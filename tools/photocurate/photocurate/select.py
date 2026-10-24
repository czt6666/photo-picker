"""挑选：去连拍 + 每个相册限量 + 打散（MMR）。"""

import math

import numpy as np


def default_k(n):
    """挑多少张：约 2%，至少 30、最多 80（照片少于 30 张就全给）。"""
    return min(n, int(min(80, max(30, round(n * 0.02)))))


def default_cap(k, n_albums):
    """每个相册最多几张：平均份额的 2 倍，至少 3 张。"""
    return max(3, math.ceil(2 * k / max(1, n_albums)))


def groups(emb, albums, times, gap=90, burst=0.90, dup=0.96):
    """把连拍和几乎一样的照片并成一组。返回每张照片的组号。
    - 同一相册、拍摄时间相差 gap 秒以内、指纹相似度 ≥ burst：连拍
    - 任何两张相似度 ≥ dup：几乎一样（比如同一张的不同导出版本）"""
    n = len(emb)
    parent = list(range(n))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    order = sorted(range(n), key=lambda i: (albums[i], times[i]))
    for a, b in zip(order, order[1:]):
        if albums[a] == albums[b] and abs(times[b] - times[a]) <= gap and float(emb[a] @ emb[b]) >= burst:
            parent[find(a)] = find(b)
    for i in range(0, n, 512):
        s = emb[i:i + 512] @ emb.T
        for a, b in zip(*np.where(s >= dup)):
            if i + a < b:
                parent[find(i + a)] = find(b)
    return [find(i) for i in range(n)]


def pick(scores, emb, albums, times, allow, k, cap, spread=0.8):
    """scores：美学分；emb：指纹（n×d，已归一化）；allow[i]：这张能不能当候选。返回选中的下标（按挑选顺序）。

    1. 每组连拍只留分最高的一张当候选。
    2. 每一步挑「分数排名 − spread × 和已选照片的相似惩罚」最大的。相似度 0.70 以下不罚，0.95 罚满，
       所以第一张一定是分最高的，后面越来越照顾"别和已选的太像"。
    3. 一个相册选满 cap 张就不再从它里面挑。"""
    n = len(scores)
    emb = np.asarray(emb, dtype=np.float32)
    s = np.nan_to_num(np.asarray(scores, dtype=np.float64), nan=-1e9)
    g = groups(emb, albums, times)
    best = {}
    for i in range(n):
        if allow[i] and (g[i] not in best or s[i] > s[best[g[i]]]):
            best[g[i]] = i
    pool = list(best.values())
    rank = np.empty(n)
    rank[np.argsort(s)] = np.arange(n) / max(1, n - 1)
    chosen, count, maxsim = [], {}, np.full(n, -1.0)
    while len(chosen) < k:
        cand = np.array([i for i in pool if count.get(albums[i], 0) < cap and i not in chosen], dtype=int)
        if not len(cand):
            break
        pen = np.clip((maxsim[cand] - 0.70) / 0.25, 0, 1) if chosen else np.zeros(len(cand))
        j = int(cand[np.argmax(rank[cand] - spread * pen)])
        chosen.append(j)
        count[albums[j]] = count.get(albums[j], 0) + 1
        maxsim = np.maximum(maxsim, emb @ emb[j])
    return chosen
