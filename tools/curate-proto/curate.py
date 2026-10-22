"""自动精选原型：给一个相册里的照片打分、去重、打散挑选，输出一个对比网页。

只是用来验证效果的原型，正式版会用 Rust + ONNX Runtime 做进 App。

用法：
    python curate.py <相册文件夹> [--out 输出.html] [--models b32,l14]

原理（详见方案文档）：
    1. 技术质量：清晰度（拉普拉斯方差，取画面里最清楚的那块）和曝光（死黑/过曝像素占比），太差的直接淘汰。
    2. 美学分：CLIP 把图片变成一串数字（"指纹"），LAION 美学打分器把指纹映射成 1～10 分。
    3. 连拍去重：时间接近且指纹很像的归一组，只留分最高的。
    4. 打散挑选（MMR）：每次挑"好看分 − 和已选照片的相似度"最大的。
"""

import argparse
import base64
import html
import io
import json
import math
import os
import sys
import time
import unicodedata
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path

import numpy as np
from PIL import Image, ImageOps

try:
    import pillow_heif

    pillow_heif.register_heif_opener()
except ImportError:
    pass

EXTS = {".jpg", ".jpeg", ".jpe", ".png", ".webp", ".heic", ".heif", ".tif", ".tiff"}
CACHE = Path(os.environ.get("CURATE_CACHE", Path.home() / ".cache" / "photopicker-curate"))

# 美学打分器（都在 CLIP 图像指纹上训练）：
#   b32：LAION aesthetic-predictor v1，ViT-B/32 上的线性层
#   l14：improved-aesthetic-predictor，ViT-L/14 上的小 MLP（SAC + LOGOS + AVA 数据）
MODELS = {
    "b32": {
        "clip": ("ViT-B-32", "openai"),
        "head_url": "https://github.com/LAION-AI/aesthetic-predictor/raw/main/sa_0_4_vit_b_32_linear.pth",
        "dim": 512,
        "mlp": False,
    },
    "l14": {
        "clip": ("ViT-L-14", "openai"),
        "head_url": "https://github.com/christophschuhmann/improved-aesthetic-predictor/raw/main/sac%2Blogos%2Bava1-l14-linearMSE.pth",
        "dim": 768,
        "mlp": True,
    },
}

# ---------- 读图 ----------


def norm_name(s):
    return unicodedata.normalize("NFC", s).lower()


def load_stars(folder):
    """读 .picasa.ini 里 star=yes 的文件名（规范化后）。"""
    p = folder / ".picasa.ini"
    if not p.exists():
        return set()
    out, cur = set(), None
    for line in p.read_text(encoding="utf-8-sig", errors="replace").splitlines():
        t = line.strip()
        if t.startswith("[") and t.endswith("]"):
            cur = t[1:-1]
        elif cur and "=" in t:
            k, v = (x.strip() for x in t.split("=", 1))
            if k.lower() == "star" and v.lower() == "yes":
                out.add(norm_name(cur))
    return out


def exif_time(img):
    try:
        ex = img.getexif()
        v = ex.get_ifd(0x8769).get(36867) or ex.get(306)  # DateTimeOriginal / DateTime
        return datetime.strptime(str(v).strip()[:19], "%Y:%m:%d %H:%M:%S").timestamp()
    except Exception:
        return None


def load_one(path):
    """解码成长边 512 的小图（JPEG 用 draft 模式直接按 1/2、1/4、1/8 解码，很快）。"""
    try:
        img = Image.open(path)
        t = exif_time(img)
        img.draft("RGB", (1024, 1024))
        img = ImageOps.exif_transpose(img).convert("RGB")
        img.thumbnail((512, 512), Image.BILINEAR)
        if t is None:
            t = path.stat().st_mtime
        return {"path": path, "img": img, "time": t}
    except Exception as e:
        print(f"  跳过 {path.name}: {e}", file=sys.stderr)
        return None


# ---------- 第一层：技术质量 ----------


def sharpness(gray):
    """拉普拉斯（每个像素 × 4 − 上下左右四个邻居）的方差。边缘越锐，值越大。
    分 4×4 块各算一次，取第二大的块：人像背景虚化不吃亏，偶尔一块噪点也不会骗过去。"""
    g = gray.astype(np.float32)
    lap = 4 * g[1:-1, 1:-1] - g[:-2, 1:-1] - g[2:, 1:-1] - g[1:-1, :-2] - g[1:-1, 2:]
    h, w = lap.shape
    vals = []
    for i in range(4):
        for j in range(4):
            blk = lap[i * h // 4 : (i + 1) * h // 4, j * w // 4 : (j + 1) * w // 4]
            vals.append(float(blk.var()))
    vals.sort()
    return vals[-2]


def exposure(gray):
    """死黑（<8）和过曝（>247）像素各占多少。"""
    n = gray.size
    return float((gray < 8).sum()) / n, float((gray > 247).sum()) / n


# ---------- 第二层：美学分 ----------


def fetch(url, name):
    CACHE.mkdir(parents=True, exist_ok=True)
    p = CACHE / name
    if not p.exists():
        print(f"  下载 {name} …")
        urllib.request.urlretrieve(url, p)
    return p


def build_head(cfg, torch):
    import torch.nn as nn

    sd = torch.load(fetch(cfg["head_url"], Path(cfg["head_url"]).name.replace("%2B", "+")), map_location="cpu")
    if cfg["mlp"]:
        head = nn.Sequential(
            nn.Linear(cfg["dim"], 1024), nn.Dropout(0.2),
            nn.Linear(1024, 128), nn.Dropout(0.2),
            nn.Linear(128, 64), nn.Dropout(0.1),
            nn.Linear(64, 16), nn.Linear(16, 1),
        )
        head.load_state_dict({k.replace("layers.", ""): v for k, v in sd.items()})
    else:
        head = nn.Linear(cfg["dim"], 1)
        head.load_state_dict(sd)
    return head.eval()


def embed_and_score(items, key):
    import open_clip
    import torch

    cfg = MODELS[key]
    dev = "mps" if torch.backends.mps.is_available() else ("cuda" if torch.cuda.is_available() else "cpu")
    model, _, preprocess = open_clip.create_model_and_transforms(*cfg["clip"], cache_dir=str(CACHE / "clip"))
    model = model.to(dev).eval()
    head = build_head(cfg, torch).to(dev)
    embs, scores = [], []
    t0 = time.time()
    with torch.no_grad():
        for i in range(0, len(items), 32):
            batch = torch.stack([preprocess(it["img"]) for it in items[i : i + 32]]).to(dev)
            e = model.encode_image(batch).float()
            e = e / e.norm(dim=-1, keepdim=True)
            scores += head(e).squeeze(-1).cpu().tolist()
            embs.append(e.cpu().numpy())
    dt = time.time() - t0
    print(f"  {key}: {len(items)} 张，{dt:.1f}s（每张 {1000 * dt / max(1, len(items)):.0f}ms，设备 {dev}）")
    return np.concatenate(embs), np.array(scores), dt


# ---------- 去重 + 挑选 ----------


def pick(items, emb, aes, quality_ok, k):
    n = len(items)
    sim = emb @ emb.T
    order = sorted(range(n), key=lambda i: items[i]["time"])

    # 连拍分组：按时间排好，和上一张相隔 ≤90 秒且很像（余弦 ≥0.90）就并入同一组；
    # 另外不管时间，几乎一模一样（≥0.96）的也算一组。用并查集合并。
    parent = list(range(n))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for a, b in zip(order, order[1:]):
        if abs(items[b]["time"] - items[a]["time"]) <= 90 and sim[a, b] >= 0.90:
            parent[find(a)] = find(b)
    ii, jj = np.where(np.triu(sim, 1) >= 0.96)
    for a, b in zip(ii, jj):
        parent[find(a)] = find(b)

    groups = {}
    for i in range(n):
        groups.setdefault(find(i), []).append(i)

    # 每组只留：质量合格里美学分最高的
    leaders, dup_of = [], {}
    for g in groups.values():
        cand = [i for i in g if quality_ok[i]] or []
        if not cand:
            continue
        best = max(cand, key=lambda i: aes[i])
        leaders.append(best)
        for i in g:
            if i != best:
                dup_of[i] = best

    # MMR：好看分换成相册内排名百分比（0～1），减去"和已选照片最像的那张"的相似度惩罚
    rank = {i: r / max(1, n - 1) for r, i in enumerate(sorted(range(n), key=lambda i: aes[i]))}
    chosen, pool = [], set(leaders)
    while pool and len(chosen) < k:
        def mmr(i):
            if not chosen:
                return rank[i]
            s = max(sim[i, j] for j in chosen)
            return rank[i] - 0.8 * min(1.0, max(0.0, (s - 0.70) / 0.25))

        best = max(pool, key=mmr)
        chosen.append(best)
        pool.discard(best)
    return chosen, dup_of, len(groups)


# ---------- 网页 ----------


def thumb_uri(img, size=300):
    im = img.copy()
    im.thumbnail((size, size))
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=72)
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("folder")
    ap.add_argument("--out", default="curate-result.html")
    ap.add_argument("--models", default="b32,l14")
    args = ap.parse_args()

    folder = Path(args.folder).expanduser()
    files = sorted(p for p in folder.iterdir() if p.suffix.lower() in EXTS and not p.name.startswith("."))
    print(f"相册 {folder.name}：{len(files)} 张可读照片")
    stars = load_stars(folder)

    t0 = time.time()
    with ThreadPoolExecutor(8) as ex:
        items = [x for x in ex.map(load_one, files) if x]
    t_decode = time.time() - t0
    print(f"  解码 {t_decode:.1f}s")
    n = len(items)

    sharp, dark, bright = [], [], []
    for it in items:
        g = np.asarray(it["img"].convert("L"))
        sharp.append(sharpness(g))
        d, b = exposure(g)
        dark.append(d)
        bright.append(b)
    sharp = np.array(sharp)
    med = float(np.median(sharp))
    # 糊：低于本相册中位数的 25%（不同相机、不同场景绝对值差很多，所以和本相册比）
    reasons = []
    for i in range(n):
        r = []
        if sharp[i] < 0.25 * med:
            r.append("糊")
        if dark[i] > 0.45:
            r.append("太暗")
        if bright[i] > 0.35:
            r.append("过曝")
        reasons.append(r)
    quality_ok = [not r for r in reasons]

    k = min(n, max(5, min(200, round(n * 0.03))))
    starred_idx = {i for i, it in enumerate(items) if norm_name(it["path"].name) in stars}

    runs = {}
    for key in [m.strip() for m in args.models.split(",") if m.strip()]:
        emb, aes, dt = embed_and_score(items, key)
        chosen, dup_of, ngroups = pick(items, emb, aes, quality_ok, k)
        hit = len(set(chosen) & starred_idx)
        runs[key] = {
            "chosen": chosen, "dup_of": dup_of, "aes": aes.tolist(), "groups": ngroups,
            "ms": 1000 * dt / max(1, n), "hit": hit,
        }
        print(f"  {key}: 挑 {len(chosen)} 张，连拍/相似分组后剩 {ngroups} 组，其中你加过星的 {hit} 张")

    # 页面里每张图的数据
    used = set(starred_idx)
    for r in runs.values():
        used |= set(r["chosen"])
        used |= set(list(r["dup_of"].keys())[:60])
    used |= {i for i in range(n) if reasons[i]}
    photos = {}
    for i in sorted(used):
        it = items[i]
        photos[i] = {
            "name": it["path"].name,
            "src": thumb_uri(it["img"]),
            "star": i in starred_idx,
            "why": reasons[i],
            "aes": {k2: round(r["aes"][i], 2) for k2, r in runs.items()},
            "dup": {k2: items[r["dup_of"][i]]["path"].name for k2, r in runs.items() if i in r["dup_of"]},
        }
    data = {
        "album": folder.name, "n": n, "k": k, "stars": len(starred_idx), "decode": round(t_decode, 1),
        "runs": {k2: {"chosen": r["chosen"], "groups": r["groups"], "ms": round(r["ms"]), "hit": r["hit"],
                      "dups": [i for i in r["dup_of"] if i in photos][:60]} for k2, r in runs.items()},
        "rejected": [i for i in range(n) if reasons[i]][:80],
        "starred": sorted(starred_idx),
        "photos": photos,
    }
    tpl = (Path(__file__).parent / "report.html").read_text(encoding="utf-8")
    out = Path(args.out).expanduser()
    out.write_text(tpl.replace("/*DATA*/null", json.dumps(data, ensure_ascii=False)), encoding="utf-8")
    print(f"写好了 {out}（{out.stat().st_size / 1e6:.1f} MB）")


if __name__ == "__main__":
    main()
