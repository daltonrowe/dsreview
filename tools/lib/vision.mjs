// Seeing a screenshot the way a designer does: from pixels only, no DOM, no CSS.
//
//   segment(img) -> { width, height, background, blobs: [...] }
//
// img = { width, height, data } (RGBA, e.g. from pngjs). A blob is one visual element: a line of text,
// an icon, a filled panel (button, card, masthead), a divider, a picture. Found by:
//   1. edges: pixels that differ visibly from their right or lower neighbour (flat fills and gentle
//      gradients have none; text, icons, outlines and photos are made of them);
//   2. grouping: edges closer than ~6px join (letters into words into a line of text, an icon's strokes);
//   3. description: tight box, the colour behind it, its own colour (ink), how much ink, a small
//      grayscale "look" for recognising it on the other screenshot; panels also get fill, corner
//      radius and border.
import { PNG } from 'pngjs';

export function decodePng(buf) {
  const p = PNG.sync.read(buf);
  return { width: p.width, height: p.height, data: p.data };
}

const hex2 = n => Math.round(n).toString(16).padStart(2, '0');
const hexRgb = h => (h ? [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)] : null);
export const toHex = c => (c ? `#${hex2(c[0])}${hex2(c[1])}${hex2(c[2])}` : null);
// perceptual-ish RGB distance ("redmean"), 0 .. ~255
export function cdist(r1, g1, b1, r2, g2, b2) {
  const rm = (r1 + r2) / 2, dr = r1 - r2, dg = g1 - g2, db = b1 - b2;
  return Math.sqrt((2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db) / 3;
}
const cd = (a, b) => (a && b ? cdist(a[0], a[1], a[2], b[0], b[1], b[2]) : 255);
export { cd as colorDistance };

const EDGE = 22;   // neighbour difference that counts as an edge
const JOIN = 3;    // edges within 2*JOIN px belong to one element

function edgeMap({ width: W, height: H, data: d }, threshold = EDGE) {
  const e = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, p = i * 4;
    let m = 0;
    if (x + 1 < W) { const q = p + 4; m = cdist(d[p], d[p + 1], d[p + 2], d[q], d[q + 1], d[q + 2]); }
    if (y + 1 < H) { const q = p + W * 4; m = Math.max(m, cdist(d[p], d[p + 1], d[p + 2], d[q], d[q + 1], d[q + 2])); }
    if (m > threshold) e[i] = 1;
  }
  return e;
}

// binary dilation by a (2r+1)² square, via an integral image
function dilate(e, W, H, r) {
  const S = new Int32Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) { let row = 0; for (let x = 0; x < W; x++) { row += e[y * W + x]; S[(y + 1) * (W + 1) + x + 1] = S[y * (W + 1) + x + 1] + row; } }
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(H, y + r + 1);
    for (let x = 0; x < W; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(W, x + r + 1);
      if (S[y1 * (W + 1) + x1] - S[y0 * (W + 1) + x1] - S[y1 * (W + 1) + x0] + S[y0 * (W + 1) + x0] > 0) out[y * W + x] = 1;
    }
  }
  return out;
}

const px = (d, W, x, y) => { const p = (y * W + x) * 4; return [d[p], d[p + 1], d[p + 2]]; };
// median colour of a list of [r,g,b] (by luminance)
function median(list) {
  if (!list.length) return null;
  list.sort((a, b) => a[0] * 0.3 + a[1] * 0.59 + a[2] * 0.11 - (b[0] * 0.3 + b[1] * 0.59 + b[2] * 0.11));
  return list[list.length >> 1];
}

// Most common colour in a list (5-bit buckets), returned as the bucket's average.
function mode(list) {
  if (!list.length) return null;
  const buckets = new Map();
  for (const c of list) {
    const k = ((c[0] >> 3) << 10) | ((c[1] >> 3) << 5) | (c[2] >> 3);
    const e = buckets.get(k) || [0, 0, 0, 0];
    e[0] += c[0]; e[1] += c[1]; e[2] += c[2]; e[3]++;
    buckets.set(k, e);
  }
  let best = null;
  for (const e of buckets.values()) if (!best || e[3] > best[3]) best = e;
  return [best[0] / best[3], best[1] / best[3], best[2] / best[3]];
}

// Most common colour of the page (its background), on a coarse 5-bit grid.
function dominant({ width: W, height: H, data: d }) {
  const counts = new Map();
  for (let y = 0; y < H; y += 3) for (let x = 0; x < W; x += 3) {
    const p = (y * W + x) * 4, k = ((d[p] >> 3) << 10) | ((d[p + 1] >> 3) << 5) | (d[p + 2] >> 3);
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  let best = 0, bk = 0;
  for (const [k, n] of counts) if (n > best) { best = n; bk = k; }
  return [((bk >> 10) & 31) * 8 + 4, ((bk >> 5) & 31) * 8 + 4, (bk & 31) * 8 + 4];
}

// Is the inside of this box a picture? Photos and patterns use many colours (UI panels measured at
// 24 or fewer 4-bit colours; photos 40-800+). Sampled well inside the box so a pill's rounded ends
// don't count what's around it, with a fixed budget so the count doesn't depend on the box's size.
function pictureLike(img, edges, b) {
  const { width: W, data: d } = img;
  const ins = Math.max(4, Math.round(Math.min(b.w, b.h) / 4));
  const iw = b.w - 2 * ins, ih = b.h - 2 * ins;
  if (iw < 8 || ih < 8) return { palette: 0, edgeDensity: 0, spread: 0, rough: 0 };
  const st = Math.max(1, Math.round(Math.sqrt((iw * ih) / 10000)));
  const palette = new Set();
  const G = 6, cells = new Uint32Array(G * G);
  const steps = [];
  let e = 0, n = 0;
  for (let y = b.y + ins; y < b.y + b.h - ins; y += st) for (let x = b.x + ins; x < b.x + b.w - ins; x += st) {
    n++; e += edges[y * W + x];
    if (edges[y * W + x]) cells[Math.min(G - 1, Math.floor(((y - b.y - ins) / ih) * G)) * G + Math.min(G - 1, Math.floor(((x - b.x - ins) / iw) * G))]++;
    const q = (y * W + x) * 4;
    palette.add(((d[q] >> 4) << 8) | ((d[q + 1] >> 4) << 4) | (d[q + 2] >> 4));
    if (x + 3 < b.x + b.w) steps.push(cdist(d[q], d[q + 1], d[q + 2], d[q + 12], d[q + 13], d[q + 14]));
  }
  // rough: the typical colour change between pixels 3px apart (median, so text strokes don't count).
  // Measured: gradients and flat panels 0-0.6 (the masthead 0.58), photos and patterns 2.5-13.
  steps.sort((a, c) => a - c);
  const rough = steps.length ? steps[steps.length >> 1] : 0;
  // spread: the share of a 6×6 grid over the inside that has any detail. A photo or pattern has detail
  // all over; a panel with a title and a search bar (the masthead) has it in a band.
  return { palette: palette.size, edgeDensity: e / Math.max(n, 1), spread: cells.filter(c => c > 0).length / (G * G), rough };
}

const SIG_W = 32, SIG_H = 16;
// grayscale thumbnail of a box, zero-mean / unit-variance (null for flat boxes)
function signature({ width: W, data: d }, b) {
  const s = new Float32Array(SIG_W * SIG_H);
  for (let j = 0; j < SIG_H; j++) for (let i = 0; i < SIG_W; i++) {
    const x0 = b.x + Math.floor((i * b.w) / SIG_W), x1 = Math.max(x0 + 1, b.x + Math.floor(((i + 1) * b.w) / SIG_W));
    const y0 = b.y + Math.floor((j * b.h) / SIG_H), y1 = Math.max(y0 + 1, b.y + Math.floor(((j + 1) * b.h) / SIG_H));
    let sum = 0, n = 0;
    const sx = Math.max(1, Math.floor((x1 - x0) / 4)), sy = Math.max(1, Math.floor((y1 - y0) / 4));
    for (let y = y0; y < y1; y += sy) for (let x = x0; x < x1; x += sx) { const p = (y * W + x) * 4; sum += d[p] * 0.3 + d[p + 1] * 0.59 + d[p + 2] * 0.11; n++; }
    s[j * SIG_W + i] = sum / n;
  }
  let m = 0; for (const v of s) m += v; m /= s.length;
  let v2 = 0; for (let k = 0; k < s.length; k++) { s[k] -= m; v2 += s[k] * s[k]; }
  const sd = Math.sqrt(v2 / s.length);
  if (sd < 2) return null;
  for (let k = 0; k < s.length; k++) s[k] /= sd;
  return s;
}
// normalized cross-correlation of two signatures: 1 = same look
export function ncc(a, b) {
  if (!a || !b) return a === b ? 1 : 0;
  let s = 0; for (let k = 0; k < a.length; k++) s += a[k] * b[k];
  return s / a.length;
}

// Corner radius of a filled panel: how far along the diagonal from its corner the fill starts.
function cornerRadius(img, b, fill) {
  const { width: W, data: d } = img;
  const corners = [[b.x, b.y, 1, 1], [b.x + b.w - 1, b.y, -1, 1], [b.x, b.y + b.h - 1, 1, -1], [b.x + b.w - 1, b.y + b.h - 1, -1, -1]];
  const rs = [];
  const lim = Math.floor(Math.min(b.w, b.h) / 2);
  for (const [cx, cy, sx, sy] of corners) {
    let k = 0;
    for (; k < lim; k++) { const c = px(d, W, cx + sx * k, cy + sy * k); if (cd(c, fill) < 30) break; }
    rs.push(k / (1 - Math.SQRT1_2)); // diagonal inset → radius
  }
  rs.sort((a, b) => a - b);
  const r = (rs[1] + rs[2]) / 2; // middle two: robust to one odd corner
  return r >= Math.min(b.w, b.h) / 2 - 2 ? 'pill' : Math.round(r);
}

// A border: the pixels just inside the edge differ from the fill.
function borderOf(img, b, fill) {
  const { width: W, data: d } = img;
  const samples = [];
  for (const t of [0.3, 0.5, 0.7]) {
    samples.push([b.x, Math.round(b.y + b.h * t), 1, 0], [b.x + b.w - 1, Math.round(b.y + b.h * t), -1, 0], [Math.round(b.x + b.w * t), b.y, 0, 1], [Math.round(b.x + b.w * t), b.y + b.h - 1, 0, -1]);
  }
  const cols = [], widths = [];
  for (const [x, y, sx, sy] of samples) {
    const c = px(d, W, x, y);
    if (cd(c, fill) < 25) continue;
    let k = 1;
    while (k < 6 && cd(px(d, W, x + sx * k, y + sy * k), fill) >= 25) k++;
    cols.push(c); widths.push(k);
  }
  if (cols.length < samples.length / 2) return null;
  widths.sort((a, b) => a - b);
  return { color: median(cols), width: widths[widths.length >> 1] };
}

// Connected groups of edges (after joining edges within 2r px), with their tight box and how many of
// their edge pixels lie on their own outline (panels are outlines around a flat fill).
function components(edges, W, H, r) {
  const grown = dilate(edges, W, H, r);
  const label = new Int32Array(W * H);
  const comps = [];
  const stack = new Int32Array(W * H);
  for (let s = 0; s < W * H; s++) {
    if (!grown[s] || label[s]) continue;
    const id = comps.length + 1;
    let sp = 0; stack[sp++] = s; label[s] = id;
    let minx = W, miny = H, maxx = -1, maxy = -1, n = 0;
    while (sp) {
      const i = stack[--sp], x = i % W, y = (i - x) / W;
      if (edges[i]) { n++; if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y; }
      if (x > 0 && grown[i - 1] && !label[i - 1]) { label[i - 1] = id; stack[sp++] = i - 1; }
      if (x < W - 1 && grown[i + 1] && !label[i + 1]) { label[i + 1] = id; stack[sp++] = i + 1; }
      if (y > 0 && grown[i - W] && !label[i - W]) { label[i - W] = id; stack[sp++] = i - W; }
      if (y < H - 1 && grown[i + W] && !label[i + W]) { label[i + W] = id; stack[sp++] = i + W; }
    }
    // an edge is marked on the pixel before the change: outside the element on its top/left,
    // inside on its right/bottom. So the drawn pixels span minx+1 .. maxx (and miny+1 .. maxy).
    comps.push({ id, n, box: n ? { x: minx + 1, y: miny + 1, w: Math.max(1, maxx - minx), h: Math.max(1, maxy - miny) } : null, rim: 0 });
  }
  for (let i = 0; i < W * H; i++) {
    if (!edges[i] || !label[i]) continue;
    const c = comps[label[i] - 1], x = i % W, y = (i - x) / W, b = c.box;
    const dp = c.depth ??= Math.max(3, Math.round(Math.min(b.w, b.h) * 0.2));
    if (x - b.x < dp || b.x + b.w - 1 - x < dp || y - b.y < dp || b.y + b.h - 1 - y < dp) c.rim++;
  }
  return comps;
}

// How much of each side of a box has an outline: the share of positions along the side with an edge
// within a band (15% of the box's smaller side deep, so a pill's rounded ends count). Returns the
// weakest side. A panel or button is outlined all round; a cluster of letters isn't (its top is ragged).
function sideCover(edges, W, b) {
  const depth = Math.max(3, Math.round(Math.min(b.w, b.h) * 0.2));
  const has = (x0, x1, y0, y1) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (edges[y * W + x]) return true; return false; };
  const X0 = b.x - 1, X1 = b.x + b.w - 1, Y0 = b.y - 1, Y1 = b.y + b.h - 1;
  let top = 0, bottom = 0, left = 0, right = 0;
  for (let x = b.x; x < b.x + b.w; x++) { if (has(x, x, Y0, Y0 + depth)) top++; if (has(x, x, Y1 - depth, Y1)) bottom++; }
  for (let y = b.y; y < b.y + b.h; y++) { if (has(X0, X0 + depth, y, y)) left++; if (has(X1 - depth, X1, y, y)) right++; }
  return Math.min(top / b.w, bottom / b.w, left / b.h, right / b.h);
}

const SOFT_EDGE = 7; // faint outlines: a light-grey card or a pale photo on a white page

export function segment(img, { maxBlobs = 3000 } = {}) {
  const { width: W, height: H, data: d } = img;
  const edges = edgeMap(img, EDGE);
  const comps = components(edges, W, H, JOIN);
  const background = dominant(img);
  const blobs = [];
  // outline: true when the element came from the faint-outline pass (always a panel or a picture)
  // a picture is at most a banner: a page column full of photos (the search results) is a container
  const pictureSized = b => b.h <= 1600 && b.w * b.h <= 0.25 * W * H;
  const describe = (c, outline = false, passEdges = edges) => {
    const b = c.box;
    if (!b) return null;
    b.w = Math.min(b.w, W - b.x); b.h = Math.min(b.h, H - b.y);
    if (b.w * b.h < 20 || c.n < 6) return null;
    if (b.w >= W * 0.98 && b.h >= H * 0.9) return null; // the page frame itself
    const area = b.w * b.h, density = c.n / area;
    // colour behind it: a ring just outside the box
    const ring = [];
    const step = Math.max(1, Math.round((b.w + b.h) / 60));
    // walked in order around the box, so neighbouring samples are neighbours on the page
    const yt = b.y - 3, yb = b.y + b.h + 2, xl = b.x - 3, xr = b.x + b.w + 2;
    if (yt >= 0) for (let x = b.x; x < b.x + b.w; x += step) ring.push(px(d, W, x, yt));
    if (xr < W) for (let y = b.y; y < b.y + b.h; y += step) ring.push(px(d, W, xr, y));
    if (yb < H) for (let x = b.x + b.w - 1; x >= b.x; x -= step) ring.push(px(d, W, x, yb));
    if (xl >= 0) for (let y = b.y + b.h - 1; y >= b.y; y -= step) ring.push(px(d, W, xl, y));
    const behind = median(ring) || background;
    // sitting on a texture (inside a photo or pattern): what's behind changes from one ring sample to
    // the next. A gradient changes slowly, so it doesn't count.
    let rough = 0;
    for (let k = 1; k < ring.length; k++) rough += cd(ring[k], ring[k - 1]);
    rough /= Math.max(ring.length - 1, 1);
    // its own colour (ink): the pixels that stand out from what's behind
    const st = Math.max(1, Math.round(Math.sqrt(area / 20000)));
    const ink = [];
    let total = 0;
    for (let y = b.y; y < b.y + b.h; y += st) for (let x = b.x; x < b.x + b.w; x += st) { total++; const c2 = px(d, W, x, y); if (cd(c2, behind) > 40) ink.push(c2); }
    const inkRatio = ink.length / Math.max(total, 1);
    // its colour: the most common ink (a grey line with an orange link is grey, not a blend), and an
    // accent: a second, clearly different ink covering a fair share of it (that orange link)
    const fg = mode(ink);
    // (anti-aliased edges are blends of ink and background: they lie on the line between the two)
    const blend = c => {
      const ab = [behind[0] - fg[0], behind[1] - fg[1], behind[2] - fg[2]], ac = [c[0] - fg[0], c[1] - fg[1], c[2] - fg[2]];
      const L = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2 || 1, t = Math.max(0, Math.min(1, (ab[0] * ac[0] + ab[1] * ac[1] + ab[2] * ac[2]) / L));
      return cd(c, [fg[0] + ab[0] * t, fg[1] + ab[1] * t, fg[2] + ab[2] * t]) < 22;
    };
    const other = fg ? ink.filter(c => cd(c, fg) > 60 && !blend(c)) : [];
    const accent = other.length >= Math.max(12, ink.length * 0.12) ? mode(other) : null;
    const thin = Math.min(b.w, b.h) <= 3;
    // a panel's outline runs around most of its box (a cluster of letters only touches its box at a few points)
    const panel = !thin && b.w >= 20 && b.h >= 14 && (outline || (c.rim / c.n > 0.85 && density < 0.25)) && sideCover(passEdges, W, b) >= 0.5;
    let kind;
    if (thin) kind = 'line';
    else if (panel) kind = 'panel';
    else if (outline) return null; // the faint pass only adds panels and pictures
    // small and square is an icon (single letters land here too); a run of strokes wider than tall is text
    else if (b.w <= 48 && b.h <= 48 && b.w / b.h <= 1.3 && b.h / b.w <= 1.3) kind = 'icon';
    else if (b.h >= 6 && b.h <= 90 && b.w >= b.h * 0.9 && density > 0.08 && inkRatio < 0.75) kind = 'text';
    else if (b.w <= 64 && b.h <= 64 && b.w / b.h < 2.2 && b.h / b.w < 2.2) kind = 'icon';
    else if (b.w >= 80 && b.h >= 60) { const pic = pictureLike(img, edges, b); kind = pic.palette >= 40 && pic.rough >= 1.5 && pictureSized(b) ? 'image' : 'shape'; }
    else kind = 'shape';
    if (rough > 14 && kind !== 'image' && kind !== 'panel') return null;
    const blob = { id: blobs.length, kind, box: b, behind: toHex(behind), color: toHex(fg), accent: toHex(accent), ink: Math.round(inkRatio * 1000) / 1000, density: Math.round(density * 1000) / 1000 };
    if (kind === 'panel' && b.w >= 60 && b.h >= 40) {
      // an outline around a many-coloured, rough inside is a picture (a photo with rounded corners). A
      // gradient (the masthead) has many colours too, but changes smoothly from pixel to pixel.
      const pic = pictureLike(img, edges, b);
      if (pic.palette >= 40 && pic.rough >= 1.5 && pictureSized(b)) kind = blob.kind = 'image';
    }
    if (kind === 'panel') {
      // the fill: the inside of the outline, away from its content
      const inner = [];
      const s2 = Math.max(1, Math.round(Math.sqrt(area / 4000)));
      for (let y = b.y + 4; y < b.y + b.h - 4; y += s2) for (let x = b.x + 4; x < b.x + b.w - 4; x += s2) if (!edges[y * W + x]) inner.push(px(d, W, x, y));
      const fill = median(inner) || behind;
      blob.fill = toHex(fill);
      blob.radius = cornerRadius(img, b, fill);
      const br = borderOf(img, b, fill);
      if (br && cd(br.color, behind) > 12) blob.border = { color: toHex(br.color), width: br.width };
      // an outline with the background showing through and no border is a glyph or icon outline, not a panel
      if (!outline && !blob.border && cd(fill, behind) < 12 && b.h <= 90) { kind = blob.kind = b.w <= 40 && b.h <= 40 ? 'icon' : 'text'; delete blob.fill; delete blob.radius; }
    }
    blob.sig = signature(img, b);
    return blob;
  };
  for (const c of comps) {
    const blob = describe(c);
    if (blob) blobs.push(blob);
    if (blobs.length >= maxBlobs) break;
  }
  // second pass: faint outlines of big boxes the first pass couldn't see (a pale photo, a light-grey
  // card on white). Only outline-like groups, and only where nothing already has that box.
  const softEdges = edgeMap(img, SOFT_EDGE);
  const soft = components(softEdges, W, H, 1);
  const same = (a, b) => Math.abs(a.x - b.x) <= 3 && Math.abs(a.y - b.y) <= 3 && Math.abs(a.w - b.w) <= 4 && Math.abs(a.h - b.h) <= 4;
  for (const c of soft) {
    const b = c.box;
    // most of the box's perimeter is outline (pieces of the picture touching its border may hang off it)
    if (!b || b.w < 40 || b.h < 30 || c.rim < 1.5 * (b.w + b.h)) continue;
    if (blobs.some(x => same(x.box, b))) continue;
    const blob = describe(c, true, softEdges);
    if (blob) { blob.id = blobs.length; blobs.push(blob); }
  }
  // Large type: letters and words are further apart than the joining distance, so join pieces on one
  // line with similar height and the same ink when the gap is under ~0.6 × their height (a word space).
  const mergeable = b => b.kind === 'text' || b.kind === 'icon' || b.kind === 'shape';
  let merged = true;
  while (merged) {
    merged = false;
    const row = blobs.filter(mergeable).sort((a, c) => a.box.x - c.box.x);
    outer: for (let i = 0; i < row.length; i++) for (let j = i + 1; j < row.length; j++) {
      const a = row[i], c = row[j], A = a.box, C = c.box;
      const gap = C.x - (A.x + A.w);
      if (gap > 0.5 * Math.max(A.h, C.h)) break; // sorted by x: the rest are further away
      const over = Math.min(A.y + A.h, C.y + C.h) - Math.max(A.y, C.y);
      if (over < 0.6 * Math.min(A.h, C.h) || Math.max(A.h, C.h) / Math.min(A.h, C.h) > 1.6) continue;
      if (Math.max(A.h, C.h) < 16) continue; // body text already joins at the default distance
      if (a.kind !== 'text' && c.kind !== 'text') continue; // a row of icons (social buttons) stays a row of icons
      if (cd(hexRgb(a.color), hexRgb(c.color)) > 30) continue;
      const x = Math.min(A.x, C.x), y = Math.min(A.y, C.y);
      const box = { x, y, w: Math.max(A.x + A.w, C.x + C.w) - x, h: Math.max(A.y + A.h, C.y + C.h) - y };
      const wa = A.w * A.h, wc = C.w * C.h;
      Object.assign(a, { kind: 'text', box, ink: Math.round(((a.ink * wa + c.ink * wc) / (wa + wc)) * 1000) / 1000, sig: signature(img, box) });
      blobs.splice(blobs.indexOf(c), 1);
      merged = true;
      break outer;
    }
  }

  // what's inside a picture is the picture's content, not layout
  const pics = blobs.filter(b => b.kind === 'image');
  const inPic = b => pics.some(p => p !== b && b.box.x >= p.box.x && b.box.y >= p.box.y && b.box.x + b.box.w <= p.box.x + p.box.w && b.box.y + b.box.h <= p.box.y + p.box.h);
  const kept = blobs.filter(b => !inPic(b));
  kept.push(...grids(kept));
  kept.forEach((b, i) => { b.id = i; });
  return { width: W, height: H, background: toHex(background), blobs: kept };
}

// Regions: tiles packed together (gaps of 32px or less) over at least two rows and two columns are one
// grid (the resource grid on the home and search pages). A grid's extent is a design decision even
// when its tiles are sample content: where it ends, how many columns it has, the gap after it.
const TILE_GAP = 32;
export function grids(blobs) {
  const tiles = blobs.filter(b => (b.kind === 'panel' || b.kind === 'image' || b.kind === 'shape') && b.box.w >= 80 && b.box.h >= 60);
  // (with some slack: a badge may poke out of the faded bottom of its tile)
  const T = 24, inside = (o, b) => b.box.x >= o.box.x - T && b.box.y >= o.box.y - T && b.box.x + b.box.w <= o.box.x + o.box.w + T && b.box.y + b.box.h <= o.box.y + o.box.h + T && b.box.w * b.box.h < o.box.w * o.box.h;
  // a tile's own contents (a badge inside a picture) are not tiles; a section panel around a row of cards
  // is one tile, so a single row of cards in a panel isn't a grid
  // (a box holding many tiles is a section or the page column, not a tile: it doesn't hide them)
  const holds = o => tiles.filter(t => t !== o && inside(o, t)).length;
  const cand = tiles.filter(t => !tiles.some(o => o !== t && inside(o, t) && holds(o) <= 2) && holds(t) <= 2);
  const parent = cand.map((_, i) => i);
  const root = i => (parent[i] === i ? i : (parent[i] = root(parent[i])));
  const gap = (a, b, k, n) => Math.max(0, Math.max(a[k], b[k]) - Math.min(a[k] + a[n], b[k] + b[n]));
  for (let i = 0; i < cand.length; i++) for (let j = i + 1; j < cand.length; j++) {
    const a = cand[i].box, b = cand[j].box;
    if (gap(a, b, 'x', 'w') <= TILE_GAP && gap(a, b, 'y', 'h') <= TILE_GAP) parent[root(i)] = root(j);
  }
  const groups = new Map();
  cand.forEach((t, i) => { const r = root(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(t); });
  const out = [];
  for (const members of groups.values()) {
    if (members.length < 4) continue;
    // layout: masonry columns (left edges repeat down the page) or justified rows (tops repeat across it)
    const cluster = vals => { const out = []; for (const v of [...vals].sort((a, b) => a - b)) if (!out.length || v - out[out.length - 1].v > 8) out.push({ v, n: 1 }); else out[out.length - 1].n++; return out; };
    const lefts = cluster(members.map(m => m.box.x)), tops = cluster(members.map(m => m.box.y));
    if (lefts.length < 2 || tops.length < 2) continue;
    // rows first: in justified rows the tiles share their tops; masonry columns share their left edges
    // (and only the first row shares a top)
    const shared = list => list.filter(c => c.n >= 2).length / list.length;
    const layout = shared(tops) >= 0.6 ? 'rows' : shared(lefts) >= 0.7 ? 'columns' : 'rows';
    const x = Math.min(...members.map(m => m.box.x)), y = Math.min(...members.map(m => m.box.y));
    const box = { x, y, w: Math.max(...members.map(m => m.box.x + m.box.w)) - x, h: Math.max(...members.map(m => m.box.y + m.box.h)) - y };
    // where each column ends (masonry columns end unevenly)
    const ends = layout === 'columns' ? lefts.map(l => Math.max(...members.filter(m => Math.abs(m.box.x - l.v) <= 8).map(m => m.box.y + m.box.h))) : null;
    out.push({ id: -1, kind: 'grid', box, layout, tiles: members.length, columns: layout === 'columns' ? lefts.length : null, rows: layout === 'rows' ? tops.length : null, columnEnds: ends, sig: null, color: null, ink: 0, density: 0 });
  }
  return out;
}

// internals, for debugging the vision on a real screenshot
export { edgeMap as _edgeMap, components as _components };
