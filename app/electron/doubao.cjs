// 豆包语音合成 2.0（火山引擎 openspeech，新版控制台 API Key 鉴权）。
// 接口：POST https://openspeech.bytedance.com/api/v3/tts/unidirectional，HTTP Chunked，每行一个 JSON：
//   { code: 0, data: <base64 音频> } … { code: 0, sentence: { text, words: [{ word, startTime, endTime }] } } … { code: 20000000, message: 'OK' }
// 长文案按句切成多段分别合成，再用 ffmpeg 拼接，逐字时间戳按每段实际时长平移。
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const { app } = require('electron');
const { store } = require('./store.cjs');
const { probe, ffmpeg } = require('./ffmpeg.cjs');
const { toSubtitleLines, toSrt } = require('./asr.cjs');

const URL_TTS = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional';
const MAX_CHARS = 280; // 每次请求的文字上限（按句切，留余量）

const getKey = () => store.getSecret('doubaoKey');

// 复刻音色（控制台里训练出的 S_ 开头 ID）走声音复刻 2.0 资源
const resourceOf = (speaker) => (/^S_/i.test(speaker) ? 'seed-icl-2.0' : 'seed-tts-2.0');

const ERRORS = {
  45000030: '这个 API Key 没开通对应的服务（在火山引擎控制台开通「豆包语音合成模型 2.0」）',
  45000010: 'API Key 无效或已删除',
  55000000: '音色和服务不匹配（复刻音色 ID 要以 S_ 开头，并确认已开通声音复刻 2.0）',
};

async function synthesizeOnce(text, opt, signal) {
  const key = getKey();
  if (!key) throw new Error('还没有设置豆包 API Key（AI 配音页右上角或设置里填写）');
  const additions = {};
  if (opt.instruction) additions.context_texts = [opt.instruction];
  if (opt.silence) additions.silence_duration = opt.silence;
  if (opt.pitch) additions.post_process = { pitch: opt.pitch };
  const body = {
    user: { uid: 'video-workbench' },
    req_params: {
      text,
      speaker: opt.speaker,
      audio_params: {
        format: 'mp3',
        sample_rate: 24000,
        bit_rate: 160000,
        speech_rate: opt.speed || 0,
        loudness_rate: opt.volume || 0,
        enable_subtitle: true,
      },
      ...(Object.keys(additions).length ? { additions: JSON.stringify(additions) } : {}),
    },
  };
  const res = await fetch(URL_TTS, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': key,
      'X-Api-Resource-Id': resourceOf(opt.speaker),
      'X-Api-Request-Id': crypto.randomUUID(),
    },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  const audio = [];
  const words = [];
  let finalCode = null;
  let errMsg = '';
  for (const line of raw.split(/\n+/)) {
    const t = line.trim();
    if (!t) continue;
    let j;
    try {
      j = JSON.parse(t);
    } catch {
      continue;
    }
    // 鉴权类错误的返回格式：{ header: { code, message } }
    const code = j.code ?? j.header?.code;
    if (j.data) audio.push(Buffer.from(j.data, 'base64'));
    for (const w of j.sentence?.words || []) words.push({ start: w.startTime, end: w.endTime, text: w.word });
    if (code === 20000000) finalCode = code;
    else if (code && code !== 0) {
      finalCode = code;
      errMsg = j.message || j.header?.message || '';
    }
  }
  if (finalCode !== 20000000 || !audio.length) {
    const hint = ERRORS[finalCode] || errMsg || `HTTP ${res.status}`;
    throw new Error(`豆包合成失败：${hint}${finalCode ? `（错误码 ${finalCode}）` : ''}`);
  }
  return { audio: Buffer.concat(audio), words };
}

// 按句切成不超过 MAX_CHARS 的段
function splitForTts(text) {
  const sentences = String(text).replace(/\r/g, '').split(/(?<=[。！？!?；;…\n])/);
  const out = [];
  let cur = '';
  for (const s of sentences) {
    if ((cur + s).length > MAX_CHARS && cur) {
      out.push(cur);
      cur = '';
    }
    if (s.length > MAX_CHARS) {
      for (let i = 0; i < s.length; i += MAX_CHARS) out.push(s.slice(i, i + MAX_CHARS));
    } else cur += s;
  }
  if (cur.trim()) out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

async function synthesizeToFile(text, opt, outFile, { signal, onProgress } = {}) {
  const parts = splitForTts(text);
  if (!parts.length) throw new Error('文案是空的');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vw-tts-'));
  try {
    const files = [];
    const allWords = [];
    let offset = 0;
    for (let i = 0; i < parts.length; i++) {
      onProgress?.(i / parts.length, `合成第 ${i + 1}/${parts.length} 段`);
      const { audio, words } = await synthesizeOnce(parts[i], opt, signal);
      const f = path.join(tmp, `p${i}.mp3`);
      fs.writeFileSync(f, audio);
      const dur = (await probe(f)).duration;
      for (const w of words) allWords.push({ start: w.start + offset, end: w.end + offset, text: w.text });
      offset += dur;
      files.push(f);
    }
    onProgress?.(0.95, '拼接音频');
    if (files.length === 1) fs.copyFileSync(files[0], outFile);
    else {
      const list = path.join(tmp, 'list.txt');
      fs.writeFileSync(list, files.map((f) => `file '${f}'`).join('\n'));
      await ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', outFile], { signal });
    }
    return { words: allWords, duration: offset };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------- 豆包音频生成模型 1.0（seed-audio-1.0）----------
// 接口：POST https://openspeech.bytedance.com/api/v3/tts/create，非流式，一次返回整段音频（base64）+ 逐字字幕。
// 一段提示词里可以同时写对白、情绪、配乐、音效；单条最长 120 秒，按生成时长计费（官方价 1 元/分钟）。
// 参考资源最多 3 条音频（音色 ID / 音频文件，提示词里用 @音频1、@音频2 引用），或 1 张图片（不能和音频混用）。
const URL_GEN = 'https://openspeech.bytedance.com/api/v3/tts/create';
const GEN_MODEL = 'seed-audio-1.0';
const GEN_MAX_CHARS = 3000;

// 生成可能要几分钟，Node 自带 fetch 有 300 秒等响应头的上限，这里直接用 https 不设超时
function postJson(url, headers, body, signal) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {}
        resolve({ status: res.statusCode, json, text, logid: res.headers['x-tt-logid'] });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    if (signal) {
      if (signal.aborted) return req.destroy(new Error('已停止'));
      signal.addEventListener('abort', () => req.destroy(new Error('已停止')), { once: true });
    }
    req.end(JSON.stringify(body));
  });
}

// 参考音频：统一转成 30 秒以内的单声道 mp3（接口要求单条 ≤30 秒、≤10MB，格式 wav/mp3/pcm/ogg_opus）
async function refAudioData(file, signal) {
  const tmp = path.join(os.tmpdir(), `vw-ref-${crypto.randomUUID()}.mp3`);
  try {
    await ffmpeg(['-i', file, '-t', '30', '-vn', '-ac', '1', '-ar', '24000', '-c:a', 'libmp3lame', '-b:a', '96k', tmp], { signal });
    return fs.readFileSync(tmp).toString('base64');
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

// 参考图片：jpeg/png/webp 且 ≤10MB 直接用，否则转成 jpg
async function refImageData(file, signal) {
  const ext = path.extname(file).slice(1).toLowerCase();
  if (['jpg', 'jpeg', 'png', 'webp'].includes(ext) && fs.statSync(file).size <= 9.5 * 1024 * 1024) return fs.readFileSync(file).toString('base64');
  const tmp = path.join(os.tmpdir(), `vw-ref-${crypto.randomUUID()}.jpg`);
  try {
    await ffmpeg(['-i', file, '-frames:v', '1', '-vf', "scale='min(2048,iw)':-2", '-q:v', '3', tmp], { signal });
    return fs.readFileSync(tmp).toString('base64');
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

const GEN_ERRORS = {
  45000030: '这个 API Key 没开通「豆包音频生成模型 1.0」',
  45000010: 'API Key 无效或已删除',
  45001116: '提示词不能为空',
};

async function generateAudio(input, { signal, onProgress } = {}) {
  const key = getKey();
  if (!key) throw new Error('还没有设置豆包 API Key');
  const prompt = String(input.text || '').trim();
  if (!prompt) throw new Error('提示词是空的');
  if (prompt.length > GEN_MAX_CHARS) throw new Error(`提示词最多 ${GEN_MAX_CHARS} 字，现在 ${prompt.length} 字`);
  const refs = input.refs || [];
  if (refs.some((r) => r.type === 'image') && refs.some((r) => r.type !== 'image')) throw new Error('参考图片不能和参考音频/音色一起用');
  if (refs.filter((r) => r.type !== 'image').length > 3) throw new Error('参考音频最多 3 条');

  onProgress?.(0.02, '准备参考素材');
  const references = [];
  for (const r of refs) {
    if (r.type === 'voice') references.push({ speaker: r.id });
    else if (r.type === 'audio') references.push({ audio_data: await refAudioData(r.file, signal) });
    else if (r.type === 'image') references.push({ image_data: await refImageData(r.file, signal) });
  }
  const body = {
    model: GEN_MODEL,
    text_prompt: prompt,
    ...(references.length ? { references } : {}),
    audio_config: {
      format: 'mp3',
      sample_rate: 44100,
      speech_rate: input.speed || 0,
      loudness_rate: input.volume || 0,
      pitch_rate: input.pitch || 0,
      enable_subtitle: true,
    },
  };

  // 接口不返回进度：按「已等待时间」慢慢往前走，给个大概
  const t0 = Date.now();
  const timer = setInterval(() => {
    const sec = (Date.now() - t0) / 1000;
    onProgress?.(0.08 + 0.85 * (1 - Math.exp(-sec / 45)), `生成中 ${Math.round(sec)} 秒`);
  }, 1000);
  let r;
  try {
    r = await postJson(URL_GEN, { 'X-Api-Key': key, 'X-Api-Request-Id': crypto.randomUUID() }, body, signal);
  } finally {
    clearInterval(timer);
  }
  const j = r.json || {};
  if (r.status !== 200 || !j.audio) {
    const code = j.code ?? j.header?.code;
    const hint = GEN_ERRORS[code] || j.message || j.header?.message || r.text.slice(0, 200) || `HTTP ${r.status}`;
    throw new Error(`豆包音频生成失败：${hint}${code ? `（错误码 ${code}）` : ''}${r.logid ? ` [logid ${r.logid}]` : ''}`);
  }
  const words = [];
  for (const s of j.subtitle?.sentences || []) {
    for (const w of s.words || []) words.push({ start: w.start_time / 1000, end: w.end_time / 1000, text: w.text });
  }
  words.sort((a, b) => a.start - b.start);
  return { audio: Buffer.from(j.audio, 'base64'), words, speech: j.subtitle?.text || '', duration: j.original_duration ?? j.duration ?? 0 };
}

// 配音任务：文案 → mp3 + 同名 .srt + .words.json（数字人/字幕烧录会优先用它，不再走识别）
const safeName = (s) => [...String(s).replace(/[\\/:*?"<>|\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim()].slice(0, 30).join('') || '配音';

function uniqueBase(dir, name) {
  let base = path.join(dir, safeName(name));
  if (fs.existsSync(base + '.mp3')) base += '_' + Date.now().toString(36).slice(-4);
  return base;
}

async function handler(job, ctx) {
  const { text, name, voice } = job.input;
  const dir = store.outDir('tts');
  const s = store.getSettings();
  const progress = (p, st) => ctx.progress(p, st);

  if (job.input.mode === 'audio') {
    const g = await generateAudio(job.input, { signal: ctx.signal, onProgress: progress });
    // 文件名优先用生成出来的台词（提示词开头往往是场景描述）
    const base = uniqueBase(dir, name || g.speech.replace(/\s+/g, '').slice(0, 16) || text.replace(/\s+/g, '').slice(0, 16));
    const out = base + '.mp3';
    fs.writeFileSync(out + '.part', g.audio);
    fs.renameSync(out + '.part', out);
    let srt = null;
    if (g.words.length) {
      fs.writeFileSync(base + '.words.json', JSON.stringify({ text: g.speech, voice, words: g.words }, null, 0));
      srt = base + '.srt';
      fs.writeFileSync(srt, toSrt(toSubtitleLines(g.words, { maxChars: s.asr.maxChars || 14 })));
    }
    return { file: out, srt, duration: g.duration, chars: text.length, speech: g.speech };
  }

  const base = uniqueBase(dir, name || text.slice(0, 16));
  const out = base + '.mp3';
  const { words, duration } = await synthesizeToFile(text, job.input, out, { signal: ctx.signal, onProgress: progress });
  fs.writeFileSync(base + '.words.json', JSON.stringify({ text, voice, words }, null, 0));
  fs.writeFileSync(base + '.srt', toSrt(toSubtitleLines(words, { maxChars: s.asr.maxChars || 14 })));
  return { file: out, srt: base + '.srt', duration, chars: text.length };
}

// 试听：每个音色一段固定短句，缓存起来不重复花钱
async function sample(speaker, name) {
  const dir = path.join(app.getPath('userData'), 'voice-samples');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, speaker.replace(/[^\w-]/g, '_') + '.mp3');
  if (!fs.existsSync(f)) {
    const { audio } = await synthesizeOnce(`你好，我是${name || '你的配音员'}，很高兴为你的视频配音。`, { speaker }, undefined);
    fs.writeFileSync(f, audio);
  }
  return f;
}

async function preview(text, opt) {
  const f = path.join(os.tmpdir(), `vw-tts-preview-${Date.now()}.mp3`);
  const { audio } = await synthesizeOnce(String(text).slice(0, 120), opt, undefined);
  fs.writeFileSync(f, audio);
  return f;
}

async function testKey(key) {
  const old = getKey();
  if (key) store.setSecret('doubaoKey', key);
  try {
    await synthesizeOnce('测试', { speaker: 'zh_female_vv_uranus_bigtts' });
    return { ok: true };
  } catch (e) {
    if (key) store.setSecret('doubaoKey', old || ''); // 新 Key 不能用就恢复原来的
    return { ok: false, error: String(e.message || e) };
  }
}

module.exports = { handler, sample, preview, testKey, synthesizeToFile, splitForTts, generateAudio, GEN_MAX_CHARS, hasKey: () => !!getKey() };
