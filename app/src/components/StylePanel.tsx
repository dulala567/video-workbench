import { useEffect, useMemo, useRef, useState, CSSProperties, PointerEvent } from 'react';
import { Plus, Trash2, Check, Save, Wand2, Type } from 'lucide-react';
import { api, presets, mediaUrl, useStyles, defaultLook, Look, SubStyle, Overlay } from '../api';
import { Toggle, Seg, toast } from './ui';

// ---------- 用 CSS 近似 ASS 的花字效果 ----------
function hexA(hex: string, a: number) {
  const h = hex.replace('#', '');
  return `rgba(${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)},${a})`;
}
export function StyledText({ st, px, text }: { st: SubStyle; px: number; text: string }) {
  // px：样式里 1 个单位对应的屏幕像素
  const base: CSSProperties = {
    fontFamily: `"${st.font}", "Hiragino Sans GB", "Noto Sans SC", "Microsoft YaHei", sans-serif`,
    fontSize: st.size * px,
    fontWeight: st.bold ? 700 : 400,
    gridArea: '1 / 1',
    paintOrder: 'stroke fill',
    whiteSpace: 'pre-wrap',
  };
  const ow = (st.outline?.width || 0) * px;
  const o2 = (st.outline2?.width || 0) * px;
  const shadow = st.shadow?.depth ? `${st.shadow.depth * px}px ${st.shadow.depth * px}px 0 ${hexA(st.shadow.color, 0.6)}` : undefined;
  if (st.box) {
    return (
      <span
        style={{
          ...base,
          color: st.color,
          background: hexA(st.box.color, st.box.opacity),
          padding: `${st.box.padding * px * 0.3}px ${st.box.padding * px}px`,
          borderRadius: 2,
        }}
      >
        {text}
      </span>
    );
  }
  return (
    <span style={{ display: 'inline-grid' }}>
      {o2 > 0 && (
        <span aria-hidden style={{ ...base, color: st.outline2.color, WebkitTextStroke: `${(ow + o2) * 2}px ${st.outline2.color}`, textShadow: shadow }}>
          {text}
        </span>
      )}
      <span style={{ ...base, color: st.color, WebkitTextStroke: ow > 0 ? `${ow * 2}px ${st.outline.color}` : undefined, textShadow: o2 > 0 ? undefined : shadow }}>
        {text}
      </span>
    </span>
  );
}

function overlayToStyle(o: Overlay): SubStyle {
  return {
    id: o.id,
    name: '',
    font: o.font || 'Hiragino Sans GB',
    size: o.size,
    bold: o.bold,
    color: o.color,
    outline: { color: o.outlineColor, width: o.outlineWidth },
    outline2: { color: '#FFFFFF', width: 0 },
    shadow: { color: '#000000', depth: 0 },
    box: o.box ? { color: '#000000', opacity: 0.6, padding: 10 } : null,
    y: o.y,
  };
}

const OVERLAY_DEFAULTS: Record<Overlay['kind'], Partial<Overlay>> = {
  title: { text: '在这里输入标题', y: 0.13, size: 76, color: '#FFE135', outlineColor: '#000000', outlineWidth: 5, bold: true },
  footer: { text: '剧情虚构 请勿模仿', y: 0.95, size: 30, color: '#FFFFFF', outlineColor: '#000000', outlineWidth: 2, bold: false },
  text: { text: '自定义文案', y: 0.4, size: 48, color: '#FFFFFF', outlineColor: '#000000', outlineWidth: 3, bold: true },
};

export function StylePanel({
  lookKey,
  previewFile,
  selectedCount,
  onApplySelected,
}: {
  lookKey: 'burn' | 'lipsync';
  previewFile?: string;
  selectedCount?: number;
  onApplySelected?: (look: Look) => void;
}) {
  const [stylesStore, saveStyles] = useStyles();
  const look: Look = useMemo(() => ({ ...defaultLook(), ...(stylesStore?.looks?.[lookKey] || {}) }), [stylesStore, lookKey]);
  const custom = stylesStore?.custom || [];
  const allStyles = [...presets.styles, ...custom];
  const [selOverlay, setSelOverlay] = useState<string | null>(null);

  const setLook = (patch: Partial<Look>) => {
    if (!stylesStore) return;
    saveStyles({ ...stylesStore, looks: { ...stylesStore.looks, [lookKey]: { ...look, ...patch } } });
  };
  const setSub = (patch: Partial<SubStyle>) => setLook({ sub: { ...look.sub, ...patch } });
  const setOverlay = (id: string, patch: Partial<Overlay>) => setLook({ overlays: look.overlays.map((o) => (o.id === id ? { ...o, ...patch } : o)) });

  // ---------- 预览底图 ----------
  const [thumb, setThumb] = useState('');
  const [dim, setDim] = useState({ w: 1080, h: 1920 });
  useEffect(() => {
    let dead = false;
    if (!previewFile) {
      setThumb('');
      setDim({ w: 1080, h: 1920 });
      return;
    }
    (async () => {
      try {
        const info = await api.media.probe(previewFile);
        const t = await api.media.thumb(previewFile, 1);
        if (!dead) {
          if (info.width && info.height) setDim({ w: info.width, h: info.height });
          setThumb(t);
        }
      } catch {}
    })();
    return () => {
      dead = true;
    };
  }, [previewFile]);

  const boxRef = useRef<HTMLDivElement>(null);
  const [cw, setCw] = useState(200);
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setCw(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const maxH = 380;
  const ratio = dim.w / dim.h;
  const previewW = Math.min(328, maxH * ratio);
  const px = (Math.min(dim.w, dim.h) / 1080) * (cw / dim.w);

  // ---------- 拖动 ----------
  const drag = useRef<{ id: string; dx: number; dy: number } | null>(null);
  const onDown = (id: string) => (e: PointerEvent) => {
    const r = boxRef.current!.getBoundingClientRect();
    const cur = id === 'sub' ? { x: 0.5, y: look.sub.y } : look.overlays.find((o) => o.id === id)!;
    drag.current = { id, dx: (e.clientX - r.left) / r.width - cur.x, dy: (e.clientY - r.top) / r.height - cur.y };
    setSelOverlay(id === 'sub' ? null : id);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onMove = (e: PointerEvent) => {
    if (!drag.current) return;
    const r = boxRef.current!.getBoundingClientRect();
    const x = Math.min(0.95, Math.max(0.05, (e.clientX - r.left) / r.width - drag.current.dx));
    const y = Math.min(0.97, Math.max(0.03, (e.clientY - r.top) / r.height - drag.current.dy));
    if (drag.current.id === 'sub') setSub({ y: Math.round(y * 1000) / 1000 });
    else setOverlay(drag.current.id, { x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000 });
  };
  const onUp = () => (drag.current = null);

  const pickStyle = (s: SubStyle) => {
    if (look.randomStyle) {
      const inPool = look.randomPool.some((p) => p.id === s.id);
      setLook({ randomPool: inPool ? look.randomPool.filter((p) => p.id !== s.id) : [...look.randomPool, s] });
    } else setLook({ sub: { ...s, y: look.sub.y } });
  };

  const addOverlay = (kind: Overlay['kind']) => {
    const o = { id: 'ov' + Date.now(), kind, x: 0.5, ...OVERLAY_DEFAULTS[kind] } as Overlay;
    setLook({ overlays: [...look.overlays, o] });
    setSelOverlay(o.id);
  };

  const [naming, setNaming] = useState<string | null>(null);
  const saveAs = () => {
    if (!stylesStore) return;
    const name = naming?.trim();
    setNaming(null);
    if (!name) return;
    const s = { ...look.sub, id: 'my-' + Date.now(), name, group: '我的' };
    saveStyles({ ...stylesStore, custom: [...custom, s], looks: { ...stylesStore.looks, [lookKey]: { ...look, sub: s } } });
    toast('已保存到「我的样式」');
  };
  const deleteCustom = (id: string) => {
    if (!stylesStore) return;
    saveStyles({ ...stylesStore, custom: custom.filter((c) => c.id !== id) });
  };

  if (!stylesStore) return <div className="side" />;
  const ov = look.overlays.find((o) => o.id === selOverlay);
  const groups = ['预设', '花字', '我的'];

  return (
    <div className="side">
      <div className="card-title">字幕与文案样式</div>
      <div className="row wrap">
        {presets.styles
          .filter((s) => s.group === '预设')
          .map((s) => (
            <button key={s.id} className={'btn sm' + (!look.randomStyle && look.sub.id === s.id ? ' primary' : '')} onClick={() => pickStyle(s)}>
              {s.name}
            </button>
          ))}
      </div>

      <div>
        <div className="row" style={{ marginBottom: 8 }}>
          <h4>预览</h4>
          <span className="grow" />
          <span className="small muted">拖动文字可调整位置</span>
        </div>
        <div
          ref={boxRef}
          className="preview"
          style={{ width: previewW, aspectRatio: `${dim.w} / ${dim.h}` }}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerDown={(e) => e.target === e.currentTarget && setSelOverlay(null)}
        >
          {thumb ? <img src={mediaUrl(thumb)} /> : <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(160deg,#36506b,#6b5a46)' }} />}
          {look.showSubs && (
            <div className={'ptext' + (selOverlay === null ? '' : '')} style={{ left: '50%', top: `${look.sub.y * 100}%` }} onPointerDown={onDown('sub')}>
              <StyledText st={look.randomStyle && look.randomPool[0] ? look.randomPool[0] : look.sub} px={px} text="这是字幕样式预览效果" />
            </div>
          )}
          {look.overlays.map((o) => (
            <div key={o.id} className={'ptext' + (selOverlay === o.id ? ' sel' : '')} style={{ left: `${o.x * 100}%`, top: `${o.y * 100}%` }} onPointerDown={onDown(o.id)}>
              <StyledText st={overlayToStyle(o)} px={px} text={o.text} />
            </div>
          ))}
        </div>
        {!previewFile && <div className="small muted" style={{ textAlign: 'center', marginTop: 6 }}>添加视频后用第一个视频的画面预览</div>}
      </div>

      <div className="row">
        <span>烧录字幕</span>
        <Toggle on={look.showSubs} onChange={(v) => setLook({ showSubs: v })} />
        <span className="grow" />
        <span className="small muted">保留标点</span>
        <Toggle on={look.keepPunct} onChange={(v) => setLook({ keepPunct: v })} />
      </div>

      {groups.map((g) => {
        const list = allStyles.filter((s) => (s.group || '我的') === g);
        if (!list.length) return null;
        return (
          <div key={g}>
            <h4 style={{ marginBottom: 8 }}>{g === '花字' ? `花字模板（${list.length} 款）` : g === '我的' ? '我的样式' : '基础样式'}</h4>
            <div className="style-grid">
              {list.map((s) => {
                const on = look.randomStyle ? look.randomPool.some((p) => p.id === s.id) : look.sub.id === s.id;
                return (
                  <div key={s.id} className={'style-tile' + (on ? ' on' : '')} onClick={() => pickStyle(s)} title={s.name}>
                    <StyledText st={{ ...s, size: 30 }} px={0.62} text="字幕" />
                    <span className="label">{s.name}</span>
                    {on && look.randomStyle && (
                      <span className="check">
                        <Check size={12} />
                      </span>
                    )}
                    {g === '我的' && (
                      <button
                        className="btn ghost sm"
                        style={{ position: 'absolute', top: 0, right: 0, height: 18, padding: '0 3px' }}
                        onClick={(e) => {
                          e.stopPropagation();
                          deleteCustom(s.id);
                        }}
                      >
                        <Trash2 size={11} />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}

      <div>
        <div className="row">
          <span>随机样式</span>
          <Toggle on={look.randomStyle} onChange={(v) => setLook({ randomStyle: v, randomPool: v && !look.randomPool.length ? [look.sub] : look.randomPool })} />
        </div>
        <div className="small muted" style={{ marginTop: 6, lineHeight: 1.6 }}>
          打开后，在上面勾选多个样式（已选 {look.randomPool.length} 个），每个视频随机用其中一个。
        </div>
      </div>

      {!look.randomStyle && (
        <div className="card" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <h4>细调「{look.sub.name}」</h4>
          <div className="field">
            <label>字体</label>
            <select className="input" value={look.sub.font} onChange={(e) => setSub({ font: e.target.value })}>
              {presets.fonts.map((f) => (
                <option key={f.family} value={f.family}>
                  {f.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>字号</label>
            <div className="row">
              <input type="range" min={28} max={120} value={look.sub.size} onChange={(e) => setSub({ size: +e.target.value })} className="grow" />
              <span className="small" style={{ width: 26 }}>{look.sub.size}</span>
              <button className={'btn sm' + (look.sub.bold ? ' primary' : '')} onClick={() => setSub({ bold: !look.sub.bold })}>
                粗
              </button>
            </div>
          </div>
          <div className="field">
            <label>文字</label>
            <div className="row">
              <input type="color" value={look.sub.color} onChange={(e) => setSub({ color: e.target.value.toUpperCase() })} />
              <span className="small muted">底框</span>
              <Toggle
                on={!!look.sub.box}
                onChange={(v) => setSub({ box: v ? { color: '#000000', opacity: 0.6, padding: 12 } : null })}
              />
              {look.sub.box && (
                <>
                  <input type="color" value={look.sub.box.color} onChange={(e) => setSub({ box: { ...look.sub.box!, color: e.target.value } })} />
                  <input
                    type="range"
                    min={0.1}
                    max={1}
                    step={0.05}
                    value={look.sub.box.opacity}
                    onChange={(e) => setSub({ box: { ...look.sub.box!, opacity: +e.target.value } })}
                    style={{ width: 70 }}
                  />
                </>
              )}
            </div>
          </div>
          {!look.sub.box && (
            <>
              <div className="field">
                <label>描边</label>
                <div className="row">
                  <input type="color" value={look.sub.outline.color} onChange={(e) => setSub({ outline: { ...look.sub.outline, color: e.target.value } })} />
                  <input type="range" min={0} max={10} step={0.5} value={look.sub.outline.width} onChange={(e) => setSub({ outline: { ...look.sub.outline, width: +e.target.value } })} className="grow" />
                </div>
              </div>
              <div className="field">
                <label>外描边</label>
                <div className="row">
                  <input type="color" value={look.sub.outline2.color} onChange={(e) => setSub({ outline2: { ...look.sub.outline2, color: e.target.value } })} />
                  <input type="range" min={0} max={8} step={0.5} value={look.sub.outline2.width} onChange={(e) => setSub({ outline2: { ...look.sub.outline2, width: +e.target.value } })} className="grow" />
                </div>
              </div>
              <div className="field">
                <label>阴影</label>
                <input type="range" min={0} max={8} step={0.5} value={look.sub.shadow.depth} onChange={(e) => setSub({ shadow: { ...look.sub.shadow, depth: +e.target.value } })} />
              </div>
            </>
          )}
        </div>
      )}

      <div>
        <h4>标题 / 文案（烧进视频，可在预览里拖动）</h4>
        <div className="row" style={{ marginTop: 8 }}>
          <button className="btn sm" onClick={() => addOverlay('title')}>
            <Plus size={13} /> 标题
          </button>
          <button className="btn sm" onClick={() => addOverlay('footer')}>
            <Plus size={13} /> 底部声明
          </button>
          <button className="btn sm" onClick={() => addOverlay('text')}>
            <Plus size={13} /> 文案
          </button>
        </div>
        {look.overlays.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 10 }}>
            {look.overlays.map((o) => (
              <div key={o.id} className="row" onClick={() => setSelOverlay(o.id)}>
                <Type size={13} className="muted" />
                <input className="input grow" style={{ height: 28, borderColor: selOverlay === o.id ? 'var(--accent)' : undefined }} value={o.text} onChange={(e) => setOverlay(o.id, { text: e.target.value })} />
                <button className="btn ghost sm danger" onClick={() => setLook({ overlays: look.overlays.filter((x) => x.id !== o.id) })}>
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
        )}
        {ov && (
          <div className="card" style={{ padding: 10, marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div className="field">
              <label>字体</label>
              <select className="input" value={ov.font || 'Hiragino Sans GB'} onChange={(e) => setOverlay(ov.id, { font: e.target.value })}>
                {presets.fonts.map((f) => (
                  <option key={f.family} value={f.family}>
                    {f.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>字号</label>
              <div className="row">
                <input type="range" min={20} max={140} value={ov.size} onChange={(e) => setOverlay(ov.id, { size: +e.target.value })} className="grow" />
                <button className={'btn sm' + (ov.bold ? ' primary' : '')} onClick={() => setOverlay(ov.id, { bold: !ov.bold })}>
                  粗
                </button>
              </div>
            </div>
            <div className="field">
              <label>颜色</label>
              <div className="row">
                <input type="color" value={ov.color} onChange={(e) => setOverlay(ov.id, { color: e.target.value })} />
                <span className="small muted">描边</span>
                <input type="color" value={ov.outlineColor} onChange={(e) => setOverlay(ov.id, { outlineColor: e.target.value })} />
                <input type="range" min={0} max={10} step={0.5} value={ov.outlineWidth} onChange={(e) => setOverlay(ov.id, { outlineWidth: +e.target.value })} className="grow" />
              </div>
            </div>
            <div className="row">
              <span className="small muted">底框</span>
              <Toggle on={!!ov.box} onChange={(v) => setOverlay(ov.id, { box: v })} />
            </div>
          </div>
        )}
      </div>

      <div>
        <h4 style={{ marginBottom: 8 }}>滤镜</h4>
        <div className="row wrap">
          <Seg
            value={look.filter.mode}
            options={[
              ['off', '关闭'],
              ['fixed', '固定'],
              ['random', '随机'],
            ]}
            onChange={(v) => setLook({ filter: { ...look.filter, mode: v } })}
          />
          {look.filter.mode === 'fixed' && (
            <select className="input" value={look.filter.value} onChange={(e) => setLook({ filter: { ...look.filter, value: e.target.value } })}>
              {presets.filters.map((f) => (
                <option key={f.label}>{f.label}</option>
              ))}
            </select>
          )}
        </div>
      </div>

      <div className="row" style={{ position: 'sticky', bottom: -16, background: '#0f0f15', padding: '10px 0', marginTop: 'auto' }}>
        {naming === null ? (
          <button className="btn sm" onClick={() => setNaming(look.sub.name + ' 副本')} disabled={look.randomStyle}>
            <Save size={13} /> 另存为
          </button>
        ) : (
          <>
            <input
              className="input"
              style={{ height: 26, width: 120 }}
              autoFocus
              value={naming}
              onChange={(e) => setNaming(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') saveAs();
                if (e.key === 'Escape') setNaming(null);
              }}
            />
            <button className="btn sm primary" onClick={saveAs}>
              保存
            </button>
          </>
        )}
        <span className="grow" />
        {onApplySelected && (
          <button className="btn sm primary" disabled={!selectedCount} onClick={() => onApplySelected(look)}>
            <Wand2 size={13} /> 应用到选中{selectedCount ? `（${selectedCount}）` : ''}
          </button>
        )}
      </div>
    </div>
  );
}

export function useLook(lookKey: 'burn' | 'lipsync'): Look {
  const [s] = useStyles();
  return { ...defaultLook(), ...(s?.looks?.[lookKey] || {}) };
}
