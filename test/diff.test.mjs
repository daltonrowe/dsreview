import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareSnapshots, matchItems, colorDistance, similarity } from '../tools/lib/diff.mjs';

let n = 0;
// a snapshot item: text at (x, y), with overrides for style / container
function item(text, x, y, o = {}) {
  const w = o.w ?? text.length * 8, h = o.h ?? 18;
  return {
    n: n++, kind: 'text', text, tag: 'span', interactive: false, cursor: 'auto', block: n, section: o.section ?? 'Main',
    textBox: { x, y, w, h },
    style: { color: '#111111', fontSize: 16, fontWeight: 400, fontFamily: 'Inter', fontStyle: 'normal', lineHeight: 24, letterSpacing: 0, textTransform: 'none', textDecoration: 'none', textAlign: 'start', ...o.style },
    container: o.container ?? null,
    ...o.extra,
  };
}
const box = (x, y, w, h, o = {}) => ({ id: o.id ?? n, tag: 'button', box: { x, y, w, h }, background: '#ffffff', backgroundImage: null, border: null, radius: '8px', shadow: null, padding: '0 0 0 0', icon: null, ...o });
const snap = items => ({ width: 1440, height: 900, items });

test('colorDistance and similarity basics', () => {
  assert.equal(colorDistance('#ffffff', '#ffffff'), 0);
  assert.ok(colorDistance('#000000', '#ffffff') > 200);
  assert.ok(colorDistance('#ff0000 / 50%', '#ff0000') > 100, 'alpha counts');
  assert.ok(similarity('search all images', 'search all images...') > 0.8);
  assert.equal(similarity('ab', 'cd'), 0);
});

test('matches by text, nearest to where it is expected, never across the page', () => {
  const D = [item('Title', 100, 100), item('Log In', 1300, 20), item('Body', 100, 200)];
  const L = [item('Title', 100, 110), item('Body', 100, 210), item('Log in', 30, 2900), item('Sign Up', 1300, 20)];
  const { pairs, unmatchedD } = matchItems(D, L);
  assert.deepEqual(pairs.map(p => p.d.text).sort(), ['Body', 'Title']);
  assert.deepEqual(unmatchedD.map(d => d.text), ['Log In'], 'the far-away "Log in" is not a match');
});

test('typography, color, size and shape differences become findings', () => {
  const D = [item('Buy now', 100, 100, { style: { fontSize: 16, fontWeight: 600 }, container: box(80, 90, 120, 40, { background: '#ff7900', radius: 'pill' }) }), item('Anchor', 100, 300)];
  const L = [item('Buy now', 100, 100, { style: { fontSize: 14, fontWeight: 700 }, container: box(80, 90, 110, 48, { background: '#0057ff', radius: '8px' }) }), item('Anchor', 100, 300)];
  const { findings } = compareSnapshots(snap(D), snap(L));
  const by = Object.fromEntries(findings.map(f => [f.category, f]));
  assert.deepEqual(by.typography.props.map(p => p.prop), ['font-size', 'font-weight']);
  assert.equal(by.typography.severity, 'high');
  assert.equal(by.color.props[0].prop, 'background');
  assert.deepEqual(by.size.props.map(p => p.prop), ['width', 'height']);
  assert.equal(by.shape.props[0].prop, 'radius');
  assert.ok(findings.every(f => f.text === 'Buy now'), 'the identical element has no findings');
});

test('alignment: the one item that leaves its column is flagged, not the column', () => {
  const col = ['One', 'Two', 'Three', 'Four'];
  const D = col.map((t, i) => item(t, 100, 100 + i * 40));
  const L = col.map((t, i) => item(t, t === 'Three' ? 112 : 100, 100 + i * 40));
  const { findings } = compareSnapshots(snap(D), snap(L));
  const al = findings.filter(f => f.category === 'alignment');
  assert.deepEqual(al.map(f => f.text), ['Three']);
  assert.match(al[0].props[0].live, /off by 12px/);
});

test('spacing: a changed gap to the next element is reported', () => {
  const D = [item('Heading', 100, 100, { h: 30 }), item('Paragraph', 100, 146)];
  const L = [item('Heading', 100, 100, { h: 30 }), item('Paragraph', 100, 162)];
  const sp = compareSnapshots(snap(D), snap(L)).findings.filter(f => f.category === 'spacing');
  assert.equal(sp.length, 1);
  assert.equal(sp[0].text, 'Heading');
  assert.deepEqual([sp[0].props[0].design, sp[0].props[0].live], ['16px', '32px']);
});

test('missing and extra items; hover behavior differences', () => {
  const link = { interactive: true, cursor: 'pointer' };
  const D = [item('Pricing', 100, 100, { extra: link }), item('Only in design', 100, 200)];
  const L = [item('Pricing', 100, 100, { extra: link }), item('Only live', 600, 600)];
  const hover = (from, to) => ({ before: { text: { color: from } }, after: { text: { color: to } } });
  D.hover = undefined;
  const { findings } = compareSnapshots({ ...snap(D), hover: { [D[0].n]: hover('#111111', '#ff7900') } }, { ...snap(L), hover: { [L[0].n]: hover('#111111', '#111111') } });
  assert.ok(findings.some(f => f.category === 'missing' && f.text === 'Only in design'));
  assert.ok(findings.some(f => f.category === 'extra' && f.text === 'Only live'));
  const b = findings.find(f => f.category === 'behavior');
  assert.equal(b.props[0].prop, 'hover color');
  assert.equal(b.props[0].live, 'no change');
});

test('finding ids are stable across runs', () => {
  const mk = () => { n = 0; return compareSnapshots(snap([item('A', 0, 0, { style: { fontSize: 12 } })]), snap([item('A', 0, 0, { style: { fontSize: 14 } })])).findings.map(f => f.id); };
  assert.deepEqual(mk(), mk());
  assert.deepEqual(mk(), ['typography:a#0']);
});

test('whole page: boxes in different regions that lined up in the design are flagged when they drift apart', () => {
  // the masthead's top lines up with the first rail button in the design; on live the masthead sits 15px lower
  const pb = (b, x, y, w, h, o = {}) => ({ b, tag: 'div', box: { x, y, w, h }, background: '#ff7900', backgroundImage: null, border: null, radius: '24px', shadow: null, label: null, section: 'Main', interactive: false, ...o });
  const D = [item('Beautiful Visuals', 300, 150, { section: 'Hero masthead' }), item('Home', 25, 96, { section: 'Left nav' }), item('Search', 25, 150, { section: 'Left nav' })];
  const L = [item('Beautiful Visuals', 300, 165, { section: 'Hero masthead' }), item('Home', 25, 96, { section: 'Left nav' }), item('Search', 25, 150, { section: 'Left nav' })];
  const design = { ...snap(D), boxes: [pb(0, 99, 84, 1300, 330, { section: 'Hero masthead' }), pb(1, 12, 84, 50, 48, { section: 'Left nav', label: 'Home' })] };
  const live = { ...snap(L), boxes: [pb(0, 99, 99, 1300, 330), pb(1, 12, 84, 50, 48, { label: 'Home' })] };
  const lay = compareSnapshots(design, live).findings.filter(f => f.layout);
  assert.equal(lay.length, 1, 'one finding for the pair, named after the bigger box');
  assert.equal(lay[0].text, 'Hero masthead');
  assert.equal(lay[0].props[0].prop, 'top edge');
  assert.match(lay[0].props[0].live, /off by 15px ↓/);
  assert.deepEqual(lay[0].guide, { axis: 'y', design: [84], live: [99, 84] });
});

test('icon-only controls with the same name but a different shape are not paired', () => {
  // the design's rail logo (50x71) and the live top-bar logo (164x40) are both "Vecteezy home"
  const ctl = (x, y, w, h) => item('Vecteezy home', x, y, { w, h, extra: { kind: 'control', interactive: true } });
  const { pairs, unmatchedD, unmatchedL } = matchItems([ctl(12, 20, 50, 71), item('Home', 25, 96)], [ctl(100, 20, 164, 40), item('Home', 25, 96)]);
  assert.deepEqual(pairs.map(p => p.d.text), ['Home']);
  assert.equal(unmatchedD[0].text, 'Vecteezy home');
  assert.equal(unmatchedL[0].text, 'Vecteezy home');
});
