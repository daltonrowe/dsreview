import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../tools/app.mjs';

// A throwaway comparisons dir (one tiny report) and DATA_DIR, so real data is never touched.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dvl-test-'));
const dataDir = path.join(tmp, 'data'), compDir = path.join(tmp, 'comparisons');
const finding = (id, category, severity) => ({ id, category, severity, text: id, section: 'Hero', props: [{ prop: 'font-size', design: '16px', live: '14px', sev: severity }], design: { n: 0, box: { x: 0, y: 0, w: 10, h: 10 }, textBox: { x: 0, y: 0, w: 10, h: 10 } }, live: { n: 0, box: { x: 0, y: 0, w: 10, h: 10 }, textBox: { x: 0, y: 0, w: 10, h: 10 } } });
fs.mkdirSync(path.join(compDir, 'home'), { recursive: true });
fs.writeFileSync(path.join(compDir, 'pairs.json'), JSON.stringify({ base: 'https://example.test', pairs: [{ id: 'home', label: 'Home', design: { page: 'AI Magic.dc.html' }, live: { path: '/' } }, { id: 'later', label: 'Later', design: { page: 'Pricing.dc.html' }, live: { path: '/p' } }] }));
fs.writeFileSync(path.join(compDir, 'home', 'report.json'), JSON.stringify({
  id: 'home', label: 'Home', generatedAt: '2026-11-18T00:00:00Z', design: { page: 'AI Magic.dc.html', props: {}, state: {}, width: 1440, height: 900 }, live: { path: '/', url: 'https://example.test/?skip=1', width: 1440, height: 900 },
  stats: { findings: 2, matched: 1, byCategory: { typography: 1, color: 1 }, bySeverity: { high: 1, medium: 1, low: 0 } },
  findings: [finding('typography:a#0', 'typography', 'high'), finding('color:b#0', 'color', 'medium')],
}));

const auth = { authorization: 'Basic ' + Buffer.from('tester:secret').toString('base64') };
let server, base;

before(async () => {
  server = createApp({ user: 'tester', pass: 'secret', dataDir, comparisonsDir: compDir }).listen(0);
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.closeAllConnections(); server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const put = (body, headers = {}) => fetch(`${base}/api/comparisons/home/decisions`, { method: 'PUT', headers: { ...auth, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('/up answers without credentials', async () => {
  assert.equal((await fetch(`${base}/up`)).status, 200);
});

test('everything else requires basic auth', async () => {
  assert.equal((await fetch(`${base}/`)).status, 401);
  const bad = { authorization: 'Basic ' + Buffer.from('tester:nope').toString('base64') };
  assert.equal((await fetch(`${base}/`, { headers: bad })).status, 401);
});

test('serves the viewer and the design project with credentials', async () => {
  const home = await fetch(`${base}/`, { headers: auth });
  assert.equal(home.status, 200);
  assert.match(await home.text(), /Design vs Live/);
  const pages = await (await fetch(`${base}/api/pages`, { headers: auth })).json();
  assert.ok(pages.length > 0);
  assert.equal((await fetch(`${base}/design-project/${encodeURIComponent(pages[0].file)}`, { headers: auth })).status, 200);
});

test('lists configured comparisons, with or without a report', async () => {
  const { base: live, comparisons } = await (await fetch(`${base}/api/comparisons`, { headers: auth })).json();
  assert.equal(live, 'https://example.test');
  assert.deepEqual(comparisons.map(c => [c.id, c.generated]), [['home', true], ['later', false]]);
  assert.equal(comparisons[0].progress.total, 2);
  assert.equal((await fetch(`${base}/api/comparisons/later`, { headers: auth })).status, 404);
});

test('decisions and notes are written to DATA_DIR and read back', async () => {
  assert.equal((await put({ ids: ['typography:a#0'], decision: 'fix-live', note: 'heading too small' })).status, 200);
  assert.ok(fs.existsSync(path.join(dataDir, 'compare', 'home.json')));
  assert.ok(!fs.existsSync(path.join(compDir, 'home', 'decisions.json')), 'local decisions file untouched when DATA_DIR is set');
  const full = await (await fetch(`${base}/api/comparisons/home`, { headers: auth })).json();
  assert.equal(full.decisions['typography:a#0'].decision, 'fix-live');
  assert.equal(full.decisions['typography:a#0'].note, 'heading too small');
  assert.equal(full.progress['fix-live'], 1);
  assert.equal(full.progress.undecided, 1);
  // clearing the decision keeps the note; clearing both drops the entry
  await put({ ids: ['typography:a#0'], decision: null });
  let d = (await (await fetch(`${base}/api/comparisons/home`, { headers: auth })).json()).decisions;
  assert.equal(d['typography:a#0'].decision, undefined);
  await put({ ids: ['typography:a#0'], note: '' });
  d = (await (await fetch(`${base}/api/comparisons/home`, { headers: auth })).json()).decisions;
  assert.equal(d['typography:a#0'], undefined);
});

test('rejects unknown decisions and bad ids', async () => {
  assert.equal((await put({ ids: ['x'], decision: 'keep' })).status, 400);
  assert.equal((await put({ ids: [], decision: 'ok' })).status, 400);
  const bad = await fetch(`${base}/api/comparisons/..%2Fx/decisions`, { method: 'PUT', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ ids: ['a'], decision: 'ok' }) });
  assert.equal(bad.status, 400);
});

test('exports Markdown with decisions', async () => {
  await put({ ids: ['color:b#0'], decision: 'unclear' });
  const md = await (await fetch(`${base}/api/comparisons/home/export.md`, { headers: auth })).text();
  assert.match(md, /# Home/);
  assert.match(md, /\| Unclear 🤷 \| medium \| color \|/);
  const all = await (await fetch(`${base}/api/export.json`, { headers: auth })).json();
  assert.equal(all.comparisons.length, 1);
});

// Reads server-sent events from /api/live until `until(events)` is satisfied.
async function liveEvents(query, until, during = async () => {}) {
  const ctrl = new AbortController();
  const res = await fetch(`${base}/api/live?${query}`, { headers: auth, signal: ctrl.signal });
  const reader = res.body.getReader(), dec = new TextDecoder(), events = [];
  let buf = '';
  const reading = (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev = block.match(/^event: (.*)$/m)?.[1], data = block.match(/^data: (.*)$/m)?.[1];
        if (ev && data) events.push({ event: ev, data: JSON.parse(data) });
        if (until(events)) return;
      }
    }
  })();
  await during();
  await Promise.race([reading, new Promise((_, rej) => setTimeout(() => rej(new Error('timed out waiting for events')), 3000))]);
  ctrl.abort();
  return events;
}

test('live: presence counts distinct browsers and decisions are broadcast', async () => {
  const other = new AbortController();
  for (let i = 0; i < 2; i++) fetch(`${base}/api/live?client=b&name=Teal%20Fox`, { headers: auth, signal: other.signal }).catch(() => {});
  await new Promise(r => setTimeout(r, 100));
  const events = await liveEvents('client=a&name=Amber%20Otter', ev => ev.some(e => e.event === 'decision'), async () => {
    await new Promise(r => setTimeout(r, 100));
    await put({ ids: ['typography:a#0'], decision: 'fix-design' }, { 'x-client-id': 'b', 'x-client-tab': 't1', 'x-client-name': 'Teal Fox' });
  });
  other.abort();
  assert.equal(events.find(e => e.event === 'presence').data.online, 2, 'two tabs of browser b + browser a = 2 people');
  const d = events.find(e => e.event === 'decision').data;
  assert.equal(d.comparison, 'home');
  assert.equal(d.title, 'Home');
  assert.equal(d.decisions['typography:a#0'].decision, 'fix-design');
  assert.equal(d.by.name, 'Teal Fox');
  assert.equal(d.by.tab, 't1');
});
