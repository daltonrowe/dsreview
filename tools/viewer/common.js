// Shared viewer helpers.
import { liveHeaders } from './live.js';
export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'content-type': 'application/json', ...liveHeaders() }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
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
// Small swatch before a color value (first color found in the string), or a gradient strip.
export function swatch(v) {
  const s = String(v ?? '');
  if (/gradient\(/.test(s)) return `<span class="swatch" style="width:28px"><i style="background-image:${esc(s.replace(/#[0-9a-f]{6} \/ \d+%/gi, m => cssColor(m)))}"></i></span>`;
  const m = s.match(/#[0-9a-f]{6}(?:\s*\/\s*\d+%)?/i);
  return m ? `<span class="swatch"><i style="background:${esc(cssColor(m[0]))}"></i></span>` : '';
}

// Link to the design page viewer in a given state, optionally marking an element.
export function viewUrl(design, where) {
  const q = new URLSearchParams({ page: design.page });
  if (design.props && Object.keys(design.props).length) q.set('props', JSON.stringify(design.props));
  if (design.state && Object.keys(design.state).length) q.set('state', JSON.stringify(design.state));
  if (design.do && design.do.length) q.set('do', JSON.stringify(design.do));
  if (design.width) q.set('w', design.width);
  if (where) { q.set('owner', where.owner); q.set('tpl', where.tpl); q.set('nth', where.nth); }
  return `view.html?${q}`;
}

let _cfg;
export async function config() { return (_cfg ||= await api('/api/config')); }
export function editorUrl(root, file, line, col) {
  return `vscode://file${root}/design-project/${file}${line ? `:${line}${col ? `:${col}` : ''}` : ''}`;
}

export const DECISIONS = ['fix-live', 'fix-design', 'ok', 'unclear'];
export const LABELS = { 'fix-live': 'Fix live', 'fix-design': 'Update design', ok: 'Fine', unclear: '🤷' };
export const TITLES = { 'fix-live': 'The live site should match the design', 'fix-design': 'The live site is right; update the design', ok: 'Difference is acceptable / not real', unclear: 'Not sure; needs a look' };

export function progressBar(p) {
  const pct = k => (p.total ? ((p[k] || 0) / p.total) * 100 : 0);
  return `<div class="progress" title="${DECISIONS.map(d => `${LABELS[d]} ${p[d] || 0}`).join(' · ')} · undecided ${p.undecided}">${DECISIONS.map(d => `<span class="${d}" style="width:${pct(d)}%"></span>`).join('')}</div>`;
}
export function legend(p) {
  return `<div class="legend">${DECISIONS.map(d => `<span title="${esc(TITLES[d])}"><i class="dot ${d}"></i>${LABELS[d]} <b>${p[d] || 0}</b></span>`).join('')}<span><i class="dot undecided"></i>Undecided <b>${p.undecided}</b></span></div>`;
}
