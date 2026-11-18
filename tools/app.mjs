// The review web app: viewer, design project, comparison reports and the decisions API.
// Started by tools/server.mjs; exported separately so tests can run it on a random port.
import express from 'express';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT, PROJECT, allPages, readPropsMeta } from './lib/render.mjs';
import { findingShots, groupShots } from './lib/crops.mjs';
import { zip } from './lib/zip.mjs';

// same fingerprint as tools/lib/review.mjs (kept here so the server doesn't load the SDK)
const fingerprint = f => crypto.createHash('sha1').update(JSON.stringify([f.category, f.props.map(p => [p.prop, p.design, p.live]), f.design?.box, f.live?.box])).digest('hex').slice(0, 12);
import { readConfig, expandPairs } from './lib/pairs.mjs';

const COMPARISONS = path.join(ROOT, 'comparisons');
// A finding is either a real difference worth keeping on the list, or noise to ignore.
export const DECISIONS = ['keep', 'ignore'];
export const DECISION_LABELS = { keep: 'Keep', ignore: 'Ignore' };

// options:
//   user, pass  HTTP basic auth credentials (everything but /up requires them)
//   dataDir     where decisions are stored. Unset (local): comparisons/<id>/decisions.json, next to the report.
//               Set (production, a persistent volume): <dataDir>/compare/<id>.json, so deploys keep them.
export function createApp({ user = 'eezy', pass = 'eezy', dataDir = null, comparisonsDir = COMPARISONS } = {}) {
  const app = express();
  const decisionsPath = id => (dataDir ? path.join(dataDir, 'compare', `${id}.json`) : path.join(comparisonsDir, id, 'decisions.json'));

  // Health check for kamal-proxy; must answer without credentials.
  app.get('/up', (req, res) => res.status(200).send('ok'));

  // HTTP basic auth on everything else
  const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
  app.use((req, res, next) => {
    const [scheme, encoded] = (req.headers.authorization || '').split(' ');
    if (scheme === 'Basic' && encoded) {
      const raw = Buffer.from(encoded, 'base64').toString();
      const i = raw.indexOf(':');
      if (i >= 0 && safeEq(raw.slice(0, i), user) & safeEq(raw.slice(i + 1), pass)) return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="Design Review", charset="UTF-8"').status(401).send('Authentication required');
  });

  app.use(express.json());

  // ---------- live collaboration (server-sent events) ----------
  // Each browser opens GET /api/live?client=<id>&name=<name>. The server tracks connections,
  // broadcasts who is online (distinct clients, so several tabs count once) and pushes every
  // saved decision so other viewers can update and show a toast.
  const live = new Map(); // connection -> { client, name }
  const cleanName = n => String(n || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 40);
  const send = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const broadcast = (event, data) => { for (const res of live.keys()) send(res, event, data); };
  const presence = () => {
    const people = new Map();
    for (const c of live.values()) people.set(c.client, c.name);
    return { online: people.size, people: [...people].map(([client, name]) => ({ client, name })) };
  };
  app.get('/api/live', (req, res) => {
    const client = String(req.query.client || '').slice(0, 64) || crypto.randomUUID();
    const name = cleanName(req.query.name) || 'Someone';
    res.set({ 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.flushHeaders();
    res.write('retry: 3000\n\n');
    live.set(res, { client, name });
    broadcast('presence', presence());
    req.on('close', () => { live.delete(res); broadcast('presence', presence()); });
  });
  // Rename this browser (x-client-id) on every open connection, then re-announce presence.
  app.put('/api/live/name', (req, res) => {
    const client = req.get('x-client-id'), name = cleanName(req.body?.name);
    if (!client || !name) return res.status(400).json({ error: 'x-client-id header and a name are required' });
    for (const c of live.values()) if (c.client === client) c.name = name;
    broadcast('presence', presence());
    res.json({ name });
  });
  // keep idle connections (and any proxy in front) from timing them out
  const heartbeat = setInterval(() => { for (const res of live.keys()) res.write(': ping\n\n'); }, 20000);
  heartbeat.unref();
  // lets the launcher end open streams on shutdown
  app.closeLive = () => { clearInterval(heartbeat); for (const res of live.keys()) res.end(); live.clear(); };
  // names travel URL-encoded in headers (headers are ASCII-only)
  const decodeHeader = v => { try { return v ? decodeURIComponent(v) : v; } catch { return v; } };
  const noCache = { etag: false, lastModified: false, setHeaders: res => res.set('cache-control', 'no-store') };

  app.use('/', express.static(path.join(ROOT, 'tools/viewer'), noCache));
  app.get('/lib/bridge.js', (req, res) => res.set('cache-control', 'no-store').sendFile(path.join(ROOT, 'tools/lib/bridge.js')));
  app.use('/design-project', express.static(PROJECT, noCache));
  app.use('/comparisons', express.static(comparisonsDir, noCache));
  app.use('/design-system', express.static(path.join(ROOT, 'design-system'), noCache));
  app.use('/screenshots', express.static(path.join(ROOT, 'screenshots'), noCache));

  // ---------- helpers ----------
  const compDir = id => {
    if (!/^[\w-]+$/.test(id)) throw Object.assign(new Error('bad comparison id'), { status: 400 });
    return path.join(comparisonsDir, id);
  };
  const readJson = async (p, fallback) => { try { return JSON.parse(await fsp.readFile(p, 'utf8')); } catch { return fallback; } };
  const readReport = async id => {
    const r = await readJson(path.join(compDir(id), 'report.json'), null);
    if (!r) return r;
    const reviews = await readJson(path.join(compDir(id), 'reviews.json'), {});
    for (const f of r.findings) {
      if (reviews[f.id] && reviews[f.id].fingerprint === fingerprint(f)) f.review = reviews[f.id];
    }
    return r;
  };

  // serialize writes per comparison so concurrent clicks never clobber each other
  const queues = new Map();
  function withLock(id, fn) {
    const prev = queues.get(id) || Promise.resolve();
    const next = prev.then(fn, fn);
    queues.set(id, next.catch(() => {}));
    return next;
  }
  async function writeJsonAtomic(p, data) {
    const tmp = p + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(data, null, 1) + '\n');
    await fsp.rename(tmp, p);
  }

  function progress(report, decisions) {
    const out = { ...Object.fromEntries(DECISIONS.map(d => [d, 0])), undecided: 0, total: 0 };
    for (const f of report.findings) {
      out.total++;
      const d = decisions[f.id]?.decision;
      out[DECISIONS.includes(d) ? d : 'undecided']++;
    }
    return out;
  }

  // ---------- API ----------
  app.get('/api/config', (req, res) => res.json({ root: ROOT, project: PROJECT, decisions: DECISIONS, labels: DECISION_LABELS }));

  app.get('/api/pages', (req, res) => {
    res.json(allPages().map(file => ({ file, dc: file.endsWith('.dc.html'), props: file.endsWith('.dc.html') ? readPropsMeta(file) : null })));
  });

  // Every configured comparison (comparisons/pairs.json × light/dark), with its report summary when it has one.
  app.get('/api/comparisons', async (req, res) => {
    const cfg = readConfig(comparisonsDir);
    const out = [];
    for (const p of expandPairs(cfg)) {
      const r = await readReport(p.id);
      const decisions = await readJson(decisionsPath(p.id), {});
      out.push({
        id: p.id, baseId: p.baseId, theme: p.theme, label: p.label || p.id, design: p.design, live: p.live,
        generated: !!r, generatedAt: r?.generatedAt || null, stats: r?.stats || null,
        liveUrl: r?.live.url || null, progress: r ? progress(r, decisions) : null,
      });
    }
    res.json({ base: cfg.base, comparisons: out });
  });

  app.get('/api/comparisons/:id', async (req, res) => {
    const r = await readReport(req.params.id);
    if (!r) return res.status(404).json({ error: `comparison "${req.params.id}" has no report. Run: node tools/compare.mjs run ${req.params.id}` });
    const decisions = await readJson(decisionsPath(req.params.id), {});
    // meta-findings: groups of findings Claude made by judgement (comparisons/<id>/groups.json)
    const groups = await readJson(path.join(compDir(req.params.id), 'groups.json'), null);
    res.json({ ...r, decisions, groups, progress: progress(r, decisions) });
  });

  // the second pass (reviews.json): one explanation per finding, when it still matches the finding
  app.get('/api/comparisons/:id/reviews', async (req, res) => {
    res.json(await readJson(path.join(compDir(req.params.id), 'reviews.json'), {}));
  });

  // body: { ids: [...], decision?: one of DECISIONS or null (clear), note?: string }
  app.put('/api/comparisons/:id/decisions', async (req, res) => {
    compDir(req.params.id);
    const { ids, decision, note } = req.body || {};
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids required' });
    if (decision !== undefined && decision !== null && !DECISIONS.includes(decision)) return res.status(400).json({ error: `decision must be one of ${DECISIONS.join(', ')} or null` });
    const result = await withLock(req.params.id, async () => {
      const p = decisionsPath(req.params.id);
      await fsp.mkdir(path.dirname(p), { recursive: true });
      const all = await readJson(p, {});
      const at = new Date().toISOString();
      for (const id of ids.map(String)) {
        const cur = { ...(all[id] || {}) };
        if (decision !== undefined) { if (decision === null) delete cur.decision; else cur.decision = decision; }
        if (note !== undefined) { if (note) cur.note = String(note).slice(0, 4000); else delete cur.note; }
        cur.at = at;
        if (!cur.decision && !cur.note) delete all[id]; else all[id] = cur;
      }
      await writeJsonAtomic(p, all);
      return Object.fromEntries(ids.map(id => [id, all[id] || null]));
    });
    res.json(result);
    const r = await readReport(req.params.id);
    broadcast('decision', {
      comparison: req.params.id, title: r?.label || req.params.id, ids, decision: decision === undefined ? undefined : decision,
      decisions: result, by: { client: req.get('x-client-id') || null, tab: req.get('x-client-tab') || null, name: cleanName(decodeHeader(req.get('x-client-name'))) || 'Someone' },
    });
  });

  // One comparison's export: { json, md } or null when it has no report. `h` is the title's heading level.
  async function buildExport(id, h = 1) {
    const r = await readReport(id);
    if (!r) return null;
    const decisions = await readJson(decisionsPath(id), {});
    const p = progress(r, decisions);
    const rows = r.findings.map(f => ({
      id: f.id, category: f.category, severity: f.severity, text: f.text, section: f.section,
      decision: decisions[f.id]?.decision || null, note: decisions[f.id]?.note || null,
      props: f.props.map(x => ({ prop: x.prop, design: x.design, live: x.live })),
      explanation: f.review?.explanation || null, verdict: f.review?.verdict || null,
      source: f.design?.where ? `${r.design.page} tpl ${f.design.where.tpl}` : null,
    }));
    const json = { id: r.id, label: r.label, theme: r.theme || 'light', generatedAt: r.generatedAt, design: { page: r.design.page, props: r.design.props, state: r.design.state }, live: r.live.url, progress: p, findings: rows };
    const H = n => '#'.repeat(h + n);
    const esc = s => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
    let md = `${H(0)} ${r.label}${r.theme ? ` (${r.theme})` : ''}\n\nDesign \`${r.design.page}\` ${JSON.stringify({ props: r.design.props || {}, state: r.design.state || {} })} vs live ${r.live.url}, captured ${r.generatedAt}.\n\n`;
    md += DECISIONS.map(d => `${DECISION_LABELS[d]} ${p[d]}`).join(' · ') + ` · Undecided ${p.undecided} · Total ${p.total}\n\n`;
    const groups = (await readJson(path.join(compDir(id), 'groups.json'), null))?.groups || [];
    const byId = new Map(rows.map(f => [f.id, f]));
    if (groups.length) {
      md += `${H(1)} Groups\n\n`;
      for (const g of groups) {
        const members = g.findings.map(i => byId.get(i)).filter(Boolean);
        if (!members.length) continue;
        const ds = [...new Set(members.map(m => m.decision || '—'))];
        md += `${H(2)} ${g.title} (${g.severity || 'medium'}, ${members.length} findings, ${ds.length === 1 ? (ds[0] === '—' ? 'undecided' : DECISION_LABELS[ds[0]]) : 'mixed'})\n\n${g.summary || ''}\n\n`;
      }
      json.groups = groups;
      md += `${H(1)} All findings\n\n`;
    }
    md += `| Decision | Severity | Category | Element | Difference (design → live) | What's off (reviewer) | Note |\n|---|---|---|---|---|---|---|\n`;
    for (const f of rows) md += `| ${f.decision ? DECISION_LABELS[f.decision] : '—'} | ${f.severity} | ${f.category} | ${esc(f.text)} | ${esc(f.props.map(x => `${x.prop}: ${x.design} → ${x.live}`).join('; '))} | ${esc(f.explanation ? `${f.explanation}${f.verdict ? ` (${f.verdict})` : ''}` : '')} | ${esc(f.note)} |\n`;
    return { json, md };
  }

  app.get('/api/comparisons/:id/export.:fmt', async (req, res) => {
    const out = await buildExport(req.params.id);
    if (!out) return res.status(404).end();
    if (req.params.fmt === 'json') return res.json(out.json);
    if (req.params.fmt !== 'md') return res.status(400).end();
    res.type('text/markdown').send(out.md);
  });

  // One finding as a zip: a Markdown write-up and named screenshots (close crops with the element(s)
  // outlined and guides drawn, plus full-width context strips), cut from the screenshots on the fly.
  app.get('/api/comparisons/:id/findings/:fid/download', async (req, res) => {
    const r = await readReport(req.params.id);
    const f = r?.findings.find(x => x.id === req.params.fid);
    if (!f) return res.status(404).json({ error: 'no such finding' });
    const decisions = await readJson(decisionsPath(req.params.id), {});
    const groups = (await readJson(path.join(compDir(req.params.id), 'groups.json'), null))?.groups || [];
    const group = groups.find(g => g.findings.includes(f.id));
    const slug = `${r.id}-${f.category}-${f.text}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 70);
    const shots = findingShots(r, f, compDir(req.params.id)).map(x => ({ name: `${slug}-${x.name}`, data: x.data }));
    const d = decisions[f.id];
    const cell = v => String(v ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
    let md = `# ${f.category[0].toUpperCase() + f.category.slice(1)}: ${f.text}\n\n`;
    md += `**${r.label}**${r.theme ? ` (${r.theme})` : ''} · severity **${f.severity}** · ${f.section || ''}\n\n`;
    md += `- Design: \`${r.design.page}\` ${JSON.stringify({ props: r.design.props || {}, state: r.design.state || {} })}\n- Live: ${r.live.url}\n- Captured: ${r.generatedAt}\n- Finding id: \`${f.id}\`\n\n`;
    if (f.review?.explanation) md += `## What's off\n\n${f.review.explanation}\n\n${f.review?.verdict ? `_Reviewer (${f.review.model}): ${f.review.verdict}${f.review.confidence ? `, ${f.review.confidence} confidence` : ''}._\n\n` : ''}`;
    md += `## Difference\n\n| Property | Design | Live |\n|---|---|---|\n${f.props.map(p => `| ${cell(p.prop)} | ${cell(p.design)} | ${cell(p.live)} |`).join('\n')}\n\n`;
    if (f.related?.length) md += `Lines up with / measured against: ${f.related.map(x => x.text).join(', ')}.\n\n`;
    if (group) md += `## Part of: ${group.title}\n\n${group.summary || ''}\n\n`;
    if (d?.decision || d?.note) md += `## Review\n\n${d.decision ? `Decision: **${DECISION_LABELS[d.decision]}**\n\n` : ''}${d.note ? `Note: ${d.note}\n\n` : ''}`;
    md += `## Screenshots\n\nMagenta: the design element · blue: the live element · grey dashed: what it's measured against · green: alignment guide.\n\n`;
    md += shots.map(x => `![${x.name}](${x.name})`).join('\n\n') + '\n';
    const body = zip([{ name: `${slug}.md`, data: md }, ...shots]);
    res.set({ 'content-type': 'application/zip', 'content-disposition': `attachment; filename="${slug}.zip"`, 'cache-control': 'no-store' });
    res.send(body);
  });

  // One meta-finding (group) as a zip: a Markdown write-up (the group, its decision state, every member
  // with its measurements and explanation) and named screenshots: an overview of each side with all
  // members outlined, and each member's design/live close-ups, numbered as in the write-up.
  app.get('/api/comparisons/:id/groups/:gid/download', async (req, res) => {
    const r = await readReport(req.params.id);
    if (!r) return res.status(404).json({ error: 'no such comparison' });
    const groups = (await readJson(path.join(compDir(req.params.id), 'groups.json'), null))?.groups || [];
    const g = groups.find(x => x.id === req.params.gid);
    if (!g) return res.status(404).json({ error: 'no such group' });
    const byId = new Map(r.findings.map(f => [f.id, f]));
    const members = g.findings.map(i => byId.get(i)).filter(Boolean);
    const decisions = await readJson(decisionsPath(req.params.id), {});
    const dir = compDir(req.params.id);
    const slug = `${r.id}-${g.id}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 70);
    const cell = v => String(v ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
    const files = groupShots(r, members, dir).map(x => ({ name: `${slug}-${x.name}`, data: x.data }));
    const ds = [...new Set(members.map(f => decisions[f.id]?.decision || ''))];
    let md = `# ${g.title}\n\n**${r.label}**${r.theme ? ` (${r.theme})` : ''} · severity **${g.severity || 'medium'}** · ${members.length} finding${members.length === 1 ? '' : 's'}${g.hint ? ` · _${g.hint}_` : ''}\n\n`;
    md += `- Design: \`${r.design.page}\` ${JSON.stringify({ props: r.design.props || {}, state: r.design.state || {} })}\n- Live: ${r.live.url}\n- Captured: ${r.generatedAt}\n- Group id: \`${g.id}\`\n`;
    md += `- Decision: ${ds.length === 1 ? (ds[0] ? `**${DECISION_LABELS[ds[0]]}**` : 'undecided') : 'mixed'}\n\n`;
    if (g.summary) md += `${g.summary}\n\n`;
    md += `## Overview\n\nMagenta: design elements · blue: live elements.\n\n${files.map(x => `![${x.name}](${x.name})`).join('\n\n')}\n\n## Findings\n\n`;
    members.forEach((f, i) => {
      const n = String(i + 1).padStart(2, '0');
      const shots = findingShots(r, f, dir).filter(x => !x.name.includes('context')).map(x => ({ name: `${slug}-${n}-${x.name}`, data: x.data }));
      files.push(...shots);
      const d = decisions[f.id];
      md += `### ${n}. ${f.category}: ${f.text}\n\n`;
      if (f.review?.explanation) md += `${f.review.explanation}${f.review.verdict ? ` _(${f.review.verdict})_` : ''}\n\n`;
      md += `| Property | Design | Live |\n|---|---|---|\n${f.props.map(p => `| ${cell(p.prop)} | ${cell(p.design)} | ${cell(p.live)} |`).join('\n')}\n\n`;
      if (d?.decision || d?.note) md += `${d.decision ? `Decision: **${DECISION_LABELS[d.decision]}**` : ''}${d.note ? ` · Note: ${d.note}` : ''}\n\n`;
      md += shots.map(x => `![${x.name}](${x.name})`).join(' ') + '\n\n';
    });
    const body = zip([{ name: `${slug}.md`, data: md }, ...files]);
    res.set({ 'content-type': 'application/zip', 'content-disposition': `attachment; filename="${slug}.zip"`, 'cache-control': 'no-store' });
    res.send(body);
  });

  // Every comparison in one file, downloaded as an attachment.
  app.get('/api/export.:fmt', async (req, res) => {
    const fmt = req.params.fmt;
    if (fmt !== 'md' && fmt !== 'json') return res.status(400).end();
    const all = (await Promise.all(expandPairs(readConfig(comparisonsDir)).map(p => buildExport(p.id, 2)))).filter(Boolean);
    const stamp = new Date().toISOString();
    res.set('content-disposition', `attachment; filename="design-vs-live-${stamp.slice(0, 10)}.${fmt}"`);
    if (fmt === 'json') return res.json({ exportedAt: stamp, comparisons: all.map(x => x.json) });
    let md = `# Design vs live: all comparisons\n\nExported ${stamp}.\n\n`;
    md += `| Comparison | ${DECISIONS.map(d => DECISION_LABELS[d]).join(' | ')} | Undecided | Total |\n|---|${DECISIONS.map(() => '---|').join('')}---|---|\n`;
    for (const { json: j } of all) md += `| ${j.label} (\`${j.id}\`) | ${DECISIONS.map(d => j.progress[d]).join(' | ')} | ${j.progress.undecided} | ${j.progress.total} |\n`;
    md += '\n' + all.map(x => x.md).join('\n');
    res.type('text/markdown').send(md);
  });

  // source lines around a location (for the snippet viewer)
  app.get('/api/source', async (req, res) => {
    const file = path.normalize(path.join(PROJECT, String(req.query.file || '')));
    if (!file.startsWith(PROJECT) || !fs.existsSync(file)) return res.status(404).end();
    const line = Number(req.query.line) || 1, ctx = Math.min(Number(req.query.context) || 6, 50);
    const lines = (await fsp.readFile(file, 'utf8')).split('\n');
    const from = Math.max(1, line - ctx), to = Math.min(lines.length, line + ctx);
    res.json({ file: path.relative(PROJECT, file), from, line, lines: lines.slice(from - 1, to).map(l => (l.length > 400 ? l.slice(0, 400) + '…' : l)) });
  });

  app.use((err, req, res, next) => { res.status(err.status || 500).json({ error: err.message }); });

  return app;
}
