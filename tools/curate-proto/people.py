"""人像识别：照片里有没有人、人是不是主体。

原则：宁可多判有人，也不能漏。「不含人像」（壁纸）只收三路检测都说没人的照片。

分三类：
    人像 —— 人是主体（人像照、合影、站在景前的游客照）
    有人 —— 画面里有人，但很小（风景里的路人、航拍里的小人）。壁纸也不要
    无人 —— 三路都没发现人。只有这一类进壁纸

三路证据：
    1. 苹果 Vision 人体框 + 人脸框（只在 Mac 上）。擅长正常大小的人，太小、背影容易漏。
    2. YOLO11 目标检测，只看"人"这一类，门槛放低到 0.15。大图再切成 2×2 四块各查一遍，
       这样航拍里只有十几个像素的小人也能找到。代价是偶尔把雕像、人形影子当成人，按原则可以接受。
    3. CLIP 文字判断：照片整体像"在拍人"还是"在拍风景"。人被挡住、只露背影时，前两路可能漏，它能补上。

判定：
    - 人像：最大的人（Vision 或 YOLO）身高占画面 ≥ 25%，或面积 ≥ 3%，或人脸 ≥ 0.3%，或 CLIP ≥ 0.6。
    - 有人：任何一路发现了人（Vision 有框、YOLO 有框、CLIP ≥ 0.15）。
    - 无人：以上都没有。
"""

import numpy as np

# 前几句是"在拍人"，后面是常见的非人主体
PROMPTS = [
    "a portrait photo of a person",
    "a photo of a group of people posing",
    "a selfie",
    "a photo of a person standing in a scenic place",
    "a landscape photo",
    "a photo of flowers",
    "a photo of a building",
    "a photo of a street",
    "a photo of an animal",
    "a photo of food",
    "a photo of the sky and clouds",
    "a photo of a lake or river",
    "a photo of trees and plants",
    "a photo of a statue",
]
N_PERSON = 4


class TextProbe:
    """用 CLIP L/14 的文字一侧，给照片指纹算"在拍人"的概率。"""

    def __init__(self, clip_model, dev):
        import open_clip
        import torch

        tok = open_clip.get_tokenizer("ViT-L-14-quickgelu")
        with torch.no_grad():
            t = clip_model.encode_text(tok(PROMPTS).to(dev)).float()
        self.text = (t / t.norm(dim=-1, keepdim=True)).cpu().numpy()

    def person_prob(self, emb):
        logits = 100.0 * emb.astype(np.float32) @ self.text.T
        logits -= logits.max(axis=1, keepdims=True)
        p = np.exp(logits)
        p /= p.sum(axis=1, keepdims=True)
        return p[:, :N_PERSON].sum(axis=1)


def vision_people(path):
    """苹果 Vision：最大的人体框（面积、高度，按占画面比例）、最大的人脸面积、人数。"""
    import Vision
    from Foundation import NSURL

    handler = Vision.VNImageRequestHandler.alloc().initWithURL_options_(NSURL.fileURLWithPath_(str(path)), None)
    body = Vision.VNDetectHumanRectanglesRequest.alloc().init()
    try:
        body.setUpperBodyOnly_(False)
    except Exception:
        pass
    face = Vision.VNDetectFaceRectanglesRequest.alloc().init()
    handler.performRequests_error_([body, face], None)

    def boxes(req):
        return [(float(r.boundingBox().size.width), float(r.boundingBox().size.height)) for r in req.results() or []]

    b, f = boxes(body), boxes(face)
    return {"body": max((w * h for w, h in b), default=0.0), "body_h": max((h for _, h in b), default=0.0),
            "face": max((w * h for w, h in f), default=0.0), "count": max(len(b), len(f))}


class Yolo:
    """YOLO11 只找"人"。整图查一遍；长边大于 2000 像素的再切 2×2（带重叠）各查一遍，找小人。"""

    def __init__(self, weights="yolo11m.pt", conf=0.15):
        from ultralytics import YOLO

        import torch

        self.model, self.conf = YOLO(weights), conf
        self.dev = "mps" if torch.backends.mps.is_available() else None

    def __call__(self, path):
        from PIL import Image, ImageOps

        im = Image.open(path)
        im.draft("RGB", (3000, 3000))
        im = ImageOps.exif_transpose(im).convert("RGB")
        W, H = im.size
        crops = [(0, 0, W, H)]
        if max(W, H) > 2000:
            cw, ch = int(W * 0.55), int(H * 0.55)
            crops += [(x, y, x + cw, y + ch) for x in (0, W - cw) for y in (0, H - ch)]
        best_conf, best_area, best_h, n = 0.0, 0.0, 0.0, 0
        for x0, y0, x1, y1 in crops:
            r = self.model.predict(im.crop((x0, y0, x1, y1)), imgsz=1280, conf=self.conf, classes=[0], device=self.dev, verbose=False)[0]
            for (bx0, by0, bx1, by1), c in zip(r.boxes.xyxy.tolist(), r.boxes.conf.tolist()):
                n += 1
                best_conf = max(best_conf, c)
                best_area = max(best_area, (bx1 - bx0) * (by1 - by0) / (W * H))
                best_h = max(best_h, (by1 - by0) / H)
        return {"conf": best_conf, "area": best_area, "h": best_h, "count": n}


def classify(v, prob, y=None):
    """v = vision_people（没有时 None），prob = CLIP"在拍人"概率，y = Yolo 的结果（没有时 None）。返回 (类别, 理由)。"""
    v = v or {"body": 0.0, "body_h": 0.0, "face": 0.0, "count": 0}
    y = y or {"conf": 0.0, "area": 0.0, "h": 0.0, "count": 0}
    h = max(v.get("body_h", 0.0), y["h"])
    area = max(v["body"], y["area"])
    why = f"人高 {h * 100:.0f}% · 人脸 {v['face'] * 100:.2f}% · YOLO {y['conf']:.2f}×{y['count']} · CLIP {prob:.2f}"
    if h >= 0.25 or area >= 0.03 or v["face"] >= 0.003 or prob >= 0.6:
        return "人像", why
    if v["count"] or y["count"] or prob >= 0.15:
        return "有人", why
    return "无人", why
