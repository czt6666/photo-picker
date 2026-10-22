# 自动精选原型

验证「自动挑好看照片」效果用的 Python 原型，正式版会用 Rust 做进 App。

```sh
python3 -m venv ~/.cache/photopicker-curate/venv
~/.cache/photopicker-curate/venv/bin/pip install -r requirements.txt
~/.cache/photopicker-curate/venv/bin/python curate.py ~/Pictures/2024/某个相册 --out ~/Desktop/精选.html
```

模型首次运行时下载到 `~/.cache/photopicker-curate/`（B/32 约 350MB，L/14 约 1.7GB）。只读照片，不改任何文件。
