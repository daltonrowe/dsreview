// Explanations: Claude Sonnet looks at each finding with its context and writes, for a designer,
// what's off on live compared with the design, plus a verdict (real / noise / unsure).
//
// Context per finding: the comparison (page, theme, design state, live URL), the finding's
// measurements and what it's measured against, the meta-finding (group) it belongs to with Claude's
// title and summary, the other differences found on the same element, and four images: a close crop
// and a full-width context strip of the design and of live (element outlined, guides drawn).
//
// Stored in comparisons/<id>/reviews.json by finding id, with a fingerprint of the finding's
// measurements: a re-run keeps the explanations of findings that didn't change (--force redoes them).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { PNG } from 'pngjs';
import { findingShots } from './crops.mjs';

export const REVIEW_MODEL = 'claude-sonnet-5-5';

const SYSTEM = `You explain visual differences between a product's design and its live website, for the product designer who has to decide what to do about each one.

How the differences were found: two screenshots of the same page, the DESIGN (made in a design tool; the target) and LIVE (the built site), were compared from pixels only. The comparison finds visual elements (text lines, icons, panels such as buttons/inputs/cards, dividers, pictures, grids of tiles), pairs them across the two screenshots and measures differences. It names elements only by kind and size ("Panel 1317×333", "Text 26×13") because it can't read; you can, from the images.

Images for one finding, in order: DESIGN close-up, DESIGN context (full page width), LIVE close-up, LIVE context. The element is outlined in magenta on the design and blue on live; elements it is measured against are outlined in grey dashes; green lines are alignment guides (one line in the design where things line up, one per element on live where they don't). A dashed outline on one side means "the same spot" for an element that only exists on the other side.

You also get the measured differences (design → live), the group this finding belongs to (a reviewer's grouping of findings with one cause, with title and summary: use it to know what the element is and why it matters), and the other differences found on the same element.

Write "explanation": 1-3 plain sentences a designer can act on. Name the element as a designer would ("the Join Pro button", "the search field's magnifier icon", "the section heading 'Featured Photographers'"), say what is visibly different on live, with the numbers that matter, and where useful what it affects (spacing below, alignment with the rail…). Don't restate the coordinates, don't describe the comparison method, don't hedge. If the measurement doesn't match what the images show (wrong pairing, a letter fragment, sample photos vs placeholders), say so plainly instead.

"verdict": "real" if a designer would want this fixed or decided; "noise" if it is an artifact of the comparison or only sample content differs; "unsure" otherwise. "confidence": "high", "medium" or "low".

Reply with only a JSON object: {"explanation": "...", "verdict": "real|noise|unsure", "confidence": "high|medium|low"}.`;

export const fingerprint = f => crypto.createHash('sha1').update(JSON.stringify([f.category, f.props.map(p => [p.prop, p.design, p.live]), f.design?.box, f.live?.box])).digest('hex').slice(0, 12);

export const reviewsPath = dir => path.join(dir, 'reviews.json');
export function readReviews(dir) { try { return JSON.parse(fs.readFileSync(reviewsPath(dir), 'utf8')); } catch { return {}; } }
export const readGroups = dir => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'groups.json'), 'utf8')).groups || []; } catch { return []; } };

// attach still-valid reviews to a report's findings (f.review)
export function withReviews(report, dir) {
  const reviews = readReviews(dir);
  for (const f of report.findings) if (reviews[f.id]?.fingerprint === fingerprint(f)) f.review = reviews[f.id];
  return report;
}

// downscale a PNG so its longest side is at most `max` px (keeps image tokens in check)
function fit(buf, max) {
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

const sameBox = (a, b) => a && b && Math.abs(a.x - b.x) <= 2 && Math.abs(a.y - b.y) <= 2 && Math.abs(a.w - b.w) <= 2 && Math.abs(a.h - b.h) <= 2;

export function context(report, f, groups) {
  const lines = [];
  lines.push(`Page: ${report.label} (${report.theme || 'light'} theme). Design: ${report.design.page} ${JSON.stringify({ props: report.design.props || {}, state: report.design.state || {} })}. Live: ${report.live.url}`);
  lines.push(`Finding: ${f.category}, severity ${f.severity}. Element: ${f.text} ${f.section || ''}.`);
  lines.push(`Measured (design → live):\n${f.props.map(p => `- ${p.prop}: ${p.design} → ${p.live}`).join('\n')}`);
  if (f.related?.length) lines.push(`Measured against: ${f.related.map(r => r.text).join(', ')} (grey dashed outlines).`);
  const g = groups.find(x => x.findings.includes(f.id));
  if (g) lines.push(`Group: "${g.title}"${g.hint ? ` [${g.hint}]` : ''}\n${g.summary || ''}`);
  // other differences on the same element (same design box)
  const others = report.findings.filter(o => o !== f && sameBox(o.design?.box, f.design?.box) && sameBox(o.live?.box, f.live?.box));
  if (others.length) lines.push(`Other differences on the same element:\n${others.map(o => `- ${o.category}: ${o.props.map(p => `${p.prop}: ${p.design} → ${p.live}`).join('; ')}`).join('\n')}`);
  return lines.join('\n\n');
}

async function explainOne(client, model, report, f, dir, groups) {
  const shots = new Map(findingShots(report, f, dir).map(s => [s.name.replace('-same-spot', ''), s.data]));
  const content = [];
  for (const [name, label, max] of [['design.png', 'DESIGN close-up', 900], ['design-context.png', 'DESIGN context', 1100], ['live.png', 'LIVE close-up', 900], ['live-context.png', 'LIVE context', 1100]]) {
    const data = shots.get(name);
    if (!data) continue;
    content.push({ type: 'text', text: `${label}:` });
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: fit(data, max).toString('base64') } });
  }
  content.push({ type: 'text', text: context(report, f, groups) });
  // Server-side fallbacks: if Sonnet declines on a safety classifier, the API retries on a fallback model.
  const res = await client.beta.messages.create({
    model, max_tokens: 4000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low' },
    system: SYSTEM,
    messages: [{ role: 'user', content }],
  });
  if (res.stop_reason === 'refusal') throw new Error('declined');
  return parse(res.content.filter(b => b.type === 'text').map(b => b.text).join(''));
}

// Explain every finding of a report that has no up-to-date explanation. Returns { done, skipped, failed }.
export async function reviewReport(report, dir, { model = REVIEW_MODEL, force = false, concurrency = 6, log = () => {} } = {}) {
  const client = new Anthropic(); // ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / an `ant auth login` profile
  const reviews = readReviews(dir), groups = readGroups(dir);
  const todo = report.findings.filter(f => force || reviews[f.id]?.fingerprint !== fingerprint(f));
  let done = 0, failed = 0, next = 0, authError = null;
  const save = () => fs.writeFileSync(reviewsPath(dir), JSON.stringify(reviews, null, 1) + '\n');
  const worker = async () => {
    while (next < todo.length && !authError) {
      const f = todo[next++];
      try {
        const r = await explainOne(client, model, report, f, dir, groups);
        reviews[f.id] = { ...r, model, fingerprint: fingerprint(f), at: new Date().toISOString() };
        done++;
        if (done % 10 === 0) { save(); log(`  explained ${done}/${todo.length}`); }
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
  if (authError) throw new Error(`the explanation model can't be reached (${authError.status || 'no credentials'}): set ANTHROPIC_API_KEY (e.g. in .env) or log in with \`ant auth login\``);
  return { done, skipped: report.findings.length - todo.length, failed };
}

// Is there anything the SDK could authenticate with? (It only finds out on the first request.)
export function reviewAvailable() {
  const env = process.env;
  if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_PROFILE || env.ANTHROPIC_FEDERATION_RULE_ID) return true;
  const home = env.HOME || env.USERPROFILE || '';
  return fs.existsSync(path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'anthropic'));
}
