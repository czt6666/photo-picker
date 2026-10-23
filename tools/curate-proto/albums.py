"""按目录看分数：每个目录一页，列出里面每张照片在各个美学模型下的分数，可按模型排序。

不跑模型，只读 library.py 算好的缓存（~/.cache/photopicker-curate/library.pkl），所以要先跑 library.py。
分数同时给"全库百分位"：某张在 V2.5 下排前 5%，就是比全库 95% 的照片分高。不同模型的刻度不一样，
百分位能横着比。

只按一级目录分组（10.1沽源/精选1/ 里的照片算在 10.1沽源 里，卡片上标出子目录）。

输出一个网页（缩略图内嵌），双击打开；页内点目录进去看，点照片看大图。
大图写在网页旁边的 big/ 目录（800px，每 100 张一个 js 文件，网页点开时才加载那一块），
不放进网页本身，否则 1500 张就有上百 MB。--big 0 不生成大图。

用法：python albums.py ~/workspace/myphotos --out 相册打分.html
"""

import argparse
import base64
import io
import json
import pickle
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
from PIL import Image, ImageOps

sys.path.insert(0, str(Path(__file__).parent))
import people  # noqa: E402
from curate import CACHE, thumb_uri  # noqa: E402
from library import NAMES, scan  # noqa: E402


def thumb(path):
    im = Image.open(path)
    im.draft("RGB", (600, 600))
    return thumb_uri(ImageOps.exif_transpose(im).convert("RGB"), 200)


def big_uri(path):
    im = Image.open(path)
    im.draft("RGB", (1600, 1600))
    im = ImageOps.exif_transpose(im).convert("RGB")
    im.thumbnail((800, 800))
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=72)
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()


def write_big(paths, root, out, per=100):
    """big/index.js：相对路径 -> 块号；big/bNN.js：一块的大图。bigview.js 按需加载。"""
    out.mkdir(parents=True, exist_ok=True)
    rels = [str(p.relative_to(root)) for p in paths]
    (out / "index.js").write_text("window.BIGINDEX=" + json.dumps({r: i // per for i, r in enumerate(rels)}, ensure_ascii=False) + ";",
                                  encoding="utf-8")
    for c in range(0, len(paths), per):
        with ThreadPoolExecutor(8) as ex:
            uris = list(ex.map(big_uri, paths[c : c + per]))
        (out / f"b{c // per:02d}.js").write_text(
            "window.BIG=Object.assign(window.BIG||{}," + json.dumps(dict(zip(rels[c : c + per], uris)), ensure_ascii=False) + ");",
            encoding="utf-8")
        print(f"  大图 {min(c + per, len(paths))}/{len(paths)}", flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("root")
    ap.add_argument("--out", default="相册打分.html")
    ap.add_argument("--big", type=int, default=1, help="生成 big/ 大图，0 = 不生成")
    args = ap.parse_args()
    root = Path(args.root).expanduser()
    cache = pickle.loads((CACHE / "library.pkl").read_bytes())
    paths = [p for p in scan(root) if "emb" in cache.get(str(p), {})]
    feat = [cache[str(p)] for p in paths]
    keys = [k for k in NAMES if any(f"aes_{k}" in f for f in feat)]

    # 全库百分位（0～100，越大越好）
    pct = {}
    for k in keys:
        v = np.array([f.get(f"aes_{k}", np.nan) for f in feat], dtype=float)
        order = np.argsort(np.nan_to_num(v, nan=-1e9))
        r = np.empty(len(v))
        r[order] = np.arange(len(v)) * 100.0 / max(1, len(v) - 1)
        pct[k] = r

    dirs = {}
    for i, p in enumerate(paths):
        parts = p.relative_to(root).parts
        dirs.setdefault(parts[0] if len(parts) > 1 else "（根目录）", []).append(i)
    names = sorted(dirs)

    albums = []
    for d in names:
        idx = dirs[d]
        print(f"  {d}：{len(idx)} 张", flush=True)
        with ThreadPoolExecutor(8) as ex:
            srcs = list(ex.map(thumb, [paths[i] for i in idx]))
        photos, kinds = [], {"人像": 0, "有人": 0, "无人": 0}
        for i, src in zip(idx, srcs):
            f = feat[i]
            kind, why = people.classify(f.get("vision2"), f.get("yolo2"))
            kinds[kind] += 1
            rel = paths[i].relative_to(root)
            photos.append({
                "name": rel.name, "rel": str(rel), "sub": "/".join(rel.parts[1:-1]), "src": src, "time": f["time"], "kind": kind, "why": why,
                "s": {k: round(f[f"aes_{k}"], 3) for k in keys if f"aes_{k}" in f},
                "p": {k: round(float(pct[k][i]), 1) for k in keys},
            })
        albums.append({"dir": d, "count": len(idx), "kinds": kinds, "photos": photos,
                       "mean": {k: round(float(np.mean([pct[k][i] for i in idx])), 1) for k in keys}})
    data = {"root": root.name, "names": {k: NAMES[k] for k in keys}, "albums": albums, "total": len(paths)}
    here = Path(__file__).parent
    tpl = (here / "albums.html").read_text(encoding="utf-8").replace("/*BIGVIEW*/", (here / "bigview.js").read_text(encoding="utf-8"))
    out = Path(args.out).expanduser()
    out.write_text(tpl.replace("/*DATA*/null", json.dumps(data, ensure_ascii=False)), encoding="utf-8")
    if args.big:
        write_big(paths, root, out.parent / "big")
    print(f"写好了 {out}（{out.stat().st_size / 1e6:.1f} MB）")


if __name__ == "__main__":
    main()
