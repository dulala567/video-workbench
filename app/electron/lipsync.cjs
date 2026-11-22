// 数字人口型：形象库 + 生成流程（口型 → 换背景 → 混背景音乐 → 识别字幕 → 烧录）
const fs = require('fs');
const os = require('os');
const path = require('path');
const { paths } = require('./paths.cjs');
const { store } = require('./store.cjs');
const { probe, ffmpeg, runProcess } = require('./ffmpeg.cjs');
const { transcribe, toSubtitleLines, toSrt } = require('./asr.cjs');

const IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.webp'];

function status() {
  const w = (p) => fs.existsSync(path.join(paths.museTalk, 'models', p));
  const python = fs.existsSync(paths.python);
  const weights = w('musetalkV15/unet.pth') && w('sd-vae/diffusion_pytorch_model.bin') && w('whisper/pytorch_model.bin') && w('face-parse-bisent/79999_iter.pth');
  const runner = fs.existsSync(paths.lipsyncRunner);
  return { ready: python && weights && runner, python, weights, runner };
}

// 显卡：数字人在 NVIDIA 显卡上跑得动，没有就退回 CPU（非常慢）。Mac 用自带的 Apple 显卡，不用查。
let gpuCache;
function detectGpu() {
  if (process.platform !== 'win32') return Promise.resolve(null);
  if (gpuCache) return gpuCache;
  gpuCache = new Promise((resolve) => {
    require('child_process').execFile('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'], { timeout: 8000, windowsHide: true }, (err, out) => {
      if (err || !out.trim()) return resolve({ nvidia: false, name: '', memMB: 0 });
      const [name, mem] = out.trim().split('\n')[0].split(',').map((x) => x.trim());
      resolve({ nvidia: true, name, memMB: Number(mem) || 0 });
    });
  });
  return gpuCache;
}

function listAvatars() {
  return store.getAvatars().filter((a) => fs.existsSync(a.file));
}

async function addAvatars(files, thumbnail) {
  const list = store.getAvatars();
  const root = store.outDir('avatars');
  const added = [];
  for (const f of files) {
    const id = 'av-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const dir = path.join(root, id);
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, 'source' + path.extname(f).toLowerCase());
    fs.copyFileSync(f, dest);
    const isImage = IMAGE_EXT.includes(path.extname(f).toLowerCase());
    let info = { duration: 0, width: 0, height: 0 };
    try {
      info = await probe(dest);
    } catch {}
    if (!isImage && info.duration > 61) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw new Error(`「${path.basename(f)}」超过 60 秒，请先剪短`);
    }
    let thumb = dest;
    if (!isImage) {
      thumb = path.join(dir, 'thumb.jpg');
      await ffmpeg(['-ss', '0.3', '-i', dest, '-frames:v', '1', '-vf', 'scale=360:-2', thumb]);
    }
    const av = {
      id,
      name: path.basename(f, path.extname(f)),
      file: dest,
      thumb,
      isImage,
      width: info.width,
      height: info.height,
      duration: info.duration,
      cacheDir: path.join(dir, 'cache'),
      createdAt: Date.now(),
    };
    list.push(av);
    added.push(av);
  }
  store.saveAvatars(list);
  return added;
}

function removeAvatars(ids) {
  const list = store.getAvatars();
  for (const a of list.filter((x) => ids.includes(x.id))) {
    fs.rmSync(path.dirname(a.file), { recursive: true, force: true });
  }
  store.saveAvatars(list.filter((x) => !ids.includes(x.id)));
}
function renameAvatar(id, name) {
  const list = store.getAvatars();
  const a = list.find((x) => x.id === id);
  if (a) a.name = name;
  store.saveAvatars(list);
}

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const baseName = (f) => path.basename(f, path.extname(f));

async function handler(job, ctx) {
  const st = status();
  if (!st.ready) throw new Error('数字人组件还没准备好（设置 → 检测环境 查看缺什么）');
  const s = store.getSettings();
  const { avatarId, audio, bgm, bg, resolution } = job.input;
  const av = store.getAvatars().find((a) => a.id === avatarId);
  if (!av) throw new Error('形象已被删除');
  const outDir = store.outDir('lipsync');
  const rawDir = path.join(outDir, '_原片');
  fs.mkdirSync(rawDir, { recursive: true });
  const name = `${s.output.addSeq ? String(ctx.seq).padStart(3, '0') + '_' : ''}${av.name}_${baseName(audio)}`;
  const raw = path.join(rawDir, name + '.mp4');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vw-ls-'));
  try {
    // 1. 口型
    const args = [paths.lipsyncRunner, '--avatar', av.file, '--cache', av.cacheDir, '--audio', audio, '--out', raw, '--bbox-shift', String(s.lipsync.bboxShift || 0)];
    if (bg?.mode && bg.mode !== 'off' && bg.files?.length) args.push('--bg', bg.mode === 'fixed' ? bg.files[0] : pick(bg.files));
    let buf = '';
    await runProcess(paths.python, args, {
      cwd: paths.museTalk,
      signal: ctx.signal,
      env: {
        ...process.env,
        PYTORCH_ENABLE_MPS_FALLBACK: '1',
        PYTHONUNBUFFERED: '1',
        // Windows 控制台默认不是 UTF-8，不设的话 Python 打印中文会出错
        PYTHONUTF8: '1',
        PYTHONIOENCODING: 'utf-8',
        // 模型都在本地，不联网
        HF_HUB_OFFLINE: '1',
        TRANSFORMERS_OFFLINE: '1',
        ...(paths.torchHome ? { TORCH_HOME: paths.torchHome } : {}),
      },
      onStdout: (t) => {
        buf += t;
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const l of lines) {
          const m = l.match(/^@@PROGRESS ([\d.]+) ?(.*)$/);
          if (m) ctx.progress(Number(m[1]) * 0.7, m[2] || '生成口型');
        }
      },
    });
    let cur = raw;
    const info = await probe(raw);

    // 2. 背景音乐：循环铺满、结尾淡出、压在人声下面
    if (bgm?.mode && bgm.mode !== 'off' && bgm.files?.length) {
      ctx.progress(0.72, '混合背景音乐');
      const music = bgm.mode === 'fixed' ? bgm.files[0] : pick(bgm.files);
      const mixed = path.join(tmp, 'mixed.mp4');
      const vol = bgm.volume ?? 0.18;
      const fadeStart = Math.max(0, info.duration - 2);
      await ffmpeg(
        [
          '-i', cur, '-stream_loop', '-1', '-i', music,
          '-filter_complex', `[1:a]volume=${vol},afade=t=out:st=${fadeStart}:d=2[b];[0:a][b]amix=inputs=2:duration=first:normalize=0[a]`,
          '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-t', String(info.duration), mixed,
        ],
        { signal: ctx.signal }
      );
      cur = mixed;
    }

    // 3. 字幕 + 清晰度 + 编码
    const { resolveLook, burnWithLook, getSubtitleLines } = require('./jobs.cjs');
    const look = resolveLook(job.input.look || {});
    const short = Number(resolution || s.lipsync.resolution || 720);
    const scale = info.width <= info.height ? `scale=${short}:-2` : `scale=-2:${short}`;
    look.vf = [scale, look.vf].filter(Boolean).join(',');
    let lines = [];
    if (look.showSubs !== false) {
      // 用原始音频识别，不受背景音乐干扰
      lines = await getSubtitleLines(audio, look, ctx, [0.72, 0.85]);
    }
    const out = path.join(outDir, name + '.mp4');
    await burnWithLook(cur, look, lines, out, ctx, [0.85, 1]);
    if (lines.length) fs.writeFileSync(path.join(rawDir, name + '.srt'), toSrt(lines));
    return { file: out, raw };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

module.exports = { status, detectGpu, listAvatars, addAvatars, removeAvatars, renameAvatar, handler };
