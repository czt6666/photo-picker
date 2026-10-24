"""模型：V2.5 美学分，CLIP L/14 图像指纹（只用来比两张照片像不像）。都是第一次用时才加载。"""

import numpy as np


def device():
    import torch

    return "mps" if torch.backends.mps.is_available() else ("cuda" if torch.cuda.is_available() else "cpu")


class Aesthetic:
    """Aesthetic Predictor V2.5（SigLIP so400m + 打分头）。分数大致 1～10，5 普通，6 以上好看。
    第一次用会从 Hugging Face 下载约 800MB 权重。"""

    def __init__(self):
        import torch
        from aesthetic_predictor_v2_5 import convert_v2_5_from_siglip

        self.torch, self.dev = torch, device()
        m, self.prep = convert_v2_5_from_siglip(low_cpu_mem_usage=True, trust_remote_code=True)
        self.dt = torch.float16 if self.dev in ("mps", "cuda") else torch.float32
        self.model = m.to(self.dt).to(self.dev).eval()

    def __call__(self, imgs):
        """imgs：PIL 图片列表。返回分数列表。"""
        with self.torch.no_grad():
            px = self.prep(images=imgs, return_tensors="pt").pixel_values.to(self.dev, self.dt)
            return [float(v) for v in self.model(px).logits.squeeze(-1).float().cpu().tolist()]


class Embedder:
    """CLIP ViT-L/14 的图像指纹（768 个数，已归一化）。两张照片指纹的点积越接近 1 越像，
    去连拍、打散挑选都用它。"""

    def __init__(self, cache_dir=None):
        import open_clip
        import torch

        self.torch, self.dev = torch, device()
        m, _, self.prep = open_clip.create_model_and_transforms(
            "ViT-L-14-quickgelu", "openai", cache_dir=str(cache_dir) if cache_dir else None)
        self.model = m.to(self.dev).eval()

    def __call__(self, imgs):
        with self.torch.no_grad():
            x = self.torch.stack([self.prep(im) for im in imgs]).to(self.dev)
            e = self.model.encode_image(x).float()
            e = e / e.norm(dim=-1, keepdim=True)
        return list(e.cpu().numpy().astype(np.float16))
