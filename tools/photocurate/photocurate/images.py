"""读图和技术质量：扫描目录、解码小图、拍摄时间、清晰度、曝光。"""

from datetime import datetime
from pathlib import Path

import numpy as np
from PIL import Image, ImageOps

try:
    import pillow_heif

    pillow_heif.register_heif_opener()
except ImportError:
    pass

EXTS = {".jpg", ".jpeg", ".jpe", ".png", ".webp", ".heic", ".heif", ".tif", ".tiff"}


def scan(root):
    """root 下所有照片（递归）。跳过 . 开头的隐藏目录和 _ 开头的工作目录（比如剪视频导出的帧）。"""
    root = Path(root).expanduser()
    return [p for p in sorted(root.rglob("*"))
            if p.is_file() and p.suffix.lower() in EXTS
            and not any(x.startswith((".", "_")) for x in p.relative_to(root).parts)]


def exif_time(img):
    try:
        ex = img.getexif()
        v = ex.get_ifd(0x8769).get(36867) or ex.get(306)  # DateTimeOriginal / DateTime
        return datetime.strptime(str(v).strip()[:19], "%Y:%m:%d %H:%M:%S").timestamp()
    except Exception:
        return None


def load_small(path, size=512):
    """解码成长边 size 的小图，顺带读拍摄时间（没有就用文件修改时间）。
    JPEG 用 draft 模式直接按 1/2、1/4、1/8 解码，很快。美学模型自己会再缩到 384，给大图没用。"""
    img = Image.open(path)
    t = exif_time(img)
    img.draft("RGB", (size * 2, size * 2))
    img = ImageOps.exif_transpose(img).convert("RGB")
    img.thumbnail((size, size), Image.BILINEAR)
    return img, t if t is not None else Path(path).stat().st_mtime


def sharpness(gray):
    """拉普拉斯（每个像素 × 4 − 上下左右四个邻居）的方差。边缘越锐，值越大。
    分 4×4 块各算一次，取第二大的块：人像背景虚化不吃亏，偶尔一块噪点也不会骗过去。"""
    g = gray.astype(np.float32)
    lap = 4 * g[1:-1, 1:-1] - g[:-2, 1:-1] - g[2:, 1:-1] - g[1:-1, :-2] - g[1:-1, 2:]
    h, w = lap.shape
    vals = sorted(float(lap[i * h // 4:(i + 1) * h // 4, j * w // 4:(j + 1) * w // 4].var())
                  for i in range(4) for j in range(4))
    return vals[-2]


def exposure(gray):
    """死黑（<8）和过曝（>247）像素各占多少。"""
    n = gray.size
    return float((gray < 8).sum()) / n, float((gray > 247).sum()) / n
