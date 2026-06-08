# Changelog

All notable changes to **claude-mgr** — a read-mostly governance CLI for a Claude Code
(`~/.claude`) harness. The format follows [Keep a Changelog](https://keepachangelog.com/).
This tool is pre-1.0 and ships in phases; releases are tracked by the project's stability
**tags** (`phase-1-stable`, `phase-2-stable`, …) rather than SemVer numbers.

claude-mgr is a **zero-runtime-dependency** Node ESM tool that lives OUTSIDE Claude Code's
loader. It is **dry-run by default**, Windows-hardened, and makes **no network calls of its
own**. Every governed-config write is gated, auto-snapshotted, and reversible.

---

## [Unreleased] — targeting `phase-4b-stable`

> The `phase-3-beta`, `phase-4a`, and `phase-4b-stable` tags are cut after the project's
> stability gate; everything below is implemented, tested, and dogfooded, but not yet behind
> a cut stable tag.

### The write gate (read this before any `--apply`)

Every command that mutates governed config is **dry-run by default**. To actually write you
must supply BOTH factors:

1. the `--apply` flag, and
2. the environment variable `CLAUDE_MGR_ENABLE_WRITES=1`.

A stray `--apply` alone writes nothing. Each write also takes an automatic snapshot first, so
it is reversible with `rollback`.

### Added — Phase 4 (remove / update / mcp / diff / completion / ndjson)

- **`remove <kind>:<name>`** — delete one user-level component. `agent:` / `command:` remove a
  single `.md` file; `skill:` removes the skill directory. Auto-snapshots before deleting, so
  every removal is reversible with `rollback`.
- **`remove <kind>:<name> --cascade [--force]`** — also remove the components that DEPEND on the
  target, computed from a dependency graph of cross-references (a skill that names an agent, a
  skill pipeline that names another skill, …). Always prints a preview first; `--force` is
  required when the dependent set is non-empty.
- **`update <plugin> [--lock-version <ver>]`** — delegate a plugin update to the `claude` CLI
  (claude-mgr itself makes no network calls). Snapshots `installed_plugins.json` first and
  reports honest partial-reversibility caveats: the marketplace fetch, the `plugins/cache/**`
  mutation, and the required Claude Code restart are claude's, OUTSIDE claude-mgr's snapshot
  scope. `--lock-version` is reported-unsupported (the underlying CLI cannot target a version).
- **`mcp remove <name> [--scope local|user|project]`** — delegate an MCP-server removal to the
  `claude` CLI. Snapshots `.mcp.json` first. `--scope project` is reversible by claude-mgr;
  `user` / `local` scope lives in `~/.claude.json` (outside the snapshot) — reported as a caveat.
- **`config diff <a> <b> [--context N]`** — a unified line-diff of two files: a minimal Myers
  shortest-edit-script engine, git-style `@@` hunks, also available as structured JSON.
- **`completion bash|powershell`** — emit a shell tab-completion script. The baked-in command
  and flag word lists are kept in sync with the real CLI by a drift-guard test.
- **`--format ndjson`** — line-delimited streaming output (one `result` line, then one
  `diagnostic` line each) for TUI / programmatic consumers, alongside `table` / `json` / `quiet`.

### Added — Phase 3 (the write machinery: snapshot / rollback / recover / lock)

- **`snapshot [--reason <msg>] [--include-auth] [--apply]`** — capture a secret-filtered tar
  archive of the governed surface. `snapshot list`, `snapshot gc [--keep N] [--older-than <dur>]`,
  `snapshot pin <id>`, and `snapshot unpin <id>` manage retention.
- **`rollback <id> [--force] [--apply]`** — restore a snapshot's bytes back onto the live tree.
- **`recover <id> [--mark-failed|--resume|--rollback|--from-manifest] [--force] [--apply]`** —
  crash recovery for an interrupted apply (forward-resume, or restore from the snapshot/manifest
  even when the journal is corrupt).
- **`lock [--break-lock --apply]`** — inspect or break a stale apply lock (with a holder/age
  preview before breaking).

### Security

- All `claude` delegations (`update`, `mcp remove`) go through a deny-by-default safe-spawn with
  an explicit argv schema: no shell, no metacharacters, allow-listed flags only. Injection
  attempts fail closed (covered by dedicated no-injection tests).
- `--cascade` deletions are bounded, preview-gated, and snapshot-reversible under ONE snapshot.
- A fail-closed write gate (`assertWritable`) denies symlink-escape and any write outside the
  governed surface; snapshots exclude secrets (credential/key files by name AND content sniff);
  the audit log is metadata-only (no file contents, no secrets).
- A post-apply invariant (#44) pins that `doctor` still runs (exit ≤ 1, never a crash) after
  every write path; a full-command smoke pins that every command runs without an internal crash.

### Deprecated — `CLAUDE_MGR_ENABLE_WRITES` second factor (evidence-driven off-ramp)

The `CLAUDE_MGR_ENABLE_WRITES=1` requirement is a deliberate belt-and-suspenders SECOND FACTOR
for the beta period — it makes an accidental governed write essentially impossible.

**Off-ramp — EVIDENCE-driven, not calendar-driven.** The env-var requirement MAY be relaxed to
**optional** (leaving `--apply` as the primary, still-explicit write gate) once — and only once —
ALL of these hold:

- a clean stability review confirms a real governed-write track record with **zero write
  incidents** — actual `--apply` round-trips used and verified reversible, not just dry-runs;
- the schema-fingerprint canary has survived at least one Claude Code version change with no
  write regression; and
- a **not-before floor** of **2026-06-10** has passed (shortened from the original 2026-07-07 by
  the owner on 2026-06-08, given strong (a)+(b) evidence: 6 reversible `--apply` round-trips with
  zero incidents, and the schema-canary surviving the CC 2.1.160 → 2.1.168 version change).

As of 2026-06-08 conditions (a) and (b) are MET; only the (c) floor (now 2026-06-10) remains, so
the off-ramp review can happen on 2026-06-10. If the evidence still holds then, the env-var factor
may be relaxed; if not, the gate simply stays in force — there is NO automatic relaxation.

- **Until the bar is met:** `CLAUDE_MGR_ENABLE_WRITES=1` stays **mandatory** for any governed
  write. Nothing changes.
- **When relaxed:** the env var becomes optional; the exact change is recorded in a future
  release note, and the env var continues to WORK (and to force-enable writes) for at least one
  further release, so existing scripts and CI never break without warning.

This is a planned, conditional, reversible relaxation — **not** a removal of the `--apply` gate,
which stays.

---

## [phase-2-stable] — doctor / drift / audit / permissions

### Added

- **`doctor [--active-probes]`** — 25 health checks over the harness. Passive by default; the
  active probes (which spawn external tools and briefly self-test the loader by writing and
  immediately self-removing a temporary file in the real `agents/` directory) are opt-in.
- **`drift [--update]`** — a hash-based fingerprint of the governed surface compared against a
  saved baseline (`--update` rewrites the baseline).
- **`audit [--since <dur>]`** — view the apply audit log.
- **`permissions [--audit]`** — list the effective permission rules; `--audit` flags overbroad
  `allow` wildcards.
- JSONC-tolerant settings parsing (comments + trailing commas); the `--format ndjson` output mode.

### Security

- Secret-safe output: settings `env` values, tokens embedded in hook/statusLine command strings,
  and MCP server args are redacted before display in any format.

---

## [phase-1-stable] — read CLI + self-test gates

### Added

- **`inventory [--type ...] [--detail] [--by-category]`** — counts and listings of skills /
  agents / commands / plugins / marketplaces / MCP servers, plus the statusLine and the
  top-level directory layout.
- **`conflicts`** — shadowing / load-order conflicts across tiers (verified loader rules).
- **`orphans`** — files that don't belong to any known component.
- **`config show-effective [--key K]`** — the merged effective settings across layers.
- **`hooks`** — the resolved hook commands.
- **`selftest [--lint|--invariants|--boundary|--all|--release-gate]`** — internal safety gates
  (SLOC lint, architecture invariants, the write-boundary allowlist, the full release gate).

### Security

- Zero runtime dependencies; no network I/O. The discovery layer reports facts (e.g. MCP env
  KEY NAMES only, never values); analysis judges them; nothing is executed.
