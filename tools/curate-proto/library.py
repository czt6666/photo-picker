"""全库精选：从一个大目录（比如 ~/workspace/myphotos）的所有照片里挑一组最好看的，做轮播用。

三个模型（B/32、L/14、V2.5）各挑一组，放在同一个网页里切换对比。只读照片，不移动、不改任何文件。

挑法（和单相册不同，轮播要的是"每张都不一样"）：
    1. 清晰度、曝光不过关的淘汰（和所在相册的中位数比）。
    2. 严格去重：时间接近又很像的连拍、或几乎一模一样的照片，一组只留分最高的。
    3. 打散：每次挑"好看分 − 和已选照片的相似度"最大的；每个相册最多拿几张，保证不同旅行都轮得到。

每张照片的分数缓存在 ~/.cache/photopicker-curate/library.pkl（按路径 + 修改时间），中断后重跑会接着算。

用法：python library.py ~/workspace/myphotos --out 全库精选.html
"""

import argparse
import json
import math
import pickle
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from curate import CACHE, EXTS, MODELS, build_head, exposure, load_one, sharpness, thumb_uri  # noqa: E402

KEYS = ["b32", "l14", "v25"]
NAMES = {"b32": "小模型 B/32", "l14": "大模型 L/14", "v25": "V2.5"}


class Scorers:
    """三个模型只加载一次，一批一批地打分。"""

    def __init__(self):
        import open_clip
        import torch

        self.torch = torch
        self.dev = "mps" if torch.backends.mps.is_available() else ("cuda" if torch.cuda.is_available() else "cpu")
        self.clip = {}
        for key in ("b32", "l14"):
            cfg = MODELS[key]
            model, _, prep = open_clip.create_model_and_transforms(*cfg["clip"], cache_dir=str(CACHE / "clip"))
            self.clip[key] = (model.to(self.dev).eval(), prep, build_head(cfg, torch).to(self.dev))
        from aesthetic_predictor_v2_5 import convert_v2_5_from_siglip

        m, p = convert_v2_5_from_siglip(low_cpu_mem_usage=True, trust_remote_code=True)
        dt = torch.float16 if self.dev == "mps" else torch.float32
        self.v25 = (m.to(dt).to(self.dev).eval(), p, dt)
        self.ms = {k: 0.0 for k in KEYS}

    def score(self, imgs):
        torch = self.torch
        out = {}
        with torch.no_grad():
            for key, (model, prep, head) in self.clip.items():
                t0 = time.time()
                x = torch.stack([prep(im) for im in imgs]).to(self.dev)
                e = model.encode_image(x).float()
                e = e / e.norm(dim=-1, keepdim=True)
                out[f"aes_{key}"] = head(e).squeeze(-1).cpu().numpy()
                if key == "l14":
                    out["emb"] = e.cpu().numpy().astype(np.float16)
                self.ms[key] += time.time() - t0
            t0 = time.time()
            model, prep, dt = self.v25
            px = prep(images=imgs, return_tensors="pt").pixel_values.to(self.dev, dt)
            out["aes_v25"] = model(px).logits.squeeze(-1).float().cpu().numpy()
            self.ms["v25"] += time.time() - t0
        return out


def scan(root):
    files = []
    for p in sorted(root.rglob("*")):
        if p.is_file() and p.suffix.lower() in EXTS and not any(part.startswith(".") for part in p.relative_to(root).parts):
            files.append(p)
    return files


def select(feat, key, albums, ok, times, k, cap):
    """严格去重 + 每相册限量的 MMR 打散。"""
    n = len(feat)
    emb = np.stack([f["emb"] for f in feat]).astype(np.float32)
    aes = np.array([f[f"aes_{key}"] for f in feat])

    # 连拍/重复分组（同一相册里按时间排，相邻且很像的并组；全库几乎一模一样的也并组）
    parent = list(range(n))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    order = sorted(range(n), key=lambda i: (albums[i], times[i]))
    for a, b in zip(order, order[1:]):
        if albums[a] == albums[b] and abs(times[b] - times[a]) <= 90 and float(emb[a] @ emb[b]) >= 0.90:
            parent[find(a)] = find(b)
    for i in range(0, n, 512):
        s = emb[i : i + 512] @ emb.T
        for a, b in zip(*np.where(s >= 0.96)):
            if i + a < b:
                parent[find(i + a)] = find(b)
    best = {}
    for i in range(n):
        if ok[i]:
            g = find(i)
            if g not in best or aes[i] > aes[best[g]]:
                best[g] = i
    pool = list(best.values())

    rank = np.empty(n)
    rank[np.argsort(aes)] = np.arange(n) / max(1, n - 1)
    chosen, count, maxsim = [], {}, np.full(n, -1.0)
    while len(chosen) < k:
        cand = [i for i in pool if count.get(albums[i], 0) < cap and i not in chosen]
        if not cand:
            break
        cand = np.array(cand)
        pen = np.clip((maxsim[cand] - 0.70) / 0.25, 0, 1) if chosen else np.zeros(len(cand))
        j = int(cand[np.argmax(rank[cand] - 0.8 * pen)])
        chosen.append(j)
        count[albums[j]] = count.get(albums[j], 0) + 1
        maxsim = np.maximum(maxsim, emb @ emb[j])
    return chosen, len(pool)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("root")
    ap.add_argument("--out", default="全库精选.html")
    args = ap.parse_args()
    root = Path(args.root).expanduser()

    files = scan(root)
    print(f"{root}：{len(files)} 张照片")
    CACHE.mkdir(parents=True, exist_ok=True)
    cache_p = CACHE / "library.pkl"
    cache = pickle.loads(cache_p.read_bytes()) if cache_p.exists() else {}

    todo = [p for p in files if cache.get(str(p), {}).get("mtime") != p.stat().st_mtime]
    print(f"  缓存里已有 {len(files) - len(todo)} 张，要新算 {len(todo)} 张")
    t_all = time.time()
    if todo:
        sc = Scorers()
        from concurrent.futures import ThreadPoolExecutor

        with ThreadPoolExecutor(8) as ex:
            for c in range(0, len(todo), 64):
                chunk = [x for x in ex.map(load_one, todo[c : c + 64]) if x]
                if not chunk:
                    continue
                res = sc.score([it["img"] for it in chunk])
                for i, it in enumerate(chunk):
                    g = np.asarray(it["img"].convert("L"))
                    d, b = exposure(g)
                    cache[str(it["path"])] = {
                        "mtime": it["path"].stat().st_mtime, "time": it["time"], "sharp": sharpness(g),
                        "dark": d, "bright": b, "emb": res["emb"][i],
                        **{f"aes_{k}": float(res[f"aes_{k}"][i]) for k in KEYS},
                    }
                cache_p.write_bytes(pickle.dumps(cache))
                done = min(c + 64, len(todo))
                el = time.time() - t_all
                print(f"  {done}/{len(todo)}，已用 {el / 60:.1f} 分钟，预计还要 {el / done * (len(todo) - done) / 60:.1f} 分钟", flush=True)
        per = {k: round(1000 * v / len(todo)) for k, v in sc.ms.items()}
        print(f"  每张耗时（毫秒）：{per}")
    else:
        per = {}

    paths = [p for p in files if str(p) in cache]
    feat = [cache[str(p)] for p in paths]
    n = len(feat)
    albums = [p.relative_to(root).parts[0] if len(p.relative_to(root).parts) > 1 else "（根目录）" for p in paths]
    times = [f["time"] for f in feat]

    # 质量：清晰度和本相册中位数比
    med = {}
    for a in set(albums):
        med[a] = float(np.median([f["sharp"] for f, b in zip(feat, albums) if b == a]))
    ok = [not (f["sharp"] < 0.25 * med[a] or f["dark"] > 0.45 or f["bright"] > 0.35) for f, a in zip(feat, albums)]

    nalb = len(set(albums))
    k = int(min(80, max(30, round(n * 0.02))))
    cap = max(3, math.ceil(2 * k / nalb))
    print(f"  {nalb} 个相册，质量合格 {sum(ok)} 张；每个模型挑 {k} 张，每个相册最多 {cap} 张")

    runs = {}
    for key in KEYS:
        chosen, groups = select(feat, key, albums, ok, times, k, cap)
        runs[key] = {"chosen": chosen, "groups": groups, "ms": per.get(key)}
        print(f"  {key}: 去重后 {groups} 组，挑了 {len(chosen)} 张")

    used = sorted({i for r in runs.values() for i in r["chosen"]})
    from PIL import Image, ImageOps

    photos = {}
    for i in used:
        im = Image.open(paths[i])
        im.draft("RGB", (1400, 1400))
        im = ImageOps.exif_transpose(im).convert("RGB")
        photos[i] = {
            "name": str(paths[i].relative_to(root)),
            "album": albums[i],
            "src": thumb_uri(im, 640),
            "aes": {k2: round(feat[i][f"aes_{k2}"], 2) for k2 in KEYS},
            "in": [k2 for k2 in KEYS if i in runs[k2]["chosen"]],
        }
    data = {
        "root": root.name, "n": n, "albums": nalb, "ok": sum(ok), "k": k, "cap": cap,
        "names": NAMES, "runs": runs, "photos": photos,
    }
    tpl = (Path(__file__).parent / "library.html").read_text(encoding="utf-8")
    out = Path(args.out).expanduser()
    out.write_text(tpl.replace("/*DATA*/null", json.dumps(data, ensure_ascii=False)), encoding="utf-8")
    print(f"写好了 {out}（{out.stat().st_size / 1e6:.1f} MB），共用 {(time.time() - t_all) / 60:.1f} 分钟")


if __name__ == "__main__":
    main()
