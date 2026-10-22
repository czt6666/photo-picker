// 看大图（albums.html 和 library.html 共用，生成网页时内嵌进去）。
// 大图不放在网页里（1500 多张会有上百 MB），而是放旁边的 big/ 目录：big/index.js 记着每张在哪一块，
// big/bNN.js 每块约 100 张。点开哪张才加载那一块；没有 big/ 目录时就放大缩略图。
// 用法：BigView.open(items, pos, { cap: (item) => 说明文字, play: true 自动轮播 })，item 要有 rel（相对路径）和 src（缩略图）。
const BigView = (() => {
  const css = document.createElement("style");
  css.textContent = `
#bv { position: fixed; inset: 0; background: rgba(12, 11, 10, 0.97); z-index: 30; display: grid; grid-template-rows: 1fr auto;
  padding: env(safe-area-inset-top, 0px) env(safe-area-inset-right, 0px) env(safe-area-inset-bottom, 0px) env(safe-area-inset-left, 0px); }
#bv img { width: 100%; height: 100%; object-fit: contain; min-height: 0; }
#bv .cap { color: #e9e5dd; text-align: center; padding: 8px 16px 14px; font-size: .82rem; line-height: 1.6; }
#bv .cap .dim { color: #a39d92; }
#bv button { position: absolute; background: none; border: 0; color: #e9e5dd; cursor: pointer; font: inherit; }
#bv .x { top: calc(10px + env(safe-area-inset-top, 0px)); right: calc(14px + env(safe-area-inset-right, 0px)); font-size: 1.8rem; }
#bv .nav { top: 50%; transform: translateY(-50%); font-size: 2.6rem; padding: 20px 14px; opacity: .7; }
#bv .nav:hover { opacity: 1; }
#bv .prev { left: env(safe-area-inset-left, 0px); }
#bv .next { right: env(safe-area-inset-right, 0px); }
#bv button:focus-visible { outline: 2px solid #f08a4b; }`;
  document.head.append(css);
  const root = document.createElement("div");
  root.id = "bv"; root.hidden = true;
  root.innerHTML = '<img id="bv-img" alt=""><div class="cap" id="bv-cap"></div>' +
    '<button class="nav prev" id="bv-prev" type="button" aria-label="上一张">‹</button>' +
    '<button class="nav next" id="bv-next" type="button" aria-label="下一张">›</button>' +
    '<button class="x" id="bv-x" type="button" aria-label="关闭">×</button>';
  document.body.append(root);
  const img = root.querySelector("#bv-img"), cap = root.querySelector("#bv-cap");

  const loading = {};
  function big(rel) {
    const B = window.BIG || {};
    if (B[rel]) return Promise.resolve(B[rel]);
    const c = (window.BIGINDEX || {})[rel];
    if (c == null) return Promise.resolve(null);
    const f = "big/b" + String(c).padStart(2, "0") + ".js";
    loading[f] = loading[f] || new Promise((done) => {
      const s = document.createElement("script");
      s.src = f; s.onload = done; s.onerror = done;
      document.head.append(s);
    });
    return loading[f].then(() => (window.BIG || {})[rel] || null);
  }

  let items = [], at = 0, opts = {}, timer = null;
  function show(pos) {
    at = (pos + items.length) % items.length;
    const it = items[at];
    img.src = it.src; img.alt = it.rel;
    big(it.rel).then((u) => { if (u && items[at] === it) img.src = u; });
    big(items[(at + 1) % items.length].rel);  // 顺手把下一张所在的块也拉下来
    cap.replaceChildren();
    if (opts.cap) cap.append(opts.cap(it));
    cap.append(Object.assign(document.createElement("div"), { className: "dim",
      textContent: (at + 1) + " / " + items.length + "　←→ 切换　Esc 关闭" + (opts.play ? "　空格暂停" : "") }));
  }
  function play(on) {
    clearInterval(timer); timer = on ? setInterval(() => show(at + 1), 4000) : null;
  }
  function open(list, pos, o) {
    if (!list.length) return;
    items = list; opts = o || {}; root.hidden = false; show(pos || 0); play(!!opts.play);
    if (opts.play) try { root.requestFullscreen && root.requestFullscreen().catch(() => {}); } catch (e) {}
  }
  function close() {
    root.hidden = true; play(false);
    try { document.fullscreenElement && document.exitFullscreen().catch(() => {}); } catch (e) {}
  }
  root.querySelector("#bv-x").onclick = close;
  root.querySelector("#bv-prev").onclick = () => show(at - 1);
  root.querySelector("#bv-next").onclick = () => show(at + 1);
  img.onclick = () => show(at + 1);
  let tx = null;
  root.addEventListener("touchstart", (e) => { tx = e.touches[0].clientX; }, { passive: true });
  root.addEventListener("touchend", (e) => {
    if (tx == null) return;
    const dx = e.changedTouches[0].clientX - tx; tx = null;
    if (Math.abs(dx) > 40) show(at + (dx < 0 ? 1 : -1));
  });
  document.addEventListener("keydown", (e) => {
    if (root.hidden) return;
    if (e.key === "Escape") close();
    else if (e.key === "ArrowRight") show(at + 1);
    else if (e.key === "ArrowLeft") show(at - 1);
    else if (e.key === " " && opts.play) { e.preventDefault(); play(!timer); }
  });
  return { open, close };
})();
