// Screenshots of one finding, cut from a comparison's full-page screenshots, with the element(s)
// outlined and alignment guides drawn, as PNG. Used by the per-finding download (tools/app.mjs).
import fs from 'node:fs';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';

const PAD = 24;
export const COLORS = { design: [224, 23, 159], live: [10, 143, 214], partner: [120, 120, 120], guide: [18, 184, 74] };

// decoded screenshots, by path and mtime (a 1440×6000 JPEG decodes in a few hundred ms)
const cache = new Map();
export function loadShot(file) {
  const st = fs.statSync(file);
  const hit = cache.get(file);
  if (hit && hit.mtime === st.mtimeMs) return hit.img;
  const img = jpeg.decode(fs.readFileSync(file), { useTArray: true, maxMemoryUsageInMB: 1024, maxResolutionInMP: 200 });
  cache.set(file, { mtime: st.mtimeMs, img });
  if (cache.size > 6) cache.delete(cache.keys().next().value);
  return img;
}

// The part of the page a finding is about (same rule as the viewer's crops): the element with some
// room around it, or for an alignment with a partner, the stretch where the two meet along the guide.
export function region(box, partner, guide) {
  if (!partner || !guide) return { x: box.x - PAD, y: box.y - PAD, w: Math.max(box.w + PAD * 2, 120), h: Math.max(box.h + PAD * 2, 60) };
  const lo = Math.min(...guide.values) - 60, hi = Math.max(...guide.values) + 60;
  if (guide.axis === 'y') {
    const [L, R] = box.x <= partner.x ? [box, partner] : [partner, box];
    const x0 = L.x + Math.max(0, L.w - 160) - PAD, x1 = R.x + Math.min(R.w, 160) + PAD;
    return { x: x0, y: lo, w: x1 - x0, h: hi - lo };
  }
  const [T, B] = box.y <= partner.y ? [box, partner] : [partner, box];
  const y0 = T.y + Math.max(0, T.h - 120) - PAD, y1 = B.y + Math.min(B.h, 120) + PAD;
  return { x: lo, y: y0, w: hi - lo, h: y1 - y0 };
}

// Cut `reg` out of `img` (clamped to the page; at most maxW×maxH, centred on the region's start),
// draw outlines and guide lines, return a PNG buffer.
export function cut(img, reg, { boxes = [], lines = [], maxW = 1440, maxH = 1600 } = {}) {
  let x = Math.max(0, Math.round(reg.x)), y = Math.max(0, Math.round(reg.y));
  let w = Math.min(Math.round(reg.w), img.width - x, maxW), h = Math.min(Math.round(reg.h), img.height - y, maxH);
  w = Math.max(1, w); h = Math.max(1, h);
  const png = new PNG({ width: w, height: h });
  for (let j = 0; j < h; j++) {
    const src = ((y + j) * img.width + x) * 4;
    png.data.set(img.data.subarray(src, src + w * 4), j * w * 4);
  }
  const put = (px, py, c) => { if (px < 0 || py < 0 || px >= w || py >= h) return; const i = (py * w + px) * 4; png.data[i] = c[0]; png.data[i + 1] = c[1]; png.data[i + 2] = c[2]; png.data[i + 3] = 255; };
  for (const { box: b, color, dashed } of boxes) {
    const x0 = Math.round(b.x - x) - 2, y0 = Math.round(b.y - y) - 2, x1 = Math.round(b.x + b.w - x) + 1, y1 = Math.round(b.y + b.h - y) + 1;
    for (let t = 0; t < 2; t++) {
      for (let i = x0; i <= x1; i++) if (!dashed || ((i - x0) >> 2) % 2 === 0) { put(i, y0 + t, color); put(i, y1 - t, color); }
      for (let j = y0; j <= y1; j++) if (!dashed || ((j - y0) >> 2) % 2 === 0) { put(x0 + t, j, color); put(x1 - t, j, color); }
    }
  }
  for (const { axis, v, color } of lines) {
    if (axis === 'y') { const j = Math.round(v - y); for (let i = 0; i < w; i++) put(i, j, color); }
    else { const i = Math.round(v - x); for (let j = 0; j < h; j++) put(i, j, color); }
  }
  return PNG.sync.write(png);
}

// The screenshots for one finding: a close crop and a full-width context strip for each side.
// Returns [{ name, data }] (names without the finding prefix).
export function findingShots(report, f, dir) {
  const out = [];
  for (const side of ['design', 'live']) {
    const own = f[side], other = f[side === 'design' ? 'live' : 'design'];
    const box = own?.box || other?.box;
    if (!box) continue;
    const file = `${dir}/${report[side].shot}`;
    if (!fs.existsSync(file)) continue;
    const img = loadShot(file);
    const partner = f.related?.[0]?.[side];
    const values = f.guide?.[side];
    const guide = values && { axis: f.guide.axis, values };
    const boxes = [{ box, color: COLORS[side], dashed: !own }, ...(f.related || []).filter(r => r[side]).map(r => ({ box: r[side], color: COLORS.partner, dashed: true }))];
    const lines = (values || []).map(v => ({ axis: f.guide.axis, v, color: COLORS.guide }));
    out.push({ name: `${side}${own ? '' : '-same-spot'}.png`, data: cut(img, region(box, partner, guide), { boxes, lines }) });
    // context: the full page width, a screen's height around the element
    const cy = box.y + box.h / 2, ch = Math.max(700, Math.min(box.h + 200, 1600));
    out.push({ name: `${side}-context.png`, data: cut(img, { x: 0, y: cy - ch / 2, w: img.width, h: ch }, { boxes, lines, maxH: 1600 }) });
  }
  return out;
}
