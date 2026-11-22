import { useState } from 'react';
import { House, Captions, MessageSquareText, AudioLines, FileText, Settings as SettingsIcon, AudioWaveform, CloudDownload, Send, Mic } from 'lucide-react';
import { useEnv, useJobs, fmtSize, Kind, IS_WIN } from './api';
import { ToastHost } from './components/ui';
import Settings from './components/Settings';
import Dashboard from './pages/Dashboard';
import Burn from './pages/Burn';
import Lipsync from './pages/Lipsync';
import Mp3 from './pages/Mp3';
import Text from './pages/Text';
import Collect from './pages/Collect';
import Publish from './pages/Publish';
import Tts from './pages/Tts';

const PAGES: Record<string, { title: string; sub: string }> = {
  home: { title: '工作台', sub: '今日概览、任务进度与快速入口' },
  burn: { title: '字幕烧录', sub: '批量识别语音，并把字幕烧录进视频' },
  lipsync: { title: '数字人口型', sub: '让数字人形象按音频开口说话，生成后自动加字幕' },
  mp3: { title: '音频提取', sub: '从视频里提取音频：MP3 / M4A / WAV / FLAC，或原样复制音轨' },
  text: { title: '转文字', sub: '把视频或音频转写成文字稿' },
  tts: { title: 'AI 配音', sub: IS_WIN ? '用豆包语音把文案配成音频，自带逐字字幕' : '用豆包语音把文案配成音频，自带逐字字幕，可直接拿去做数字人' },
  collect: { title: '采集中心', sub: '采集视频素材，可自动加入字幕烧录队列' },
  publish: { title: '发布到账号', sub: '把成品按顺序批量发布到多个账号（通过本机的小V猫）' },
};

const NAV: { group?: string; items: { id: string; label: string; icon: any; kind?: Kind }[] }[] = [
  { items: [{ id: 'home', label: '工作台', icon: House }] },
  {
    group: '创作',
    items: [
      { id: 'burn', label: '字幕烧录', icon: Captions, kind: 'burn' },
      ...(IS_WIN ? [] : [{ id: 'lipsync', label: '数字人口型', icon: MessageSquareText, kind: 'lipsync' as Kind }]),
      { id: 'tts', label: 'AI 配音', icon: Mic, kind: 'tts' },
    ],
  },
  {
    group: '素材',
    items: [
      { id: 'collect', label: '采集中心', icon: CloudDownload, kind: 'collect' },
    ],
  },
  {
    group: '工具',
    items: [
      { id: 'mp3', label: '音频提取', icon: AudioLines, kind: 'mp3' },
      { id: 'text', label: '转文字', icon: FileText, kind: 'text' },
    ],
  },
  { group: '发布', items: [{ id: 'publish', label: '发布到账号', icon: Send, kind: 'publish' }] },
];

export default function App() {
  const [page, setPage] = useState('home');
  const [showSettings, setShowSettings] = useState(false);
  const env = useEnv();
  const { jobs } = useJobs();
  const runningOf = (k?: Kind) => (k ? jobs.filter((j) => j.kind === k && j.status === 'running').length : 0);
  const p = PAGES[page];

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-logo">
            <AudioWaveform size={16} color="#fff" />
          </div>
          视频工作台
        </div>
        {NAV.map((g, i) => (
          <div key={i}>
            {g.group && <div className="nav-group">{g.group}</div>}
            {g.items.map((it) => (
              <button key={it.id} className={'nav-item' + (page === it.id ? ' active' : '')} onClick={() => setPage(it.id)}>
                <it.icon size={16} />
                {it.label}
                {runningOf(it.kind) > 0 && <span className="nav-badge">{runningOf(it.kind)} 进行中</span>}
              </button>
            ))}
          </div>
        ))}
        <div className="sidebar-bottom">
          <button className="nav-item" onClick={() => setShowSettings(true)}>
            <SettingsIcon size={16} /> 设置
          </button>
        </div>
      </aside>

      <main className="main">
        <div className="topbar">
          <div>
            <h1>{p.title}</h1>
            <div className="sub">{p.sub}</div>
          </div>
          <div className="spacer" />
          {env && (
            <>
              <span className="chip">
                <span className={'dot ' + (env.ffmpeg ? 'ok' : 'bad')} /> ffmpeg
              </span>
              <span className="chip">
                <span className={'dot ' + (env.gpuEncode ? 'ok' : 'warn')} title={env.gpuEncodeName || '没有可用的硬件编码，用 CPU 编码'} /> 硬件编码
              </span>
              <span className="chip">
                <span className={'dot ' + (env.whisper && env.whisperModel ? 'ok' : 'bad')} /> 识别引擎
              </span>
              {!IS_WIN && (
                <span className="chip">
                  <span className={'dot ' + (env.lipsync.ready ? 'ok' : 'warn')} /> 数字人组件
                </span>
              )}
            </>
          )}
        </div>
        {page === 'home' && <Dashboard go={setPage} />}
        {page === 'burn' && <Burn />}
        {page === 'lipsync' && !IS_WIN && <Lipsync go={setPage} />}
        {page === 'tts' && <Tts go={setPage} />}
        {page === 'mp3' && <Mp3 />}
        {page === 'text' && <Text />}
        {page === 'collect' && <Collect go={setPage} />}
        {page === 'publish' && <Publish />}
      </main>

      <footer className="statusbar">
        {env && (
          <>
            {!IS_WIN && (
              <span className="item">
                <span className={'dot ' + (env.lipsync.ready ? 'ok' : 'warn')} /> 数字人组件{env.lipsync.ready ? '就绪' : '未就绪'}
              </span>
            )}
            <span className="item">
              <span className={'dot ' + (env.whisperModel ? 'ok' : 'warn')} /> 识别模型{env.whisperModel ? '就绪' : '未就绪'}
            </span>
            <span className="item">
              <span className="dot ok" /> {env.chip} · {env.memGB}GB
            </span>
            <span className="item">
              <span className="dot ok" /> 输出盘剩余 {env.disk ? fmtSize(env.disk) : '未知'}
            </span>
          </>
        )}
        <span className="grow" />
        <span>v0.1.0</span>
      </footer>
      {showSettings && <Settings onClose={() => setShowSettings(false)} />}
      <ToastHost />
    </div>
  );
}
