#!/usr/bin/env node
// Design-project viewer for Claude Code (and humans).
// Renders pages from /design-project in headless Chromium, lets you set
// "tweak" props (states), run interactions, and screenshot whole pages or
// individual components ([data-screen-label] regions).
//
// Run `node tools/dc.mjs help` for usage.

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, PROJECT, allPages, resolvePage, startServer, openPage, settle, sel, readPropsMeta, splitProps, jsonish, coerce } from './lib/render.mjs';

const SHOTS = path.join(ROOT, 'screenshots');

const HELP = `
dc.mjs: view & screenshot design-project pages, components and states

  node tools/dc.mjs list
      All pages, their tweak props (states) with options/defaults.

  node tools/dc.mjs inspect <page> [state opts]
      Props, current values, the components ([data-screen-label]) visible in
      that state, and the clickable controls (for --do click:...).

  node tools/dc.mjs shot <page> [state opts] [shot opts]
      Screenshot. Prints the PNG path(s).

  node tools/dc.mjs matrix <page> --vary <prop>[,<prop2>] [state opts] [shot opts]
      One screenshot per option (cartesian product if several props).

<page>  File name with or without ".dc.html", case-insensitive, partial match ok
        (e.g. "pricing", "AI Magic", "log in v1").

State opts
  --props k=v,k2=v2   Set tweak props (use "list" to see names/options).
                      Booleans: true/false. Repeatable. Values match options
                      case-insensitively / by substring ("dark", "option 2").
  --state k=v,k2=v2   Set the page's internal (non-prop) state, e.g. which view
                      an app page shows (AI Magic: active=search|explore|...).
                      Values are parsed as JSON when possible. See "inspect".
  --do <step>         Interaction, repeatable, run in order after props:
                        click:<selector>    hover:<selector>
                        fill:<selector>::<text>   press:<Key>
                        scroll:<selector>   wait:<ms>   eval:<js>
                      <selector> is any Playwright selector: CSS,
                      text=Monthly, role=button[name="Buy"], label=<screen label>
                      (shorthand for [data-screen-label="..."]).
  --width N --height N  Viewport (default 1440x900).
  --theme dark        Sets ?theme=dark for pages that read it.

Shot opts
  --component <label>  Crop to a [data-screen-label] region (exact, then
                       case-insensitive substring match). --nth N picks the
                       Nth match (0-based) when the label repeats.
  --selector <sel>     Crop to an arbitrary element instead.
  --all-components     One shot per visible component in this state.
  --full               Full page height, including pages whose content scrolls
                       inside an inner container (default: viewport only).
  --out <path>         Output file (single shot only). Default: screenshots/<auto>.png
  --scale N            deviceScaleFactor (default 1; 2 for retina detail).
`;

// ---------- args ----------
function parseArgs(argv) {
  const pos = [];
  const o = { props: {}, state: {}, do: [], width: 1440, height: 900, nth: 0, scale: 1 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { pos.push(a); continue; }
    const k = a.slice(2);
    const flag = ['full', 'all-components', 'json'].includes(k);
    const v = flag ? true : argv[++i];
    if (k === 'props') for (const kv of splitProps(v)) { const j = kv.indexOf('='); o.props[kv.slice(0, j).trim()] = coerce(kv.slice(j + 1).trim()); }
    else if (k === 'state') for (const kv of splitProps(v)) { const j = kv.indexOf('='); o.state[kv.slice(0, j).trim()] = jsonish(kv.slice(j + 1).trim()); }
    else if (k === 'do') o.do.push(v);
    else if (['width', 'height', 'nth', 'scale'].includes(k)) o[k] = Number(v);
    else o[k.replace(/-(\w)/g, (_, c) => c.toUpperCase())] = v;
  }
  return { cmd: pos[0], page: pos[1], o };
}

async function describe(page) {
  return page.evaluate(() => {
    const vis = el => window.__dcv.vis(el);
    const root = window.__dcRootName?.();
    const entry = root && window.__dcRegistry?.[root];
    const labels = {};
    for (const el of document.querySelectorAll('[data-screen-label]')) {
      if (!vis(el)) continue;
      const l = el.dataset.screenLabel, r = el.getBoundingClientRect();
      (labels[l] ||= []).push(`${Math.round(r.width)}x${Math.round(r.height)}@${Math.round(r.left + scrollX)},${Math.round(r.top + scrollY)}`);
    }
    const controls = [];
    for (const el of document.querySelectorAll('button, a[href], [role=button], [role=tab], input, select, textarea, [onclick]')) {
      if (!vis(el)) continue;
      const t = (el.getAttribute('aria-label') || el.innerText || el.placeholder || el.title || '').trim().replace(/\s+/g, ' ').slice(0, 60);
      if (t) controls.push(`${el.tagName.toLowerCase()}${el.type && el.tagName === 'INPUT' ? `[${el.type}]` : ''}: ${t}`);
    }
    return { root, state: window.__dcv.getState(), props: entry?.propsMeta || null, preview: entry?.preview || null, components: labels, controls: [...new Set(controls)], scrollHeight: document.documentElement.scrollHeight };
  });
}

function slug(s) { return String(s).toLowerCase().replace(/\.dc\.html$|\.html$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }
function autoName(file, o, extra) {
  const parts = [slug(file)];
  for (const [k, v] of Object.entries(o.props)) parts.push(`${slug(k)}-${slug(v)}`);
  for (const [k, v] of Object.entries(o.state)) parts.push(`${slug(k)}-${slug(JSON.stringify(v))}`);
  if (o.do.length) parts.push('do-' + slug(o.do.map(d => d.split(':').slice(1).join(':')).join('-')).slice(0, 40));
  if (o.theme) parts.push(o.theme);
  if (extra) parts.push(slug(extra));
  if (o.full) parts.push('full');
  if (o.width !== 1440) parts.push(`w${o.width}`);
  return path.join(SHOTS, parts.join('__') + '.png');
}

async function findComponent(page, label, nth) {
  let loc = page.locator(`[data-screen-label=${JSON.stringify(label)}]`);
  if (!(await loc.count())) {
    const labels = await page.evaluate(() => [...new Set([...document.querySelectorAll('[data-screen-label]')].map(e => e.dataset.screenLabel))]);
    const hit = labels.filter(l => l.toLowerCase().includes(label.toLowerCase()));
    if (hit.length !== 1) throw new Error(`component "${label}" ${hit.length ? 'is ambiguous: ' + hit.join(', ') : 'not found'} in this state. Present: ${labels.join(', ')}`);
    loc = page.locator(`[data-screen-label=${JSON.stringify(hit[0])}]`);
  }
  const visible = [];
  const flags = await loc.evaluateAll(els => els.map(e => window.__dcv.vis(e)));
  flags.forEach((v, i) => v && visible.push(loc.nth(i)));
  if (!visible.length) throw new Error(`component "${label}" exists but is not visible in this state (try --do click:... to open it)`);
  if (nth >= visible.length) throw new Error(`--nth ${nth} out of range; ${visible.length} visible match(es)`);
  return visible[nth];
}

async function shoot(page, file, o, out) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const opts = { path: out, animations: 'disabled', caret: 'hide' };
  if (o.component || o.selector) {
    const el = o.component ? await findComponent(page, o.component, o.nth) : page.locator(sel(o.selector)).nth(o.nth);
    await el.screenshot(opts);
  } else {
    if (o.full) {
      // If the document itself doesn't scroll but an inner container does, grow the viewport to fit it.
      const extra = await page.evaluate(() => {
        if (document.documentElement.scrollHeight > innerHeight + 4) return 0;
        let best = 0;
        for (const el of document.querySelectorAll('*')) {
          const d = el.scrollHeight - el.clientHeight;
          if (d > best && el.clientHeight > innerHeight * 0.5 && /(auto|scroll)/.test(getComputedStyle(el).overflowY) && window.__dcv.vis(el)) best = d;
        }
        return best;
      });
      if (extra > 0) {
        const vp = page.viewportSize();
        await page.setViewportSize({ width: vp.width, height: Math.min(vp.height + extra, 20000) });
        await settle(page);
      }
    }
    await page.screenshot({ ...opts, fullPage: !!o.full });
  }
  return out;
}

// ---------- commands ----------
async function main() {
  const { cmd, page: q, o } = parseArgs(process.argv.slice(2));
  if (!cmd || cmd === 'help' || cmd === '--help') { console.log(HELP); return; }

  if (cmd === 'list' && !q) {
    // props are static: read them straight from the files, no browser needed
    for (const f of allPages()) {
      const html = fs.readFileSync(path.join(PROJECT, f), 'utf8');
      const kind = f.endsWith('.dc.html') ? '' : '  (standalone export, no props)';
      console.log(`\n${f}${kind}`);
      const imports = [...html.matchAll(/<dc-import name="([^"]+)"([^>]*)>/g)];
      if (imports.length) console.log(`  imports: ${imports.map(x => `${x[1]}(${x[2].match(/\b(?:layout|direction)="[^"]*"/g)?.join(' ') || ''})`).join(', ')}`);
      const meta = readPropsMeta(f);
      if (!meta) continue;
      const bySection = {};
      for (const [k, v] of Object.entries(meta)) if (!k.startsWith('$')) (bySection[v.section || ''] ||= []).push([k, v]);
      for (const [sec, items] of Object.entries(bySection)) {
        if (sec) console.log(`  [${sec}]`);
        for (const [k, v] of items) console.log(`    ${k} = ${JSON.stringify(v.default)}${v.options ? `  ∈ ${v.options.map(x => JSON.stringify(x)).join(' | ')}` : `  (${v.editor || v.tsType})`}`);
      }
    }
    return;
  }

  const file = resolvePage(q);
  const srv = await startServer();
  const base = `http://127.0.0.1:${srv.address().port}`;
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: o.width, height: o.height }, deviceScaleFactor: o.scale, reducedMotion: 'reduce' });
  const log = [];
  const outs = [];
  try {
    if (cmd === 'inspect') {
      const page = await openPage(ctx, base, file, o, log);
      const d = await describe(page);
      console.log(`page: ${file}   root: ${d.root}   scrollHeight: ${d.scrollHeight}px @ ${o.width}w`);
      if (d.props) {
        console.log('\nprops (states):');
        for (const [k, v] of Object.entries(d.props)) {
          const cur = k in o.props ? o.props[k] : v.default;
          console.log(`  ${k} = ${JSON.stringify(cur)}${v.options ? `  ∈ ${v.options.map(x => JSON.stringify(x)).join(' | ')}` : ''}${v.section ? `   [${v.section}]` : ''}`);
        }
      }
      if (d.state) {
        console.log('\ninternal state (settable with --state; objects/arrays shown abbreviated):');
        for (const [k, v] of Object.entries(d.state)) console.log(`  ${k} = ${JSON.stringify(v)}`);
      }
      console.log('\ncomponents visible in this state (label: WxH@x,y per instance):');
      for (const [l, inst] of Object.entries(d.components)) console.log(`  ${l}: ${inst.join('  ')}`);
      console.log(`\ncontrols (${d.controls.length}):`);
      for (const c of d.controls.slice(0, 150)) console.log(`  ${c}`);
      if (d.controls.length > 150) console.log(`  … ${d.controls.length - 150} more`);
    } else if (cmd === 'shot') {
      const page = await openPage(ctx, base, file, o, log);
      if (o.allComponents) {
        const d = await describe(page);
        for (const [l, inst] of Object.entries(d.components)) for (let i = 0; i < inst.length; i++) {
          try { outs.push(await shoot(page, file, { ...o, component: l, nth: i }, autoName(file, o, `${l}${inst.length > 1 ? '-' + i : ''}`))); }
          catch (e) { log.push(`skip ${l}#${i}: ${e.message}`); }
        }
      } else {
        outs.push(await shoot(page, file, o, o.out ? path.resolve(o.out) : autoName(file, o, o.component ? `${o.component}${o.nth ? '-' + o.nth : ''}` : o.selector)));
      }
    } else if (cmd === 'matrix') {
      if (!o.vary) throw new Error('--vary <prop>[,<prop>] required');
      const probe = await openPage(ctx, base, file, { ...o, props: {}, state: {}, do: [] }, log);
      const meta = (await describe(probe)).props || {};
      await probe.close();
      const vary = o.vary.split(',').map(s => s.trim());
      let combos = [{}];
      for (const k of vary) {
        const m = meta[k];
        if (!m) throw new Error(`unknown prop "${k}". Props: ${Object.keys(meta).join(', ')}`);
        const opts = m.options || (m.editor === 'boolean' ? [true, false] : null);
        if (!opts) throw new Error(`prop "${k}" has no enumerable options`);
        combos = combos.flatMap(c => opts.map(v => ({ ...c, [k]: v })));
      }
      if (combos.length > 40) throw new Error(`${combos.length} combinations; narrow --vary (max 40)`);
      for (const c of combos) {
        const oc = { ...o, props: { ...o.props, ...c }, state: { ...o.state }, do: [...o.do] };
        const page = await openPage(ctx, base, file, oc, log);
        try { outs.push(await shoot(page, file, oc, autoName(file, oc, o.component))); }
        catch (e) { log.push(`skip ${JSON.stringify(c)}: ${e.message}`); }
        await page.close();
      }
    } else {
      throw new Error(`unknown command "${cmd}"\n${HELP}`);
    }
  } finally {
    await browser.close();
    srv.close();
  }
  for (const p of outs) console.log(path.relative(process.cwd(), p) || p);
  const uniq = [...new Set(log)];
  if (uniq.length) console.error(`\n[${uniq.length} page issue(s)]\n  ` + uniq.slice(0, 15).join('\n  ') + (uniq.length > 15 ? `\n  … ${uniq.length - 15} more` : ''));
}

main().catch(e => { console.error('error: ' + e.message.split('\nCall log')[0].replace(/\x1b\[[0-9;]*m/g, '')); process.exit(1); });
