// 自检模式：`VideoWorkbench.exe --self-test <输出目录> [--sample <中文语音文件>] [--face <人脸照片>]`
// 云端打包后在真实 Windows 上跑一遍关键链路，结果写进 <输出目录>/selftest.json，失败时退出码非 0。
// 只用于打包检查，普通用户不会触发。
const fs = require('fs');
const path = require('path');
const { BrowserWindow } = require('electron');
const { paths } = require('./paths.cjs');
const { ffmpeg, probe, detectHwEncoder, runProcess, filterPath } = require('./ffmpeg.cjs');
const { transcribe, toSubtitleLines, pickEngine } = require('./asr.cjs');
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
    return { env: { ...env, lipsync: undefined }, exe: process.execPath, ffmpeg: paths.ffmpeg(), whisper: paths.whisper(), fontsDir: paths.fontsDir };
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

  // 软件放在中文文件夹里时，字幕滤镜还能不能读到包里自带的字体
  if (paths.fontsDir) {
    await step(
      '字幕字体（安装包自带的思源黑体）',
      async () => {
        const dir = path.join(out, '字体 检查');
        fs.mkdirSync(dir, { recursive: true });
        const ass = [
          '[Script Info]', 'ScriptType: v4.00+', 'PlayResX: 720', 'PlayResY: 1280', '',
          '[V4+ Styles]',
          'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
          'Style: Default,Noto Sans SC,60,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,3,0,2,10,10,10,1', '',
          '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
          'Dialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,中文字体检查',
        ].join('\n');
        fs.writeFileSync(path.join(dir, 'sub.ass'), ass);
        let err = '';
        await runProcess(paths.ffmpeg(), ['-hide_banner', '-v', 'verbose', '-f', 'lavfi', '-i', 'color=c=black:s=720x1280:d=0.2', '-vf', `ass=sub.ass:fontsdir=${filterPath(paths.fontsDir)}`, '-frames:v', '1', '-f', 'null', '-'], {
          cwd: dir,
          onStderr: (t) => (err += t),
        });
        const picked = err.split(/\r?\n/).filter((l) => /fontselect/.test(l)).map((l) => l.replace(/^.*fontselect:\s*/, ''));
        if (!picked.some((l) => /->.*Noto\s?Sans\s?SC/i.test(l))) throw new Error('没用上自带字体：' + (picked.join(' | ') || err.slice(-800)));
        return { fontsDir: paths.fontsDir, picked };
      },
      false
    );
  }

  for (const fmt of ['mp3', 'wav', 'copy']) {
    await step(`音频提取（${fmt}）`, async () => {
      const r = await handlers.mp3({ input: { file: src, opts: { format: fmt, skipExisting: false, deleteSource: false } } }, ctx);
      return { file: path.basename(r.file), outSize: r.outSize };
    });
  }

  const sample = argAfter('--sample');
  if (sample) {
    const expectText = (segs) => {
      const text = segs.map((x) => x.text).join('');
      if (!/视频|字幕|大家好/.test(text)) throw new Error('识别结果不对：' + text);
      return text;
    };
    // 两种识别引擎都测：快速识别（SenseVoice，装了才有）和 whisper（退路，也是其他语言用的）
    const base = store.getSettings();
    const hasFast = !!(paths.sherpa() && paths.senseVoiceDir());
    if (hasFast) {
      await step('中文语音识别（快速识别 SenseVoice）', async () => {
        store.saveSettings({ ...base, asr: { ...base.asr, engine: 'auto' } });
        if (pickEngine(store.getSettings()) !== 'sensevoice') throw new Error('没有选中快速识别');
        const segs = await transcribe(path.resolve(sample), { signal: undefined, onProgress() {} });
        return { text: expectText(segs), lines: toSubtitleLines(segs, { maxChars: 14 }).map((l) => `${l.start.toFixed(2)}-${l.end.toFixed(2)} ${l.text}`) };
      });
      // 长音频要切段识别：把样例接 4 遍（72 秒），检查每一遍都识别出来、时间没错位
      await step('长音频切段识别（72 秒）', async () => {
        const long = path.join(out, '长 音频.wav');
        await ffmpeg(['-stream_loop', '3', '-i', path.resolve(sample), '-ac', '1', '-ar', '16000', long]);
        const dur = (await probe(long)).duration;
        const segs = await transcribe(long, { signal: undefined, onProgress() {} });
        const text = segs.map((x) => x.text).join('');
        const hits = [...text.matchAll(/大家好/g)].length;
        if (hits !== 4) throw new Error(`应识别出 4 遍，实际 ${hits} 遍：` + text);
        for (let i = 1; i < segs.length; i++) if (segs[i].start + 0.01 < segs[i - 1].start) throw new Error('时间顺序乱了');
        const starts = segs.filter((x, i) => x.text === '大' && segs[i + 1]?.text === '家' && segs[i + 2]?.text === '好').map((x) => +x.start.toFixed(2));
        const last = segs[segs.length - 1].end;
        if (Math.abs(last - dur) > 2.5) throw new Error(`最后一个字在 ${last.toFixed(1)} 秒，音频长 ${dur.toFixed(1)} 秒`);
        if (!fs.existsSync(path.join(paths.senseVoiceDir(), 'model.int8.onnx'))) throw new Error('识别后模型文件不见了');
        return { duration: dur, pieces: segs.length, starts, lastEnd: last };
      });
    }
    await step('中文语音识别（whisper）', async () => {
      store.saveSettings({ ...store.getSettings(), asr: { ...base.asr, engine: 'whisper' } });
      const segs = await transcribe(path.resolve(sample), { signal: undefined, onProgress() {} });
      store.saveSettings({ ...store.getSettings(), asr: { ...base.asr, engine: 'auto' } });
      return { text: expectText(segs), lines: toSubtitleLines(segs, { maxChars: 14 }).length };
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
      // 记录进度回报：进度条在界面上动不动，靠的就是这些回调
      const stages = [];
      let maxP = 0;
      const lsCtx = {
        ...ctx,
        progress: (p, stage) => {
          maxP = Math.max(maxP, p);
          if (stage && stages[stages.length - 1] !== stage.replace(/[\d./]+/g, '#')) stages.push(stage.replace(/[\d./]+/g, '#'));
        },
      };
      const r = await lipsync.handler({ input: { avatarId: av.id, audio, bg: { mode: 'fixed', files: [bgImg] }, look: { showSubs: false } } }, lsCtx);
      if (!stages.some((x) => x.includes('生成口型'))) throw new Error('口型脚本的进度没有传到界面：' + JSON.stringify(stages));
      const png = path.join(out, '数字人.png');
      await ffmpeg(['-ss', '1.5', '-i', r.file, '-frames:v', '1', png]);
      return { file: r.file, duration: (await probe(r.file)).duration, frame: path.basename(png), maxProgress: maxP, stages };
    });
    // 快速模式（小型解码模型）：同一个形象再生成一条，形象分析结果走缓存
    await step('数字人快速模式（小型解码模型）', async () => {
      const cur = store.getSettings();
      store.saveSettings({ ...cur, lipsync: { ...cur.lipsync, fastDecode: true } });
      try {
        const av = lipsync.listAvatars()[0];
        const audio = path.join(out, '口型 音频.mp3');
        const r = await lipsync.handler({ input: { avatarId: av.id, audio, look: { showSubs: false } } }, ctx);
        const log = fs.readFileSync(r.raw.replace(/\.mp4$/, '.log'), 'utf8');
        if (!log.includes('快速模式：用小型解码模型')) throw new Error('没用上快速模式：' + log.slice(-600));
        const png = path.join(out, '数字人_快速模式.png');
        await ffmpeg(['-ss', '1.5', '-i', r.file, '-frames:v', '1', png]);
        return { duration: (await probe(r.file)).duration, frame: path.basename(png), log: log.split(/\r?\n/).filter((l) => /每批|完成：|设备|显卡/.test(l)) };
      } finally {
        const now = store.getSettings();
        store.saveSettings({ ...now, lipsync: { ...now.lipsync, fastDecode: false } });
      }
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
