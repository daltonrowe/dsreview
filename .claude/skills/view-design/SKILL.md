---
name: view-design
description: View and screenshot pages, components and states from /design-project (the exported Claude design project). Use whenever you need to see what a design looks like — a page, a [data-screen-label] component, a tweak/prop variant (theme, layout, version options), an internal app view (e.g. AI Magic's explore/search views), or an interaction state (hover, open menu, modal) — or to compare variants side by side.
---

# Viewing the design project

All rendering goes through `tools/dc.mjs` (Playwright + headless Chromium; it serves the
repo itself, so no dev server is needed). Run from the repo root. It prints the PNG paths;
**Read each PNG to actually see it.** Screenshots land in `screenshots/` (gitignored).

## Vocabulary
- **Page**: a file in `design-project/`. `*.dc.html` are live design-canvas pages;
  `Vecteezy *.html` are large standalone exports (no props/state control, screenshot only).
- **Props (tweaks)**: designer-facing variant switches declared per page (`theme`, `layout`,
  `showPageAction`, `leftPanel`, ...). Set with `--props`.
- **Internal state**: the page's runtime state, e.g. AI Magic `active` (`aisearch`, `search`,
  `explore`, `collections`, `alerts`, `airesults`) and `aiHome`. Set with `--state`.
- **Component**: any element with `data-screen-label="..."`. Crop with `--component`.
- **Interaction state**: hover/click/type results. Reach with `--do` steps.

## Workflow
1. Discover: `node tools/dc.mjs list` (all pages + props/options, no browser, fast).
2. Inspect a state: `node tools/dc.mjs inspect <page> [--props ...] [--state ...] [--do ...]`
   → current props, internal state keys, components visible *in that state* with sizes,
   and the visible clickable controls (to build `--do click:` selectors).
3. Shoot:
   ```bash
   node tools/dc.mjs shot pricing                                   # viewport, defaults
   node tools/dc.mjs shot pricing --props theme=dark,layout="option 2" --component faq
   node tools/dc.mjs shot "ai magic" --state active=explore
   node tools/dc.mjs shot "ai magic" --do 'click:role=link[name="Explore"]' --do 'click:text="Vectors"'
   node tools/dc.mjs shot checkout --all-components                 # one PNG per component
   node tools/dc.mjs shot "settings directions" --full              # whole canvas
   node tools/dc.mjs matrix "log in" --vary leftPanel --props mode=log   # one PNG per option
   node tools/dc.mjs matrix pricing --vary theme,layout --component "Pricing V4"
   ```
   `node tools/dc.mjs help` has every flag.

## Tips
- Page names are fuzzy (`pricing`, `ai magic`, `log in v1`); prop values match
  case-insensitively and by substring (`theme=dark`, `layout="option 2"`).
- Prefer `--component` crops over `--full`: full pages can be 5000px+ tall and get heavily
  downscaled when you view them. Use `--scale 2` for fine detail on small components.
- Components only exist in states that render them. If `--component` says "not found",
  run `inspect` with the same props/state to see what's present, then open it via
  `--props`, `--state` or `--do`.
- `text=Foo` is a substring match; use `text="Foo"` (quoted) or `role=button[name="Foo"]`
  for exact. `label=<screen label>` targets a component in `--do` steps.
- Animations are disabled and reduced-motion is on, so shots are deterministic.
- Lines after the PNG paths (`[n page issue(s)]`) are real 404s/JS errors in the design;
  harmless template noise is already filtered out.
- If Chromium is missing: `npx playwright install chromium`.
