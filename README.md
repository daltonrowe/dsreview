# Design vs Live

Tooling for comparing the exported Claude design project (`design-project/`) with the live site
(https://ao-4276-redesign-rollup.xeezy.com) and reviewing the visual differences from a designer's point
of view: screenshots only, no code or markup.

## Setup

```bash
npm install
npm run browsers   # headless Chromium for screenshots and comparisons (once)
npm start          # review viewer at http://localhost:4321 (opens browser)
npm run serve      # same, without opening a browser
npm test           # server + screenshot-analysis tests
```

The server requires HTTP basic auth: `eezy` / `eezy` (override with `REVIEW_USER` / `REVIEW_PASS`).

## Layout

| Path | What |
|---|---|
| `design-project/` | The exported design project (`*.dc.html` live pages, `Vecteezy *.html` standalone exports) |
| `design-system/` | Target design-system tokens (`tokens.json` source; `tokens.css` / `tokens.md` generated views) |
| `comparisons/pairs.json` | Which design page state is compared with which live URL |
| `comparisons/<id>/`, `comparisons/<id>--dark/` | One comparison (light, dark): its `report.json`, `design.jpg`, `live.jpg`, reviewer `decisions.json` (and a gitignored `snapshot.json`: the elements found in each screenshot) |
| `tools/compare.mjs` | Comparison CLI: run, show, add, screenshot live pages |
| `tools/dc.mjs` | Design-project screenshot CLI |
| `tools/app.mjs`, `tools/server.mjs` | Express app (viewer, reports, decisions API, live collaboration) and its launcher |
| `tools/pull-decisions.mjs` | Copies decisions from the deployed site into local `comparisons/*/decisions.json` |
| `tools/viewer/` | Viewer UI: home, comparison review, design page viewer |
| `tools/lib/` | `render.mjs` (design pages in Playwright), `live.mjs` (live pages: consent wall, ?skip=1, full-height capture), `vision.mjs` (elements from pixels), `pixeldiff.mjs` (pairing + findings), `pairs.mjs` (pairs × themes), `bridge.js` (design runtime helpers for the page viewer) |
| `.claude/skills/` | `view-design`, `compare-live`: how Claude Code uses the tools |

## How a comparison works

This branch (`screenshot-compare`) compares **screenshots only**, from a designer's point of view. The
browser renders each page; after that, nothing reads the DOM or CSS: every finding comes from pixels.

1. Every pair runs twice, **light** and **dark** (`<id>--dark`). Dark sets the design page's `theme`
   prop and makes the browser prefer a dark color scheme, which the live site follows. A pair can set
   `"themes": ["light"]` or a `"dark": { "design": {…}, "live": {…} }` override; pages without a `theme`
   prop get no dark run.
2. Both pages render in headless Chromium at the same width (1440). The live site gets `?skip=1`, its
   consent manager and ad/analytics scripts are blocked, and the Rails profiler badge is hidden. Animations,
   transitions and scrollbars are turned off on both sides. The viewport grows to the page's full height
   (capped at `maxHeight`, default 3000px) and each side is captured as one screenshot. A live page that
   answers with an error (4xx/5xx) stops the run instead of being compared.
3. **Seeing** (`tools/lib/vision.mjs`): in each screenshot, pixels that differ visibly from their neighbour
   are edges; edges within ~6px join into one element. Each element gets a tight box and a kind:
   **text** (a run of strokes), **icon** (small and square), **panel** (an outline around a flat fill:
   buttons, chips, inputs, cards, the masthead), **divider**, **picture** (an outline around a busy,
   many-colored inside; what's inside a picture is its content and is ignored) or **shape**. It also gets
   the color behind it, its own (ink) color, how much ink it has, and a small grayscale thumbnail of its
   look. Panels get their fill, an estimated corner radius and their border.
4. **Pairing** (`tools/lib/pixeldiff.mjs`): distinctive elements that look alike on both sides (and are
   each other's best look-alike) become anchors; they say how far each part of the page moved. Every
   element then pairs with the best look-alike near where it's expected. Large flat things (a gradient
   placeholder in the design, a photo on live) also pair by size and place alone.
5. **Findings**, in a designer's terms: **typography** (text taller/shorter, heavier/lighter by ink,
   wider/narrower), **color** (text/icon color, panel fill, page background), **size** (panels, icons,
   pictures, dividers), **shape** (corner radius, border, a panel that lost its fill), **spacing** (gap to
   the next element below/right, content inset inside its panel), **alignment** (edges that line up
   anywhere on the page in the design and no longer do on live, e.g. the masthead's top and the first
   rail button; the element that moved is named), and **missing** / **extra** elements.

There's no hover/behavior check: a screenshot shows one state. To compare a hover or an open menu, add a
pair whose `design.do` / `live.do` steps put both pages in that state.

```bash
node tools/compare.mjs list
node tools/compare.mjs run                 # all pairs, light + dark; or: run home sign-up; --theme dark
node tools/compare.mjs show home --severity medium
node tools/compare.mjs add show --design "ai magic" --state active=... --live /vector-art/581241-slices-lime-summer-background
node tools/compare.mjs live /free-photos/dog --full --theme dark
```

Elements have no names (there's no markup to name them from), so findings are titled by kind and size
("Panel 1317×330", "Text 110×18") and located by position; the crops show what they are. Finding ids are
the category, kind and design position on a 16px grid, so they survive re-runs while the layout holds.

## Viewer

- **Home** (`/`): each comparison with design/live thumbnails, finding counts by severity and category, and
  decision progress. The design pages are listed below (collapsed) with links to the page viewer.
- **Comparison** (`/compare.html?id=home`): findings on the left, the two screenshots on the right.
  - **☀ Light / ☾ Dark** switches between the two versions of the comparison.
  - Views: **Side by side** (one scroll for both), **Overlay** (slider sets live opacity), **Difference**
    (identical pixels are black), **Swipe** (slider moves the split). The selected finding's boxes are the
    only ones drawn (magenta design, blue live); **Esc** clears the selection and outlines every finding
    shown, so you can click a box to pick one. Alignment findings draw green **guide
    lines** across the whole screenshot at the edge that should line up (one line in the design, one per
    element on live, so the gap shows), with the partner box dashed.
  - **Zoom**: hold **Z** and click to zoom in at that spot, **⌘ + Z + click** (Ctrl + Z + click elsewhere)
    to zoom out, or use − / Fit / + / 1:1.
  - **Elements** (`e`) outlines everything the analysis found in each screenshot, colored by kind
    (text red, icon purple, panel teal, picture dashed yellow, divider green); unpaired ones are tinted.
    Use it to check what the comparison saw.
  - Each finding shows design and live crops, the property rows (design → live, with swatches) and the
    decision buttons:
    **Keep** (a real difference) or **Ignore** (noise), plus a note (✎). **➜ Find** scrolls the screenshots to the difference and points at it with a big bouncing arrow on each side.
  - Filter by category (click; ⌘/shift-click for several), severity, decision status and text. **Set all
    shown…** decides every finding in the current filter. **Export** downloads Markdown (`.json` too).
  - Keys: `j`/`k` move, `1` keep, `2` ignore, `0` clear, `f` find (big arrow on the selected difference), `n` note, `m` cycle
    view, `[`/`]` slider, `Esc` clear selection (show all boxes), `e` elements, `/` search.
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
