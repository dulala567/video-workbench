// 各类任务的执行逻辑。每个 handler：async (job, ctx) => 输出信息
const fs = require('fs');
const os = require('os');
const path = require('path');
const { shell } = require('electron');
const { store } = require('./store.cjs');
const { probe, ffmpeg, filterPath, hwEncoder, x264Args } = require('./ffmpeg.cjs');
const { paths } = require('./paths.cjs');
const { transcribe, toSubtitleLines, toSrt, parseSrt, toPlainText } = require('./asr.cjs');
const { buildAss, presets } = require('./ass.cjs');

// 音频提取支持的格式
const AUDIO_FORMATS = {
  mp3: { ext: '.mp3', args: (br) => ['-c:a', 'libmp3lame', '-b:a', br || '128k'] },
  m4a: { ext: '.m4a', args: (br) => ['-c:a', 'aac', '-b:a', br || '128k'] },
  wav: { ext: '.wav', args: () => ['-c:a', 'pcm_s16le'] },
  flac: { ext: '.flac', args: () => ['-c:a', 'flac'] },
  copy: { ext: '', args: () => ['-c:a', 'copy'] },
};
// 原样复制音轨时，按原编码选容器
const COPY_EXT = { aac: '.m4a', alac: '.m4a', mp3: '.mp3', opus: '.opus', vorbis: '.ogg', flac: '.flac', ac3: '.ac3', eac3: '.eac3', pcm_s16le: '.wav', pcm_s24le: '.wav', pcm_f32le: '.wav' };

const baseName = (f) => path.basename(f, path.extname(f));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

function outName(dir, file, suffix, ext, seq) {
  const s = store.getSettings();
  const prefix = s.output.addSeq && seq ? String(seq).padStart(3, '0') + '_' : '';
  return path.join(dir, `${prefix}${baseName(file)}${suffix}${ext}`);
}

async function trashSource(file) {
  try {
    await shell.trashItem(file); // 放进废纸篓，可以找回
  } catch (e) {
    console.warn('删除原文件失败', e);
  }
}

// 编码参数：自动 = 检测到的硬件编码（Mac VideoToolbox / Windows NVIDIA、Intel、AMD），没有就用 libx264
function videoCodecArgs() {
  const s = store.getSettings();
  const crf = Number(s.encode.quality) || 20;
  const hw = hwEncoder();
  if (s.encode.encoder === 'x264') return x264Args(crf); // 用户特意选的软件编码：保持 medium，求清晰
  if (!hw) return x264Args(crf, 'veryfast'); // 没有硬件编码只能用 CPU：用快档，实测快近一倍，画质差别很小
  return hw.args(crf);
}

// 把「样式配置」落到这一条视频上：随机样式、随机滤镜在这里决定
function resolveLook(look) {
  const out = { ...look };
  if (look.randomStyle && look.randomPool?.length) out.sub = { ...pick(look.randomPool), y: look.sub?.y ?? 0.72 };
  let vf = null;
  if (look.filter?.mode === 'fixed') vf = presets.filters.find((f) => f.label === look.filter.value)?.filter;
  if (look.filter?.mode === 'random') vf = pick(presets.filters).filter;
  out.vf = vf;
  return out;
}

// 识别或读取同名字幕 → 字幕行
async function getSubtitleLines(file, look, ctx, range = [0, 0.6]) {
  const s = store.getSettings();
  // AI 配音生成的音频旁边有 .words.json（豆包给的逐字时间戳 + 原文），直接用，不再识别
  const wordsFile = path.join(path.dirname(file), baseName(file) + '.words.json');
  if (fs.existsSync(wordsFile)) {
    try {
      const { words } = JSON.parse(fs.readFileSync(wordsFile, 'utf8'));
      if (words?.length) {
        ctx.progress(range[1], '使用配音字幕');
        return toSubtitleLines(words, { maxChars: s.asr.maxChars || 14, keepPunct: !!look.keepPunct });
      }
    } catch {}
  }
  const srt = path.join(path.dirname(file), baseName(file) + '.srt');
  if (s.asr.useSameNameSrt && fs.existsSync(srt)) {
    // 现成字幕也按每行字数切短，长句不会冲出画面
    return toSubtitleLines(parseSrt(fs.readFileSync(srt, 'utf8')), { maxChars: s.asr.maxChars || 14, keepPunct: !!look.keepPunct });
  }
  const segs = await transcribe(file, {
    signal: ctx.signal,
    onProgress: (p, stage) => ctx.progress(range[0] + (range[1] - range[0]) * p, stage),
  });
  return toSubtitleLines(segs, { maxChars: s.asr.maxChars || 14, keepPunct: !!look.keepPunct });
}

// 烧录：滤镜 + ASS → 编码
async function burnWithLook(file, look, lines, outFile, ctx, range = [0.6, 1]) {
  const info = await probe(file);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vw-burn-'));
  try {
    const assFile = path.join(tmp, 'sub.ass');
    fs.writeFileSync(assFile, buildAss(look, lines, info));
    // 在临时目录里运行 ffmpeg、字幕文件用相对路径，避开 Windows 盘符路径的转义问题；字体目录是安装包自带的
    const assArg = 'ass=sub.ass' + (paths.fontsDir ? ':fontsdir=' + filterPath(paths.fontsDir) : '');
    const vf = [look.vf, assArg].filter(Boolean).join(',');
    const audio = info.hasAudio ? (info.audioCodec === 'aac' ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '192k']) : [];
    const partial = outFile + '.part.mp4';
    await ffmpeg(['-i', file, '-vf', vf, ...videoCodecArgs(), ...audio, '-movflags', '+faststart', partial], {
      duration: info.duration,
      signal: ctx.signal,
      cwd: tmp,
      onProgress: (p) => ctx.progress(range[0] + (range[1] - range[0]) * p, '烧录字幕'),
    });
    fs.renameSync(partial, outFile);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(outFile + '.part.mp4', { force: true });
  }
}

const handlers = {
  // 音频提取（原「转 MP3」）：从视频/音频里取出第一条音轨，转成指定格式，或原样复制
  async mp3(job, ctx) {
    const s = store.getSettings();
    const o = { format: 'mp3', bitrate: '128k', sampleRate: '', ...s.mp3, ...(job.input.opts || {}) };
    const { file } = job.input;
    const info = await probe(file);
    if (!info.hasAudio) throw new Error('这个文件没有音轨');
    const fmt = AUDIO_FORMATS[o.format] ? o.format : 'mp3';
    const ext = fmt === 'copy' ? COPY_EXT[info.audioCodec] || '.mka' : AUDIO_FORMATS[fmt].ext;
    const out = path.join(store.outDir('mp3'), baseName(file) + ext);
    if (path.resolve(out) === path.resolve(file)) throw new Error('输出和原文件是同一个文件，换一种格式或换输出目录');
    if (o.skipExisting && fs.existsSync(out)) return { file: out, skipped: true, inSize: fs.statSync(file).size, outSize: fs.statSync(out).size, format: fmt };
    const codec =
      fmt === 'copy'
        ? ['-c:a', 'copy']
        : [
            ...AUDIO_FORMATS[fmt].args(o.bitrate),
            ...(o.mono ? ['-ac', '1'] : []),
            ...(o.sampleRate ? ['-ar', String(o.sampleRate)] : []),
          ];
    const part = out + '.part' + ext;
    await ffmpeg(['-i', file, '-map', '0:a:0', '-vn', '-sn', '-dn', ...codec, ...(ext === '.m4a' ? ['-movflags', '+faststart'] : []), part], {
      duration: info.duration,
      signal: ctx.signal,
      onProgress: (p) => ctx.progress(p, fmt === 'copy' ? '复制音轨' : '提取中'),
    });
    fs.renameSync(part, out);
    const inSize = fs.statSync(file).size;
    const outSize = fs.statSync(out).size;
    if (o.deleteSource) await trashSource(file);
    return { file: out, inSize, outSize, format: fmt, duration: info.duration };
  },

  async text(job, ctx) {
    const s = store.getSettings();
    const { file } = job.input;
    const dir = store.outDir('text');
    const txt = path.join(dir, baseName(file) + '.txt');
    if (s.text.skipExisting && fs.existsSync(txt)) {
      const t = fs.readFileSync(txt, 'utf8');
      return { file: txt, chars: t.replace(/\s/g, '').length, skipped: true };
    }
    const segs = await transcribe(file, { signal: ctx.signal, onProgress: (p, st) => ctx.progress(p, st) });
    const text = toPlainText(segs);
    fs.writeFileSync(txt, text);
    let srt = null;
    if (s.text.exportSrt) {
      srt = path.join(dir, baseName(file) + '.srt');
      fs.writeFileSync(srt, toSrt(toSubtitleLines(segs, { maxChars: s.asr.maxChars || 14 })));
    }
    return { file: txt, srt, chars: text.replace(/\s/g, '').length };
  },

  async burn(job, ctx) {
    const s = store.getSettings();
    const { file, mode } = job.input;
    const look = resolveLook(job.input.look || {});
    const dir = store.outDir('burn');
    if (mode === 'srtOnly') {
      const lines = await getSubtitleLines(file, look, ctx, [0, 1]);
      const out = path.join(dir, baseName(file) + '.srt');
      fs.writeFileSync(out, toSrt(lines));
      return { file: out, lines: lines.length };
    }
    const out = outName(dir, file, s.output.suffix, '.mp4', ctx.seq);
    if (s.output.skipDone && fs.existsSync(out)) return { file: out, skipped: true };
    const lines = look.showSubs === false ? [] : await getSubtitleLines(file, look, ctx);
    await burnWithLook(file, look, lines, out, ctx, look.showSubs === false ? [0, 1] : [0.6, 1]);
    if (s.output.deleteSource) await trashSource(file);
    return { file: out, styleName: look.sub?.name, filter: look.vf ? '有' : '无' };
  },
};

module.exports = { handlers, getSubtitleLines, burnWithLook, resolveLook, videoCodecArgs, baseName };
