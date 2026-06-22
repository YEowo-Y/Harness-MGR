# claude-mgr web UI — prototype

A standalone, responsive, bilingual (中/EN) visual prototype of the planned **write-enabled,
real-time web UI** for claude-mgr, in an **agent-workstation** style (sidebar shell + main panel +
right inspector — the Codex / Claude / Cherry Studio feel). It demonstrates the visual + interaction
direction — it is **not** the real module and uses **mock data** (no engine wired in yet).

Full design rationale, tokens, architecture, and the phased build plan live in
`docs/internal/web-ui-design.md`.

## What it shows

- **Dashboard** — KPI cards plus a **switchable component-kind view** (skill / agent / command / mcp /
  plugin), each kind colour- and icon-coded for at-a-glance scanning. Clicking any row opens a rich,
  **governance-first detail** in the right inspector.
- **Item detail (inspector)** — per kind: frontmatter / config → governance (*which file controls it*
  + precedence) → a loadability verdict → a faithful content preview (mcp env values **redacted**) →
  only the actions that are truly toggleable for that kind (mcp / plugin get enable/disable; agents
  and commands don't). Skills also get the 4-state visibility control.
- **Compare** — per-kind presence (claude-only · both · codex-only) + a divergent-items list.
- **Doctor** — a health-score read-out + a checks list. **Snapshots** — a read-only history view.
- Left sidebar (search, nav, claude/codex target switch, gate + theme + 中/EN toggles), light **and**
  dark themes, WCAG-checked contrast, and a dry-run write preview. Motion respects
  `prefers-reduced-motion`.

## Run it

```sh
# any static server works; e.g. Python:
python -m http.server 5500 --directory web/prototype
# then open http://localhost:5500/workstation.html
```

Or just open `workstation.html` directly in a browser. (Inside Claude Code, it's also wired in
`.claude/launch.json` as the `prototype` server for the preview panel — open `/workstation.html`.)

It loads GSAP, Tabler Icons, and Google Fonts from public CDNs, so it needs network access on first
load. No build step, no dependencies to install.

## Status

Mock data + illustrative write flow. The real build wires these screens to the engine's JSON
(`inventory` / `compare` / `doctor` / `config show-effective` / `conflicts`) and the gated
snapshot/rollback ops. See `docs/internal/web-ui-design.md` §6–7.
