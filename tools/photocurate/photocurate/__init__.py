"""photocurate：从一堆照片里挑出最好看的。

    from photocurate import Curator, scan

    c = Curator()                                    # 分数缓存在 ~/.cache/photopicker-curate/library.pkl
    photos = c.analyze(scan("~/workspace/myphotos"), root="~/workspace/myphotos")
    best = c.pick(photos)                            # 全库精选（约 2%，30～80 张）
    walls = c.pick(photos, wall=True)                # 壁纸：不含人
    one = c.pick([p for p in photos if p.album == "烟台"], k=10)   # 单个相册挑 10 张

每张 Photo 有：score（V2.5 美学分）、kind（人像 / 有人 / 无人）、why（判定依据）、ok（画质过关）、
album、time、path。原理见 README.md。
"""

from .api import Curator, Photo
from .images import scan
from .people import classify

__all__ = ["Curator", "Photo", "scan", "classify"]
