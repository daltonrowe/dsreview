#!/usr/bin/env node
// Compare design-project pages with the live site, visually.
// Run `node tools/compare.mjs help` for usage.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, resolvePage, startServer, openPage, settle, splitProps, jsonish, coerce } from './lib/render.mjs';
import { SNAPSHOT, openLive, fitViewport, liveUrl } from './lib/live.mjs';
import { DIR, DEFAULT_BASE, readConfig, expandPairs } from './lib/pairs.mjs';
import { compareSnapshots, CATEGORIES } from './lib/diff.mjs';
import { tplSource } from './lib/source.mjs';

const PAIRS = path.join(DIR, 'pairs.json');

const HELP = `
compare.mjs: compare design-project pages with the live site (alignment, size, color, type, behavior)

  node tools/compare.mjs list
      Configured comparisons (comparisons/pairs.json) and whether each has a report.

  node tools/compare.mjs run [<id> ...] [--theme light|dark] [--no-hover] [--base URL]
      Capture the design page and the live page at the same width, match their elements and write
      comparisons/<id>/report.json + design.jpg + live.jpg. No ids = all comparisons.
      Every pair runs in light and dark (dark: the page's theme prop + prefers-color-scheme: dark on
      live; its id is <id>--dark). --theme runs one. --no-hover skips the hover probe (faster).

  node tools/compare.mjs show <id> [--category c[,c]] [--severity high|medium|low] [--limit N]
      Print a report's findings as text.

  node tools/compare.mjs add <id> --label "Home" --design <page> [--props k=v] [--state k=v] [--do step]
                                  --live <path> [--live-do step] [--max-height N]
      Add (or replace) a comparison in comparisons/pairs.json. Design options are the same as
      tools/dc.mjs; --live-do steps run on the live page (same syntax).

  node tools/compare.mjs live <path> [--do step] [--theme dark] [--full] [--out file.png] [--width N]
      Screenshot a live page (consent wall and profiler hidden). Prints the PNG path.

Live site: ${DEFAULT_BASE} (override with --base or LIVE_BASE; ?skip=1 is added to every URL).
Categories: ${CATEGORIES.join(', ')}
`;

function parseArgs(argv) {
  const pos = [];
  const o = { props: {}, state: {}, do: [], liveDo: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { pos.push(a); continue; }
    const k = a.slice(2);
    if (['no-hover', 'full', 'json'].includes(k)) { o[k.replace(/-(\w)/g, (_, c) => c.toUpperCase())] = true; continue; }
    const v = argv[++i];
    if (k === 'props') for (const kv of splitProps(v)) { const j = kv.indexOf('='); o.props[kv.slice(0, j).trim()] = coerce(kv.slice(j + 1).trim()); }
    else if (k === 'state') for (const kv of splitProps(v)) { const j = kv.indexOf('='); o.state[kv.slice(0, j).trim()] = jsonish(kv.slice(j + 1).trim()); }
    else if (k === 'do') o.do.push(v);
    else if (k === 'live-do') o.liveDo.push(v);
    else o[k.replace(/-(\w)/g, (_, c) => c.toUpperCase())] = v;
  }
  return { cmd: pos[0], args: pos.slice(1), o };
}


// ---------- capture one side ----------
async function probeHover(page, items, log) {
  const ns = items.filter(i => i.interactive).map(i => i.n).slice(0, 250);
  const vp = page.viewportSize();
  await page.mouse.move(vp.width - 1, 1);
  const before = await page.evaluate(ns => Object.fromEntries(ns.map(n => [n, window.__cmp.hoverState(n)])), ns);
  const out = {};
  let failed = 0;
  for (const n of ns) {
    try {
      await page.locator(`[data-cmp="${n}"]`).first().hover({ timeout: 1500, force: true });
      await page.waitForTimeout(40);
      out[n] = { before: before[n], after: await page.evaluate(n => window.__cmp.hoverState(n), n) };
    } catch { failed++; }
  }
  await page.mouse.move(vp.width - 1, 1);
  if (failed) log.push(`hover probe: ${failed} of ${ns.length} elements could not be hovered`);
  return out;
}

async function capture(page, maxHeight, shotPath, hover, log) {
  const height = await fitViewport(page, maxHeight);
  const snap = await page.evaluate(m => window.__cmp.snapshot({ maxHeight: m }), maxHeight);
  await page.screenshot({ path: shotPath, type: 'jpeg', quality: 82, animations: 'disabled', caret: 'hide' });
  snap.height = height;
  if (hover) snap.hover = await probeHover(page, snap.items, log);
  return snap;
}

const viewerUrl = d => {
  const q = new URLSearchParams({ page: d.page });
  if (d.props && Object.keys(d.props).length) q.set('props', JSON.stringify(d.props));
  if (d.state && Object.keys(d.state).length) q.set('state', JSON.stringify(d.state));
  if (d.do?.length) q.set('do', JSON.stringify(d.do));
  return `view.html?${q}`;
};

export async function runPair(pair, cfg, { hover = true, browser, designBase }) {
  const width = pair.width || cfg.width, height = pair.height || cfg.height, maxHeight = pair.maxHeight || cfg.maxHeight;
  const out = path.join(DIR, pair.id);
  fs.mkdirSync(out, { recursive: true });
  const logD = [], logL = [];
  const file = resolvePage(pair.design.page);
  const ctxOpts = { viewport: { width, height }, reducedMotion: 'reduce', deviceScaleFactor: 1, colorScheme: pair.theme === 'dark' ? 'dark' : 'light' };

  const dctx = await browser.newContext(ctxOpts);
  await dctx.addInitScript({ path: SNAPSHOT });
  const dpage = await openPage(dctx, designBase, file, { props: { ...pair.design.props }, state: { ...pair.design.state }, do: [...(pair.design.do || [])] }, logD);
  const design = await capture(dpage, maxHeight, path.join(out, 'design.jpg'), hover, logD);
  await dctx.close();

  const lctx = await browser.newContext(ctxOpts);
  const lpage = await openLive(lctx, cfg.base, pair.live.path, { do: pair.live.do || [] }, logL);
  const finalUrl = lpage.url();
  const live = await capture(lpage, maxHeight, path.join(out, 'live.jpg'), hover, logL);
  await lctx.close();

  const result = compareSnapshots(design, live);
  // design element -> source line (owner is the component name; its file is <owner>.dc.html)
  for (const f of result.findings) {
    const w = f.design?.where;
    if (!w) continue;
    const src = path.join(ROOT, 'design-project', `${w.owner}.dc.html`);
    const hit = fs.existsSync(src) && tplSource(src, w.tpl);
    if (hit) f.design.source = { file: `${w.owner}.dc.html`, line: hit.line, col: hit.col };
  }
  const report = {
    id: pair.id, baseId: pair.baseId, theme: pair.theme, label: pair.label || pair.id, generatedAt: new Date().toISOString(), base: cfg.base, hover,
    design: { ...pair.design, page: file, view: viewerUrl({ ...pair.design, page: file }), width, height: design.height, shot: 'design.jpg', items: design.items.length, log: [...new Set(logD)] },
    live: { ...pair.live, url: liveUrl(cfg.base, pair.live.path), finalUrl, width, height: live.height, shot: 'live.jpg', items: live.items.length, log: [...new Set(logL)] },
    ...result,
  };
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 1) + '\n');
  // raw snapshots, for debugging the matcher (not served)
  fs.writeFileSync(path.join(out, 'snapshot.json'), JSON.stringify({ design, live }) + '\n');
  return report;
}

function summary(r) {
  const s = r.stats;
  const cats = CATEGORIES.filter(c => s.byCategory[c]).map(c => `${c} ${s.byCategory[c]}`).join(', ');
  return `${r.id}: ${s.matched} matched (${s.designItems} design / ${s.liveItems} live items) · ${s.findings} findings [high ${s.bySeverity.high}, medium ${s.bySeverity.medium}, low ${s.bySeverity.low}] · ${cats}`;
}

function printFindings(r, o) {
  const cats = o.category ? o.category.split(',') : null;
  const order = ['high', 'medium', 'low'];
  const minSev = o.severity ? order.indexOf(o.severity) : 2;
  const list = r.findings.filter(f => (!cats || cats.includes(f.category)) && order.indexOf(f.severity) <= minSev);
  const limit = Number(o.limit) || 60;
  console.log(`${r.label} — ${summary(r)}\n  design: ${r.design.page} ${JSON.stringify({ props: r.design.props, state: r.design.state })}\n  live:   ${r.live.url}\n`);
  for (const f of list.slice(0, limit)) {
    const b = f.design?.box || f.live.box;
    console.log(`[${f.severity}] ${f.category} · “${f.text}”${f.section ? ` (${f.section})` : ''} @${Math.round(b.x)},${Math.round(b.y)}`);
    for (const p of f.props) console.log(`    ${p.prop}: ${p.design}  →  ${p.live}`);
  }
  if (list.length > limit) console.log(`\n… ${list.length - limit} more (--limit N)`);
}

async function main() {
  const { cmd, args, o } = parseArgs(process.argv.slice(2));
  if (!cmd || cmd === 'help' || cmd === '--help') { console.log(HELP); return; }
  const cfg = readConfig();
  const all = expandPairs(cfg).filter(p => !o.theme || p.theme === o.theme);
  if (o.base || process.env.LIVE_BASE) cfg.base = (o.base || process.env.LIVE_BASE).replace(/\/$/, '');

  if (cmd === 'list') {
    for (const p of all) {
      const rp = path.join(DIR, p.id, 'report.json');
      const r = fs.existsSync(rp) ? JSON.parse(fs.readFileSync(rp, 'utf8')) : null;
      console.log(`${p.id.padEnd(16)} ${p.label || ''} (${p.theme})\n  design: ${p.design.page} ${JSON.stringify({ props: p.design.props || {}, state: p.design.state || {}, do: p.design.do || [] })}\n  live:   ${p.live.path}${p.live.do?.length ? ` do ${JSON.stringify(p.live.do)}` : ''}\n  ${r ? `report ${r.generatedAt}: ${r.stats.findings} findings` : 'no report yet'}`);
    }
    return;
  }

  if (cmd === 'show') {
    const rp = path.join(DIR, args[0] || '', 'report.json');
    if (!args[0] || !fs.existsSync(rp)) throw new Error(`no report for "${args[0]}". Run: node tools/compare.mjs run ${args[0] || '<id>'}`);
    printFindings(JSON.parse(fs.readFileSync(rp, 'utf8')), o);
    return;
  }

  if (cmd === 'add') {
    const id = args[0];
    if (!id || !/^[\w-]+$/.test(id)) throw new Error('add <id>: letters, digits, - and _ only');
    if (!o.design || !o.live) throw new Error('add needs --design <page> and --live <path>');
    const pair = { id, label: o.label || id, design: { page: resolvePage(o.design), props: o.props, state: o.state, do: o.do }, live: { path: o.live, do: o.liveDo } };
    if (o.maxHeight) pair.maxHeight = Number(o.maxHeight);
    const raw = JSON.parse(fs.readFileSync(PAIRS, 'utf8'));
    const i = raw.pairs.findIndex(p => p.id === id);
    if (i >= 0) raw.pairs[i] = pair; else raw.pairs.push(pair);
    fs.writeFileSync(PAIRS, JSON.stringify(raw, null, 2) + '\n');
    console.log(`${i >= 0 ? 'replaced' : 'added'} ${id}. Run: node tools/compare.mjs run ${id}`);
    return;
  }

  const browser = await chromium.launch();
  try {
    if (cmd === 'live') {
      const width = Number(o.width) || cfg.width;
      const ctx = await browser.newContext({ viewport: { width, height: cfg.height }, reducedMotion: 'reduce', colorScheme: o.theme === 'dark' ? 'dark' : 'light' });
      const log = [];
      const page = await openLive(ctx, cfg.base, args[0] || '/', { do: o.do }, log);
      if (o.full) await fitViewport(page, Number(o.maxHeight) || 8000);
      await settle(page);
      const out = o.out ? path.resolve(o.out) : path.join(ROOT, 'screenshots', `live__${(args[0] || '/').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'home'}${o.theme === 'dark' ? '__dark' : ''}${o.full ? '__full' : ''}.png`);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      await page.screenshot({ path: out });
      console.log(path.relative(process.cwd(), out));
      if (log.length) console.error(`\n[${log.length} page issue(s)]\n  ` + [...new Set(log)].join('\n  '));
      return;
    }
    if (cmd === 'run') {
      // an id names one comparison, or a pair's id runs all its themes
      const ids = args.length ? args.flatMap(a => { const hit = all.filter(p => p.id === a || p.baseId === a).map(p => p.id); if (!hit.length) throw new Error(`unknown comparison "${a}". Known: ${all.map(p => p.id).join(', ')}`); return hit; }) : all.map(p => p.id);
      const srv = await startServer();
      const designBase = `http://127.0.0.1:${srv.address().port}`;
      try {
        for (const id of ids) {
          const pair = all.find(p => p.id === id);
          const t = Date.now();
          const r = await runPair(pair, cfg, { hover: !o.noHover, browser, designBase });
          console.log(`${summary(r)}  (${Math.round((Date.now() - t) / 1000)}s)`);
          for (const l of [...r.design.log.map(x => 'design ' + x), ...r.live.log.map(x => 'live ' + x)].slice(0, 8)) console.log(`  ${l}`);
        }
      } finally { srv.close(); }
      return;
    }
    throw new Error(`unknown command "${cmd}"\n${HELP}`);
  } finally {
    await browser.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error('error: ' + e.message.split('\nCall log')[0].replace(/\x1b\[[0-9;]*m/g, '')); process.exit(1); });
}
