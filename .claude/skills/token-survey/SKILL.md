---
name: token-survey
description: Create, run, and read design-token surveys (colors, radius, type, spacing, shadows…) over /design-project, and act on the Keep/Exclude/Remove decisions recorded in the review viewer. Use when asked to survey a token type, add page states to a survey, regenerate one, or compile/act on survey decisions.
---

# Token surveys

A survey = one token type (a *preset*). Sections = distinct rendered values (numbered S1, S2…).
Items = distinct usages, i.e. one template element in one component file with that value,
numbered #1… within their section (referenced as `S3.7`). Each item has a screenshot, the page state
it was found in, its authored declaration (inline / CSS rule / inherited, with any `var(--token)`),
and its source location.

## Commands
```bash
node tools/survey.mjs presets                         # radius, text-color, background, gradient, border-color,
                                                      # border-width, shadow, font-size, font-weight, line-height,
                                                      # letter-spacing, font-family, typography, gap, padding, opacity
node tools/survey.mjs new <id> --preset <preset> [--title "..."]
node tools/survey.mjs run <id> [--only "<capture label substring>"]   # ~1–3 min for all states
npm start                                             # viewer at http://localhost:4321
```

## Files
- `surveys/captures.json`: default page states scanned (page + props/state/do, same as `tools/dc.mjs`).
  Add states here (e.g. a modal opened via `do`) to widen coverage. A spec can set `"captures": [...]` instead of `"default"`.
- `surveys/<id>/spec.json`: title, preset, captures.
- `surveys/<id>/survey.json`: generated output. Never hand-edit; re-run instead.
- `surveys/<id>/decisions.json`: `{ itemId: { decision: keep|round|exclude|remove, round?: { to: <token>, value, css }, note, at } }`, written by the viewer.
  `round` means: replace this usage's value with design-system token `round.to`.
- `design-system/tokens.json`: the target tokens (Apollo, from the Design System artifact). The viewer matches each section value to its nearest token (`tools/viewer/tokens.js`).
  Regenerating keeps it (item ids are stable hashes of preset + component + template element + value).
- `surveys/<id>/shots/<itemId>.png`: per-usage screenshots (gitignored, regenerable).
- Compiled list: `GET /api/surveys/<id>/export.md` or `.json` (needs server), or join survey.json + decisions.json yourself.

## Notes
- Presets are implemented in `tools/lib/bridge.js` (`PRESETS`); add a new token type there plus its title
  in `tools/survey.mjs`, and preview in `tools/viewer/common.js`.
- Only `.dc.html` pages are surveyed; `Vecteezy *.html` exports and `AI Magic Export` (a near-duplicate of AI Magic) are not in the default captures.
- Only elements rendered and visible in a captured state are found. Hover, focus, and modals need captures with `do` steps.
- To view any item's state yourself, use the `view-design` skill (`tools/dc.mjs`) with the capture's props/state/do.

- The survey page's **Suggested Tokens** panel (logic in `tools/viewer/survey.html` `computeSuggest`, names from `suggestName` in `tools/viewer/tokens.js`) proposes new tokens from non-excluded/non-removed usages; mirror that logic if asked to compile suggestions outside the UI.
- Color surveys should be created with `--themes light,dark` so each page state is captured in both modes (dark switching: page `theme` prop, else `dark` map in `surveys/captures.json`).
- Once deployed, reviewers' decisions live on the server. Run `npm run pull-decisions` (add `--force` to replace differing local files) before reading `surveys/*/decisions.json`.
- After (re)generating a survey, run `node tools/group.mjs <id>` (or `--all`) to rebuild its groups (`surveys/<id>/groups.json`), which the viewer shows by default. Group rules are in `tools/group.mjs`. Check new groups by eye before trusting them: contact sheets of each group's screenshots catch over-merges quickly.
