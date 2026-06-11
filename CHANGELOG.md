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

Every command that mutates governed config is **dry-run by default**. To actually write, pass
`--apply`. Each write also takes an automatic snapshot first, so it is reversible with `rollback`.

> **Off-ramp (2026-06-09):** the `CLAUDE_MGR_ENABLE_WRITES=1` second factor is **no longer
> required** — `--apply` alone now writes. The env var is now an explicit **opt-out lock**: set
> `CLAUDE_MGR_ENABLE_WRITES=0` to hard-disable all governed writes (e.g. in CI); setting it to `1`
> still works (back-compat). See the off-ramp note below for the evidence and migration.

### Added — Phase 5 (MCP server, P5.U6 — 2026-06-11)

- **MCP server** (`node src/mcp/server.mjs`) — exposes the read-only view to Claude Code as a
  Model Context Protocol server over **stdio**: exactly 4 tools, `claude_mgr_inventory` /
  `claude_mgr_health` / `claude_mgr_conflicts` / `claude_mgr_doctor` (passive checks only —
  active probes stay a human opt-in). Each tool returns the same `version:1` JSON envelope the
  CLI prints (secret redaction included). A separate process role, NOT a CLI subcommand;
  register with `claude mcp add claude-mgr -- node <abs path>/src/mcp/server.mjs`. Write
  commands are deliberately NOT exposed as tools.
- **FIRST runtime npm dependency** (owner-sanctioned 2026-06-10, an explicit exception to the
  zero-dependency line): the official `@modelcontextprotocol/sdk`, **exact-pinned at `1.29.0`**
  (no `^`/`~`) with `package-lock.json` committed. Only the stdio-transport server entry points
  are imported — never an HTTP/SSE transport. **Migration note:** running the MCP server (and
  now the full test suite) requires `npm install` once; the CLI itself still runs without it.
  claude-mgr's own code remains machine-enforced zero-network (`selftest --boundary`); see
  `docs/threat-model.md` §5.10 for the supply-chain carve-out.

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

### Changed — `CLAUDE_MGR_ENABLE_WRITES` relaxed to an opt-out lock (off-ramp EXERCISED 2026-06-09)

The Phase-3 two-factor write gate has been **relaxed**. `--apply` alone now enables a governed
write; `CLAUDE_MGR_ENABLE_WRITES` is **no longer required**. It is now an explicit **opt-out
lock**: set `CLAUDE_MGR_ENABLE_WRITES=0` to hard-disable all governed writes (the refusal exits 3
with `writes-disabled-env`); any other value — unset, `1` (back-compat), … — allows writes when
`--apply` is present. Dry-run stays the default and **`--apply` is never removed.**

This was the planned evidence-driven off-ramp, exercised after a final review on **2026-06-09**
with ALL conditions met:

- **(a)** a real governed-write track record with **zero incidents** — 6 reversible `--apply`
  round-trips (single-file agent + command, a skill-directory recursive delete, and a multi-op
  cascade with the `--force` refusal proven), each verified byte-identical-reversible;
- **(b)** the schema-fingerprint canary survived a Claude Code version change with no write
  regression (CC 2.1.160 → 2.1.168), and was re-baselined again for the **2.1.170** binary now on
  disk with the tool healthy (release-gate green, `doctor` 0 errors, 2539 tests / 0 fail);
- **(c)** the not-before floor (2026-06-10, shortened by the owner from the original 2026-07-07)
  — the owner elected to run the final review one day early, on 2026-06-09.

**Migration / back-compat:**

- Scripts that already set `CLAUDE_MGR_ENABLE_WRITES=1` continue to work **unchanged**.
- ⚠ Scripts or CI that relied on an **unset** variable to BLOCK writes must now set
  `CLAUDE_MGR_ENABLE_WRITES=0` to keep that lock — under the relaxed gate, an unset variable plus
  `--apply` now writes.

This is the relaxation of the env-var second factor only — **not** a removal of the `--apply`
gate, which stays, nor of dry-run-by-default, which stays.

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
