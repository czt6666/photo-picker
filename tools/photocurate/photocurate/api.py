"""对外的接口：Curator.analyze() 给照片打分、分类；Curator.pick() 挑精选。"""

import sys
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from . import images, people, select
from .cache import Cache


@dataclass
class Photo:
    path: Path
    album: str              # 属于哪个相册（root 下的一级目录）；同相册的照片才算连拍、才一起限量
    time: float             # 拍摄时间（时间戳）
    score: float            # V2.5 美学分，大致 1～10，5 普通，6 以上好看
    kind: str               # 人像 / 有人 / 无人
    why: str                # 人像判定的依据，比如「人高 67% · 人脸 0.96% · 算数的人 6」
    ok: bool                # 清晰度、曝光过关（和同相册的照片比，明显糊、太黑、太亮的为 False）
    emb: np.ndarray = field(repr=False)   # 图像指纹，比两张像不像用

    @property
    def wallpaper(self):
        """能不能当壁纸：没检测到人，且画质过关。"""
        return self.kind == "无人" and self.ok


class Curator:
    """
    c = Curator()
    photos = c.analyze(scan("~/Pictures/旅行"), root="~/Pictures/旅行")
    best = c.pick(photos, wall=True)        # 壁纸：只从没人的里挑

    analyze 只算缓存里没有的；人像识别要 YOLO（每张约 1.6 秒），Mac 上还会用苹果 Vision。
    """

    def __init__(self, cache_path=None, find_people=True, batch=32, log=True):
        self.cache = Cache(cache_path)
        self.find_people = find_people
        self.batch = batch
        self.log = (lambda *a: print(*a, file=sys.stderr, flush=True)) if log else (lambda *a: None)
        self._aes = self._emb = self._yolo = None

    # ---------- 分析 ----------

    def analyze(self, paths, root=None):
        """给每张照片算齐：拍摄时间、清晰度、曝光、指纹、美学分、人像分类。
        返回 Photo 列表（顺序同 paths；读不了的照片跳过）。root 用来定相册：root 下的一级目录算一个相册。"""
        paths = [Path(p).expanduser() for p in paths]
        root = Path(root).expanduser() if root else None
        recs = [self.cache.get(p) for p in paths]

        need = [i for i, r in enumerate(recs) if not {"time", "sharp", "emb", "aes_v25"} <= r.keys()]
        if need:
            self._run_images([paths[i] for i in need], [recs[i] for i in need])
        if self.find_people:
            need = [i for i, r in enumerate(recs) if "yolo2" not in r and "aes_v25" in r]
            if need:
                self._run_people([paths[i] for i in need], [recs[i] for i in need])
        self.cache.save()

        keep = [i for i, r in enumerate(recs) if "aes_v25" in r]
        paths, recs = [paths[i] for i in keep], [recs[i] for i in keep]
        albums = [self._album(p, root) for p in paths]
        med = {}
        for a, r in zip(albums, recs):
            med.setdefault(a, []).append(r["sharp"])
        med = {a: float(np.median(v)) for a, v in med.items()}
        out = []
        for p, a, r in zip(paths, albums, recs):
            if self.find_people:
                kind, why = people.classify(r.get("vision2"), r.get("yolo2"))
            else:
                kind, why = "未知", ""
            ok = not (r["sharp"] < 0.25 * med[a] or r["dark"] > 0.45 or r["bright"] > 0.35)
            out.append(Photo(p, a, r["time"], r["aes_v25"], kind, why, ok, np.asarray(r["emb"], dtype=np.float32)))
        return out

    @staticmethod
    def _album(p, root):
        if root is None:
            return p.parent.name
        parts = p.relative_to(root).parts
        return parts[0] if len(parts) > 1 else "（根目录）"

    def _run_images(self, paths, recs):
        from .models import Aesthetic, Embedder

        self.log(f"美学分：要算 {len(paths)} 张")
        self._emb = self._emb or Embedder(self.cache.path.parent / "clip")
        self._aes = self._aes or Aesthetic()
        t0 = time.time()
        with ThreadPoolExecutor(8) as ex:
            for c in range(0, len(paths), self.batch):
                part = list(zip(paths[c:c + self.batch], recs[c:c + self.batch]))
                loaded = list(ex.map(lambda x: self._load(x[0]), part))
                good = [(r, im) for (p, r), im in zip(part, loaded) if im is not None]
                if not good:
                    continue
                imgs = [im[0] for _, im in good]
                for (r, (img, t)), e, s in zip(good, self._emb(imgs), self._aes(imgs)):
                    g = np.asarray(img.convert("L"))
                    d, b = images.exposure(g)
                    r.update(time=t, sharp=images.sharpness(g), dark=d, bright=b, emb=e, aes_v25=s)
                done = min(c + self.batch, len(paths))
                self.log(f"  {done}/{len(paths)}，还要约 {(time.time() - t0) / done * (len(paths) - done) / 60:.1f} 分钟")
                if (c // self.batch) % 4 == 3:
                    self.cache.save()

    def _load(self, p):
        try:
            return images.load_small(p)
        except Exception as e:
            self.log(f"  跳过 {p.name}: {e}")
            return None

    def _run_people(self, paths, recs):
        self.log(f"人像识别：要算 {len(paths)} 张")
        self._yolo = self._yolo or people.Yolo(self.cache.path.parent / "yolo")
        mac = sys.platform == "darwin"
        t0 = time.time()
        for n, (p, r) in enumerate(zip(paths, recs), 1):
            if mac:
                try:
                    r["vision2"] = people.vision_people(p)
                except Exception as e:
                    self.log(f"  Vision 失败 {p.name}: {e}")
                    r["vision2"] = None
            try:
                r["yolo2"] = self._yolo(p)
            except Exception as e:
                self.log(f"  YOLO 失败 {p.name}: {e}")  # 不写 yolo2：下次重试，也不会被当成「无人」
            if n % 50 == 0 or n == len(paths):
                self.cache.save()
                self.log(f"  {n}/{len(paths)}，还要约 {(time.time() - t0) / n * (len(paths) - n) / 60:.1f} 分钟")

    # ---------- 挑选 ----------

    def pick(self, photos, k=None, per_album=None, wall=False, kinds=None, spread=0.8):
        """从 photos 里挑 k 张：去连拍、每个相册最多 per_album 张、尽量不重样。返回 Photo 列表（第一张分最高）。

        wall=True：只从「无人」里挑（壁纸）。kinds：只从这些类别里挑，比如 {"人像"}。
        k、per_album 不给就按数量自动定（约 2%，30～80 张；每相册 = 平均份额 × 2）。
        画质不过关的不会被挑。"""
        if not photos:
            return []
        if wall:
            kinds = {"无人"}
        n = len(photos)
        k = select.default_k(n) if k is None else k
        albums = [p.album for p in photos]
        per_album = select.default_cap(k, len(set(albums))) if per_album is None else per_album
        allow = [p.ok and (kinds is None or p.kind in kinds) for p in photos]
        idx = select.pick([p.score for p in photos], np.stack([p.emb for p in photos]), albums,
                          [p.time for p in photos], allow, k, per_album, spread)
        return [photos[i] for i in idx]
