"""全库精选：从一个大目录（比如 ~/workspace/myphotos）的所有照片里挑一组最好看的，做轮播 / 壁纸用。

几个美学模型各挑一组，放在同一个网页里切换对比；每个模型再挑一组「不含人像」的，给壁纸用。
只读照片，不移动、不改任何文件。

模型（都在本地跑）：
    l14      LAION 改进版美学打分器，底座 OpenAI CLIP ViT-L/14（2022）
    v25      Aesthetic Predictor V2.5，底座 Google SigLIP so400m（2024）
    topiq    TOPIQ-IAA（2023），在 AVA 上训练的专用美学网络，靠 pyiqa 加载
    qrealign Q-ReAlign Mini（Qwen3.5-VL 0.8B 视觉语言模型），问它"这张图美学如何"，
             看它回答 excellent / good / fair / poor / bad 的概率，加权成 0～1 分

挑法（轮播要的是"每张都不一样"）：
    1. 清晰度、曝光不过关的淘汰（和所在相册的中位数比）。
    2. 严格去重：时间接近又很像的连拍、或几乎一模一样的照片，一组只留分最高的。
    3. 打散：每次挑"好看分 − 和已选照片的相似度"最大的；每个相册最多拿几张，保证不同旅行都轮得到。

每张照片的分数缓存在 ~/.cache/photopicker-curate/library.pkl（按路径 + 修改时间，每个模型分开存），
中断后重跑会接着算；加了新模型只算新模型。

用法：python library.py ~/workspace/myphotos --out 全库精选.html [--models l14,v25,topiq,qrealign]
"""

import argparse
import json
import math
import pickle
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
import people  # noqa: E402
from curate import CACHE, EXTS, MODELS, build_head, exposure, load_one, sharpness, thumb_uri  # noqa: E402

NAMES = {"l14": "LAION L/14", "v25": "V2.5", "topiq": "TOPIQ", "qrealign": "Q-ReAlign"}


def device():
    import torch

    return "mps" if torch.backends.mps.is_available() else ("cuda" if torch.cuda.is_available() else "cpu")


class L14:
    """CLIP L/14：给出指纹（去重、相似度、人像判断都用它）和 LAION 美学分。"""

    def __init__(self):
        import open_clip
        import torch

        self.torch, self.dev = torch, device()
        cfg = MODELS["l14"]
        m, _, self.prep = open_clip.create_model_and_transforms(*cfg["clip"], cache_dir=str(CACHE / "clip"))
        self.model = m.to(self.dev).eval()
        self.head = build_head(cfg, torch).to(self.dev)
        self.probe = people.TextProbe(self.model, self.dev)

    def __call__(self, imgs, paths):
        with self.torch.no_grad():
            x = self.torch.stack([self.prep(im) for im in imgs]).to(self.dev)
            e = self.model.encode_image(x).float()
            e = e / e.norm(dim=-1, keepdim=True)
            aes = self.head(e).squeeze(-1).cpu().numpy()
        e = e.cpu().numpy()
        prob = self.probe.person_prob(e)
        return [{"emb": e[i].astype(np.float16), "aes_l14": float(aes[i]), "person_p": float(prob[i])} for i in range(len(imgs))]


class V25:
    def __init__(self):
        import torch
        from aesthetic_predictor_v2_5 import convert_v2_5_from_siglip

        self.torch, self.dev = torch, device()
        m, self.prep = convert_v2_5_from_siglip(low_cpu_mem_usage=True, trust_remote_code=True)
        self.dt = torch.float16 if self.dev == "mps" else torch.float32
        self.model = m.to(self.dt).to(self.dev).eval()

    def __call__(self, imgs, paths):
        with self.torch.no_grad():
            px = self.prep(images=imgs, return_tensors="pt").pixel_values.to(self.dev, self.dt)
            s = self.model(px).logits.squeeze(-1).float().cpu().tolist()
        return [{"aes_v25": float(v)} for v in s]


class Topiq:
    def __init__(self):
        import pyiqa
        import torch

        self.torch, self.dev = torch, device()
        self.metric = pyiqa.create_metric("topiq_iaa", device=self.dev)

    def __call__(self, imgs, paths):
        import torchvision.transforms.functional as TF

        out = []
        with self.torch.no_grad():
            for im in imgs:
                x = TF.to_tensor(im).unsqueeze(0).to(self.dev)
                out.append({"aes_topiq": float(self.metric(x).item())})
        return out


class QReAlign:
    LEVELS = ["excellent", "good", "fair", "poor", "bad"]
    WEIGHTS = [1.0, 0.75, 0.5, 0.25, 0.0]

    def __init__(self):
        import torch
        from transformers import AutoModelForImageTextToText, AutoProcessor

        self.torch, self.dev = torch, device()
        ck = "q-future/Q-ReAlign-Mini-0.8B"
        self.proc = AutoProcessor.from_pretrained(ck)
        dt = torch.float16 if self.dev == "mps" else torch.float32
        self.model = AutoModelForImageTextToText.from_pretrained(ck, dtype=dt).to(self.dev).eval()
        self.ids = [self.proc.tokenizer(" " + w, add_special_tokens=False).input_ids[0] for w in self.LEVELS]
        self.w = torch.tensor(self.WEIGHTS, device=self.dev)
        msgs = [{"role": "user", "content": [{"type": "image"}, {"type": "text", "text": "How would you rate the aesthetics of this image?"}]}]
        self.text = self.proc.apply_chat_template(msgs, add_generation_prompt=True) + "The aesthetics of the image is"

    def __call__(self, imgs, paths):
        out = []
        with self.torch.no_grad():
            for im in imgs:
                inp = self.proc(text=[self.text], images=[im], return_tensors="pt").to(self.dev)
                p = self.model(**inp).logits[0, -1, self.ids].float().softmax(-1)
                out.append({"aes_qrealign": float((p * self.w).sum().item())})
        return out


class YoloPeople:
    """YOLO11 找人（整图 + 大图切 2×2），读原文件。"""

    def __init__(self):
        self.det = people.Yolo()

    def __call__(self, imgs, paths):
        return [{"yolo": self.det(p)} for p in paths]


class Vision:
    """苹果 Vision 的人体/人脸检测，读原文件（只在 Mac 上）。"""

    def __init__(self):
        import Vision as _  # noqa: F401

    def __call__(self, imgs, paths):
        out = []
        for p in paths:
            try:
                out.append({"vision": people.vision_people(p)})
            except Exception as e:
                print(f"  Vision 失败 {p.name}: {e}", file=sys.stderr)
                out.append({"vision": None})
        return out


SCORERS = {"l14": (L14, "aes_l14"), "v25": (V25, "aes_v25"), "topiq": (Topiq, "aes_topiq"),
           "qrealign": (QReAlign, "aes_qrealign"), "vision": (Vision, "vision"), "yolo": (YoloPeople, "yolo")}


def scan(root):
    return [p for p in sorted(root.rglob("*"))
            if p.is_file() and p.suffix.lower() in EXTS and not any(x.startswith(".") for x in p.relative_to(root).parts)]


def select(feat, key, albums, ok, times, k, cap, allow):
    """严格去重 + 每相册限量的 MMR 打散。allow[i] = 这张能不能进候选（比如壁纸要排除人像）。"""
    n = len(feat)
    emb = np.stack([f["emb"] for f in feat]).astype(np.float32)
    aes = np.array([f.get(f"aes_{key}", np.nan) for f in feat], dtype=np.float64)
    aes = np.nan_to_num(aes, nan=np.nanmin(aes) if not np.isnan(aes).all() else 0.0)

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
        if ok[i] and allow[i]:
            g = find(i)
            if g not in best or aes[i] > aes[best[g]]:
                best[g] = i
    pool = list(best.values())

    rank = np.empty(n)
    rank[np.argsort(aes)] = np.arange(n) / max(1, n - 1)
    chosen, count, maxsim = [], {}, np.full(n, -1.0)
    while len(chosen) < k:
        cand = np.array([i for i in pool if count.get(albums[i], 0) < cap and i not in chosen], dtype=int)
        if not len(cand):
            break
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
    ap.add_argument("--models", default="l14,v25,topiq,qrealign")
    args = ap.parse_args()
    root = Path(args.root).expanduser()
    keys = [m.strip() for m in args.models.split(",") if m.strip()]
    if "l14" not in keys:
        keys.insert(0, "l14")  # 指纹总要有
    jobs = keys + (["vision", "yolo"] if sys.platform == "darwin" else ["yolo"])

    files = scan(root)
    print(f"{root}：{len(files)} 张照片")
    CACHE.mkdir(parents=True, exist_ok=True)
    cache_p = CACHE / "library.pkl"
    cache = pickle.loads(cache_p.read_bytes()) if cache_p.exists() else {}
    for p in files:
        c = cache.get(str(p))
        if c is not None and c.get("mtime") != p.stat().st_mtime:
            del cache[str(p)]

    t_all, per = time.time(), {}
    # 一个模型一个模型地算：同时只占一个模型的内存
    for job in jobs:
        field = SCORERS[job][1]
        if job == "l14":
            todo = [p for p in files if "person_p" not in cache.get(str(p), {})]
        else:
            todo = [p for p in files if str(p) in cache and field not in cache[str(p)]]
            if job == "vision":  # 旧缓存没有人体框高度，重算
                todo = [p for p in files if str(p) in cache and "body_h" not in (cache[str(p)].get("vision") or {})]
        if not todo:
            continue
        print(f"  {job}：要算 {len(todo)} 张", flush=True)
        try:
            sc = SCORERS[job][0]()
        except Exception as e:
            print(f"  {job} 加载失败，跳过：{e}", flush=True)
            continue
        t0, spent = time.time(), 0.0
        with ThreadPoolExecutor(8) as ex:
            for c in range(0, len(todo), 32):
                chunk = [x for x in ex.map(load_one, todo[c : c + 32]) if x]
                if not chunk:
                    continue
                t1 = time.time()
                res = sc([it["img"] for it in chunk], [it["path"] for it in chunk])
                spent += time.time() - t1
                for it, r in zip(chunk, res):
                    key = str(it["path"])
                    if key not in cache:
                        g = np.asarray(it["img"].convert("L"))
                        d, b = exposure(g)
                        cache[key] = {"mtime": it["path"].stat().st_mtime, "time": it["time"],
                                      "sharp": sharpness(g), "dark": d, "bright": b}
                    cache[key].update(r)
                if (c // 32) % 4 == 3 or c + 32 >= len(todo):
                    cache_p.write_bytes(pickle.dumps(cache))
                    done = min(c + 32, len(todo))
                    el = time.time() - t0
                    print(f"    {done}/{len(todo)}，预计还要 {el / done * (len(todo) - done) / 60:.1f} 分钟", flush=True)
        per[job] = round(1000 * spent / len(todo))
        del sc
    if per:
        print(f"  每张耗时（毫秒，仅模型本身）：{per}")

    paths = [p for p in files if str(p) in cache and "emb" in cache[str(p)]]
    feat = [cache[str(p)] for p in paths]
    n = len(feat)
    albums = [p.relative_to(root).parts[0] if len(p.relative_to(root).parts) > 1 else "（根目录）" for p in paths]
    times = [f["time"] for f in feat]
    med = {a: float(np.median([f["sharp"] for f, b in zip(feat, albums) if b == a])) for a in set(albums)}
    ok = [not (f["sharp"] < 0.25 * med[a] or f["dark"] > 0.45 or f["bright"] > 0.35) for f, a in zip(feat, albums)]

    cls = [people.classify(f.get("vision"), f["person_p"], f.get("yolo")) for f in feat]
    kinds = [c[0] for c in cls]
    counts = {k2: kinds.count(k2) for k2 in ("人像", "有人", "无人")}
    print(f"  人像识别：{counts}")

    nalb = len(set(albums))
    k = int(min(80, max(30, round(n * 0.02))))
    cap = max(3, math.ceil(2 * k / nalb))
    print(f"  {nalb} 个相册，质量合格 {sum(ok)} 张；每个模型挑 {k} 张，每个相册最多 {cap} 张")

    runs = {}
    # 壁纸只收三路检测都说没人的（宁可错杀）
    everyone, no_people = [True] * n, [kd == "无人" for kd in kinds]
    for key in keys:
        if not any(f"aes_{key}" in f for f in feat):
            continue
        a, g = select(feat, key, albums, ok, times, k, cap, everyone)
        b, g2 = select(feat, key, albums, ok, times, k, cap, no_people)
        runs[key] = {"all": a, "wall": b, "groups": g, "ms": per.get(key)}
        print(f"  {key}: 去重后 {g} 组，挑 {len(a)} 张；不含人像 {len(b)} 张")

    # 人像识别抽查：每类按 CLIP 概率排开取一些，边界上的也看得到
    rng = np.random.default_rng(0)
    sample = {}
    for kd, m in (("人像", 36), ("有人", 48), ("无人", 48)):
        idx = [i for i in range(n) if kinds[i] == kd]
        if len(idx) > m:
            idx = rng.choice(idx, m, replace=False).tolist()
        # 无人：最像有人的排前面（最可能漏判）；其他两类：最不像的排前面
        idx = sorted(idx, key=lambda i: -feat[i]["person_p"] if kd == "无人" else feat[i]["person_p"])
        sample[kd] = idx

    big = sorted({i for r in runs.values() for i in r["all"] + r["wall"]})
    small = sorted({i for v in sample.values() for i in v} - set(big))
    from PIL import Image, ImageOps

    photos = {}
    for i, size in [(i, 480) for i in big] + [(i, 300) for i in small]:
        im = Image.open(paths[i])
        im.draft("RGB", (1000, 1000))
        im = ImageOps.exif_transpose(im).convert("RGB")
        photos[i] = {
            "name": str(paths[i].relative_to(root)), "album": albums[i], "src": thumb_uri(im, size),
            "aes": {k2: round(feat[i][f"aes_{k2}"], 3) for k2 in runs if f"aes_{k2}" in feat[i]},
            "kind": kinds[i], "why": cls[i][1],
        }
    data = {"root": root.name, "n": n, "albums": nalb, "ok": sum(ok), "k": k, "cap": cap, "kinds": counts,
            "names": {k2: NAMES[k2] for k2 in runs}, "runs": runs, "sample": sample, "photos": photos}
    tpl = (Path(__file__).parent / "library.html").read_text(encoding="utf-8")
    out = Path(args.out).expanduser()
    out.write_text(tpl.replace("/*DATA*/null", json.dumps(data, ensure_ascii=False)), encoding="utf-8")
    print(f"写好了 {out}（{out.stat().st_size / 1e6:.1f} MB），共用 {(time.time() - t_all) / 60:.1f} 分钟")


if __name__ == "__main__":
    main()
