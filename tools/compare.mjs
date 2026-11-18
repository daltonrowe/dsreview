#!/usr/bin/env node
// Compare design-project pages with the live site, visually.
// Run `node tools/compare.mjs help` for usage.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, resolvePage, startServer, openPage, settle, splitProps, jsonish, coerce } from './lib/render.mjs';
import { openLive, fitViewport, liveUrl } from './lib/live.mjs';
import { DIR, DEFAULT_BASE, readConfig, expandPairs } from './lib/pairs.mjs';
import { decodePng, segment } from './lib/vision.mjs';
import { reviewReport, reviewAvailable, REVIEW_MODEL } from './lib/review.mjs';
import { findingShots } from './lib/crops.mjs';

// credentials for the review model, from .env when present (ANTHROPIC_API_KEY)
if (fs.existsSync(path.join(ROOT, '.env'))) { try { process.loadEnvFile(path.join(ROOT, '.env')); } catch { } }
import { compareImages, CATEGORIES } from './lib/pixeldiff.mjs';

const PAIRS = path.join(DIR, 'pairs.json');

const HELP = `
compare.mjs: compare screenshots of design-project pages and the live site, as a designer would:
pixels only (no DOM, no CSS): alignment, size, color, type, shape, spacing, missing/extra

  node tools/compare.mjs list
      Configured comparisons (comparisons/pairs.json) and whether each has a report.

  node tools/compare.mjs run [<id> ...] [--theme light|dark] [--base URL]
      Capture the design page and the live page at the same width, find the visual elements in each screenshot (pixels only), pair them and write
      comparisons/<id>/report.json + design.jpg + live.jpg. No ids = all comparisons.
      Every pair runs in light and dark (dark: the page's theme prop + prefers-color-scheme: dark on
      live; its id is <id>--dark). --theme runs one.

  node tools/compare.mjs show <id> [--category c[,c]] [--severity high|medium|low] [--limit N]
      Print a report's findings as text.

  node tools/compare.mjs review [<id> ...] [--force] [--model id]
      Second pass: a smaller model (${REVIEW_MODEL}) looks at each finding's crops and measurements
      and explains what's off, with a verdict (real / noise / unsure). Kept in reviews.json; only new or
      changed findings are reviewed again. Needs ANTHROPIC_API_KEY (or .env). \`run\` does this
      automatically when credentials are available (--no-review to skip).

  node tools/compare.mjs crop <id> <findingId> [...]
      Write a finding's screenshots (design/live close crops with outlines and guides, plus
      full-width context strips) to screenshots/crops/. Prints the PNG paths.

  node tools/compare.mjs findings <id>
      Every finding with its id, compactly: the input for grouping them into meta-findings.

  node tools/compare.mjs group <id> <groups.json>
      Check a set of meta-findings (groups of finding ids, written by judgement) and install it as
      comparisons/<id>/groups.json. Format: { "groups": [ { "id", "title", "summary", "severity",
      "findings": [ids] } ] }. Reports unknown ids, findings in two groups and what's left ungrouped.

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
    if (['no-hover', 'no-review', 'full', 'json', 'force'].includes(k)) { o[k.replace(/-(\w)/g, (_, c) => c.toUpperCase())] = true; continue; }
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
// The browser only renders the page; everything after the screenshot works on its pixels.
async function capture(page, maxHeight, shotPath) {
  const height = await fitViewport(page, maxHeight);
  const png = await page.screenshot({ type: 'png', animations: 'disabled', caret: 'hide' });
  await page.screenshot({ path: shotPath, type: 'jpeg', quality: 82, animations: 'disabled', caret: 'hide' });
  const seg = segment(decodePng(png));
  seg.height = height;
  return seg;
}

const viewerUrl = d => {
  const q = new URLSearchParams({ page: d.page });
  if (d.props && Object.keys(d.props).length) q.set('props', JSON.stringify(d.props));
  if (d.state && Object.keys(d.state).length) q.set('state', JSON.stringify(d.state));
  if (d.do?.length) q.set('do', JSON.stringify(d.do));
  return `view.html?${q}`;
};

export async function runPair(pair, cfg, { browser, designBase }) {
  const width = pair.width || cfg.width, height = pair.height || cfg.height, maxHeight = pair.maxHeight || cfg.maxHeight;
  const out = path.join(DIR, pair.id);
  fs.mkdirSync(out, { recursive: true });
  const logD = [], logL = [];
  const file = resolvePage(pair.design.page);
  const ctxOpts = { viewport: { width, height }, reducedMotion: 'reduce', deviceScaleFactor: 1, colorScheme: pair.theme === 'dark' ? 'dark' : 'light' };

  const dctx = await browser.newContext(ctxOpts);
  const dpage = await openPage(dctx, designBase, file, { props: { ...pair.design.props }, state: { ...pair.design.state }, do: [...(pair.design.do || [])] }, logD);
  const design = await capture(dpage, maxHeight, path.join(out, 'design.jpg'));
  await dctx.close();

  const lctx = await browser.newContext(ctxOpts);
  const lpage = await openLive(lctx, cfg.base, pair.live.path, { do: pair.live.do || [] }, logL);
  const finalUrl = lpage.url();
  const live = await capture(lpage, maxHeight, path.join(out, 'live.jpg'));
  await lctx.close();

  const result = compareImages(design, live);
  const report = {
    id: pair.id, baseId: pair.baseId, theme: pair.theme, label: pair.label || pair.id, generatedAt: new Date().toISOString(), base: cfg.base, method: 'screenshots',
    design: { ...pair.design, page: file, view: viewerUrl({ ...pair.design, page: file }), width, height: design.height, shot: 'design.jpg', items: design.blobs.length, background: design.background, log: [...new Set(logD)] },
    live: { ...pair.live, url: liveUrl(cfg.base, pair.live.path), finalUrl, width, height: live.height, shot: 'live.jpg', items: live.blobs.length, background: live.background, log: [...new Set(logL)] },
    ...result,
  };
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 1) + '\n');
  // the elements found in each screenshot, for debugging the vision (gitignored; signatures dropped)
  const strip = sg => ({ ...sg, blobs: sg.blobs.map(({ sig, ...b }) => b) });
  fs.writeFileSync(path.join(out, 'snapshot.json'), JSON.stringify({ design: strip(design), live: strip(live) }) + '\n');
  return report;
}

function summary(r) {
  const s = r.stats;
  const cats = CATEGORIES.filter(c => s.byCategory[c]).map(c => `${c} ${s.byCategory[c]}`).join(', ');
  return `${r.id}: ${s.matched} matched (${s.designItems} design / ${s.liveItems} live elements) · ${s.findings} findings [high ${s.bySeverity.high}, medium ${s.bySeverity.medium}, low ${s.bySeverity.low}] · ${cats}`;
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

  if (cmd === 'findings') {
    const rp = path.join(DIR, args[0] || '', 'report.json');
    if (!args[0] || !fs.existsSync(rp)) throw new Error(`no report for "${args[0]}"`);
    const r = JSON.parse(fs.readFileSync(rp, 'utf8'));
    console.log(`# ${r.label} (${r.theme || 'light'}) · ${r.findings.length} findings · design ${r.design.page} vs live ${r.live.url}`);
    console.log(`# screenshots: comparisons/${r.id}/design.jpg, comparisons/${r.id}/live.jpg (${r.design.width}×${r.design.height} / ${r.live.width}×${r.live.height})`);
    for (const f of r.findings) {
      const b = (f.design || f.live).box, lb = f.live?.box;
      console.log(`${f.id}\t${f.severity}\t${f.category}\t${f.text}\td@${b.x},${b.y}${lb && f.design ? ` l@${lb.x},${lb.y}` : ''}\t${f.props.map(p => `${p.prop}: ${p.design} → ${p.live}`).join('; ')}`);
    }
    return;
  }

  if (cmd === 'crop') {
    const [id, ...fids] = args;
    const rp = path.join(DIR, id || '', 'report.json');
    if (!id || !fs.existsSync(rp) || !fids.length) throw new Error('crop <id> <findingId> [...]');
    const r = JSON.parse(fs.readFileSync(rp, 'utf8'));
    const out = path.join(ROOT, 'screenshots', 'crops');
    fs.mkdirSync(out, { recursive: true });
    for (const fid of fids) {
      const f = r.findings.find(x => x.id === fid);
      if (!f) { console.log(`${fid}: no such finding`); continue; }
      const slug = `${id}-${fid}`.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '');
      for (const s of findingShots(r, f, path.join(DIR, id))) {
        const file = path.join(out, `${slug}-${s.name}`);
        fs.writeFileSync(file, s.data);
        console.log(path.relative(process.cwd(), file));
      }
    }
    return;
  }

  if (cmd === 'review') {
    const all = expandPairs(readConfig()).filter(p => !o.theme || p.theme === o.theme);
    const ids = args.length ? args.flatMap(a => all.filter(p => p.id === a || p.baseId === a).map(p => p.id)) : all.map(p => p.id);
    for (const id of ids) {
      const rp = path.join(DIR, id, 'report.json');
      if (!fs.existsSync(rp)) { console.log(`${id}: no report`); continue; }
      const r = JSON.parse(fs.readFileSync(rp, 'utf8'));
      const t = Date.now();
      const rv = await reviewReport(r, path.join(DIR, id), { model: o.model || REVIEW_MODEL, force: !!o.force, log: m => console.log(m) });
      console.log(`${id}: ${rv.done} reviewed, ${rv.skipped} unchanged${rv.failed ? `, ${rv.failed} failed` : ''} (${Math.round((Date.now() - t) / 1000)}s)`);
    }
    return;
  }

  if (cmd === 'group') {
    const [id, file] = args;
    const rp = path.join(DIR, id || '', 'report.json');
    if (!id || !fs.existsSync(rp)) throw new Error(`no report for "${id}"`);
    if (!file || !fs.existsSync(file)) throw new Error('group <id> <groups.json>: file not found');
    const r = JSON.parse(fs.readFileSync(rp, 'utf8'));
    const input = JSON.parse(fs.readFileSync(file, 'utf8'));
    const groups = Array.isArray(input) ? input : input.groups;
    if (!Array.isArray(groups)) throw new Error('expected { "groups": [...] }');
    const known = new Set(r.findings.map(f => f.id)), seen = new Map(), problems = [];
    groups.forEach((g, i) => {
      if (!g.id) g.id = String(g.title || `group-${i + 1}`).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      if (!g.title) problems.push(`group ${g.id}: no title`);
      if (!['high', 'medium', 'low'].includes(g.severity)) g.severity = 'medium';
      g.findings = (g.findings || []).filter(fid => { if (!known.has(fid)) { problems.push(`group ${g.id}: unknown finding ${fid}`); return false; } return true; });
      for (const fid of g.findings) { if (seen.has(fid)) problems.push(`${fid} is in both ${seen.get(fid)} and ${g.id}`); else seen.set(fid, g.id); }
    });
    const ids = new Set(groups.map(g => g.id));
    if (ids.size !== groups.length) problems.push('group ids must be unique');
    const ungrouped = r.findings.filter(f => !seen.has(f.id));
    fs.writeFileSync(path.join(DIR, id, 'groups.json'), JSON.stringify({ by: input.by || 'claude', at: new Date().toISOString(), reportGeneratedAt: r.generatedAt, groups }, null, 1) + '\n');
    console.log(`${id}: ${groups.length} groups covering ${seen.size} of ${r.findings.length} findings (${ungrouped.length} ungrouped)`);
    for (const p of problems) console.log(`  ! ${p}`);
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
          const r = await runPair(pair, cfg, { browser, designBase });
          console.log(`${summary(r)}  (${Math.round((Date.now() - t) / 1000)}s)`);
          if (!o.noReview && reviewAvailable()) {
            try { const rv = await reviewReport(r, path.join(DIR, id), { log: m => console.log(m) }); console.log(`  review: ${rv.done} reviewed, ${rv.skipped} unchanged${rv.failed ? `, ${rv.failed} failed` : ''}`); }
            catch (e) { console.log(`  review skipped: ${e.message}`); }
          }
          const gp = path.join(DIR, id, 'groups.json');
          if (fs.existsSync(gp)) {
            const known = new Set(r.findings.map(f => f.id));
            const gone = JSON.parse(fs.readFileSync(gp, 'utf8')).groups.flatMap(g => g.findings).filter(f => !known.has(f));
            if (gone.length) console.log(`  groups.json: ${gone.length} grouped findings no longer exist; regroup (node tools/compare.mjs findings ${id})`);
          }
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
