// 把「样式 + 字幕行 + 叠加文字」生成 ASS 字幕文件，交给 ffmpeg 的 libass 烧录。
// 尺寸单位：样式里的字号/描边按 1080 短边设计，按视频短边等比缩放。
const presets = require('../shared/presets.json');

function assColor(hex, opacity = 1) {
  const h = (hex || '#FFFFFF').replace('#', '');
  const r = h.slice(0, 2), g = h.slice(2, 4), b = h.slice(4, 6);
  const a = Math.round((1 - opacity) * 255).toString(16).padStart(2, '0');
  return `&H${a}${b}${g}${r}`.toUpperCase();
}
function assTime(t) {
  const cs = Math.max(0, Math.round(t * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
}
function escapeText(t) {
  return String(t).replace(/\\/g, '＼').replace(/[{}]/g, (c) => (c === '{' ? '｛' : '｝')).replace(/\r?\n/g, '\\N');
}

// libass 不会给没有空格的中文自动换行：按可用宽度估算每行字数，超出就均匀折成多行
function charUnits(ch) {
  return /[\u0000-ÿ]/.test(ch) ? 0.55 : 1;
}
// Windows 没有 Mac 的中文字体：宋/楷/黑换成 Windows 自带的，其余换成安装包自带的思源黑体（Noto Sans SC）
const WIN_FONT = { 'Songti SC': 'SimSun', 'Kaiti SC': 'KaiTi', 'Heiti SC': 'SimHei', 'STSong': 'SimSun', 'STKaiti': 'KaiTi', 'STHeiti': 'SimHei' };
const MAC_ONLY = /Hiragino|Lantinghei|Yuanti|Wawati|HanziPen|Hannotate|Weibei|Xingkai|Baoli|PingFang|Libian|Lingwai|Weibei/i;
function fontFor(family) {
  if (process.platform !== 'win32') return family;
  if (WIN_FONT[family]) return WIN_FONT[family];
  if (!family || MAC_ONLY.test(family)) return 'Noto Sans SC';
  return family;
}

function wrapText(text, fontPx, availPx) {
  return String(text)
    .split(/\r?\n/)
    .map((para) => {
      const chars = [...para];
      const units = chars.reduce((a, c) => a + charUnits(c), 0);
      const perLine = Math.max(4, Math.floor(availPx / (fontPx * 1.02)));
      if (units <= perLine) return para;
      const lines = Math.ceil(units / perLine);
      const target = units / lines;
      const out = [];
      let cur = '';
      let u = 0;
      for (const c of chars) {
        if (u + charUnits(c) > target + 0.5 && out.length < lines - 1 && cur) {
          out.push(cur);
          cur = '';
          u = 0;
        }
        cur += c;
        u += charUnits(c);
      }
      if (cur) out.push(cur);
      return out.join('\n');
    })
    .join('\n');
}

// 一个样式 → 1~2 个 ASS Style（双描边花字用两层叠出来）
function styleLines(name, st, k) {
  const size = Math.round(st.size * k);
  const ow = (st.outline?.width || 0) * k;
  const o2w = (st.outline2?.width || 0) * k;
  const sd = (st.shadow?.depth || 0) * k;
  const bold = st.bold ? -1 : 0;
  const out = [];
  if (st.box) {
    // BorderStyle 3 = 不透明底框，框色取 OutlineColour，Outline 当内边距
    out.push(
      `Style: ${name}_1,${fontFor(st.font)},${size},${assColor(st.color)},${assColor(st.color)},${assColor(st.box.color, st.box.opacity)},${assColor(st.box.color, st.box.opacity)},${bold},0,0,0,100,100,0,0,3,${((st.box.padding || 12) * k).toFixed(1)},0,5,0,0,0,1`
    );
    return { lines: out, layers: [`${name}_1`] };
  }
  if (o2w > 0) {
    out.push(
      `Style: ${name}_0,${fontFor(st.font)},${size},${assColor(st.outline2.color)},${assColor(st.outline2.color)},${assColor(st.outline2.color)},${assColor(st.shadow?.color || '#000000', 0.6)},${bold},0,0,0,100,100,0,0,1,${(ow + o2w).toFixed(1)},${sd.toFixed(1)},5,0,0,0,1`
    );
  }
  out.push(
    `Style: ${name}_1,${fontFor(st.font)},${size},${assColor(st.color)},${assColor(st.color)},${assColor(st.outline?.color || '#000000')},${assColor(st.shadow?.color || '#000000', 0.6)},${bold},0,0,0,100,100,0,0,1,${ow.toFixed(1)},${o2w > 0 ? 0 : sd.toFixed(1)},5,0,0,0,1`
  );
  return { lines: out, layers: o2w > 0 ? [`${name}_0`, `${name}_1`] : [`${name}_1`] };
}

function overlayStyle(o) {
  return {
    font: o.font || 'Hiragino Sans GB',
    size: o.size || 56,
    bold: o.bold !== false,
    color: o.color || '#FFFFFF',
    outline: { color: o.outlineColor || '#000000', width: o.outlineWidth ?? 3 },
    outline2: { color: '#FFFFFF', width: 0 },
    shadow: { color: '#000000', depth: 0 },
    box: o.box ? { color: o.boxColor || '#000000', opacity: o.boxOpacity ?? 0.6, padding: 10 } : null,
  };
}

/**
 * @param look   { sub: 样式, overlays: [{text,x,y,...}], showSubs: bool }
 * @param lines  [{start,end,text}]
 * @param video  { width, height, duration }
 */
function buildAss(look, lines, video) {
  const W = video.width || 1080;
  const H = video.height || 1920;
  const k = Math.min(W, H) / 1080;
  const sub = look.sub || presets.styles[0];
  const styleDefs = [];
  const events = [];
  // 字幕可以换行的宽度：左右各留 6%
  const margin = Math.round(W * 0.06);

  const subStyle = styleLines('Sub', sub, k);
  styleDefs.push(...subStyle.lines);
  if (look.showSubs !== false) {
    const x = Math.round(W / 2);
    const y = Math.round((sub.y ?? 0.72) * H);
    const avail = W - margin * 2 - ((sub.outline?.width || 0) + (sub.outline2?.width || 0)) * k * 2;
    for (const l of lines) {
      const text = escapeText(wrapText(l.text, sub.size * k, avail));
      subStyle.layers.forEach((name, layer) => {
        events.push(`Dialogue: ${layer},${assTime(l.start)},${assTime(l.end)},${name},,${margin},${margin},0,,{\\pos(${x},${y})}${text}`);
      });
    }
  }

  (look.overlays || []).forEach((o, i) => {
    if (!o.text?.trim()) return;
    const st = styleLines(`Ov${i}`, overlayStyle(o), k);
    styleDefs.push(...st.lines);
    const x = Math.round((o.x ?? 0.5) * W);
    const y = Math.round((o.y ?? 0.1) * H);
    const text = escapeText(wrapText(o.text, (o.size || 56) * k, W - margin * 2));
    st.layers.forEach((name, layer) => {
      events.push(`Dialogue: ${layer + 2},${assTime(0)},${assTime((video.duration || 3600) + 1)},${name},,${margin},${margin},0,,{\\pos(${x},${y})}${text}`);
    });
  });

  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
${styleDefs.join('\n')}

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${events.join('\n')}
`;
}

module.exports = { fontFor, buildAss, presets };
