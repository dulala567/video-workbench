"""
视频工作台 · 数字人口型运行脚本（基于 MuseTalk 1.5，适配 Apple Silicon）

和原版 MuseTalk 的区别：
- 人脸关键点用 face-alignment 的 68 点（原版用 mmpose/DWPose，在 Mac 上很难装）；两者点位编号一致。
- 设备优先用 Apple 显卡（MPS），没有就用 CPU。
- 形象的人脸分析结果（帧、坐标、潜变量、融合遮罩）缓存在硬盘上，第二次用同一个形象直接读缓存。
- 生成时逐帧把画面写进 ffmpeg 管道，不把整段视频读进内存。

用法（工作目录必须是 MuseTalk 仓库根目录）：
  python lipsync_runner.py --avatar 形象.mp4/jpg --cache 缓存目录 --audio 音频 --out 输出.mp4
进度通过 stdout 的 "@@PROGRESS <0~1> <阶段>" 行汇报。
"""
import argparse
import json
import os
import pickle
import shutil
import subprocess
import sys
import time

import cv2
import numpy as np
import torch

# Windows 上 OpenCV 的 imread/imwrite 不认中文路径（用户名、输出目录里常有中文），
# 换成先读字节再解码、先编码再写字节。MuseTalk 内部调用的也是 cv2.imread，一起生效。
if sys.platform == "win32":
    _imread, _imwrite = cv2.imread, cv2.imwrite

    def _imread_u(path, flags=cv2.IMREAD_COLOR):
        try:
            data = np.fromfile(path, dtype=np.uint8)
        except (OSError, ValueError):
            return None
        return cv2.imdecode(data, flags) if data.size else None

    def _imwrite_u(path, img, params=None):
        ok, buf = cv2.imencode(os.path.splitext(path)[1] or ".png", img, params or [])
        if ok:
            buf.tofile(path)
        return ok

    cv2.imread, cv2.imwrite = _imread_u, _imwrite_u

# MuseTalk 的代码和权重都按「仓库根目录」的相对路径找
MUSETALK_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "MuseTalk")
if MUSETALK_DIR not in sys.path:
    sys.path.insert(0, MUSETALK_DIR)

CACHE_VERSION = 3
FPS = 25
EXTRA_MARGIN = 10  # MuseTalk 1.5 下巴额外留边
MAX_LONG_SIDE = 1920


def progress(p, stage=""):
    print(f"@@PROGRESS {max(0.0, min(1.0, p)):.4f} {stage}", flush=True)


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def pick_device():
    if torch.backends.mps.is_available():
        return torch.device("mps")
    if torch.cuda.is_available():
        return torch.device("cuda")
    return torch.device("cpu")


# 这里出的是中间文件，后面还会按清晰度重新编码一次，所以只求快、画质留足
VIDEO_ENC = ["-c:v", "h264_videotoolbox", "-q:v", "70"] if sys.platform == "darwin" else ["-c:v", "libx264", "-preset", "veryfast", "-crf", "16"]


# face-alignment 默认用 torch.compile 加速，Windows 上要装微软 C++ 编译器才行，直接关掉
FA_COMPILE = sys.platform != "win32"


def free_gpu(device):
    """把用完的显存还给系统。PyTorch 默认占着不还；8GB 这类显卡上显存一满，
    NVIDIA 驱动会改用内存顶替显存，不报错但慢十倍左右。"""
    if device.type != "cuda":
        return
    import gc

    gc.collect()
    try:
        torch.cuda.empty_cache()
    except Exception:
        pass


def gpu_free_gb(device):
    """NVIDIA 显卡当前剩余显存（GB）；别的设备返回 None。"""
    if device.type != "cuda":
        return None
    try:
        free, _total = torch.cuda.mem_get_info()
        return free / 1024**3
    except Exception:
        return None


def is_oom(e):
    return "out of memory" in str(e).lower()


def pick_batch_size(want, free_gb):
    """显存少就一批少算几帧（free_gb 为 None 表示不是 NVIDIA 显卡，不限制）。"""
    if free_gb is None or free_gb >= 6:
        return want
    return min(want, 8 if free_gb >= 3.5 else 4)


def speed_note(device, free_gb):
    """进度后面附带的提醒：让人看得出为什么慢。"""
    if device.type == "cpu":
        return " · 没用上显卡，在用 CPU 算（很慢）"
    if free_gb is not None and free_gb < 0.5:
        return " · 显存快满了，关掉其他占显卡的程序会快很多"
    return ""


def ffmpeg_bin():
    for p in ["/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg", "/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"]:
        if os.path.exists(p):
            return p
    return "ffmpeg"


# ---------------------------------------------------------------- 形象预处理
def extract_frames(src, out_dir):
    """把形象视频/图片转成 25fps 的 jpg 帧序列，长边不超过 1920。"""
    os.makedirs(out_dir, exist_ok=True)
    ext = os.path.splitext(src)[1].lower()
    scale = f"scale='if(gt(iw,ih),min({MAX_LONG_SIDE},iw),-2)':'if(gt(iw,ih),-2,min({MAX_LONG_SIDE},ih))'"
    if ext in (".jpg", ".jpeg", ".png", ".webp", ".bmp"):
        img = cv2.imread(src)
        if img is None:
            raise RuntimeError("读不了这张图片：" + src)
        h, w = img.shape[:2]
        k = min(1.0, MAX_LONG_SIDE / max(h, w))
        if k < 1:
            img = cv2.resize(img, (int(w * k) // 2 * 2, int(h * k) // 2 * 2), interpolation=cv2.INTER_AREA)
        else:
            img = img[: h // 2 * 2, : w // 2 * 2]
        cv2.imwrite(os.path.join(out_dir, "00000000.jpg"), img, [cv2.IMWRITE_JPEG_QUALITY, 95])
    else:
        subprocess.run(
            [ffmpeg_bin(), "-v", "error", "-y", "-i", src, "-vf", f"fps={FPS},{scale}", "-q:v", "2", os.path.join(out_dir, "%08d.jpg")],
            check=True,
        )
        # ffmpeg 从 1 开始编号，改成从 0 开始
        files = sorted(os.listdir(out_dir))
        for i, f in enumerate(files):
            os.rename(os.path.join(out_dir, f), os.path.join(out_dir, f"{i:08d}.jpg"))
    files = sorted(f for f in os.listdir(out_dir) if f.endswith(".jpg"))
    if not files:
        raise RuntimeError("形象里没有读到画面")
    return [os.path.join(out_dir, f) for f in files]


DETECT_LONG_SIDE = 960  # 找人脸位置时把大图缩到这个尺寸


def detect_faces_small(fa, rgb):
    """在缩小的图上找人脸位置，再把框换算回原图。
    人脸检测占的显存和画面大小成正比，1080×1920 的原图直接检测要好几个 GB；
    口播画面里人脸都很大，缩小了一样找得到。关键点仍然在原图上算，精度不变。
    图本来就不大时返回 None，交给 face-alignment 自己检测。"""
    h, w = rgb.shape[:2]
    k = DETECT_LONG_SIDE / max(h, w)
    if k >= 1:
        return None
    small = cv2.resize(rgb, (max(1, round(w * k)), max(1, round(h * k))), interpolation=cv2.INTER_AREA)
    dets = fa.face_detector.detect_from_image(small)
    out = []
    for d in dets:
        d = np.array(d, dtype=np.float32)
        d[:4] /= k
        out.append(d)
    return out


def landmark_bbox(fa, frame_bgr, bbox_shift):
    """按 MuseTalk 的规则，用 68 点关键点算出口型区域的框。找不到人脸返回 None。"""
    rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
    res = fa.get_landmarks_from_image(rgb, detected_faces=detect_faces_small(fa, rgb), return_bboxes=True)
    lms, _, boxes = res if isinstance(res, tuple) else (res, None, None)
    if not lms:
        return None
    # 多张脸时取最大的那张
    areas = [(lm[:, 0].max() - lm[:, 0].min()) * (lm[:, 1].max() - lm[:, 1].min()) for lm in lms]
    i = int(np.argmax(areas))
    lm = lms[i].astype(np.int32)
    det = boxes[i][:4].astype(np.int32) if boxes is not None and len(boxes) > i else None

    half_face = lm[29].copy()
    if bbox_shift:
        half_face[1] += bbox_shift
    half_dist = np.max(lm[:, 1]) - half_face[1]
    upper = max(0, int(half_face[1] - half_dist))
    x1, y1, x2, y2 = int(np.min(lm[:, 0])), upper, int(np.max(lm[:, 0])), int(np.max(lm[:, 1]))
    h, w = frame_bgr.shape[:2]
    if y2 - y1 <= 0 or x2 - x1 <= 0 or x1 < 0:
        if det is None:
            return None
        x1, y1, x2, y2 = [int(v) for v in det]
    x1, y1 = max(0, x1), max(0, y1)
    x2, y2 = min(w, x2), min(h, y2 + EXTRA_MARGIN)
    return [x1, y1, x2, y2]


def prepare_avatar(src, cache, bbox_shift, device, vae, fp):
    info_path = os.path.join(cache, "info.json")
    st = os.stat(src)
    sig = {"version": CACHE_VERSION, "src_size": st.st_size, "src_mtime": int(st.st_mtime), "bbox_shift": bbox_shift}
    if os.path.exists(info_path):
        try:
            with open(info_path) as f:
                info = json.load(f)
            if all(info.get(k) == v for k, v in sig.items()):
                return info
        except Exception:
            pass
        shutil.rmtree(cache, ignore_errors=True)

    from musetalk.utils.blending import get_image_prepare_material
    import face_alignment

    os.makedirs(cache, exist_ok=True)
    progress(0.01, "分析形象（首次较慢）")
    frames = extract_frames(src, os.path.join(cache, "frames"))
    n = len(frames)
    log(f"形象共 {n} 帧")

    fa_device = "mps" if device.type == "mps" else ("cuda" if device.type == "cuda" else "cpu")
    try:
        fa = face_alignment.FaceAlignment(face_alignment.LandmarksType.TWO_D, flip_input=False, device=fa_device, compile=FA_COMPILE)
    except Exception as e:
        log("face-alignment 用", fa_device, "失败，改用 CPU：", e)
        fa = face_alignment.FaceAlignment(face_alignment.LandmarksType.TWO_D, flip_input=False, device="cpu", compile=FA_COMPILE)

    coords, latents, mask_coords = [], [], []
    mask_dir = os.path.join(cache, "masks")
    os.makedirs(mask_dir, exist_ok=True)
    last_box = None
    for i, fpath in enumerate(frames):
        frame = cv2.imread(fpath)
        box = landmark_bbox(fa, frame, bbox_shift)
        if box is None:
            box = last_box  # 偶尔一帧没检测到脸，沿用上一帧的框
        if box is None:
            continue
        last_box = box
        coords.append(box)
        x1, y1, x2, y2 = box
        crop = cv2.resize(frame[y1:y2, x1:x2], (256, 256), interpolation=cv2.INTER_LANCZOS4)
        with torch.no_grad():
            latents.append(vae.get_latents_for_unet(crop).to("cpu"))
        mask, crop_box = get_image_prepare_material(frame, box, fp=fp, mode="jaw")
        cv2.imwrite(os.path.join(mask_dir, f"{i:08d}.png"), mask)
        mask_coords.append(crop_box)
        progress(0.02 + 0.28 * (i + 1) / n, "分析形象（首次较慢）")

    if not coords:
        raise RuntimeError("形象里没检测到人脸，请换一段正脸清晰的视频或照片")
    if len(coords) < n:
        # 开头几帧没检测到脸：用第一个有效框补齐
        missing = n - len(coords)
        coords = [coords[0]] * missing + coords
        latents = [latents[0]] * missing + latents
        mask_coords = [mask_coords[0]] * missing + mask_coords
        first_mask = sorted(os.listdir(mask_dir))[0]
        for i in range(n):
            p = os.path.join(mask_dir, f"{i:08d}.png")
            if not os.path.exists(p):
                shutil.copy(os.path.join(mask_dir, first_mask), p)

    torch.save(torch.cat(latents, dim=0), os.path.join(cache, "latents.pt"))
    with open(os.path.join(cache, "coords.pkl"), "wb") as f:
        pickle.dump({"coords": coords, "mask_coords": mask_coords}, f)
    h, w = cv2.imread(frames[0]).shape[:2]
    info = {**sig, "frames": n, "width": w, "height": h}
    with open(info_path, "w") as f:
        json.dump(info, f)
    return info


# ---------------------------------------------------------------- 替换背景
RVM_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "RobustVideoMatting")


def prepare_alpha(cache, n, device):
    """用 RobustVideoMatting 给形象每一帧抠出人像透明度，缓存成 png。只在第一次换背景时做。"""
    alpha_dir = os.path.join(cache, "alpha")
    if os.path.isdir(alpha_dir) and len(os.listdir(alpha_dir)) >= n:
        return alpha_dir
    sys.path.insert(0, RVM_DIR)
    from model import MattingNetwork

    net = MattingNetwork("mobilenetv3").eval()
    net.load_state_dict(torch.load(os.path.join(RVM_DIR, "rvm_mobilenetv3.pth"), map_location="cpu"))
    net = net.to(device)
    os.makedirs(alpha_dir, exist_ok=True)
    frame_dir = os.path.join(cache, "frames")
    first = cv2.imread(os.path.join(frame_dir, "00000000.jpg"))
    ratio = min(1.0, 512 / max(first.shape[:2]))
    rec = [None] * 4

    def run(img):
        nonlocal rec
        t = torch.from_numpy(cv2.cvtColor(img, cv2.COLOR_BGR2RGB)).permute(2, 0, 1).float().div(255).unsqueeze(0).to(device)
        _, pha, *rec = net(t, *rec, downsample_ratio=ratio)
        return (pha[0, 0].clamp(0, 1).cpu().numpy() * 255).astype(np.uint8)

    with torch.no_grad():
        # 先用前几帧把循环状态"热"起来，第一帧的边缘会更稳
        for i in range(min(n, 8)):
            run(cv2.imread(os.path.join(frame_dir, f"{i:08d}.jpg")))
        for i in range(n):
            pha = run(cv2.imread(os.path.join(frame_dir, f"{i:08d}.jpg")))
            cv2.imwrite(os.path.join(alpha_dir, f"{i:08d}.png"), pha)
            progress(0.30 + 0.01 * (i + 1) / n, "抠出人像（首次）")
    return alpha_dir


class Background:
    """背景素材：图片固定不动；视频按 25fps 循环播放。统一裁成和形象同样大小（铺满、居中裁切）。
    视频用 ffmpeg 解码成原始帧从管道读，不用 cv2.VideoCapture（它在 Windows 上打不开中文路径）。"""

    def __init__(self, path, w, h):
        self.w, self.h = w, h
        self.proc = None
        self.img = None
        self.path = path
        if os.path.splitext(path)[1].lower() in (".jpg", ".jpeg", ".png", ".webp", ".bmp"):
            self.img = self.cover(cv2.imread(path))
        else:
            self.open()
            if self.read() is None:
                raise RuntimeError("读不了背景视频：" + path)
            self.open()

    def open(self):
        self.close()
        vf = f"fps={FPS},scale={self.w}:{self.h}:force_original_aspect_ratio=increase,crop={self.w}:{self.h}"
        self.proc = subprocess.Popen(
            [ffmpeg_bin(), "-v", "error", "-stream_loop", "-1", "-i", self.path, "-an", "-vf", vf, "-f", "rawvideo", "-pix_fmt", "bgr24", "-"],
            stdout=subprocess.PIPE,
        )

    def read(self):
        n = self.w * self.h * 3
        buf = self.proc.stdout.read(n)
        if len(buf) < n:
            return None
        return np.frombuffer(buf, dtype=np.uint8).reshape(self.h, self.w, 3)

    def close(self):
        if self.proc:
            self.proc.kill()
            self.proc.wait()
            self.proc = None

    def cover(self, img):
        if img is None:
            raise RuntimeError("读不了背景素材")
        ih, iw = img.shape[:2]
        k = max(self.w / iw, self.h / ih)
        img = cv2.resize(img, (max(self.w, round(iw * k)), max(self.h, round(ih * k))), interpolation=cv2.INTER_AREA)
        y = (img.shape[0] - self.h) // 2
        x = (img.shape[1] - self.w) // 2
        return img[y : y + self.h, x : x + self.w]

    def next(self):
        if self.img is not None:
            return self.img
        f = self.read()
        if f is None:  # 理论上 -stream_loop 不会读完，保险起见重开
            self.open()
            f = self.read()
        return f


# ---------------------------------------------------------------- 生成
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--avatar", required=True)
    ap.add_argument("--cache", required=True)
    ap.add_argument("--audio", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--bbox-shift", type=int, default=0)
    ap.add_argument("--batch-size", type=int, default=16)
    ap.add_argument("--bg", default=None, help="（预留）替换背景")
    ap.add_argument("--fp32", action="store_true", help="用 float32（更慢，半精度出问题时用）")
    args = ap.parse_args()
    for k in ("avatar", "cache", "audio", "out", "bg"):
        if getattr(args, k):
            setattr(args, k, os.path.abspath(getattr(args, k)))
    os.chdir(MUSETALK_DIR)

    t0 = time.time()
    device = pick_device()
    dtype = torch.float32 if (args.fp32 or device.type == "cpu") else torch.float16
    log("设备：", device, dtype)
    if device.type == "cuda":
        try:
            free, total_mem = torch.cuda.mem_get_info()
            log(f"显卡：{torch.cuda.get_device_name(0)}，显存共 {total_mem / 1024**3:.1f}GB，开始时剩 {free / 1024**3:.1f}GB")
        except Exception as e:
            log("读不到显存信息：", e)
    elif device.type == "cpu" and sys.platform == "win32":
        log("没检测到可用的 NVIDIA 显卡（或驱动太旧），改用 CPU，会非常慢")
    progress(0.0, "加载模型" + ("（没用上显卡，在用 CPU）" if device.type == "cpu" else ""))

    from transformers import WhisperModel
    from musetalk.utils.utils import load_all_model
    from musetalk.utils.audio_processor import AudioProcessor
    from musetalk.utils.face_parsing import FaceParsing
    from musetalk.utils.blending import get_image_blending

    # 模型先在内存里转成半精度，再放进显卡。
    # 原版是先按全精度放进显卡再转，加载那一下要多占 3GB 多显存，6GB/8GB 的显卡容易被挤满。
    vae, unet, pe = load_all_model(
        unet_model_path=os.path.join("models", "musetalkV15", "unet.pth"),
        vae_type="sd-vae",
        unet_config=os.path.join("models", "musetalkV15", "musetalk.json"),
        device=torch.device("cpu"),
    )
    vae.vae = vae.vae.to("cpu").to(dtype=dtype).to(device)
    vae.device = device
    unet.model = unet.model.to(dtype=dtype).to(device)
    unet.device = device
    pe = pe.to(dtype=dtype).to(device)
    free_gpu(device)
    timesteps = torch.tensor([0], device=device)

    fp = FaceParsing(left_cheek_width=90, right_cheek_width=90)
    info = prepare_avatar(args.avatar, args.cache, args.bbox_shift, device, vae, fp)
    del fp
    log(f"形象准备完成 {time.time() - t0:.1f}s")
    alpha_dir = prepare_alpha(args.cache, info["frames"], device) if args.bg else None
    free_gpu(device)  # 分析形象、抠图用过的显存先还掉，再开始生成
    bg = Background(args.bg, info["width"], info["height"]) if args.bg else None

    # 音频特征
    progress(0.31, "提取音频特征")
    tmp_wav = os.path.join(args.cache, "_audio_16k.wav")
    subprocess.run([ffmpeg_bin(), "-v", "error", "-y", "-i", args.audio, "-ac", "1", "-ar", "16000", tmp_wav], check=True)
    audio_processor = AudioProcessor(feature_extractor_path=os.path.join("models", "whisper"))
    whisper = WhisperModel.from_pretrained(os.path.join("models", "whisper")).to(device=device, dtype=dtype).eval()
    whisper.requires_grad_(False)
    feats, length = audio_processor.get_audio_feature(tmp_wav, weight_dtype=dtype)
    with torch.no_grad():
        chunks = audio_processor.get_whisper_chunk(feats, device, dtype, whisper, length, fps=FPS, audio_padding_length_left=2, audio_padding_length_right=2)
    del whisper
    total = len(chunks)
    log(f"音频 {length / 16000:.1f}s，共 {total} 帧")

    # 缓存
    latents = torch.load(os.path.join(args.cache, "latents.pt"))
    with open(os.path.join(args.cache, "coords.pkl"), "rb") as f:
        cc = pickle.load(f)
    coords, mask_coords = cc["coords"], cc["mask_coords"]
    n = info["frames"]
    frame_dir = os.path.join(args.cache, "frames")
    mask_dir = os.path.join(args.cache, "masks")

    def cyc(i):
        # 来回播放（正放再倒放），避免循环时跳帧
        if n == 1:
            return 0
        j = i % (2 * n)
        return j if j < n else 2 * n - 1 - j

    w, h = info["width"], info["height"]
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    part = args.out + ".part.mp4"
    enc = subprocess.Popen(
        [
            ffmpeg_bin(), "-v", "error", "-y",
            "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{w}x{h}", "-r", str(FPS), "-i", "-",
            "-i", args.audio,
            "-map", "0:v", "-map", "1:a",
            *VIDEO_ENC, "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", part,
        ],
        stdin=subprocess.PIPE,
    )

    frame_cache = {}

    def load(idx):
        if idx not in frame_cache:
            if len(frame_cache) > 64:
                frame_cache.clear()
            alpha = None
            if alpha_dir:
                alpha = cv2.imread(os.path.join(alpha_dir, f"{idx:08d}.png"), cv2.IMREAD_GRAYSCALE).astype(np.float32)[..., None] / 255.0
            frame_cache[idx] = (
                cv2.imread(os.path.join(frame_dir, f"{idx:08d}.jpg")),
                cv2.imread(os.path.join(mask_dir, f"{idx:08d}.png"), cv2.IMREAD_GRAYSCALE),
                alpha,
            )
        return frame_cache[idx]

    t1 = time.time()
    done = 0
    bs = pick_batch_size(args.batch_size, gpu_free_gb(device))
    log(f"每批 {bs} 帧")
    with torch.no_grad():
        s = 0
        while s < total:
            idxs = [cyc(i) for i in range(s, min(total, s + bs))]
            try:
                wb = chunks[s : s + len(idxs)].to(device=device, dtype=dtype)
                lb = latents[idxs].to(device=device, dtype=dtype)
                audio_feat = pe(wb)
                pred = unet.model(lb, timesteps, encoder_hidden_states=audio_feat).sample
                recon = vae.decode_latents(pred)
            except RuntimeError as e:
                # 显存不够：一批少算一半再试，减到 1 帧还不行才算失败
                if not is_oom(e) or bs == 1:
                    raise
                wb = lb = audio_feat = pred = None
                bs = max(1, bs // 2)
                free_gpu(device)
                log(f"显存不够，改成每批 {bs} 帧重试")
                continue
            for k, face in enumerate(recon):
                idx = idxs[k]
                frame, mask, alpha = load(idx)
                x1, y1, x2, y2 = coords[idx]
                face = cv2.resize(np.ascontiguousarray(face).astype(np.uint8), (x2 - x1, y2 - y1))
                out = get_image_blending(frame.copy(), face, coords[idx], mask, mask_coords[idx])
                if bg is not None:
                    out = (out.astype(np.float32) * alpha + bg.next().astype(np.float32) * (1 - alpha)).astype(np.uint8)
                enc.stdin.write(np.ascontiguousarray(out).tobytes())
            s += len(idxs)
            done += len(idxs)
            el = time.time() - t1
            progress(0.33 + 0.65 * done / total, f"生成口型 {done}/{total} 帧 · {done / max(el, 1e-3):.1f} 帧/秒" + speed_note(device, gpu_free_gb(device)))
    enc.stdin.close()
    if bg is not None:
        bg.close()
    if enc.wait() != 0:
        raise RuntimeError("ffmpeg 编码失败")
    os.replace(part, args.out)
    os.remove(tmp_wav)
    log(f"完成：{total} 帧，生成 {time.time() - t1:.1f}s，总计 {time.time() - t0:.1f}s")
    if device.type == "cuda":
        try:
            log(f"显存最高用到 {torch.cuda.max_memory_allocated() / 1024**3:.1f}GB（PyTorch 实际占用 {torch.cuda.max_memory_reserved() / 1024**3:.1f}GB）")
        except Exception:
            pass
    progress(1.0, "完成")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        import traceback

        traceback.print_exc()
        # 说明放在最后一行：软件界面只显示输出的最后几行
        if is_oom(e):
            log("错误：显存不够。请关掉其他占用显卡的程序（直播/录屏软件、别的 AI 软件、多余的浏览器窗口）后重试；设置里「同时生成数量」保持 1。")
        else:
            log("错误：", e)
        sys.exit(1)
