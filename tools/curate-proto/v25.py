"""用更新的 Aesthetic Predictor V2.5（SigLIP 底座，2024）给相册打分，结果存成 <npz>.v25.json 供 faces.py 对比。

和 LAION v1/v2 同一个思路（大模型的图片指纹 + 小打分头），换了更强的底座 SigLIP，
训练数据也更偏"摄影作品"，据作者说对真实照片区分更细。

用法：python v25.py <相册文件夹> <curate.py 输出的 .npz>
"""

import json
import sys
import time
from pathlib import Path

import numpy as np
import torch
from PIL import Image, ImageOps

from aesthetic_predictor_v2_5 import convert_v2_5_from_siglip


def main():
    folder, npz = Path(sys.argv[1]).expanduser(), Path(sys.argv[2])
    names = [str(x) for x in np.load(npz, allow_pickle=True)["names"]]
    dev = "mps" if torch.backends.mps.is_available() else "cpu"
    model, prep = convert_v2_5_from_siglip(low_cpu_mem_usage=True, trust_remote_code=True)
    model = model.to(torch.float16 if dev == "mps" else torch.float32).to(dev).eval()
    out, t0 = {}, time.time()
    for i in range(0, len(names), 16):
        ims = []
        for nm in names[i : i + 16]:
            im = Image.open(folder / nm)
            im.draft("RGB", (768, 768))
            ims.append(ImageOps.exif_transpose(im).convert("RGB"))
        px = prep(images=ims, return_tensors="pt").pixel_values.to(dev, model.dtype)
        with torch.no_grad():
            s = model(px).logits.squeeze(-1).float().cpu().tolist()
        out.update(zip(names[i : i + 16], s))
    print(f"v2.5：{len(names)} 张，每张 {1000 * (time.time() - t0) / len(names):.0f}ms（{dev}）")
    npz.with_suffix(".v25.json").write_text(json.dumps(out))


if __name__ == "__main__":
    main()
