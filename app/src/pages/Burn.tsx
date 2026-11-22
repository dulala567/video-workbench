import { useMemo, useState } from 'react';
import { FileVideo, FolderPlus, Play, Pause, Square, Trash2, Captions, FolderOpen, RotateCcw, X, Send } from 'lucide-react';
import { api, useJobs, fileName, fmtDur, fmtSize, Job } from '../api';
import { Seg, Stats, StatusBadge, Progress, Empty, useDrop, useCounts, toast } from '../components/ui';
import { StylePanel, useLook } from '../components/StylePanel';

type Filter = 'all' | 'pending' | 'srt' | 'done' | 'failed';

export default function Burn() {
  const { jobs, active } = useJobs('burn');
  const look = useLook('burn');
  const [mode, setMode] = useState<'burn' | 'srtOnly'>('burn');
  const [filter, setFilter] = useState<Filter>('all');
  const [sort, setSort] = useState<'time' | 'name'>('time');
  const [sel, setSel] = useState<Set<string>>(new Set());
  const c = useCounts(jobs);

  const addFiles = async (files: string[]) => {
    const exist = new Set(jobs.filter((j) => j.status !== 'done').map((j) => j.input.file));
    const fresh = files.filter((f) => !exist.has(f));
    if (!fresh.length) return toast('这些视频已经在列表里了');
    const items = await Promise.all(
      fresh.map(async (file) => {
        let meta = {};
        try {
          const info = await api.media.probe(file);
          meta = { width: info.width, height: info.height, duration: info.duration, size: info.size };
        } catch {}
        return { file, mode, look, meta };
      })
    );
    await api.jobs.add('burn', items);
    toast(`已添加 ${items.length} 个视频`);
  };
  const drop = useDrop('video', addFiles);

  const pickFiles = async () => addFiles(await api.dialog.open({ group: 'video' }));
  const pickDir = async () => {
    const r = await api.dialog.open({ group: 'video', dir: true });
    if (r?.files?.length) addFiles(r.files);
    else if (r?.dir) toast('文件夹里没有视频', true);
  };
  const start = async () => {
    // 开始前把当前样式/模式同步给还没开始的任务
    const pend = jobs.filter((j) => j.status === 'pending' && !j.input.customLook).map((j) => j.id);
    if (pend.length) await api.jobs.updateInputs(pend, { look, mode });
    const failed = jobs.filter((j) => j.status === 'failed').map((j) => j.id);
    if (failed.length) await api.jobs.retry(failed);
    api.jobs.start('burn');
  };

  const list = useMemo(() => {
    let l = jobs.filter((j) => {
      if (filter === 'all') return true;
      if (filter === 'srt') return j.status === 'done' && j.input.mode === 'srtOnly';
      return j.status === filter;
    });
    l = [...l].sort((a, b) => (sort === 'name' ? fileName(a.input.file).localeCompare(fileName(b.input.file), 'zh') : a.createdAt - b.createdAt));
    return l;
  }, [jobs, filter, sort]);

  const toggle = (id: string) => {
    const n = new Set(sel);
    n.has(id) ? n.delete(id) : n.add(id);
    setSel(n);
  };
  const allSel = list.length > 0 && list.every((j) => sel.has(j.id));
  const previewFile = jobs.find((j) => sel.has(j.id))?.input.file || jobs[0]?.input.file;

  return (
    <div className="page with-side">
      <div className="page-body" {...drop.props}>
        <div className="row">
          <button className="btn primary" onClick={pickFiles}>
            <FileVideo size={15} /> 选择视频
          </button>
          <button className="btn" onClick={pickDir}>
            <FolderPlus size={15} /> 添加文件夹
          </button>
          <span className="grow" />
          <Seg
            value={mode}
            options={[
              ['burn', '识别 + 烧录'],
              ['srtOnly', '仅生成字幕'],
            ]}
            onChange={setMode}
          />
          <button
            className="btn"
            title="把已完成的成品（选中的，或全部）加到「发布到账号」的待发布列表"
            disabled={!c.done}
            onClick={async () => {
              const done = jobs.filter((j) => j.status === 'done' && j.output?.file?.endsWith('.mp4'));
              const pick = done.some((j) => sel.has(j.id)) ? done.filter((j) => sel.has(j.id)) : done;
              const n = await api.publish.addToDraft(pick.map((j) => j.output.file));
              toast(`已加入发布队列（待发布 ${n} 条）`);
            }}
          >
            <Send size={14} /> 加入发布队列
          </button>
          {!active ? (
            <button className="btn primary" disabled={!c.pending && !c.failed} onClick={start}>
              <Play size={14} /> 开始处理
            </button>
          ) : (
            <button className="btn" onClick={() => api.jobs.pause('burn')}>
              <Pause size={14} /> 暂停
            </button>
          )}
          <button className="btn" disabled={!c.running} onClick={() => api.jobs.stop('burn')}>
            <Square size={13} /> 停止
          </button>
        </div>

        <Stats
          items={[
            { label: '全部', value: c.all },
            { label: '处理中 / 排队', value: `${c.running} / ${c.pending}`, cls: 'c-orange' },
            { label: '已完成', value: c.done, cls: 'c-green' },
            { label: '失败', value: c.failed, cls: 'c-red' },
          ]}
        />

        <div className={'card' + (drop.over ? ' dropzone over' : '')} style={{ padding: 0, flex: 1, minHeight: 300, display: 'flex', flexDirection: 'column' }}>
          <div className="row" style={{ padding: '10px 12px', borderBottom: '1px solid var(--border)' }}>
            <div className="tabs">
              {(
                [
                  ['all', '全部', c.all],
                  ['pending', '待处理', c.pending],
                  ['srt', '字幕就绪', jobs.filter((j) => j.status === 'done' && j.input.mode === 'srtOnly').length],
                  ['done', '已完成', c.done],
                  ['failed', '失败', c.failed],
                ] as [Filter, string, number][]
              ).map(([k, l, n]) => (
                <button key={k} className={'tab' + (filter === k ? ' on' : '')} onClick={() => setFilter(k)}>
                  {l}
                  <span className="n">{n}</span>
                </button>
              ))}
            </div>
            <span className="grow" />
            <button className={'btn sm' + (sort === 'time' ? ' primary' : '')} onClick={() => setSort('time')}>
              按添加时间
            </button>
            <button className={'btn sm' + (sort === 'name' ? ' primary' : '')} onClick={() => setSort('name')}>
              按文件名
            </button>
            {sel.size > 0 && (
              <button
                className="btn sm"
                onClick={() => {
                  api.jobs.remove([...sel]);
                  setSel(new Set());
                }}
              >
                <X size={12} /> 移除选中
              </button>
            )}
            <button className="btn sm" onClick={() => api.jobs.clear('burn', 'pending')}>
              <Trash2 size={12} /> 清除待处理
            </button>
            <button className="btn sm" onClick={() => api.jobs.clear('burn', 'all')}>
              <Trash2 size={12} /> 清空全部
            </button>
          </div>
          {jobs.length === 0 ? (
            <Empty icon={<Captions size={24} />} title="把视频拖到这里" desc="支持一次拖入多个视频或整个文件夹，识别语音后把字幕和标题烧进视频">
              <button className="btn primary" onClick={pickFiles}>
                选择视频
              </button>
              <button className="btn" onClick={pickDir}>
                选择文件夹
              </button>
            </Empty>
          ) : (
            <div style={{ overflow: 'auto', flex: 1 }}>
              <table className="table">
                <thead>
                  <tr>
                    <th style={{ width: 36 }}>
                      <input type="checkbox" checked={allSel} onChange={() => setSel(allSel ? new Set() : new Set(list.map((j) => j.id)))} />
                    </th>
                    <th>文件</th>
                    <th style={{ width: 140 }}>样式</th>
                    <th style={{ width: 120 }}>状态</th>
                    <th style={{ width: 180 }}>进度</th>
                    <th style={{ width: 90 }} />
                  </tr>
                </thead>
                <tbody>
                  {list.map((j) => (
                    <JobRow key={j.id} j={j} checked={sel.has(j.id)} onCheck={() => toggle(j.id)} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
      <StylePanel
        lookKey="burn"
        previewFile={previewFile}
        selectedCount={jobs.filter((j) => sel.has(j.id) && j.status !== 'running').length}
        onApplySelected={async (lk) => {
          const ids = jobs.filter((j) => sel.has(j.id) && j.status !== 'running').map((j) => j.id);
          await api.jobs.updateInputs(ids, { look: lk, customLook: true });
          toast(`已把当前样式应用到 ${ids.length} 个视频`);
        }}
      />
    </div>
  );
}

function JobRow({ j, checked, onCheck }: { j: Job; checked: boolean; onCheck: () => void }) {
  const m = j.input.meta || {};
  const look = j.input.look || {};
  return (
    <tr>
      <td>
        <input type="checkbox" checked={checked} onChange={onCheck} />
      </td>
      <td className="file-cell">
        <div className="name">{fileName(j.input.file)}</div>
        <div className="meta">
          {m.width ? `${m.width}×${m.height} · ` : ''}
          {fmtDur(m.duration)} · {fmtSize(m.size || 0)}
          {j.input.mode === 'srtOnly' ? ' · 仅字幕' : ''}
        </div>
        {j.error && <div className="err">{j.error}</div>}
      </td>
      <td className="small">
        {look.randomStyle ? `随机（${look.randomPool?.length || 0} 款）` : look.sub?.name || '—'}
        {j.input.customLook && <span className="muted"> · 单独</span>}
      </td>
      <td>
        <StatusBadge job={j} />
      </td>
      <td>
        <Progress job={j} />
      </td>
      <td>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          {j.status === 'done' && j.output?.file && (
            <button className="btn ghost sm" title="在访达中显示" onClick={() => api.shell.show(j.output.file)}>
              <FolderOpen size={13} />
            </button>
          )}
          {j.status === 'failed' && (
            <button className="btn ghost sm" title="重试" onClick={() => api.jobs.retry([j.id])}>
              <RotateCcw size={13} />
            </button>
          )}
          {j.status !== 'running' && (
            <button className="btn ghost sm danger" title="移除" onClick={() => api.jobs.remove([j.id])}>
              <X size={13} />
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}
