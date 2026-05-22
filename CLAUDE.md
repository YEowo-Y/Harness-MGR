# claude-mgr — project context for Claude Code sessions

A **read-mostly governance CLI** for the user's large Claude Code harness (inventory / conflicts / `config show-effective` / doctor / snapshot-rollback / remove-update). Zero-runtime-dependency Node ESM, Windows-hardened, **dry-run-by-default**, lives OUTSIDE Claude Code's loader. The user is a non-coder ("vibe coding") — reply in Chinese.

## Authoritative references (read these before building)
- **Full plan (1624 lines):** `C:\Users\alice\.claude\plans\claude-mgr-v5.md` — the single source of truth (decided-items table + verified loader rules + 67-unit schedule + test catalog).
- **Session memory / decisions / learnings:** `C:\Users\alice\.claude\projects\C--Users-alice\memory\MEMORY.md`.

## Build cursor (as of 2026-05-22)
- ✅ **P1.U1** scaffold · **P1.U2–U5** core lib (Diagnostic/Source/Plan/Result + DiagnosticBag; `paths.mjs`+`assertWritable` [fail-closed, symlink-escape denied]; `retry`; `safe-spawn` [mandatory argv schema, deny-by-default]; async `reexport` shim) · **P1.U6** fixtures (incl. redacted `real-snapshot/`) · **P1.U7** discovery/components (split into `frontmatter.mjs` [pure, null-proto, never-throws YAML-frontmatter parser] + `components.mjs` [FLAT skill/agent/command walk → `ComponentRecord[]`+`Diagnostic[]`]; reviewer APPROVE after HIGH-1 null-proto hardening + HIGH-2 rejected with evidence; namespaced-command recursion deferred to a unit with a nested fixture) · **P1.U8** discovery/plugins+marketplaces (`read-json.mjs` shared never-throws JSON reader; `plugins.mjs` installed_plugins.json→`PluginRecord[]` [schema-version-first; `cachePresent` is a FACT, not a judgment]; `marketplaces.mjs` known_marketplaces.json→`MarketplaceRecord[]` [root-relative `onDisk`, not trusting machine-specific `installLocation`]; new PII-redacted `plugins-groundtruth/` fixture = committed 13-installed / 11-missing-cache / 2-onDisk oracle; reviewer APPROVE, 0 Blocker/High) · **P1.U9** discovery/settings+mcp (`settings.mjs` [discoverSettings→statusLine capture, discoverTopLevelDirs→19-known-dir classification, KNOWN_TOP_DIRS exported]; `mcp.mjs` [discoverMcp project+user scope, transport stdio/http/unknown, SECRET-SAFE envKeys=key-names-only]; `settings-mcp/` fixture incl. MUSTNOTLEAK sentinel; reviewer APPROVE after LOW-1/LOW-2/MEDIUM-1/MEDIUM-2 adopted). All committed, **143 tests pass / 0 fail** on Node v24.14.0.
- ▶ **NEXT: P1.U10–U16** — scan.mjs orchestrator (integrates all discovery into one scan) → analysis (`conflicts` [agents actionable; bundled-shadows-user=warn] + `load-order` [computed resolver, **2.1.x version-guard**, Phase-1 emits `likelyWinner`] + settings-merge) → `cli.mjs` (6 read subcommands) → `selftest/{boundary,invariants,lint}` → `claude-mgr.ps1` + dogfood install (`cmd /c mklink /D`) → tag **`phase-1-stable`**.
- ⚠️ Open follow-up: **M2** — `reexport.mjs` missing-hooks-lib should surface a `Diagnostic` (not a raw loader error). **REASSIGNED to U15** (CLI boundary): U7's `components.mjs` is a pure module (takes a `rootDir`, no `reexport` import), so live-config-dir resolution + the missing-lib diagnostic belong where the real `~/.claude` is resolved.

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
- **Subagents may TIME OUT on long tasks here — but do NOT disable/abandon delegation.** The DoD's SEPARATE `code-reviewer` and `executor` passes MUST stay delegated (never self-author + self-approve — that gate is the whole point). Mitigate timeouts by scoping each delegated task SMALL (one sub-unit at a time) and **resuming/retrying** a timed-out agent; fall back to a direct Edit ONLY for a tiny fix a reviewer has already prescribed.
- The tool resolves the governed `~/.claude/` and `~/.claude/hooks/lib` via the home dir — **independent of cwd**, so develop here, not inside `~/.claude/`.
- GitHub remote: `exampleuser-jpg/claude-mgr` (PRIVATE), `main` → `origin/main`.
