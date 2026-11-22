import { useEffect, useMemo, useState } from 'react';
import { Send, Plug, Unplug, RefreshCw, FilePlus2, Trash2, X, FolderOpen, RotateCcw, Square, ChevronDown, ChevronRight, Wand2, Play } from 'lucide-react';
import { api, useJobs, useSettings, fileName } from '../api';
import { Seg, StatusBadge, Progress, toast, useCounts } from '../components/ui';

interface Draft {
  id: string;
  file: string;
  title: string;
  desc: string;
  tags: string[];
  schedule?: string;
}
interface Account {
  id: string;
  name: string;
  platform: string;
  status: string;
}
interface Status {
  connected: boolean;
  url?: string;
  serverName?: string;
  tools?: { name: string; title?: string; description?: string; inputSchema?: any }[];
  accountTool?: string;
  publishTool?: string;
  mapping?: Record<string, { source: string; value: string }>;
  sources?: Record<string, string>;
}
const errMsg = (e: any) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

export default function Publish() {
  const [s, save] = useSettings();
  const [st, setSt] = useState<Status>({ connected: false });
  useEffect(() => {
    api.vcat.status().then(setSt);
  }, []);
  if (!s) return null;
  return st.connected ? <Connected st={st} setSt={setSt} s={s} save={save} /> : <ConnectCard s={s} onConnected={setSt} />;
}

function ConnectCard({ s, onConnected }: { s: any; onConnected: (st: Status) => void }) {
  const [token, setToken] = useState('');
  const [show, setShow] = useState(false);
  const [port, setPort] = useState(String(s.publish?.port || 3199));
  const [remember, setRemember] = useState(true);
  const [hasToken, setHasToken] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => {
    api.vcat.hasToken().then(setHasToken);
  }, []);
  const connect = async () => {
    setBusy(true);
    setErr('');
    try {
      onConnected(await api.vcat.connect({ port, token: token.trim(), remember }));
      toast('已连接小V猫');
    } catch (e) {
      setErr(errMsg(e));
    }
    setBusy(false);
  };
  return (
    <div className="page" style={{ display: 'grid', placeItems: 'center' }}>
      <div className="card" style={{ width: 560, padding: 28, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ textAlign: 'center' }}>
          <Send size={26} className="c-accent" />
          <h2 style={{ margin: '10px 0 4px' }}>把成品一键发到多个账号</h2>
          <div className="muted small">需要先连接本机的「小V猫」（3.0.0 以上），只需配置一次</div>
        </div>
        <ol className="small" style={{ lineHeight: 2, margin: 0, paddingLeft: 20, color: 'var(--text-2)' }}>
          <li>打开小V猫，进入「设置 → MCP 接入」，打开「启用 MCP」</li>
          <li>在「写入权限」里勾选「内容发布」</li>
          <li>点「复制令牌」，粘贴到下面，再点「连接」</li>
        </ol>
        <div className="field" style={{ gridTemplateColumns: '70px 1fr auto' }}>
          <label>访问令牌</label>
          <input
            className="input"
            type={show ? 'text' : 'password'}
            placeholder={hasToken ? '已保存在钥匙串（留空直接用）' : 'vcat_mcp_...'}
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
          <button className="btn ghost sm" onClick={() => setShow(!show)}>
            {show ? '隐藏' : '显示'}
          </button>
        </div>
        <div className="field" style={{ gridTemplateColumns: '70px 100px 1fr auto' }}>
          <label>端口</label>
          <input className="input" value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))} />
          <span className="small muted">默认 3199，找不到时会自动试后面几个端口</span>
          <button className="btn primary" disabled={busy || (!token.trim() && !hasToken)} onClick={connect}>
            <Plug size={14} /> {busy ? '连接中…' : '连接'}
          </button>
        </div>
        <label className="row small muted">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> 记住令牌（用系统钥匙串加密保存）
          {hasToken && (
            <button
              className="btn ghost sm"
              onClick={async () => {
                await api.vcat.forgetToken();
                setHasToken(false);
                toast('已删除保存的令牌');
              }}
            >
              删除已保存的令牌
            </button>
          )}
        </label>
        {err && <div className="err" style={{ maxWidth: 'none' }}>{err}</div>}
      </div>
    </div>
  );
}

function Connected({ st, setSt, s, save }: { st: Status; setSt: (x: Status) => void; s: any; save: (x: any) => any }) {
  const { jobs, active } = useJobs('publish');
  const c = useCounts(jobs);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selAcc, setSelAcc] = useState<string[]>([]);
  const [rawReply, setRawReply] = useState('');
  const [showRaw, setShowRaw] = useState(false);
  const [accountTool, setAccountTool] = useState(st.accountTool || '');
  const [publishTool, setPublishTool] = useState(st.publishTool || '');
  const [mapping, setMapping] = useState(st.mapping || {});
  const [mode, setMode] = useState<'all' | 'split' | 'pair'>('all');
  const [interval, setInterval_] = useState<number>(s.publish?.interval ?? 30);
  const [loadingAcc, setLoadingAcc] = useState(false);

  const tools = st.tools || [];
  const pTool = tools.find((t) => t.name === publishTool);
  const props: Record<string, any> = pTool?.inputSchema?.properties || {};
  const required: string[] = pTool?.inputSchema?.required || [];

  useEffect(() => {
    api.publish.draft().then(setDrafts);
  }, []);
  const saveDrafts = (d: Draft[]) => {
    setDrafts(d);
    api.publish.saveDraft(d);
  };
  const loadAccounts = async () => {
    if (!accountTool) return toast('先选「账号列表」工具', true);
    setLoadingAcc(true);
    try {
      const r = await api.vcat.accounts(accountTool, {});
      setAccounts(r.accounts);
      setRawReply(r.raw);
      if (!r.accounts.length) toast('工具返回里没识别出账号，点「查看原始返回」看看格式', true);
    } catch (e) {
      toast(errMsg(e), true);
    }
    setLoadingAcc(false);
  };
  useEffect(() => {
    if (accountTool) loadAccounts();
  }, [accountTool]);

  const persist = (patch: any) => save({ ...s, publish: { ...s.publish, ...patch } });
  const changePublishTool = async (name: string) => {
    setPublishTool(name);
    const saved = s.publish?.mapping?.[name];
    setMapping(saved && Object.keys(saved).length ? saved : await api.vcat.autoMapping(name));
    persist({ toolName: name });
  };
  const setMap = (k: string, patch: any) => {
    const m = { ...mapping, [k]: { ...(mapping[k] || { source: 'skip', value: '' }), ...patch } };
    setMapping(m);
    persist({ mapping: { ...(s.publish?.mapping || {}), [publishTool]: m } });
  };

  const addFiles = async () => {
    const files: string[] = await api.dialog.open({ group: 'video' });
    if (!files.length) return;
    await api.publish.addToDraft(files);
    setDrafts(await api.publish.draft());
  };

  const missing = required.filter((k) => !mapping[k] || mapping[k].source === 'skip');
  const chosen = accounts.filter((a) => selAcc.includes(a.id));
  const plan = useMemo(() => {
    if (!chosen.length) return [] as { d: Draft; accs: Account[] }[];
    if (mode === 'all') return drafts.map((d) => ({ d, accs: chosen }));
    if (mode === 'split') return drafts.map((d, i) => ({ d, accs: [chosen[i % chosen.length]] }));
    return drafts.slice(0, chosen.length).map((d, i) => ({ d, accs: [chosen[i]] }));
  }, [drafts, chosen, mode]);

  const startPublish = async () => {
    if (!publishTool) return toast('先选「发布作品」工具', true);
    if (missing.length) return toast(`发布工具的必填参数还没对照：${missing.join('、')}`, true);
    if (!plan.length) return toast('先选视频和账号', true);
    const items = plan.map(({ d, accs }) => ({
      item: { file: d.file, title: d.title, desc: d.desc, tags: d.tags, schedule: d.schedule ? new Date(d.schedule).toISOString() : undefined },
      accounts: accs,
      toolName: publishTool,
      mapping,
      interval,
    }));
    await api.jobs.add('publish', items);
    await api.jobs.start('publish');
    const sent = new Set(plan.map((p) => p.d.id));
    saveDrafts(drafts.filter((d) => !sent.has(d.id)));
    toast(`已加入 ${items.length} 条发布任务`);
  };

  return (
    <div className="page with-side">
      <div className="page-body">
        <div className="card row" style={{ padding: '10px 14px' }}>
          <span className="dot ok" />
          <span>
            已连接小V猫{st.serverName ? `（${st.serverName}）` : ''} · <span className="muted small">{st.url}</span> · <span className="muted small">{tools.length} 个工具</span>
          </span>
          <span className="grow" />
          <button
            className="btn sm"
            onClick={async () => {
              await api.vcat.disconnect();
              setSt({ connected: false });
            }}
          >
            <Unplug size={13} /> 断开
          </button>
        </div>

        <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div className="row">
            <div className="card-title">
              待发布视频 <span className="hint">{drafts.length} 条 · 字幕烧录、数字人页面的「加入发布队列」会加到这里</span>
            </div>
            <span className="grow" />
            <button className="btn sm primary" onClick={addFiles}>
              <FilePlus2 size={13} /> 添加视频
            </button>
            {drafts.length > 0 && (
              <button className="btn sm" onClick={() => saveDrafts([])}>
                清空
              </button>
            )}
          </div>
          {drafts.length === 0 && <div className="empty small">还没有待发布的视频</div>}
          {drafts.map((d, i) => (
            <div key={d.id} style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 10, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <div className="row" style={{ gridColumn: '1 / 3' }}>
                <span className="badge">{i + 1}</span>
                <span className="small" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {fileName(d.file)}
                </span>
                <span className="grow" />
                <button className="btn ghost sm" onClick={() => api.shell.show(d.file)}>
                  <FolderOpen size={12} />
                </button>
                <button className="btn ghost sm" onClick={() => saveDrafts(drafts.filter((x) => x.id !== d.id))}>
                  <X size={12} />
                </button>
              </div>
              <input className="input" placeholder="标题" value={d.title} onChange={(e) => saveDrafts(drafts.map((x) => (x.id === d.id ? { ...x, title: e.target.value } : x)))} />
              <input
                className="input"
                placeholder="话题，用逗号或空格分开"
                value={d.tags.join('，')}
                onChange={(e) => saveDrafts(drafts.map((x) => (x.id === d.id ? { ...x, tags: e.target.value.split(/[,，\s#]+/).filter(Boolean) } : x)))}
              />
              <textarea
                className="input"
                rows={2}
                placeholder="描述 / 正文"
                value={d.desc}
                onChange={(e) => saveDrafts(drafts.map((x) => (x.id === d.id ? { ...x, desc: e.target.value } : x)))}
              />
              <div className="row" style={{ alignItems: 'flex-start' }}>
                <span className="small muted" style={{ paddingTop: 8 }}>定时</span>
                <input
                  className="input grow"
                  type="datetime-local"
                  value={d.schedule || ''}
                  onChange={(e) => saveDrafts(drafts.map((x) => (x.id === d.id ? { ...x, schedule: e.target.value } : x)))}
                />
              </div>
            </div>
          ))}
        </div>

        <div className="card" style={{ padding: 0 }}>
          <div className="row" style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)' }}>
            <b>发布队列</b>
            <span className="small muted">
              发布中 {c.running} · 排队 {c.pending} · 完成 {c.done} · 失败 {c.failed}
            </span>
            <span className="grow" />
            {active ? (
              <button className="btn sm" onClick={() => api.jobs.stop('publish')}>
                <Square size={12} /> 停止
              </button>
            ) : (
              c.pending + c.failed > 0 && (
                <button
                  className="btn sm primary"
                  onClick={async () => {
                    const failed = jobs.filter((j) => j.status === 'failed').map((j) => j.id);
                    if (failed.length) await api.jobs.retry(failed);
                    api.jobs.start('publish');
                  }}
                >
                  <Play size={12} /> 继续
                </button>
              )
            )}
            <button className="btn sm" onClick={() => api.jobs.clear('publish', 'finished')}>
              清除已完成
            </button>
          </div>
          {jobs.length === 0 ? (
            <div className="empty small">选好视频和账号后点「开始发布」</div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>视频 → 账号</th>
                  <th style={{ width: 150 }}>状态</th>
                  <th style={{ width: 160 }}>进度</th>
                  <th style={{ width: 70 }} />
                </tr>
              </thead>
              <tbody>
                {jobs.map((j) => (
                  <tr key={j.id}>
                    <td className="file-cell">
                      <div className="name">{j.input.item.title || fileName(j.input.item.file)}</div>
                      <div className="meta">→ {j.input.accounts.map((a: Account) => `${a.platform ? a.platform + '·' : ''}${a.name}`).join('、')}</div>
                      {j.output?.results?.map((r: any, i: number) => (
                        <div key={i} className="meta" style={{ whiteSpace: 'pre-wrap' }}>
                          小V猫：{r.reply}
                        </div>
                      ))}
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
                        {j.status === 'failed' && (
                          <button
                            className="btn ghost sm"
                            onClick={async () => {
                              await api.jobs.retry([j.id]);
                              api.jobs.start('publish');
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
          )}
        </div>
      </div>

      <div className="side">
        <div className="card-title">账号</div>
        <div className="row">
          <select className="input grow" value={accountTool} onChange={(e) => (setAccountTool(e.target.value), persist({ accountTool: e.target.value }))}>
            <option value="">选择「账号列表」工具</option>
            {tools.map((t) => (
              <option key={t.name} value={t.name}>
                {t.title || t.name}
              </option>
            ))}
          </select>
          <button className="btn sm" onClick={loadAccounts} disabled={loadingAcc}>
            <RefreshCw size={13} />
          </button>
        </div>
        {accounts.length > 0 && (
          <div className="list-box">
            <div className="hd">
              <input type="checkbox" checked={selAcc.length === accounts.length} onChange={(e) => setSelAcc(e.target.checked ? accounts.map((a) => a.id) : [])} />
              <span className="small">全选（已选 {selAcc.length}/{accounts.length}）</span>
            </div>
            <div className="bd" style={{ maxHeight: 220 }}>
              {accounts.map((a) => (
                <label key={a.id} className="row small" style={{ padding: '4px 0' }}>
                  <input type="checkbox" checked={selAcc.includes(a.id)} onChange={(e) => setSelAcc(e.target.checked ? [...selAcc, a.id] : selAcc.filter((x) => x !== a.id))} />
                  {a.platform && <span className="badge">{a.platform}</span>}
                  <span className="grow">{a.name}</span>
                  {a.status && <span className="muted">{a.status}</span>}
                </label>
              ))}
            </div>
          </div>
        )}
        {rawReply && (
          <div>
            <button className="btn ghost sm" onClick={() => setShowRaw(!showRaw)}>
              {showRaw ? <ChevronDown size={12} /> : <ChevronRight size={12} />} 查看原始返回
            </button>
            {showRaw && <pre className="small" style={{ whiteSpace: 'pre-wrap', userSelect: 'text', background: 'var(--bg)', padding: 8, borderRadius: 8, maxHeight: 160, overflow: 'auto' }}>{rawReply}</pre>}
          </div>
        )}

        <div className="card-title" style={{ marginTop: 6 }}>发布工具</div>
        <select className="input" value={publishTool} onChange={(e) => changePublishTool(e.target.value)}>
          <option value="">选择「发布作品」工具</option>
          {tools.map((t) => (
            <option key={t.name} value={t.name}>
              {t.title || t.name}
            </option>
          ))}
        </select>
        {pTool?.description && <div className="small muted" style={{ lineHeight: 1.6 }}>{pTool.description}</div>}
        {pTool && (
          <div>
            <div className="row" style={{ marginBottom: 6 }}>
              <h4>参数对照</h4>
              <span className="grow" />
              <button className="btn ghost sm" onClick={async () => setMapping(await api.vcat.autoMapping(publishTool))}>
                <Wand2 size={12} /> 自动对照
              </button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {Object.entries(props).map(([k, p]) => (
                <div key={k} style={{ display: 'grid', gridTemplateColumns: '104px minmax(0, 1fr)', gap: 6, alignItems: 'center' }}>
                  <span className="small" title={p.description || ''} style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {k}
                    {required.includes(k) && <span className="c-red">*</span>}
                    <span className="muted"> {p.type || ''}</span>
                  </span>
                  <div className="row" style={{ minWidth: 0 }}>
                    <select className="input grow" style={{ height: 28, minWidth: 0, width: '100%' }} value={mapping[k]?.source || 'skip'} onChange={(e) => setMap(k, { source: e.target.value })}>
                      {Object.entries(st.sources || {}).map(([v, l]) => (
                        <option key={v} value={v}>
                          {l}
                        </option>
                      ))}
                    </select>
                    {mapping[k]?.source === 'const' && (
                      <input className="input" style={{ height: 28, width: 80 }} value={mapping[k]?.value || ''} onChange={(e) => setMap(k, { value: e.target.value })} />
                    )}
                  </div>
                </div>
              ))}
            </div>
            {missing.length > 0 && <div className="err">必填参数还没对照：{missing.join('、')}</div>}
          </div>
        )}

        <div className="card-title" style={{ marginTop: 6 }}>分发方式</div>
        <Seg
          value={mode}
          options={[
            ['all', '每条发所有账号'],
            ['split', '均分'],
            ['pair', '一一对应'],
          ]}
          onChange={setMode}
        />
        <div className="small muted" style={{ lineHeight: 1.6 }}>
          {mode === 'all' && '每条视频都发到选中的所有账号'}
          {mode === 'split' && '视频按顺序轮流分给选中的账号，每个账号发不同的视频'}
          {mode === 'pair' && '第 1 条发第 1 个账号，第 2 条发第 2 个……多出来的视频不发'}
        </div>
        <div className="row">
          <span className="small">每次发布间隔</span>
          <input
            className="input"
            type="number"
            min={0}
            max={3600}
            value={interval}
            onChange={(e) => (setInterval_(+e.target.value), persist({ interval: +e.target.value }))}
            style={{ width: 80 }}
          />
          <span className="small muted">秒</span>
        </div>
        <div style={{ position: 'sticky', bottom: -16, background: '#0f0f15', padding: '10px 0', marginTop: 'auto' }}>
          <div className="small muted" style={{ marginBottom: 6 }}>
            将发布 {plan.length} 条视频，共 {plan.reduce((a, p) => a + p.accs.length, 0)} 次（视频 × 账号）
          </div>
          <button className="btn primary" style={{ width: '100%', justifyContent: 'center' }} disabled={!plan.length || !publishTool} onClick={startPublish}>
            <Send size={14} /> 开始发布
          </button>
        </div>
      </div>
    </div>
  );
}
