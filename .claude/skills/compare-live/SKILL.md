---
name: compare-live
description: Compare screenshots of design-project pages and the live site (https://ao-4276-redesign-rollup.xeezy.com) from a designer's point of view — pixels only, no DOM or CSS — for alignment, size, color, typography, shape, spacing and missing/extra elements, and read or act on the reviewer decisions. Use when asked to compare a design page with live, add or re-run a comparison, screenshot a live page, explain what differs, or compile what needs fixing on live vs in the design.
---

# Comparing the design with the live site

Everything goes through `tools/compare.mjs` (Playwright + headless Chromium). Run from the repo root.
Reports land in `comparisons/<id>/` and are reviewed in the viewer (`npm start` → `compare.html?id=<id>`).

## Vocabulary
- **Comparison (pair)**: one design page state ↔ one live URL, configured in `comparisons/pairs.json`.
  Design side = `page` + `props` + `state` + `do` (exactly the `tools/dc.mjs` options, see the `view-design` skill).
  Live side = `path` (`?skip=1` is added to get past the staging OAuth wall) + optional `do` steps.
- **Themes**: every pair runs light and dark. The dark comparison's id is `<id>--dark` (design `theme`
  prop = dark; live browser `prefers-color-scheme: dark`, which the live site follows). `run home` runs
  both; `--theme dark` one. Pair options: `"themes": ["light"]`, `"dark": { "design": {…}, "live": {…} }`.
- **Screenshots only** (this branch): the browser renders; the analysis reads pixels, never the DOM/CSS.
- **Element** (`tools/lib/vision.mjs`): a group of edges in a screenshot, with a tight box and a kind —
  `text`, `icon`, `panel` (outline around a flat fill: button, chip, input, card, masthead; has `fill`,
  `radius`, `border`), `line` (divider), `image` (picture; its inside is ignored) or `shape` — plus the color
  behind it, its ink color and ink ratio, and a grayscale thumbnail used to recognise it on the other side.
- **Pairing** (`tools/lib/pixeldiff.mjs`): anchors (unique look-alikes) give the local offset; elements pair
  with the best look-alike near where they're expected; big flat things also pair by size and place.
- **Finding**: one difference for one paired element and one category (`typography`, `color`, `size`,
  `shape`, `spacing`, `alignment`, `missing`, `extra`), with severity and property rows (`design → live`).
  Titled by kind and size ("Panel 1317×330"); `section` is its position. Alignment findings carry `guide`
  (axis + design/live edge values) and `related` partner boxes; they're page-wide (masthead top vs the
  first rail button).
- **Decision** (reviewer, in the viewer): `keep` (a real difference) or `ignore` (noise), plus a note.
  Stored in `comparisons/<id>/decisions.json` locally (deployed: `DATA_DIR/compare/<id>.json`; pull with
  `npm run pull-decisions`). Finding ids: `<category>:<kind>@<x/16>,<y/16>` (design position).

- **Grid**: tiles packed together over 2+ rows and columns (masonry `columns` or justified `rows`);
  compared on where it starts/ends, columns, ragged bottom, the gap after it.
- **Whole page**: captures are the full page height (footer included) via a very tall viewport, up to 16000px.
- **Review** (`reviews.json`): a smaller model (Claude Haiku 5.5) explains each finding from its crops,
  with a verdict real/noise/unsure. Needs `ANTHROPIC_API_KEY` (or `.env`); `run` does it when available.
- **Meta-findings** (`groups.json`): YOUR job when asked to group or regroup. See "Grouping" below.

## Workflow
```bash
node tools/compare.mjs list                         # configured pairs + report status
node tools/compare.mjs run                          # all pairs, light + dark (~10 s each); or: run home sign-up
node tools/compare.mjs show home --severity medium  # findings as text; --category color,size --limit N
node tools/compare.mjs add show-page --label "Show page" --design "ai magic" --state active=... --live /vector-art/581241-slices-lime-summer-background
node tools/compare.mjs live /free-photos/dog --full # screenshot a live page → screenshots/
node tools/compare.mjs review home                  # smaller-model explanations (needs ANTHROPIC_API_KEY)
node tools/compare.mjs findings home                # ids, for grouping
node tools/compare.mjs crop home <findingId>        # close crops → screenshots/crops/
node tools/compare.mjs group home groups.json       # install meta-findings
```
Then Read `comparisons/<id>/design.jpg` and `live.jpg` (same width, page coordinates) to see both sides.

## Picking the design state for a live page
Make the design match the live page's *content state* before judging differences, or everything shows up
as missing/extra. Look at the live page first (`compare.mjs live <path>`), then pick props/state with
`node tools/dc.mjs list` / `inspect`. Known: the live sign-up/log-in pages use the **Original** left
panel; the live home shows **Sign Up** (design: **Log In**) and the **Vectors** search scope;
`/signups/join-pro` on live is still the old pricing page (the redesign isn't there yet).

## Grouping (meta-findings)
When asked to group findings, or after a `run` warns that grouped findings no longer exist:
1. `node tools/compare.mjs findings <id>`: every finding with its id, positions and measurements.
2. Look at `comparisons/<id>/design.jpg` / `live.jpg`, and `node tools/compare.mjs crop <id> <findingId>`
   for close crops (design magenta, live blue, partner grey dashed, guides green) in screenshots/crops/.
3. Group by one cause a designer would recognise (a section that moved and the gaps it changed; one
   palette shift across many colours; a component that differs; a grid that ends elsewhere). Title names
   the cause with the key number; summary says what the elements actually are and why they belong
   together; severity by how much a designer would care; `hint` for "likely noise" (analysis artifacts)
   or "content difference" (copy, sample photos). Every finding in exactly one group.
4. Write `{ "by": "claude", "groups": [ { "id", "title", "summary", "severity", "hint"?, "findings": [ids] } ] }`
   to a file and install it: `node tools/compare.mjs group <id> <file>` (fix what it reports).
Light and dark are separate comparisons (`<id>` and `<id>--dark`) and need their own groups.

## Reading results
- Check what the analysis saw: in the viewer, turn on **Elements** (`e`), or read
  `comparisons/<id>/snapshot.json` (`design.blobs` / `live.blobs`, gitignored).
- `missing`/`extra` are often content differences (different copy, sample data, photos vs placeholders).
- No hover/behavior check: a screenshot is one state. Add a pair with `do` steps for a hover/open state.
- If the live site is down (4xx/5xx), `run` stops with an error rather than comparing an error page.

## Acting on decisions
Read `decisions.json` (or `GET /api/comparisons/<id>/export.md`) and join with `report.json` findings by id.
`keep` = a confirmed difference between design and live; `ignore` = noise. When asked to compile the
differences, list the kept ones (with their property rows, design → live, and crops from the screenshots).
Use ignored findings to tune the vision (`tools/lib/vision.mjs`) or pairing (`tools/lib/pixeldiff.mjs`)
when the same kind of noise keeps coming back.
