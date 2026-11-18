// Compare two screenshots, element by element and as a whole, from pixels only.
//
//   compareImages(designSeg, liveSeg) -> { pairs, findings, stats }
//
// The inputs come from vision.segment(). Elements are paired by how they look (a grayscale thumbnail)
// near where they're expected; large flat things (panels, pictures, placeholders) can also pair by
// size and place alone. Findings describe what a designer would notice:
//   typography  text that's taller/shorter, heavier/lighter, wider/narrower
//   color       text/icon colour, panel fill, the page background
//   size        width / height of a panel, icon, picture, divider
//   shape       corner radius, border, a fill that's gone
//   spacing     gap to the next element below / to the right, content inset inside a panel
//   alignment   edges that line up anywhere on the page in the design and no longer do on live
//   missing     in the design, not on the live page
//   extra       on the live page, not in the design
import { ncc, colorDistance } from './vision.mjs';

export const CATEGORIES = ['typography', 'color', 'size', 'shape', 'spacing', 'alignment', 'missing', 'extra'];
const SEV = { low: 1, medium: 2, high: 3 };
const maxSev = list => list.reduce((a, b) => (SEV[b] > SEV[a] ? b : a), 'low');
const r1 = n => Math.round(n * 10) / 10;
const center = b => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
const dist = (a, b) => { const p = center(a), q = center(b); return Math.hypot(p.x - q.x, p.y - q.y); };
const hexRgb = h => (h ? [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)] : null);
const cdist = (a, b) => colorDistance(hexRgb(a), hexRgb(b));
const colorSev = d => (d > 60 ? 'high' : d > 25 ? 'medium' : 'low');
const ratio = (a, b) => Math.max(a / b, b / a);
const contains = (o, b) => b.x >= o.x - 1 && b.y >= o.y - 1 && b.x + b.w <= o.x + o.w + 1 && b.y + b.h <= o.y + o.h + 1;

// What kinds may be the same thing on the other side (a placeholder panel may be a photo on live).
const COMPAT = { grid: ['grid'], text: ['text', 'icon'], icon: ['icon', 'shape', 'text'], shape: ['shape', 'icon', 'image'], panel: ['panel', 'image', 'shape'], image: ['image', 'panel', 'shape'], line: ['line'] };

const MAX_JUMP = 400;
export function matchBlobs(D, L) {
  // 1. anchors: distinctive elements that look alike and are each other's best look-alike
  const best = (b, list) => {
    let top = null, second = -1;
    for (const o of list) {
      if (!COMPAT[b.kind].includes(o.kind) || ratio(b.box.w, o.box.w) > 1.15 || ratio(b.box.h, o.box.h) > 1.15) continue;
      const s = ncc(b.sig, o.sig);
      if (!top || s > top.s) { second = top ? top.s : second; top = { o, s }; } else if (s > second) second = s;
    }
    return top && { ...top, second };
  };
  let anchors = [];
  for (const d of D) {
    if (!d.sig || !(d.kind === 'text' || d.kind === 'icon') || d.box.w * d.box.h < 80) continue;
    const m = best(d, L);
    if (!m || m.s < 0.9 || m.s - m.second < 0.04) continue;
    const back = best(m.o, D);
    if (back?.o !== d) continue;
    anchors.push({ d, l: m.o, dx: m.o.box.x - d.box.x, dy: m.o.box.y - d.box.y });
  }
  const med = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; };
  const nearest = (b, list, k) => list.map(a => ({ a, dd: dist(b, a.d.box) })).sort((x, y) => x.dd - y.dd).slice(0, k).map(x => x.a);
  anchors = anchors.filter(a => {
    const nb = nearest(a.d.box, anchors.filter(x => x !== a), 5);
    if (nb.length < 2) return Math.abs(a.dy) < MAX_JUMP;
    return Math.abs(a.dy - med(nb.map(x => x.dy))) < 120 && Math.abs(a.dx - med(nb.map(x => x.dx))) < 120;
  });
  const expected = b => { const nb = nearest(b, anchors, 5); return { ...b, x: b.x + med(nb.map(x => x.dx)), y: b.y + med(nb.map(x => x.dy)) }; };

  // 2. everything: look-alikes near where they should be
  const cands = [];
  for (const d of D) {
    const ex = expected(d.box);
    for (const l of L) {
      if (!COMPAT[d.kind].includes(l.kind)) continue;
      // grids pair by where they start and how wide they are: their height is what may differ
      if (d.kind === 'grid') { const top = Math.min(Math.abs(ex.y - l.box.y), Math.abs(d.box.y - l.box.y)), left = Math.min(Math.abs(ex.x - l.box.x), Math.abs(d.box.x - l.box.x)); if (top <= 500 && left <= 80 && ratio(d.box.w, l.box.w) < 1.25) cands.push({ d, l, cost: (top + left) / 50, how: 'region' }); continue; }
      const jump = dist(ex, l.box);
      if (jump > MAX_JUMP) continue;
      const sr = ratio(d.box.w, l.box.w) + ratio(d.box.h, l.box.h) - 2;
      if (d.kind === 'line') { if (ratio(Math.max(d.box.w, d.box.h), Math.max(l.box.w, l.box.h)) < 1.5 && jump < 120) cands.push({ d, l, cost: jump / 20 + sr, how: 'shape' }); continue; }
      const s = ncc(d.sig, l.sig);
      if (s >= 0.6 && sr < 1.2) cands.push({ d, l, cost: (1 - s) * 6 + sr * 2 + jump / 150, how: 'look' });
      // a label in the same place at about the same size is the same label, even if its copy changed
      else if (d.kind === 'text' && l.kind === 'text' && ratio(d.box.h, l.box.h) < 1.25 && ratio(d.box.w, l.box.w) < 1.35 && jump < 24) cands.push({ d, l, cost: 6 + sr * 4 + jump / 10, how: 'place' });
      // big flat things: the same size in the same place is the same thing, whatever is inside
      else if (d.kind !== 'text' && d.box.w * d.box.h >= 1500 && ratio(d.box.w, l.box.w) < 1.12 && ratio(d.box.h, l.box.h) < 1.12 && jump < 60) cands.push({ d, l, cost: 8 + sr * 4 + jump / 20, how: 'place' });
    }
  }
  cands.sort((a, b) => a.cost - b.cost);
  const usedD = new Set(), usedL = new Set(), pairs = [];
  for (const c of cands) {
    if (usedD.has(c.d.id) || usedL.has(c.l.id)) continue;
    usedD.add(c.d.id); usedL.add(c.l.id);
    pairs.push({ d: c.d, l: c.l, how: c.how });
  }
  return { pairs, unmatchedD: D.filter(d => !usedD.has(d.id)), unmatchedL: L.filter(l => !usedL.has(l.id)), anchors: anchors.length };
}

// ---------- per element ----------
// A design placeholder where live shows a picture: the tile's shape and colour come from the content.
const placeholderPair = (d, l) => (d.kind === 'panel' || d.kind === 'shape') && l.kind === 'image';

function grid(d, l) {
  if (d.kind !== 'grid' || l.kind !== 'grid') return [];
  const rows = [];
  const endD = d.box.y + d.box.h, endL = l.box.y + l.box.h, dEnd = endL - endD;
  if (Math.abs(dEnd) >= 8) rows.push({ prop: 'ends at', design: `y=${endD}`, live: `y=${endL} (${Math.abs(dEnd)}px ${dEnd > 0 ? 'lower' : 'higher'})`, sev: Math.abs(dEnd) >= 40 ? 'high' : 'medium' });
  if (Math.abs(l.box.y - d.box.y) >= 6) rows.push({ prop: 'starts at', design: `y=${d.box.y}`, live: `y=${l.box.y}`, sev: Math.abs(l.box.y - d.box.y) >= 16 ? 'medium' : 'low' });
  if (d.layout !== l.layout) rows.push({ prop: 'layout', design: d.layout === 'columns' ? `${d.columns} columns (masonry)` : 'justified rows', live: l.layout === 'columns' ? `${l.columns} columns (masonry)` : 'justified rows', sev: 'high' });
  else if (d.layout === 'columns' && d.columns !== l.columns) rows.push({ prop: 'columns', design: d.columns, live: l.columns, sev: 'high' });
  if (Math.abs(d.box.w - l.box.w) > 4) rows.push({ prop: 'width', design: `${d.box.w}px`, live: `${l.box.w}px`, sev: 'medium' });
  // masonry: how unevenly the columns end
  const spread = e => Math.max(...e) - Math.min(...e);
  if (d.layout === 'columns' && d.columns === l.columns && Math.abs(spread(d.columnEnds) - spread(l.columnEnds)) >= 40) rows.push({ prop: 'ragged bottom', design: `columns end within ${spread(d.columnEnds)}px`, live: `within ${spread(l.columnEnds)}px`, sev: 'low' });
  return rows;
}

function typography(d, l) {
  if (d.kind !== 'text' || l.kind !== 'text') return [];
  const rows = [];
  const dh = l.box.h - d.box.h;
  if (Math.abs(dh) >= 2) rows.push({ prop: 'text height', design: `${d.box.h}px`, live: `${l.box.h}px (${dh > 0 ? 'bigger' : 'smaller'})`, sev: Math.abs(dh) >= 4 || Math.abs(dh) / d.box.h >= 0.15 ? 'high' : 'medium' });
  // same height, more ink: heavier type
  if (Math.abs(dh) <= 1 && d.ink > 0.04) {
    const r = l.ink / d.ink;
    if (r >= 1.2 || r <= 1 / 1.2) rows.push({ prop: 'weight', design: `ink ${Math.round(d.ink * 100)}%`, live: `ink ${Math.round(l.ink * 100)}% (${r > 1 ? 'heavier' : 'lighter'})`, sev: r >= 1.4 || r <= 1 / 1.4 ? 'high' : 'medium' });
  }
  const dw = l.box.w - d.box.w;
  if (Math.abs(dh) <= 1 && Math.abs(dw) >= 4 && Math.abs(dw) / d.box.w >= 0.04) rows.push({ prop: 'text width', design: `${d.box.w}px`, live: `${l.box.w}px (${dw > 0 ? 'wider' : 'narrower'}: spacing or copy)`, sev: Math.abs(dw) / d.box.w >= 0.12 ? 'medium' : 'low' });
  return rows;
}

function colors(d, l) {
  const rows = [];
  if (placeholderPair(d, l)) return rows;
  if ((d.kind === 'text' || d.kind === 'icon' || d.kind === 'line') && d.color && l.color && d.kind === l.kind) {
    const c = cdist(d.color, l.color);
    if (c > 14) rows.push({ prop: `${d.kind} color`, design: d.color, live: l.color, swatch: true, sev: colorSev(c) });
    // a second ink within the line (a coloured link in a grey sentence)
    if (d.kind === 'text' && (d.accent || l.accent)) {
      const ca = d.accent && l.accent ? cdist(d.accent, l.accent) : 999;
      if (ca > 20) rows.push({ prop: 'accent color (e.g. a link)', design: d.accent || 'none', live: l.accent || 'none (all one colour)', swatch: true, sev: !d.accent || !l.accent ? 'high' : colorSev(ca) });
    }
  }
  if (d.kind === 'panel' && l.kind === 'panel') {
    const c = cdist(d.fill, l.fill);
    if (c > 10) rows.push({ prop: 'fill', design: d.fill, live: l.fill, swatch: true, sev: colorSev(c) });
  }
  return rows;
}

function size(d, l) {
  if (d.kind === 'text' || d.kind === 'grid' || placeholderPair(d, l)) return []; // text: typography; grid: its own rows
  const rows = [];
  for (const [k, prop] of [['w', 'width'], ['h', 'height']]) {
    const x = d.box[k], y = l.box[k], dd = Math.abs(x - y);
    if (dd > 2 && dd / Math.max(x, y) > 0.03) rows.push({ prop, design: `${x}px`, live: `${y}px`, sev: dd >= 8 || dd / Math.max(x, y) >= 0.15 ? 'high' : dd >= 4 ? 'medium' : 'low' });
  }
  return rows;
}

function shape(d, l) {
  const rows = [];
  if (d.kind === 'panel' && l.kind !== 'panel' && l.kind !== 'image') rows.push({ prop: 'panel', design: `fill ${d.fill}`, live: 'no panel', sev: 'high' });
  if (d.kind !== 'panel' || l.kind !== 'panel') return rows;
  if (d.radius !== l.radius && !(typeof d.radius === 'number' && typeof l.radius === 'number' && Math.abs(d.radius - l.radius) < 3)) {
    rows.push({ prop: 'corner radius', design: d.radius === 'pill' ? 'pill' : `~${d.radius}px`, live: l.radius === 'pill' ? 'pill' : `~${l.radius}px`, sev: d.radius === 'pill' || l.radius === 'pill' || Math.abs(d.radius - l.radius) >= 6 ? 'medium' : 'low' });
  }
  const bd = d.border, bl = l.border;
  if (!!bd !== !!bl) rows.push({ prop: 'border', design: bd ? `${bd.width}px ${bd.color}` : 'none', live: bl ? `${bl.width}px ${bl.color}` : 'none', swatch: true, sev: 'medium' });
  else if (bd && bl && (cdist(bd.color, bl.color) > 14 || bd.width !== bl.width)) rows.push({ prop: 'border', design: `${bd.width}px ${bd.color}`, live: `${bl.width}px ${bl.color}`, swatch: true, sev: 'low' });
  return rows;
}

// ---------- relations between elements ----------
const EDGES = { left: b => b.x, right: b => b.x + b.w, top: b => b.y, bottom: b => b.y + b.h };
const nested = (a, b) => contains(a, b) || contains(b, a);
const structural = b => b.kind === 'panel' || b.kind === 'line' || b.kind === 'image' || Math.max(b.box.w, b.box.h) >= 200;

// Edges that line up anywhere on the page in the design and not on live. Per element and edge:
// flagged when it breaks most of its design alignments (so the thing that moved is named).
function alignment(pairs, name) {
  const per = new Map();
  const N = pairs.length;
  for (const edge of Object.keys(EDGES)) {
    const f = EDGES[edge];
    for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) {
      const A = pairs[i], B = pairs[j];
      if (Math.abs(f(A.d.box) - f(B.d.box)) > 1) continue;
      if (nested(A.d.box, B.d.box)) continue; // flush inside its parent: no choice was made
      // text bottoms depend on the letters (descenders): not an edge anyone aligns
      if (edge === 'bottom' && (A.d.kind === 'text' || B.d.kind === 'text')) continue;
      // page-wide, structure lines up (panels, dividers, pictures, long things: the masthead and the rail
      // button). Two small things lining up far apart is a coincidence, so those must be neighbours.
      const along = edge === 'left' || edge === 'right' ? Math.abs(center(A.d.box).y - center(B.d.box).y) : Math.abs(center(A.d.box).x - center(B.d.box).x);
      if (along > (structural(A.d) || structural(B.d) ? 1400 : 300)) continue;
      const off = f(A.l.box) - f(B.l.box), ok = Math.abs(off) <= 2;
      for (const [x, y, o] of [[i, j, off], [j, i, -off]]) {
        const k = `${x}:${edge}`;
        if (!per.has(k)) per.set(k, { kept: 0, broken: [] });
        if (ok) per.get(k).kept++; else per.get(k).broken.push({ j: y, off: o });
      }
    }
  }
  const movers = new Map();
  for (const [k, v] of per) if (v.broken.length && v.broken.length >= 2 * v.kept) movers.set(k, v);
  const out = [], done = new Set();
  for (const [k, v] of movers) {
    const i = Number(k.split(':')[0]), edge = k.split(':')[1];
    if (v.broken.length === 1) {
      const j = v.broken[0].j, other = movers.get(`${j}:${edge}`);
      if (other && other.broken.length === 1 && other.broken[0].j === i) {
        const a = pairs[i].d.box, b = pairs[j].d.box;
        if (a.w * a.h < b.w * b.h || done.has(`${j}:${i}:${edge}`)) continue;
        done.add(`${i}:${j}:${edge}`);
      }
    }
    const offs = v.broken.map(b => b.off).sort((a, b) => a - b);
    const m = offs[offs.length >> 1], dd = Math.abs(m);
    const A = pairs[i], B = pairs[v.broken[0].j], f = EDGES[edge], isX = edge === 'left' || edge === 'right';
    out.push({
      i, edge,
      row: {
        prop: `${edge} edge`,
        design: `lines up with ${name(B.d)}${v.broken.length > 1 ? ` +${v.broken.length - 1}` : ''} at ${isX ? 'x' : 'y'}=${f(A.d.box)}`,
        live: `off by ${r1(m)}px ${isX ? (m > 0 ? '→' : '←') : (m > 0 ? '↓' : '↑')} (${f(A.l.box)} vs ${f(B.l.box)})`,
        sev: dd >= 8 ? 'high' : dd >= 4 ? 'medium' : 'low',
      },
      guide: { axis: isX ? 'x' : 'y', design: [f(A.d.box)], live: [f(A.l.box), f(B.l.box)] },
      related: v.broken.slice(0, 6).map(b => ({ text: name(pairs[b.j].d), design: pairs[b.j].d.box, live: pairs[b.j].l.box })),
    });
  }
  return out;
}

// Gap to the nearest neighbour below and to the right; content inset inside a panel.
function spacing(pairs, name) {
  const res = new Map();
  const add = (i, row) => { if (!res.has(i)) res.set(i, []); res.get(i).push(row); };
  for (let i = 0; i < pairs.length; i++) {
    const a = pairs[i].d.box;
    for (const dir of ['below', 'right']) {
      let best = null;
      for (let j = 0; j < pairs.length; j++) {
        if (i === j) continue;
        const b = pairs[j].d.box;
        if (nested(a, b)) continue;
        const overlap = dir === 'below' ? Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) : Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        if (overlap <= Math.min(dir === 'below' ? Math.min(a.w, b.w) : Math.min(a.h, b.h), 8) * 0.5) continue;
        const gap = dir === 'below' ? b.y - (a.y + a.h) : b.x - (a.x + a.w);
        if (gap < 0 || gap > 160) continue;
        if (!best || gap < best.gap) best = { j, gap };
      }
      if (!best) continue;
      const A = pairs[i].l.box, B = pairs[best.j].l.box;
      const gapL = dir === 'below' ? B.y - (A.y + A.h) : B.x - (A.x + A.w);
      const dd = Math.abs(gapL - best.gap);
      if (dd < 3 || dd / Math.max(best.gap, Math.abs(gapL), 1) < 0.15) continue;
      add(i, {
        prop: `gap ${dir} → ${name(pairs[best.j].d)}`, design: `${best.gap}px`, live: `${gapL}px`, sev: dd >= 12 ? 'high' : dd >= 6 ? 'medium' : 'low',
        guide: dir === 'below' ? { axis: 'y', design: [a.y + a.h, a.y + a.h + best.gap], live: [A.y + A.h, A.y + A.h + gapL] } : { axis: 'x', design: [a.x + a.w, a.x + a.w + best.gap], live: [A.x + A.w, A.x + A.w + gapL] },
        related: [{ text: name(pairs[best.j].d), design: pairs[best.j].d.box, live: B }],
      });
    }
  }
  // One cause, one finding: when several elements' gaps to the same neighbour changed by the same amount
  // (a top bar's items all above a masthead that moved), keep the closest one and count the others.
  const groups = new Map();
  for (const [i, rows] of res) for (const r of rows) {
    if (!r.prop.startsWith('gap ')) continue;
    const k = `${r.prop}|${Math.round((parseFloat(r.live) - parseFloat(r.design)) / 3)}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push({ i, r });
  }
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    list.sort((a, b) => parseFloat(a.r.design) - parseFloat(b.r.design));
    list[0].r.prop += ` (+${list.length - 1} more above it, same change)`;
    for (const { i, r } of list.slice(1)) res.set(i, res.get(i).filter(x => x !== r));
  }
  // inset: where content sits inside the panel around it, for panels of about the same size
  const panels = pairs.filter(p => p.d.kind === 'panel' && p.l.kind === 'panel');
  for (let i = 0; i < pairs.length; i++) {
    const p = pairs[i];
    if (p.d.kind === 'panel') continue;
    const host = panels.filter(q => q !== p && contains(q.d.box, p.d.box) && contains(q.l.box, p.l.box)).sort((a, b) => a.d.box.w * a.d.box.h - b.d.box.w * b.d.box.h)[0];
    if (!host || ratio(host.d.box.w, host.l.box.w) > 1.03 || ratio(host.d.box.h, host.l.box.h) > 1.05) continue;
    for (const [k, prop] of [['x', 'left'], ['y', 'top']]) {
      const x = p.d.box[k] - host.d.box[k], y = p.l.box[k] - host.l.box[k], dd = Math.abs(x - y);
      if (dd >= 3) add(i, { prop: `inset ${prop} in ${name(host.d)}`, design: `${x}px`, live: `${y}px`, sev: dd >= 8 ? 'high' : dd >= 5 ? 'medium' : 'low', related: [{ text: name(host.d), design: host.d.box, live: host.l.box }] });
    }
  }
  return res;
}

// ---------- top level ----------
const KIND = { grid: 'Grid', text: 'Text', icon: 'Icon', panel: 'Panel', image: 'Picture', line: 'Divider', shape: 'Shape', page: 'Page' };
export const blobName = b => (b.kind === 'grid' ? `Grid of ${b.tiles} tiles, ${b.layout === 'columns' ? `${b.columns} columns` : `${b.rows} rows`} (${b.box.w}×${b.box.h})` : `${KIND[b.kind]} ${b.box.w}×${b.box.h}`);
const where = b => `at ${b.box.x}, ${b.box.y}`;

export function compareImages(design, live) {
  const D = design.blobs, L = live.blobs;
  const { pairs, unmatchedD, unmatchedL, anchors } = matchBlobs(D, L);
  const name = blobName;
  const align = alignment(pairs, name);
  const gaps = spacing(pairs, name);
  const side = b => ({ box: b.box, textBox: b.box, kind: b.kind });

  const findings = [];
  // stable ids: category + kind + design position on a 16px grid
  const key = b => `${b.kind}@${Math.round(center(b.box).x / 16)},${Math.round(center(b.box).y / 16)}`;
  const push = (category, b, rows, extra) => {
    if (!rows.length) return;
    const top = rows.filter(r => r.guide).sort((x, y) => SEV[y.sev] - SEV[x.sev])[0];
    const rel = rows.find(r => r.related);
    findings.push({
      id: `${category}:${extra.design ? '' : 'live:'}${key(b)}`, category, severity: maxSev(rows.map(r => r.sev)), text: name(b), section: where(b),
      props: rows.map(({ guide, related, ...r }) => r), ...extra,
      ...(top ? { guide: top.guide, related: top.related } : rel ? { related: rel.related } : {}),
    });
  };
  pairs.forEach((p, i) => {
    const sides = { design: side(p.d), live: side(p.l), match: p.how };
    push('typography', p.d, typography(p.d, p.l), sides);
    push('color', p.d, colors(p.d, p.l), sides);
    push('size', p.d, [...grid(p.d, p.l), ...size(p.d, p.l)], sides);
    push('shape', p.d, shape(p.d, p.l), sides);
    push('spacing', p.d, gaps.get(i) || [], sides);
  });
  for (const a of align) {
    const p = pairs[a.i];
    findings.push({ id: `alignment:${key(p.d)}:${a.edge}`, category: 'alignment', severity: a.row.sev, text: name(p.d), section: where(p.d), props: [a.row], design: side(p.d), live: side(p.l), guide: a.guide, related: a.related });
  }
  // the page itself
  const bgd = cdist(design.background, live.background);
  if (bgd > 8) {
    const page = s => side({ kind: 'page', box: { x: 0, y: 0, w: s.width, h: s.height } });
    findings.push({ id: 'color:page-background', category: 'color', severity: colorSev(bgd), text: 'Page background', section: 'whole page', props: [{ prop: 'background', design: design.background, live: live.background, swatch: true }], design: page(design), live: page(live) });
  }
  // only what a designer would miss: skip specks and pictures (their content differs anyway)
  const notable = b => b.box.w * b.box.h >= 120 && b.kind !== 'image';
  const sevOf = b => (b.box.w * b.box.h >= 2500 || (b.kind === 'text' && b.box.h >= 18) || b.kind === 'panel' ? 'medium' : 'low');
  // a design placeholder (panel/shape) where live shows a picture is sample content, not a missing element
  const pics = L.filter(b => b.kind === 'image');
  const overlap = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const placeholder = b => (b.kind === 'panel' || b.kind === 'shape') && pics.some(p => overlap(b.box, p.box) >= 0.4 * b.box.w * b.box.h);
  for (const b of unmatchedD.filter(b => notable(b) && !placeholder(b))) push('missing', b, [{ prop: KIND[b.kind].toLowerCase(), design: `${b.box.w}×${b.box.h}`, live: 'not found', sev: sevOf(b) }], { design: side(b), live: null });
  for (const b of unmatchedL.filter(notable)) push('extra', b, [{ prop: KIND[b.kind].toLowerCase(), design: 'not in design', live: `${b.box.w}×${b.box.h}`, sev: 'low' }], { design: null, live: side(b) });

  const seen = new Map();
  for (const f of findings) { const c = seen.get(f.id) || 0; seen.set(f.id, c + 1); if (c) f.id += `~${c}`; }
  const y = f => (f.design || f.live).box.y;
  findings.sort((a, b) => SEV[b.severity] - SEV[a.severity] || CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category) || y(a) - y(b));
  const byCategory = Object.fromEntries(CATEGORIES.map(c => [c, findings.filter(f => f.category === c).length]));
  const bySeverity = Object.fromEntries(Object.keys(SEV).map(s => [s, findings.filter(f => f.severity === s).length]));
  return {
    pairs: pairs.map(p => ({ design: p.d.id, live: p.l.id, how: p.how })),
    findings,
    stats: { designItems: D.length, liveItems: L.length, matched: pairs.length, anchors, missing: byCategory.missing, extra: byCategory.extra, findings: findings.length, byCategory, bySeverity },
  };
}
