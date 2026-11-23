#!/bin/bash
set -x
cd "$(dirname "$0")"
uv venv --python 3.11 .venv
source .venv/bin/activate
uv pip install --index-url https://pypi.org/simple torch torchvision torchaudio "numpy<2" "diffusers==0.30.2" "transformers==4.39.2" "accelerate==0.28.0" "huggingface_hub==0.25.2" opencv-python soundfile librosa einops omegaconf face-alignment tqdm imageio gdown scipy
cd MuseTalk
M=models
mkdir -p $M/musetalkV15 $M/sd-vae $M/whisper $M/face-parse-bisent
python - <<'PY'
from huggingface_hub import hf_hub_download as d
for f in ["musetalkV15/musetalk.json","musetalkV15/unet.pth"]:
    d("TMElyralab/MuseTalk", f, local_dir="models")
for f in ["config.json","diffusion_pytorch_model.bin"]:
    d("stabilityai/sd-vae-ft-mse", f, local_dir="models/sd-vae")
for f in ["config.json","pytorch_model.bin","preprocessor_config.json"]:
    d("openai/whisper-tiny", f, local_dir="models/whisper")
for f in ["config.json","diffusion_pytorch_model.safetensors"]:
    d("madebyollin/taesd", f, local_dir="models/taesd")  # 快速模式用的小型解码模型
print("HF done")
PY
gdown "https://drive.google.com/uc?id=154JgKpzCPW82qINcVieuPH3fZ2e0P812" -O $M/face-parse-bisent/79999_iter.pth || echo GDOWN_FAIL
curl -L https://download.pytorch.org/models/resnet18-5c106cde.pth -o $M/face-parse-bisent/resnet18-5c106cde.pth
# 官方 resnet18 是旧打包格式，新版 PyTorch 默认拒绝加载，转存一次
python -c "import torch; p='$M/face-parse-bisent/resnet18-5c106cde.pth'; torch.save(torch.load(p, map_location='cpu', weights_only=False), p)"
ls -la $M/*
echo SETUP_DONE
