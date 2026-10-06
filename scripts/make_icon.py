"""生成 App 图标源图（1024×1024）。再用 `npx tauri icon app-icon.png` 生成各平台尺寸。"""
import math, sys
from PIL import Image, ImageDraw, ImageFilter

S = 1024
SS = 4  # 超采样抗锯齿
W = S * SS

def rr(draw, box, r, fill):
    draw.rounded_rectangle(box, radius=r, fill=fill)

img = Image.new("RGBA", (W, W), (0, 0, 0, 0))

# 阴影
shadow = Image.new("RGBA", (W, W), (0, 0, 0, 0))
sd = ImageDraw.Draw(shadow)
m = 100 * SS
rr(sd, (m, m + 18 * SS, W - m, W - m + 18 * SS), 185 * SS, (0, 0, 0, 110))
shadow = shadow.filter(ImageFilter.GaussianBlur(22 * SS))
img.alpha_composite(shadow)

# 底板：深灰蓝渐变
base = Image.new("RGBA", (W, W), (0, 0, 0, 0))
grad = Image.new("RGBA", (W, W))
gd = ImageDraw.Draw(grad)
top, bot = (52, 63, 84), (24, 29, 40)
for y in range(W):
    t = y / W
    c = tuple(int(top[i] * (1 - t) + bot[i] * t) for i in range(3))
    gd.line([(0, y), (W, y)], fill=c + (255,))
mask = Image.new("L", (W, W), 0)
rr(ImageDraw.Draw(mask), (m, m, W - m, W - m), 185 * SS, 255)
base.paste(grad, (0, 0), mask)
img.alpha_composite(base)

# 照片（白边相纸，略微倾斜）
photo = Image.new("RGBA", (W, W), (0, 0, 0, 0))
pd = ImageDraw.Draw(photo)
px0, py0, px1, py1 = 250 * SS, 270 * SS, 774 * SS, 700 * SS
rr(pd, (px0, py0, px1, py1), 26 * SS, (250, 250, 247, 255))
ix0, iy0, ix1, iy1 = px0 + 34 * SS, py0 + 34 * SS, px1 - 34 * SS, py1 - 34 * SS
# 天空
sky = Image.new("RGBA", (ix1 - ix0, iy1 - iy0))
skd = ImageDraw.Draw(sky)
for y in range(iy1 - iy0):
    t = y / (iy1 - iy0)
    c = (int(120 + 60 * t), int(180 + 30 * t), int(235 - 10 * t), 255)
    skd.line([(0, y), (ix1 - ix0, y)], fill=c)
photo.paste(sky, (ix0, iy0))
# 太阳
pd.ellipse((ix0 + 300 * SS, iy0 + 50 * SS, ix0 + 380 * SS, iy0 + 130 * SS), fill=(255, 236, 160, 255))
# 山
pd.polygon([(ix0, iy1), (ix0 + 150 * SS, iy0 + 140 * SS), (ix0 + 300 * SS, iy1)], fill=(70, 130, 95, 255))
pd.polygon([(ix0 + 140 * SS, iy1), (ix0 + 330 * SS, iy0 + 190 * SS), (ix1, iy0 + 330 * SS), (ix1, iy1)], fill=(48, 102, 76, 255))
photo = photo.rotate(-6, resample=Image.BICUBIC, center=(W // 2, W // 2))
ps = photo.split()[3].filter(ImageFilter.GaussianBlur(14 * SS))
psh = Image.new("RGBA", (W, W), (0, 0, 0, 0))
psh.putalpha(ps.point(lambda a: a * 0.45))
img.alpha_composite(psh, (0, 10 * SS))
img.alpha_composite(photo)

# 金色星标
def star(cx, cy, r_out, r_in, n=5, rot=-90):
    pts = []
    for i in range(n * 2):
        r = r_out if i % 2 == 0 else r_in
        a = math.radians(rot + i * 180 / n)
        pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return pts

sx, sy = 700 * SS, 690 * SS
glow = Image.new("RGBA", (W, W), (0, 0, 0, 0))
ImageDraw.Draw(glow).polygon(star(sx, sy + 12 * SS, 200 * SS, 86 * SS), fill=(0, 0, 0, 140))
glow = glow.filter(ImageFilter.GaussianBlur(16 * SS))
img.alpha_composite(glow)
sd = ImageDraw.Draw(img)
sd.polygon(star(sx, sy, 196 * SS, 84 * SS), fill=(255, 196, 40, 255))
sd.polygon(star(sx, sy - 8 * SS, 150 * SS, 64 * SS), fill=(255, 214, 90, 255))

img = img.resize((S, S), Image.LANCZOS)
img.save(sys.argv[1] if len(sys.argv) > 1 else "app-icon.png")
