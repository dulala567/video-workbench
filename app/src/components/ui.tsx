import { ReactNode, useEffect, useState, DragEvent } from 'react';
import { api, Job } from '../api';

export function Toggle({ on, onChange, disabled }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return <button className={'toggle' + (on ? ' on' : '')} disabled={disabled} onClick={() => onChange(!on)} />;
}

export function Seg<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="seg">
      {options.map(([v, l]) => (
        <button key={v} className={v === value ? 'on' : ''} onClick={() => onChange(v)}>
          {l}
        </button>
      ))}
    </div>
  );
}

// 拖放：接收文件或文件夹，展开成指定类型的媒体文件
export function useDrop(group: string, onFiles: (files: string[]) => void) {
  const [over, setOver] = useState(false);
  return {
    over,
    props: {
      onDragOver: (e: DragEvent) => {
        e.preventDefault();
        setOver(true);
      },
      onDragLeave: () => setOver(false),
      onDrop: async (e: DragEvent) => {
        e.preventDefault();
        setOver(false);
        const items = Array.from(e.dataTransfer.files).map((f) => api.pathForFile(f));
        const files = await api.fs.expand({ items, group });
        if (files.length) onFiles(files);
        else toast('没有找到支持的文件', true);
      },
    },
  };
}

export function Empty({ icon, title, desc, children }: { icon: ReactNode; title: string; desc?: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <div>
        <div className="icon">{icon}</div>
        <h3>{title}</h3>
        {desc && <div className="small">{desc}</div>}
        {children && <div className="row" style={{ justifyContent: 'center', marginTop: 16 }}>{children}</div>}
      </div>
    </div>
  );
}

export function Stats({ items }: { items: { label: string; value: ReactNode; cls?: string }[] }) {
  return (
    <div className="stats" style={{ gridTemplateColumns: `repeat(${items.length}, 1fr)` }}>
      {items.map((it) => (
        <div className="stat" key={it.label}>
          <div className="label">{it.label}</div>
          <div className={'value ' + (it.cls || '')}>{it.value}</div>
        </div>
      ))}
    </div>
  );
}

const STATUS: Record<string, [string, string]> = {
  pending: ['待处理', 'var(--muted)'],
  running: ['处理中', 'var(--orange)'],
  done: ['已完成', 'var(--green)'],
  failed: ['失败', 'var(--red)'],
};
export function StatusBadge({ job }: { job: Job }) {
  const [label, color] = STATUS[job.status];
  return (
    <span className="badge">
      <span className="dot" style={{ background: color }} />
      {job.status === 'running' && job.stage ? job.stage : job.output?.skipped ? '已跳过' : label}
    </span>
  );
}

export function Progress({ job }: { job: Job }) {
  if (job.status === 'pending') return <span className="muted small">—</span>;
  return (
    <div className="row">
      <div className="progress grow">
        <div style={{ width: `${Math.round(job.progress * 100)}%`, background: job.status === 'failed' ? 'var(--red)' : undefined }} />
      </div>
      <span className="small muted" style={{ width: 34, textAlign: 'right' }}>
        {Math.round(job.progress * 100)}%
      </span>
    </div>
  );
}

// ---------- 轻提示 ----------
let pushToast: (m: { text: string; error?: boolean }) => void = () => {};
export function toast(text: string, error = false) {
  pushToast({ text, error });
}
export function ToastHost() {
  const [m, setM] = useState<{ text: string; error?: boolean } | null>(null);
  useEffect(() => {
    let t: any;
    pushToast = (x) => {
      setM(x);
      clearTimeout(t);
      t = setTimeout(() => setM(null), x.error ? 5000 : 2500);
    };
  }, []);
  return m ? <div className={'toast' + (m.error ? ' error' : '')}>{m.text}</div> : null;
}

export function useCounts(jobs: Job[]) {
  const c = { all: jobs.length, pending: 0, running: 0, done: 0, failed: 0 };
  for (const j of jobs) c[j.status]++;
  return c;
}
