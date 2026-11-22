// 统一任务队列：每类任务（burn/lipsync/mp3/text）各自一条队列，各自的并发数、开始/暂停/停止。
const { store } = require('./store.cjs');

const KINDS = ['burn', 'lipsync', 'mp3', 'text', 'collect', 'publish', 'tts'];

class Queue {
  constructor({ handlers, concurrencyOf, onChange }) {
    this.handlers = handlers; // kind -> async (job, ctx) => output
    this.concurrencyOf = concurrencyOf; // kind -> number
    this.onChange = onChange;
    this.running = new Map(); // jobId -> AbortController
    this.active = Object.fromEntries(KINDS.map((k) => [k, false]));
    // 上次退出时还在跑的任务，恢复成待处理
    this.jobs = store.getJobs().filter((j) => KINDS.includes(j.kind)).map((j) => (j.status === 'running' ? { ...j, status: 'pending', progress: 0, stage: '' } : j));
    this.saveTimer = null;
    this.emitTimer = null;
  }

  snapshot() {
    return { jobs: this.jobs, active: this.active };
  }

  changed(immediate = false) {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => store.saveJobs(this.jobs), 500);
    if (immediate) {
      clearTimeout(this.emitTimer);
      this.emitTimer = null;
      this.onChange(this.snapshot());
    } else if (!this.emitTimer) {
      this.emitTimer = setTimeout(() => {
        this.emitTimer = null;
        this.onChange(this.snapshot());
      }, 150);
    }
  }

  add(kind, items) {
    const now = Date.now();
    const added = items.map((input, i) => ({
      id: `${kind}-${now}-${i}-${Math.random().toString(36).slice(2, 7)}`,
      kind,
      status: 'pending',
      progress: 0,
      stage: '',
      input, // 各任务自己的参数（文件路径、样式等）
      output: null,
      error: null,
      createdAt: now + i,
      finishedAt: null,
    }));
    this.jobs.push(...added);
    this.changed(true);
    this.pump();
    return added.map((j) => j.id);
  }

  update(id, patch) {
    const j = this.jobs.find((x) => x.id === id);
    if (!j) return;
    Object.assign(j, patch);
    this.changed(patch.status !== undefined);
  }

  start(kind) {
    this.active[kind] = true;
    // 失败的任务重新开始时也重试
    this.changed(true);
    this.pump();
  }
  pause(kind) {
    this.active[kind] = false;
    this.changed(true);
  }
  stop(kind) {
    this.active[kind] = false;
    for (const j of this.jobs) {
      if (j.kind === kind && j.status === 'running') this.running.get(j.id)?.abort();
    }
    this.changed(true);
  }
  retry(ids) {
    for (const j of this.jobs) {
      if (ids.includes(j.id) && (j.status === 'failed' || j.status === 'done')) {
        Object.assign(j, { status: 'pending', progress: 0, stage: '', error: null });
      }
    }
    this.changed(true);
    this.pump();
  }
  remove(ids) {
    for (const id of ids) this.running.get(id)?.abort();
    this.jobs = this.jobs.filter((j) => !ids.includes(j.id));
    this.changed(true);
  }
  clear(kind, which) {
    // which: 'pending' | 'finished' | 'all'
    const match = (j) =>
      j.kind === kind &&
      (which === 'all' ? j.status !== 'running' : which === 'pending' ? j.status === 'pending' : ['done', 'failed'].includes(j.status));
    this.jobs = this.jobs.filter((j) => !match(j));
    this.changed(true);
  }
  updateInputs(ids, patch) {
    for (const j of this.jobs) {
      if (ids.includes(j.id) && j.status !== 'running') j.input = { ...j.input, ...patch };
    }
    this.changed(true);
  }

  pump() {
    for (const kind of KINDS) {
      if (!this.active[kind]) continue;
      const limit = Math.max(1, this.concurrencyOf(kind));
      let runningCount = this.jobs.filter((j) => j.kind === kind && j.status === 'running').length;
      const pending = this.jobs.filter((j) => j.kind === kind && j.status === 'pending').sort((a, b) => a.createdAt - b.createdAt);
      for (const job of pending) {
        if (runningCount >= limit) break;
        runningCount++;
        this.runJob(job);
      }
      if (runningCount === 0 && pending.length === 0) {
        this.active[kind] = false; // 这一类全部跑完，自动停
        this.changed(true);
      }
    }
  }

  async runJob(job) {
    const ac = new AbortController();
    this.running.set(job.id, ac);
    this.update(job.id, { status: 'running', progress: 0, stage: '准备中', error: null });
    const ctx = {
      signal: ac.signal,
      progress: (p, stage) => this.update(job.id, { progress: Math.max(0, Math.min(1, p)), ...(stage ? { stage } : {}) }),
      seq: this.jobs.filter((j) => j.kind === job.kind).sort((a, b) => a.createdAt - b.createdAt).findIndex((j) => j.id === job.id) + 1,
      // 任务完成后顺手把产物交给另一类队列（比如采集完自动加入字幕烧录）
      enqueue: (kind, items, autoStart) => {
        const ids = this.add(kind, items);
        if (autoStart) this.start(kind);
        return ids;
      },
    };
    try {
      const output = await this.handlers[job.kind](job, ctx);
      this.update(job.id, { status: 'done', progress: 1, stage: '', output, finishedAt: Date.now() });
      store.bumpStat(job.kind);
    } catch (e) {
      if (ac.signal.aborted) {
        this.update(job.id, { status: 'pending', progress: 0, stage: '' });
      } else {
        console.error(e);
        this.update(job.id, { status: 'failed', stage: '', error: String(e.message || e), finishedAt: Date.now() });
      }
    } finally {
      this.running.delete(job.id);
      this.pump();
    }
  }
}

module.exports = { Queue, KINDS };
