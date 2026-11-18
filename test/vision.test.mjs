// The screenshot-only comparison, on synthetic screenshots: no browser, no DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { segment } from '../tools/lib/vision.mjs';
import { compareImages } from '../tools/lib/pixeldiff.mjs';

// ---------- a tiny painter ----------
function canvas(w = 400, h = 300, bg = [255, 255, 255]) {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([...bg, 255], i * 4);
  return { width: w, height: h, data };
}
const hex = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
function rect(img, x, y, w, h, color, radius = 0) {
  const c = hex(color);
  for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) {
    // rounded corners: skip pixels outside the corner circles
    const cx = i < x + radius ? x + radius : i >= x + w - radius ? x + w - radius - 1 : i;
    const cy = j < y + radius ? y + radius : j >= y + h - radius ? y + h - radius - 1 : j;
    if ((i - cx) ** 2 + (j - cy) ** 2 > radius * radius) continue;
    img.data.set([...c, 255], (j * img.width + i) * 4);
  }
}
// "text": a row of glyph-like vertical strokes
function text(img, x, y, w, h, color = '#1c1c1c') {
  for (let i = 0; i < w; i += 5) rect(img, x + i, y + ((i / 5) % 3 === 0 ? 0 : Math.round(h * 0.3)), 2, (i / 5) % 3 === 0 ? h : h - Math.round(h * 0.3), color);
}
// an icon: an X
function icon(img, x, y, s, color = '#333333') {
  for (let k = 0; k < s; k++) { rect(img, x + k, y + k, 2, 2, color); rect(img, x + s - k - 2, y + k, 2, 2, color); }
}

// a little page: a rail button, a masthead panel with a title, two lines of copy, an icon
function page({ mastheadY = 40, fill = '#ff6a00', titleH = 20, copyGap = 12, radius = 12, iconOn = true } = {}) {
  const img = canvas();
  rect(img, 10, 40, 40, 40, '#ffe8d6', 10);            // rail button (top at y=40)
  rect(img, 70, mastheadY, 300, 120, fill, radius);    // masthead
  text(img, 100, mastheadY + 30, 200, titleH, '#ffffff');
  text(img, 80, 200, 220, 12);
  text(img, 80, 200 + 12 + copyGap, 160, 12);
  if (iconOn) icon(img, 340, 250, 20);
  return img;
}
const find = (r, cat, pred = () => true) => r.findings.filter(f => f.category === cat && pred(f));

test('segment: finds panels (with fill and corner radius), text and icons from pixels alone', () => {
  const s = segment(page());
  const panels = s.blobs.filter(b => b.kind === 'panel');
  const masthead = panels.find(b => b.box.w > 250);
  assert.ok(masthead, 'masthead panel');
  assert.equal(masthead.fill, '#ff6a00');
  assert.ok(Math.abs(masthead.radius - 12) <= 3, `radius ~12, got ${masthead.radius}`);
  assert.equal(s.blobs.filter(b => b.kind === 'text').length, 3);
  assert.ok(s.blobs.some(b => b.kind === 'icon'));
  assert.equal(s.background, '#fcfcfc', 'page background (5-bit bucket of white)');
});

test('identical screenshots have no findings', () => {
  const r = compareImages(segment(page()), segment(page()));
  assert.equal(r.findings.length, 0);
  assert.ok(r.stats.matched >= 6);
});

test('whole page: the masthead no longer lines up with the first rail button', () => {
  const r = compareImages(segment(page()), segment(page({ mastheadY: 55 })));
  const al = find(r, 'alignment', f => f.props[0].prop === 'top edge');
  assert.ok(al.length >= 1, JSON.stringify(r.findings.map(f => [f.category, f.text, f.props])));
  const f = al.find(x => x.text.startsWith('Panel 30')) || al[0];
  assert.match(f.props[0].live, /off by 15px ↓/);
  assert.equal(f.guide.axis, 'y');
  assert.equal(f.related.length, 1);
});

test('fill colour, corner radius, text size, spacing and a missing icon', () => {
  const r = compareImages(segment(page()), segment(page({ fill: '#0057ff', radius: 0, titleH: 26, copyGap: 28, iconOn: false })));
  assert.ok(find(r, 'color', f => f.props.some(p => p.prop === 'fill' && p.live === '#0057ff')).length, 'fill');
  assert.ok(find(r, 'shape', f => f.props.some(p => p.prop === 'corner radius')).length, 'radius');
  assert.ok(find(r, 'typography', f => f.props.some(p => p.prop === 'text height' && /bigger/.test(p.live))).length, 'text height');
  assert.ok(find(r, 'spacing', f => f.props.some(p => p.prop.startsWith('gap below'))).length, 'gap');
  assert.ok(find(r, 'missing', f => f.text.startsWith('Icon')).length, 'missing icon');
});

test('finding ids are stable across runs', () => {
  const run = () => compareImages(segment(page()), segment(page({ fill: '#0057ff' }))).findings.map(f => f.id);
  assert.deepEqual(run(), run());
});
