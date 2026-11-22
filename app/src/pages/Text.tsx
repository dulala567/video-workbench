import { useEffect, useState } from 'react';
import { FileText, FolderPlus, Play, Trash2, FolderOpen, X, RotateCcw, Square, Copy } from 'lucide-react';
import { api, useJobs, useSettings, fileName } from '../api';
import { Toggle, Stats, StatusBadge, Progress, Empty, useDrop, useCounts, toast } from '../components/ui';

export default function Text() {
  const { jobs, active } = useJobs('text');
  const [s, save] = useSettings();
  const c = useCounts(jobs);
  const [tab, setTab] = useState<'list' | 'result'>('list');
  const [openId, setOpenId] = useState<string | null>(null);
  const [content, setContent] = useState('');

  const addFiles = async (files: string[]) => {
    const exist = new Set(jobs.filter((j) => j.status !== 'done').map((j) => j.input.file));
    const fresh = files.filter((f) => !exist.has(f));
    if (fresh.length) await api.jobs.add('text', fresh.map((file) => ({ file })));
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
    api.jobs.start('text');
  };

  const done = jobs.filter((j) => j.status === 'done' && j.output);
  const opened = done.find((j) => j.id === openId) || done[0];
  useEffect(() => {
    if (tab !== 'result' || !opened) return setContent('');
    api.fs
      .readText(opened.output.file)
      .then(setContent)
      .catch(() => setContent('（读取失败，文件可能已被移动）'));
  }, [tab, opened?.id]);

  if (!s) return null;
  const set = (patch: any) => save({ ...s, text: { ...s.text, ...patch } });

  return (
    <div className="page" {...drop.props} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="row">
        <div className="seg">
          <button className={tab === 'list' ? 'on' : ''} onClick={() => setTab('list')}>
            任务列表
          </button>
          <button className={tab === 'result' ? 'on' : ''} onClick={() => setTab('result')}>
            文案结果
          </button>
        </div>
        <button className="btn primary" onClick={pickFiles}>
          <FileText size={15} /> 选择文件
        </button>
        <button className="btn" onClick={pickDir}>
          <FolderPlus size={15} /> 添加文件夹
        </button>
        <span className="grow" />
        <span>跳过已有文本</span>
        <Toggle on={s.text.skipExisting} onChange={(v) => set({ skipExisting: v })} />
        <span style={{ marginLeft: 8 }}>同时导出 SRT</span>
        <Toggle on={s.text.exportSrt} onChange={(v) => set({ exportSrt: v })} />
        <button className="btn" onClick={() => api.jobs.clear('text', 'finished')}>
          <Trash2 size={13} /> 清除已完成
        </button>
        {active ? (
          <button className="btn" onClick={() => api.jobs.stop('text')}>
            <Square size={13} /> 停止
          </button>
        ) : (
          <button className="btn primary" disabled={!c.pending && !c.failed} onClick={start}>
            <Play size={14} /> 开始识别
          </button>
        )}
      </div>

      <Stats
        items={[
          { label: '文件数', value: c.all },
          { label: '识别中 / 排队', value: `${c.running} / ${c.pending}`, cls: 'c-orange' },
          { label: '已完成', value: c.done, cls: 'c-green' },
          { label: '累计字数', value: done.reduce((a, j) => a + (j.output.chars || 0), 0) },
        ]}
      />

      {tab === 'list' ? (
        <div className={'card' + (drop.over ? ' dropzone over' : '')} style={{ padding: 0, flex: 1, minHeight: 280, overflow: 'auto' }}>
          {jobs.length === 0 ? (
            <div style={{ display: 'grid', placeItems: 'center', height: '100%' }}>
              <div className="dropzone" style={{ padding: '10px 60px' }}>
                <Empty icon={<FileText size={24} />} title="视频 / 音频转文字" desc="拖入视频或 MP3，自动识别语音并导出为 TXT（可同时导出 SRT 字幕）">
                  <button className="btn primary" onClick={pickFiles}>
                    选择文件
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
                  <th style={{ width: 90 }}>字数</th>
                  <th style={{ width: 120 }}>状态</th>
                  <th style={{ width: 180 }}>进度</th>
                  <th style={{ width: 90 }} />
                </tr>
              </thead>
              <tbody>
                {jobs.map((j) => (
                  <tr key={j.id}>
                    <td className="file-cell">
                      <div className="name">{fileName(j.input.file)}</div>
                      {j.error && <div className="err">{j.error}</div>}
                    </td>
                    <td className="small">{j.output?.chars ?? '—'}</td>
                    <td>
                      <StatusBadge job={j} />
                    </td>
                    <td>
                      <Progress job={j} />
                    </td>
                    <td>
                      <div className="row" style={{ justifyContent: 'flex-end' }}>
                        {j.output?.file && (
                          <button
                            className="btn ghost sm"
                            title="查看文案"
                            onClick={() => {
                              setOpenId(j.id);
                              setTab('result');
                            }}
                          >
                            <FileText size={13} />
                          </button>
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
      ) : (
        <div className="row" style={{ flex: 1, minHeight: 280, alignItems: 'stretch' }}>
          <div className="card" style={{ width: 280, padding: 6, overflow: 'auto' }}>
            {done.length === 0 && <div className="muted small" style={{ padding: 12 }}>还没有识别完成的文件</div>}
            {done.map((j) => (
              <button key={j.id} className={'nav-item' + (opened?.id === j.id ? ' active' : '')} onClick={() => setOpenId(j.id)}>
                <FileText size={14} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{fileName(j.input.file)}</span>
              </button>
            ))}
          </div>
          <div className="card grow" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {opened && (
              <div className="row">
                <b className="grow">{fileName(opened.output.file)}</b>
                <button
                  className="btn sm"
                  onClick={() => {
                    navigator.clipboard.writeText(content);
                    toast('已复制');
                  }}
                >
                  <Copy size={13} /> 复制全文
                </button>
                <button className="btn sm" onClick={() => api.shell.show(opened.output.file)}>
                  <FolderOpen size={13} /> 打开位置
                </button>
              </div>
            )}
            <textarea className="input grow" readOnly value={content} style={{ resize: 'none', lineHeight: 1.8 }} />
          </div>
        </div>
      )}
    </div>
  );
}
