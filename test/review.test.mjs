// The explanation pass, against a local stand-in for the Messages API: checks what is sent to the
// model (model, fallbacks, four images, the group and same-element context) and what is stored.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import jpeg from 'jpeg-js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvl-review-'));
const requests = [];
let server;

const box = (x, y, w, h) => ({ x, y, w, h });
const finding = (id, category, props, extra = {}) => ({ id, category, severity: 'medium', text: 'Icon 17×17', section: 'at 400, 40', props, design: { box: box(400, 40, 17, 17) }, live: { box: box(380, 50, 20, 20) }, ...extra });

before(async () => {
  // a tiny comparison on disk: screenshots, report, groups
  const shot = () => jpeg.encode({ width: 600, height: 300, data: Buffer.alloc(600 * 300 * 4, 200) }, 90).data;
  fs.writeFileSync(path.join(dir, 'design.jpg'), shot());
  fs.writeFileSync(path.join(dir, 'live.jpg'), shot());
  fs.writeFileSync(path.join(dir, 'groups.json'), JSON.stringify({ groups: [{ id: 'search-field', title: 'Search field: icons brighter and larger on live', summary: 'The search glass grows 17→20px.', severity: 'medium', findings: ['color:icon@1', 'size:icon@1'] }] }));
  // the stand-in API: records each request, answers with a fixed explanation
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      requests.push({ url: req.url, headers: req.headers, body: JSON.parse(body) });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 },
        content: [{ type: 'text', text: '{"explanation": "The search field\'s magnifier is brighter and 3px bigger on live.", "verdict": "real", "confidence": "high"}' }] }));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.ANTHROPIC_API_KEY = 'test-key';
});
after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); delete process.env.ANTHROPIC_BASE_URL; delete process.env.ANTHROPIC_API_KEY; });

const report = {
  id: 'search--dark', label: 'Search results', theme: 'dark',
  design: { page: 'AI Magic.dc.html', props: { theme: 'dark' }, state: {}, shot: 'design.jpg', width: 600, height: 300 },
  live: { url: 'https://example.test/free-photos/dog?skip=1', shot: 'live.jpg', width: 600, height: 300 },
  findings: [
    finding('color:icon@1', 'color', [{ prop: 'icon color', design: '#7e7e7e', live: '#f2f2f2' }]),
    finding('size:icon@1', 'size', [{ prop: 'width', design: '17px', live: '20px' }]),
  ],
};

test('explains each finding with Sonnet, the right context and four images; stores and reuses the result', async () => {
  const { reviewReport, readReviews, REVIEW_MODEL } = await import('../tools/lib/review.mjs');
  assert.equal(REVIEW_MODEL, 'claude-sonnet-5-5');
  const r1 = await reviewReport(report, dir, { concurrency: 1 });
  assert.deepEqual(r1, { done: 2, skipped: 0, failed: 0 });
  assert.equal(requests.length, 2);
  const { body, headers, url } = requests[0];
  assert.match(url, /\/v1\/messages/);
  assert.equal(body.model, 'claude-sonnet-5-5');
  assert.equal(body.fallbacks, 'default');
  assert.match(headers['anthropic-beta'], /server-side-fallback-2026-07-01/);
  const images = body.messages[0].content.filter(c => c.type === 'image');
  assert.equal(images.length, 4, 'design + live, close-up + context');
  const text = body.messages[0].content.filter(c => c.type === 'text').map(c => c.text).join('\n');
  assert.match(text, /DESIGN close-up/);
  assert.match(text, /Group: "Search field: icons brighter and larger on live"/);
  assert.match(text, /Other differences on the same element:\n- size: width: 17px → 20px/);
  assert.match(text, /Search results \(dark theme\)/);
  const stored = readReviews(dir);
  assert.equal(stored['color:icon@1'].verdict, 'real');
  assert.match(stored['color:icon@1'].explanation, /magnifier/);
  assert.equal(stored['color:icon@1'].model, 'claude-sonnet-5-5');
  // unchanged findings aren't explained again
  const r2 = await reviewReport(report, dir);
  assert.deepEqual(r2, { done: 0, skipped: 2, failed: 0 });
  assert.equal(requests.length, 2);
});
