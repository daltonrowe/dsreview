// Design-system tokens (design-system/tokens.json) + nearest-token matching for survey values.
// nearest(preset, value) -> { exact, candidates: [{ name, value, delta, label, css }] } | null
//   css = { property: value } that applies the candidate to the element (used by the preview).

let T = null;
export async function loadTokens() {
  if (T) return T;
  try { const r = await fetch('/design-system/tokens.json'); T = r.ok ? build(await r.json()) : null; } catch { T = null; }
  return T;
}

const px = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
const fmt = n => `${Math.round(n * 100) / 100}px`;
const sign = d => (d === 0 ? '±0' : `${d > 0 ? '+' : '−'}${Math.round(Math.abs(d) * 100) / 100}`);

function build(raw) {
  const out = { raw, families: {} };
  // colors: resolve "{alias}" per theme
  const themes = raw.color?.themes?.map(t => t.id) || ['light'];
  const byName = Object.fromEntries((raw.color?.tokens || []).map(t => [t.name, t]));
  const resolve = (name, theme, depth = 0) => {
    const t = byName[name]; if (!t || depth > 8) return null;
    let v = typeof t.value === 'string' ? t.value : t.value[theme] ?? t.value[themes[0]];
    if (typeof v === 'string' && v.startsWith('{')) return resolve(v.slice(1, -1), theme, depth + 1);
    return v;
  };
  const colors = [];
  for (const t of raw.color?.tokens || []) {
    const first = resolve(t.name, themes[0]);
    for (const th of themes) {
      const v = resolve(t.name, th); const rgb = v && parseColor(v);
      // a theme value equal to the first theme's adds nothing
      if (rgb && (th === themes[0] || v !== first)) colors.push({ name: t.name, theme: th, value: v, rgb, lab: oklab(rgb) });
    }
  }
  out.colors = colors;
  const list = fam => (raw[fam]?.tokens || []).map(t => ({ name: t.name, value: typeof t.value === 'string' ? t.value : Object.values(t.value)[0] }));
  out.radius = list('radius').map(t => ({ ...t, n: px(t.value) }));
  out.spacing = list('spacing').filter(t => t.name !== 'spacing').map(t => ({ ...t, n: px(t.value) }));
  out.shadow = list('shadow').map(t => ({ ...t, s: parseShadow(t.value) })).filter(t => t.s);
  out.families = raw.type?.families || {};
  out.styles = (raw.type?.groups || []).flatMap(g => g.styles.map(s => ({
    ...s, familyKey: s.family || g.family || 'sans',
    size: px(s.fontSize), weight: Number(String(s.fontWeight).split(' ')[0]), lh: px(s.lineHeight),
    ls: String(s.letterSpacing).endsWith('em') ? parseFloat(s.letterSpacing) * px(s.fontSize) : px(s.letterSpacing) || 0,
  })));
  return out;
}

// ---------- color math ----------
export function parseColor(v) {
  v = String(v).trim();
  let m;
  if ((m = v.match(/^#([0-9a-f]{3,8})$/i))) {
    let h = m[1];
    if (h.length <= 4) h = h.split('').map(c => c + c).join('');
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1 };
  }
  if ((m = v.match(/^(#[0-9a-f]{6})\s*\/\s*([\d.]+)%$/i))) return { ...parseColor(m[1]), a: +m[2] / 100 };
  if ((m = v.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+)(%?))?\s*\)$/))) {
    const a = m[4] === undefined ? 1 : m[5] ? +m[4] / 100 : +m[4];
    return { r: +m[1], g: +m[2], b: +m[3], a };
  }
  return null;
}
function oklab({ r, g, b }) {
  const lin = c => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
const dE = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) * 100;
const rgbCss = ({ r, g, b }, a = 1) => (a >= 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${Math.round(a * 100) / 100})`);

// ---------- shadow ----------
function parseShadow(v) {
  const first = String(v).split(/,(?![^(]*\))/)[0];
  const colM = first.match(/rgba?\([^)]*\)|#[0-9a-f]{3,8}(?:\s*\/\s*[\d.]+%)?/i);
  const col = colM ? parseColor(colM[0]) : { r: 0, g: 0, b: 0, a: 1 };
  const nums = first.replace(colM ? colM[0] : '', '').match(/-?[\d.]+(px)?/g)?.map(parseFloat) || [];
  if (nums.length < 2) return null;
  return { x: nums[0], y: nums[1], blur: nums[2] || 0, spread: nums[3] || 0, col, inset: /inset/.test(first) };
}

// ---------- matching ----------
// group candidates sharing the same value: "spacing / spacing-1"
function merge(cands) {
  const by = new Map();
  for (const c of cands) {
    const k = c.value + '|' + c.delta;
    if (!by.has(k)) by.set(k, { ...c, names: [c.name] });
    else by.get(k).names.push(c.name);
  }
  return [...by.values()].map(c => ({ ...c, name: c.names.length > 3 ? `${c.names.slice(0, 3).join(' / ')} +${c.names.length - 3}` : c.names.join(' / '), token: c.names[0] }));
}

function numericNearest(tokens, n, cssProp, top = 3) {
  const c = tokens.filter(t => t.n != null).map(t => ({ name: t.name, value: t.value, n: t.n, delta: t.n - n, dist: Math.abs(t.n - n) }));
  c.sort((a, b) => a.dist - b.dist || a.n - b.n);
  const merged = merge(c);
  // keep top N distinct values, plus anything tied with the Nth
  const out = merged.slice(0, top);
  return out.map(x => ({ ...x, label: `${x.name} · ${x.value} (${sign(x.delta)})`, css: { [cssProp]: x.value } }));
}

// multi-part values ("0px 0px 10px 10px", "8px 16px"): round each non-zero part
function partsNearest(tokens, value, cssProp, prefix) {
  const parts = value.split(/\s+/);
  const res = parts.map(p => {
    if (p === 'pill') return { name: 'rounded-full', value: '9999px', delta: 0 };
    const n = px(p);
    if (n == null || n === 0) return { name: '0', value: '0px', delta: 0 };
    const best = numericNearest(tokens, n, cssProp, 1)[0];
    return best ? { name: best.token, value: best.value, delta: best.delta } : { name: p, value: p, delta: 0 };
  });
  const v = res.map(r => r.value).join(' ');
  const exact = res.every(r => r.delta === 0);
  return { exact, candidates: [{ name: res.map(r => r.name).join(' · '), token: res.map(r => r.name).join(' '), value: v, delta: res.reduce((s, r) => s + Math.abs(r.delta), 0), label: `${res.map(r => r.name).join(' · ')} · ${v}`, css: { [cssProp]: v } }] };
}

function colorNearest(value, cssProp) {
  const cols = value.split(/,\s*(?=#)/);
  if (cols.length > 1) {
    const parts = cols.map(c => colorNearest(c, cssProp));
    if (parts.some(p => !p)) return null;
    const firsts = parts.map(p => p.candidates[0]);
    const css = firsts.map(f => Object.values(f.css)[0]).join(' ');
    return { exact: parts.every(p => p.exact), candidates: [{ name: firsts.map(f => f.token).join(' + '), token: firsts.map(f => f.token).join(' '), value: firsts.map(f => f.value).join(', '), delta: firsts.reduce((s, f) => s + f.delta, 0), label: firsts.map(f => f.token).join(' + '), css: { [cssProp]: css } }] };
  }
  const rgb = parseColor(cols[0]);
  if (!rgb) return null;
  const lab = oklab(rgb);
  const c = T.colors.map(t => ({ name: t.theme === 'light' ? t.name : `${t.name} (${t.theme})`, value: t.value, delta: Math.round(dE(lab, t.lab) * 10) / 10, rgb: t.rgb, theme: t.theme }));
  c.sort((a, b) => a.delta - b.delta || (a.theme === 'light' ? -1 : 1));
  const merged = merge(c).slice(0, 3);
  const exact = merged[0].delta < 0.5;
  return {
    exact,
    candidates: merged.map(x => ({ ...x, label: `${x.name} · ${x.value} (ΔE ${x.delta})`, css: { [cssProp]: rgbCss(x.rgb, rgb.a) } })),
    alpha: rgb.a < 1 ? rgb.a : null,
  };
}

function shadowNearest(value) {
  const s = parseShadow(value);
  if (!s || !T.shadow.length) return null;
  const c = T.shadow.map(t => {
    const d = Math.abs(t.s.x - s.x) + Math.abs(t.s.y - s.y) + Math.abs(t.s.blur - s.blur) + Math.abs(t.s.spread - s.spread) + Math.abs(t.s.col.a - s.col.a) * 100 + dE(oklab(t.s.col), oklab(s.col)) / 5;
    return { name: t.name, value: t.value, delta: Math.round(d * 10) / 10 };
  }).sort((a, b) => a.delta - b.delta);
  return { exact: c[0].delta < 0.5, candidates: merge(c).slice(0, 3).map(x => ({ ...x, label: `${x.name} · ${x.value} (Δ ${x.delta})`, css: { 'box-shadow': x.value } })) };
}

function familyCss(key) { return T.families[key] || key; }

function typographyNearest(value) {
  const [spec, fam = ''] = value.split(' · ');
  const [size, weight, lh, ls] = spec.split(' / ');
  const v = { size: px(size), weight: Number(weight), lh: lh === 'normal' ? px(size) * 1.2 : px(lh), ls: ls ? px(ls) : 0, italic: / italic$/.test(fam), fam: fam.replace(/ italic$/, '') };
  const c = T.styles.map(s => {
    const famMatch = (T.families[s.familyKey] || '').toLowerCase().includes(v.fam.toLowerCase());
    const d = Math.abs(s.size - v.size) * 3 + Math.abs(s.weight - v.weight) / 50 + Math.abs(s.lh - v.lh) * 0.5 + Math.abs(s.ls - v.ls) + (famMatch ? 0 : 4) + ((s.fontStyle === 'italic') !== v.italic ? 4 : 0);
    const sv = `${s.fontSize} / ${s.fontWeight} / ${s.lineHeight}`;
    return {
      name: s.name, value: sv, delta: Math.round(d * 10) / 10,
      css: { 'font-size': s.fontSize, 'font-weight': String(s.fontWeight), 'line-height': s.lineHeight, 'letter-spacing': s.letterSpacing === '0' ? 'normal' : s.letterSpacing, 'font-family': familyCss(s.familyKey), 'font-style': s.fontStyle || 'normal' },
    };
  }).sort((a, b) => a.delta - b.delta);
  return { exact: c[0].delta < 0.6, candidates: c.slice(0, 3).map(x => ({ ...x, token: x.name, label: `${x.name} · ${x.value} (Δ ${x.delta})` })) };
}

function typeScaleNearest(field, value, cssProp) {
  const n = field === 'weight' ? Number(value) : px(value);
  if (n == null) return null;
  const vals = new Map();
  for (const s of T.styles) {
    const sv = s[field];
    if (sv == null) continue;
    const disp = field === 'weight' ? String(sv) : fmt(sv);
    if (!vals.has(disp)) vals.set(disp, { names: [], n: sv });
    vals.get(disp).names.push(s.name);
  }
  const c = [...vals.entries()].map(([disp, { names, n: sn }]) => ({ name: names.length > 3 ? `${names.slice(0, 3).join(' / ')} +${names.length - 3}` : names.join(' / '), token: names[0], value: disp, n: sn, delta: sn - n, dist: Math.abs(sn - n) }));
  c.sort((a, b) => a.dist - b.dist || a.n - b.n);
  return { exact: c[0]?.dist < 0.05, candidates: c.slice(0, 3).map(x => ({ ...x, label: `${x.value} · ${x.name} (${sign(x.delta)})`, css: { [cssProp]: x.value } })) };
}

function fontFamilyNearest(value) {
  const fam = value.toLowerCase();
  const entries = Object.entries(T.families);
  const hit = entries.find(([, stack]) => stack.toLowerCase().includes(fam));
  const guess = hit ? hit[0] : /serif|garamond|georgia|times/.test(fam) && !/sans/.test(fam) ? 'accent' : /mono|courier/.test(fam) ? 'mono' : 'sans';
  const order = [guess, ...entries.map(e => e[0]).filter(k => k !== guess)];
  return { exact: !!hit, candidates: order.map((k, i) => ({ name: k, token: k, value: T.families[k], delta: i === 0 && hit ? 0 : i + 1, label: `${k} · ${T.families[k].split(',')[0]}`, css: { 'font-family': T.families[k] } })) };
}

export function nearest(preset, value) {
  if (!T || value == null) return null;
  const v = String(value);
  switch (preset) {
    case 'radius':
      if (v === 'pill' || v === '50%') return { exact: true, candidates: [{ name: 'rounded-full', token: 'rounded-full', value: '9999px', delta: 0, label: 'rounded-full (Tailwind utility)', css: { 'border-radius': '9999px' } }] };
      if (/\s/.test(v)) return partsNearest(T.radius, v, 'border-radius', 'radius-');
      return withExact(numericNearest(T.radius, px(v), 'border-radius'));
    case 'gap':
      if (/\s/.test(v)) return partsNearest(T.spacing, v, 'gap', 'spacing-');
      return withExact(numericNearest(T.spacing, px(v), 'gap'));
    case 'padding':
      if (/\s/.test(v)) return partsNearest(T.spacing, v, 'padding', 'spacing-');
      return withExact(numericNearest(T.spacing, px(v), 'padding'));
    case 'text-color': return colorNearest(v, 'color');
    case 'background': return colorNearest(v, 'background-color');
    case 'border-color': return colorNearest(v, 'border-color');
    case 'shadow': return shadowNearest(v);
    case 'typography': return typographyNearest(v);
    case 'font-size': return typeScaleNearest('size', v, 'font-size');
    case 'font-weight': return typeScaleNearest('weight', v, 'font-weight');
    case 'line-height': return typeScaleNearest('lh', v, 'line-height');
    case 'letter-spacing': return typeScaleNearest('ls', v, 'letter-spacing');
    case 'font-family': return fontFamilyNearest(v);
    default: return null; // gradient, opacity, border-width: no tokens in the system
  }
}
function withExact(cands) {
  if (!cands.length) return null;
  return { exact: cands[0].delta === 0, candidates: cands.map(c => ({ ...c, token: c.token || c.name })) };
}

// ---------- helpers for the Suggested Tokens tool ----------
// Distance between two values of a preset, or null when they can't be compared (no clustering).
export function valueDistance(preset, a, b) {
  if (['text-color', 'background', 'border-color'].includes(preset)) {
    const x = parseColor(a), y = parseColor(b);
    if (!x || !y || /,/.test(a) || /,/.test(b)) return null;
    return dE(oklab(x), oklab(y)) + Math.abs(x.a - y.a) * 100;
  }
  const single = v => (/^-?[\d.]+(px)?$/.test(String(v)) ? parseFloat(v) : null);
  const x = single(a), y = single(b);
  return x == null || y == null ? null : Math.abs(x - y);
}
export const isColorPreset = p => ['text-color', 'background', 'border-color'].includes(p);

// Token names in the family a preset maps to (for "unused existing tokens").
export function familyTokenNames(preset) {
  if (!T) return [];
  switch (preset) {
    case 'radius': return T.radius.map(t => t.name);
    case 'gap': case 'padding': return T.spacing.map(t => t.name);
    case 'shadow': return T.shadow.map(t => t.name);
    case 'typography': return T.styles.map(s => s.name);
    case 'text-color': case 'background': case 'border-color': return [...new Set(T.colors.map(c => c.name))];
    default: return [];
  }
}

// A suggested name for a new token holding `value`.
export function suggestName(preset, value) {
  const v = String(value), n = parseFloat(v), num = Number.isFinite(n) ? String(Math.round(n * 100) / 100).replace('.', '_') : null;
  const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  switch (preset) {
    case 'radius': return /\s/.test(v) ? `radius-${slug(v.replace(/px/g, ''))}` : `radius-${num}`;
    case 'gap': case 'padding': return /\s/.test(v) ? `spacing-${slug(v.replace(/px/g, ''))}` : `spacing-${num}px`;
    case 'font-size': return `text-size-${num}`;
    case 'font-weight': return `font-weight-${num}`;
    case 'line-height': return `leading-${num}`;
    case 'letter-spacing': return `tracking-${num}`;
    case 'font-family': return `font-${slug(v)}`;
    case 'border-width': return `border-${num}`;
    case 'opacity': return `opacity-${Math.round(n * 100)}`;
    case 'shadow': { const s = parseShadow(v); return s ? `shadow-${s.y}-${s.blur}${s.col.a < 1 ? `-${Math.round(s.col.a * 100)}` : ''}` : `shadow-${slug(v).slice(0, 20)}`; }
    case 'typography': { const [spec] = v.split(' · '); const [size, weight] = spec.split(' / '); return `text-${parseFloat(size)}-${weight}`; }
    case 'text-color': case 'background': case 'border-color': {
      const near = nearest(preset, v)?.candidates?.[0]?.token || '';
      const ramp = (near.match(/^color-(grey|red|green|purple|yellow|orange|pro|ai)/) || [, near.startsWith('color-theme') ? 'grey' : 'new'])[1];
      const c = parseColor(v);
      const hex = c ? [c.r, c.g, c.b].map(x => x.toString(16).padStart(2, '0')).join('') + (c.a < 1 ? `-a${Math.round(c.a * 100)}` : '') : slug(v);
      return `color-${ramp}-${hex}`;
    }
    default: return `${preset}-${slug(v).slice(0, 24)}`;
  }
}

// tokens.json-shaped entry for a suggestion.
export function tokenEntry(preset, name, value, usage) {
  if (preset === 'typography') {
    const [spec, fam = ''] = String(value).split(' · ');
    const [fontSize, fontWeight, lineHeight, letterSpacing] = spec.split(' / ');
    return { name, fontSize, fontWeight: Number(fontWeight), lineHeight, letterSpacing: letterSpacing || '0', fontStyle: / italic$/.test(fam) ? 'italic' : 'normal', family: fam.replace(/ italic$/, ''), usage };
  }
  if (isColorPreset(preset)) { const c = parseColor(value); return { name, value: c ? (c.a < 1 ? `rgba(${c.r}, ${c.g}, ${c.b}, ${Math.round(c.a * 100) / 100})` : '#' + [c.r, c.g, c.b].map(x => x.toString(16).padStart(2, '0')).join('')) : value, usage }; }
  return { name, value, usage };
}
