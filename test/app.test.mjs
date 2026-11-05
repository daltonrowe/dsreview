import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../tools/app.mjs';

// Decisions go to a throwaway DATA_DIR so the real surveys/*/decisions.json are never touched.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsr-test-'));
const auth = { authorization: 'Basic ' + Buffer.from('tester:secret').toString('base64') };
let server, base;

before(async () => {
  server = createApp({ user: 'tester', pass: 'secret', dataDir }).listen(0);
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

test('/up answers without credentials', async () => {
  const res = await fetch(`${base}/up`);
  assert.equal(res.status, 200);
});

test('everything else requires basic auth', async () => {
  assert.equal((await fetch(`${base}/`)).status, 401);
  const bad = { authorization: 'Basic ' + Buffer.from('tester:nope').toString('base64') };
  assert.equal((await fetch(`${base}/`, { headers: bad })).status, 401);
});

test('serves the viewer and the design project with credentials', async () => {
  const home = await fetch(`${base}/`, { headers: auth });
  assert.equal(home.status, 200);
  assert.match(await home.text(), /Design System Review/);
  const pages = await (await fetch(`${base}/api/pages`, { headers: auth })).json();
  assert.ok(pages.length > 0);
  const page = await fetch(`${base}/design-project/${encodeURIComponent(pages[0].file)}`, { headers: auth });
  assert.equal(page.status, 200);
});

test('decisions are written to DATA_DIR and read back', async () => {
  const surveys = await (await fetch(`${base}/api/surveys`, { headers: auth })).json();
  const s = surveys.find(x => x.generated);
  assert.ok(s, 'needs at least one generated survey in surveys/');
  const full = await (await fetch(`${base}/api/surveys/${s.id}`, { headers: auth })).json();
  const itemId = full.sections[0].items[0].id;
  const put = await fetch(`${base}/api/surveys/${s.id}/decisions`, {
    method: 'PUT', headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ ids: [itemId], decision: 'keep' }),
  });
  assert.equal(put.status, 200);
  const stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'decisions', `${s.id}.json`), 'utf8'));
  assert.equal(stored[itemId].decision, 'keep');
  const after = await (await fetch(`${base}/api/surveys/${s.id}`, { headers: auth })).json();
  assert.equal(after.decisions[itemId].decision, 'keep');
});

test('rejects unknown decisions', async () => {
  const res = await fetch(`${base}/api/surveys/radius/decisions`, {
    method: 'PUT', headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ ids: ['x'], decision: 'remove' }),
  });
  assert.equal(res.status, 400);
});
