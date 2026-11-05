#!/usr/bin/env node
// Suggested components: find elements that look the same (kind, height, radius, fill, border,
// shadow, text style) across the redesign and rank them by how often they recur.
//
//   node tools/components.mjs        → analysis/components/components.json + shots/
//
// Scans the same page states as the surveys (surveys/captures.json).
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT, startServer, openPage, shootElement } from './lib/render.mjs';

const OUT = path.join(ROOT, 'analysis/components');
const hash = s => crypto.createHash('sha1').update(s).digest('hex').slice(0, 10);

// Design-system components (design-system/tokens.json meta.components) that relate to each category.
const RELATED = {
  Button: ['Button'], 'Icon button': ['Button', 'CloseButton'], Chip: ['TabSelector'], Tab: ['TabSelector'],
  Badge: ['CreditBadge'], Control: ['Switch', 'ToggleSwitch', 'RadioSelector', 'NumericStepper', 'PaginationList'],
  Input: [], Card: [], 'Card (clickable)': [], Avatar: [],
};

function describeFamily(f) {
  const parts = [];
  if (f.height) parts.push(`~${f.height}px tall`);
  parts.push({ pill: 'pill', circle: 'circle', square: 'square corners', small: 'small radius', medium: 'medium radius', large: 'large radius', xl: 'extra-large radius' }[f.radius]);
  if (f.fill !== 'none') parts.push(`${f.fill} fill`);
  if (f.border) parts.push('border');
  if (f.shadow) parts.push('shadow');
  if (f.text) parts.push(`${f.text} text`);
  return parts.join(' · ');
}
function describe(spec, cat) {
  const parts = [];
  if (spec.height) parts.push(`${spec.height}px tall`);
  parts.push(spec.radius === '0' ? 'square corners' : spec.radius === 'pill' ? 'pill' : spec.radius === 'circle' ? 'circle' : `${spec.radius} radius`);
  if (spec.gradient) parts.push('gradient fill'); else if (spec.bg) parts.push(`fill ${spec.bg}`);
  if (spec.border) parts.push(spec.border === 'partial' ? 'partial border' : `border ${spec.border}`);
  if (spec.shadow) parts.push('shadow');
  if (spec.font) parts.push(`text ${spec.font.replace('/', ' / ')}`);
  if (spec.icon && cat !== 'Icon button') parts.push('with icon');
  return parts.join(' · ');
}

async function main() {
  const captures = JSON.parse(fs.readFileSync(path.join(ROOT, 'surveys/captures.json'), 'utf8')).captures;
  fs.rmSync(path.join(OUT, 'shots'), { recursive: true, force: true });
  fs.mkdirSync(path.join(OUT, 'shots'), { recursive: true });
  const srv = await startServer();
  const base = `http://127.0.0.1:${srv.address().port}`;
  const browser = await chromium.launch();
  const clusters = new Map(); // sig -> cluster
  const t0 = Date.now();
  try {
    for (const [ci, cap] of captures.entries()) {
      const ctx = await browser.newContext({ viewport: { width: cap.width || 1440, height: cap.height || 900 }, reducedMotion: 'reduce' });
      let page;
      try { page = await openPage(ctx, base, cap.page, { props: { ...(cap.props || {}) }, state: cap.state || {}, do: cap.do || [] }); }
      catch (e) { console.log(`[${ci + 1}] ${cap.label}: ${e.message.split('\n')[0]}`); await ctx.close(); continue; }
      const recs = await page.evaluate(() => window.__dcv.componentCandidates());
      for (const r of recs) {
        let c = clusters.get(r.sig);
        if (!c) {
          c = { id: hash(r.sig), sig: r.sig, category: r.cat, family: r.family, variants: new Map(), elements: new Map(), instances: 0, pages: new Set(), components: new Set(), texts: new Set(), example: null };
          clusters.set(r.sig, c);
        }
        const ek = `${r.owner}|${r.tpl}`;
        if (!c.elements.has(ek)) c.elements.set(ek, { owner: r.owner, tpl: r.tpl, nth: r.nth, capture: ci });
        c.instances += r.instances;
        const v = c.variants.get(r.exact) || { spec: r.spec, usages: new Set(), instances: 0 };
        v.usages.add(ek); v.instances += r.instances; c.variants.set(r.exact, v);
        c.pages.add(cap.page.replace(/\.dc\.html$/, ''));
        if (r.component) c.components.add(r.component);
        if (r.text) c.texts.add(r.text);
        if (!c.example) {
          c.example = { capture: ci, owner: r.owner, tpl: r.tpl, nth: r.nth };
          try { await shootElement(page, r, path.join(OUT, 'shots', `${c.id}.png`)); c.shot = `shots/${c.id}.png`; } catch { }
        }
      }
      console.log(`[${ci + 1}/${captures.length}] ${cap.label}: ${recs.length} candidates`);
      await ctx.close();
    }
  } finally { await browser.close(); srv.close(); }

  const list = [...clusters.values()].map(c => ({
    id: c.id, category: c.category, description: describeFamily(c.family), family: c.family,
    variants: [...c.variants.values()].map(v => ({ description: describe(v.spec, c.category), spec: v.spec, usages: v.usages.size, instances: v.instances })).sort((a, b) => b.usages - a.usages),
    usages: c.elements.size, instances: c.instances, pages: [...c.pages], components: [...c.components].slice(0, 12),
    examples: [...c.texts].slice(0, 6), example: c.example, shot: c.shot || null, related: RELATED[c.category] || [],
  }))
    // "used often": recurs as several distinct elements, or across pages
    .filter(c => c.usages >= 3 || (c.usages >= 2 && c.pages.length >= 2))
    .sort((a, b) => b.usages * b.pages.length - a.usages * a.pages.length || b.instances - a.instances);
  const out = { generatedAt: new Date().toISOString(), captures, total: list.length, components: list };
  fs.writeFileSync(path.join(OUT, 'components.json'), JSON.stringify(out, null, 1));
  const byCat = {};
  for (const c of list) byCat[c.category] = (byCat[c.category] || 0) + 1;
  console.log(`\n${list.length} suggested components in ${Math.round((Date.now() - t0) / 1000)}s:`, byCat);
}

main().catch(e => { console.error('error: ' + e.message); process.exit(1); });
