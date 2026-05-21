# claude-mgr — project context for Claude Code sessions

A **read-mostly governance CLI** for the user's large Claude Code harness (inventory / conflicts / `config show-effective` / doctor / snapshot-rollback / remove-update). Zero-runtime-dependency Node ESM, Windows-hardened, **dry-run-by-default**, lives OUTSIDE Claude Code's loader. The user is a non-coder ("vibe coding") — reply in Chinese.

## Authoritative references (read these before building)
- **Full plan (1624 lines):** `C:\Users\alice\.claude\plans\claude-mgr-v5.md` — the single source of truth (decided-items table + verified loader rules + 67-unit schedule + test catalog).
- **Session memory / decisions / learnings:** `C:\Users\alice\.claude\projects\C--Users-alice\memory\MEMORY.md`.

## Build cursor (as of 2026-05-21)
- ✅ **P1.U1** scaffold · **P1.U2–U5** core lib (Diagnostic/Source/Plan/Result + DiagnosticBag; `paths.mjs`+`assertWritable` [fail-closed, symlink-escape denied]; `retry`; `safe-spawn` [mandatory argv schema, deny-by-default]; async `reexport` shim) · **P1.U6** fixtures (incl. redacted `real-snapshot/`). All committed (33 commits), **86 tests pass / 0 fail** on Node v24.14.0.
- ▶ **NEXT: P1.U7–U16** — discovery (components/marketplaces/plugins/settings/mcp/scan/orphan) → analysis (`conflicts` [agents actionable; bundled-shadows-user=warn] + `load-order` [computed resolver, **2.1.x version-guard**, Phase-1 emits `likelyWinner`] + settings-merge) → `cli.mjs` (6 read subcommands) → `selftest/{boundary,invariants,lint}` → `claude-mgr.ps1` + dogfood install (`cmd /c mklink /D`) → tag **`phase-1-stable`**.
- ⚠️ Open follow-up: **M2** — `reexport.mjs` missing-hooks-lib should surface a `Diagnostic` (not a raw loader error); fold into U7's CLI entry.

## Per-Unit Definition of Done (every work unit, in order)
1. **Regression** — full `node --test` green, no regressions.
2. **Code review** — a SEPARATE `code-reviewer` pass (never self-approve); fix Blocker/High before commit.
3. **Boundary** — edge cases covered (use the `test/fixtures/` corpus: broken / unicode-paths / long-paths / case-insensitive / …).
4. **Acceptance** — falsifiable criterion (golden-file oracle; "matches golden", never "exit 0").
5. **Git** — commit on green; **one file = one commit** (data fixtures may commit per-category); push.

## Environment gotchas (verified on this machine)
- Node **v24.14.0**; runner = `node --test` (zero deps). Run from the repo root.
- The **PowerShell tool is unreliable here** → use the **Bash tool with POSIX paths** (`/c/Dev/Projects/claude-mgr`).
- Windows **Developer Mode is ON** → the dogfood symlink uses `cmd /c mklink /D` (PowerShell `New-Item -SymbolicLink` fails).
- **Subagents TIME OUT on long tasks** in this env → keep delegated units small, or apply targeted Edits directly.
- The tool resolves the governed `~/.claude/` and `~/.claude/hooks/lib` via the home dir — **independent of cwd**, so develop here, not inside `~/.claude/`.
- GitHub remote: `exampleuser-jpg/claude-mgr` (PRIVATE), `main` → `origin/main`.
