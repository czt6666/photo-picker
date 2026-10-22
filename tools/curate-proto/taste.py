"""学你的口味：用你在别的相册里挑过的照片，训练一个只属于你的打分器，再去挑没见过的相册。

原理：CLIP 指纹里已经藏着"花特写 / 人像 / 建筑 / 逆光 / 虚化"这些信息。
通用美学分是"网上大众觉得好看"；这里换成"你挑过的那些照片的指纹长什么样"。
做法是最简单的逻辑回归：在 768 个数字上各学一个权重，加起来越大越像你会挑的。

评估用"留一个相册"：拿其余相册训练，在留出的相册上挑和你一样多的张数，数重合几张，
和通用美学分、瞎蒙三者对比。训练时从没见过被测的相册，所以不是作弊。

用法：python taste.py 结果1.npz 结果2.npz ... [--model l14]
"""

import argparse
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from curate import pick  # noqa: E402


def train(X, y, lam=1.0, iters=300, lr=0.5):
    """L2 正则的逻辑回归，正负样本按数量配平（你挑的通常只占一小部分）。"""
    w = np.zeros(X.shape[1])
    b = 0.0
    pos = y.mean()
    sw = np.where(y, 0.5 / pos, 0.5 / (1 - pos))
    for _ in range(iters):
        z = X @ w + b
        p = 1 / (1 + np.exp(-z))
        g = sw * (p - y)
        w -= lr * (X.T @ g / len(y) + lam * w / len(y))
        b -= lr * g.mean()
    return w, b


def overlap(order, picked, k):
    return int(picked[order[:k]].sum())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("npz", nargs="+")
    ap.add_argument("--model", default="l14")
    args = ap.parse_args()
    albums = [dict(np.load(p, allow_pickle=True)) for p in args.npz]
    albums = [a for a in albums if a["picked"].any() and f"emb_{args.model}" in a]
    print(f"{len(albums)} 个有你挑选记录的相册，模型 {args.model}\n")
    print("相册 | 张数 | 你挑 | 瞎蒙 | 通用美学(排序/去重打散) | 你的口味(排序/去重打散)")
    tot = np.zeros(5)
    for i, a in enumerate(albums):
        rest = [b for j, b in enumerate(albums) if j != i]
        if not rest:
            break
        X = np.concatenate([b[f"emb_{args.model}"].astype(np.float32) for b in rest])
        y = np.concatenate([b["picked"] for b in rest]).astype(np.float64)
        w, b0 = train(X, y)
        E = a[f"emb_{args.model}"].astype(np.float32)
        mine = E @ w + b0
        gen = a[f"aes_{args.model}"]
        picked = a["picked"]
        n, k = len(picked), int(picked.sum())
        items = [{"time": t} for t in a["time"]]
        ok = list(a["ok"])
        row = [k * k / n]
        for score in (gen, mine):
            row.append(overlap(np.argsort(-score), picked, k))
            chosen, _, _ = pick(items, E, score, ok, k)
            row.append(int(picked[chosen].sum()))
        tot += row
        print(f"{a['album']} | {n} | {k} | {row[0]:.1f} | {row[1]} / {row[2]} | {row[3]} / {row[4]}")
    print(f"合计 | | | {tot[0]:.1f} | {tot[1]:.0f} / {tot[2]:.0f} | {tot[3]:.0f} / {tot[4]:.0f}")


if __name__ == "__main__":
    main()
