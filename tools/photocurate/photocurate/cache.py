"""分数缓存：每张照片算过的东西存起来（按路径，文件改过就作废），下次只算新照片。"""

import os
import pickle
from pathlib import Path

DEFAULT_DIR = Path(os.environ.get("PHOTOCURATE_CACHE", Path.home() / ".cache" / "photopicker-curate"))


class Cache:
    """一个字典：{照片路径: {字段: 值}}，存在一个 pickle 文件里。
    字段：mtime、time（拍摄时间）、sharp / dark / bright（清晰度、死黑、过曝）、emb（指纹）、
    aes_v25（美学分）、vision2 / yolo2（找人的框）。和原型 tools/curate-proto 的 library.pkl 通用。"""

    def __init__(self, path=None):
        self.path = Path(path) if path else DEFAULT_DIR / "library.pkl"
        self.data = pickle.loads(self.path.read_bytes()) if self.path.exists() else {}

    def get(self, p):
        """这张照片的记录；文件改过（修改时间变了）就清空重来。"""
        key, mtime = str(p), Path(p).stat().st_mtime
        rec = self.data.get(key)
        if rec is None or rec.get("mtime") != mtime:
            rec = self.data[key] = {"mtime": mtime}
        return rec

    def save(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_bytes(pickle.dumps(self.data))
        tmp.replace(self.path)
