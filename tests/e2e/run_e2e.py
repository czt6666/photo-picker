"""在 Linux 上驱动真实 App 做端到端测试（Xvfb + tauri-driver + WebKitWebDriver）。

准备（Ubuntu）：
    apt install xvfb xdotool webkit2gtk-driver
    cargo install tauri-driver --locked
    pip install selenium
    npx tauri build --debug --no-bundle
    python3 scripts/make_test_photos.py /tmp/pp-e2e/photos 40 300

运行：
    python3 tests/e2e/run_e2e.py /tmp/pp-e2e

会用一个隔离的 HOME（<工作目录>/home），不影响本机的设置和缓存。截图保存在 <工作目录>/shots。
"""
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.common.action_chains import ActionChains
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.common.options import ArgOptions

ROOT = Path(__file__).resolve().parents[2]
APP = ROOT / "src-tauri" / "target" / os.environ.get("PP_PROFILE", "debug") / "photo-picker"
WORK = Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/pp-e2e")
PHOTOS = WORK / "photos"
HOME = WORK / "home"
SHOTS = WORK / "shots"
IDENT = "io.github.czt6666.photopicker"
DISPLAY = ":97"

results = []


def check(name, cond, detail=""):
    results.append((name, bool(cond), detail))
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail else ""), flush=True)


def wait(fn, timeout=20, interval=0.1):
    end = time.time() + timeout
    last = None
    while time.time() < end:
        try:
            last = fn()
            if last:
                return last
        except Exception as e:  # noqa: BLE001
            last = e
        time.sleep(interval)
    return last if not isinstance(last, Exception) else None


def main():
    shutil.rmtree(HOME, ignore_errors=True)
    shutil.rmtree(SHOTS, ignore_errors=True)
    SHOTS.mkdir(parents=True)
    cfg = HOME / ".config" / IDENT
    cfg.mkdir(parents=True)
    (cfg / "settings.json").write_text(json.dumps({"workdir": str(PHOTOS)}))
    # 每次从干净的 .picasa.ini 开始
    ini = PHOTOS / "2024" / "旅行" / ".picasa.ini"
    ini_backup = WORK / "picasa.ini.orig"
    if not ini_backup.exists():
        shutil.copy(ini, ini_backup)
    shutil.copy(ini_backup, ini)
    for f in (PHOTOS / "大图").glob(".picasa.ini"):
        f.unlink()
    export_dir = WORK / "export"
    shutil.rmtree(export_dir, ignore_errors=True)

    env = dict(os.environ, HOME=str(HOME), DISPLAY=DISPLAY, XDG_CONFIG_HOME=str(HOME / ".config"),
               XDG_CACHE_HOME=str(HOME / ".cache"), XDG_DATA_HOME=str(HOME / ".local/share"),
               WEBKIT_DISABLE_COMPOSITING_MODE="1", NO_AT_BRIDGE="1")
    xvfb = subprocess.Popen(["Xvfb", DISPLAY, "-screen", "0", "1600x1000x24"], stderr=subprocess.DEVNULL)
    time.sleep(1)
    drv = subprocess.Popen(["tauri-driver", "--port", "4444"], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1.5)
    opts = ArgOptions()
    opts.set_capability("browserName", "wry")
    opts.set_capability("tauri:options", {"application": str(APP)})
    d = webdriver.Remote("http://127.0.0.1:4444", options=opts)
    try:
        run(d, env, export_dir)
    finally:
        try:
            d.quit()
        except Exception:  # noqa: BLE001
            pass
        drv.terminate()
        xvfb.terminate()
    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    sys.exit(1 if failed else 0)


def js(d, script, *args):
    return d.execute_script(script, *args)


def invoke(d, cmd, args=None):
    return d.execute_async_script(
        "const [cmd, args, done] = arguments;"
        "window.__TAURI_INTERNALS__.invoke(cmd, args).then(r => done({ok: r}), e => done({err: String(e)}));",
        cmd, args or {})


def xdo(env, *args):
    return subprocess.run(["xdotool", *args], env=env, capture_output=True, text=True).stdout.strip()


def read_perf(d):
    return json.loads(js(d, "return document.body.dataset.perf || '[]'"))


def open_folder(d, name):
    js(d, "[...document.querySelectorAll('.sb-item[data-path]')].find(e => e.dataset.path.endsWith(arguments[0])).click()", name)


def run(d, env, export_dir):
    d.set_window_size(1400, 900)
    # ---------- 图库 ----------
    # 启动后会自动打开第一个文件夹；等它稳定下来（侧栏会随视图切换重绘）
    wait(lambda: "张照片" in d.find_element(By.ID, "status-count").text, timeout=30)
    rows = js(d, "return [...document.querySelectorAll('.sb-item[data-path]')].map(e => e.innerText.replace(/\\s+/g, ' '))")
    check("侧栏列出 3 个含照片的文件夹", len(rows) == 3, str(rows))
    trip = next((r for r in rows if "旅行" in r), "")
    check("从 Picasa 的 .picasa.ini 读到 3 个星标", "★3" in trip, trip)
    starred_total = d.find_element(By.CSS_SELECTOR, ".sb-starred .count").text
    check("“已加星标的照片”合计 3", starred_total == "3", starred_total)
    wd = js(d, "return document.querySelector('.sb-workdir').innerText.replace(/\\s+/g, ' ')")
    check("侧栏显示工作目录及相册数", "photos" in wd and "3 个相册" in wd, wd)

    # ---------- 网格 ----------
    open_folder(d, "旅行")
    wait(lambda: "300 张" in d.find_element(By.ID, "status-count").text)
    t0 = time.time()
    loaded = wait(lambda: len(d.find_elements(By.CSS_SELECTOR, ".cell.loaded")) >= 20, timeout=30)
    check("打开 300 张的文件夹，首屏缩略图加载", loaded, f"{time.time() - t0:.2f}s")
    n_cells = len(d.find_elements(By.CSS_SELECTOR, ".cell"))
    check("网格是虚拟化的（DOM 里远少于 300 个格子）", n_cells < 150, f"{n_cells} 个格子")
    starred_cells = d.find_elements(By.CSS_SELECTOR, ".cell.starred")
    check("网格里显示星标", len(starred_cells) >= 2, f"{len(starred_cells)} 个")
    d.save_screenshot(str(SHOTS / "01-grid.png"))

    # 滚到底，缩略图也能出来
    js(d, "document.getElementById('grid').scrollTop = 1e9")
    ok = wait(lambda: js(d, "return [...document.querySelectorAll('.cell')].filter(c => c.style.visibility !== 'hidden' && Number(c.dataset.i) > 280 && c.classList.contains('loaded')).length") >= 5, timeout=30)
    check("滚到底部，底部缩略图加载", ok)
    js(d, "document.getElementById('grid').scrollTop = 0")

    # 仅显示星标
    d.find_element(By.CSS_SELECTOR, ".toggle-ui").click()
    ok = wait(lambda: "3 张" in d.find_element(By.ID, "status-count").text)
    check("“仅显示星标”过滤后只剩 3 张", ok, d.find_element(By.ID, "status-count").text)
    d.save_screenshot(str(SHOTS / "02-starred-only.png"))
    d.find_element(By.CSS_SELECTOR, ".toggle-ui").click()
    wait(lambda: "300 张" in d.find_element(By.ID, "status-count").text)

    # 选中第 1 张，按空格加星；Shift+→ 连选，再按 S（S 也保留）
    first = wait(lambda: d.find_element(By.CSS_SELECTOR, '.cell[data-i="0"]'))
    first.click()
    ActionChains(d).send_keys(Keys.SPACE).perform()
    ini = PHOTOS / "2024" / "旅行" / ".picasa.ini"
    ok = wait(lambda: b"[DSC_1.jpg]\r\nstar=yes\r\n" in ini.read_bytes(), timeout=5)
    check("按空格加星标 → 写入 .picasa.ini（保持 CRLF、保留原有内容）", ok and "faces=rect64" in ini.read_text())
    ActionChains(d).key_down("").send_keys("").send_keys("").key_up("").perform()  # Shift+→→
    sel = d.find_element(By.ID, "status-count").text
    check("Shift+方向键连选 3 张", "已选 3 张" in sel, sel)
    ActionChains(d).send_keys("s").perform()  # 有没加星的 → 全部加星
    ok = wait(lambda: all(f"[DSC_{k}.jpg]" in ini.read_text() for k in (1, 2, 3)) and ini.read_text().count("star=yes") == 5)
    check("多选按 S：全部加星（Picasa 语义）", ok, ini.read_text().replace("\r\n", " | "))
    ActionChains(d).send_keys(Keys.SPACE).perform()  # 全部已加星 → 全部取消
    ok = wait(lambda: ini.read_text().count("star=yes") == 2)
    check("再按空格：全部取消星标，原有 faces 等字段保留", ok and "faces=rect64" in ini.read_text(), ini.read_text().replace("\r\n", " | "))
    side = wait(lambda: d.find_element(By.CSS_SELECTOR, ".sb-starred .count").text == "2")
    check("侧栏星标总数随之更新", side)

    # 点过状态栏的“星标”按钮后焦点留在按钮上，再按空格：只能切换一次（不能“按钮被空格点一次 + 快捷键一次”抵消掉）
    d.find_element(By.CSS_SELECTOR, '.cell[data-i="4"]').click()
    d.find_element(By.ID, "btn-star").click()
    ok1 = wait(lambda: "[DSC_5.jpg]" in ini.read_text(), timeout=5)
    ActionChains(d).send_keys(Keys.SPACE).perform()
    time.sleep(0.8)
    check("焦点在按钮上时按空格只切换一次", ok1 and "[DSC_5.jpg]" not in ini.read_text(), ini.read_text().replace("\r\n", " | "))
    # 按住空格的自动连发（repeat=true）要忽略
    js(d, "window.dispatchEvent(new KeyboardEvent('keydown', {key: ' ', repeat: true, bubbles: true}))")
    time.sleep(0.8)
    check("按住空格的自动连发不会反复切换星标", "[DSC_5.jpg]" not in ini.read_text())

    # ---------- 看图器：大图翻页 ----------
    open_folder(d, "大图")
    wait(lambda: "40 张" in d.find_element(By.ID, "status-count").text)
    wait(lambda: len(d.find_elements(By.CSS_SELECTOR, ".cell.loaded")) >= 10, timeout=60)
    # 等后台把 40 张缩略图都生成完，再测翻页（模拟“打开文件夹看了一会儿”）
    wait(lambda: d.find_element(By.ID, "status-thumbs").text == "", timeout=120, interval=0.5)
    # RAW+JPG：40 张 JPG 里有 10 张带同名 CR3；另有一张只有 RAW 的 IMG_9001.CR3（Linux 上解不了 → 不显示）
    count_text = d.find_element(By.ID, "status-count").text
    tags = js(d, "return [...document.querySelectorAll('.cell')].filter(c => c.style.visibility !== 'hidden' && !c.querySelector('.raw-tag').hidden).map(c => c.dataset.i + ':' + c.querySelector('.raw-tag').textContent)")
    check("RAW+JPG 合并：同名 RAW 不单独显示，JPG 角标显示 CR3", count_text.startswith("40 张") and "0:CR3" in tags and "4:CR3" in tags and "1:CR3" not in tags, f"{count_text} {tags}")
    ActionChains(d).double_click(d.find_element(By.CSS_SELECTOR, '.cell[data-i="0"]')).perform()
    ok = wait(lambda: js(d, "const m = document.querySelector('.v-main'); return !!(m && m.naturalWidth)"), timeout=30)
    check("双击打开看图器，显示清晰图", ok)
    title = d.find_element(By.CSS_SELECTOR, ".v-name").text
    check("看图器标题标注同名 RAW", title == "IMG_0001.JPG + CR3", title)
    nat = js(d, "const m = document.querySelector('.v-main'); return [m.naturalWidth, m.naturalHeight]")
    stage = js(d, "const s = document.querySelector('.v-stage'); return [s.clientWidth, s.clientHeight, devicePixelRatio]")
    check("看图用的是屏幕尺寸预览，不是 6000px 原图", nat and nat[0] < 6000, f"预览 {nat}，舞台 {stage}")
    info_text = lambda: js(d, "return document.querySelector('.v-info').textContent")  # noqa: E731
    info = wait(lambda: "6000 × 4000" in info_text() and info_text())
    check("信息栏显示原图尺寸和拍摄参数", info and "f/2.8" in info and "Canon EOS R5" in info, info or "")
    d.save_screenshot(str(SHOTS / "03-viewer.png"))

    # 真实的 X11 滚轮事件（xdotool 走 XTEST，和真鼠标一样；加 --window 会变成被 GTK 忽略的合成事件）
    # 没有窗口管理器，窗口在 (0,0)，页面坐标 = 屏幕坐标
    geo = js(d, "const r = document.querySelector('.v-stage').getBoundingClientRect(); return [r.left + r.width/2, r.top + r.height/2]")
    xdo(env, "mousemove", str(int(geo[0])), str(int(geo[1])))
    perf_count = len(read_perf(d))
    for _ in range(8):
        xdo(env, "click", "5")
        time.sleep(0.4)
    pos = d.find_element(By.CSS_SELECTOR, ".v-pos").text
    check("滚轮向下 8 格 → 到第 9 张（一格一张）", pos.startswith("9 /"), pos)
    time.sleep(0.5)
    perf = read_perf(d)[perf_count:]
    hits = [p for p in perf if p["cached"]]
    check("正常节奏翻页：下一张已被预加载，命中率高", len(hits) >= 6, f"{len(hits)}/{len(perf)} 命中，耗时 {[p['ms'] for p in perf]}ms")

    # 快速连续滚 10 格（间隔 40ms）：每格都算数、不卡死、停下后清晰图出现
    t0 = time.time()
    xdo(env, "click", "--repeat", "10", "--delay", "40", "5")  # 一次调用发 10 格，避免每次启动 xdotool 的 ~100ms 开销
    t_scroll = time.time() - t0
    ok = wait(lambda: js(d, "const m = document.querySelector('.v-main'); return !!(m && m.isConnected && m.naturalWidth && document.querySelector('.v-pos').textContent.startsWith('19 /'))"), timeout=20)
    pos = d.find_element(By.CSS_SELECTOR, ".v-pos").text
    check("快速连滚 10 格 → 到第 19 张，停下后清晰图出现", ok, f"停在 {pos}，滚动 {t_scroll:.2f}s，停下后 {time.time() - t0 - t_scroll:.2f}s 出清晰图")

    # 竖拍（EXIF 方向 6）显示为竖图
    js(d, "document.querySelector('.v-strip-inner .s-item[data-i=\"4\"]')?.click()")
    ActionChains(d).send_keys("").perform()  # Home
    for _ in range(4):
        ActionChains(d).send_keys("").perform()
        time.sleep(0.15)
    ok = wait(lambda: js(d, "const m = document.querySelector('.v-main'); return m && m.naturalWidth && m.naturalHeight > m.naturalWidth"), timeout=20)
    dims = js(d, "const m = document.querySelector('.v-main'); return m && [m.style.width, m.style.height]")
    check("EXIF 方向 6 的照片按竖图显示", ok, f"第 5 张，显示尺寸 {dims}")
    d.save_screenshot(str(SHOTS / "04-rotated.png"))

    # 1:1 放大 → 换原图
    ActionChains(d).send_keys("1").perform()
    ok = wait(lambda: js(d, "const m = document.querySelector('.v-main'); return m && m.naturalWidth >= 4000"), timeout=30)
    check("按 1 放大到 1:1 → 加载原图", ok, js(d, "const m = document.querySelector('.v-main'); return m && [m.naturalWidth, m.naturalHeight]"))
    d.save_screenshot(str(SHOTS / "05-zoom.png"))
    ActionChains(d).send_keys("").perform()  # Esc → 回到适合窗口

    # 看图时按空格加星标；IMG_0005 带 CR3，两个文件都要打上星
    ActionChains(d).send_keys(Keys.SPACE).perform()
    big_ini = PHOTOS / "大图" / ".picasa.ini"
    ok = wait(lambda: big_ini.exists() and "[IMG_0005.JPG]\nstar=yes" in big_ini.read_text() and "[IMG_0005.CR3]\nstar=yes" in big_ini.read_text(), timeout=5)
    check("看图器里按空格加星标（JPG 和同名 CR3 一起）", ok, big_ini.read_text().replace("\n", " | ") if big_ini.exists() else "无 .picasa.ini")
    starmark = js(d, "return !document.querySelector('.v-starmark').hidden")
    check("看图器显示星标标记", starmark)
    d.save_screenshot(str(SHOTS / "06-viewer-starred.png"))
    ActionChains(d).send_keys("").perform()  # Esc → 回网格
    ok = wait(lambda: d.find_element(By.ID, "viewer").get_attribute("hidden") is not None)
    focused = js(d, "const c = document.querySelector('.cell.focused'); return c && c.dataset.i")
    check("Esc 返回网格，光标停在刚看的照片上", ok and focused == "4", f"focused={focused}")

    # ---------- 星标相册 ----------
    d.find_element(By.CSS_SELECTOR, ".sb-starred").click()
    ok = wait(lambda: "3 张" in d.find_element(By.ID, "status-count").text)
    check("“已加星标的照片”汇总所有文件夹的 3 张", ok, d.find_element(By.ID, "status-count").text)
    d.save_screenshot(str(SHOTS / "07-starred-album.png"))

    # ---------- 导出 ----------
    d.find_element(By.ID, "btn-export").click()
    wait(lambda: d.find_element(By.CSS_SELECTOR, "#export-dialog .modal-card"))
    d.save_screenshot(str(SHOTS / "08-export-dialog.png"))
    js(d, "document.querySelector('#export-dialog .dest').value = arguments[0]", str(export_dir))
    js(d, "document.querySelector('#export-dialog .sub').value = '精选'")
    js(d, "document.querySelector('#export-dialog input[name=mode][value=resize]').checked = true")
    js(d, "const s = document.querySelector('#export-dialog .maxpx'); s.value = '2048'")
    # 连点两下“导出”：只能导出一次，不能出现“导出失败”
    js(d, "const g = document.querySelector('#export-dialog .go'); g.click(); g.click();")
    ok = wait(lambda: "完成" in d.find_element(By.CSS_SELECTOR, "#export-dialog .ptext").text, timeout=60)
    check("连点两下导出只导出一次", ok and "失败" not in d.find_element(By.CSS_SELECTOR, "#export-dialog .ptext").text,
          d.find_element(By.CSS_SELECTOR, "#export-dialog .ptext").text)
    out = sorted(p.name for p in (export_dir / "精选").glob("*")) if (export_dir / "精选").exists() else []
    check("导出全部星标照片（缩小到 2048），同名 CR3 一起导出", out == ["DSC_10.jpg", "DSC_25.jpg", "IMG_0005.CR3", "IMG_0005.jpg"], str(out))
    if "IMG_0005.CR3" in out:
        check("RAW 原样复制（字节一致）", (export_dir / "精选" / "IMG_0005.CR3").read_bytes() == (PHOTOS / "大图" / "IMG_0005.CR3").read_bytes())
    done_text = d.find_element(By.CSS_SELECTOR, "#export-dialog .ptext").text
    check("导出完成提示里写明文件数", "3 张" in done_text and "4 个文件" in done_text, done_text)
    d.save_screenshot(str(SHOTS / "09-export-done.png"))
    if out:
        from PIL import Image
        im = Image.open(export_dir / "精选" / "IMG_0005.jpg")
        exif = im.getexif()
        check("缩小导出：竖图转正、长边 2048、EXIF 保留且方向重置为 1",
              im.size == (1365, 2048) and exif.get(0x0112) == 1 and exif.get(0x0110) == "Canon EOS R5", f"{im.size} {dict(exif)}")

    # 原图导出走后端命令（目标文件夹选择框是系统原生对话框，WebDriver 点不到）
    r = invoke(d, "export_photos", {"request": {"paths": [str(PHOTOS / "大图" / "IMG_0001.JPG")], "dest": str(export_dir), "mode": "original"}})
    same = (export_dir / "IMG_0001.JPG").read_bytes() == (PHOTOS / "大图" / "IMG_0001.JPG").read_bytes() if (export_dir / "IMG_0001.JPG").exists() else False
    check("原图导出：字节完全一致", r.get("ok") and same, str(r)[:200])
    check("原图导出默认带上同名 RAW 和 xmp", (export_dir / "IMG_0001.CR3").exists() and (export_dir / "IMG_0001.xmp").exists() and r.get("ok", {}).get("files") == 3, str(r)[:200])

    # 越权访问被拒绝
    probe = ("const [p, done] = arguments; const img = new Image();"
             "img.onload = () => done('loaded'); img.onerror = () => done('blocked');"
             "img.src = window.__TAURI_INTERNALS__.convertFileSrc(p, 'photo');")
    inside = d.execute_async_script(probe, str(PHOTOS / "大图" / "IMG_0002.JPG"))
    outside = d.execute_async_script(probe, "/usr/share/pixmaps/debian-logo.png")
    check("图片协议：图库内可读、图库外拒绝", inside == "loaded" and outside == "blocked", f"inside={inside} outside={outside}")
    r = invoke(d, "export_photos", {"request": {"paths": ["/etc/hostname"], "dest": str(export_dir), "mode": "original"}})
    check("导出命令拒绝图库外的文件", "err" in r and not (export_dir / "hostname").exists(), str(r)[:120])
    r = invoke(d, "list_folder", {"path": "/etc"})
    check("列目录命令拒绝图库外的文件夹", "err" in r, str(r)[:120])

    # ---------- 快捷键帮助 ----------
    d.find_element(By.CSS_SELECTOR, "#export-dialog .go").click()  # 关掉导出对话框
    wait(lambda: d.find_element(By.ID, "export-dialog").get_attribute("hidden") is not None)
    ActionChains(d).send_keys("?").perform()
    ok = wait(lambda: d.find_elements(By.CSS_SELECTOR, "#export-dialog .help"))
    d.save_screenshot(str(SHOTS / "10-help.png"))
    ActionChains(d).send_keys("\ue00c").perform()
    closed = wait(lambda: d.find_element(By.ID, "export-dialog").get_attribute("hidden") is not None)
    check("按 ? 打开快捷键帮助，Esc 关闭", ok and closed)

    # ---------- 工作目录切换 ----------
    sub = str(PHOTOS / "2024")
    r = invoke(d, "set_workdir", {"path": sub})
    check("切换工作目录：只扫描新目录下的相册", r.get("ok") and [f["name"] for f in r["ok"]["folders"]] == ["旅行"], str(r)[:200])
    d.refresh()
    ok = wait(lambda: js(d, "return document.querySelectorAll('.sb-item[data-path]').length") == 1 and "300 张" in d.find_element(By.ID, "status-count").text, timeout=30)
    btn = js(d, "return document.getElementById('btn-workdir').textContent")
    status = js(d, "return document.getElementById('status-count').textContent")
    check("重启后记住工作目录，工具栏显示目录名", ok and "2024" in btn, f"ok={ok} btn={btn} status={status}")
    d.find_element(By.ID, "btn-workdir").click()
    menu = wait(lambda: js(d, "return [...document.querySelectorAll('.menu button')].map(b => b.innerText.replace(/\\s+/g, ' '))"))
    d.save_screenshot(str(SHOTS / "11-workdir-menu.png"))
    check("工作目录菜单列出最近用过的目录", menu and any(m.startswith("photos") for m in menu), str(menu))
    js(d, "[...document.querySelectorAll('.menu button')].find(b => b.innerText.startsWith('photos')).click()")
    ok = wait(lambda: js(d, "return document.querySelectorAll('.sb-item[data-path]').length") == 3, timeout=30)
    check("从“最近”切回原工作目录，3 个相册都回来了", ok)

    # 最近列表里的目录被删除 / 移动硬盘拔掉：菜单里置灰，可一键清理
    gone = WORK / "temp-workdir"
    shutil.rmtree(gone, ignore_errors=True)
    (gone / "album").mkdir(parents=True)
    shutil.copy(PHOTOS / "杂项" / "screenshot.png", gone / "album" / "a.png")
    invoke(d, "set_workdir", {"path": str(gone)})
    invoke(d, "set_workdir", {"path": str(PHOTOS)})
    shutil.rmtree(gone)
    d.refresh()
    wait(lambda: js(d, "return document.querySelectorAll('.sb-item[data-path]').length") == 3, timeout=30)
    d.find_element(By.ID, "btn-workdir").click()
    items = wait(lambda: js(d, "return [...document.querySelectorAll('.menu button')].map(b => [b.innerText.replace(/\\s+/g, ' '), b.disabled])"))
    greyed = [t for t, dis in items or [] if "未连接" in t and dis]
    check("不存在的最近目录显示“未连接”且不可点", len(greyed) == 1 and "temp-workdir" in greyed[0], str(items))
    js(d, "[...document.querySelectorAll('.menu button')].find(b => b.innerText.startsWith('从列表中移除')).click()")
    time.sleep(1)
    d.find_element(By.ID, "btn-workdir").click()
    items = wait(lambda: js(d, "return [...document.querySelectorAll('.menu button')].map(b => b.innerText)"))
    check("一键清理后不再列出", items and not any("temp-workdir" in t for t in items), str(items))


if __name__ == "__main__":
    main()
