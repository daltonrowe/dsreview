#!/usr/bin/env node
// Review server: serves the viewer, the design project, survey data, and the decisions API.
//   node tools/server.mjs [--port 4321] [--open]
import express from 'express';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { exec } from 'node:child_process';
import { ROOT, PROJECT, allPages, readPropsMeta } from './lib/render.mjs';

const SURVEYS = path.join(ROOT, 'surveys');
const argv = process.argv.slice(2);
const PORT = Number(argv[argv.indexOf('--port') + 1]) || Number(process.env.PORT) || 4321;
const DECISIONS = ['keep', 'round', 'exclude', 'remove'];

const app = express();
app.use(express.json());
const noCache = { etag: false, lastModified: false, setHeaders: res => res.set('cache-control', 'no-store') };

app.use('/', express.static(path.join(ROOT, 'tools/viewer'), noCache));
app.get('/lib/bridge.js', (req, res) => res.set('cache-control', 'no-store').sendFile(path.join(ROOT, 'tools/lib/bridge.js')));
app.use('/design-project', express.static(PROJECT, noCache));
app.use('/surveys', express.static(SURVEYS, noCache));
app.use('/design-system', express.static(path.join(ROOT, 'design-system'), noCache));
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
  const out = { keep: 0, round: 0, exclude: 0, remove: 0, undecided: 0, total: 0 };
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

app.get('/api/surveys', async (req, res) => {
  const ids = fs.existsSync(SURVEYS) ? fs.readdirSync(SURVEYS).filter(d => fs.existsSync(path.join(SURVEYS, d, 'spec.json'))) : [];
  const out = [];
  for (const id of ids.sort()) {
    const spec = await readJson(path.join(SURVEYS, id, 'spec.json'), {});
    const survey = await readJson(path.join(SURVEYS, id, 'survey.json'), null);
    const decisions = await readJson(path.join(SURVEYS, id, 'decisions.json'), {});
    out.push({ id, title: spec.title, preset: spec.preset, description: spec.description || '', generated: !!survey, generatedAt: survey?.generatedAt || null, stats: survey?.stats || null, progress: survey ? progress(survey, decisions) : null });
  }
  res.json(out);
});

app.get('/api/surveys/:id', async (req, res) => {
  const dir = surveyDir(req.params.id);
  const survey = await readJson(path.join(dir, 'survey.json'), null);
  if (!survey) return res.status(404).json({ error: `survey "${req.params.id}" not generated. Run: node tools/survey.mjs run ${req.params.id}` });
  const decisions = await readJson(path.join(dir, 'decisions.json'), {});
  res.json({ ...survey, decisions, progress: progress(survey, decisions) });
});

// body: { ids: [...], decision?: 'keep'|'round'|'exclude'|'remove'|null, note?: string,
//         round?: { [itemId]: { to: token, value, css } } (required per id when decision is 'round') }
app.put('/api/surveys/:id/decisions', async (req, res) => {
  const dir = surveyDir(req.params.id);
  const { ids, decision, note, round } = req.body || {};
  if (decision === 'round' && ids.some(i => !round?.[i]?.to)) return res.status(400).json({ error: 'round decision needs round[id].to for every id' });
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids required' });
  if (decision !== undefined && decision !== null && !DECISIONS.includes(decision)) return res.status(400).json({ error: `decision must be one of ${DECISIONS.join(', ')} or null` });
  const result = await withLock(req.params.id, async () => {
    const p = path.join(dir, 'decisions.json');
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
});

app.get('/api/surveys/:id/export.:fmt', async (req, res) => {
  const dir = surveyDir(req.params.id);
  const survey = await readJson(path.join(dir, 'survey.json'), null);
  if (!survey) return res.status(404).end();
  const decisions = await readJson(path.join(dir, 'decisions.json'), {});
  const rows = survey.sections.map(s => ({
    section: s.n, value: s.value, tokens: s.tokens,
    items: s.items.map(it => ({
      ref: `S${s.n}.${it.n}`, id: it.id, decision: decisions[it.id]?.decision || null, roundTo: decisions[it.id]?.round?.to || null, roundValue: decisions[it.id]?.round?.value || null, note: decisions[it.id]?.note || null,
      declared: it.declared, component: it.component, page: survey.captures[it.where.capture]?.label,
      source: it.source?.line ? `${it.source.file}:${it.source.line}` : it.source?.file, shot: it.shot && `surveys/${survey.id}/${it.shot}`,
    })),
  }));
  if (req.params.fmt === 'json') return res.json({ id: survey.id, title: survey.title, preset: survey.preset, generatedAt: survey.generatedAt, progress: progress(survey, decisions), sections: rows });
  if (req.params.fmt !== 'md') return res.status(400).end();
  const p = progress(survey, decisions);
  let md = `# ${survey.title}\n\nSurvey \`${survey.id}\` (preset \`${survey.preset}\`), generated ${survey.generatedAt}.\n\n`;
  md += `Keep ${p.keep} · Round ${p.round} · Exclude ${p.exclude} · Remove ${p.remove} · Undecided ${p.undecided} · Total ${p.total}\n\n`;
  for (const s of rows) {
    const counts = DECISIONS.map(d => `${d} ${s.items.filter(i => i.decision === d).length}`).join(', ');
    md += `## S${s.section} · \`${s.value}\`\n\n${s.tokens.length ? `Tokens: ${s.tokens.map(t => `\`${t}\``).join(', ')}. ` : ''}${s.items.length} usages (${counts}).\n\n`;
    md += `| # | Decision | Declared | Component | Page | Source | Note |\n|---|---|---|---|---|---|---|\n`;
    for (const it of s.items) md += `| ${it.ref} | ${it.decision === 'round' ? `round → \`${it.roundTo}\`${it.roundValue ? ` (${it.roundValue})` : ''}` : it.decision || '—'} | \`${(it.declared || '').replace(/\|/g, '\\|')}\` | ${it.component || ''} | ${it.page || ''} | ${it.source || ''} | ${(it.note || '').replace(/\|/g, '\\|').replace(/\n/g, ' ')} |\n`;
    md += '\n';
  }
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

app.listen(PORT, '127.0.0.1', () => {
  const url = `http://localhost:${PORT}`;
  console.log(`design-system-review → ${url}`);
  if (argv.includes('--open')) exec(`open ${url}`);
});
