// Opening pages on the live site, and preparing any page (live or design) for a like-for-like capture.
import path from 'node:path';
import { ROOT, settle, runStep } from './render.mjs';

export const DEFAULT_BASE = 'https://ao-4276-redesign-rollup.xeezy.com';

// Third parties that only add noise (consent wall, ads, analytics, chat). Blocked on the live site.
const BLOCK = /consentmanager\.net|googletagmanager|google-analytics|doubleclick|googlesyndication|adservice|hotjar|facebook\.net|connect\.facebook|bing\.com\/bat|clarity\.ms|intercom|segment\.(io|com)|sentry|tiktok|pinimg|ct\.pinterest\.com|snapchat|criteo|taboola|outbrain|amazon-adsystem/i;

// Freeze motion and hide tooling overlays, so both sides render deterministically.
export const FREEZE_CSS = `
  *, *::before, *::after { transition: none !important; animation: none !important; caret-color: transparent !important; scroll-behavior: auto !important; }
  #cmpwrapper, .cmpwrapper, .profiler-results { display: none !important; }
  html, body, * { scrollbar-width: none !important; }
  ::-webkit-scrollbar { display: none !important; width: 0 !important; height: 0 !important; }
`;

// The ?skip=1 parameter gets past the staging OAuth wall; it's added to every live URL.
export function liveUrl(base, p) {
  const u = new URL(p || '/', base);
  if (!u.searchParams.has('skip')) u.searchParams.set('skip', '1');
  return u.toString();
}

// o: { do: [steps] }  (same step syntax as tools/dc.mjs --do)
export async function openLive(ctx, base, p, o = {}, log = []) {
  const page = await ctx.newPage();
  await page.route('**/*', route => (BLOCK.test(route.request().url()) ? route.abort() : route.continue()));
  page.on('pageerror', e => log.push('pageerror: ' + e.message.split('\n')[0]));
  page.on('response', r => { if (r.status() >= 400 && r.url().startsWith(base) && r.request().resourceType() === 'document') log.push(`${r.status()}: ${r.url().replace(base, '')}`); });
  const url = liveUrl(base, p);
  const res = await page.goto(url, { waitUntil: 'load', timeout: 60000 });
  // an error page is not the page: comparing it would overwrite a good report with noise
  if (res && res.status() >= 400) { await page.close(); throw new Error(`live page answered ${res.status()}: ${url} (staging down or wrong path?)`); }
  await page.addStyleTag({ content: FREEZE_CSS });
  await settle(page);
  for (const step of o.do || []) await runStep(page, step);
  return page;
}

// Make the whole page (up to maxHeight) fit in the viewport so nothing scrolls: page coordinates
// then equal viewport coordinates, fixed/sticky bars sit where they belong, and every element can
// be hovered without scrolling. Handles pages that scroll inside an inner container (the design canvas).
export async function fitViewport(page, maxHeight) {
  await page.addStyleTag({ content: FREEZE_CSS }).catch(() => {});
  const want = await page.evaluate(() => {
    const doc = document.documentElement.scrollHeight;
    if (doc > innerHeight + 4) return doc;
    let extra = 0;
    for (const el of document.querySelectorAll('body *')) {
      const d = el.scrollHeight - el.clientHeight;
      if (d > extra && el.clientHeight > innerHeight * 0.5 && /(auto|scroll)/.test(getComputedStyle(el).overflowY)) extra = d;
    }
    return innerHeight + extra;
  });
  const vp = page.viewportSize();
  const h = Math.max(vp.height, Math.min(want, maxHeight));
  if (h !== vp.height) await page.setViewportSize({ width: vp.width, height: h });
  // lazy images and infinite lists load as they come into view
  await page.evaluate(() => window.scrollTo(0, 0));
  await settle(page);
  return h;
}
