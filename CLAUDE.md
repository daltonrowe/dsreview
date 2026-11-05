This is a Repo to help turn a super large Claude design project into a manageable Design System.

The exported project lives at /design-project.
Tools to viewing and review should like in /tools.

## Viewing designs
To see any page, component or state from /design-project, use `node tools/dc.mjs` (see the `view-design` skill in `.claude/skills/view-design/SKILL.md`). Start with `node tools/dc.mjs list`, then `inspect`, then `shot`/`matrix`, and Read the PNGs it prints. Screenshots go to /screenshots.


## Token surveys
The review viewer (`npm start`, Express in `tools/server.mjs`, UI in `tools/viewer/`) shows token surveys from `/surveys`. Create/run them with `node tools/survey.mjs` (see `.claude/skills/token-survey/SKILL.md`). Reviewer decisions are in `surveys/<id>/decisions.json`.

Target design-system tokens live in `/design-system/tokens.json` (pulled from the Design System artifact https://claude.ai/artifact/SrrkzHfHSLFpfN5gAZ5xoC; `tokens.css`/`tokens.md` are its generated views).
