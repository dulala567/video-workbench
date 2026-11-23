// 外部程序与引擎的路径解析。
// Mac：GUI 启动的 Electron 拿不到 shell 的 PATH，这里手动补上 Homebrew 目录。
// Windows 打包版：ffmpeg / whisper-cli 在 resources/bin，识别模型在 resources/models，字幕字体在 resources/fonts。
const fs = require('fs');
const path = require('path');
const os = require('os');

const IS_WIN = process.platform === 'win32';
const SEP = IS_WIN ? ';' : ':';

// 打包后 process.resourcesPath 指向安装目录下的 resources；开发时没有这几个子目录
const RES = process.resourcesPath || '';
const resDir = (name) => {
  const d = RES && path.join(RES, name);
  return d && fs.existsSync(d) ? d : null;
};
const BUNDLED_BIN = resDir('bin');

const EXTRA_PATHS = IS_WIN
  ? [BUNDLED_BIN].filter(Boolean)
  : [BUNDLED_BIN, '/opt/homebrew/opt/ffmpeg-full/bin', '/opt/homebrew/bin', '/usr/local/opt/ffmpeg-full/bin', '/usr/local/bin'].filter(Boolean);
process.env.PATH = [...EXTRA_PATHS, process.env.PATH || ''].join(SEP);

function which(bin) {
  const names = IS_WIN ? [bin + '.exe', bin] : [bin];
  for (const dir of process.env.PATH.split(SEP)) {
    if (!dir) continue;
    for (const n of names) {
      const p = path.join(dir, n);
      try {
        fs.accessSync(p, IS_WIN ? fs.constants.F_OK : fs.constants.X_OK);
        if (fs.statSync(p).isFile()) return p;
      } catch {}
    }
  }
  return null;
}

// 工程根目录（app 的上一级），engines/ 放模型和 Python 环境。
// Windows 打包版的数字人引擎在 resources/engines：python/（自带 Python + 显卡版 PyTorch）、MuseTalk/、RobustVideoMatting/、torch-hub/（人脸检测模型）
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const BUNDLED_ENGINES = resDir('engines');
const ENGINES_DIR = BUNDLED_ENGINES || path.join(PROJECT_ROOT, 'engines');

// 识别模型：优先用安装包自带的，其次用工程里的
function defaultWhisperModel() {
  const bundled = resDir('models');
  if (bundled) {
    const f = fs.readdirSync(bundled).find((x) => /^ggml-.*\.bin$/.test(x));
    if (f) return path.join(bundled, f);
  }
  return path.join(ENGINES_DIR, 'whisper', 'ggml-large-v3-turbo.bin');
}

// 快速识别（SenseVoice，通过 sherpa-onnx 运行）：程序和模型。Windows 打包版自带；
// 开发时可以用环境变量 VW_SHERPA / VW_SENSEVOICE_DIR 指过去，或放在 engines/sherpa-onnx、engines/sensevoice。
function sherpaBin() {
  const exe = IS_WIN ? 'sherpa-onnx-offline.exe' : 'sherpa-onnx-offline';
  const cands = [process.env.VW_SHERPA, resDir('sherpa') && path.join(resDir('sherpa'), exe), path.join(ENGINES_DIR, 'sherpa-onnx', 'bin', exe)];
  return cands.find((p) => p && fs.existsSync(p)) || null;
}
function senseVoiceDir() {
  const cands = [process.env.VW_SENSEVOICE_DIR, resDir('models') && path.join(resDir('models'), 'sensevoice'), path.join(ENGINES_DIR, 'sensevoice')];
  return cands.find((p) => p && fs.existsSync(path.join(p, 'model.int8.onnx')) && fs.existsSync(path.join(p, 'tokens.txt'))) || null;
}

const paths = {
  isWin: IS_WIN,
  projectRoot: PROJECT_ROOT,
  engines: ENGINES_DIR,
  ffmpeg: () => which('ffmpeg'),
  ffprobe: () => which('ffprobe'),
  whisper: () => which('whisper-cli'),
  sherpa: sherpaBin,
  senseVoiceDir,
  defaultWhisperModel: defaultWhisperModel(),
  fontsDir: resDir('fonts'), // 安装包自带的字幕字体（Windows 版带思源黑体）
  python: BUNDLED_ENGINES ? path.join(ENGINES_DIR, 'python', IS_WIN ? 'python.exe' : 'bin/python3') : path.join(ENGINES_DIR, '.venv', 'bin', 'python'),
  torchHome: BUNDLED_ENGINES ? path.join(ENGINES_DIR, 'torch-hub') : null, // 自带的人脸检测模型，避免运行时联网下载
  museTalk: path.join(ENGINES_DIR, 'MuseTalk'),
  lipsyncRunner: path.join(ENGINES_DIR, 'lipsync_runner.py'),
  defaultOutRoot: path.join(os.homedir(), IS_WIN ? 'Videos' : 'Movies', '视频工作台'),
};

module.exports = { paths, which };
