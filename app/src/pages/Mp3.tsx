import { AudioLines, FileVideo, FolderPlus, Play, Trash2, FolderOpen, X, RotateCcw, Square } from 'lucide-react';
import { api, useJobs, useSettings, fileName, fmtSize, mediaUrl } from '../api';
import { Toggle, Stats, StatusBadge, Progress, Empty, useDrop, useCounts, toast } from '../components/ui';
import { useEffect, useRef, useState } from 'react';

const FORMATS: [string, string, string][] = [
  ['mp3', 'MP3', '通用，体积小'],
  ['m4a', 'M4A（AAC）', '苹果设备友好，同音质比 MP3 小'],
  ['wav', 'WAV', '无损，体积大，适合剪辑/配音'],
  ['flac', 'FLAC', '无损压缩，比 WAV 小一半左右'],
  ['copy', '原始音轨', '不转码，最快、零损失，格式跟原视频走'],
];
const FMT_NAME: Record<string, string> = Object.fromEntries(FORMATS.map(([k, n]) => [k, n]));

export default function Mp3() {
  const { jobs, active } = useJobs('mp3');
  const [s, save] = useSettings();
  const c = useCounts(jobs);
  const [outDir, setOutDir] = useState('');
  const [playing, setPlaying] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  useEffect(() => () => audio.current?.pause(), []);
  useEffect(() => {
    api.settings.dirOf('mp3').then(setOutDir);
  }, [s]);

  const addFiles = async (files: string[]) => {
    const exist = new Set(jobs.filter((j) => j.status !== 'done').map((j) => j.input.file));
    const fresh = files.filter((f) => !exist.has(f));
    if (!fresh.length) return;
    const items = await Promise.all(fresh.map(async (file) => ({ file, size: await api.media.size(file) })));
    await api.jobs.add('mp3', items);
  };
  const drop = useDrop('media', addFiles);
  const pickFiles = async () => addFiles(await api.dialog.open({ group: 'media' }));
  const pickDir = async () => {
    const r = await api.dialog.open({ group: 'media', dir: true });
    if (r?.files?.length) addFiles(r.files);
  };
  const start = async () => {
    const failed = jobs.filter((j) => j.status === 'failed').map((j) => j.id);
    if (failed.length) await api.jobs.retry(failed);
    api.jobs.start('mp3');
  };

  if (!s) return null;
  const set = (patch: any) => save({ ...s, mp3: { ...s.mp3, ...patch } });
  const done = jobs.filter((j) => j.status === 'done' && j.output);
  const inTotal = done.reduce((a, j) => a + (j.output.inSize || 0), 0);
  const outTotal = done.reduce((a, j) => a + (j.output.outSize || 0), 0);
  const fmt = s.mp3.format || 'mp3';
  const lossy = fmt === 'mp3' || fmt === 'm4a';
  const play = (file: string, id: string) => {
    audio.current?.pause();
    if (playing === id) return setPlaying(null);
    const a = new Audio(mediaUrl(file));
    audio.current = a;
    a.onended = () => setPlaying(null);
    a.play().catch(() => toast('这个格式没法在软件里直接播放，可以在访达里打开', true));
    setPlaying(id);
  };

  return (
    <div className="page" {...drop.props} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="row">
        <button className="btn primary" onClick={pickFiles}>
          <FileVideo size={15} /> 选择视频/音频
        </button>
        <button className="btn" onClick={pickDir}>
          <FolderPlus size={15} /> 添加文件夹
        </button>
        <span className="grow" />
        <button className="btn" onClick={() => api.jobs.clear('mp3', 'finished')}>
          <Trash2 size={13} /> 清除已完成
        </button>
        {active ? (
          <button className="btn" onClick={() => api.jobs.stop('mp3')}>
            <Square size={13} /> 停止
          </button>
        ) : (
          <button className="btn primary" disabled={!c.pending && !c.failed} onClick={start}>
            <Play size={14} /> 开始提取
          </button>
        )}
      </div>

      <div className="card row wrap" style={{ gap: 18, padding: '12px 16px' }}>
        <div className="row">
          <span>格式</span>
          <select className="input" value={fmt} onChange={(e) => set({ format: e.target.value })} title={FORMATS.find((f) => f[0] === fmt)?.[2]}>
            {FORMATS.map(([k, n, d]) => (
              <option key={k} value={k}>
                {n} · {d}
              </option>
            ))}
          </select>
        </div>
        {lossy && (
          <div className="row">
            <span>音质</span>
            <select className="input" value={s.mp3.bitrate} onChange={(e) => set({ bitrate: e.target.value })}>
              <option value="64k">64 kbps（最小）</option>
              <option value="128k">128 kbps（推荐）</option>
              <option value="192k">192 kbps</option>
              <option value="320k">320 kbps（最高）</option>
            </select>
          </div>
        )}
        {fmt !== 'copy' && (
          <div className="row">
            <span>采样率</span>
            <select className="input" value={s.mp3.sampleRate || ''} onChange={(e) => set({ sampleRate: e.target.value })}>
              <option value="">跟原文件一样</option>
              <option value="48000">48 kHz（视频常用）</option>
              <option value="44100">44.1 kHz（音乐常用）</option>
              <option value="16000">16 kHz（语音识别用）</option>
            </select>
          </div>
        )}
        {fmt !== 'copy' && (
          <div className="row">
            <span>单声道</span>
            <Toggle on={s.mp3.mono} onChange={(v) => set({ mono: v })} />
          </div>
        )}
        <div className="row">
          <span>跳过已提取</span>
          <Toggle on={s.mp3.skipExisting} onChange={(v) => set({ skipExisting: v })} />
        </div>
        <div className="row">
          <span>提取后把原文件移到废纸篓</span>
          <Toggle on={s.mp3.deleteSource} onChange={(v) => set({ deleteSource: v })} />
        </div>
        <div className="row grow" style={{ minWidth: 260 }}>
          <span className="muted small">输出到</span>
          <span className="small" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {outDir}
          </span>
          <button className="btn ghost sm" onClick={() => api.shell.open(outDir)}>
            <FolderOpen size={13} />
          </button>
        </div>
      </div>

      <Stats
        items={[
          { label: '文件数', value: c.all },
          { label: '已完成', value: c.done, cls: 'c-green' },
          { label: '原文件 → 音频', value: `${fmtSize(inTotal)} → ${fmtSize(outTotal)}` },
          { label: '已节省空间', value: fmtSize(Math.max(0, inTotal - outTotal)), cls: 'c-green' },
        ]}
      />

      <div className={'card' + (drop.over ? ' dropzone over' : '')} style={{ padding: 0, flex: 1, minHeight: 280, overflow: 'auto' }}>
        {jobs.length === 0 ? (
          <div style={{ display: 'grid', placeItems: 'center', height: '100%' }}>
            <div className="dropzone" style={{ padding: '10px 60px' }}>
              <Empty icon={<AudioLines size={24} />} title="批量提取视频里的音频" desc="拖入视频、音频或文件夹；可选 MP3 / M4A / WAV / FLAC，或原样复制音轨（不转码）">
                <button className="btn primary" onClick={pickFiles}>
                  选择视频/音频
                </button>
                <button className="btn" onClick={pickDir}>
                  选择文件夹
                </button>
              </Empty>
            </div>
          </div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>文件</th>
                <th style={{ width: 160 }}>大小</th>
                <th style={{ width: 110 }}>状态</th>
                <th style={{ width: 180 }}>进度</th>
                <th style={{ width: 110 }} />
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.id}>
                  <td className="file-cell">
                    <div className="name">{fileName(j.input.file)}</div>
                    {j.output?.file && (
                      <div className="meta">
                        → {fileName(j.output.file)}
                        {j.output.format ? ` · ${FMT_NAME[j.output.format] || j.output.format}` : ''}
                        {j.output.skipped ? ' · 已存在，跳过' : ''}
                      </div>
                    )}
                    {j.error && <div className="err">{j.error}</div>}
                  </td>
                  <td className="small">{j.output ? `${fmtSize(j.output.inSize)} → ${fmtSize(j.output.outSize)}` : fmtSize(j.input.size || 0)}</td>
                  <td>
                    <StatusBadge job={j} />
                  </td>
                  <td>
                    <Progress job={j} />
                  </td>
                  <td>
                    <div className="row" style={{ justifyContent: 'flex-end' }}>
                      {j.output?.file && (
                        <>
                          <button className="btn ghost sm" title="播放" onClick={() => play(j.output.file, j.id)}>
                            {playing === j.id ? <Square size={13} /> : <Play size={13} />}
                          </button>
                          <button className="btn ghost sm" title="在访达中显示" onClick={() => api.shell.show(j.output.file)}>
                            <FolderOpen size={13} />
                          </button>
                        </>
                      )}
                      {j.status === 'failed' && (
                        <button className="btn ghost sm" onClick={() => api.jobs.retry([j.id])}>
                          <RotateCcw size={13} />
                        </button>
                      )}
                      {j.status !== 'running' && (
                        <button className="btn ghost sm" onClick={() => api.jobs.remove([j.id])}>
                          <X size={13} />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
