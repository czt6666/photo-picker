"""按目录看分数：每个目录一页，列出里面每张照片在各个美学模型下的分数，可按模型排序。

不跑模型，只读 library.py 算好的缓存（~/.cache/photopicker-curate/library.pkl），所以要先跑 library.py。
分数同时给"全库百分位"：某张在 V2.5 下排前 5%，就是比全库 95% 的照片分高。不同模型的刻度不一样，
百分位能横着比。

输出一个网页（缩略图内嵌），双击打开；页内点目录进去看。

用法：python albums.py ~/workspace/myphotos --out 相册打分.html
"""

import argparse
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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("root")
    ap.add_argument("--out", default="相册打分.html")
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
        dirs.setdefault(str(p.parent.relative_to(root)) or "（根目录）", []).append(i)
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
            kind, why = people.classify(f.get("vision"), f["person_p"], f.get("yolo"))
            kinds[kind] += 1
            photos.append({
                "name": paths[i].name, "src": src, "time": f["time"], "kind": kind, "why": why,
                "s": {k: round(f[f"aes_{k}"], 3) for k in keys if f"aes_{k}" in f},
                "p": {k: round(float(pct[k][i]), 1) for k in keys},
            })
        albums.append({"dir": d, "count": len(idx), "kinds": kinds, "photos": photos,
                       "mean": {k: round(float(np.mean([pct[k][i] for i in idx])), 1) for k in keys}})
    data = {"root": root.name, "names": {k: NAMES[k] for k in keys}, "albums": albums, "total": len(paths)}
    tpl = (Path(__file__).parent / "albums.html").read_text(encoding="utf-8")
    out = Path(args.out).expanduser()
    out.write_text(tpl.replace("/*DATA*/null", json.dumps(data, ensure_ascii=False)), encoding="utf-8")
    print(f"写好了 {out}（{out.stat().st_size / 1e6:.1f} MB）")


if __name__ == "__main__":
    main()
