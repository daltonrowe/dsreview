// Shared rendering core: page lookup, static server, open page in a state, interactions.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const PROJECT = path.join(ROOT, 'design-project');
export const BRIDGE = path.join(ROOT, 'tools/lib/bridge.js');

export function splitProps(s) { return s.split(/,(?=\s*[\w$-]+=)/); }
export function jsonish(v) { try { return JSON.parse(v); } catch { return v; } }
export function coerce(v) { return v === 'true' ? true : v === 'false' ? false : v; }

// Props declared on a page, read statically from the file (no browser).
export function readPropsMeta(file) {
  const html = fs.readFileSync(path.join(PROJECT, file), 'utf8');
  const m = html.match(/data-props="([^"]*)"/);
  if (!m) return null;
  const meta = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&amp;/g, '&'));
  for (const k of Object.keys(meta)) if (k.startsWith('$')) delete meta[k];
  return meta;
}

// ---------- pages ----------
export function allPages() {
  return fs.readdirSync(PROJECT).filter(f => f.endsWith('.html')).sort();
}
export function resolvePage(q) {
  if (!q) throw new Error('page name required. Try: node tools/dc.mjs list');
  const pages = allPages();
  const n = s => s.toLowerCase().replace(/\.dc\.html$|\.html$/, '');
  const exact = pages.filter(p => n(p) === n(q));
  if (exact.length) return exact.find(p => p.endsWith('.dc.html')) || exact[0];
  const sub = pages.filter(p => n(p).includes(n(q)));
  const dc = sub.filter(p => p.endsWith('.dc.html'));
  const pick = dc.length === 1 ? dc : sub;
  if (pick.length === 1) return pick[0];
  throw new Error(`"${q}" matches ${pick.length ? pick.join(', ') : 'nothing'}. Pages: ${pages.join(', ')}`);
}

// ---------- static server ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.mp4': 'video/mp4', '.webm': 'video/webm', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf' };
export function startServer() {
  const srv = http.createServer((req, res) => {
    const p = path.normalize(path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname)));
    if (!p.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    fs.stat(p, (err, st) => {
      if (err || !st.isFile()) { res.writeHead(404).end('not found'); return; }
      res.writeHead(200, { 'content-type': MIME[path.extname(p).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' });
      fs.createReadStream(p).pipe(res);
    });
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv)));
}

// ---------- browser ----------
// o: { props, state, do, theme }. Mutates o.props to canonical option values.
export async function openPage(ctx, base, file, o, log = []) {
  o = { props: {}, state: {}, do: [], ...o };
  const page = await ctx.newPage();
  page.on('pageerror', e => log.push('pageerror: ' + e.message.split('\n')[0]));
  // ignore known-harmless noise: un-rendered template attrs and the editor's image-slot state file
  page.on('console', m => { const t = m.text(); if (m.type() === 'error' && !t.includes('{{') && !t.startsWith('Failed to load resource')) log.push('console: ' + t.slice(0, 200)); });
  page.on('response', r => { if (r.status() >= 400 && !r.url().includes('.image-slots.state.json')) log.push(`${r.status()}: ${decodeURIComponent(r.url().replace(base, ''))}`); });
  await page.addInitScript({ path: BRIDGE });
  const url = `${base}/design-project/${encodeURIComponent(file)}${o.theme ? `?theme=${o.theme}` : ''}`;
  await page.goto(url, { waitUntil: 'load', timeout: 60000 });
  const isDc = file.endsWith('.dc.html');
  if (isDc) {
    await page.waitForFunction(() => typeof window.__dcRootName === 'function' && document.querySelector('#dc-root')?.childElementCount > 0, null, { timeout: 30000 })
      .catch(() => log.push('warn: dc runtime did not report a rendered root within 30s'));
  }
  await settle(page);
  if (Object.keys(o.props).length) {
    if (!isDc) throw new Error(`${file} is not a .dc.html page; --props unsupported`);
    const meta = await page.evaluate(() => window.__dcRegistry[window.__dcRootName()]?.propsMeta || {});
    for (const [k, v] of Object.entries(o.props)) {
      if (!(k in meta)) throw new Error(`unknown prop "${k}". Props: ${Object.keys(meta).join(', ') || '(none)'}`);
      const opts = meta[k].options;
      if (opts && !opts.includes(v)) {
        const ci = opts.find(x => String(x).toLowerCase() === String(v).toLowerCase()) ?? opts.find(x => String(x).toLowerCase().includes(String(v).toLowerCase()));
        if (ci === undefined) throw new Error(`prop ${k}: "${v}" not in [${opts.join(' | ')}]`);
        o.props[k] = ci;
      }
    }
    await page.evaluate(p => window.__dcSetProps(window.__dcRootName(), p), o.props);
    await settle(page);
  }
  if (Object.keys(o.state).length) {
    if (!isDc) throw new Error(`${file} is not a .dc.html page; --state unsupported`);
    const known = await page.evaluate(() => window.__dcv.getState());
    for (const k of Object.keys(o.state)) if (known && !(k in known)) log.push(`warn: state key "${k}" not currently in state (setting anyway). Known: ${Object.keys(known).join(', ')}`);
    await page.evaluate(p => window.__dcv.setState(p), o.state);
    await settle(page);
  }
  for (const step of o.do) await runStep(page, step);
  return page;
}

export async function settle(page) {
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  await page.evaluate(() => document.fonts?.ready).catch(() => {});
  await page.evaluate(() => Promise.all([...document.images].filter(i => !i.complete && i.loading !== 'lazy').map(i => new Promise(r => { i.onload = i.onerror = r; setTimeout(r, 5000); }))));
  await page.waitForTimeout(400);
}

export function sel(s) {
  if (s.startsWith('label=')) return `[data-screen-label=${JSON.stringify(s.slice(6))}]`;
  return s;
}
export async function runStep(page, step) {
  const i = step.indexOf(':');
  const kind = step.slice(0, i), arg = step.slice(i + 1);
  const loc = () => page.locator(sel(arg.split('::')[0])).filter({ visible: true }).first();
  switch (kind) {
    case 'click': await loc().click({ timeout: 10000 }); break;
    case 'hover': await loc().hover({ timeout: 10000 }); break;
    case 'scroll': await loc().scrollIntoViewIfNeeded({ timeout: 10000 }); break;
    case 'fill': await loc().fill(arg.split('::').slice(1).join('::'), { timeout: 10000 }); break;
    case 'press': await page.keyboard.press(arg); break;
    case 'wait': await page.waitForTimeout(Number(arg)); return;
    case 'eval': await page.evaluate(arg); break;
    default: throw new Error(`unknown --do step "${kind}"`);
  }
  await settle(page);
}

