"""加上苹果 Vision 的两个打分，和通用美学分比一比，看谁更接近你自己挑的。

苹果系统里自带（不用下载，只在 Mac 上有）：
    - 人脸拍摄质量 VNDetectFaceCaptureQualityRequest：每张脸 0～1 分。苹果用它从连拍里挑"脸拍得最好"的那张，
      会综合脸清不清楚、闭没闭眼、表情、角度、光线。
    - 图片美学分 VNCalculateImageAestheticsScoresRequest（macOS 15 起）：整张图 -1～1 分，
      还会标出"实用照片"（截图、文件、收据）。相册 App 的精选/回忆大致靠这类分数。

评估三个指标：
    1. 排序重合：按分数排前 k（k = 你挑的张数），和你挑的重合几张。
    2. 宽松去重后重合：只合并几乎一模一样的照片，再打散挑 k 张。
    3. 连拍挑对率：一组相似照片里，你挑了一部分、没挑一部分；分数最高那张是不是你挑的。
       这个最能看出"同一场景里分得清好坏"，瞎蒙的期望是组里你挑的占比。

用法：python faces.py <相册文件夹> <curate.py 输出的 .npz>
"""

import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from curate import pick  # noqa: E402


def vision_scores(path):
    import Vision
    from Foundation import NSURL

    handler = Vision.VNImageRequestHandler.alloc().initWithURL_options_(NSURL.fileURLWithPath_(str(path)), None)
    fq = Vision.VNDetectFaceCaptureQualityRequest.alloc().init()
    reqs = [fq]
    aes = None
    if hasattr(Vision, "VNCalculateImageAestheticsScoresRequest"):
        aes = Vision.VNCalculateImageAestheticsScoresRequest.alloc().init()
        reqs.append(aes)
    ok, err = handler.performRequests_error_(reqs, None)
    faces = []
    for f in fq.results() or []:
        bb = f.boundingBox()
        q = f.faceCaptureQuality()
        faces.append({"q": float(q) if q is not None else 0.0, "area": float(bb.size.width * bb.size.height)})
    out = {"faces": faces, "aes": None, "utility": None}
    if aes is not None and aes.results():
        r = aes.results()[0]
        out["aes"] = float(r.overallScore())
        out["utility"] = bool(r.isUtility())
    return out


def z(x):
    x = np.asarray(x, dtype=np.float64)
    return (x - x.mean()) / (x.std() + 1e-9)


def groups_of(times, emb, gap=90, burst=0.90):
    order = np.argsort(times)
    gid = np.zeros(len(times), dtype=int)
    g = 0
    for a, b in zip(order, order[1:]):
        if not (abs(times[b] - times[a]) <= gap and float(emb[a] @ emb[b]) >= burst):
            g += 1
        gid[b] = g
    return gid


def main():
    folder, npz = Path(sys.argv[1]).expanduser(), Path(sys.argv[2])
    d = dict(np.load(npz, allow_pickle=True))
    names = [str(x) for x in d["names"]]
    cache = npz.with_suffix(".vision.json")
    vis = json.loads(cache.read_text()) if cache.exists() else {}
    todo = [nm for nm in names if nm not in vis]
    if todo:
        import time

        t0 = time.time()
        for i, nm in enumerate(todo):
            try:
                vis[nm] = vision_scores(folder / nm)
            except Exception as e:
                print(f"  Vision 失败 {nm}: {e}", file=sys.stderr)
                vis[nm] = {"faces": [], "aes": None, "utility": None}
        dt = time.time() - t0
        print(f"Vision：{len(todo)} 张，每张 {1000 * dt / len(todo):.0f}ms")
        cache.write_text(json.dumps(vis))

    picked = d["picked"].astype(bool)
    n, k = len(picked), int(picked.sum())
    emb = d["emb_l14"].astype(np.float32)
    times = d["time"]
    ok = list(d["ok"])

    # 主脸 = 面积最大的那张脸；脸太小（不到画面 0.3%）当没有人像
    faceq = np.full(n, np.nan)
    for i, nm in enumerate(names):
        fs = [f for f in vis[nm]["faces"] if f["area"] >= 0.003]
        if fs:
            faceq[i] = max(fs, key=lambda f: f["area"])["q"]
    has_face = ~np.isnan(faceq)
    apple = np.array([vis[nm]["aes"] if vis[nm]["aes"] is not None else np.nan for nm in names])
    has_apple = not np.isnan(apple).all()
    util = sum(1 for nm in names if vis[nm]["utility"])

    print(f"\n{d['album']}：{n} 张，你挑 {k} 张；有人脸 {has_face.sum()} 张（你挑的里 {int((has_face & picked).sum())} 张）；"
          f"苹果美学分{'有' if has_apple else '没有（系统低于 macOS 15）'}；实用照片 {util} 张")

    l14 = z(d["aes_l14"])
    fz = np.zeros(n)
    if has_face.any():
        fz[has_face] = z(faceq[has_face])
    scores = {"通用美学 L14": l14, "通用 + 人脸": l14 + fz}
    if has_apple:
        az = z(np.nan_to_num(apple, nan=np.nanmean(apple)))
        scores["苹果美学"] = az
        scores["苹果美学 + 人脸"] = az + fz
        scores["通用 + 苹果 + 人脸"] = l14 + az + fz
    v25 = npz.with_suffix(".v25.json")
    if v25.exists():
        vs = json.loads(v25.read_text())
        vz = z([vs[nm] for nm in names])
        scores["美学 v2.5"] = vz
        scores["v2.5 + 通用"] = vz + l14
        scores["v2.5 + 人脸"] = vz + fz
    if has_face.any():
        only = np.where(has_face, fz, -9)
        scores["只看人脸（有脸的）"] = only

    gid = groups_of(times, emb)
    mixed = [np.where(gid == g)[0] for g in np.unique(gid)]
    mixed = [m for m in mixed if len(m) >= 2 and picked[m].any() and (~picked[m]).any()]
    rand_burst = sum(picked[m].mean() for m in mixed)
    items = [{"time": t} for t in times]

    print(f"\n瞎蒙：排序重合 {k * k / n:.1f}，连拍挑对 {rand_burst:.1f} / {len(mixed)} 组")
    print("打分方式 | 排序重合 | 宽松去重后重合 | 连拍挑对")
    for name, s in scores.items():
        top = int(picked[np.argsort(-s)[:k]].sum())
        chosen, _, _ = pick(items, emb, s, ok, k, gap=10, burst=0.97, dup=0.985)
        loose = int(picked[chosen].sum())
        burst_hit = sum(int(picked[m[np.argmax(s[m])]]) for m in mixed)
        print(f"{name} | {top} | {loose} | {burst_hit} / {len(mixed)}")


if __name__ == "__main__":
    main()
