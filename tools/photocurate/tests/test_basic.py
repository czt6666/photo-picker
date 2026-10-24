"""不需要下载模型的测试：用假模型跑一遍分析和挑选，再单独测人像判定规则和去连拍。"""

import numpy as np
from PIL import Image

from photocurate import Curator, classify, scan
from photocurate import select


class FakeEmb:
    """每张图一个互不相干的随机方向（真实照片内容不同，指纹也不同）。"""
    def __init__(self):
        self.rng = np.random.default_rng(1)

    def __call__(self, imgs):
        v = self.rng.standard_normal((len(imgs), 64))
        return list((v / np.linalg.norm(v, axis=1, keepdims=True)).astype(np.float16))


class FakeAes:
    def __call__(self, imgs):
        return [float(np.asarray(im).mean()) / 25 for im in imgs]


class FakeYolo:
    def __call__(self, path):
        # 文件名带 person 的照片里有个大人（骨架清楚）
        return {"boxes": [[0.4, 0.2, 0.6, 0.9, 0.9, 12]] if "person" in path.name else []}


def make(tmp_path):
    rng = np.random.default_rng(0)
    for album in ("a", "b"):
        (tmp_path / album).mkdir()
        for i in range(12):
            arr = (rng.random((64, 96, 3)) * (60 + i * 15)).astype(np.uint8)
            name = f"{'person' if i % 3 == 0 else 'land'}{i}.jpg"
            Image.fromarray(arr).save(tmp_path / album / name)
    (tmp_path / "_work").mkdir()
    Image.new("RGB", (10, 10)).save(tmp_path / "_work" / "skip.jpg")


def curator(tmp_path):
    c = Curator(tmp_path / "cache.pkl", log=False)
    c._emb, c._aes, c._yolo = FakeEmb(), FakeAes(), FakeYolo()
    return c


def test_analyze_and_pick(tmp_path):
    make(tmp_path)
    paths = scan(tmp_path)
    assert len(paths) == 24  # _ 开头的目录跳过
    photos = curator(tmp_path).analyze(paths, root=tmp_path)
    assert {p.album for p in photos} == {"a", "b"}
    assert {p.kind for p in photos if "person" in p.path.name} == {"人像"}
    best = curator(tmp_path).pick(photos, k=6, per_album=3)
    assert len(best) == 6 and best[0].score == max(p.score for p in photos if p.ok)
    assert all(sum(p.album == a for p in best) <= 3 for a in ("a", "b"))
    walls = curator(tmp_path).pick(photos, k=6, wall=True)
    assert walls and all(p.kind == "无人" for p in walls)


def test_cache_reused(tmp_path):
    make(tmp_path)
    paths = scan(tmp_path)
    curator(tmp_path).analyze(paths, root=tmp_path)
    c = Curator(tmp_path / "cache.pkl", log=False)  # 没有模型：缓存齐了就不该去加载
    assert len(c.analyze(paths, root=tmp_path)) == 24


def test_classify_rules():
    ripple = {"boxes": [[0.4, 0.3, 0.5, 0.8, 0.5, 2]]}        # 大框、找不到骨架：波纹、树林
    assert classify(None, ripple)[0] == "无人"
    assert classify(None, {"boxes": [[0.4, 0.3, 0.5, 0.8, 0.5, 9]]})[0] == "人像"
    assert classify(None, {"boxes": [[0.4, 0.3, 0.41, 0.33, 0.45, -1]]})[0] == "有人"   # 航拍小人
    assert classify(None, {"boxes": [[0.4, 0.3, 0.41, 0.33, 0.2, 0]]})[0] == "无人"
    assert classify({"bodies": [], "faces": [[0.1, 0.1, 0.2, 0.2, 0.9]]}, {"boxes": []})[0] == "人像"


def test_burst_grouping():
    e = np.eye(4, dtype=np.float32)
    e[1] = e[0]                                   # 0 和 1 一模一样
    g = select.groups(e, ["a"] * 4, [0, 10, 20, 30])
    assert g[0] == g[1] and len(set(g)) == 3
