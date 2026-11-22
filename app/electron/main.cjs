const { app, BrowserWindow, ipcMain, dialog, shell, protocol, net } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { paths } = require('./paths.cjs');
const { store } = require('./store.cjs');
const { Queue } = require('./queue.cjs');
const { handlers } = require('./jobs.cjs');
const { ffmpeg, probe, detectHwEncoder } = require('./ffmpeg.cjs');
const lipsync = require('./lipsync.cjs');
const collect = require('./collect.cjs');
const vcat = require('./vcat.cjs');
const doubao = require('./doubao.cjs');
const selftest = require('./selftest.cjs');

app.setName('视频工作台');
// 自检模式用单独的数据目录，不碰真实的设置和任务
if (process.argv.includes('--self-test')) {
  const out = path.resolve(process.argv[process.argv.indexOf('--self-test') + 1] || 'selftest-out');
  app.setPath('userData', path.join(out, 'userdata'));
}
protocol.registerSchemesAsPrivileged([
  { scheme: 'media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true } },
]);

let win;
const send = (ch, data) => win && !win.isDestroyed() && win.webContents.send(ch, data);

const queue = new Queue({
  handlers: { ...handlers, lipsync: lipsync.handler, collect: collect.handler, publish: vcat.handler, tts: doubao.handler },
  concurrencyOf: (kind) => {
    const s = store.getSettings();
    return { burn: s.encode.burnConcurrency, text: s.asr.concurrency, mp3: 3, lipsync: s.lipsync.concurrency, collect: s.collect.concurrency, publish: 1, tts: 2 }[kind] || 1;
  },
  onChange: (snap) => send('jobs:update', snap),
});

const VIDEO_EXT = ['mp4', 'mov', 'm4v', 'mkv', 'avi', 'webm', 'flv'];
const AUDIO_EXT = ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg'];
const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'webp'];
const EXT_GROUPS = { video: VIDEO_EXT, audio: AUDIO_EXT, media: [...VIDEO_EXT, ...AUDIO_EXT], image: IMAGE_EXT, avatar: [...VIDEO_EXT, ...IMAGE_EXT] };

function listMedia(dir, exts, depth = 0) {
  let out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name.startsWith('.')) continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory() && depth < 3) out = out.concat(listMedia(p, exts, depth + 1));
    else if (exts.includes(path.extname(ent.name).slice(1).toLowerCase())) out.push(p);
  }
  return out.sort((a, b) => a.localeCompare(b, 'zh'));
}

// 视频首帧缩略图（缓存）
const thumbDir = () => {
  const d = path.join(app.getPath('userData'), 'thumbs');
  fs.mkdirSync(d, { recursive: true });
  return d;
};
async function thumbnail(file, at = 0.5) {
  if (IMAGE_EXT.includes(path.extname(file).slice(1).toLowerCase())) return file;
  const st = fs.statSync(file);
  const key = crypto.createHash('md5').update(file + st.mtimeMs + at).digest('hex');
  const out = path.join(thumbDir(), key + '.jpg');
  if (!fs.existsSync(out)) {
    const info = await probe(file);
    const t = Math.min(at, Math.max(0, info.duration - 0.1));
    await ffmpeg(['-ss', String(t), '-i', file, '-frames:v', '1', '-vf', 'scale=540:-2', '-q:v', '4', out]);
  }
  return out;
}

async function checkEnv() {
  const s = store.getSettings();
  const ff = paths.ffmpeg();
  const hw = await detectHwEncoder();
  let disk = null;
  try {
    fs.mkdirSync(s.outRoot, { recursive: true });
    const st = fs.statfsSync(s.outRoot);
    disk = st.bavail * st.bsize;
  } catch {}
  const model = store.whisperModel();
  return {
    ffmpeg: !!ff,
    gpuEncode: !!hw,
    gpuEncodeName: hw?.label || '',
    platform: process.platform,
    whisper: !!paths.whisper(),
    whisperModel: fs.existsSync(model),
    whisperModelPath: model,
    lipsync: lipsync.status(),
    gpu: await lipsync.detectGpu(),
    disk,
    chip: os.cpus()[0]?.model || '',
    memGB: Math.round(os.totalmem() / 1024 ** 3),
  };
}

function registerIpc() {
  ipcMain.handle('settings:get', () => store.getSettings());
  ipcMain.handle('settings:save', (_e, s) => store.saveSettings(s));
  ipcMain.handle('settings:dirOf', (_e, kind) => store.outDir(kind));
  ipcMain.handle('env:check', () => checkEnv());
  ipcMain.handle('stats:get', () => store.getStats());

  ipcMain.handle('dialog:open', async (_e, { group = 'video', dir = false, multi = true } = {}) => {
    const r = await dialog.showOpenDialog(win, {
      properties: dir ? ['openDirectory'] : ['openFile', ...(multi ? ['multiSelections'] : [])],
      filters: dir ? [] : [{ name: '媒体文件', extensions: EXT_GROUPS[group] }],
    });
    if (r.canceled) return [];
    if (dir) return { dir: r.filePaths[0], files: listMedia(r.filePaths[0], EXT_GROUPS[group]) };
    return r.filePaths;
  });
  ipcMain.handle('dialog:pickDir', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('fs:expand', (_e, { items, group }) => {
    // 拖进来的文件/文件夹 → 展开成媒体文件列表
    const exts = EXT_GROUPS[group];
    let out = [];
    for (const p of items) {
      try {
        if (fs.statSync(p).isDirectory()) out = out.concat(listMedia(p, exts));
        else if (exts.includes(path.extname(p).slice(1).toLowerCase())) out.push(p);
      } catch {}
    }
    return out;
  });
  ipcMain.handle('media:probe', (_e, f) => probe(f));
  ipcMain.handle('media:thumb', (_e, f, at) => thumbnail(f, at));
  ipcMain.handle('media:size', (_e, f) => {
    try {
      return fs.statSync(f).size;
    } catch {
      return 0;
    }
  });
  ipcMain.handle('fs:readText', (_e, p) => {
    // 只读本应用产生的文字结果（txt/srt），限制在 1MB 以内
    if (!/\.(txt|srt)$/i.test(p)) throw new Error('只能读取文本结果');
    const st = fs.statSync(p);
    if (st.size > 1024 * 1024) throw new Error('文件太大');
    return fs.readFileSync(p, 'utf8');
  });
  ipcMain.handle('shell:open', (_e, p) => shell.openPath(p));
  ipcMain.handle('shell:show', (_e, p) => shell.showItemInFolder(p));
  ipcMain.handle('shell:openExternal', (_e, u) => /^https?:\/\//.test(u) && shell.openExternal(u));

  ipcMain.handle('jobs:snapshot', () => queue.snapshot());
  ipcMain.handle('jobs:add', (_e, kind, items) => queue.add(kind, items));
  ipcMain.handle('jobs:start', (_e, kind) => queue.start(kind));
  ipcMain.handle('jobs:pause', (_e, kind) => queue.pause(kind));
  ipcMain.handle('jobs:stop', (_e, kind) => queue.stop(kind));
  ipcMain.handle('jobs:retry', (_e, ids) => queue.retry(ids));
  ipcMain.handle('jobs:remove', (_e, ids) => queue.remove(ids));
  ipcMain.handle('jobs:clear', (_e, kind, which) => queue.clear(kind, which));
  ipcMain.handle('jobs:updateInputs', (_e, ids, patch) => queue.updateInputs(ids, patch));

  ipcMain.handle('styles:get', () => store.getStyles());
  ipcMain.handle('styles:save', (_e, v) => store.saveStyles(v));

  // 采集中心
  ipcMain.handle('collect:parse', (_e, text) => collect.parseLinks(text));
  ipcMain.handle('collect:login', () => collect.openLoginWindow(win));
  ipcMain.handle('collect:clearSession', () => collect.clearSession());

  // 发布到账号（小V猫 MCP）
  ipcMain.handle('vcat:hasToken', () => !!store.getSecret('vcatToken'));
  ipcMain.handle('vcat:connect', async (_e, { port, token, remember }) => {
    const t = token || store.getSecret('vcatToken');
    const r = await vcat.connect({ port, token: t });
    if (token && remember) store.setSecret('vcatToken', token);
    const s = store.getSettings();
    store.saveSettings({ ...s, publish: { ...s.publish, port: Number(port) || 3199 } });
    return r;
  });
  ipcMain.handle('vcat:forgetToken', () => store.setSecret('vcatToken', ''));
  ipcMain.handle('vcat:disconnect', () => vcat.disconnect());
  ipcMain.handle('vcat:status', () => vcat.describe());
  ipcMain.handle('vcat:accounts', (_e, tool, args) => vcat.listAccounts(tool, args));
  ipcMain.handle('vcat:autoMapping', (_e, toolName) => vcat.autoMapping(vcat.describe().tools?.find((t) => t.name === toolName)));
  ipcMain.handle('publish:draft', () => store.getPublishDraft());
  ipcMain.handle('publish:saveDraft', (_e, v) => store.savePublishDraft(v));
  ipcMain.handle('publish:addToDraft', (_e, files) => {
    const d = store.getPublishDraft();
    const have = new Set(d.map((x) => x.file));
    for (const f of files) {
      if (have.has(f)) continue;
      const title = path.basename(f, path.extname(f)).replace(/_字幕$/, '').replace(/^\d{3}_/, '');
      d.push({ id: 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), file: f, title, desc: '', tags: [] });
    }
    store.savePublishDraft(d);
    return d.length;
  });

  // AI 配音（豆包语音合成）
  ipcMain.handle('tts:hasKey', () => doubao.hasKey());
  ipcMain.handle('tts:testKey', (_e, key) => doubao.testKey(key));
  ipcMain.handle('tts:clearKey', () => store.setSecret('doubaoKey', ''));
  ipcMain.handle('tts:sample', (_e, id, name) => doubao.sample(id, name));
  ipcMain.handle('tts:preview', (_e, text, opt) => doubao.preview(text, opt));

  ipcMain.handle('avatars:list', () => lipsync.listAvatars());
  ipcMain.handle('avatars:add', (_e, files) => lipsync.addAvatars(files, thumbnail));
  ipcMain.handle('avatars:remove', (_e, ids) => lipsync.removeAvatars(ids));
  ipcMain.handle('avatars:rename', (_e, id, name) => lipsync.renameAvatar(id, name));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#0b0b10',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: false },
  });
  if (process.env.VITE_DEV) win.loadURL('http://localhost:5199');
  else win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(async () => {
  protocol.handle('media', (req) => {
    const u = new URL(req.url);
    const p = decodeURIComponent(u.pathname.replace(/^\//, ''));
    return net.fetch(pathToFileURL(p).toString(), { headers: req.headers });
  });
  registerIpc();
  if (selftest.isSelfTest()) {
    const code = await selftest.run(checkEnv).catch((e) => {
      console.error(e);
      return 2;
    });
    app.exit(code);
    return;
  }
  detectHwEncoder(); // 后台检测硬件编码，第一次烧录前基本就有结果了
  createWindow();
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});
app.on('window-all-closed', () => !selftest.isSelfTest() && app.quit());
app.on('before-quit', () => {
  for (const k of ['burn', 'lipsync', 'mp3', 'text', 'collect', 'publish', 'tts']) queue.stop(k);
});
