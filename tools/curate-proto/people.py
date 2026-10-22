"""人像识别：判断一张照片的拍摄主体是不是人。

分三类：
    人像   —— 人是主体（人像照、合影、人占了画面一大块）
    有路人 —— 画面里有人，但很小，主体是风景、建筑等（壁纸可以用）
    无人   —— 没检测到人

两路证据合起来判断，任何一路单独都会犯错：
    1. 苹果 Vision 的人体框和人脸框（只在 Mac 上有）：看人占画面多大。
       人体框面积 ≥ 8%，或人脸面积 ≥ 0.8%，基本就是拍人。
       缺点：背影、侧身、人很小、或者雕像海报上的人，可能检出也可能漏。
    2. CLIP 文字判断（零样本）：把照片的"指纹"和几句英文描述比，看它最像哪一句，
       比如 "a portrait photo of a person" 和 "a landscape photo"。它是看整体意思的，
       能分辨"这张照片在拍人"还是"风景里恰好有个人"。

判定：
    - 人像：人体框 ≥ 8% 或人脸 ≥ 0.8%，且 CLIP 认为"在拍人"的概率 ≥ 0.25；
            或者 CLIP 概率 ≥ 0.6 且检出了人（人小但构图在拍人，比如远景人像）。
    - 有路人：检出了人但不够上面的条件。
    - 无人：没检出人。但 CLIP 概率 ≥ 0.8 时也算人像，防 Vision 漏检（比如背影）。
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
    """苹果 Vision：最大的人体框面积、最大的人脸面积（都按占画面比例），以及人数。"""
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

    def areas(req):
        out = []
        for r in req.results() or []:
            bb = r.boundingBox()
            out.append(float(bb.size.width * bb.size.height))
        return out

    b, f = areas(body), areas(face)
    return {"body": max(b, default=0.0), "face": max(f, default=0.0), "count": max(len(b), len(f))}


def classify(v, prob):
    """v = vision_people 的结果（没有 Vision 时传 None），prob = CLIP"在拍人"概率。返回 (类别, 理由)。"""
    if v is None:
        if prob >= 0.6:
            return "人像", f"CLIP {prob:.2f}"
        return ("有路人", f"CLIP {prob:.2f}") if prob >= 0.3 else ("无人", f"CLIP {prob:.2f}")
    why = f"人体 {v['body'] * 100:.1f}% · 人脸 {v['face'] * 100:.2f}% · CLIP {prob:.2f}"
    big = v["body"] >= 0.08 or v["face"] >= 0.008
    if (big and prob >= 0.25) or (v["count"] and prob >= 0.6) or prob >= 0.8:
        return "人像", why
    if v["count"]:
        return "有路人", why
    return "无人", why
