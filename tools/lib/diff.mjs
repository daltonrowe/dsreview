// Compare two page snapshots (tools/lib/snapshot.js): one of a design page, one of the live site.
// Pure functions, no browser: match items across the two pages, then turn the differences into
// findings a reviewer can decide on.
//
//   compareSnapshots(design, live) -> { pairs, findings, stats }
//
// Categories:
//   typography  font size / weight / family / line height / letter spacing / case / style
//   color       text color, box background or gradient
//   size        width / height of the box around a piece of text (button, chip, input, card)
//   shape       corner radius, border, shadow, a box that exists on one side only
//   spacing     padding inside a box, gap to the next element below / to the right
//   alignment   an element that no longer lines up with the things it lined up with in the design
//   icon        icon count or size inside a box
//   behavior    hover effect, clickability, cursor
//   missing     in the design, not found on the live page
//   extra       on the live page, not in the design

export const CATEGORIES = ['typography', 'color', 'size', 'shape', 'spacing', 'alignment', 'icon', 'behavior', 'missing', 'extra'];
const SEV = { low: 1, medium: 2, high: 3 };
const maxSev = list => list.reduce((a, b) => (SEV[b] > SEV[a] ? b : a), 'low');

// ---------- text keys and similarity ----------
export const normKey = s => String(s || '').toLowerCase().replace(/[“”"'‘’`]/g, '').replace(/[…]/g, '...').replace(/\s+/g, ' ').trim();
function bigrams(s) { const out = new Map(); for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); out.set(g, (out.get(g) || 0) + 1); } return out; }
export function similarity(a, b) {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const A = bigrams(a), B = bigrams(b);
  let inter = 0;
  for (const [g, n] of A) inter += Math.min(n, B.get(g) || 0);
  return (2 * inter) / (a.length - 1 + b.length - 1);
}

// ---------- geometry ----------
const center = b => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
const dist = (a, b) => { const p = center(a), q = center(b); return Math.hypot(p.x - q.x, p.y - q.y); };
const r1 = n => Math.round(n * 10) / 10;

// ---------- colors ----------
export function parseColor(c) {
  if (!c) return null;
  const m = String(c).match(/^#([0-9a-f]{6})(?:\s*\/\s*(\d+)%)?$/i);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: n >> 16, g: (n >> 8) & 255, b: n & 255, a: m[2] === undefined ? 1 : Number(m[2]) / 100 };
}
// 0 (same) .. ~440 (black vs white); null counts as transparent
export function colorDistance(a, b) {
  if (a === b) return 0;
  const p = parseColor(a) || { r: 255, g: 255, b: 255, a: 0 }, q = parseColor(b) || { r: 255, g: 255, b: 255, a: 0 };
  // weighted RGB ("redmean"), good enough to rank how visible a change is
  const rm = (p.r + q.r) / 2, dr = p.r - q.r, dg = p.g - q.g, db = p.b - q.b;
  const rgb = Math.sqrt((2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db) / 3;
  return Math.max(rgb * Math.min(p.a, q.a), Math.abs(p.a - q.a) * 255);
}
const colorSev = d => (d > 60 ? 'high' : d > 20 ? 'medium' : 'low');

// ---------- matching ----------
// 1. Anchors: texts that occur exactly once on each side and agree with their neighbours about how
//    far things moved. 2. Every item's expected live position = its design position + the median
//    offset of its nearest anchors. 3. Exact text matches (case/quote-insensitive) closest to the
//    expected position, then similar text. Candidates further than MAX_JUMP from where they're
//    expected are rejected, so a repeated label never pairs with one across the page.
const MAX_JUMP = 450;
export function matchItems(D, L) {
  const pairs = [], usedD = new Set(), usedL = new Set();
  const keyOf = it => normKey(it.text);
  const group = list => { const m = new Map(); for (const it of list) { const k = keyOf(it); if (!m.has(k)) m.set(k, []); m.get(k).push(it); } return m; };
  const gD = group(D), gL = group(L);

  let anchors = [];
  for (const [k, ds] of gD) {
    const ls = gL.get(k);
    // anchors are visible text only: accessible names (aria-label) are reused for different things
    if (ds.length === 1 && ls?.length === 1 && k.length >= 2 && ds[0].kind === 'text' && ls[0].kind === 'text') anchors.push({ d: ds[0], dx: ls[0].textBox.x - ds[0].textBox.x, dy: ls[0].textBox.y - ds[0].textBox.y });
  }
  const med = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };
  const nearest = (b, list, k) => list.map(a => ({ a, dd: dist(b, a.d.textBox) })).sort((x, y) => x.dd - y.dd).slice(0, k).map(x => x.a);
  // drop anchors that disagree with their neighbourhood (same word used for different things)
  anchors = anchors.filter(a => {
    const nb = nearest(a.d.textBox, anchors.filter(x => x !== a), 5);
    if (nb.length < 2) return Math.abs(a.dy) < 1000;
    return Math.abs(a.dy - med(nb.map(x => x.dy))) < 300 && Math.abs(a.dx - med(nb.map(x => x.dx))) < 300;
  });
  // where a design box should be on the live page
  const expected = b => {
    const nb = nearest(b, anchors, 5);
    return { ...b, x: b.x + med(nb.map(x => x.dx)), y: b.y + med(nb.map(x => x.dy)) };
  };
  const exp = new Map(D.map(d => [d.n, expected(d.textBox)]));

  const greedy = cands => {
    cands.sort((a, b) => a.cost - b.cost);
    for (const c of cands) {
      if (usedD.has(c.d.n) || usedL.has(c.l.n)) continue;
      usedD.add(c.d.n); usedL.add(c.l.n);
      pairs.push({ d: c.d, l: c.l, how: c.how });
    }
  };
  // an icon or image is only the same thing if it's about the same size
  const sameShape = (d, l) => {
    if (isText(d) && isText(l)) return true;
    const a = d.textBox, b = l.textBox;
    return Math.max(a.w / b.w, b.w / a.w) <= 1.8 && Math.max(a.h / b.h, b.h / a.h) <= 1.8;
  };
  const exact = [];
  for (const [k, ds] of gD) for (const d of ds) for (const l of gL.get(k) || []) {
    if ((d.kind === 'image') !== (l.kind === 'image')) continue;
    if (!sameShape(d, l)) continue;
    const jump = dist(exp.get(d.n), l.textBox);
    if (jump <= MAX_JUMP) exact.push({ d, l, cost: jump, how: 'text' });
  }
  greedy(exact);
  const restD = D.filter(d => !usedD.has(d.n) && d.kind !== 'image' && keyOf(d).length >= 3);
  const restL = L.filter(l => !usedL.has(l.n) && l.kind !== 'image' && keyOf(l).length >= 3);
  const fuzzy = [];
  for (const d of restD) {
    const kd = keyOf(d);
    for (const l of restL) {
      const kl = keyOf(l);
      if (Math.min(kd.length, kl.length) / Math.max(kd.length, kl.length) < 0.5) continue;
      const s = similarity(kd, kl), jump = dist(exp.get(d.n), l.textBox);
      if (s >= 0.72 && jump <= MAX_JUMP && sameShape(d, l)) fuzzy.push({ d, l, cost: (1 - s) * 1000 + jump / 10, how: 'similar text' });
    }
  }
  greedy(fuzzy);
  return { pairs, unmatchedD: D.filter(d => !usedD.has(d.n)), unmatchedL: L.filter(l => !usedL.has(l.n)), expected };
}

// ---------- layout boxes (whole page) ----------
const contains = (o, b) => { const c = center(b); return c.x >= o.x && c.x <= o.x + o.w && c.y >= o.y && c.y <= o.y + o.h && o.w * o.h >= b.w * b.h; };
// Pair painted boxes across the pages: boxes holding the same matched text are the same box; empty
// boxes (icons' pills, dividers, decorative panels) pair by size near where they're expected.
export function matchBoxes(Db, Lb, pairs, D, L, expected) {
  const d2l = new Map(pairs.map(p => [p.d.n, p.l.n]));
  const matchedL = new Set(pairs.map(p => p.l.n));
  const inside = (boxes, items, keep) => boxes.map(b => new Set(items.filter(it => keep(it.n) && contains(b.box, it.textBox)).map(it => it.n)));
  const inD = inside(Db, D, n => d2l.has(n)).map(set => new Set([...set].map(n => d2l.get(n))));
  const inL = inside(Lb, L, n => matchedL.has(n));
  const cands = [];
  for (let i = 0; i < Db.length; i++) {
    const a = Db[i].box, ex = expected(a);
    for (let j = 0; j < Lb.length; j++) {
      const b = Lb[j].box;
      const sr = Math.max(a.w / b.w, b.w / a.w) + Math.max(a.h / b.h, b.h / a.h) - 2; // 0 = same size
      if (inD[i].size || inL[j].size) {
        if (!inD[i].size || !inL[j].size) continue;
        let inter = 0;
        for (const n of inD[i]) if (inL[j].has(n)) inter++;
        const jac = inter / (inD[i].size + inL[j].size - inter);
        if (jac < 0.5) continue;
        cands.push({ i, j, cost: (1 - jac) * 10 + Math.min(sr, 5) + dist(ex, b) / 400 });
      } else {
        if (sr > 0.35) continue;
        const dd = dist(ex, b);
        if (dd > 60) continue;
        cands.push({ i, j, cost: 20 + sr * 10 + dd / 10 });
      }
    }
  }
  cands.sort((x, y) => x.cost - y.cost);
  const usedD = new Set(), usedL = new Set(), out = [];
  for (const c of cands) {
    if (usedD.has(c.i) || usedL.has(c.j)) continue;
    usedD.add(c.i); usedL.add(c.j);
    out.push({ d: Db[c.i], l: Lb[c.j], items: [...inD[c.i]] });
  }
  return out;
}

// What to call a box: its screen label, else the text it holds, else its shape.
function boxName(bp, D, pairs, biggest) {
  if (bp.d.label) return bp.d.label;
  // the biggest box of a labelled region is that region (the masthead's gradient panel is "Hero masthead")
  if (bp.d.section && biggest.get(bp.d.section) === bp) return bp.d.section;
  const l2d = new Map(pairs.map(p => [p.l.n, p.d]));
  // name it after its most prominent text: largest type, then longest
  const texts = bp.items.map(n => l2d.get(n)).filter(Boolean).sort((a, b) => b.style.fontSize - a.style.fontSize || b.text.length - a.text.length);
  if (texts.length) return `box around “${short(texts[0].text)}”`;
  return `${bp.d.tag} ${Math.round(bp.d.box.w)}×${Math.round(bp.d.box.h)}`;
}

// Edges that line up anywhere on the page in the design (the masthead's top with the first rail
// button, a card column with the search bar…) and no longer do on live. Per box and edge: flagged when
// it breaks most of its design alignments, so the box that moved is named, not everything around it.
const BOX_EDGES = ['left', 'right', 'top', 'bottom'];
function layoutAlignment(bpairs, D, pairs) {
  const res = [];
  const biggest = new Map();
  for (const bp of bpairs) { const k = bp.d.section, cur = biggest.get(k); if (k && (!cur || bp.d.box.w * bp.d.box.h > cur.d.box.w * cur.d.box.h)) biggest.set(k, bp); }
  const boxName_ = bp => boxName(bp, D, pairs, biggest);
  const N = bpairs.length;
  const nested = (a, b) => (a.x <= b.x && a.y <= b.y && a.x + a.w >= b.x + b.w && a.y + a.h >= b.y + b.h) || (b.x <= a.x && b.y <= a.y && b.x + b.w >= a.x + a.w && b.y + b.h >= a.y + a.h);
  const per = new Map(); // `${i}:${edge}` -> { kept, broken: [{ j, off }] }
  for (const edge of BOX_EDGES) {
    const f = EDGES[edge];
    for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) {
      const A = bpairs[i], B = bpairs[j];
      if (Math.abs(f(A.d.box) - f(B.d.box)) > 1) continue;
      // a box flush inside its parent shares an edge by construction (no padding): not a design choice
      if (nested(A.d.box, B.d.box)) continue;
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
  const done = new Set();
  for (const [k, v] of movers) {
    const [i, edge] = [Number(k.split(':')[0]), k.split(':')[1]];
    // a mutual pair (each the other's only broken partner) is one finding, named after the bigger box
    if (v.broken.length === 1) {
      const j = v.broken[0].j, other = movers.get(`${j}:${edge}`);
      if (other && other.broken.length === 1 && other.broken[0].j === i) {
        const a = bpairs[i].d.box, b = bpairs[j].d.box;
        if (a.w * a.h < b.w * b.h || done.has(`${j}:${i}:${edge}`)) continue;
        done.add(`${i}:${j}:${edge}`);
      }
    }
    const offs = v.broken.map(b => b.off).sort((a, b) => a - b);
    const med = offs[Math.floor(offs.length / 2)], dd = Math.abs(med);
    const A = bpairs[i], B = bpairs[v.broken[0].j];
    const isX = edge === 'left' || edge === 'right', f = EDGES[edge];
    const nameA = boxName_(A), nameB = boxName_(B);
    res.push({
      key: `${normKey(nameA)}:${edge}`, name: nameA, A, B, edge,
      row: {
        prop: `${edge} edge`,
        design: `lines up with ${nameB}${B.d.section && B.d.section !== A.d.section ? ` (${B.d.section})` : ''}${v.broken.length > 1 ? ` +${v.broken.length - 1}` : ''} at ${isX ? 'x' : 'y'}=${r1(f(A.d.box))}`,
        live: `off by ${r1(med)}px ${isX ? (med > 0 ? '→' : '←') : (med > 0 ? '↓' : '↑')} (${r1(f(A.l.box))} vs ${r1(f(B.l.box))})`,
        sev: dd >= 8 ? 'high' : dd >= 4 ? 'medium' : 'low',
      },
      guide: { axis: isX ? 'x' : 'y', design: [f(A.d.box)], live: [f(A.l.box), f(B.l.box)] },
      related: v.broken.slice(0, 6).map(b => ({ text: boxName_(bpairs[b.j]), design: bpairs[b.j].d.box, live: bpairs[b.j].l.box })),
    });
  }
  return res;
}

// The box that represents an item visually: its container when that container is "its own"
// (holds at most two items, e.g. a button with a label and a badge), else its text box.
function outerBoxes(items) {
  const count = new Map();
  for (const it of items) if (it.container) count.set(it.container.id, (count.get(it.container.id) || 0) + 1);
  const m = new Map();
  for (const it of items) m.set(it.n, it.container && count.get(it.container.id) <= 2 ? { box: it.container.box, cid: it.container.id } : { box: it.textBox, cid: null });
  return m;
}

// ---------- per-pair property diffs ----------
function isText(it) { return it.kind === 'text' || it.kind === 'field'; }
// "normal" line height is roughly 1.2em for the fonts in play
const lh = st => (st.lineHeight === 'normal' ? Math.round(st.fontSize * 1.2 * 10) / 10 : st.lineHeight);
function typography(d, l) {
  if (!isText(d) || !isText(l)) return [];
  const a = d.style, b = l.style, rows = [];
  if (Math.abs(a.fontSize - b.fontSize) >= 0.5) rows.push({ prop: 'font-size', design: `${a.fontSize}px`, live: `${b.fontSize}px`, sev: Math.abs(a.fontSize - b.fontSize) >= 2 ? 'high' : 'medium' });
  if (a.fontWeight !== b.fontWeight) rows.push({ prop: 'font-weight', design: a.fontWeight, live: b.fontWeight, sev: Math.abs(a.fontWeight - b.fontWeight) >= 200 ? 'high' : 'medium' });
  if (a.fontFamily.toLowerCase() !== b.fontFamily.toLowerCase()) rows.push({ prop: 'font-family', design: a.fontFamily, live: b.fontFamily, sev: 'high' });
  if (a.fontStyle !== b.fontStyle) rows.push({ prop: 'font-style', design: a.fontStyle, live: b.fontStyle, sev: 'medium' });
  const la = lh(a), lb = lh(b), ld = Math.abs(la - lb);
  if (ld >= (a.lineHeight === 'normal' || b.lineHeight === 'normal' ? 2 : 1)) {
    const f = st => (st.lineHeight === 'normal' ? `normal (~${Math.round(lh(st))}px)` : `${st.lineHeight}px`);
    rows.push({ prop: 'line-height', design: f(a), live: f(b), sev: ld >= 4 ? 'medium' : 'low' });
  }
  if (Math.abs(a.letterSpacing - b.letterSpacing) >= 0.2) rows.push({ prop: 'letter-spacing', design: `${a.letterSpacing}px`, live: `${b.letterSpacing}px`, sev: 'low' });
  if (a.textTransform !== b.textTransform) rows.push({ prop: 'text-transform', design: a.textTransform, live: b.textTransform, sev: 'medium' });
  if (a.textDecoration !== b.textDecoration) rows.push({ prop: 'text-decoration', design: a.textDecoration, live: b.textDecoration, sev: 'medium' });
  return rows;
}

function colors(d, l) {
  const rows = [];
  if (d.kind === 'text' && l.kind === 'text') {
    const cd = colorDistance(d.style.color, l.style.color);
    if (cd > 6) rows.push({ prop: 'text color', design: d.style.color, live: l.style.color, swatch: true, sev: colorSev(cd) });
  }
  const a = d.container, b = l.container;
  if (a && b) {
    const bd = colorDistance(a.background, b.background);
    if (bd > 6) rows.push({ prop: 'background', design: a.background || 'none', live: b.background || 'none', swatch: true, sev: colorSev(bd) });
    const ga = a.backgroundImage === 'image' ? null : a.backgroundImage, gb = b.backgroundImage === 'image' ? null : b.backgroundImage;
    if ((ga || gb) && ga !== gb) rows.push({ prop: 'gradient', design: ga || 'none', live: gb || 'none', gradient: true, sev: !ga || !gb ? 'high' : 'medium' });
  }
  return rows;
}

const pxv = s => parseFloat(s) || 0;
function shape(d, l) {
  const a = d.container, b = l.container, rows = [];
  if (!a && !b) return rows;
  if (!a || !b) {
    const has = a || b;
    const desc = [has.background && `bg ${has.background}`, has.backgroundImage && (has.backgroundImage === 'image' ? 'image' : 'gradient'), has.border && `border ${has.border}`, has.shadow && 'shadow'].filter(Boolean).join(', ');
    // a box the size of the text itself is an underline/badge, not worth a high flag
    rows.push({ prop: 'box', design: a ? `${has.tag} (${desc})` : 'none', live: b ? `${has.tag} (${desc})` : 'none', sev: 'high' });
    return rows;
  }
  if (a.radius !== b.radius && !(a.radius.endsWith('px') && b.radius.endsWith('px') && Math.abs(pxv(a.radius) - pxv(b.radius)) < 1)) {
    const both = a.radius.endsWith('px') && b.radius.endsWith('px') && !a.radius.includes(' ') && !b.radius.includes(' ');
    rows.push({ prop: 'radius', design: a.radius, live: b.radius, sev: both && Math.abs(pxv(a.radius) - pxv(b.radius)) < 3 ? 'low' : 'medium' });
  }
  if ((a.border || '') !== (b.border || '')) {
    const ca = (a.border || '').match(/#[0-9a-f]{6}(?: \/ \d+%)?/i)?.[0], cb = (b.border || '').match(/#[0-9a-f]{6}(?: \/ \d+%)?/i)?.[0];
    const sameish = a.border && b.border && pxv(a.border) === pxv(b.border) && colorDistance(ca, cb) <= 6;
    if (!sameish) rows.push({ prop: 'border', design: a.border || 'none', live: b.border || 'none', sev: !a.border || !b.border ? 'medium' : colorSev(colorDistance(ca, cb)) === 'high' ? 'medium' : 'low' });
  }
  if ((a.shadow || '') !== (b.shadow || '')) rows.push({ prop: 'shadow', design: a.shadow || 'none', live: b.shadow || 'none', sev: !a.shadow || !b.shadow ? 'medium' : 'low' });
  return rows;
}

function size(d, l) {
  const a = d.container, b = l.container, rows = [];
  if (!a || !b) return rows;
  for (const [k, prop] of [['w', 'width'], ['h', 'height']]) {
    const x = a.box[k], y = b.box[k], dd = Math.abs(x - y);
    if (dd > 2 && dd / Math.max(x, y) > 0.03) rows.push({ prop, design: `${r1(x)}px`, live: `${r1(y)}px`, sev: dd >= 8 || dd / Math.max(x, y) >= 0.15 ? 'high' : dd >= 4 ? 'medium' : 'low' });
  }
  return rows;
}

// Where the text sits inside its box (left/top inset), for boxes of about the same size.
function inset(d, l) {
  const a = d.container, b = l.container;
  if (!a || !b || !isText(d) || !isText(l)) return [];
  if (Math.abs(a.box.w - b.box.w) > 2 || Math.abs(a.box.h - b.box.h) > 2) return [];
  const rows = [];
  for (const [k, prop] of [['x', 'left'], ['y', 'top']]) {
    const x = d.textBox[k] - a.box[k], y = l.textBox[k] - b.box[k], dd = Math.abs(x - y);
    if (dd >= 3) rows.push({ prop: `text inset ${prop}`, design: `${r1(x)}px`, live: `${r1(y)}px`, sev: dd >= 8 ? 'high' : dd >= 5 ? 'medium' : 'low' });
  }
  return rows;
}

function icons(d, l) {
  const a = d.container?.icon, b = l.container?.icon;
  if (!d.container || !l.container) return [];
  if (!a && !b) return [];
  if (!a || !b) return [{ prop: 'icon', design: a ? `${a.count} × ${a.size}` : 'none', live: b ? `${b.count} × ${b.size}` : 'none', sev: 'medium' }];
  const rows = [];
  if (a.count !== b.count) rows.push({ prop: 'icon count', design: a.count, live: b.count, sev: 'medium' });
  if (a.size !== b.size) {
    const [aw, ah] = a.size.split('x').map(Number), [bw, bh] = b.size.split('x').map(Number);
    const dd = Math.max(Math.abs(aw - bw), Math.abs(ah - bh));
    if (dd >= 1) rows.push({ prop: 'icon size', design: a.size, live: b.size, sev: dd >= 4 ? 'medium' : 'low' });
  }
  return rows;
}

// Hover: what changes when the pointer is over it, on each side.
function hoverChanges(h) {
  if (!h?.before || !h?.after) return {};
  const out = {};
  for (const part of ['text', 'target', 'container']) {
    const b = h.before[part], a = h.after[part];
    if (!b || !a) continue;
    for (const k of Object.keys(b)) if (String(b[k]) !== String(a[k])) out[k] = { from: b[k], to: a[k] };
  }
  return out;
}
const COLORISH = new Set(['color', 'background', 'outline']);
function behavior(d, l, hd, hl) {
  const rows = [];
  if (d.interactive !== l.interactive) rows.push({ prop: 'clickable', design: d.interactive ? 'yes' : 'no', live: l.interactive ? 'yes' : 'no', sev: d.interactive ? 'high' : 'low' });
  else if (d.interactive && (d.cursor === 'pointer') !== (l.cursor === 'pointer')) rows.push({ prop: 'cursor', design: d.cursor, live: l.cursor, sev: 'low' });
  if (hd === undefined || hl === undefined) return rows;
  const cd = hoverChanges(hd), cl = hoverChanges(hl);
  for (const k of new Set([...Object.keys(cd), ...Object.keys(cl)])) {
    const x = cd[k], y = cl[k];
    const fmt = c => (c ? `${c.from ?? 'none'} → ${c.to ?? 'none'}` : 'no change');
    if (x && y) {
      // both change it: only flag when they end up visibly different
      const same = COLORISH.has(k) ? colorDistance(x.to, y.to) <= 10 : String(x.to) === String(y.to);
      if (same) continue;
      rows.push({ prop: `hover ${k}`, design: fmt(x), live: fmt(y), swatch: COLORISH.has(k), sev: 'low' });
    } else rows.push({ prop: `hover ${k}`, design: fmt(x), live: fmt(y), swatch: COLORISH.has(k), sev: 'medium' });
  }
  return rows;
}

// ---------- layout relations (across matched pairs) ----------
const EDGES = {
  left: b => b.x, right: b => b.x + b.w, 'center x': b => b.x + b.w / 2,
  top: b => b.y, bottom: b => b.y + b.h, 'center y': b => b.y + b.h / 2,
};
const XS = ['left', 'right', 'center x'], YS = ['top', 'bottom', 'center y'];

// An element is misaligned when, on some edge, it breaks most of the alignments it had in the
// design (so one stray item in a column is flagged, not the whole column).
function alignment(pairs, outD, outL) {
  const P = pairs.map(p => ({ p, bd: outD.get(p.d.n).box, bl: outL.get(p.l.n).box, cd: outD.get(p.d.n).cid, cl: outL.get(p.l.n).cid, centered: p.d.style.textAlign === 'center' || outD.get(p.d.n).cid !== null }));
  const res = new Map(); // index -> rows
  for (let i = 0; i < P.length; i++) {
    const A = P[i];
    for (const edge of Object.keys(EDGES)) {
      const isX = XS.includes(edge), f = EDGES[edge];
      let kept = 0;
      const broken = [];
      for (let j = 0; j < P.length; j++) {
        if (i === j) continue;
        const B = P[j];
        if (A.cd !== null && A.cd === B.cd) continue; // two labels inside one box: their box covers it
        if (A.p.d.block === B.p.d.block) continue; // inline runs of one paragraph
        if (A.p.d.section !== B.p.d.section) continue; // lining up across unrelated regions is coincidence
        if (edge === 'center x' && !(A.centered && B.centered)) continue; // left-aligned text centred under a button is a coincidence
        // only nearby relations: a column (x edges) within 600px vertically, a row (y edges) within 900px across
        if (isX ? Math.abs(A.bd.y - B.bd.y) > 600 : Math.abs(A.bd.x - B.bd.x) > 900 || Math.abs(center(A.bd).y - center(B.bd).y) > Math.max(A.bd.h, B.bd.h)) continue;
        if (Math.abs(f(A.bd) - f(B.bd)) > 1) continue;
        const off = f(A.bl) - f(B.bl);
        if (Math.abs(off) <= 2) kept++; else broken.push({ j, off });
      }
      if (broken.length && broken.length >= 2 * kept && broken.length + kept >= 1) {
        const offs = broken.map(b => b.off).sort((a, b) => a - b);
        const med = offs[Math.floor(offs.length / 2)];
        const ref = P[broken[0].j].p;
        const dd = Math.abs(med);
        if (!res.has(i)) res.set(i, []);
        res.get(i).push({
          prop: `${edge} edge`, design: `aligned with “${short(ref.d.text)}”${broken.length > 1 ? ` +${broken.length - 1}` : ''}`,
          live: `off by ${r1(med)}px ${isX ? (med > 0 ? '→' : '←') : (med > 0 ? '↓' : '↑')}`,
          sev: dd >= 8 ? 'high' : dd >= 4 ? 'medium' : 'low', ref: ref.d.n, dd,
          guide: { axis: isX ? 'x' : 'y', design: [f(A.bd)], live: [f(A.bl), f(P[broken[0].j].bl)] },
          related: broken.slice(0, 6).map(b => ({ text: P[b.j].p.d.text, design: P[b.j].bd, live: P[b.j].bl })),
        });
      }
    }
  }
  // keep the most telling edge per axis
  for (const [i, rows] of res) {
    const best = ax => rows.filter(r => ax.includes(r.prop.replace(' edge', ''))).sort((a, b) => b.dd - a.dd)[0];
    res.set(i, [best(XS), best(YS)].filter(Boolean));
  }
  return res;
}

// Gap to the nearest matched neighbour below and to the right, design vs live.
function spacing(pairs, outD, outL, dItems, lItems) {
  const res = new Map();
  const textD = new Map(dItems.map(i => [i.n, i.textBox])), textL = new Map(lItems.map(i => [i.n, i.textBox]));
  const boxes = (a, b, out, text) => {
    const A = out.get(a), B = out.get(b);
    return A.cid !== null && A.cid === B.cid ? [text.get(a), text.get(b)] : [A.box, B.box];
  };
  for (let i = 0; i < pairs.length; i++) {
    for (const dir of ['below', 'right']) {
      let best = null;
      for (let j = 0; j < pairs.length; j++) {
        if (i === j || pairs[i].d.block === pairs[j].d.block) continue;
        const [a, b] = boxes(pairs[i].d.n, pairs[j].d.n, outD, textD);
        if (a === b || (a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h)) continue;
        const overlap = dir === 'below' ? Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) : Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        if (overlap <= Math.min(dir === 'below' ? Math.min(a.w, b.w) : Math.min(a.h, b.h), 8) * 0.5) continue;
        const gap = dir === 'below' ? b.y - (a.y + a.h) : b.x - (a.x + a.w);
        if (gap < -0.5 || gap > 160) continue;
        if (!best || gap < best.gap) best = { j, gap };
      }
      if (!best) continue;
      const [a, b] = boxes(pairs[i].l.n, pairs[best.j].l.n, outL, textL);
      const gapL = dir === 'below' ? b.y - (a.y + a.h) : b.x - (a.x + a.w);
      const dd = Math.abs(gapL - best.gap);
      if (dd < 3 || dd / Math.max(Math.abs(best.gap), Math.abs(gapL), 1) < 0.15) continue;
      if (!res.has(i)) res.set(i, []);
      res.get(i).push({
        prop: `gap ${dir === 'below' ? 'below' : 'right'} → “${short(pairs[best.j].d.text)}”`, design: `${r1(best.gap)}px`, live: `${r1(gapL)}px`,
        sev: dd >= 12 ? 'high' : dd >= 6 ? 'medium' : 'low', ref: pairs[best.j].d.n,
      });
    }
  }
  return res;
}

const short = s => (s.length > 28 ? s.slice(0, 27) + '…' : s);

// ---------- top level ----------
export function compareSnapshots(design, live) {
  const D = design.items, L = live.items;
  const { pairs, unmatchedD, unmatchedL, expected } = matchItems(D, L);
  const bpairs = matchBoxes(design.boxes || [], live.boxes || [], pairs, D, L, expected);
  const outD = outerBoxes(D), outL = outerBoxes(L);
  const align = alignment(pairs, outD, outL);
  const gaps = spacing(pairs, outD, outL, D, L);

  // stable ids: category + text + nth occurrence of that text in the design (live, for "extra")
  const occ = list => { const seen = new Map(), m = new Map(); for (const it of [...list].sort((a, b) => a.textBox.y - b.textBox.y || a.textBox.x - b.textBox.x)) { const k = normKey(it.text).slice(0, 48); const c = seen.get(k) || 0; seen.set(k, c + 1); m.set(it.n, `${k}#${c}`); } return m; };
  const occD = occ(D), occL = occ(L);
  const side = (it, out) => ({ n: it.n, textBox: it.textBox, box: out.get(it.n).box, section: it.section, where: it.where || null });

  const findings = [];
  const push = (category, it, rows, extra = {}) => {
    if (!rows.length) return;
    const key = extra.live && !extra.design ? `live:${occL.get(it.n)}` : occD.get(it.n);
    findings.push({ id: `${category}:${key}`, category, severity: maxSev(rows.map(r => r.sev)), text: it.text, section: it.section, props: rows, ...extra });
  };
  pairs.forEach((p, i) => {
    const sides = { design: side(p.d, outD), live: side(p.l, outL), match: p.how };
    if (p.how !== 'text') sides.liveText = p.l.text;
    push('typography', p.d, typography(p.d, p.l), sides);
    push('color', p.d, colors(p.d, p.l), sides);
    push('size', p.d, size(p.d, p.l), sides);
    push('shape', p.d, shape(p.d, p.l), sides);
    push('spacing', p.d, [...inset(p.d, p.l), ...(gaps.get(i) || [])], sides);
    const al = align.get(i) || [];
    // the most telling misalignment draws its guide line and partners in the viewer
    const top = [...al].sort((a, b) => b.dd - a.dd)[0];
    push('alignment', p.d, al.map(({ guide, related, ...r }) => r), top ? { ...sides, guide: top.guide, related: top.related } : sides);
    push('icon', p.d, icons(p.d, p.l), sides);
    push('behavior', p.d, behavior(p.d, p.l, design.hover?.[p.d.n], live.hover?.[p.l.n]), sides);
  });
  // Whole regions that sit somewhere else: median offset of the matched items in each design section.
  const bySection = new Map();
  for (const p of pairs) { const k = p.d.section || '(page)'; if (!bySection.has(k)) bySection.set(k, []); bySection.get(k).push(p); }
  for (const [name, ps] of bySection) {
    if (ps.length < 2) continue;
    const med = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
    const dx = med(ps.map(p => outL.get(p.l.n).box.x - outD.get(p.d.n).box.x)), dy = med(ps.map(p => outL.get(p.l.n).box.y - outD.get(p.d.n).box.y));
    if (Math.abs(dx) < 4 && Math.abs(dy) < 4) continue;
    const union = (list, out) => { const bs = list.map(n => out.get(n).box); const x = Math.min(...bs.map(b => b.x)), y = Math.min(...bs.map(b => b.y)); const w = Math.max(...bs.map(b => b.x + b.w)) - x, h = Math.max(...bs.map(b => b.y + b.h)) - y; return { x, y, w, h }; };
    const bd = union(ps.map(p => p.d.n), outD), bl = union(ps.map(p => p.l.n), outL);
    const rows = [];
    const sev = v => (Math.abs(v) >= 16 ? 'high' : Math.abs(v) >= 8 ? 'medium' : 'low');
    if (Math.abs(dx) >= 4) rows.push({ prop: 'region x', design: `${r1(bd.x)}px`, live: `${r1(bl.x)}px (${dx > 0 ? '→' : '←'} ${r1(Math.abs(dx))}px)`, sev: sev(dx) });
    if (Math.abs(dy) >= 4) rows.push({ prop: 'region y', design: `${r1(bd.y)}px`, live: `${r1(bl.y)}px (${dy > 0 ? '↓' : '↑'} ${r1(Math.abs(dy))}px)`, sev: sev(dy) });
    findings.push({ id: `alignment:section:${normKey(name)}`, category: 'alignment', severity: maxSev(rows.map(r => r.sev)), text: `${name} (${ps.length} matched elements)`, section: name, props: rows, region: true,
      design: { n: null, textBox: bd, box: bd, section: name, where: null }, live: { n: null, textBox: bl, box: bl, section: name, where: null } });
  }
  // Whole-page alignment of painted boxes, across regions.
  for (const a of layoutAlignment(bpairs, D, pairs)) {
    const b = a.A;
    findings.push({ id: `alignment:layout:${a.key}`, category: 'alignment', severity: a.row.sev, text: a.name, section: b.d.section, props: [a.row], layout: true,
      design: { n: null, textBox: b.d.box, box: b.d.box, section: b.d.section, where: null }, live: { n: null, textBox: b.l.box, box: b.l.box, section: b.l.section, where: null },
      guide: a.guide, related: a.related });
  }
  const notable = it => it.interactive || it.style.fontSize >= 18 || it.style.fontWeight >= 600;
  for (const it of unmatchedD) {
    if (it.kind === 'image') continue;
    push('missing', it, [{ prop: it.kind === 'field' ? 'field' : it.interactive ? 'control' : 'text', design: it.text, live: 'not found', sev: notable(it) ? 'medium' : 'low' }], { design: side(it, outD), live: null });
  }
  for (const it of unmatchedL) {
    if (it.kind === 'image') continue;
    push('extra', it, [{ prop: it.kind === 'field' ? 'field' : it.interactive ? 'control' : 'text', design: 'not in design', live: it.text, sev: 'low' }], { design: null, live: side(it, outL) });
  }
  // de-duplicate ids (identical text at identical rank can't collide, but be safe)
  const seen = new Map();
  for (const f of findings) { const c = seen.get(f.id) || 0; seen.set(f.id, c + 1); if (c) f.id += `~${c}`; }
  findings.sort((a, b) => SEV[b.severity] - SEV[a.severity] || CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category) || (a.design?.textBox.y ?? a.live.textBox.y) - (b.design?.textBox.y ?? b.live.textBox.y));

  const byCategory = Object.fromEntries(CATEGORIES.map(c => [c, findings.filter(f => f.category === c).length]));
  const bySeverity = Object.fromEntries(Object.keys(SEV).map(s => [s, findings.filter(f => f.severity === s).length]));
  return {
    pairs: pairs.map(p => ({ design: p.d.n, live: p.l.n, how: p.how })),
    findings,
    boxPairs: bpairs.map(b => ({ design: b.d.b, live: b.l.b })),
    stats: { designItems: D.length, liveItems: L.length, matched: pairs.length, designBoxes: (design.boxes || []).length, liveBoxes: (live.boxes || []).length, matchedBoxes: bpairs.length, missing: byCategory.missing, extra: byCategory.extra, findings: findings.length, byCategory, bySeverity },
  };
}
