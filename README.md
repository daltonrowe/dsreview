# Design vs Live

Tooling for comparing the exported Claude design project (`design-project/`) with the live site
(https://ao-4276-redesign-rollup.xeezy.com) and reviewing the visual differences: alignment, size, color,
typography, shape, spacing, icons and hover behavior.

## Setup

```bash
npm install
npm run browsers   # headless Chromium for screenshots and comparisons (once)
npm start          # review viewer at http://localhost:4321 (opens browser)
npm run serve      # same, without opening a browser
npm test           # server + diff tests
```

The server requires HTTP basic auth: `eezy` / `eezy` (override with `REVIEW_USER` / `REVIEW_PASS`).

## Layout

| Path | What |
|---|---|
| `design-project/` | The exported design project (`*.dc.html` live pages, `Vecteezy *.html` standalone exports) |
| `design-system/` | Target design-system tokens (`tokens.json` source; `tokens.css` / `tokens.md` generated views) |
| `comparisons/pairs.json` | Which design page state is compared with which live URL |
| `comparisons/<id>/` | One comparison's `report.json`, `design.jpg`, `live.jpg`, reviewer `decisions.json` (and a gitignored `snapshot.json`) |
| `tools/compare.mjs` | Comparison CLI: run, show, add, screenshot live pages |
| `tools/dc.mjs` | Design-project screenshot CLI |
| `tools/app.mjs`, `tools/server.mjs` | Express app (viewer, reports, decisions API, live collaboration) and its launcher |
| `tools/pull-decisions.mjs` | Copies decisions from the deployed site into local `comparisons/*/decisions.json` |
| `tools/viewer/` | Viewer UI: home, comparison review, design page viewer |
| `tools/lib/` | `render.mjs` (design pages in Playwright), `live.mjs` (live pages: consent wall, ?skip=1, full-height capture), `snapshot.js` (in-page element snapshot), `diff.mjs` (matching + findings), `bridge.js` (design runtime helpers), `source.mjs` (element → source line) |
| `.claude/skills/` | `view-design`, `compare-live`: how Claude Code uses the tools |

## How a comparison works

1. Both pages render in headless Chromium at the same width (1440). The live site gets `?skip=1`, its
   consent manager and ad/analytics scripts are blocked, and the Rails profiler badge is hidden. Animations,
   transitions and scrollbars are turned off on both sides.
2. The viewport grows to the page's full height (capped at `maxHeight`, default 3000px), including design
   pages that scroll inside an inner container, so page and screen coordinates agree and nothing is hidden
   behind a scroll.
3. Each side is snapshotted (`tools/lib/snapshot.js`): every visible piece of text, form field and
   icon-only control, with its text box, typography and the painted box around it (button, chip, input,
   card). Hidden things (sr-only text, collapsed drawers, covered panels) are skipped.
4. Every interactive item is hovered on both sides and its styles read before and after.
5. Items are matched by text near where they're expected (`tools/lib/diff.mjs`), then compared:
   **typography**, **color** (text, background, gradient), **size** of the box, **shape** (radius, border,
   shadow, box present on one side only), **spacing** (gap to the next element below/right, text inset),
   **alignment** (an element that stops lining up with the things it lined up with in the design; whole
   regions that moved), **icon** count/size, **behavior** (hover effect, clickability, cursor), and
   **missing** / **extra** items.

```bash
node tools/compare.mjs list
node tools/compare.mjs run                 # all pairs; or: run home sign-up; --no-hover is faster
node tools/compare.mjs show home --severity medium
node tools/compare.mjs add show --design "ai magic" --state active=... --live /vector-art/581241-slices-lime-summer-background
node tools/compare.mjs live /free-photos/dog --full
```

Re-running keeps decisions: finding ids are stable (`<category>:<text>#<occurrence>`).

## Viewer

- **Home** (`/`): each comparison with design/live thumbnails, finding counts by severity and category, and
  decision progress. The design pages are listed below (collapsed) with links to the page viewer.
- **Comparison** (`/compare.html?id=home`): findings on the left, the two screenshots on the right.
  - Views: **Side by side** (one scroll for both), **Overlay** (slider sets live opacity), **Difference**
    (identical pixels are black), **Swipe** (slider moves the split). Boxes outline every finding shown
    (magenta design, blue live); click one to select its finding. **Fit** / **100%** zoom.
  - Each finding shows design and live crops, the property rows (design → live, with swatches), links to
    the design page with the element marked and to its source line, and the decision buttons:
    **Fix live**, **Update design**, **Fine**, **🤷**, plus a note (✎).
  - Filter by category (click; ⌘/shift-click for several), severity, decision status and text. **Set all
    shown…** decides every finding in the current filter. **Export** downloads Markdown (`.json` too).
  - Keys: `j`/`k` move, `1` fix live, `2` update design, `3` fine, `4` 🤷, `0` clear, `n` note, `m` cycle
    view, `[`/`]` slider, `b` toggle all boxes, `/` search.
- **Live collaboration**: each browser gets a random name (e.g. "Teal Fox") and streams updates from
  `/api/live` (server-sent events). A yellow **N online** pill appears when more than one person is on the
  site; decisions made elsewhere update open pages in place and show a toast.
- **Page viewer** (`/view.html?page=…`): a design page with prop controls, internal state, and width. When
  opened from a finding, it applies that state and marks the element.

## Design screenshots: `tools/dc.mjs`

```bash
node tools/dc.mjs list                                   # pages + props (variants)
node tools/dc.mjs inspect pricing --props theme=dark     # components, state, controls in that state
node tools/dc.mjs shot pricing --props theme=dark --component faq
node tools/dc.mjs shot "ai magic" --state active=explore
node tools/dc.mjs matrix "log in" --vary leftPanel
node tools/dc.mjs help
```

## Deploy (dcloudbox)

Kamal 2 deploys to dcloudbox behind the shared kamal-proxy. GitHub Actions (`.github/workflows/cd.yml`) runs on every push to `master`: it runs the tests, builds the image, pushes it to ghcr.io and runs `bin/kamal deploy`. Config: `config/deploy.yml`, `.kamal/secrets`, `Dockerfile`.

- The image contains everything the viewer serves: `design-project/`, `design-system/` and `comparisons/` (reports and screenshots). Comparisons run locally (they need Playwright and the live site), so commit the regenerated `comparisons/` folder to publish it.
- Decisions made on the deployed site live on the `dsreview_data` volume (`DATA_DIR=/app/data`, under `compare/`), not in the image, so deploys keep them. `npm run pull-decisions` copies them into the local `comparisons/<id>/decisions.json`. It refuses to overwrite different local decisions unless you pass `--force`.
- `/up` is the unauthenticated health check. Everything else asks for basic auth: `eezy` / `eezy` (set in `config/deploy.yml`).

**First deploy (once):**

1. Point the DNS `A` record for `dsreview.daltonrowe.com` at `162.55.211.252`.
2. Push the repo to `github.com/daltonrowe/dsreview`.
3. Repository secrets: `SSH_PRIVATE_KEY` (the shared `dcloudbox_ci` key) and `NOTIFY_WEBHOOK_URL`. Check them with `gh secret list --repo daltonrowe/dsreview`.
4. From the laptop: `export KAMAL_REGISTRY_PASSWORD=$(gh auth token)`, then `bin/kamal setup`. The token needs `write:packages` (`gh auth refresh -s write:packages`).
5. Link the ghcr package to the repo in its package settings, and keep it private.

**Operations:** `bin/kamal logs`, `bin/kamal shell`, `bin/kamal app details`, `bin/kamal rollback <version>`, `bin/kamal lock release`. Any server command needs `KAMAL_REGISTRY_PASSWORD` exported first.
