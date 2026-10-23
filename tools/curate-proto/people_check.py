"""人像识别核对页：新规则（Vision + YOLO 找框 + 骨架核对）和旧规则（带 CLIP）比，哪些照片的判定变了。

不跑模型，只读 library.py 算好的缓存；旧规则要用的旧字段（vision / yolo / person_p）还在缓存里才比得了。
照片上画出每个框：实线 = 算数的人，虚线 = 排除的可疑框（框旁写 YOLO 把握和骨架关键点数）。

用法：python people_check.py ~/workspace/myphotos --out 人像识别核对.html
"""

import argparse
import json
import pickle
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from PIL import Image, ImageOps

sys.path.insert(0, str(Path(__file__).parent))
import people  # noqa: E402
from curate import CACHE, thumb_uri  # noqa: E402
from library import scan  # noqa: E402


def old_classify(v, prob, y):
    """旧规则（2026-10-22 版），只用来对比。"""
    v = v or {"body": 0.0, "body_h": 0.0, "face": 0.0, "count": 0}
    y = y or {"area": 0.0, "h": 0.0, "count": 0}
    h, area = max(v.get("body_h", 0.0), y["h"]), max(v["body"], y["area"])
    if h >= 0.25 or area >= 0.03 or v["face"] >= 0.003 or prob >= 0.6:
        return "人像"
    if v["count"] or y["count"] or prob >= 0.15:
        return "有人"
    return "无人"


def thumb(path):
    im = Image.open(path)
    im.draft("RGB", (1000, 1000))
    return thumb_uri(ImageOps.exif_transpose(im).convert("RGB"), 480)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("root")
    ap.add_argument("--out", default="人像识别核对.html")
    args = ap.parse_args()
    root = Path(args.root).expanduser()
    cache = pickle.loads((CACHE / "library.pkl").read_bytes())
    paths = [p for p in scan(root) if "yolo2" in cache.get(str(p), {})]
    rows, counts, moves = [], {"人像": 0, "有人": 0, "无人": 0}, {}
    for p in paths:
        f = cache[str(p)]
        new, why = people.classify(f.get("vision2"), f.get("yolo2"))
        old = old_classify(f.get("vision"), f["person_p"], f.get("yolo")) if "person_p" in f else None
        counts[new] += 1
        if old:
            moves[old + "→" + new] = moves.get(old + "→" + new, 0) + 1
        _, _, doubt = people.people_boxes(f.get("vision2"), f.get("yolo2"))
        rows.append({"p": p, "rel": str(p.relative_to(root)), "old": old, "new": new, "why": why, "doubt": doubt,
                     "boxes": [b + [int(b[5] >= people.KP_MIN or b[4] >= people.TRUST
                                        or (b[3] - b[1] < people.BIG_H and b[4] >= people.SMALL_CONF))]
                               for b in f["yolo2"]["boxes"]],
                     "vboxes": (f.get("vision2") or {}).get("bodies", []), "faces": (f.get("vision2") or {}).get("faces", [])})

    # 要看的：判定变了的全部列出；没变的，「无人」里排除过可疑框的（最可能漏判）也列出
    show = [r for r in rows if r["old"] and r["old"] != r["new"]] + \
           sorted([r for r in rows if r["new"] == "无人" and r["doubt"] > 0 and (not r["old"] or r["old"] == "无人")],
                  key=lambda r: -r["doubt"])[:60]
    print(f"  {len(rows)} 张：{counts}；判定变了 {sum(1 for r in rows if r['old'] and r['old'] != r['new'])} 张")
    with ThreadPoolExecutor(8) as ex:
        srcs = list(ex.map(thumb, [r["p"] for r in show]))
    items = [{k: v for k, v in r.items() if k != "p"} | {"src": s} for r, s in zip(show, srcs)]
    data = {"root": root.name, "n": len(rows), "counts": counts, "moves": moves, "items": items,
            "rule": {"big_h": people.BIG_H, "trust": people.TRUST, "small": people.SMALL_CONF, "kp": people.KP_MIN}}
    here = Path(__file__).parent
    tpl = (here / "people_check.html").read_text(encoding="utf-8").replace("/*BIGVIEW*/", (here / "bigview.js").read_text(encoding="utf-8"))
    out = Path(args.out).expanduser()
    out.write_text(tpl.replace("/*DATA*/null", json.dumps(data, ensure_ascii=False)), encoding="utf-8")
    print(f"写好了 {out}（{out.stat().st_size / 1e6:.1f} MB）")


if __name__ == "__main__":
    main()
