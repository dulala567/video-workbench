import { useEffect, useState } from 'react';
import { UserPlus, UserRound, Music, FolderPlus, Plus, Trash2, Play, Square, X, FolderOpen, RotateCcw, Check, Image as ImageIcon, AlertTriangle, Send, Mic } from 'lucide-react';
import { api, useJobs, useSettings, useEnv, fileName, mediaUrl, Avatar, fmtDur } from '../api';
import { Seg, Toggle, StatusBadge, Progress, Empty, toast, useCounts } from '../components/ui';
import { StylePanel, useLook } from '../components/StylePanel';

interface Group {
  id: string;
  avatars: string[];
  audios: string[];
  mode: 'cross' | 'pair';
}
type Pick = { mode: 'off' | 'fixed' | 'random'; files: string[] };

export function useAvatars() {
  const [list, setList] = useState<Avatar[]>([]);
  const reload = () => api.avatars.list().then(setList);
  useEffect(() => {
    reload();
  }, []);
  return [list, reload] as const;
}

export default function Lipsync({ go }: { go?: (p: string) => void }) {
  const env = useEnv();
  const [s, save] = useSettings();
  const { jobs, active } = useJobs('lipsync');
  const c = useCounts(jobs);
  const look = useLook('lipsync');
  const [avatars, reloadAvatars] = useAvatars();
  const [selAv, setSelAv] = useState<string[]>([]);
  const [audios, setAudios] = useState<string[]>([]);
  const [mode, setMode] = useState<'cross' | 'pair'>('cross');
  const [groups, setGroups] = useState<Group[]>([]);
  const [bgm, setBgm] = useState<Pick & { volume: number }>({ mode: 'off', files: [], volume: 0.18 });
  const [bg, setBg] = useState<Pick>({ mode: 'off', files: [] });
  const [adding, setAdding] = useState(false);
  const [outDir, setOutDir] = useState('');
  // 从「AI 配音」页送过来的音频
  useEffect(() => {
    try {
      const pending: string[] = JSON.parse(localStorage.getItem('lipsyncPendingAudios') || '[]');
      if (pending.length) {
        localStorage.removeItem('lipsyncPendingAudios');
        setAudios((a) => [...new Set([...a, ...pending])]);
        toast(`已加入 ${pending.length} 条配音（字幕会直接用配音原文，不再识别）`);
      }
    } catch {}
  }, []);
  useEffect(() => {
    api.settings.dirOf('lipsync').then(setOutDir);
  }, [s]);

  const addAvatars = async () => {
    const files: string[] = await api.dialog.open({ group: 'avatar' });
    if (!files.length) return;
    setAdding(true);
    try {
      const added: Avatar[] = await api.avatars.add(files);
      toast(`已添加 ${added.length} 个形象`);
    } catch (e: any) {
      toast(String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), true);
    }
    setAdding(false);
    reloadAvatars();
  };
  const removeAvatar = async (id: string) => {
    if (!confirm(`删除形象「${avName(id)}」？会删掉形象库里的这份副本和人脸缓存，你的原始文件不受影响。`)) return;
    await api.avatars.remove([id]);
    setSelAv(selAv.filter((x) => x !== id));
    reloadAvatars();
  };
  const toggleAv = (id: string) => setSelAv(selAv.includes(id) ? selAv.filter((x) => x !== id) : [...selAv, id]);

  const pickAudios = async (dir = false) => {
    const r = await api.dialog.open({ group: 'audio', dir });
    const files: string[] = dir ? r?.files || [] : r;
    if (files?.length) setAudios([...new Set([...audios, ...files])]);
  };
  const pickInto = async (setter: (f: (p: any) => any) => void, group: string, dir: boolean) => {
    const r = await api.dialog.open({ group, dir, multi: false });
    const files: string[] = dir ? r?.files || [] : r;
    if (files?.length) setter((p: any) => ({ ...p, files, mode: dir ? 'random' : 'fixed' }));
  };

  const addGroup = () => {
    if (!selAv.length || !audios.length) return;
    if (mode === 'pair' && selAv.length !== audios.length && selAv.length !== 1)
      return toast(`一一对应需要形象和音频数量相同（现在 ${selAv.length} 个形象、${audios.length} 个音频）`, true);
    setGroups([...groups, { id: 'g' + Date.now(), avatars: selAv, audios, mode }]);
    setAudios([]);
    setSelAv([]);
  };
  const expand = (g: Group) => {
    if (g.mode === 'cross') return g.avatars.flatMap((a) => g.audios.map((au) => ({ avatarId: a, audio: au })));
    return g.audios.map((au, i) => ({ avatarId: g.avatars[g.avatars.length === 1 ? 0 : i], audio: au }));
  };
  const total = groups.reduce((a, g) => a + expand(g).length, 0);

  const enqueue = async (startNow: boolean) => {
    if (!groups.length) return toast('先添加至少一组', true);
    const items = groups.flatMap(expand).map((x) => ({
      ...x,
      look,
      bgm,
      bg,
      resolution: s.lipsync.resolution,
    }));
    await api.jobs.add('lipsync', items);
    setGroups([]);
    toast(`已加入 ${items.length} 条任务`);
    if (startNow) api.jobs.start('lipsync');
  };
  const avName = (id: string) => avatars.find((a) => a.id === id)?.name || '（已删除）';
  const preview = avatars.find((a) => a.id === selAv[0])?.file || avatars[0]?.file;

  if (!s) return null;
  return (
    <div className="page with-side">
      <div className="page-body">
        {env && !env.lipsync.ready && (
          <div className="card row" style={{ borderColor: 'var(--orange)', padding: '10px 14px' }}>
            <AlertTriangle size={16} className="c-orange" />
            <span className="small">
              数字人组件还没准备好：
              {!env.lipsync.python && 'Python 环境未安装；'}
              {!env.lipsync.weights && '模型权重未下载完；'}
              {!env.lipsync.runner && '口型脚本缺失；'}
              现在可以先整理形象和任务，生成要等组件就绪。
            </span>
          </div>
        )}

        <div className="card">
          <div className="row" style={{ marginBottom: 12 }}>
            <div className="card-title">
              <UserRound size={15} /> 数字人形象库 <span className="hint">{avatars.length} 个 · 视频（≤60 秒）或照片，正脸清晰、人物位置稳定</span>
            </div>
            <span className="grow" />
            <button className="btn primary sm" onClick={addAvatars} disabled={adding}>
              <UserPlus size={13} /> {adding ? '添加中…' : '添加形象'}
            </button>
          </div>
          {avatars.length === 0 ? (
            <Empty icon={<UserRound size={22} />} title="还没有数字人形象" desc="点「添加形象」选择视频或照片" />
          ) : (
            <div className="avatar-grid">
              {avatars.map((a) => (
                <AvatarTile key={a.id} a={a} on={selAv.includes(a.id)} onClick={() => toggleAv(a.id)} onRemove={() => removeAvatar(a.id)} />
              ))}
            </div>
          )}
        </div>

        <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="row">
            <div className="card-title">
              <Music size={15} /> 分组任务 <span className="hint">一组 = 若干形象 + 若干音频，可以加多组，最后一次性加入队列</span>
            </div>
            <span className="grow" />
            {groups.length > 0 && (
              <button className="btn ghost sm" onClick={() => setGroups([])}>
                <Trash2 size={12} /> 清除全部
              </button>
            )}
          </div>
          {groups.map((g, i) => (
            <div key={g.id} className="row small" style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 12px' }}>
              <b>第 {i + 1} 组</b>
              <span className="muted">{g.mode === 'cross' ? '每个形象 × 每个音频' : '按顺序一一对应'}</span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} className="grow">
                {g.avatars.map(avName).join('、')} ｜ {g.audios.map(fileName).join('、')}
              </span>
              <span className="c-accent">{expand(g).length} 条</span>
              <button className="btn ghost sm" onClick={() => setGroups(groups.filter((x) => x.id !== g.id))}>
                <X size={12} />
              </button>
            </div>
          ))}
          <div className="row">
            <b>第 {groups.length + 1} 组</b>
            <span className="small muted">先在上方点选形象，再选这一组的音频</span>
            <span className="grow" />
            <Seg
              value={mode}
              options={[
                ['cross', '每个形象 × 每个音频'],
                ['pair', '按顺序一一对应'],
              ]}
              onChange={setMode}
            />
          </div>
          <div className="row" style={{ alignItems: 'stretch' }}>
            <div className="list-box grow">
              <div className="hd">
                <span className="badge">1</span> 形象 {selAv.length}
                <span className="grow" />
                <button className="btn ghost sm" onClick={() => setSelAv([])}>
                  清除
                </button>
              </div>
              <div className="bd">
                {selAv.length === 0 && <span className="small muted">在上方形象库里点选（可多选）</span>}
                {selAv.map((id) => (
                  <span key={id} className="pill">
                    {avName(id)}
                  </span>
                ))}
              </div>
            </div>
            <div className="list-box grow">
              <div className="hd">
                <span className="badge">2</span> 音频 {audios.length}
                <span className="grow" />
                <button className="btn sm" onClick={() => pickAudios(false)}>
                  选择音频
                </button>
                <button className="btn sm" onClick={() => pickAudios(true)}>
                  <FolderPlus size={12} /> 文件夹
                </button>
                {go && (
                  <button className="btn sm" title="用豆包把文案配成语音" onClick={() => go('tts')}>
                    <Mic size={12} /> AI 配音
                  </button>
                )}
                <button className="btn ghost sm" onClick={() => setAudios([])}>
                  清除
                </button>
              </div>
              <div className="bd">
                {audios.length === 0 && <span className="small muted">点「选择音频」，可以一次选多个</span>}
                {audios.map((f, i) => (
                  <span key={f} className="pill">
                    {mode === 'pair' && <span className="muted">{i + 1}.</span>}
                    {fileName(f)}
                    <X size={11} style={{ cursor: 'pointer' }} onClick={() => setAudios(audios.filter((x) => x !== f))} />
                  </span>
                ))}
              </div>
            </div>
          </div>
          <div className="row">
            <span className="small muted">选好形象和音频后，添加为一组</span>
            <span className="grow" />
            <button className="btn primary sm" disabled={!selAv.length || !audios.length} onClick={addGroup}>
              <Plus size={13} /> 添加为一组
            </button>
          </div>

          <div className="row wrap" style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
            <b style={{ width: 70 }}>背景音乐</b>
            <Seg
              value={bgm.mode}
              options={[
                ['off', '不加'],
                ['fixed', '固定一首'],
                ['random', '文件夹随机'],
              ]}
              onChange={(v) => (v === 'off' ? setBgm({ ...bgm, mode: v }) : pickInto(setBgm as any, 'audio', v === 'random'))}
            />
            {bgm.mode !== 'off' && (
              <>
                <span className="small" style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {bgm.mode === 'fixed' ? fileName(bgm.files[0] || '') : `${bgm.files.length} 首`}
                </span>
                <span className="small muted">音量</span>
                <input type="range" min={0.05} max={0.6} step={0.01} value={bgm.volume} onChange={(e) => setBgm({ ...bgm, volume: +e.target.value })} style={{ width: 90 }} />
              </>
            )}
            <span className="small muted">循环铺满、结尾淡出，压在人声下面</span>
          </div>
          <div className="row wrap">
            <b style={{ width: 70 }}>替换背景</b>
            <Seg
              value={bg.mode}
              options={[
                ['off', '不替换'],
                ['fixed', '固定一个'],
                ['random', '文件夹随机'],
              ]}
              onChange={(v) => (v === 'off' ? setBg({ ...bg, mode: v }) : pickInto(setBg as any, 'avatar', v === 'random'))}
            />
            {bg.mode !== 'off' && <span className="small">{bg.mode === 'fixed' ? fileName(bg.files[0] || '') : `${bg.files.length} 个`}</span>}
            <span className="small muted">把形象背景换成你的实拍图片或视频（视频会循环）</span>
          </div>
          <div className="row">
            <b style={{ width: 70 }}>自动字幕</b>
            <span className="small muted">识别音频并按右侧样式烧录字幕；标题、声明在右侧添加</span>
          </div>
          <div className="row" style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
            <span>清晰度</span>
            <select className="input" value={s.lipsync.resolution} onChange={(e) => save({ ...s, lipsync: { ...s.lipsync, resolution: e.target.value } })}>
              <option value="480">480p</option>
              <option value="720">720p</option>
              <option value="1080">1080p</option>
            </select>
            <span className="small muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 300 }}>
              输出：{outDir}
            </span>
            <button className="btn ghost sm" onClick={() => api.shell.open(outDir)}>
              <FolderOpen size={13} />
            </button>
            <span className="grow" />
            <button className="btn" disabled={!groups.length} onClick={() => enqueue(false)}>
              全部加入队列
            </button>
            <button className="btn primary" disabled={!groups.length} onClick={() => enqueue(true)}>
              <Play size={14} /> 加入并开始生成{total ? `（${total} 条）` : ''}
            </button>
          </div>
        </div>

        <div className="card" style={{ padding: 0 }}>
          <div className="row" style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)' }}>
            <b>生成队列</b>
            <span className="small muted">
              处理中 {c.running} · 排队 {c.pending} · 完成 {c.done} · 失败 {c.failed}
            </span>
            <span className="grow" />
            {active ? (
              <button className="btn sm" onClick={() => api.jobs.stop('lipsync')}>
                <Square size={12} /> 停止
              </button>
            ) : (
              <button className="btn sm primary" disabled={!c.pending && !c.failed} onClick={async () => {
                const failed = jobs.filter((j) => j.status === 'failed').map((j) => j.id);
                if (failed.length) await api.jobs.retry(failed);
                api.jobs.start('lipsync');
              }}>
                <Play size={12} /> 开始生成
              </button>
            )}
            <button
              className="btn sm"
              disabled={!c.done}
              onClick={async () => {
                const n = await api.publish.addToDraft(jobs.filter((j) => j.status === 'done' && j.output?.file).map((j) => j.output.file));
                toast(`已加入发布队列（待发布 ${n} 条）`);
              }}
            >
              <Send size={12} /> 加入发布队列
            </button>
            <button className="btn sm" onClick={() => api.jobs.clear('lipsync', 'finished')}>
              清除已完成
            </button>
            <button className="btn sm" onClick={() => api.jobs.clear('lipsync', 'all')}>
              清空任务
            </button>
          </div>
          {jobs.length === 0 ? (
            <div className="empty small">选好形象和音频，加入队列后开始生成。成品会自动带字幕。</div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>形象 × 音频</th>
                  <th style={{ width: 150 }}>状态</th>
                  <th style={{ width: 180 }}>进度</th>
                  <th style={{ width: 90 }} />
                </tr>
              </thead>
              <tbody>
                {jobs.map((j) => (
                  <tr key={j.id}>
                    <td className="file-cell">
                      <div className="name">
                        {avName(j.input.avatarId)} × {fileName(j.input.audio)}
                      </div>
                      <div className="meta">
                        {j.input.resolution}p{j.input.bgm?.mode !== 'off' ? ' · 背景音乐' : ''}
                        {j.input.bg?.mode !== 'off' ? ' · 换背景' : ''}
                        {j.input.look?.showSubs !== false ? ' · 字幕' : ''}
                      </div>
                      {j.error && <div className="err">{j.error}</div>}
                    </td>
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
      <StylePanel lookKey="lipsync" previewFile={preview} />
    </div>
  );
}

function AvatarTile({ a, on, onClick, onRemove }: { a: Avatar; on: boolean; onClick: () => void; onRemove: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <div className={'avatar' + (on ? ' on' : '')} onClick={onClick} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} title={a.name}>
      {hover && !a.isImage ? <video src={mediaUrl(a.file)} autoPlay muted loop /> : <img src={mediaUrl(a.thumb)} />}
      {on && (
        <span className="tick">
          <Check size={12} />
        </span>
      )}
      <div className="nm">
        {a.isImage ? <ImageIcon size={10} /> : fmtDur(a.duration)} {a.name}
      </div>
      <button
        className="btn sm x"
        style={{ height: 22, padding: '0 5px' }}
        onClick={(e) => {
          e.stopPropagation();
          onRemove();
        }}
      >
        <Trash2 size={11} />
      </button>
    </div>
  );
}
