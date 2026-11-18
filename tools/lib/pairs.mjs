// comparisons/pairs.json -> the comparisons to run, one per pair and theme.
//
// Themes: the config's "themes" (default ["light", "dark"]), or a pair's own "themes".
//   light  id = the pair's id (so existing reports and decisions keep their ids)
//   dark   id = "<id>--dark". Design: the page's `theme` prop set to dark (the dc runtime matches option
//          values case-insensitively, so "dark" works for "Dark" too) unless the pair gives "dark": { design }
//          overrides. Live: the browser's prefers-color-scheme is dark (the live site follows it).
// A page with no `theme` prop and no dark override gets no dark comparison.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, readPropsMeta, resolvePage } from './render.mjs';

export const DIR = path.join(ROOT, 'comparisons');
export const DEFAULT_BASE = 'https://ao-4276-redesign-rollup.xeezy.com';

export function readConfig(dir = DIR) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(path.join(dir, 'pairs.json'), 'utf8')); } catch { raw = { pairs: [] }; }
  return { base: DEFAULT_BASE, width: 1440, height: 900, maxHeight: 3000, themes: ['light', 'dark'], ...raw };
}

function hasThemeProp(page) {
  try { return !!readPropsMeta(resolvePage(page))?.theme; } catch { return false; }
}

export function expandPairs(cfg) {
  const out = [];
  for (const p of cfg.pairs) {
    for (const theme of p.themes || cfg.themes) {
      if (theme === 'light') { out.push({ ...p, baseId: p.id, theme: 'light' }); continue; }
      if (theme !== 'dark') continue;
      const ov = p.dark || {};
      if (!ov.design && !hasThemeProp(p.design.page)) continue;
      out.push({
        ...p, id: `${p.id}--dark`, baseId: p.id, theme: 'dark', label: `${p.label || p.id}`,
        design: { ...p.design, ...ov.design, props: { ...p.design.props, ...(ov.design?.props || (ov.design ? {} : { theme: 'dark' })) } },
        live: { ...p.live, ...ov.live },
      });
    }
  }
  return out;
}
