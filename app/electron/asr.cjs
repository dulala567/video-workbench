// 语音识别：ffmpeg 转 16k 单声道 wav → whisper-cli → 字幕段落；以及 SRT 读写、分句。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { paths } = require('./paths.cjs');
const { store } = require('./store.cjs');
const { ffmpeg, runProcess } = require('./ffmpeg.cjs');

const PROMPTS = {
  zh: '以下是普通话的句子，使用简体中文。',
};

// ---------- 快速识别：SenseVoice ----------
// 阿里开源的小型语音识别模型（约 230MB），不用显卡，在 CPU 上就比 whisper 快一到两个数量级，中文准确、自带标点和逐字时间。
// 只支持中文、英文、日文、韩文、粤语；其他语言、或者它没装好/出错时，退回 whisper。
const SV_LANGS = ['zh', 'en', 'ja', 'ko', 'yue'];
const SR = 16000;

function pickEngine(s) {
  if ((s.asr.engine || 'auto') === 'whisper') return 'whisper';
  if (!SV_LANGS.includes(s.asr.language || 'zh')) return 'whisper';
  return paths.sherpa() && paths.senseVoiceDir() ? 'sensevoice' : 'whisper';
}

// 模型一次最多处理 30 秒，长音频要切段。切在停顿处（切在字中间会识别错），每段 8~28 秒。
// 返回切点（采样点位置）。samples 是 16k 单声道 Int16Array。
function planCuts(samples, { minSec = 8, maxSec = 28 } = {}) {
  const FRAME = 320; // 20 毫秒
  const n = Math.floor(samples.length / FRAME);
  const maxF = maxSec * 50;
  if (n <= maxF) return [];
  const rms = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let j = i * FRAME, e = j + FRAME; j < e; j++) sum += samples[j] * samples[j];
    rms[i] = Math.sqrt(sum / FRAME);
  }
  // 安静的标准：底噪和说话音量之间靠近底噪的位置
  const sorted = Float32Array.from(rms).sort();
  const floor = sorted[Math.floor(n * 0.1)];
  const speech = sorted[Math.floor(n * 0.9)];
  const thr = floor + 0.15 * (speech - floor);
  const cuts = [];
  let start = 0;
  while (n - start > maxF) {
    const lo = start + minSec * 50;
    const hi = start + maxF;
    // 找这一段里最长的一处停顿，切在它中间
    let best = null;
    for (let i = lo; i < hi; ) {
      if (rms[i] > thr) {
        i++;
        continue;
      }
      let j = i;
      while (j < hi && rms[j] <= thr) j++;
      if (!best || j - i >= best.len) best = { at: Math.floor((i + j) / 2), len: j - i };
      i = j;
    }
    let cut;
    if (best && best.len >= 4) cut = best.at;
    else {
      // 没有像样的停顿（比如一直有背景音乐）：在靠后的位置找声音最小的一帧
      cut = hi - 1;
      for (let i = Math.floor(start + maxF * 0.7); i < hi; i++) if (rms[i] < rms[cut]) cut = i;
    }
    cuts.push(cut * FRAME);
    start = cut;
  }
  return cuts;
}

function wavHeader(dataBytes) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + dataBytes, 4);
  h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // 单声道
  h.writeUInt32LE(SR, 24);
  h.writeUInt32LE(SR * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(dataBytes, 40);
  return h;
}

// 一段的识别结果（逐字 + 时间）→ 和 whisper 逐词输出同样形状的片段
function svPieces(result, offsetSec, chunkSec) {
  const tokens = result.tokens || [];
  const ts = result.timestamps || [];
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const text = String(tokens[i]).replace(/▁/g, ' ');
    if (!text || /^<\|.*\|>$/.test(text)) continue;
    const start = ts[i] ?? (out.length ? out[out.length - 1].end - offsetSec : 0);
    const next = ts[i + 1] ?? Math.min(chunkSec, start + 0.3);
    out.push({ start: offsetSec + start, end: offsetSec + Math.max(start + 0.05, Math.min(next, start + 0.6)), text });
  }
  return out;
}

async function transcribeSenseVoice(file, tmp, s, { signal, onProgress } = {}) {
  const pcmFile = path.join(tmp, 'a.pcm');
  onProgress?.(0, '提取音频');
  await ffmpeg(['-i', file, '-vn', '-ac', '1', '-ar', String(SR), '-f', 's16le', '-c:a', 'pcm_s16le', pcmFile], { signal });
  const buf = fs.readFileSync(pcmFile);
  const samples = new Int16Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + (buf.length & ~1)));
  if (samples.length < SR * 0.2) return [];
  const bounds = [0, ...planCuts(samples), samples.length];
  const chunks = [];
  for (let i = 0; i + 1 < bounds.length; i++) {
    const name = `c${String(i).padStart(4, '0')}.wav`;
    const data = Buffer.from(samples.buffer, bounds[i] * 2, (bounds[i + 1] - bounds[i]) * 2);
    fs.writeFileSync(path.join(tmp, name), Buffer.concat([wavHeader(data.length), data]));
    chunks.push({ name, offset: bounds[i] / SR, dur: (bounds[i + 1] - bounds[i]) / SR });
  }

  // 识别程序在 Windows 上不一定认中文路径（软件常被放在中文文件夹里）。
  // 在临时目录里建一个指向模型文件夹的链接，工作目录设成临时目录，这样传给它的全是不带中文的相对路径。
  const link = path.join(tmp, 'm');
  fs.symlinkSync(paths.senseVoiceDir(), link, 'junction');
  try {
    const lang = s.asr.language || 'zh';
    const base = ['--sense-voice-model=m/model.int8.onnx', '--tokens=m/tokens.txt', `--num-threads=${Math.max(1, Math.min(8, s.asr.threads || 4))}`, '--sense-voice-use-itn=true', `--sense-voice-language=${lang}`];
    const pieces = [];
    const GROUP = 16; // 一次喂 16 段（约 5 分钟），好回报进度
    for (let g = 0; g < chunks.length; g += GROUP) {
      const part = chunks.slice(g, g + GROUP);
      onProgress?.(0.05 + 0.95 * (g / chunks.length), '识别语音');
      let out = '';
      let err = '';
      await runProcess(paths.sherpa(), [...base, ...part.map((c) => c.name)], { signal, cwd: tmp, onStdout: (t) => (out += t), onStderr: (t) => (err += t) });
      // 每个文件一行 JSON，顺序和传入的文件一致
      const results = (out + '\n' + err)
        .split(/\r?\n/)
        .filter((l) => l.startsWith('{') && l.includes('"timestamps"'))
        .map((l) => JSON.parse(l));
      if (results.length !== part.length) throw new Error(`快速识别返回 ${results.length} 段结果，应为 ${part.length} 段`);
      results.forEach((r, i) => pieces.push(...svPieces(r, part[i].offset, part[i].dur)));
    }
    return pieces;
  } finally {
    // 只删链接本身，不能连模型一起删
    try {
      if (process.platform === 'win32') fs.rmdirSync(link);
      else fs.unlinkSync(link);
    } catch {}
  }
}

async function transcribe(file, opts = {}) {
  const s = store.getSettings();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vw-asr-'));
  try {
    if (pickEngine(s) === 'sensevoice') {
      try {
        return await transcribeSenseVoice(file, tmp, s, opts);
      } catch (e) {
        if (opts.signal?.aborted) throw e;
        console.error('快速识别失败，改用 whisper：', e);
      }
    }
    return await transcribeWhisper(file, tmp, s, opts);
  } finally {
    // 链接还在的话先摘掉，再删临时目录（防止删到模型文件夹里去）
    const link = path.join(tmp, 'm');
    try {
      if (fs.lstatSync(link)) process.platform === 'win32' ? fs.rmdirSync(link) : fs.unlinkSync(link);
    } catch {}
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function transcribeWhisper(file, tmp, s, { signal, onProgress } = {}) {
  const model = store.whisperModel();
  if (!fs.existsSync(model)) throw new Error('识别模型不存在：' + model + '（设置里可以改路径）');
  const whisper = paths.whisper();
  if (!whisper) throw new Error('没找到 whisper-cli，请先 brew install whisper-cpp');

  {
    const wav = path.join(tmp, 'a.wav');
    onProgress?.(0, '提取音频');
    await ffmpeg(['-i', file, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav], { signal });
    const outBase = path.join(tmp, 'out');
    // whisper-cli 在 Windows 上读模型路径时不认中文（软件放在中文文件夹里就会崩溃），
    // 所以把工作目录切到模型所在的文件夹，只传模型文件名；音频从标准输入喂进去，不传路径。
    // -ml 1：逐词输出时间戳，后面按真实时间断句
    const args = ['-m', path.basename(model), '-f', '-', '-l', s.asr.language || 'zh', '-t', String(s.asr.threads || 8), '-ml', '1', '-oj', '-of', outBase, '-pp'];
    const prompt = PROMPTS[s.asr.language];
    if (prompt) args.push('--prompt', prompt);
    onProgress?.(0.05, '识别语音');
    try {
      await runProcess(whisper, args, {
        signal,
        cwd: path.dirname(model),
        stdinFile: wav,
        onStderr: (t) => {
          const m = t.match(/progress\s*=\s*(\d+)%/g);
          if (m) onProgress?.(0.05 + 0.95 * (Number(m[m.length - 1].match(/\d+/)[0]) / 100), '识别语音');
        },
      });
    } catch (e) {
      if (process.platform === 'win32' && /[^\x00-\x7f]/.test(path.basename(model) + outBase)) {
        e.message += '\n（识别模型的文件名或系统临时文件夹路径里有中文，识别程序可能不认；把模型文件名改成英文再试）';
      }
      throw e;
    }
    const j = JSON.parse(fs.readFileSync(outBase + '.json', 'utf8'));
    const zh = (s.asr.language || 'zh') === 'zh';
    return (j.transcription || [])
      .map((x) => ({ start: x.offsets.from / 1000, end: x.offsets.to / 1000, text: zh ? toZhPunct(x.text.trim()) : x.text.trim() }))
      .filter((x) => x.text && !/^\[.*\]$/.test(x.text) && !x.text.includes('�'));
  }
}

// ---------- 分句：把识别出来的长段落切成适合竖屏的短字幕 ----------
const STRONG = /[。！？!?；;…]/;
const WEAK = /[，,、：:]/;
const ALL_PUNCT = /[。！？!?；;…，,、：:“”"'‘’（）()《》\s]/g;

function visibleLen(s) {
  return [...s.replace(ALL_PUNCT, '')].length;
}

// 一段没有标点的长句该在哪几个字后面断开：尽量平均，且断在词边界上。
// 系统分词词典不全（比如会把「音频」拆成两个字），所以两个单字之间尽量不断，优先断在多字词前后。
const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
function wordBreaks(text, maxChars) {
  const len = [...text].length;
  if (len <= maxChars) return [];
  const segs = [...segmenter.segment(text)].map((x) => [...x.segment].length);
  const cands = [];
  let pos = 0;
  segs.forEach((n, i) => {
    if (i > 0) cands.push({ pos, good: n > 1 || segs[i - 1] > 1 });
    pos += n;
  });
  const lines = Math.ceil(len / maxChars);
  const out = [];
  let last = 0;
  for (let m = 1; m < lines; m++) {
    const ideal = (m * len) / lines;
    let best = null;
    for (const c of cands) {
      if (c.pos <= last || c.pos - last > maxChars || len - c.pos > (lines - m) * maxChars) continue;
      const score = Math.abs(c.pos - ideal) + (c.good ? 0 : 2);
      if (!best || score < best.score) best = { ...c, score };
    }
    const b = best ? best.pos : Math.round(ideal);
    out.push(b);
    last = b;
  }
  return out;
}

function splitText(text, maxChars) {
  // 先按句号类切，再按逗号类切，最后硬切
  const pieces = [];
  let cur = '';
  for (const ch of text) {
    cur += ch;
    if (STRONG.test(ch)) {
      pieces.push(cur);
      cur = '';
    }
  }
  if (cur) pieces.push(cur);
  const out = [];
  for (const p of pieces) {
    if (visibleLen(p) <= maxChars) {
      out.push(p);
      continue;
    }
    let buf = '';
    for (const ch of p) {
      buf += ch;
      if (WEAK.test(ch) && visibleLen(buf) >= 2) {
        out.push(buf);
        buf = '';
      }
    }
    if (buf) out.push(buf);
  }
  // 合并太短的，硬切太长的
  const merged = [];
  for (const p of out) {
    const last = merged[merged.length - 1];
    if (last && visibleLen(last) + visibleLen(p) <= maxChars && visibleLen(last) < maxChars / 2 && !STRONG.test(last.slice(-1))) {
      merged[merged.length - 1] = last + p;
    } else merged.push(p);
  }
  const final = [];
  for (const p of merged) {
    const chars = [...p];
    if (visibleLen(p) <= maxChars) {
      final.push(p);
      continue;
    }
    let from = 0;
    for (const b of wordBreaks(p, maxChars)) {
      final.push(chars.slice(from, b).join(''));
      from = b;
    }
    final.push(chars.slice(from).join(''));
  }
  return final.filter((x) => visibleLen(x) > 0);
}

function cleanLine(s, keepPunct) {
  if (keepPunct) return s.trim();
  return s
    .replace(/[。！？!?；;…，,、：:]+$/g, '')
    .replace(/[。；;，,、：:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// 识别结果里的半角标点换成中文标点（只换挨着中文的）
function toZhPunct(s) {
  const map = { ',': '，', '?': '？', '!': '！', ':': '：', ';': '；' };
  return s.replace(/([一-鿿])\s*([,?!:;])/g, (_m, a, p) => a + map[p]).replace(/^([,?!:;])/, (p) => map[p]);
}

/**
 * 把识别片段变成字幕行。
 * 输入可以是逐词片段（whisper -ml 1，时间准确），也可以是整句片段（现成 SRT）。
 * 1. 太长的整句先按标点/字数切开，时间按字数比例分；
 * 2. 再把小片段按真实时间拼成行：遇到标点就断、超过字数就断、停顿超过 0.6 秒也断。
 */
function toSubtitleLines(segments, { maxChars = 14, keepPunct = false } = {}) {
  const pieces = [];
  for (const seg of segments) {
    if (visibleLen(seg.text) <= maxChars) {
      pieces.push(seg);
      continue;
    }
    const parts = splitText(seg.text, maxChars);
    const total = parts.reduce((a, p) => a + Math.max(1, visibleLen(p)), 0);
    let t = seg.start;
    const dur = Math.max(0.2, seg.end - seg.start);
    for (const p of parts) {
      const d = (dur * Math.max(1, visibleLen(p))) / total;
      pieces.push({ start: t, end: t + d, text: p });
      t += d;
    }
  }

  // 超长的分句（到下一个标点为止）事先算好在哪几个片段前断：平均分、断在词边界
  const isEnd = (p) => STRONG.test(p.text.trim().slice(-1)) || WEAK.test(p.text.trim().slice(-1));
  const breakBefore = new Array(pieces.length).fill(false);
  for (let i = 0; i < pieces.length; ) {
    let j = i;
    const offsets = [];
    let text = '';
    while (j < pieces.length) {
      offsets.push(visibleLen(text));
      text += pieces[j].text.replace(ALL_PUNCT, '');
      if (isEnd(pieces[j++])) break;
    }
    for (const b of wordBreaks(text, maxChars)) {
      // 找起点离断点最近的片段
      let bestK = -1;
      offsets.forEach((o, k) => {
        if (k > 0 && (bestK < 0 || Math.abs(o - b) < Math.abs(offsets[bestK] - b))) bestK = k;
      });
      if (bestK > 0) breakBefore[i + bestK] = true;
    }
    i = j;
  }

  const raw = [];
  let cur = null;
  const flush = () => {
    if (cur && visibleLen(cur.text) > 0) raw.push(cur);
    cur = null;
  };
  pieces.forEach((p, i) => {
    const onlyPunct = visibleLen(p.text) === 0;
    if (cur && !onlyPunct && (breakBefore[i] || visibleLen(cur.text + p.text) > maxChars + 2 || p.start - cur.end > 0.6)) flush();
    if (!cur) cur = { start: p.start, end: p.end, text: '' };
    cur.text += p.text;
    cur.end = Math.max(cur.end, p.end);
    if (isEnd(p)) flush();
  });
  flush();

  // 只有一两个字的行，和下一行合得下就合并
  const merged = [];
  for (let i = 0; i < raw.length; i++) {
    const l = raw[i];
    const next = raw[i + 1];
    if (next && visibleLen(l.text) <= 2 && visibleLen(l.text + next.text) <= maxChars && next.start - l.end < 0.4) {
      raw[i + 1] = { start: l.start, end: next.end, text: l.text + next.text };
      continue;
    }
    merged.push(l);
  }

  // 行与行之间的短空隙补上，字幕不闪
  const lines = [];
  merged.forEach((l, i) => {
    const next = merged[i + 1];
    let end = l.end;
    if (next && next.start - end < 0.5) end = next.start;
    if (end - l.start < 0.3) end = l.start + 0.3;
    const text = cleanLine(l.text, keepPunct);
    if (text) lines.push({ start: l.start, end, text });
  });
  return lines;
}

// 逐词片段 → 按句分行的纯文本（转文字导出用）
function toPlainText(segments) {
  let out = '';
  for (const s of segments) {
    out += s.text;
    if (STRONG.test(s.text.trim().slice(-1))) out += '\n';
  }
  return out.replace(/\n+$/, '').trim();
}

// ---------- SRT ----------
function fmtSrtTime(t) {
  const ms = Math.round(t * 1000);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const r = ms % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(r).padStart(3, '0')}`;
}
function toSrt(lines) {
  return lines.map((l, i) => `${i + 1}\n${fmtSrtTime(l.start)} --> ${fmtSrtTime(l.end)}\n${l.text}\n`).join('\n');
}
function parseSrt(text) {
  const toSec = (s) => {
    const m = s.trim().match(/(\d+):(\d+):(\d+)[,.](\d+)/);
    return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000 : 0;
  };
  return text
    .replace(/\r/g, '')
    .split(/\n\s*\n/)
    .map((block) => {
      const ls = block.trim().split('\n');
      const ti = ls.findIndex((l) => l.includes('-->'));
      if (ti < 0) return null;
      const [a, b] = ls[ti].split('-->');
      return { start: toSec(a), end: toSec(b), text: ls.slice(ti + 1).join(' ').trim() };
    })
    .filter((x) => x && x.text);
}

module.exports = { transcribe, toSubtitleLines, toSrt, parseSrt, toPlainText, pickEngine, planCuts };
