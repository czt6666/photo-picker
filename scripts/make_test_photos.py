"""生成一套测试照片，用来手动/自动测试选片 App。

用法：python3 scripts/make_test_photos.py <输出目录> [大图张数] [小图张数]

生成内容：
- 大图/      2400 万像素（6000×4000）的高熵 JPEG，接近真实相机文件大小（约 10MB），
              每 5 张有一张带 EXIF 方向 6（竖拍），带拍摄时间、机型、光圈快门 ISO；
              模拟相机 RAW+JPEG：每 4 张有一张带同名 .CR3（假数据），第 1 张还有 .xmp 侧车文件，
              另有一张只有 RAW 没有 JPG 的 IMG_9001.CR3（macOS 上显示，其它平台隐藏）
- 2024/旅行/ 小尺寸 JPEG，用来测试网格滚动；附带一个 Picasa 3 格式的 .picasa.ini（预置 3 个星标）
- 杂项/      PNG、带透明度的 PNG、一张损坏的 JPEG
"""
import os
import sys

from PIL import Image, ImageDraw, ImageFont
from PIL.TiffImagePlugin import IFDRational

out = sys.argv[1]
n_big = int(sys.argv[2]) if len(sys.argv) > 2 else 40
n_small = int(sys.argv[3]) if len(sys.argv) > 3 else 300


def font(size):
    for p in ["/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "/System/Library/Fonts/Helvetica.ttc"]:
        if os.path.exists(p):
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()


def make(w, h, i, label, noise=0.16):
    hue = (i * 47) % 360
    base = Image.new("HSV", (w, h), (int(hue / 360 * 255), 120, 200)).convert("RGB")
    d = ImageDraw.Draw(base)
    # 渐变色带 + 几何图形，保证每张都不一样
    for k in range(8):
        y = int(h * k / 8)
        d.rectangle([0, y, w, y + h // 16], fill=((hue + k * 30) % 255, 90 + k * 15, 160 - k * 10))
    d.ellipse([w * 0.55, h * 0.15, w * 0.85, h * 0.6], fill=(250, 230, 120))
    d.polygon([(0, h), (w * 0.35, h * 0.35), (w * 0.7, h)], fill=(40, 110, 70))
    # 左上角红块、右下角蓝块：方便肉眼检查方向是否正确
    d.rectangle([0, 0, w // 8, h // 8], fill=(230, 30, 30))
    d.rectangle([w - w // 8, h - h // 8, w, h], fill=(30, 60, 230))
    f = font(max(24, h // 5))
    d.text((w * 0.08, h * 0.3), label, fill=(255, 255, 255), font=f, stroke_width=max(2, h // 120), stroke_fill=(0, 0, 0))
    if noise:
        nz = Image.effect_noise((w, h), 64).convert("RGB")
        base = Image.blend(base, nz, noise)
    return base


def exif_for(i, orientation):
    ex = Image.Exif()
    ex[0x0112] = orientation
    ex[0x010F] = "Canon"
    ex[0x0110] = "Canon EOS R5"
    sub = ex.get_ifd(0x8769)
    sub[0x9003] = f"2024:05:{1 + i % 28:02d} {8 + i % 10:02d}:{i % 60:02d}:00"
    sub[0x829D] = IFDRational(28, 10)  # f/2.8
    sub[0x829A] = IFDRational(1, 250)  # 1/250s
    sub[0x8827] = 100 * (1 + i % 8)
    sub[0x920A] = IFDRational(50, 1)  # 50mm
    return ex


def make_raw_companions(folder, n):
    """假的 RAW/XMP 文件：只需要文件名配对，内容不会被解码（有同名 JPG 时只显示 JPG）。"""
    for i in range(1, n + 1, 4):
        with open(os.path.join(folder, f"IMG_{i:04d}.CR3"), "wb") as fp:
            fp.write(b"FAKE-CR3-" + str(i).encode() + os.urandom(64 * 1024))
    with open(os.path.join(folder, "IMG_0001.xmp"), "w") as fp:
        fp.write('<x:xmpmeta xmlns:x="adobe:ns:meta/"/>\n')
    with open(os.path.join(folder, "IMG_9001.CR3"), "wb") as fp:
        fp.write(b"FAKE-CR3-ONLY" + os.urandom(1024))


if len(sys.argv) > 4 and sys.argv[4] == "--raw-only":
    make_raw_companions(os.path.join(out, "大图"), n_big)
    sys.exit(0)

big = os.path.join(out, "大图")
os.makedirs(big, exist_ok=True)
for i in range(1, n_big + 1):
    orientation = 6 if i % 5 == 0 else 1
    # 方向 6：像素按“横着”存，看图软件应顺时针转 90° 显示成竖图
    img = make(6000, 4000, i, f"#{i}" + (" ROT6" if orientation == 6 else ""))
    img.save(os.path.join(big, f"IMG_{i:04d}.JPG"), quality=92, exif=exif_for(i, orientation))
    print("big", i, flush=True)

make_raw_companions(big, n_big)

trip = os.path.join(out, "2024", "旅行")
os.makedirs(trip, exist_ok=True)
for i in range(1, n_small + 1):
    img = make(1200, 800, i, f"{i}", noise=0.08)
    img.save(os.path.join(trip, f"DSC_{i}.jpg"), quality=85, exif=exif_for(i, 1))
with open(os.path.join(trip, ".picasa.ini"), "w", newline="\r\n") as fp:
    fp.write("[Picasa]\nname=旅行\n[DSC_2.jpg]\nstar=yes\n[DSC_10.jpg]\nstar=yes\nrotate=rotate(0)\n[DSC_25.jpg]\nstar=yes\n[DSC_3.jpg]\nfaces=rect64(3f845bcb59418507),8e62398ebda8c1a5\n")

misc = os.path.join(out, "杂项")
os.makedirs(misc, exist_ok=True)
make(1600, 1000, 1, "PNG", noise=0).save(os.path.join(misc, "screenshot.png"))
rgba = make(800, 800, 2, "ALPHA", noise=0).convert("RGBA")
rgba.putalpha(Image.linear_gradient("L").resize((800, 800)))
rgba.save(os.path.join(misc, "alpha.png"))
with open(os.path.join(misc, "broken.jpg"), "wb") as fp:
    fp.write(b"\xff\xd8\xff\xe0garbage" * 10)
print("done")
