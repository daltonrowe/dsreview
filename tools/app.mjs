// The review web app: viewer, design project, survey data and the decisions API.
// Started by tools/server.mjs; exported separately so tests can run it on a random port.
import express from 'express';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT, PROJECT, allPages, readPropsMeta } from './lib/render.mjs';

const SURVEYS = path.join(ROOT, 'surveys');
// 'unclear' (🤷 in the viewer) marks a usage the reviewer doesn't understand: it needs a look, not a verdict.
const DECISIONS = ['keep', 'round', 'exclude', 'unclear'];

// options:
//   user, pass  HTTP basic auth credentials (everything but /up requires them)
//   dataDir     where decisions are stored. Unset (local): surveys/<id>/decisions.json, next to the survey.
//               Set (production, a persistent volume): <dataDir>/decisions/<id>.json, so deploys keep them.
export function createApp({ user = 'eezy', pass = 'eezy', dataDir = null } = {}) {
  const app = express();
  const decisionsPath = id => (dataDir ? path.join(dataDir, 'decisions', `${id}.json`) : path.join(SURVEYS, id, 'decisions.json'));
  // Reviewer edits to a survey's groups (names, usages moved to Uncategorized), stored like decisions.
  const groupEditsPath = id => (dataDir ? path.join(dataDir, 'groups', `${id}.json`) : path.join(SURVEYS, id, 'group-edits.json'));
  const emptyEdits = () => ({ names: {}, uncategorized: [] });

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
    res.set('WWW-Authenticate', 'Basic realm="Design System Review", charset="UTF-8"').status(401).send('Authentication required');
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
  const surveyTitles = new Map();
  const surveyTitle = async id => {
    if (!surveyTitles.has(id)) surveyTitles.set(id, (await readJson(path.join(SURVEYS, id, 'spec.json'), {})).title || id);
    return surveyTitles.get(id);
  };
  const noCache = { etag: false, lastModified: false, setHeaders: res => res.set('cache-control', 'no-store') };

  app.use('/', express.static(path.join(ROOT, 'tools/viewer'), noCache));
  app.get('/lib/bridge.js', (req, res) => res.set('cache-control', 'no-store').sendFile(path.join(ROOT, 'tools/lib/bridge.js')));
  app.use('/design-project', express.static(PROJECT, noCache));
  app.use('/surveys', express.static(SURVEYS, noCache));
  app.use('/design-system', express.static(path.join(ROOT, 'design-system'), noCache));
  app.use('/analysis', express.static(path.join(ROOT, 'analysis'), noCache));
  app.use('/screenshots', express.static(path.join(ROOT, 'screenshots'), noCache));

  // ---------- helpers ----------
  const surveyDir = id => {
    if (!/^[\w.-]+$/.test(id)) throw Object.assign(new Error('bad survey id'), { status: 400 });
    return path.join(SURVEYS, id);
  };
  const readJson = async (p, fallback) => { try { return JSON.parse(await fsp.readFile(p, 'utf8')); } catch { return fallback; } };

  // serialize writes per survey so concurrent clicks never clobber each other
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

  function progress(survey, decisions) {
    const out = { keep: 0, round: 0, exclude: 0, unclear: 0, undecided: 0, total: 0 };
    for (const s of survey.sections) for (const it of s.items) {
      out.total++;
      const d = decisions[it.id]?.decision;
      out[DECISIONS.includes(d) ? d : 'undecided']++;
    }
    return out;
  }

  // ---------- API ----------
  app.get('/api/config', (req, res) => res.json({ root: ROOT, project: PROJECT }));

  app.get('/api/pages', (req, res) => {
    res.json(allPages().map(file => ({ file, dc: file.endsWith('.dc.html'), props: file.endsWith('.dc.html') ? readPropsMeta(file) : null })));
  });

  app.get('/api/components', async (req, res) => {
    const data = await readJson(path.join(ROOT, 'analysis/components/components.json'), null);
    if (!data) return res.status(404).json({ error: 'Not generated. Run: node tools/components.mjs' });
    res.json(data);
  });

  app.get('/api/surveys', async (req, res) => {
    const ids = fs.existsSync(SURVEYS) ? fs.readdirSync(SURVEYS).filter(d => fs.existsSync(path.join(SURVEYS, d, 'spec.json'))) : [];
    const out = [];
    for (const id of ids.sort()) {
      const spec = await readJson(path.join(SURVEYS, id, 'spec.json'), {});
      const survey = await readJson(path.join(SURVEYS, id, 'survey.json'), null);
      const decisions = await readJson(decisionsPath(id), {});
      out.push({ id, title: spec.title, preset: spec.preset, description: spec.description || '', generated: !!survey, generatedAt: survey?.generatedAt || null, stats: survey?.stats || null, progress: survey ? progress(survey, decisions) : null });
    }
    res.json(out);
  });

  app.get('/api/surveys/:id', async (req, res) => {
    const dir = surveyDir(req.params.id);
    const survey = await readJson(path.join(dir, 'survey.json'), null);
    if (!survey) return res.status(404).json({ error: `survey "${req.params.id}" not generated. Run: node tools/survey.mjs run ${req.params.id}` });
    const decisions = await readJson(decisionsPath(req.params.id), {});
    const groupEdits = { ...emptyEdits(), ...(await readJson(groupEditsPath(req.params.id), {})) };
    res.json({ ...survey, decisions, groupEdits, progress: progress(survey, decisions) });
  });

  // body: { ids: [...], decision?: 'keep'|'round'|'exclude'|'unclear'|null, note?: string,
  //         round?: { [itemId]: { to: token, value, css } } (required per id when decision is 'round') }
  app.put('/api/surveys/:id/decisions', async (req, res) => {
    const dir = surveyDir(req.params.id);
    const { ids, decision, note, round } = req.body || {};
    if (decision === 'round' && ids.some(i => !round?.[i]?.to)) return res.status(400).json({ error: 'round decision needs round[id].to for every id' });
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids required' });
    if (decision !== undefined && decision !== null && !DECISIONS.includes(decision)) return res.status(400).json({ error: `decision must be one of ${DECISIONS.join(', ')} or null` });
    const result = await withLock(req.params.id, async () => {
      const p = decisionsPath(req.params.id);
      await fsp.mkdir(path.dirname(p), { recursive: true });
      const all = await readJson(p, {});
      const at = new Date().toISOString();
      for (const id of ids) {
        const cur = { ...(all[id] || {}) };
        if (decision !== undefined) { if (decision === null) delete cur.decision; else cur.decision = decision; }
        if (decision === 'round') cur.round = { to: String(round[id].to), value: round[id].value ?? null, css: round[id].css ?? null };
        else if (decision !== undefined) delete cur.round;
        if (note !== undefined) { if (note) cur.note = String(note); else delete cur.note; }
        cur.at = at;
        if (!cur.decision && !cur.note) delete all[id]; else all[id] = cur;
      }
      await writeJsonAtomic(p, all);
      return Object.fromEntries(ids.map(id => [id, all[id] || null]));
    });
    res.json(result);
    broadcast('decision', {
      survey: req.params.id, title: await surveyTitle(req.params.id), ids, decision: decision === undefined ? undefined : decision,
      decisions: result, by: { client: req.get('x-client-id') || null, tab: req.get('x-client-tab') || null, name: cleanName(decodeHeader(req.get('x-client-name'))) || 'Someone' },
    });
  });

  // One survey's export: { json, md } or null when it isn't generated. `h` is the heading level
  // of the survey title (1 alone, 2 inside the all-surveys export).
  async function buildExport(id, h = 1) {
    const survey = await readJson(path.join(surveyDir(id), 'survey.json'), null);
    if (!survey) return null;
    const decisions = await readJson(decisionsPath(id), {});
    const rows = survey.sections.map(s => ({
      section: s.n, value: s.value, tokens: s.tokens,
      items: s.items.map(it => ({
        ref: `S${s.n}.${it.n}`, id: it.id, decision: decisions[it.id]?.decision || null, roundTo: decisions[it.id]?.round?.to || null, roundValue: decisions[it.id]?.round?.value || null, note: decisions[it.id]?.note || null,
        declared: it.declared, component: it.component, page: survey.captures[it.where.capture]?.label,
        source: it.source?.line ? `${it.source.file}:${it.source.line}` : it.source?.file, shot: it.shot && `surveys/${survey.id}/${it.shot}`,
      })),
    }));
    const p = progress(survey, decisions);
    const json = { id: survey.id, title: survey.title, preset: survey.preset, generatedAt: survey.generatedAt, progress: p, sections: rows };
    const H = n => '#'.repeat(h + n);
    let md = `${H(0)} ${survey.title}\n\nSurvey \`${survey.id}\` (preset \`${survey.preset}\`), generated ${survey.generatedAt}.\n\n`;
    md += `Keep ${p.keep} · Round ${p.round} · Exclude ${p.exclude} · Unclear 🤷 ${p.unclear} · Undecided ${p.undecided} · Total ${p.total}\n\n`;
    for (const s of rows) {
      const counts = DECISIONS.map(d => `${d} ${s.items.filter(i => i.decision === d).length}`).join(', ');
      md += `${H(1)} S${s.section} · \`${s.value}\`\n\n${s.tokens.length ? `Tokens: ${s.tokens.map(t => `\`${t}\``).join(', ')}. ` : ''}${s.items.length} usages (${counts}).\n\n`;
      md += `| # | Decision | Declared | Component | Page | Source | Note |\n|---|---|---|---|---|---|---|\n`;
      for (const it of s.items) md += `| ${it.ref} | ${it.decision === 'round' ? `round → \`${it.roundTo}\`${it.roundValue ? ` (${it.roundValue})` : ''}` : it.decision || '—'} | \`${(it.declared || '').replace(/\|/g, '\\|')}\` | ${it.component || ''} | ${it.page || ''} | ${it.source || ''} | ${(it.note || '').replace(/\|/g, '\\|').replace(/\n/g, ' ')} |\n`;
      md += '\n';
    }
    return { json, md };
  }

  app.get('/api/surveys/:id/export.:fmt', async (req, res) => {
    const out = await buildExport(req.params.id);
    if (!out) return res.status(404).end();
    if (req.params.fmt === 'json') return res.json(out.json);
    if (req.params.fmt !== 'md') return res.status(400).end();
    res.type('text/markdown').send(out.md);
  });

  // body: { rename?: { group, name } (empty name restores the generated one),
  //         uncategorize?: [itemId, ...], restore?: [itemId, ...] }
  app.put('/api/surveys/:id/group-edits', async (req, res) => {
    surveyDir(req.params.id);
    const { rename, uncategorize, restore } = req.body || {};
    const edits = await withLock(req.params.id + ':groups', async () => {
      const p = groupEditsPath(req.params.id);
      const e = { ...emptyEdits(), ...(await readJson(p, {})) };
      if (rename?.group) {
        const name = String(rename.name || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 120);
        if (name) e.names[String(rename.group)] = name; else delete e.names[String(rename.group)];
      }
      const set = new Set(e.uncategorized);
      for (const i of uncategorize || []) set.add(String(i));
      for (const i of restore || []) set.delete(String(i));
      e.uncategorized = [...set];
      await fsp.mkdir(path.dirname(p), { recursive: true });
      await writeJsonAtomic(p, e);
      return e;
    });
    res.json(edits);
    broadcast('group-edits', { survey: req.params.id, edits, by: { client: req.get('x-client-id') || null, tab: req.get('x-client-tab') || null, name: cleanName(decodeHeader(req.get('x-client-name'))) || 'Someone' } });
  });

  // Every generated survey in one file, downloaded as an attachment.
  app.get('/api/export.:fmt', async (req, res) => {
    const fmt = req.params.fmt;
    if (fmt !== 'md' && fmt !== 'json') return res.status(400).end();
    const ids = fs.existsSync(SURVEYS) ? fs.readdirSync(SURVEYS).filter(d => fs.existsSync(path.join(SURVEYS, d, 'survey.json'))).sort() : [];
    const all = (await Promise.all(ids.map(id => buildExport(id, 2)))).filter(Boolean);
    const stamp = new Date().toISOString();
    res.set('content-disposition', `attachment; filename="dsreview-export-${stamp.slice(0, 10)}.${fmt}"`);
    if (fmt === 'json') return res.json({ exportedAt: stamp, surveys: all.map(x => x.json) });
    let md = `# Design System Review: all surveys\n\nExported ${stamp}.\n\n`;
    md += `| Survey | Keep | Round | Exclude | Unclear 🤷 | Undecided | Total |\n|---|---|---|---|---|---|---|\n`;
    for (const { json: j } of all) md += `| ${j.title} (\`${j.id}\`) | ${j.progress.keep} | ${j.progress.round} | ${j.progress.exclude} | ${j.progress.unclear} | ${j.progress.undecided} | ${j.progress.total} |\n`;
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
