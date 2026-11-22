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

async function transcribe(file, { signal, onProgress } = {}) {
  const s = store.getSettings();
  const model = store.whisperModel();
  if (!fs.existsSync(model)) throw new Error('识别模型不存在：' + model + '（设置里可以改路径）');
  const whisper = paths.whisper();
  if (!whisper) throw new Error('没找到 whisper-cli，请先 brew install whisper-cpp');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vw-asr-'));
  try {
    const wav = path.join(tmp, 'a.wav');
    onProgress?.(0, '提取音频');
    await ffmpeg(['-i', file, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav], { signal });
    const outBase = path.join(tmp, 'out');
    // -ml 1：逐词输出时间戳，后面按真实时间断句
    const args = ['-m', model, '-f', wav, '-l', s.asr.language || 'zh', '-t', String(s.asr.threads || 8), '-ml', '1', '-oj', '-of', outBase, '-pp'];
    const prompt = PROMPTS[s.asr.language];
    if (prompt) args.push('--prompt', prompt);
    onProgress?.(0.05, '识别语音');
    await runProcess(whisper, args, {
      signal,
      onStderr: (t) => {
        const m = t.match(/progress\s*=\s*(\d+)%/g);
        if (m) onProgress?.(0.05 + 0.95 * (Number(m[m.length - 1].match(/\d+/)[0]) / 100), '识别语音');
      },
    });
    const j = JSON.parse(fs.readFileSync(outBase + '.json', 'utf8'));
    const zh = (s.asr.language || 'zh') === 'zh';
    return (j.transcription || [])
      .map((x) => ({ start: x.offsets.from / 1000, end: x.offsets.to / 1000, text: zh ? toZhPunct(x.text.trim()) : x.text.trim() }))
      .filter((x) => x.text && !/^\[.*\]$/.test(x.text) && !x.text.includes('�'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
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

module.exports = { transcribe, toSubtitleLines, toSrt, parseSrt, toPlainText };
