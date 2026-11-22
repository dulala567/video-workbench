import { useEffect, useState } from 'react';
import { Captions, MessageSquareText, FileText, AudioLines, ListChecks, CircleCheck, ArrowRight, Check, X, FolderOpen, CloudDownload, Send, Mic } from 'lucide-react';
import { api, useJobs, useEnv, today, fileName, Kind } from '../api';
import { Progress } from '../components/ui';
import { useAvatars } from './Lipsync';

const KIND_NAME: Record<Kind, string> = { lipsync: '数字人', burn: '字幕烧录', text: '转文字', mp3: '音频提取', collect: '采集', publish: '发布', tts: 'AI 配音' };

export default function Dashboard({ go }: { go: (p: string) => void }) {
  const { jobs } = useJobs();
  const env = useEnv();
  const [avatars] = useAvatars();
  const [stats, setStats] = useState<Record<string, Record<string, number>>>({});
  const [hideGuide, setHideGuide] = useState(() => localStorage.getItem('hideGuide') === '1');
  useEffect(() => {
    api.stats.get().then(setStats);
  }, [jobs.filter((j) => j.status === 'done').length]);

  const d = today();
  const y = new Date(Date.now() - 864e5).toLocaleDateString('sv-SE');
  const t = stats[d] || {};
  const yd = stats[y] || {};
  const diff = (k: string) => {
    const n = (t[k] || 0) - (yd[k] || 0);
    return n === 0 ? '与昨日持平' : `较昨日 ${n > 0 ? '+' : ''}${n}`;
  };
  // 本周、累计、连续天数
  const days = Object.keys(stats).sort();
  const sum = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);
  const weekStart = new Date();
  weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7));
  const week = days.filter((x) => x >= weekStart.toLocaleDateString('sv-SE')).reduce((a, x) => a + sum(stats[x]), 0);
  const all = days.reduce((a, x) => a + sum(stats[x]), 0);
  let streak = 0;
  for (let i = 0; ; i++) {
    const k = new Date(Date.now() - i * 864e5).toLocaleDateString('sv-SE');
    if (stats[k] && sum(stats[k]) > 0) streak++;
    else if (i > 0) break;
    else continue;
    if (i > 3650) break;
  }

  const running = jobs.filter((j) => j.status === 'running' || j.status === 'pending').slice(0, 6);
  const recent = jobs
    .filter((j) => j.status === 'done' && j.output?.file)
    .sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0))
    .slice(0, 6);
  const countOf = (k: Kind, st: string) => jobs.filter((j) => j.kind === k && j.status === st).length;

  const steps = [
    { title: '准备数字人组件', desc: '口型模型和运行环境，首次需要下载', done: !!env?.lipsync.ready },
    { title: '准备字幕识别模型', desc: '用于自动识别语音并烧录字幕', done: !!env?.whisperModel },
    { title: '添加一个数字人形象', desc: '一段清晰的正脸视频或照片', done: avatars.length > 0, go: 'lipsync' },
    { title: '生成第一条数字人视频', desc: '选形象、选音频、加入队列', done: (stats && Object.values(stats).some((x) => x.lipsync)) || false, go: 'lipsync' },
  ];
  const doneSteps = steps.filter((s) => s.done).length;
  const curStep = steps.findIndex((s) => !s.done);

  const cards = [
    { k: 'lipsync' as Kind, icon: <MessageSquareText size={18} />, title: '数字人口型', desc: '形象 + 音频，批量生成口播视频' },
    { k: 'burn' as Kind, icon: <Captions size={18} />, title: '字幕烧录', desc: '识别语音，把字幕和标题烧进视频' },
    { k: 'text' as Kind, icon: <FileText size={18} />, title: '转文字', desc: '视频音频转文案，一键复制' },
    { k: 'tts' as Kind, icon: <Mic size={18} />, title: 'AI 配音', desc: '豆包语音配音，或一段提示词生成整段音频' },
  ];
  const minor = [
    { k: 'collect' as Kind, icon: <CloudDownload size={14} />, title: '采集中心', desc: '采集视频素材' },
    { k: 'mp3' as Kind, icon: <AudioLines size={14} />, title: '音频提取', desc: '视频转 MP3 / WAV 等' },
    { k: 'publish' as Kind, icon: <Send size={14} />, title: '发布到账号', desc: '通过小V猫批量发布' },
  ];

  return (
    <div className="page" style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 1200, margin: '0 auto', width: '100%' }}>
      <div className="card">
        <div className="row">
          <b>今日成绩</b>
          <span className="small muted">{new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' })}</span>
        </div>
        <div className="row" style={{ gap: 10, marginTop: 12 }}>
          {(['lipsync', 'burn', 'tts', 'text', 'mp3'] as Kind[]).map((k) => (
            <div key={k} className="card grow" style={{ padding: '12px 16px', background: 'var(--panel-2)' }}>
              <div className="small muted">{KIND_NAME[k]}</div>
              <div style={{ fontSize: 26, fontWeight: 700, marginTop: 2 }}>
                {t[k] || 0}
                <span className="small muted" style={{ fontWeight: 400 }}>
                  {' '}
                  {k === 'lipsync' || k === 'burn' || k === 'tts' ? '条' : '个'}
                </span>
              </div>
              <div className="small muted">{diff(k)}</div>
            </div>
          ))}
        </div>
        <div className="row small" style={{ marginTop: 12, borderTop: '1px solid var(--border)', paddingTop: 10, gap: 16 }}>
          <span className="badge" style={{ background: 'var(--accent-bg)', color: 'var(--accent-2)' }}>
            连续使用 {streak} 天
          </span>
          <span>
            本周 <b>{week}</b> 条
          </span>
          <span>
            累计 <b>{all}</b> 条
          </span>
        </div>
      </div>

      {!hideGuide && doneSteps < 4 && (
        <div className="card">
          <div className="row">
            <b>快速上手</b>
            <span className="small muted">完成这 4 步，就能生成第一条数字人视频（{doneSteps}/4）</span>
            <span className="grow" />
            <button
              className="btn ghost sm"
              onClick={() => {
                localStorage.setItem('hideGuide', '1');
                setHideGuide(true);
              }}
            >
              <X size={12} /> 不再显示
            </button>
          </div>
          <div className="steps">
            {steps.map((s, i) => (
              <div key={i} className={'step' + (s.done ? ' done' : '') + (i === curStep ? ' cur' : '')}>
                <span className="num">{s.done ? <Check size={12} /> : i + 1}</span>
                <div className="grow">
                  <div style={{ fontWeight: 600 }}>{s.title}</div>
                  <div className="small muted" style={{ marginTop: 3 }}>
                    {s.desc}
                  </div>
                </div>
                {i === curStep && s.go && (
                  <button className="btn primary sm" onClick={() => go(s.go!)}>
                    去完成 <ArrowRight size={12} />
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="module-cards">
        {cards.map((m) => (
          <div key={m.k} className="card module-card" onClick={() => go(m.k)}>
            <div className="ic">{m.icon}</div>
            <h3>{m.title}</h3>
            <div className="small muted">{m.desc}</div>
            <div className="small muted" style={{ marginTop: 18 }}>
              {countOf(m.k, 'running')} 进行中 · 今日完成 {t[m.k] || 0}
            </div>
          </div>
        ))}
      </div>

      <div className="row" style={{ gap: 10 }}>
        {minor.map((m) => (
          <button key={m.k} className="btn" onClick={() => go(m.k)}>
            {m.icon} {m.title} <span className="muted small">{m.desc}</span>
          </button>
        ))}
      </div>

      <div className="row" style={{ alignItems: 'stretch', gap: 14 }}>
        <div className="card grow" style={{ minHeight: 220, flexBasis: 0 }}>
          <b>进行中的任务</b>
          {running.length === 0 ? (
            <div className="empty small">
              <div>
                <div className="icon">
                  <ListChecks size={22} />
                </div>
                <div style={{ color: 'var(--text)', fontWeight: 600 }}>当前没有进行中的任务</div>
                <div>添加任务后会在这里显示实时进度</div>
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 12 }}>
              {running.map((j) => (
                <div key={j.id}>
                  <div className="row small">
                    <span className="badge">{KIND_NAME[j.kind]}</span>
                    <span className="grow" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {j.kind === 'collect' ? j.input.url : fileName(j.input.file || j.input.item?.file || j.input.audio || '')}
                    </span>
                    <span className="muted">{j.status === 'pending' ? '排队中' : j.stage}</span>
                  </div>
                  <div style={{ marginTop: 6 }}>
                    <Progress job={j} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="card grow" style={{ minHeight: 220, flexBasis: 0 }}>
          <b>最近完成</b>
          {recent.length === 0 ? (
            <div className="empty small">
              <div>
                <div className="icon">
                  <CircleCheck size={22} />
                </div>
                <div style={{ color: 'var(--text)', fontWeight: 600 }}>还没有完成的任务</div>
                <div>完成后可以在这里直接打开位置</div>
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8 }}>
              {recent.map((j) => (
                <div key={j.id} className="row small" style={{ padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
                  <span className="badge">{KIND_NAME[j.kind]}</span>
                  <span className="grow" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {fileName(j.output.file)}
                  </span>
                  <button className="btn ghost sm" onClick={() => api.shell.show(j.output.file)}>
                    <FolderOpen size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
