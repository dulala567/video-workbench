import { useEffect, useMemo, useRef, useState } from 'react';
import { Mic, Play, Square as StopIcon, KeyRound, Wand2, FolderOpen, X, RotateCcw, Search, UserRound, Send, ImagePlus, FileAudio, Plus, Sparkles } from 'lucide-react';
import voicesJson from '../../shared/doubao-voices.json';
import { api, useJobs, useSettings, fileName, mediaUrl, fmtDur, IS_WIN } from '../api';
import { Seg, StatusBadge, Progress, toast, useCounts } from '../components/ui';

interface Voice {
  id: string;
  name: string;
  scene: string;
  gender: '女' | '男';
  dialect: boolean;
}
const VOICES = (voicesJson as any).voices as Voice[];
// 音频生成的参考素材：音色 ID / 音频文件（提示词里用 @音频N 引用）/ 一张图片
type Ref = { type: 'voice'; id: string; name: string } | { type: 'audio'; file: string } | { type: 'image'; file: string };
const GEN_MAX = 3000;
const GEN_PLACEHOLDER =
  '一段提示词同时描述对白、情绪、配乐和音效，模型一次生成完整音频。例如：\n\n总时长约 20 秒。开头是清晨的鸟鸣和轻柔的钢琴。一位年轻女性（@音频1）用温柔、带笑意的语气说：“早上好，今天给大家分享三个提高效率的小习惯。”然后音乐渐强，转为轻快的节奏。\n\n用空行隔开就是多条，每条单独生成。';
const loadRefs = (): Ref[] => {
  try {
    return JSON.parse(localStorage.getItem('ttsRefs') || '[]');
  } catch {
    return [];
  }
};
const errMsg = (e: any) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

// 把文案切成多条：空行分段 / 每行一条 / 整篇一条
function splitScripts(text: string, mode: string) {
  const t = text.replace(/\r/g, '').trim();
  if (!t) return [];
  if (mode === 'all') return [t];
  const parts = mode === 'line' ? t.split(/\n+/) : t.split(/\n\s*\n+/);
  return parts.map((x) => x.trim()).filter(Boolean);
}

export default function Tts({ go }: { go: (p: string) => void }) {
  const [s, save] = useSettings();
  const { jobs, active } = useJobs('tts');
  const c = useCounts(jobs);
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [keyInput, setKeyInput] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [checking, setChecking] = useState(false);
  const [q, setQ] = useState('');
  const [gender, setGender] = useState<'all' | '女' | '男'>('all');
  const [scene, setScene] = useState('全部');
  const [text, setText] = useState(() => localStorage.getItem('ttsDraft') || '');
  const [playing, setPlaying] = useState<string | null>(null);
  const [loadingSample, setLoadingSample] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const [refs, setRefs] = useState<Ref[]>(loadRefs);
  const area = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    try {
      localStorage.setItem('ttsRefs', JSON.stringify(refs));
    } catch {}
  }, [refs]);

  useEffect(() => {
    api.tts.hasKey().then(setHasKey);
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem('ttsDraft', text);
    } catch {}
  }, [text]);

  const scenes = useMemo(() => ['全部', ...Array.from(new Set(VOICES.map((v) => v.scene)))], []);
  const list = VOICES.filter((v) => (gender === 'all' || v.gender === gender) && (scene === '全部' || v.scene === scene) && (!q || v.name.includes(q) || v.id.includes(q)));

  if (!s) return null;
  const t = s.tts;
  const setT = (patch: any) => save({ ...s, tts: { ...t, ...patch } });
  const speaker = t.customVoice?.trim() || t.voice;
  const voiceName = t.customVoice?.trim() ? `复刻音色 ${t.customVoice.trim()}` : VOICES.find((v) => v.id === t.voice)?.name || t.voice;
  const scripts = splitScripts(text, t.split);
  const isGen = t.mode === 'audio';
  const audioRefs: Ref[] = refs.filter((r) => r.type !== 'image');
  const hasImage = refs.some((r) => r.type === 'image');
  const tooLong = isGen ? scripts.filter((x) => x.length > GEN_MAX).length : 0;
  const refLabel = (r: Ref) => (r.type === 'voice' ? r.name : fileName(r.file));
  const refsSummary = refs.length ? refs.map(refLabel).join(' + ') : '模型自选音色';

  // 在光标处插入 @音频N
  const insertAt = (tag: string) => {
    const el = area.current;
    const pos = el ? el.selectionStart : text.length;
    const next = text.slice(0, pos) + tag + text.slice(el ? el.selectionEnd : pos);
    setText(next);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(pos + tag.length, pos + tag.length);
    });
  };
  const addVoiceRef = () => {
    if (audioRefs.length >= 3) return toast('参考音频最多 3 条', true);
    if (refs.some((r) => r.type === 'voice' && r.id === speaker)) return toast('这个音色已经加过了', true);
    setRefs([...refs, { type: 'voice', id: speaker, name: voiceName }]);
  };
  const addFileRef = async (kind: 'audio' | 'image') => {
    const files: string[] = await api.dialog.open({ group: kind === 'audio' ? 'media' : 'image', multi: kind === 'audio' });
    if (!files?.length) return;
    if (kind === 'image') return setRefs([{ type: 'image', file: files[0] }]);
    const room = 3 - audioRefs.length;
    if (files.length > room) toast(`参考音频最多 3 条，只加了前 ${room} 个`, true);
    setRefs([...refs, ...files.slice(0, room).map((f) => ({ type: 'audio' as const, file: f }))]);
  };

  const play = (file: string, id: string) => {
    audio.current?.pause();
    if (playing === id) return setPlaying(null);
    const a = new Audio(mediaUrl(file));
    audio.current = a;
    a.onended = () => setPlaying(null);
    a.play();
    setPlaying(id);
  };
  const sample = async (v: Voice) => {
    if (!hasKey) return toast('先填豆包 API Key', true);
    setLoadingSample(v.id);
    try {
      play(await api.tts.sample(v.id, v.name), v.id);
    } catch (e) {
      toast(errMsg(e), true);
    }
    setLoadingSample(null);
  };
  const preview = async () => {
    if (!scripts.length) return toast('先写文案', true);
    setLoadingSample('preview');
    try {
      play(await api.tts.preview(scripts[0], { speaker, speed: t.speed, volume: t.volume, pitch: t.pitch, instruction: t.instruction }), 'preview');
    } catch (e) {
      toast(errMsg(e), true);
    }
    setLoadingSample(null);
  };
  const generate = async () => {
    if (!scripts.length) return toast(isGen ? '先写提示词' : '先写文案', true);
    if (isGen) {
      if (tooLong) return toast(`有 ${tooLong} 条提示词超过 ${GEN_MAX} 字`, true);
      await api.jobs.add(
        'tts',
        scripts.map((txt) => ({ mode: 'audio', text: txt, name: '', voice: `音频生成 · ${refsSummary}`, refs, speed: t.speed, volume: t.volume, pitch: t.pitch }))
      );
      await api.jobs.start('tts');
      return toast(`开始生成 ${scripts.length} 条音频`);
    }
    await api.jobs.add(
      'tts',
      scripts.map((txt) => ({ text: txt, name: txt.replace(/\s+/g, '').slice(0, 16), voice: voiceName, speaker, speed: t.speed, volume: t.volume, pitch: t.pitch, instruction: t.instruction }))
    );
    await api.jobs.start('tts');
    toast(`开始生成 ${scripts.length} 条配音`);
  };
  const saveKey = async () => {
    setChecking(true);
    const r = await api.tts.testKey(keyInput.trim());
    setChecking(false);
    if (r.ok) {
      setHasKey(true);
      setKeyInput('');
      toast('API Key 可用，已加密保存');
    } else toast(r.error, true);
  };
  const toLipsync = (files: string[]) => {
    try {
      const prev = JSON.parse(localStorage.getItem('lipsyncPendingAudios') || '[]');
      localStorage.setItem('lipsyncPendingAudios', JSON.stringify([...new Set([...prev, ...files])]));
    } catch {}
    go('lipsync');
  };
  const done = jobs.filter((j) => j.status === 'done' && j.output?.file);

  return (
    <div className="page with-side">
      <div className="page-body">
        {hasKey === false && (
          <div className="card" style={{ borderColor: 'var(--orange)', display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div className="card-title">
              <KeyRound size={15} /> 先填豆包语音的 API Key
              <span className="hint">火山引擎控制台 → 豆包语音 → API Key 管理；配音用「豆包语音合成模型 2.0」，音频生成用「豆包音频生成模型 1.0」</span>
            </div>
            <div className="row">
              <input className="input grow" type={showKey ? 'text' : 'password'} placeholder="粘贴 API Key" value={keyInput} onChange={(e) => setKeyInput(e.target.value)} />
              <button className="btn ghost sm" onClick={() => setShowKey(!showKey)}>
                {showKey ? '隐藏' : '显示'}
              </button>
              <button className="btn primary" disabled={!keyInput.trim() || checking} onClick={saveKey}>
                {checking ? '验证中…' : '验证并保存'}
              </button>
            </div>
            <div className="small muted">保存前会先合成两个字验证；用系统钥匙串加密存在本机。</div>
          </div>
        )}

        <div className="row">
          <Seg
            value={t.mode || 'tts'}
            options={[
              ['tts', '配音朗读'],
              ['audio', '音频生成 1.0'],
            ]}
            onChange={(v) => setT({ mode: v })}
          />
          <span className="small muted">
            {isGen
              ? '一段提示词生成对白 + 配乐 + 音效，单条最长 120 秒；按生成时长计费，官方价 1 元/分钟'
              : '逐字朗读文案，适合口播和数字人；按字数计费，官方价 3 元/万字'}
          </span>
        </div>

        <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10, flex: 1, minHeight: 320 }}>
          <div className="row">
            <div className="card-title">
              {isGen ? '提示词' : '文案'}{' '}
              <span className="hint">
                {text.replace(/\s/g, '').length} 字 · 将生成 {scripts.length} 条{isGen ? '音频' : '配音'}
                {isGen && <> · 每条最多 {GEN_MAX} 字</>}
                {tooLong > 0 && <b style={{ color: 'var(--red)' }}> · {tooLong} 条超长</b>}
              </span>
            </div>
            <span className="grow" />
            <Seg
              value={t.split}
              options={[
                ['blank', '空行分段'],
                ['line', '每行一条'],
                ['all', '整篇一条'],
              ]}
              onChange={(v) => setT({ split: v })}
            />
          </div>
          <textarea
            ref={area}
            className="input grow"
            style={{ minHeight: 220, lineHeight: 1.8, fontSize: 14 }}
            placeholder={isGen ? GEN_PLACEHOLDER : '在这里写口播文案。\n\n用空行隔开就是多条，每条生成一个音频，可以一次性批量做数字人。'}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          {isGen && (
            <div className="list-box" style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div className="row">
                <b className="small">参考素材</b>
                <span className="small muted">可选。最多 3 条音色/音频，点标签把「@音频N」插进提示词；或 1 张图片（按图片气质生成声音，不能和音频混用）</span>
              </div>
              {refs.length > 0 && (
                <div className="row wrap">
                  {refs.map((r, i) => {
                    const n = audioRefs.indexOf(r) + 1;
                    return (
                      <span key={i} className="badge" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 6px 3px 8px' }}>
                        {r.type === 'image' ? (
                          <ImagePlus size={12} />
                        ) : (
                          <b style={{ cursor: 'pointer', color: 'var(--accent)' }} title="插入到提示词光标处" onClick={() => insertAt(`@音频${n}`)}>
                            @音频{n}
                          </b>
                        )}
                        <span style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.type === 'voice' ? r.id : r.file}>
                          {r.type === 'voice' ? '音色 ' : ''}
                          {refLabel(r)}
                        </span>
                        <X size={12} style={{ cursor: 'pointer' }} onClick={() => setRefs(refs.filter((x) => x !== r))} />
                      </span>
                    );
                  })}
                </div>
              )}
              <div className="row wrap">
                <button className="btn sm" disabled={hasImage || audioRefs.length >= 3} onClick={addVoiceRef} title="把右侧选中的音色加为参考">
                  <Plus size={12} /> 当前音色（{voiceName}）
                </button>
                <button className="btn sm" disabled={hasImage || audioRefs.length >= 3} onClick={() => addFileRef('audio')} title="音频或视频文件，取前 30 秒">
                  <FileAudio size={12} /> 参考音频
                </button>
                <button className="btn sm" disabled={audioRefs.length > 0 || hasImage} onClick={() => addFileRef('image')}>
                  <ImagePlus size={12} /> 参考图片
                </button>
              </div>
            </div>
          )}
          <div className="row">
            <span className="small muted">
              {isGen ? '参考：' : '音色：'}
              <b style={{ color: 'var(--text)' }}>{isGen ? refsSummary : voiceName}</b>
            </span>
            <span className="grow" />
            {!isGen && (
              <button className="btn" disabled={!scripts.length || !hasKey || loadingSample === 'preview'} onClick={preview}>
                {playing === 'preview' ? <StopIcon size={13} /> : <Play size={13} />} 试听第一条
              </button>
            )}
            <button className="btn primary" disabled={!scripts.length || !hasKey || tooLong > 0} onClick={generate}>
              {isGen ? <Sparkles size={14} /> : <Mic size={14} />} {isGen ? '生成音频' : '生成配音'}（{scripts.length} 条）
            </button>
          </div>
        </div>

        <div className="card" style={{ padding: 0 }}>
          <div className="row" style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)' }}>
            <b>配音结果</b>
            <span className="small muted">
              生成中 {c.running} · 排队 {c.pending} · 完成 {c.done} · 失败 {c.failed}
            </span>
            <span className="grow" />
            {done.length > 0 && !IS_WIN && (
              <button className="btn sm primary" onClick={() => toLipsync(done.map((j) => j.output.file))}>
                <UserRound size={12} /> 全部拿去做数字人
              </button>
            )}
            {active && (
              <button className="btn sm" onClick={() => api.jobs.stop('tts')}>
                停止
              </button>
            )}
            <button className="btn sm" onClick={() => api.jobs.clear('tts', 'finished')}>
              清除已完成
            </button>
          </div>
          {jobs.length === 0 ? (
            <div className="empty small">生成的 MP3 和同名字幕（SRT）会保存在「配音输出」目录；音频生成一条通常要 20 秒到几分钟</div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>文案</th>
                  <th style={{ width: 70 }}>时长</th>
                  <th style={{ width: 120 }}>状态</th>
                  <th style={{ width: 150 }}>进度</th>
                  <th style={{ width: 120 }} />
                </tr>
              </thead>
              <tbody>
                {[...jobs].reverse().map((j) => (
                  <tr key={j.id}>
                    <td className="file-cell">
                      <div className="name" style={{ fontWeight: 400, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{j.input.text}</div>
                      <div className="meta">
                        {j.input.voice} · {j.input.text.length} 字{j.output?.file ? ` · ${fileName(j.output.file)}` : ''}
                      </div>
                      {j.output?.speech && j.input.mode === 'audio' && <div className="meta">台词：{j.output.speech}</div>}
                      {j.error && <div className="err">{j.error}</div>}
                    </td>
                    <td className="small">{j.output?.duration ? fmtDur(j.output.duration) : '—'}</td>
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
                              {playing === j.id ? <StopIcon size={13} /> : <Play size={13} />}
                            </button>
                            {!IS_WIN && (
<button className="btn ghost sm" title="拿去做数字人" onClick={() => toLipsync([j.output.file])}>
                              <Send size={13} />
                            </button>
)}
                            <button className="btn ghost sm" title="在访达中显示" onClick={() => api.shell.show(j.output.file)}>
                              <FolderOpen size={13} />
                            </button>
                          </>
                        )}
                        {j.status === 'failed' && (
                          <button
                            className="btn ghost sm"
                            onClick={async () => {
                              await api.jobs.retry([j.id]);
                              api.jobs.start('tts');
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
        <div className="row">
          <div className="card-title">音色</div>
          <span className="grow" />
          {hasKey && (
            <button
              className="btn ghost sm"
              title="更换 API Key"
              onClick={async () => {
                if (!confirm('删除已保存的豆包 API Key？')) return;
                await api.tts.clearKey();
                setHasKey(false);
              }}
            >
              <KeyRound size={12} /> 换 Key
            </button>
          )}
        </div>
        <div className="row">
          <Search size={14} className="muted" />
          <input className="input grow" style={{ height: 28 }} placeholder="搜索音色" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="row wrap">
          <Seg
            value={gender}
            options={[
              ['all', '全部'],
              ['女', '女声'],
              ['男', '男声'],
            ]}
            onChange={setGender}
          />
          <select className="input" style={{ height: 30 }} value={scene} onChange={(e) => setScene(e.target.value)}>
            {scenes.map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
        </div>
        <div className="list-box">
          <div className="bd" style={{ maxHeight: 330, padding: 4 }}>
            {list.map((v) => (
              <div
                key={v.id}
                className={'nav-item' + (!t.customVoice?.trim() && t.voice === v.id ? ' active' : '')}
                style={{ padding: '6px 8px' }}
                onClick={() => setT({ voice: v.id, customVoice: '' })}
              >
                <span className="badge" style={{ padding: '1px 6px' }}>
                  {v.gender}
                </span>
                <span className="grow">{v.name}</span>
                <span className="small muted">
                  {v.scene}
                  {v.dialect ? '·方言' : ''}
                </span>
                <button
                  className="btn ghost sm"
                  style={{ height: 22, padding: '0 5px' }}
                  title="试听"
                  onClick={(e) => {
                    e.stopPropagation();
                    playing === v.id ? play('', v.id) : sample(v);
                  }}
                >
                  {loadingSample === v.id ? '…' : playing === v.id ? <StopIcon size={11} /> : <Play size={11} />}
                </button>
              </div>
            ))}
            {list.length === 0 && <div className="small muted" style={{ padding: 8 }}>没有匹配的音色</div>}
          </div>
        </div>
        <div className="field" style={{ gridTemplateColumns: '64px 1fr' }}>
          <label>复刻音色</label>
          <input className="input" style={{ height: 30 }} placeholder="S_ 开头的音色 ID（可选）" value={t.customVoice || ''} onChange={(e) => setT({ customVoice: e.target.value })} />
        </div>
        <div className="small muted" style={{ marginTop: -6 }}>
          {isGen
            ? '音频生成模式：选好音色后，点左边「+ 当前音色」加为参考才会生效；不加参考时由模型按提示词描述设计声音'
            : '在火山控制台「声音复刻」里训练好后，把音色 ID 填这里就用你自己的声音'}
        </div>

        <div className="card" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div className="field">
            <label>语速</label>
            <div className="row">
              <input type="range" min={-50} max={100} step={5} value={t.speed} onChange={(e) => setT({ speed: +e.target.value })} className="grow" />
              <span className="small" style={{ width: 38 }}>{(1 + t.speed / 100).toFixed(2)}x</span>
            </div>
          </div>
          <div className="field">
            <label>音量</label>
            <div className="row">
              <input type="range" min={-50} max={100} step={5} value={t.volume} onChange={(e) => setT({ volume: +e.target.value })} className="grow" />
              <span className="small" style={{ width: 38 }}>{(1 + t.volume / 100).toFixed(2)}x</span>
            </div>
          </div>
          <div className="field">
            <label>音调</label>
            <div className="row">
              <input type="range" min={-12} max={12} step={1} value={t.pitch} onChange={(e) => setT({ pitch: +e.target.value })} className="grow" />
              <span className="small" style={{ width: 38 }}>{t.pitch > 0 ? '+' : ''}{t.pitch}</span>
            </div>
          </div>
          {!isGen && <div className="field" style={{ alignItems: 'start' }}>
            <label style={{ paddingTop: 6 }}>语气指令</label>
            <textarea
              className="input"
              rows={2}
              placeholder="可选，例如：用热情、有感染力的带货语气说"
              value={t.instruction}
              onChange={(e) => setT({ instruction: e.target.value })}
            />
          </div>}
          <button className="btn ghost sm" onClick={() => setT({ speed: 0, volume: 0, pitch: 0, instruction: '' })}>
            <Wand2 size={12} /> 恢复默认
          </button>
        </div>
      </div>
    </div>
  );
}
