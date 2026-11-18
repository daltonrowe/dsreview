This repo compares a super large Claude design project with the live site, to find and review visual differences.

The exported project lives at /design-project.
Tools to viewing and review should like in /tools.

## Viewing designs
To see any page, component or state from /design-project, use `node tools/dc.mjs` (see the `view-design` skill in `.claude/skills/view-design/SKILL.md`). Start with `node tools/dc.mjs list`, then `inspect`, then `shot`/`matrix`, and Read the PNGs it prints. Screenshots go to /screenshots.


## Comparing with the live site
The project's job is to compare the design project with the live site (https://ao-4276-redesign-rollup.xeezy.com; `?skip=1` bypasses the OAuth wall) for visual differences: alignment, size, color, typography, shape and spacing. On the `screenshot-compare` branch the comparison reads screenshots only (pixels, from a designer's point of view; no DOM/CSS). Use `node tools/compare.mjs` (see `.claude/skills/compare-live/SKILL.md`). Pairs live in `comparisons/pairs.json`, reports in `comparisons/<id>/`, reviewer decisions in `comparisons/<id>/decisions.json`. The review viewer is `npm start` (Express in `tools/server.mjs`, UI in `tools/viewer/`).

Design-system tokens live in `/design-system/tokens.json` (pulled from the Design System artifact https://claude.ai/artifact/SrrkzHfHSLFpfN5gAZ5xoC; `tokens.css`/`tokens.md` are its generated views).
