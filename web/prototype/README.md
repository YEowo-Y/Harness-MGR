# claude-mgr web UI — prototype

A standalone, responsive, bilingual (中/EN) visual prototype of the planned **write-enabled,
real-time web UI** for claude-mgr. It demonstrates the visual + interaction direction — it is **not**
the real module and uses **mock data** (no engine wired in yet).

Full design rationale, tokens, architecture, and the phased build plan live in
`docs/internal/web-ui-design.md`.

## What it shows

- **Dashboard** — KPI cards (animated count-up + trend deltas), a cross-target compare strip, a
  filterable skills table, and a dry-run write flow (Disable a skill → preview the config diff →
  confirm → snapshot id → rollback).
- **Compare** — per-kind stacked bars (claude-only · both · codex-only) + a divergent-items list.
- **Doctor** — a health-score arc, severity counts, and a checks list.
- Sticky top bar, 中/EN language toggle, sliding nav indicator, dark-on-cream Anthropic brand,
  GSAP motion (respects `prefers-reduced-motion`).

## Run it

```sh
# any static server works; e.g. Python:
python -m http.server 5500 --directory web/prototype
# then open http://localhost:5500
```

Or just open `index.html` directly in a browser. (Inside Claude Code, it's also wired in
`.claude/launch.json` as the `prototype` server for the preview panel.)

It loads GSAP, Tabler Icons, and Google Fonts from public CDNs, so it needs network access on first
load. No build step, no dependencies to install.

## Status

Mock data + illustrative write flow. The real build wires these screens to the engine's JSON
(`inventory` / `compare` / `doctor` / `config show-effective` / `conflicts`) and the gated
snapshot/rollback ops. See `docs/internal/web-ui-design.md` §6–7.
