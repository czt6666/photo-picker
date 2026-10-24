"""命令行：python -m photocurate <目录> [--k 30] [--wall] [--kind 人像] [--per-album 5] [--json 结果.json] [--csv 全部分数.csv]

打印挑出来的照片（相对路径、美学分、人像分类）。照片原地不动，只读。"""

import argparse
import csv
import json
from pathlib import Path

from . import Curator, scan


def main():
    ap = argparse.ArgumentParser(prog="photocurate", description="给照片打美学分、分人像，挑精选（照片只读不动）")
    ap.add_argument("root", help="照片目录（一级子目录算一个相册）")
    ap.add_argument("--k", type=int, help="挑几张（默认约 2%%，30～80）")
    ap.add_argument("--per-album", type=int, help="每个相册最多几张（默认自动）")
    ap.add_argument("--wall", action="store_true", help="壁纸：只挑没有人的")
    ap.add_argument("--kind", choices=["人像", "有人", "无人"], action="append", help="只从这些类别里挑，可写多次")
    ap.add_argument("--album", help="只在这个相册（一级子目录名）里挑")
    ap.add_argument("--no-people", action="store_true", help="不做人像识别（快很多，但不能用 --wall / --kind）")
    ap.add_argument("--cache", help="分数缓存文件（默认 ~/.cache/photopicker-curate/library.pkl）")
    ap.add_argument("--json", help="把挑选结果写成 JSON")
    ap.add_argument("--csv", help="把所有照片的分数和分类写成 CSV")
    a = ap.parse_args()
    if a.no_people and (a.wall or a.kind):
        ap.error("--no-people 不能和 --wall / --kind 一起用")

    root = Path(a.root).expanduser()
    c = Curator(a.cache, find_people=not a.no_people)
    photos = c.analyze(scan(root), root=root)
    if a.album:
        photos = [p for p in photos if p.album == a.album]
    best = c.pick(photos, k=a.k, per_album=a.per_album, wall=a.wall, kinds=set(a.kind) if a.kind else None)

    for i, p in enumerate(best, 1):
        print(f"{i:3d}  {p.score:5.2f}  {p.kind}  {p.path.relative_to(root)}")
    if a.json:
        Path(a.json).write_text(json.dumps([row(p, root) for p in best], ensure_ascii=False, indent=1), encoding="utf-8")
    if a.csv:
        with open(a.csv, "w", newline="", encoding="utf-8-sig") as f:
            w = csv.DictWriter(f, fieldnames=list(row(photos[0], root)))
            w.writeheader()
            w.writerows(row(p, root) for p in photos)


def row(p, root):
    return {"path": str(p.path.relative_to(root)), "album": p.album, "score": round(p.score, 3), "kind": p.kind,
            "why": p.why, "ok": p.ok, "time": p.time}


if __name__ == "__main__":
    main()
