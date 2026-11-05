// Shared viewer helpers.
export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'content-type': 'application/json' }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

// "#rrggbb / 40%" -> css color
export function cssColor(v) {
  const m = String(v).trim().match(/^(#[0-9a-f]{6})(?:\s*\/\s*(\d+)%)?$/i);
  if (!m) return v;
  return m[2] ? `${m[1]}${Math.round((+m[2] / 100) * 255).toString(16).padStart(2, '0')}` : m[1];
}

// Visual preview for a section value, by preset.
export function preview(preset, value) {
  const v = String(value);
  switch (preset) {
    case 'text-color': case 'background': case 'border-color': {
      const cols = v.split(/,\s*(?=#)/);
      return `<span class="swatch${cols.length > 1 ? ' wide' : ''}">${cols.map((c, i) => `<i style="background:${esc(cssColor(c))};left:${(i / cols.length) * 100}%;width:${100 / cols.length}%;right:auto"></i>`).join('')}</span>`;
    }
    case 'gradient': return `<span class="swatch wide"><i style="background-image:${esc(v)}"></i></span>`;
    case 'radius': {
      const r = v.split(' ').map(x => (x === 'pill' ? '999px' : x));
      return `<span class="radius-prev" style="border-radius:${esc(r[0])} 0 0 0"></span>`;
    }
    case 'shadow': return `<span class="shadow-prev" style="box-shadow:${esc(v)}"></span>`;
    case 'opacity': return `<span class="swatch"><i style="background:var(--text);opacity:${esc(v)}"></i></span>`;
    case 'gap': case 'padding': case 'border-width': {
      const n = parseFloat(v) || 0;
      return `<span class="space-prev" style="width:${Math.min(n, 120)}px"></span>`;
    }
    case 'font-size': return `<span class="type-prev" style="font-size:${esc(Math.min(parseFloat(v), 48))}px">Ag</span>`;
    case 'size-weight': {
      const [size, weight] = v.split(' / ');
      return `<span class="type-prev" style="font-size:${Math.min(parseFloat(size), 40)}px;font-weight:${esc(weight)}">Ag</span>`;
    }
    case 'font-weight': return `<span class="type-prev" style="font-size:22px;font-weight:${esc(v)}">Ag</span>`;
    case 'font-family': return `<span class="type-prev" style="font-size:22px;font-family:${esc(v)}">Ag</span>`;
    case 'letter-spacing': return `<span class="type-prev" style="font-size:15px;letter-spacing:${esc(v)}">AaBb</span>`;
    case 'typography': {
      const [spec, fam = ''] = v.split(' · ');
      const [size, weight] = spec.split(' / ');
      const f = fam.replace(/ italic$/, '');
      return `<span class="type-prev" style="font-size:${Math.min(parseFloat(size), 44)}px;font-weight:${esc(weight)};font-family:'${esc(f)}';${fam.endsWith(' italic') ? 'font-style:italic' : ''}">Ag</span>`;
    }
    default: return '';
  }
}

// Link to the live page in a given state, optionally highlighting an element.
// extra: { options: [{label, token, value, css}], pick } shows rounding options on the target
export function viewUrl(capture, where, extra) {
  const q = new URLSearchParams({ page: capture.page });
  if (capture.props && Object.keys(capture.props).length) q.set('props', JSON.stringify(capture.props));
  if (capture.state && Object.keys(capture.state).length) q.set('state', JSON.stringify(capture.state));
  if (capture.do && capture.do.length) q.set('do', JSON.stringify(capture.do));
  if (capture.width) q.set('w', capture.width);
  if (where) { q.set('owner', where.owner); q.set('tpl', where.tpl); q.set('nth', where.nth); }
  if (extra?.options?.length) { q.set('options', JSON.stringify(extra.options)); q.set('pick', extra.pick ?? 0); }
  return `view.html?${q}`;
}

let _cfg;
export async function config() { return (_cfg ||= await api('/api/config')); }
export function editorUrl(root, file, line, col) {
  return `vscode://file${root}/design-project/${file}${line ? `:${line}${col ? `:${col}` : ''}` : ''}`;
}

export function progressBar(p) {
  const pct = k => (p.total ? ((p[k] || 0) / p.total) * 100 : 0);
  return `<div class="progress" title="keep ${p.keep} · round ${p.round || 0} · exclude ${p.exclude} · remove ${p.remove} · undecided ${p.undecided}"><span class="keep" style="width:${pct('keep')}%"></span><span class="round" style="width:${pct('round')}%"></span><span class="exclude" style="width:${pct('exclude')}%"></span><span class="remove" style="width:${pct('remove')}%"></span></div>`;
}
export function legend(p) {
  return `<div class="legend"><span><i class="dot keep"></i>Keep <b>${p.keep}</b></span><span><i class="dot round"></i>Round <b>${p.round || 0}</b></span><span><i class="dot exclude"></i>Exclude <b>${p.exclude}</b></span><span><i class="dot remove"></i>Remove <b>${p.remove}</b></span><span><i class="dot undecided"></i>Undecided <b>${p.undecided}</b></span></div>`;
}
