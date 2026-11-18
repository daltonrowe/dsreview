// Second pass: a smaller model looks at each finding (its design and live crops and the measured
// differences) and explains in plain words what's off, and whether it looks like a real difference
// or an artifact of the comparison.
//
// Reviews live in comparisons/<id>/reviews.json, keyed by finding id, with a fingerprint of the
// finding's measurements: a re-run keeps the reviews of findings that didn't change.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { PNG } from 'pngjs';
import { findingShots } from './crops.mjs';

export const REVIEW_MODEL = 'claude-haiku-5-5';

const SYSTEM = `You review differences found by an automated comparison of two screenshots of the same web page: the DESIGN (the target, from a design tool) and the LIVE site (what's built). The comparison works from pixels only: it finds visual elements (text lines, icons, panels/buttons, dividers, pictures, grids of tiles), pairs them across the two screenshots, and measures differences. It names elements by kind and size ("Panel 1317×333"), not by meaning.

For one finding you get: the two close crops (design first, then live; the element is outlined in magenta on the design and blue on live, things it is measured against are grey dashed, alignment guides are green lines) and the measured rows (property: design → live).

Write for a product designer:
- "explanation": 1-3 short sentences. Say what the element is (read it from the crops: "the Join Pro button", "the search field", "the section title"), and what is visibly off on live compared with the design, in plain words with the numbers that matter. If the measurement doesn't match what you see, say so.
- "verdict": "real" if a designer would want this fixed or decided, "noise" if it is an artifact (the two crops show different content that happens to be paired, a fragment of a letter, sample photos vs placeholders, a difference too small to see), "unsure" otherwise.
- "confidence": "high", "medium" or "low".

Reply with only a JSON object: {"explanation": "...", "verdict": "real|noise|unsure", "confidence": "high|medium|low"}.`;

export const fingerprint = f => crypto.createHash('sha1').update(JSON.stringify([f.category, f.props.map(p => [p.prop, p.design, p.live]), f.design?.box, f.live?.box])).digest('hex').slice(0, 12);

const reviewsPath = dir => path.join(dir, 'reviews.json');
export function readReviews(dir) { try { return JSON.parse(fs.readFileSync(reviewsPath(dir), 'utf8')); } catch { return {}; } }

// downscale a PNG buffer so its longest side is at most `max` px (nearest neighbour; crops are small)
function fit(buf, max = 1000) {
  const src = PNG.sync.read(buf);
  const k = Math.max(src.width, src.height) / max;
  if (k <= 1) return buf;
  const w = Math.round(src.width / k), h = Math.round(src.height / k), out = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const s = (Math.min(src.height - 1, Math.floor(y * k)) * src.width + Math.min(src.width - 1, Math.floor(x * k))) * 4;
    out.data.set(src.data.subarray(s, s + 4), (y * w + x) * 4);
  }
  return PNG.sync.write(out);
}

function parse(text) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('no JSON in reply');
  const j = JSON.parse(m[0]);
  return {
    explanation: String(j.explanation || '').trim(),
    verdict: ['real', 'noise', 'unsure'].includes(j.verdict) ? j.verdict : 'unsure',
    confidence: ['high', 'medium', 'low'].includes(j.confidence) ? j.confidence : 'low',
  };
}

async function reviewOne(client, model, report, f, dir) {
  const shots = findingShots(report, f, dir).filter(s => !s.name.includes('context'));
  const content = [];
  for (const s of shots) {
    content.push({ type: 'text', text: s.name.startsWith('design') ? 'DESIGN crop:' : 'LIVE crop:' });
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: fit(s.data).toString('base64') } });
  }
  content.push({ type: 'text', text: `Finding: ${f.category} · ${f.text} · ${f.section || ''}\nMeasured (design → live):\n${f.props.map(p => `- ${p.prop}: ${p.design} → ${p.live}`).join('\n')}${f.related?.length ? `\nMeasured against: ${f.related.map(r => r.text).join(', ')}` : ''}` });
  const res = await client.messages.create({
    model, max_tokens: 4000,
    output_config: { effort: 'low' },
    system: SYSTEM,
    messages: [{ role: 'user', content }],
  });
  if (res.stop_reason === 'refusal') throw new Error('model declined');
  const text = res.content.filter(b => b.type === 'text').map(b => b.text).join('');
  return parse(text);
}

// Review every finding of a report that has no up-to-date review. Returns { done, skipped, failed }.
export async function reviewReport(report, dir, { model = REVIEW_MODEL, force = false, concurrency = 6, log = () => {} } = {}) {
  const client = new Anthropic(); // ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / an `ant auth login` profile
  const reviews = readReviews(dir);
  const todo = report.findings.filter(f => force || reviews[f.id]?.fingerprint !== fingerprint(f));
  let done = 0, failed = 0, next = 0, authError = null;
  const save = () => fs.writeFileSync(reviewsPath(dir), JSON.stringify(reviews, null, 1) + '\n');
  const worker = async () => {
    while (next < todo.length && !authError) {
      const f = todo[next++];
      try {
        const r = await reviewOne(client, model, report, f, dir);
        reviews[f.id] = { ...r, model, fingerprint: fingerprint(f), at: new Date().toISOString() };
        done++;
        if (done % 10 === 0) { save(); log(`  reviewed ${done}/${todo.length}`); }
      } catch (e) {
        // no or bad credentials: stop at the first one instead of failing every finding
        if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError || /resolve authentication/i.test(e.message)) { authError = e; break; }
        failed++;
        log(`  ${f.id}: ${e instanceof Anthropic.APIError ? `API ${e.status}` : 'error'}: ${String(e.message).split('\n')[0]}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, worker));
  save();
  if (authError) throw new Error(`the review model can't be reached (${authError.status || 'no credentials'}): set ANTHROPIC_API_KEY (e.g. in .env) or log in with \`ant auth login\``);
  return { done, skipped: report.findings.length - todo.length, failed };
}

// Is there anything the SDK could authenticate with? (It only finds out on the first request.)
export function reviewAvailable() {
  const env = process.env;
  if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_PROFILE || env.ANTHROPIC_FEDERATION_RULE_ID) return true;
  const home = env.HOME || env.USERPROFILE || '';
  return fs.existsSync(path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'anthropic'));
}
