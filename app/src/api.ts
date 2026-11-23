import { useEffect, useState, useCallback } from 'react';
import presetsJson from '../shared/presets.json';

export type Kind = 'burn' | 'lipsync' | 'mp3' | 'text' | 'collect' | 'publish' | 'tts';
export type JobStatus = 'pending' | 'running' | 'done' | 'failed';

export interface Job {
  id: string;
  kind: Kind;
  status: JobStatus;
  progress: number;
  stage: string;
  input: any;
  output: any;
  error: string | null;
  createdAt: number;
  finishedAt: number | null;
}

export interface SubStyle {
  id: string;
  name: string;
  group?: string;
  font: string;
  size: number;
  bold: boolean;
  color: string;
  outline: { color: string; width: number };
  outline2: { color: string; width: number };
  shadow: { color: string; depth: number };
  box: { color: string; opacity: number; padding: number } | null;
  y: number;
}

export interface Overlay {
  id: string;
  kind: 'title' | 'footer' | 'text';
  text: string;
  x: number;
  y: number;
  size: number;
  color: string;
  outlineColor: string;
  outlineWidth: number;
  bold: boolean;
  font?: string;
  box?: boolean;
}

export interface Look {
  sub: SubStyle;
  overlays: Overlay[];
  showSubs: boolean;
  keepPunct: boolean;
  randomStyle: boolean;
  randomPool: SubStyle[];
  filter: { mode: 'off' | 'fixed' | 'random'; value: string };
}

export interface Avatar {
  id: string;
  name: string;
  file: string;
  thumb: string;
  isImage: boolean;
  width: number;
  height: number;
  duration: number;
}

export interface Env {
  ffmpeg: boolean;
  gpuEncode: boolean;
  gpuEncodeName?: string;
  platform?: string;
  whisper: boolean;
  whisperModel: boolean;
  whisperModelPath: string;
  senseVoice?: boolean; // 快速识别（SenseVoice）程序和模型都在
  lipsync: { ready: boolean; python: boolean; weights: boolean; runner: boolean };
  gpu?: { nvidia: boolean; name: string; memMB: number } | null; // 只有 Windows 查
  disk: number | null;
  chip: string;
  memGB: number;
}

// Windows 版：没有数字人（需要 NVIDIA 显卡 + 大模型，做不到解压即用），字体换成 Windows 自带 + 安装包自带的思源黑体
export const IS_WIN = (window as any).api?.platform === 'win32';
const WIN_FONTS = [
  { label: '思源黑体', family: 'Noto Sans SC' },
  { label: '微软雅黑', family: 'Microsoft YaHei' },
  { label: '黑体', family: 'SimHei' },
  { label: '等线', family: 'DengXian' },
  { label: '宋体', family: 'SimSun' },
  { label: '楷体', family: 'KaiTi' },
  { label: '仿宋', family: 'FangSong' },
];
const _presets = presetsJson as unknown as {
  styles: SubStyle[];
  fonts: { label: string; family: string }[];
  filters: { label: string; filter: string }[];
};
export const presets = IS_WIN ? { ..._presets, fonts: WIN_FONTS } : _presets;

declare global {
  interface Window {
    api: any;
  }
}
export const api = window.api;

export const mediaUrl = (p: string) => (p ? 'media://local/' + encodeURIComponent(p) : '');
export const fileName = (p: string) => p.split('/').pop() || p;
export const fmtSize = (b: number) =>
  b >= 1024 ** 3 ? (b / 1024 ** 3).toFixed(1) + ' GB' : b >= 1024 ** 2 ? (b / 1024 ** 2).toFixed(1) + ' MB' : (b / 1024).toFixed(0) + ' KB';
export const fmtDur = (s: number) => {
  if (!s) return '0:00';
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
};
export const today = () => new Date().toLocaleDateString('sv-SE');

// ---------- hooks ----------
let jobsCache: { jobs: Job[]; active: Record<Kind, boolean> } = { jobs: [], active: { burn: false, lipsync: false, mp3: false, text: false, collect: false, publish: false, tts: false } };
const jobListeners = new Set<(s: typeof jobsCache) => void>();
let jobsInit = false;
function initJobs() {
  if (jobsInit) return;
  jobsInit = true;
  api.jobs.snapshot().then((s: typeof jobsCache) => {
    jobsCache = s;
    jobListeners.forEach((l) => l(s));
  });
  api.jobs.onUpdate((s: typeof jobsCache) => {
    jobsCache = s;
    jobListeners.forEach((l) => l(s));
  });
}
export function useJobs(kind?: Kind) {
  initJobs();
  const [s, set] = useState(jobsCache);
  useEffect(() => {
    jobListeners.add(set);
    set(jobsCache);
    return () => {
      jobListeners.delete(set);
    };
  }, []);
  const jobs = kind ? s.jobs.filter((j) => j.kind === kind) : s.jobs;
  return { jobs, active: kind ? s.active[kind] : false, allActive: s.active };
}

let settingsCache: any = null;
const settingsListeners = new Set<(s: any) => void>();
export function useSettings() {
  const [s, set] = useState<any>(settingsCache);
  useEffect(() => {
    settingsListeners.add(set);
    if (!settingsCache) api.settings.get().then((v: any) => ((settingsCache = v), settingsListeners.forEach((l) => l(v))));
    return () => {
      settingsListeners.delete(set);
    };
  }, []);
  const save = useCallback(async (next: any) => {
    const v = await api.settings.save(next);
    settingsCache = v;
    settingsListeners.forEach((l) => l(v));
    return v;
  }, []);
  return [s, save] as const;
}

let envCache: Env | null = null;
const envListeners = new Set<(e: Env) => void>();
export async function refreshEnv() {
  envCache = await api.env.check();
  envListeners.forEach((l) => l(envCache!));
  return envCache;
}
export function useEnv() {
  const [e, set] = useState<Env | null>(envCache);
  useEffect(() => {
    envListeners.add(set);
    if (!envCache) refreshEnv();
    return () => {
      envListeners.delete(set);
    };
  }, []);
  return e;
}

// 样式配置：字幕烧录和数字人各存一份，保存在 userData/styles.json
export const defaultLook = (): Look => ({
  sub: { ...presets.styles[1] },
  overlays: [],
  showSubs: true,
  keepPunct: false,
  randomStyle: false,
  randomPool: [],
  filter: { mode: 'off', value: '鲜艳' },
});
interface StylesStore {
  looks: Record<string, Look>;
  custom: SubStyle[];
}
let stylesCache: StylesStore | null = null;
const stylesListeners = new Set<(s: StylesStore) => void>();
export function useStyles() {
  const [s, set] = useState<StylesStore | null>(stylesCache);
  useEffect(() => {
    stylesListeners.add(set);
    if (!stylesCache)
      api.styles.get().then((v: StylesStore | null) => {
        stylesCache = v || { looks: {}, custom: [] };
        stylesListeners.forEach((l) => l(stylesCache!));
      });
    return () => {
      stylesListeners.delete(set);
    };
  }, []);
  const save = useCallback((next: StylesStore) => {
    stylesCache = next;
    stylesListeners.forEach((l) => l(next));
    api.styles.save(next);
  }, []);
  return [s, save] as const;
}
