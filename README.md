# Design System Review

Tooling for turning the exported Claude design project (`design-project/`) into a manageable design system.

## Setup

```bash
npm install        # also downloads headless Chromium for screenshots
npm start          # review viewer at http://localhost:4321 (opens browser)
npm run serve      # same, without opening a browser
```

The server requires HTTP basic auth: `eezy` / `eezy` (override with `REVIEW_USER` / `REVIEW_PASS`).

## Layout

| Path | What |
|---|---|
| `design-project/` | The exported design project (`*.dc.html` live pages, `Vecteezy *.html` standalone exports) |
| `design-system/` | Target design-system tokens (Apollo; `tokens.json` is the source, `tokens.css` and `tokens.md` are generated views), pulled from the Design System artifact |
| `tools/server.mjs` | Express server: viewer, design pages, survey data, decisions API |
| `tools/viewer/` | Viewer UI: home, survey review, live page viewer |
| `tools/survey.mjs` | Token survey generator |
| `tools/dc.mjs` | Screenshot CLI |
| `tools/lib/` | Shared code: `render.mjs` (Playwright), `bridge.js` (in-page helpers + token presets), `source.mjs` (element → source line) |
| `surveys/` | `captures.json` (page states to scan) and one folder per survey |
| `analysis/components/` | Suggested Components output (`tools/components.mjs`) |
| `.claude/skills/` | `view-design`, `token-survey`: how Claude Code uses the tools |

## Viewer

- **Home** (`/`): surveys with progress, and every page.
- **Survey** (`/survey.html?id=radius`): sections (S1, S2…) per distinct value. In each section, usages are numbered #1… and each one shows a screenshot, the authored declaration (inline, CSS rule, or inherited, plus any `var(--token)`), its component, the page state, a **Usage** button (opens the live page in a popover; ⌘-click for a new tab), a source link (`file:line` opens VS Code), the **nearest design-system token** (or an exact match), and **Keep / Round / Exclude** buttons. **Round** records the token picked in the Nearest dropdown. **Preview** (and the **Usage** popover) shows the page with a **Round to** bar: Original plus each nearest token, applied live to the element. Pick with a click or `0`–`3`, toggle with `t`, then use **Round to <token>** to save it. Each usage is badged **On-token** (its value equals a design-system token value) or **Off-token**. You can filter All / Decided / Undecided / Excluded (All hides excluded), by page state or text, hide on-token usages, set a decision for a whole section, and export to `.md` or `.json`.
  Keys: `j`/`k` move, `1` keep, `2` round, `3` exclude, `0` clear, `p` preview, `o` usage popover, `space` zoom, `/` search.
- **Suggested Tokens** (bottom of each survey): re-values the *existing* tokens to best fit non-excluded usage (same names, same count, same order; optimal weighted 1-D k-medians). It shows each token's current → proposed value, what it absorbs, and the fit before → after (exact matches, average rounding). For colors and shadows, which aren't scales, it shows how usage spreads over the existing tokens and lists unused ones.
- **Suggested Components** (home page, collapsed): look-alike elements (kind, size, shape, fill, border, text style) that recur across the redesign, with screenshot, uses/pages, visual variants and related design-system components. Generate with `node tools/components.mjs` → `analysis/components/`.
- **Page viewer** (`/view.html?page=…`): the live page with prop controls, internal state, and width. When opened from a usage, it applies that usage's state and marks the element. **Mark** chooses Border (dashed outline), Highlight (tinted fill) or None; `m` cycles through them and the choice is remembered.

## Token surveys

```bash
node tools/survey.mjs presets                          # available token types
node tools/survey.mjs new colors --preset text-color   # creates surveys/colors/spec.json
node tools/survey.mjs run colors                       # scans all states in surveys/captures.json
```

Decisions are saved to `surveys/<id>/decisions.json`. Re-running a survey keeps them, because item ids are stable. Screenshots (`surveys/*/shots/`) are gitignored and regenerated on each run.

## Screenshots: `tools/dc.mjs`

```bash
node tools/dc.mjs list                                   # pages + props (variants)
node tools/dc.mjs inspect pricing --props theme=dark     # components, state, controls in that state
node tools/dc.mjs shot pricing --props theme=dark --component faq
node tools/dc.mjs shot "ai magic" --state active=explore
node tools/dc.mjs matrix "log in" --vary leftPanel
node tools/dc.mjs help
```

**Props** are the designer-exposed variants. **State** is a page's internal view state. A **component** is any element with `data-screen-label`. **`--do`** runs interactions (click, hover, fill, and so on).
