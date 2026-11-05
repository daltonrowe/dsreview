#!/usr/bin/env node
// Token survey generator.
//
//   node tools/survey.mjs new <id> --preset <preset> [--title "..."]   create surveys/<id>/spec.json
//   node tools/survey.mjs run <id> [--only <capture label substring>]   (re)generate surveys/<id>/survey.json + shots
//   node tools/survey.mjs presets                                        list token presets
//
// Survey = one token type (preset). Sections = distinct rendered values.
// Items = distinct usages: one per (component file, template element, value),
// each with a screenshot, where-used (page state + element address) and source line.
// Decisions live in surveys/<id>/decisions.json and are never touched here.

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT, PROJECT, startServer, openPage, settle } from './lib/render.mjs';
import { tplSource } from './lib/source.mjs';

const SURVEYS = path.join(ROOT, 'surveys');

// Keep in sync with PRESETS in tools/lib/bridge.js (titles only; logic lives there).
const PRESETS = {
  radius: 'Corner radius', 'text-color': 'Text color', background: 'Background color', gradient: 'Gradients',
  'border-color': 'Border color', 'border-width': 'Border width', shadow: 'Shadows',
  'font-size': 'Font size', 'font-weight': 'Font weight', 'line-height': 'Line height', 'letter-spacing': 'Letter spacing',
  'font-family': 'Font family', typography: 'Type styles', gap: 'Gap', padding: 'Padding', opacity: 'Opacity',
};

function args(argv) {
  const pos = [], o = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) o[argv[i].slice(2)] = argv[i + 1]?.startsWith('--') || argv[i + 1] === undefined ? true : argv[++i];
    else pos.push(argv[i]);
  }
  return { pos, o };
}

const hash = s => crypto.createHash('sha1').update(s).digest('hex').slice(0, 10);
const firstNum = v => { const m = String(v).match(/-?[\d.]+/); return m ? parseFloat(m[0]) : Infinity; };

function loadCaptures(spec) {
  if (Array.isArray(spec.captures)) return spec.captures;
  return JSON.parse(fs.readFileSync(path.join(SURVEYS, 'captures.json'), 'utf8')).captures;
}

async function run(id, o) {
  const dir = path.join(SURVEYS, id);
  const spec = JSON.parse(fs.readFileSync(path.join(dir, 'spec.json'), 'utf8'));
  let captures = loadCaptures(spec);
  if (o.only) captures = captures.filter(c => c.label.toLowerCase().includes(String(o.only).toLowerCase()));
  const shotsDir = path.join(dir, 'shots');
  fs.rmSync(shotsDir, { recursive: true, force: true });
  fs.mkdirSync(shotsDir, { recursive: true });

  const srv = await startServer();
  const base = `http://127.0.0.1:${srv.address().port}`;
  const browser = await chromium.launch();
  const items = new Map(); // key -> item
  const problems = [];
  let order = 0;
  const t0 = Date.now();

  try {
    for (const [ci, cap] of captures.entries()) {
      const ctx = await browser.newContext({ viewport: { width: cap.width || 1440, height: cap.height || 900 }, reducedMotion: 'reduce' });
      const log = [];
      let page;
      try {
        page = await openPage(ctx, base, cap.page, { props: { ...(cap.props || {}) }, state: cap.state || {}, do: cap.do || [] }, log);
      } catch (e) {
        problems.push(`${cap.label}: ${e.message.split('\n')[0]}`);
        await ctx.close();
        continue;
      }
      const recs = await page.evaluate(p => window.__dcv.collect(p), spec.preset);
      let fresh = 0;
      for (const r of recs) {
        const key = `${r.owner}|${r.tpl}|${r.value}`;
        const hit = items.get(key);
        if (hit) { hit.captures.push(ci); hit.instances += r.instances; continue; }
        const itemId = hash(`${spec.preset}|${key}`);
        const item = {
          id: itemId, order: order++, value: r.value,
          declared: r.declared, declaredProp: r.declaredProp, declaredFrom: r.declaredFrom, inheritedFrom: r.inheritedFrom, tokens: r.tokens,
          component: r.component, tag: r.tag, text: r.text, size: r.size, instances: r.instances,
          where: { capture: ci, owner: r.owner, tpl: r.tpl, nth: r.nth },
          captures: [ci], source: sourceFor(r.owner, r.tpl), shot: null,
        };
        items.set(key, item);
        try { item.shot = await shoot(page, r, path.join(shotsDir, `${itemId}.png`)) && `shots/${itemId}.png`; }
        catch (e) { problems.push(`${cap.label}: screenshot ${r.owner}#${r.tpl}: ${e.message.split('\n')[0]}`); }
        fresh++;
      }
      console.log(`[${ci + 1}/${captures.length}] ${cap.label}: ${recs.length} usages, ${fresh} new`);
      for (const l of new Set(log)) if (!/^(404|console)/.test(l)) problems.push(`${cap.label}: ${l}`);
      await ctx.close();
    }
  } finally {
    await browser.close();
    srv.close();
  }

  // group into sections by value
  const bySection = new Map();
  for (const it of [...items.values()].sort((a, b) => a.order - b.order)) {
    if (!bySection.has(it.value)) bySection.set(it.value, []);
    bySection.get(it.value).push(it);
  }
  let sections = [...bySection.entries()].map(([value, its]) => ({
    id: hash(`${spec.preset}|section|${value}`), value,
    tokens: [...new Set(its.flatMap(i => i.tokens))],
    usages: its.length, instances: its.reduce((n, i) => n + i.instances, 0),
    items: its.map((it, i) => { const { order: _, ...rest } = it; return { n: i + 1, ...rest }; }),
  }));
  const numeric = ['radius', 'border-width', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'typography', 'gap', 'padding', 'opacity'].includes(spec.preset);
  sections.sort(numeric ? (a, b) => firstNum(a.value) - firstNum(b.value) || a.value.localeCompare(b.value) : (a, b) => b.instances - a.instances);
  sections = sections.map((s, i) => ({ n: i + 1, ...s }));

  const survey = {
    id, title: spec.title, preset: spec.preset, description: spec.description || '',
    generatedAt: new Date().toISOString(), captures,
    stats: { sections: sections.length, usages: items.size, instances: sections.reduce((n, s) => n + s.instances, 0) },
    problems, sections,
  };
  fs.writeFileSync(path.join(dir, 'survey.json'), JSON.stringify(survey, null, 1));
  if (!fs.existsSync(path.join(dir, 'decisions.json'))) fs.writeFileSync(path.join(dir, 'decisions.json'), '{}\n');
  console.log(`\n${id}: ${sections.length} sections, ${items.size} usages (${survey.stats.instances} instances) in ${Math.round((Date.now() - t0) / 1000)}s`);
  if (problems.length) console.log(`${problems.length} problem(s):\n  ` + problems.slice(0, 20).join('\n  '));
  console.log(`→ surveys/${id}/survey.json   view: http://localhost:4321/survey.html?id=${id}`);
}

function sourceFor(owner, tpl) {
  const file = `${owner}.dc.html`;
  const abs = path.join(PROJECT, file);
  if (!fs.existsSync(abs)) return { file, line: null };
  const src = tplSource(abs, tpl);
  return src ? { file, line: src.line, col: src.col, snippet: src.snippet.length > 600 ? src.snippet.slice(0, 600) + '…' : src.snippet } : { file, line: null };
}

// Screenshot an element with surrounding context and a dashed highlight.
async function shoot(page, r, out) {
  const box = await page.evaluate(({ owner, tpl, nth }) => {
    const el = window.__dcv.find(owner, tpl, nth);
    if (!el) return null;
    el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    const rect = window.__dcv.highlight(el, { scroll: false });
    return rect && { x: rect.left, y: rect.top, w: rect.width, h: rect.height, vw: innerWidth, vh: innerHeight };
  }, r);
  if (!box) throw new Error('element not found');
  await page.waitForTimeout(60);
  await page.evaluate(() => Promise.all([...document.images].filter(i => !i.complete).map(i => new Promise(res => { i.onload = i.onerror = res; setTimeout(res, 1500); }))));
  // context: at least 320x160, 24px padding, clamped to viewport
  const pad = 24;
  let w = Math.max(box.w + pad * 2, 320), h = Math.max(box.h + pad * 2, 160);
  let x = box.x + box.w / 2 - w / 2, y = box.y + box.h / 2 - h / 2;
  x = Math.max(0, Math.min(x, box.vw - w)); y = Math.max(0, Math.min(y, box.vh - h));
  w = Math.min(w, box.vw - x); h = Math.min(h, box.vh - y);
  await page.screenshot({ path: out, clip: { x, y, width: w, height: h }, animations: 'disabled', caret: 'hide' });
  await page.evaluate(() => window.__dcv.unhighlight());
  return true;
}

async function main() {
  const { pos, o } = args(process.argv.slice(2));
  const [cmd, id] = pos;
  if (cmd === 'presets') { for (const [k, v] of Object.entries(PRESETS)) console.log(`${k.padEnd(16)} ${v}`); return; }
  if (cmd === 'new') {
    if (!id || !o.preset || !PRESETS[o.preset]) throw new Error(`usage: survey.mjs new <id> --preset <${Object.keys(PRESETS).join('|')}> [--title ...]`);
    const dir = path.join(SURVEYS, id);
    if (fs.existsSync(path.join(dir, 'spec.json'))) throw new Error(`surveys/${id} already exists`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'spec.json'), JSON.stringify({ title: o.title || PRESETS[o.preset], preset: o.preset, description: '', captures: 'default' }, null, 2) + '\n');
    console.log(`created surveys/${id}/spec.json, now: node tools/survey.mjs run ${id}`);
    return;
  }
  if (cmd === 'run') { if (!id) throw new Error('usage: survey.mjs run <id>'); await run(id, o); return; }
  console.log('usage:\n  node tools/survey.mjs presets\n  node tools/survey.mjs new <id> --preset <preset> [--title "..."]\n  node tools/survey.mjs run <id> [--only <capture label>]');
}

main().catch(e => { console.error('error: ' + e.message); process.exit(1); });
