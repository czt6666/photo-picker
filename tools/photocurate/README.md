# photocurate

从一堆照片里挑出最好看的：给每张打美学分，分出人像 / 有人 / 无人，再去连拍、打散，挑出精选或壁纸。
照片只读，不移动、不修改。

由 `tools/curate-proto` 的原型整理而来，只保留试下来最好的做法：美学分用 V2.5，人像识别用 Vision + YOLO + 骨架核对。

## 安装

```bash
cd tools/photocurate
python -m venv .venv && . .venv/bin/activate
pip install -e .
```

第一次运行会下载模型：V2.5 约 800MB（Hugging Face），CLIP L/14 约 900MB，YOLO 两个各约 40MB。
都放在 `~/.cache/photopicker-curate/`（用环境变量 `PHOTOCURATE_CACHE` 可以改）。

## 用法

命令行：

```bash
python -m photocurate ~/workspace/myphotos                 # 全库精选
python -m photocurate ~/workspace/myphotos --wall --k 20   # 20 张壁纸（不含人）
python -m photocurate ~/workspace/myphotos --album 烟台 --k 10
python -m photocurate ~/workspace/myphotos --kind 人像 --json 人像精选.json
python -m photocurate ~/workspace/myphotos --csv 全部分数.csv   # 每张的分数和分类
```

代码里：

```python
from photocurate import Curator, scan

c = Curator()
photos = c.analyze(scan("~/workspace/myphotos"), root="~/workspace/myphotos")
best  = c.pick(photos)                     # 全库精选
walls = c.pick(photos, wall=True, k=20)    # 壁纸
one   = c.pick([p for p in photos if p.album == "烟台"], k=10)

for p in best:
    print(p.path, p.score, p.kind, p.why)
```

`analyze` 返回的每张 `Photo`：

| 字段 | 意思 |
| --- | --- |
| `score` | V2.5 美学分，大致 1～10。5 分普通，6 分以上算好看 |
| `kind` | 人像（人是主体）/ 有人（有人但很小）/ 无人 |
| `why` | 人像判定的依据，比如「人高 67% · 人脸 0.96% · 算数的人 6」 |
| `ok` | 画质过关：和同相册比不明显糊、不太黑、不太亮 |
| `wallpaper` | 能当壁纸：无人且画质过关 |
| `album` | root 下的一级目录名 |
| `time` | 拍摄时间（EXIF，没有就用文件修改时间） |

分数存在缓存里（按路径 + 修改时间），再跑只算新照片。缓存和原型的 `library.pkl` 通用，原型已经算过的不用重算。

## 原理

**1. 画质（不用模型）**
- 清晰度：每个像素和上下左右邻居的亮度差，差得越猛边缘越锐。画面分 16 块，取第二清楚的那块，所以背景虚化的人像不吃亏。比同相册中位数的 1/4 还低就算糊。
- 曝光：死黑像素超过 45%，或过曝像素超过 35%，就淘汰。

**2. 美学分：Aesthetic Predictor V2.5**
用 SigLIP（一种看过海量"图片 + 文字"的模型）把照片变成一串数字，再用一个在人工打分数据上训练过的小网络，把这串数字换算成 1～10 分。
模型的输入固定是 384×384，所以给它长边 512 的小图就够了，给原图结果一样，只是更慢。
原型里对比过 LAION L/14、TOPIQ、Q-ReAlign 和苹果自带的美学分，V2.5 的挑选结果最好。

**3. 人像识别：人像 / 有人 / 无人**
- 先找"像人的框"：苹果 Vision 的人体框和人脸框（只在 Mac 上），加上 YOLO11。YOLO 的门槛放得很低，大图还切成四块各找一遍，航拍里的小人也能找到。
- 再核对：门槛低，所以波纹、树林、石头也会冒出框来。每个框连同周围一圈裁出来，交给姿态模型 YOLO11-pose 找骨架（鼻、眼、肩、肘、腕、胯、膝、踝，共 17 个点）。真人拼得出骨架，纹理拼不出来。
  - 大框（身高超过画面 10%）要找到至少 6 个清楚的关键点才算人。YOLO 特别有把握的（0.85 以上）直接算。
  - 小框小到看不清骨架，YOLO 把握 0.4 以上就算有人。宁可错杀，保证壁纸里没人。
- 判定：
  - 人像：算数的人里，最大的身高占画面 25% 以上，或面积 3% 以上，或人脸 0.3% 以上。
  - 有人：有任何一个算数的人。
  - 无人：都没有。
- 阈值在 `people.py` 开头，可以调。

**4. 挑选**
- 去连拍：同一相册里 90 秒内拍的、而且很像的（CLIP 指纹相似度 0.90 以上），归成一组；任何两张几乎一样的（0.96 以上，比如同一张的不同导出版本）也归一组。每组只留分最高的一张。
- 打散：每一步挑「分数排名 − 和已选照片的相似惩罚」最大的。第一张一定是分最高的，后面会照顾"别和已选的太像"，所以不会挑出 10 张差不多的日落。
- 每个相册限量：默认是平均份额的 2 倍，至少 3 张，免得一次旅行占满全部名额。
- 挑多少：默认约 2%，最少 30、最多 80 张，也可以用 `k` 指定。

CLIP L/14 只用来算指纹、比两张照片像不像，不参与打分。

## 速度（MacBook Air M 系列）

| 步骤 | 每张 |
| --- | --- |
| 读图 + 画质 | 约 10 ms |
| CLIP 指纹 | 约 66 ms |
| V2.5 美学分 | 约 94 ms |
| 苹果 Vision | 约 58 ms |
| YOLO 找人 + 骨架核对 | 约 1.6 s |

2000 张第一次全算约 1 小时，主要花在找人上。不需要人像分类时用 `--no-people`，几分钟就能跑完。

## 测试

```bash
pip install pytest && python -m pytest tests   # 用假模型，不用下载权重
```
