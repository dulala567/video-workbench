// 设置、统计、形象库、样式库：都存成 userData 下的 JSON 文件。
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { paths } = require('./paths.cjs');

const dataDir = () => app.getPath('userData');
const file = (name) => path.join(dataDir(), name);

function readJson(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file(name), 'utf8'));
  } catch {
    return fallback;
  }
}
function writeJson(name, value) {
  fs.mkdirSync(dataDir(), { recursive: true });
  const tmp = file(name) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file(name));
}

// 各模块输出目录：留空 = 总目录下的同名子目录
const DIR_KEYS = {
  burn: '字幕输出',
  mp3: 'MP3输出',
  text: '转文字输出',
  lipsync: '数字人输出',
  avatars: '数字人形象库',
  collect: '采集中心下载',
  tts: '配音输出',
};

const DEFAULT_SETTINGS = {
  outRoot: paths.defaultOutRoot,
  dirs: { burn: '', mp3: '', text: '', lipsync: '', avatars: '', collect: '', tts: '' },
  output: { suffix: '_字幕', skipDone: false, addSeq: false, deleteSource: false },
  asr: { language: 'zh', model: '', threads: 8, concurrency: 1, useSameNameSrt: false, maxChars: 14 },
  encode: { encoder: 'auto', quality: 20, burnConcurrency: 2 },
  mp3: { format: 'mp3', bitrate: '128k', sampleRate: '', mono: true, skipExisting: true, deleteSource: false },
  text: { skipExisting: true, exportSrt: false },
  lipsync: { concurrency: 1, resolution: '720', bboxShift: 0 },
  collect: { autoBurn: false, concurrency: 3 },
  tts: { mode: 'tts', voice: 'zh_female_vv_uranus_bigtts', customVoice: '', speed: 0, volume: 0, pitch: 0, instruction: '', split: 'blank' },
  publish: { port: 3199, interval: 30, toolName: '', accountTool: '', mapping: {} },
};

function deepMerge(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const k of Object.keys(over)) {
    out[k] = base && typeof base[k] === 'object' && !Array.isArray(base[k]) ? deepMerge(base[k], over[k]) : over[k];
  }
  return out;
}

const store = {
  getSettings() {
    return deepMerge(DEFAULT_SETTINGS, readJson('settings.json', {}));
  },
  saveSettings(s) {
    writeJson('settings.json', s);
    return store.getSettings();
  },
  outDir(kind) {
    const s = store.getSettings();
    const d = s.dirs[kind] || path.join(s.outRoot, DIR_KEYS[kind]);
    fs.mkdirSync(d, { recursive: true });
    return d;
  },
  whisperModel() {
    return store.getSettings().asr.model || paths.defaultWhisperModel;
  },

  // 统计：{ 'YYYY-MM-DD': { burn: n, mp3: n, ... } }
  bumpStat(kind) {
    const stats = readJson('stats.json', {});
    const day = new Date().toLocaleDateString('sv-SE');
    stats[day] = stats[day] || {};
    stats[day][kind] = (stats[day][kind] || 0) + 1;
    writeJson('stats.json', stats);
  },
  getStats() {
    return readJson('stats.json', {});
  },

  getAvatars() {
    return readJson('avatars.json', []);
  },
  saveAvatars(list) {
    writeJson('avatars.json', list);
  },

  getStyles() {
    return readJson('styles.json', null);
  },
  saveStyles(v) {
    writeJson('styles.json', v);
  },


  // 发布用的待发布列表
  getPublishDraft() {
    return readJson('publish-draft.json', []);
  },
  savePublishDraft(v) {
    writeJson('publish-draft.json', v);
  },

  // 小V猫访问令牌：用系统钥匙串加密后存盘，不写明文
  getSecret(name) {
    const { safeStorage } = require('electron');
    const v = readJson('secrets.json', {})[name];
    if (!v) return '';
    try {
      return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(Buffer.from(v, 'base64')) : '';
    } catch {
      return '';
    }
  },
  setSecret(name, value) {
    const { safeStorage } = require('electron');
    const all = readJson('secrets.json', {});
    if (!value) delete all[name];
    else {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('系统钥匙串不可用，无法安全保存令牌');
      all[name] = safeStorage.encryptString(value).toString('base64');
    }
    writeJson('secrets.json', all);
  },

  getJobs() {
    return readJson('jobs.json', []);
  },
  saveJobs(list) {
    writeJson('jobs.json', list);
  },
  DIR_KEYS,
};

module.exports = { store };
