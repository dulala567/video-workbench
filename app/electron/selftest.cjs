// 自检模式：`VideoWorkbench.exe --self-test <输出目录> [--sample <中文语音文件>] [--face <人脸照片>]`
// 云端打包后在真实 Windows 上跑一遍关键链路，结果写进 <输出目录>/selftest.json，失败时退出码非 0。
// 只用于打包检查，普通用户不会触发。
const fs = require('fs');
const path = require('path');
const { BrowserWindow } = require('electron');
const { paths } = require('./paths.cjs');
const { ffmpeg, probe, detectHwEncoder } = require('./ffmpeg.cjs');
const { transcribe, toSubtitleLines } = require('./asr.cjs');
const { burnWithLook, resolveLook, handlers } = require('./jobs.cjs');
const { presets } = require('./ass.cjs');
const { store } = require('./store.cjs');
const lipsync = require('./lipsync.cjs');

function argAfter(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : null;
}

async function run(checkEnv) {
  const out = path.resolve(argAfter('--self-test') || 'selftest-out');
  fs.mkdirSync(out, { recursive: true });
  const results = [];
  const log = (name, ok, detail) => {
    results.push({ name, ok, detail });
    fs.writeFileSync(path.join(out, 'selftest.json'), JSON.stringify({ platform: process.platform, results }, null, 2));
  };
  const step = async (name, fn, critical = true) => {
    const t0 = Date.now();
    try {
      const d = await fn();
      log(name, true, { ms: Date.now() - t0, ...(d || {}) });
    } catch (e) {
      log(name, false, { ms: Date.now() - t0, error: String(e?.stack || e), critical });
    }
  };
  const ctx = { signal: undefined, progress() {}, enqueue() {}, seq: 1 };

  // 输出目录指到自检目录，不动真实用户目录；目录名带中文和空格，测路径
  const s = store.getSettings();
  store.saveSettings({ ...s, outRoot: path.join(out, '输出 目录') });

  await step('环境检查', async () => {
    const env = await checkEnv();
    if (!env.ffmpeg) throw new Error('找不到 ffmpeg');
    if (!env.whisper) throw new Error('找不到 whisper-cli');
    if (!env.whisperModel) throw new Error('找不到识别模型 ' + env.whisperModelPath);
    return { env: { ...env, lipsync: undefined }, ffmpeg: paths.ffmpeg(), whisper: paths.whisper(), fontsDir: paths.fontsDir };
  });

  // 文件名带中文和空格，顺便测路径
  const src = path.join(out, '测试 视频.mp4');
  await step('生成测试视频', async () => {
    await ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=s=720x1280:d=4:r=25', '-f', 'lavfi', '-i', 'sine=f=440:d=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', src]);
    return { duration: (await probe(src)).duration };
  });

  await step('硬件编码检测', async () => ({ encoder: (await detectHwEncoder())?.label || '无（使用 CPU x264）' }), false);

  const lines = [
    { start: 0.2, end: 1.9, text: '中文字幕烧录测试' },
    { start: 2.0, end: 3.8, text: '视频工作台 Windows 版' },
  ];
  for (const st of [presets.styles[0], presets.styles.find((x) => x.box) || presets.styles[1]]) {
    const burned = path.join(out, `烧录_${st.name}.mp4`);
    await step(`字幕烧录（样式「${st.name}」，字体 ${st.font}）`, async () => {
      const look = resolveLook({ sub: { ...st, y: 0.7 }, showSubs: true });
      await burnWithLook(src, look, lines, burned, ctx, [0, 1]);
      const png = burned.replace(/\.mp4$/, '.png');
      await ffmpeg(['-ss', '1', '-i', burned, '-frames:v', '1', png]);
      return { size: fs.statSync(burned).size, frame: path.basename(png) };
    });
  }

  for (const fmt of ['mp3', 'wav', 'copy']) {
    await step(`音频提取（${fmt}）`, async () => {
      const r = await handlers.mp3({ input: { file: src, opts: { format: fmt, skipExisting: false, deleteSource: false } } }, ctx);
      return { file: path.basename(r.file), outSize: r.outSize };
    });
  }

  const sample = argAfter('--sample');
  if (sample) {
    await step('中文语音识别', async () => {
      const segs = await transcribe(path.resolve(sample), { signal: undefined, onProgress() {} });
      const text = segs.map((x) => x.text).join('');
      if (!/视频|字幕|大家好/.test(text)) throw new Error('识别结果不对：' + text);
      return { text, lines: toSubtitleLines(segs, { maxChars: 14 }).length };
    });
  }

  const face = argAfter('--face');
  if (face && sample) {
    await step('显卡检测', async () => ({ gpu: (await lipsync.detectGpu()) || '不适用' }), false);
    await step('数字人对口型（照片 + 3 秒音频 + 换背景）', async () => {
      const st = lipsync.status();
      if (!st.ready) throw new Error('数字人组件不全：' + JSON.stringify(st));
      const audio = path.join(out, '口型 音频.mp3');
      await ffmpeg(['-i', path.resolve(sample), '-t', '3', audio]);
      const bgImg = path.join(out, '背景 图.png');
      await ffmpeg(['-f', 'lavfi', '-i', 'color=c=0x3366cc:s=720x1280', '-frames:v', '1', bgImg]);
      const [av] = await lipsync.addAvatars([path.resolve(face)]);
      const r = await lipsync.handler({ input: { avatarId: av.id, audio, bg: { mode: 'fixed', files: [bgImg] }, look: { showSubs: false } } }, ctx);
      const png = path.join(out, '数字人.png');
      await ffmpeg(['-ss', '1.5', '-i', r.file, '-frames:v', '1', png]);
      return { file: r.file, duration: (await probe(r.file)).duration, frame: path.basename(png) };
    });
  }

  await step(
    '界面加载',
    async () => {
      const win = new BrowserWindow({ width: 1280, height: 800, show: true, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: false } });
      await win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
      await new Promise((r) => setTimeout(r, 4000));
      const nav = await win.webContents.executeJavaScript("[...document.querySelectorAll('.nav-item')].map(e=>e.textContent.trim()).join(' | ')");
      const img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(out, 'ui.png'), img.toPNG());
      win.destroy();
      if (!nav) throw new Error('界面没有渲染出导航');
      return { nav };
    },
    false
  );

  const failed = results.filter((r) => !r.ok && r.detail.critical !== false);
  log('结论', failed.length === 0, { failed: failed.map((f) => f.name) });
  return failed.length ? 1 : 0;
}

module.exports = { run, isSelfTest: () => process.argv.includes('--self-test') };
