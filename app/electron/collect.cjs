// 采集中心：解析快手分享链接 → 取视频直链 → 下载。
// 用独立的持久会话（persist:kuaishou）请求，用户在「打开快手」窗口里登录/验证后，cookie 会自动带上。
// 遇到登录或验证页面不会绕过，只提示用户自己去窗口里完成。
const fs = require('fs');
const path = require('path');
const { session, BrowserWindow } = require('electron');
const { store } = require('./store.cjs');
const { probe } = require('./ffmpeg.cjs');

const PARTITION = 'persist:kuaishou';
const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const KS_HOST = /(^|\.)(kuaishou\.com|kuaishou\.cn|gifshow\.com|chenzhongtech\.com|kwai\.com)$/i;

const ses = () => session.fromPartition(PARTITION);

// 从一段分享文案里找出所有快手链接
function parseLinks(text) {
  const out = [];
  for (const m of String(text).matchAll(/https?:\/\/[^\s"'<>，。！？、]+/g)) {
    let u = m[0].replace(/[)）\]】]+$/, '');
    try {
      if (KS_HOST.test(new URL(u).hostname) && !out.includes(u)) out.push(u);
    } catch {}
  }
  return out;
}

// 在 INIT_STATE 里找带 mainMvUrls 的 photo 对象
function findPhoto(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 8) return null;
  if (obj.photo && typeof obj.photo === 'object' && (obj.photo.mainMvUrls || obj.photo.photoType)) return obj.photo;
  if (Array.isArray(obj.mainMvUrls) && obj.photoId) return obj;
  for (const v of Object.values(obj)) {
    const r = findPhoto(v, depth + 1);
    if (r) return r;
  }
  return null;
}

async function resolve(url, signal) {
  const res = await ses().fetch(url, { headers: { 'User-Agent': MOBILE_UA, 'Accept-Language': 'zh-CN,zh;q=0.9' }, signal, redirect: 'follow' });
  if (!res.ok) throw new Error(`打开分享页失败（HTTP ${res.status}）`);
  const html = await res.text();
  const m = html.match(/window\.INIT_STATE\s*=\s*(\{[\s\S]*?\})\s*<\/script>/);
  let photo = null;
  if (m) {
    try {
      photo = findPhoto(JSON.parse(m[1]));
    } catch {}
  }
  if (!photo) {
    if (/captcha|verify|验证|登录|login/i.test(html)) throw new Error('快手要求登录或验证：点「打开快手」在窗口里完成后，再重试这条');
    throw new Error('没在分享页里找到视频信息（链接可能失效，或作品已删除/设为私密）');
  }
  const urls = (photo.mainMvUrls || []).map((x) => x.url).filter(Boolean);
  if (!urls.length) {
    if (photo.ext_params?.atlas || /ATLAS|IMAGE/i.test(photo.photoType || '')) throw new Error('这是图集作品，不是视频，暂不支持');
    throw new Error('这个作品没有可下载的视频地址');
  }
  return {
    urls,
    caption: String(photo.caption || '').trim(),
    author: String(photo.userName || '').trim(),
    photoId: String(photo.photoId || ''),
    duration: Number(photo.duration || 0) / 1000,
  };
}

function safeName(s, max = 40) {
  return [...String(s).replace(/#\S+/g, '').replace(/[\\/:*?"<>|\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim()].slice(0, max).join('') || '未命名';
}

async function download(urls, file, signal, onProgress) {
  let lastErr;
  for (const u of urls) {
    // 多个 CDN 逐个试
    try {
      const res = await ses().fetch(u, { headers: { 'User-Agent': MOBILE_UA, Referer: 'https://v.m.chenzhongtech.com/' }, signal });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const total = Number(res.headers.get('content-length') || 0);
      const part = file + '.part';
      const out = fs.createWriteStream(part);
      let got = 0;
      const reader = res.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          got += value.length;
          if (!out.write(Buffer.from(value))) await new Promise((r) => out.once('drain', r));
          if (total) onProgress(got / total);
        }
      } finally {
        await new Promise((r) => out.end(r));
      }
      if (got < 1024) throw new Error('下载到的文件太小');
      fs.renameSync(part, file);
      return got;
    } catch (e) {
      fs.rmSync(file + '.part', { force: true });
      if (signal?.aborted) throw e;
      lastErr = e;
    }
  }
  throw new Error('视频下载失败：' + (lastErr?.message || '所有地址都不可用'));
}

async function handler(job, ctx) {
  const s = store.getSettings();
  const { url } = job.input;
  ctx.progress(0.02, '解析链接');
  const info = await resolve(url, ctx.signal);
  const dir = store.outDir('collect');
  const base = `${safeName(info.author, 16)}_${safeName(info.caption)}_${info.photoId.slice(-6) || Date.now()}`;
  const file = path.join(dir, base + '.mp4');
  if (fs.existsSync(file)) {
    return { file, title: info.caption, author: info.author, skipped: true };
  }
  ctx.progress(0.05, '下载视频');
  const size = await download(info.urls, file, ctx.signal, (p) => ctx.progress(0.05 + 0.95 * p, '下载视频'));
  // 文案另存一份，方便二创时参考
  if (info.caption) fs.writeFileSync(path.join(dir, base + '.txt'), `作者：${info.author}\n链接：${url}\n\n${info.caption}\n`);

  if (job.input.autoBurn ?? s.collect.autoBurn) {
    let meta = {};
    try {
      const p = await probe(file);
      meta = { width: p.width, height: p.height, duration: p.duration, size: p.size };
    } catch {}
    ctx.enqueue('burn', [{ file, mode: 'burn', look: job.input.look, meta }], true);
  }
  return { file, title: info.caption, author: info.author, size };
}

// 让用户自己在快手页面里登录或完成验证（同一个会话，cookie 会保留）
let loginWin = null;
function openLoginWindow(parent) {
  if (loginWin && !loginWin.isDestroyed()) {
    loginWin.focus();
    return;
  }
  loginWin = new BrowserWindow({
    width: 1100,
    height: 820,
    parent,
    title: '快手（在这里登录或完成验证，完成后关闭窗口）',
    webPreferences: { partition: PARTITION, contextIsolation: true, sandbox: true },
  });
  loginWin.loadURL('https://www.kuaishou.com/');
  loginWin.on('closed', () => (loginWin = null));
}

async function clearSession() {
  await ses().clearStorageData();
}

module.exports = { handler, parseLinks, openLoginWindow, clearSession };
