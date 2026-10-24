"""人像识别：照片里有没有人、人是不是主体。

原则：宁可多判有人，也不能漏。「不含人像」（壁纸）只收没发现人的照片。

分三类：
    人像 —— 人是主体（人像照、合影、站在景前的游客照）
    有人 —— 画面里有人，但很小（风景里的路人、航拍里的小人）。壁纸也不要
    无人 —— 没发现人。只有这一类进壁纸

两步：先找「像人的框」，再逐个核对是不是真的人。
    1. 找框：苹果 Vision 的人体框、人脸框（只在 Mac 上）+ YOLO11 只找"人"（门槛放低到 0.15，
       大图再切 2×2 各找一遍，航拍里的小人也能找到）。门槛低，所以波纹、树枝、石头也会冒出框来。
    2. 核对：把 YOLO 的每个框连同周围一圈裁出来，交给姿态模型（YOLO11-pose）找人体关键点
       （鼻子、眼睛、肩、肘、腕、胯、膝、脚踝，共 17 个）。真的人能找到一副像样的骨架，
       水面波纹、树林只是"长得像一个竖条"，找不出骨架。
       - 框很大（身高 ≥ 画面 10%）：必须核对通过才算人（YOLO 特别有把握的 ≥ 0.85 直接算）。
       - 框很小：小到姿态模型也看不清，按宁可错杀，YOLO 把握 ≥ 0.4 就算有人，再低的不算。
    Vision 的人体框、人脸框误报很少，直接算。

判定：
    - 人像：算数的人里最大的身高 ≥ 画面 25%，或面积 ≥ 3%，或人脸 ≥ 0.3%。
    - 有人：有任何一个算数的人。
    - 无人：以上都没有。
"""

BIG_H = 0.10        # 框身高超过画面 10% 就必须核对骨架
TRUST = 0.85        # YOLO 把握到这个程度，不核对也算
SMALL_CONF = 0.40   # 小框（核对不了）YOLO 把握至少这么多才算
KP_CONF, KP_MIN = 0.5, 6   # 骨架：至少 6 个关键点、每个把握 ≥ 0.5
MAX_CHECK = 12      # 每张最多核对 12 个框（人群照里框很多，核对到够判定就行）


def vision_people(path):
    """苹果 Vision：人体框、人脸框（按画面比例，左上角原点）和把握。"""
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
        out = []
        for r in req.results() or []:
            b = r.boundingBox()
            x, y, w, h = float(b.origin.x), float(b.origin.y), float(b.size.width), float(b.size.height)
            out.append([round(x, 4), round(1 - y - h, 4), round(x + w, 4), round(1 - y, 4), round(float(r.confidence()), 3)])
        return out

    return {"bodies": boxes(body), "faces": boxes(face)}


def _iou(a, b):
    ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    u = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / u if u > 0 else 0.0


class Yolo:
    """YOLO11 找人 + YOLO11-pose 核对骨架。整图找一遍；长边大于 2000 像素的再切 2×2（带重叠）各找一遍。

    返回 {"boxes": [[x0, y0, x1, y1, 把握, 骨架关键点数], ...]}，坐标按画面比例；关键点数 -1 = 没核对。
    """

    def __init__(self, weights_dir=None, weights="yolo11m.pt", pose="yolo11m-pose.pt", conf=0.15):
        """weights_dir：权重放哪（没有时 ultralytics 会自动下载，约 40MB + 40MB）。"""
        from pathlib import Path

        import torch
        from ultralytics import YOLO

        d = Path(weights_dir) if weights_dir else Path(".")
        d.mkdir(parents=True, exist_ok=True)
        self.model, self.pose, self.conf = YOLO(str(d / weights)), YOLO(str(d / pose)), conf
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
        found = []
        for x0, y0, x1, y1 in crops:
            r = self.model.predict(im.crop((x0, y0, x1, y1)), imgsz=1280, conf=self.conf, classes=[0], device=self.dev, verbose=False)[0]
            for (bx0, by0, bx1, by1), c in zip(r.boxes.xyxy.tolist(), r.boxes.conf.tolist()):
                found.append([(bx0 + x0) / W, (by0 + y0) / H, (bx1 + x0) / W, (by1 + y0) / H, c])
        # 切块和整图会找到同一个人：重叠多的只留把握最大的
        found.sort(key=lambda b: -b[4])
        boxes = []
        for b in found:
            if all(_iou(b, k) < 0.5 for k in boxes):
                boxes.append(b)
        # 核对：大框先核对（决定是不是人像），小框里把握高的先核对
        order = sorted(range(len(boxes)), key=lambda i: -(boxes[i][3] - boxes[i][1]))
        out = [[round(v, 4) for v in b[:4]] + [round(b[4], 3), -1] for b in boxes]
        for i in order[:MAX_CHECK]:
            out[i][5] = self._skeleton(im, boxes[i])
        return {"boxes": out}

    def _skeleton(self, im, b):
        """把框外扩 25% 裁出来，放大到短边至少 256，找骨架。返回最像人的那副骨架里清楚的关键点数。"""
        W, H = im.size
        x0, y0, x1, y1 = b[0] * W, b[1] * H, b[2] * W, b[3] * H
        mx, my = (x1 - x0) * 0.25, (y1 - y0) * 0.25
        c = im.crop((int(max(0, x0 - mx)), int(max(0, y0 - my)), int(min(W, x1 + mx)), int(min(H, y1 + my))))
        s = 256 / max(1, min(c.size))
        if s > 1:
            c = c.resize((int(c.width * s), int(c.height * s)))
        r = self.pose.predict(c, imgsz=320, conf=0.25, device=self.dev, verbose=False)[0]
        if r.keypoints is None or r.keypoints.conf is None or not len(r.keypoints.conf):
            return 0
        return int((r.keypoints.conf >= KP_CONF).sum(dim=1).max().item())


def people_boxes(v, y):
    """算数的人：[(身高, 面积)]；以及最大人脸面积、被排除的可疑框里最高的把握（抽查用）。"""
    v = v or {"bodies": [], "faces": []}
    y = y or {"boxes": []}
    real, doubt = [], 0.0
    for x0, y0, x1, y1, c in v["bodies"]:
        real.append((y1 - y0, (x1 - x0) * (y1 - y0)))
    for x0, y0, x1, y1, c, kp in y["boxes"]:
        h, area = y1 - y0, (x1 - x0) * (y1 - y0)
        if kp >= KP_MIN or c >= TRUST or (h < BIG_H and c >= SMALL_CONF):
            real.append((h, area))
        else:
            doubt = max(doubt, c)
    face = max(((x1 - x0) * (y1 - y0) for x0, y0, x1, y1, c in v["faces"]), default=0.0)
    return real, face, doubt


def classify(v, y):
    """v = vision_people（没有时 None），y = Yolo 的结果（没有时 None）。返回 (类别, 理由)。"""
    real, face, doubt = people_boxes(v, y)
    h = max((r[0] for r in real), default=0.0)
    area = max((r[1] for r in real), default=0.0)
    why = f"人高 {h * 100:.0f}% · 人脸 {face * 100:.2f}% · 算数的人 {len(real)}"
    if doubt:
        why += f" · 排除了可疑框（最高把握 {doubt:.2f}）"
    if h >= 0.25 or area >= 0.03 or face >= 0.003:
        return "人像", why
    if real or face > 0:
        return "有人", why
    return "无人", why
