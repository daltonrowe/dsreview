#!/usr/bin/env node
// Copy reviewer decisions from the deployed review site into the local comparisons/<id>/decisions.json.
//   node tools/pull-decisions.mjs [--url https://…] [--force] [--dry]
// Env: REVIEW_URL (default below), REVIEW_USER / REVIEW_PASS (default eezy / eezy).
// Refuses to overwrite a local decisions file that differs from the remote one unless --force.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './lib/render.mjs';

const argv = process.argv.slice(2);
const flag = f => argv.includes(f);
const url = (argv[argv.indexOf('--url') + 1]?.startsWith('http') ? argv[argv.indexOf('--url') + 1] : null)
  || process.env.REVIEW_URL || 'https://dsreview.daltonrowe.com';
const auth = 'Basic ' + Buffer.from(`${process.env.REVIEW_USER || 'eezy'}:${process.env.REVIEW_PASS || 'eezy'}`).toString('base64');

async function get(p) {
  const res = await fetch(url.replace(/\/$/, '') + p, { headers: { authorization: auth } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${p}`);
  return res.json();
}

const { comparisons } = await get('/api/comparisons');
let conflicts = 0;
for (const c of comparisons.filter(x => x.generated)) {
  const remote = (await get(`/api/comparisons/${c.id}`)).decisions || {};
  const file = path.join(ROOT, 'comparisons', c.id, 'decisions.json');
  if (!fs.existsSync(path.dirname(file))) { console.log(`${c.id}: not in this checkout, skipped`); continue; }
  const local = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const n = Object.keys(remote).length;
  if (JSON.stringify(local) === JSON.stringify(remote)) { console.log(`${c.id}: ${n} decisions, already up to date`); continue; }
  if (Object.keys(local).length && !flag('--force')) {
    console.log(`${c.id}: local has ${Object.keys(local).length} decisions that differ from remote (${n}); use --force to overwrite`);
    conflicts++;
    continue;
  }
  if (!flag('--dry')) fs.writeFileSync(file, JSON.stringify(remote, null, 1) + '\n');
  console.log(`${c.id}: ${flag('--dry') ? 'would write' : 'wrote'} ${n} decisions`);
}
if (conflicts) process.exitCode = 1;
