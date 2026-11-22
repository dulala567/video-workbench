import { useEffect, useState } from 'react';
import { Download, FolderOpen, Settings2, LogIn, Trash2, X, RotateCcw, Square, Captions } from 'lucide-react';
import { api, useJobs, useSettings, fileName, fmtSize } from '../api';
import { Stats, StatusBadge, Progress, Toggle, toast, useCounts } from '../components/ui';
import { useLook } from '../components/StylePanel';

export default function Collect({ go }: { go: (p: string) => void }) {
  const { jobs, active } = useJobs('collect');
  const [s, save] = useSettings();
  const c = useCounts(jobs);
  const burnLook = useLook('burn');
  const [text, setText] = useState('');
  const [found, setFound] = useState<string[]>([]);
  const [dir, setDir] = useState('');
  useEffect(() => {
    api.settings.dirOf('collect').then(setDir);
  }, [s]);
  useEffect(() => {
    const t = setTimeout(() => api.collect.parse(text).then(setFound), 200);
    return () => clearTimeout(t);
  }, [text]);

  if (!s) return null;
  const autoBurn = !!s.collect?.autoBurn;

  const start = async () => {
    if (!found.length) return toast('没找到快手链接。粘贴手机端「分享 → 复制链接」得到的内容', true);
    const exist = new Set(jobs.filter((j) => j.status !== 'failed').map((j) => j.input.url));
    const fresh = found.filter((u) => !exist.has(u));
    if (!fresh.length) return toast('这些链接已经在列表里了');
    await api.jobs.add('collect', fresh.map((url) => ({ url, autoBurn, look: burnLook })));
    await api.jobs.start('collect');
    setText('');
    toast(`开始下载 ${fresh.length} 个作品`);
  };
  const changeDir = async () => {
    const d = await api.dialog.pickDir();
    if (d) save({ ...s, dirs: { ...s.dirs, collect: d } });
  };

  return (
    <div className="page" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div className="card-title">
          快手 · 批量下载 <span className="hint">粘贴手机端分享链接，每行一个；也可以直接粘贴整段分享文案，会自动找出里面的链接</span>
        </div>
        <textarea
          className="input"
          rows={6}
          placeholder={'https://v.kuaishou.com/xxxxxx\n或者整段：「xxx」的作品 https://v.kuaishou.com/xxxxxx 复制此消息，打开【快手】直接观看！'}
          value={text}
          onChange={(e) => setText(e.target.value)}
          style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12 }}
        />
        <div className="row wrap">
          <button className="btn primary" onClick={start} disabled={!found.length}>
            <Download size={14} /> 解析并下载{found.length ? `（${found.length} 个链接）` : ''}
          </button>
          <span className="row small" style={{ marginLeft: 8 }}>
            <Captions size={14} className="muted" /> 下载后自动加入字幕烧录
            <Toggle on={autoBurn} onChange={(v) => save({ ...s, collect: { ...s.collect, autoBurn: v } })} />
          </span>
          {autoBurn && (
            <button className="btn ghost sm" onClick={() => go('burn')}>
              用字幕烧录页当前样式 →
            </button>
          )}
          <span className="grow" />
          <button className="btn sm" title="需要登录或验证时，在弹出的快手窗口里自己完成" onClick={() => api.collect.login()}>
            <LogIn size={13} /> 打开快手
          </button>
          <button className="btn sm" onClick={() => api.shell.open(dir)}>
            <FolderOpen size={13} /> 打开下载目录
          </button>
          <button className="btn sm" onClick={changeDir}>
            <Settings2 size={13} /> 更改目录
          </button>
        </div>
      </div>

      <Stats
        items={[
          { label: '进行中', value: c.running + c.pending, cls: 'c-orange' },
          { label: '已完成', value: c.done, cls: 'c-green' },
          { label: '失败', value: c.failed, cls: 'c-red' },
        ]}
      />
      <div className="small muted">下载位置：{dir}　·　只下载你有权使用的作品；二次发布前请确认版权</div>

      <div className="card" style={{ padding: 0, flex: 1, minHeight: 240, display: 'flex', flexDirection: 'column' }}>
        <div className="row" style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)' }}>
          <b>下载列表</b>
          <span className="grow" />
          {active && (
            <button className="btn sm" onClick={() => api.jobs.stop('collect')}>
              <Square size={12} /> 停止
            </button>
          )}
          <button className="btn sm" onClick={() => api.jobs.clear('collect', 'finished')}>
            <Trash2 size={12} /> 清除已完成/失败
          </button>
          <button className="btn sm" onClick={() => api.jobs.clear('collect', 'all')}>
            清空全部
          </button>
        </div>
        {jobs.length === 0 ? (
          <div className="empty small">粘贴快手分享链接开始采集</div>
        ) : (
          <div style={{ overflow: 'auto' }}>
            <table className="table">
              <thead>
                <tr>
                  <th>作品</th>
                  <th style={{ width: 110 }}>大小</th>
                  <th style={{ width: 120 }}>状态</th>
                  <th style={{ width: 180 }}>进度</th>
                  <th style={{ width: 90 }} />
                </tr>
              </thead>
              <tbody>
                {[...jobs].reverse().map((j) => (
                  <tr key={j.id}>
                    <td className="file-cell">
                      <div className="name">{j.output?.file ? fileName(j.output.file) : j.input.url}</div>
                      <div className="meta">
                        {j.output?.author ? `@${j.output.author} · ` : ''}
                        {j.input.url}
                        {j.input.autoBurn ? ' · 完成后烧录字幕' : ''}
                      </div>
                      {j.error && <div className="err">{j.error}</div>}
                    </td>
                    <td className="small">{j.output?.size ? fmtSize(j.output.size) : '—'}</td>
                    <td>
                      <StatusBadge job={j} />
                    </td>
                    <td>
                      <Progress job={j} />
                    </td>
                    <td>
                      <div className="row" style={{ justifyContent: 'flex-end' }}>
                        {j.output?.file && (
                          <button className="btn ghost sm" onClick={() => api.shell.show(j.output.file)}>
                            <FolderOpen size={13} />
                          </button>
                        )}
                        {j.status === 'failed' && (
                          <button
                            className="btn ghost sm"
                            onClick={async () => {
                              await api.jobs.retry([j.id]);
                              api.jobs.start('collect');
                            }}
                          >
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
          </div>
        )}
      </div>
    </div>
  );
}
