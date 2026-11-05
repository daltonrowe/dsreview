#!/usr/bin/env node
// Meta-survey: group a survey's usages into "parts of the page" so one decision covers them all.
//
//   node tools/group.mjs <survey-id> [...]     → surveys/<id>/groups.json
//   node tools/group.mjs --all
//
// Two usages are in the same group when (union-find, so links chain):
//   element  they are the same template element (same file + template node), e.g. one button seen
//            with different values in light and dark mode;
//   style    their source tags match once position/size is ignored: same tag, classes and visual CSS
//            (colors, radius, padding, type, borders, ...). Copy-pasted parts, repeated list items and
//            the same card in Pricing Option 1-4 land together;
//   rule     the value comes from the same stylesheet rule and property;
//   copy     identical source tag and identical text: a part copy-pasted between layouts or pages;
//   sibling  same file, same labelled region (data-screen-label), same tag and classes, same value as
//            written, and a similar size (within 30%): repeated parts whose inline styles differ slightly.
// Style and sibling links need a distinctive look (a fill, border, shadow, padding or gap, or a
// class): shared typography like `font-size: 14px; font-weight: 600` is not enough to call two parts the same.
//
// Decisions stay per usage (decisions.json); the viewer applies a group decision to every member.
// surveys/<id>/groups.overrides.json (optional) adjusts the result: { "split": [[itemId, ...], ...],
// "merge": [[itemId, itemId, ...], ...] }; split pulls the listed usages out into their own group.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT } from './lib/render.mjs';

const SURVEYS = path.join(ROOT, 'surveys');
const hash = s => crypto.createHash('sha1').update(s).digest('hex').slice(0, 10);

// Layout/positioning: differs between copies of the same part, so it is left out of the signature.
const LAYOUT = /^(position|top|right|bottom|left|inset|z-index|width|height|min-width|min-height|max-width|max-height|margin(-.*)?|flex(-.*)?|order|align-self|justify-self|grid(-.*)?|place-self|transform|translate|rotate|scale|transition(-.*)?|animation(-.*)?|cursor|pointer-events|user-select|visibility|overflow(-.*)?|aspect-ratio|object-position|will-change|content-visibility|isolation|box-sizing|vertical-align|white-space|text-overflow|word-break|overflow-wrap|hyphens|scroll-.*)$/;

function parseTag(snippet) {
  if (!snippet) return null;
  const tag = (snippet.match(/^<([\w:-]+)/) || [])[1]?.toLowerCase();
  const attr = name => { const m = snippet.match(new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`, 'i')); return m ? m[1] : null; };
  // numbered modifiers (cat-stack__c1, __c2) mark copies of one part, so numbers are ignored
  const classes = [...new Set((attr('class') || '').split(/\s+/).filter(c => c && !c.includes('{{')).map(c => c.replace(/\d+/g, '#')))].sort();
  const decls = [];
  for (const d of (attr('style') || '').split(/;(?![^(]*\))/)) {
    const i = d.indexOf(':');
    if (i < 0) continue;
    // template variables ({{ pc.stackBg1 }}, {{ pc.stackBg2 }}) are the same slot filled differently
    const prop = d.slice(0, i).trim().toLowerCase(), val = d.slice(i + 1).trim().replace(/\{\{[^}]*\}\}/g, '{{}}').replace(/\s+/g, ' ');
    if (!prop || LAYOUT.test(prop)) continue;
    decls.push(`${prop}:${val}`);
  }
  decls.sort();
  return { tag, classes, decls };
}

// Typography alone (font-size + weight + color) is shared by unrelated text all over a page, so a
// signature only identifies a part when it also has a shape (fill, border, shadow, padding, gap)
// or a class.
const SHAPE = /^(background|border|box-shadow|padding|outline|gap|row-gap|column-gap)/;
const distinctive = t => t && (t.classes.length > 0 || t.decls.some(d => SHAPE.test(d)));

function signature(it) {
  const t = parseTag(it.source?.snippet);
  if (!t?.tag || !distinctive(t)) return null;
  if (t.decls.length < 2 && !t.classes.length) return null;
  return `${t.tag}.${t.classes.join('.')}{${t.decls.join(';')}}`;
}

class UnionFind {
  constructor() { this.p = new Map(); }
  find(x) { if (!this.p.has(x)) this.p.set(x, x); let r = x; while (this.p.get(r) !== r) r = this.p.get(r); while (this.p.get(x) !== r) { const n = this.p.get(x); this.p.set(x, r); x = n; } return r; }
  union(a, b) { const ra = this.find(a), rb = this.find(b); if (ra !== rb) this.p.set(rb, ra); }
}

function group(id) {
  const dir = path.join(SURVEYS, id);
  const survey = JSON.parse(fs.readFileSync(path.join(dir, 'survey.json'), 'utf8'));
  const overrides = fs.existsSync(path.join(dir, 'groups.overrides.json')) ? JSON.parse(fs.readFileSync(path.join(dir, 'groups.overrides.json'), 'utf8')) : {};
  const items = survey.sections.flatMap(s => s.items.map(it => ({ ...it, section: s })));
  const uf = new UnionFind();
  const reasons = new Map(); // root-independent: itemId -> Set(reason)
  const note = (a, r) => { if (!reasons.has(a)) reasons.set(a, new Set()); reasons.get(a).add(r); };
  const link = (list, reason) => {
    for (let i = 1; i < list.length; i++) { uf.union(list[0].id, list[i].id); note(list[0].id, reason); note(list[i].id, reason); }
  };
  const bucket = key => { const m = new Map(); for (const it of items) { const k = key(it); if (!k) continue; if (!m.has(k)) m.set(k, []); m.get(k).push(it); } return m; };

  for (const it of items) uf.find(it.id);
  for (const list of bucket(it => `${it.where.owner}|${it.where.tpl}`).values()) link(list, 'element');
  for (const list of bucket(signature).values()) link(list, 'style');
  // exact copies: the same source tag carrying the same text (copy-pasted between layouts/pages)
  for (const list of bucket(it => (it.source?.snippet && it.text ? `${it.source.snippet.replace(/\s+/g, ' ')}|${it.text}` : null)).values()) link(list, 'copy');
  for (const list of bucket(it => (it.declaredFrom && it.declaredFrom !== 'inline' ? `${it.declaredFrom}|${it.declaredProp}` : null)).values()) link(list, 'rule');
  const similar = (a, b) => a.size && b.size && [0, 1].every(k => Math.abs(a.size[k] - b.size[k]) <= 0.3 * Math.max(a.size[k], b.size[k], 1));
  for (const list of bucket(it => { const t = parseTag(it.source?.snippet); return it.component && it.declared && distinctive(t) ? `${it.where.owner}|${it.component}|${it.tag}|${t.classes.join('.')}|${it.declaredProp}:${it.declared}` : null; }).values()) {
    // link each to every similar-sized member (pairwise; lists are small)
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) if (similar(list[i], list[j])) { uf.union(list[i].id, list[j].id); note(list[i].id, 'sibling'); note(list[j].id, 'sibling'); }
  }
  for (const ids of overrides.merge || []) for (let i = 1; i < ids.length; i++) uf.union(ids[0], ids[i]);

  // collect
  const byRoot = new Map();
  for (const it of items) { const r = uf.find(it.id); if (!byRoot.has(r)) byRoot.set(r, []); byRoot.get(r).push(it); }
  let groups = [...byRoot.values()];
  // split overrides: pull listed usages into their own group
  for (const ids of overrides.split || []) {
    const set = new Set(ids);
    groups = groups.flatMap(g => { const a = g.filter(it => set.has(it.id)), b = g.filter(it => !set.has(it.id)); return a.length && b.length ? [a, b] : [g]; });
  }

  const out = groups.map(members => {
    members.sort((a, b) => a.section.n - b.section.n || a.n - b.n);
    const top = (f, n = 1) => { const c = new Map(); for (const m of members) { const v = f(m); if (v) c.set(v, (c.get(v) || 0) + m.instances); } return [...c].sort((a, b) => b[1] - a[1]).slice(0, n).map(x => x[0]); };
    const component = top(m => m.component)[0] || null;
    const tag = top(m => m.tag)[0];
    const text = top(m => m.text)[0] || '';
    const declared = top(m => (m.declared ? `${m.declaredProp}: ${m.declared}` : null))[0] || null;
    const why = [...new Set(members.flatMap(m => [...(reasons.get(m.id) || [])]))].sort();
    return {
      id: hash(members.map(m => m.id).sort().join(',')),
      label: [component, `<${tag}>`, text && `“${text.slice(0, 40)}”`].filter(Boolean).join(' · '),
      component, tag, text, declared,
      items: members.map(m => m.id),
      values: [...new Set(members.map(m => m.value))],
      pages: [...new Set(members.flatMap(m => m.captures.map(c => survey.captures[c].page.replace(/\.dc\.html$/, ''))))],
      usages: members.length,
      instances: members.reduce((n, m) => n + m.instances, 0),
      why,
    };
  }).sort((a, b) => b.instances - a.instances || b.usages - a.usages);
  out.forEach((g, i) => { g.n = i + 1; });

  const result = { survey: id, generatedAt: new Date().toISOString(), usages: items.length, groups: out };
  fs.writeFileSync(path.join(dir, 'groups.json'), JSON.stringify(result, null, 1));
  const multi = out.filter(g => g.usages > 1);
  console.log(`${id.padEnd(12)} ${items.length} usages → ${out.length} groups (${multi.length} with 2+ usages covering ${multi.reduce((n, g) => n + g.usages, 0)}; largest ${out.reduce((m, g) => Math.max(m, g.usages), 0)})`);
  return result;
}

const args = process.argv.slice(2);
const ids = args.includes('--all') ? fs.readdirSync(SURVEYS).filter(d => fs.existsSync(path.join(SURVEYS, d, 'survey.json'))).sort() : args;
if (!ids.length) { console.log('usage: node tools/group.mjs <survey-id> [...] | --all'); process.exit(1); }
for (const id of ids) group(id);
