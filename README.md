# claude-mgr

A read-mostly governance CLI for your Claude Code harness at `~/.claude`.

---

## 快速上手

**这是什么？**
`claude-mgr` 是一个命令行工具，用来查看和管理你 `~/.claude` 目录里的 Claude Code 配置（技能、代理、命令、插件、MCP 服务器、设置等）。它不属于 Claude Code 加载器，只在你手动运行时生效。

**怎么运行：**

```powershell
# Windows PowerShell
.\claude-mgr.ps1 <command> [flags]
```

```sh
# macOS / Linux / WSL
./claude-mgr.sh <command> [flags]
```

```sh
# 也可以直接用 Node（需要 Node >= 24）
node src/cli.mjs <command> [flags]
```

**最常用命令：**

| 命令 | 说明 |
|------|------|
| `inventory` | 统计技能/代理/命令/插件/MCP 服务器数量 |
| `doctor` | 运行 25 项健康检查，报告配置问题 |
| `health` | 一条命令汇总组件可加载性、最佳实践建议、钩子说明（只读） |
| `conflicts` | 查找加载顺序冲突（名字相同、互相遮蔽），并给出处置建议 |
| `config show-effective` | 显示合并后的生效设置（user < local） |
| `snapshot --apply` | 对 `~/.claude` 拍快照（写入需加 `--apply`） |
| `skill propose <名字> --from <文件>` | 为技能生成一份新提案（不动原 `SKILL.md`） |
| `skill accept <名字>` | 把提案落到真正的 `SKILL.md`（先自动拍快照，可回滚） |
| `drift` | 对比当前配置与上次快照基准，检测变化 |

**安全须知：**
所有写入命令默认只预览，不执行任何写操作。要真正写入，只需加 `--apply`。如果想在 CI 等场景里硬性禁用所有写入，设置环境变量 `CLAUDE_MGR_ENABLE_WRITES=0` 即可（此时写入会被拒绝）。

---

## Overview

`claude-mgr` is a zero-runtime-dependency Node ESM CLI that governs the
`~/.claude` directory used by Claude Code. It is designed for the owner of a
large Claude Code harness who wants visibility into what is installed and
confidence that writes are auditable and reversible.

Key properties:

- **Read-mostly**: all inspect commands are pure read-only; no files are
  modified unless a write command is explicitly invoked with `--apply`.
- **Dry-run by default**: every write command previews the operation and exits
  without touching any file unless `--apply` is supplied.
- **Write gate with an opt-out lock**: a governed-config write requires
  `--apply`. The environment variable `CLAUDE_MGR_ENABLE_WRITES` is an explicit
  opt-out lock — set it to `0` to hard-disable all governed writes (e.g. in CI),
  and a write then refuses with exit code 3. Unset or `1` (back-compat) leaves
  writes enabled with `--apply`.
- **Auto-snapshot + rollback**: every governed write takes an automatic snapshot
  of the governed surface first; `rollback` restores files byte-identical.
- **One exact-pinned npm runtime dependency**: the CLI imports only Node stdlib
  and the project's own modules; the optional stdio [MCP server](#mcp-server)
  uses the official `@modelcontextprotocol/sdk` (exact-pinned, lockfile
  committed — the owner-sanctioned 2026-06-10 exception to the original
  zero-dependency line).
- **Windows-hardened**: developed and tested on Windows with
  `C:\Windows\System32\tar.exe` (bsdtar). Unicode filenames and CRLF handled.
- **Lives outside Claude Code's loader**: `claude-mgr` never participates in
  CC's runtime skill/agent loading and has no effect on how CC loads components.

---

## Install & run

The CLI itself runs with no `npm install`. Clone or copy the repo, then invoke
one of the three entry points:

| Platform | Entry point | Example |
|----------|-------------|---------|
| Windows (PowerShell) | `.\claude-mgr.ps1` | `.\claude-mgr.ps1 inventory` |
| macOS / Linux / WSL | `./claude-mgr.sh` | `./claude-mgr.sh doctor` |
| Any (Node direct) | `node src/cli.mjs` | `node src/cli.mjs conflicts` |

**Requirements**: Node >= 24. The CLI imports only Node stdlib. Running the
[MCP server](#mcp-server) (or the full test suite) requires `npm install` once
— the project's first and only runtime dependency, the exact-pinned official
`@modelcontextprotocol/sdk` (owner-sanctioned 2026-06-10).

The entry scripts resolve `src/cli.mjs` relative to their own location, so they
work from any working directory.

---

## Commands

### Global flags (apply to every command)

| Flag | Description |
|------|-------------|
| `--format table\|json\|ndjson\|quiet` | Output format (default: `table`) |
| `--config-dir <path>` | Override the governed directory (default: `~/.claude`) |
| `--redact-paths` | Replace the home-directory prefix in output paths with `~` |

---

### Inspect (read-only)

All commands in this group read files and never modify anything.

#### `inventory`

Count skills, agents, commands, plugins, MCP servers and report top-level
directories.

```
claude-mgr inventory
claude-mgr inventory --type skill|agent|command|plugin|marketplace|mcp
claude-mgr inventory --detail
claude-mgr inventory --by-category
```

- `--type <kind>` — narrow output to one kind's full list.
- `--detail` — add full object arrays for each kind (useful for tooling).
- `--by-category` — add a purpose-grouped summary (writing, development,
  self-iteration, research, …).

#### `conflicts`

Report shadowing conflicts among loaded components (same resolution key loaded
from multiple sources).

```
claude-mgr conflicts
claude-mgr conflicts --name <pattern>
```

- `--name <pattern>` — filter clusters by key using a regex.

The output also includes `dispositions` — for each shadowing cluster, the loader
winner, the shadowed losers, and a cited resolution suggestion: a concrete
`remove <kind>:<name>` for a user-tier loser, or a "disable / uninstall the
plugin" advisory for a plugin-tier one (never a `remove` that would be refused).
This is read-only advice; the actual removal routes through the gated `remove`
command. The pre-existing `conflicts` array is unchanged.

#### `health`

Aggregate a quick "is anything wrong?" read of the harness, all in one
read-only command: every component's loadability (`loadable` / `degraded` /
`not-loaded`) with reasons, rule-backed best-practice advice, and plain-English
hook explanations — all severity-tiered (error / warn / info) in the table view.
Passive only (no active probes); writes nothing. The `version:1` JSON / ndjson
envelope feeds the TUI and the MCP server.

```
claude-mgr health
claude-mgr health --format json
```

#### `orphans`

List files in `~/.claude` that are not recognized config entries (hard orphans:
unexpected top-level entries; soft orphans: misplaced files inside known dirs).

```
claude-mgr orphans
```

#### `config show-effective`

Display the merged effective settings from all settings layers
(`settings.json` < `settings.local.json`). Sensitive values are redacted.

```
claude-mgr config show-effective
claude-mgr config show-effective --key env
claude-mgr config show-effective --explain
```

- `--key <dotted.path>` — narrow to one key and its per-layer merge.
- `--explain` — show the per-layer provenance alongside each effective value.

#### `config diff <a> <b>`

Compute a unified Myers line-diff between two files.

```
claude-mgr config diff ~/.claude/settings.json ~/backup/settings.json
claude-mgr config diff a.txt b.txt --context 5
```

- `--context <N>` — lines of context around each hunk (default: 3).

If both `<a>` and `<b>` are snapshot ids that exist under
`.mgr-state/snapshots/`, `config diff` compares the two **snapshots** instead of
two files (read-only): with no third argument it diffs their manifests (which
files were added / removed / modified); with a third `[relpath]` it diffs that
one file's contents between the two snapshots. An id-shaped string that is not a
real snapshot dir simply falls back to file mode.

```
claude-mgr config diff 2026-06-07T10-00-00Z 2026-06-08T09-00-00Z
claude-mgr config diff 2026-06-07T10-00-00Z 2026-06-08T09-00-00Z settings.json
```

#### `hooks`

Show the merged per-event hook order from effective settings. Secrets embedded
in hook command strings are redacted.

```
claude-mgr hooks
```

#### `permissions`

List effective allow / ask / deny permission rules. Add `--audit` to also
surface wildcard (`*`-containing) allow entries.

```
claude-mgr permissions
claude-mgr permissions --audit
```

- `--audit` — add an `overbroad` list and warn diagnostics for wildcard rules.

#### `doctor`

Run all 25 passive health checks against the config. With `--active-probes`,
also runs 3 active checks (syntax-checks Node hook scripts via `node --check`,
resolves the `claude` CLI, and briefly creates + removes a transient probe file
in `agents/`).

```
claude-mgr doctor
claude-mgr doctor --active-probes
```

- `--active-probes` — include active checks (spawns external tools; the loader
  probe creates and immediately removes a temporary file in `agents/`).

#### `audit`

Read the metadata-only audit log written by write commands.

```
claude-mgr audit
claude-mgr audit --since 7d
claude-mgr audit --since 24h
```

- `--since <duration>` — filter to entries newer than the duration (e.g. `7d`,
  `24h`, `30m`, `45s`, `2w`).

#### `drift`

Compare the current governed surface against the stored baseline in
`.mgr-state/lockfile.json`. Without `--update` it is read-only.

```
claude-mgr drift
claude-mgr drift --update
```

- `--update` — save the current state as the new baseline (writes the
  baseline lockfile to `.mgr-state/` only — never governed config; the single
  `--update` flag is sufficient, no `--apply` or `CLAUDE_MGR_ENABLE_WRITES`
  needed because it touches only claude-mgr's own state dir).

#### `completion`

Emit a shell tab-completion script.

```
claude-mgr completion bash    | source /dev/stdin   # or: eval "$(…)"
claude-mgr completion powershell
```

Source the output in your shell profile to get `<Tab>` suggestions for
commands, sub-verbs, and flags.

#### `selftest`

Run the project's internal self-test gates.

```
claude-mgr selftest --all
claude-mgr selftest --lint
claude-mgr selftest --invariants
claude-mgr selftest --boundary
claude-mgr selftest --release-gate
claude-mgr selftest --schema-canary
claude-mgr selftest --schema-canary --update-baseline
```

- `--all` — run lint + invariants + boundary checks together.
- `--release-gate` — full gate: tests, coverage, invariants, boundary, lint,
  doctor passive.
- `--schema-canary` — compare the CC config schema surface against the saved
  baseline; `--update-baseline` re-saves it.

---

### Snapshots

Snapshot commands read the governed tree and (with `--apply`) write an archive
to `.mgr-state/snapshots/`. They never modify `~/.claude` itself.

#### `snapshot [--apply]`

Dry-run preview of what would be archived, or create an archive.

```
claude-mgr snapshot
claude-mgr snapshot --reason "before update" --apply
claude-mgr snapshot --include-auth --apply
```

- `--apply` — create the snapshot (set `CLAUDE_MGR_ENABLE_WRITES=0` to hard-disable).
- `--reason <msg>` — label stored in the snapshot manifest.
- `--include-auth` — opt-in to include the MCP auth cache file.

#### `snapshot list`

List stored snapshots (newest first).

```
claude-mgr snapshot list
claude-mgr snapshot list --keep 5 --older-than 30d
```

- `--keep <N>` — show retention preview: which snapshots would be pruned.
- `--older-than <duration>` — used with `--keep` for the retention preview.

#### `snapshot gc [--apply]`

Prune old snapshots. Dry-run by default.

```
claude-mgr snapshot gc --keep 5
claude-mgr snapshot gc --older-than 30d --apply
```

- `--keep <N>` — keep the N most recent snapshots; prune the rest.
- `--older-than <duration>` — prune snapshots older than this duration.
- `--apply` — actually delete (set `CLAUDE_MGR_ENABLE_WRITES=0` to hard-disable). A
  criterion (`--keep` or `--older-than`) is required.

#### `snapshot pin <id>` / `snapshot unpin <id>`

Mark a snapshot so `gc` never prunes it, or remove that mark.

```
claude-mgr snapshot pin 2026-06-07T10-00-00Z --apply
claude-mgr snapshot unpin 2026-06-07T10-00-00Z --apply
```

---

### Governed writes (dry-run by default, `--apply` to write)

These commands modify `~/.claude` or delegate to the external `claude` CLI.
Every command previews without writing unless `--apply` is given. Writes can be
hard-disabled by setting `CLAUDE_MGR_ENABLE_WRITES=0` in the environment (e.g.
in CI); a closed lock exits with code 3 before loading the write machinery.

Every governed write takes an **automatic snapshot first** — the snapshot is
the undo point for `rollback`.

#### `rollback <id> [--apply]`

Restore a snapshot's bytes onto the live tree. Dry-run shows the drift check
and archive-verify results without touching any file.

```
claude-mgr rollback 2026-06-07T10-00-00Z
claude-mgr rollback 2026-06-07T10-00-00Z --force --apply
```

- `--force` — proceed even if the live tree has drifted since the snapshot.
- `--apply` — perform the restore (set `CLAUDE_MGR_ENABLE_WRITES=0` to hard-disable).

#### `recover <id> [--apply]`

Reconcile a crashed or interrupted apply. Choose one mode flag:

```
claude-mgr recover 2026-06-07T10-00-00Z --mark-failed --apply
claude-mgr recover 2026-06-07T10-00-00Z --resume --apply
claude-mgr recover 2026-06-07T10-00-00Z --rollback --apply
claude-mgr recover 2026-06-07T10-00-00Z --from-manifest --apply
```

- `--mark-failed` — write `failed` to the journal (always requires `--apply`).
- `--resume` — re-verify landed writes and commit if they match.
- `--rollback` — restore from the snapshot (dry-run-capable).
- `--from-manifest` — restore using only the archive manifest, ignoring the
  journal (useful when the journal is missing or corrupt).
- `--force` — override the drift refusal for `--rollback` / `--from-manifest`.

#### `lock [--break-lock] [--apply]`

Inspect or force-remove the apply lock.

```
claude-mgr lock
claude-mgr lock --break-lock
claude-mgr lock --break-lock --apply
```

- Bare `lock` — show current lock status (read-only).
- `--break-lock` without `--apply` — dry-run: show holder info and age-based
  caution (live holder / dead holder / absent).
- `--break-lock --apply` — force-remove the lock and write an audit entry
  (set `CLAUDE_MGR_ENABLE_WRITES=0` to hard-disable).

#### `remove <kind>:<name> [--apply]`

Delete an agent, command, or skill from the governed tree.

```
claude-mgr remove agent:my-agent
claude-mgr remove command:my-command --reason "no longer needed" --apply
claude-mgr remove skill:my-skill --apply
claude-mgr remove agent:my-agent --cascade --force --apply
```

- `kind` must be `agent`, `command`, or `skill`.
- `--reason <msg>` — label stored in the snapshot and audit log.
- `--cascade` — also remove dependent components (requires `--force` when
  dependents exist, to prevent accidental multi-deletes).
- `--force` — permit the cascade to proceed when the dependent set is non-empty.
- `--apply` — execute the delete (set `CLAUDE_MGR_ENABLE_WRITES=0` to hard-disable).

The remove is reversible: the auto-snapshot lets `rollback` restore the deleted
file(s) byte-identical.

#### `update <plugin> [--apply]`

Preview or delegate a plugin update to the external `claude` CLI.

```
claude-mgr update my-plugin
claude-mgr update my-plugin --reason "security fix" --apply
```

- `--reason <msg>` — label stored in the auto-snapshot and audit log.
- `--lock-version <ver>` — acknowledged but reported as unsupported by the
  underlying `claude plugin update` command (it cannot target a version).
- `--apply` — snapshot first, then run `claude plugin update <key>` via a
  sandboxed spawn (set `CLAUDE_MGR_ENABLE_WRITES=0` to hard-disable).

**Partial-reversibility note**: the auto-snapshot covers only
`installed_plugins.json`. The code fetched by `claude` and the plugin cache are
outside claude-mgr's snapshot scope and are not restored by `rollback`.

#### `mcp remove <name> [--apply]`

Preview or delegate an MCP server removal to the external `claude` CLI.

```
claude-mgr mcp remove my-server
claude-mgr mcp remove my-server --scope project --apply
```

- `--scope local|user|project` — passed through to `claude mcp remove`. If
  omitted, claude-mgr passes no scope and the external `claude` CLI applies its
  own default; an unscoped removal is treated as **not snapshotted / not
  reversible** (same as `user`/`local` scope). Pass `--scope project` to get a
  reversible, snapshotted removal of `.mcp.json`.
- `--reason <msg>` — label stored in the auto-snapshot and audit log.
- `--apply` — snapshot first, then run `claude mcp remove <name>` via a
  sandboxed spawn (set `CLAUDE_MGR_ENABLE_WRITES=0` to hard-disable).

**Partial-reversibility note**: for `--scope project` the snapshot covers
`.mcp.json` and `rollback` can restore it. For `user`/`local` scope (or when
`--scope` is omitted) the mutation is in `~/.claude.json`, outside
claude-mgr's snapshot scope.

#### `skill propose <name> --from <file> [--apply]`

Write an iterated version of a skill as a **new**
`skills/<name>/SKILL.proposed-<timestamp>.md`, **never touching the original
`SKILL.md`**. Dry-run by default (shows a unified diff between the current
`SKILL.md` and the proposed content).

```
claude-mgr skill propose my-skill --from ./my-skill-v2.md
claude-mgr skill propose my-skill --from ./my-skill-v2.md --reason "tighten wording" --apply
```

- `--from <file>` — the file whose contents become the proposed `SKILL.md`.
- `--reason <msg>` — label stored in the provenance record.
- `--apply` — write the proposal file plus a provenance record (set
  `CLAUDE_MGR_ENABLE_WRITES=0` to hard-disable).

Because `propose` only adds a new file (the loader ignores `SKILL.proposed-*`),
no snapshot is needed — undo is simply deleting the new file.

#### `skill accept <name> [<proposalId>] [--force] [--apply]`

Land a proposal onto the real `SKILL.md`. Auto-snapshots first, so it is
reversible with `rollback`. A **stale guard** refuses if `SKILL.md` has drifted
from the proposal's recorded source — or if there is no provenance record to
check against — unless you pass `--force`. With one proposal the id is optional;
with several it lists them and asks you to name one.

```
claude-mgr skill accept my-skill
claude-mgr skill accept my-skill 2026-06-12T10-00-00Z --apply
claude-mgr skill accept my-skill --force --apply
```

- `<proposalId>` — pick a specific proposal (the timestamp or full leaf name);
  optional when exactly one proposal exists.
- `--force` — accept even when `SKILL.md` has drifted or no provenance exists.
- `--apply` — snapshot, then overwrite `SKILL.md` (set
  `CLAUDE_MGR_ENABLE_WRITES=0` to hard-disable).

On success the accepted proposal and its provenance record are removed; any
sibling proposals are kept.

---

## MCP server

`claude-mgr` can expose its read-only view to Claude Code as a Model Context
Protocol server over **stdio** (P5.U6). It is a separate process role — not a
CLI subcommand — launched as `node src/mcp/server.mjs`.

**What it exposes — 4 read-only tools, nothing else:**

| Tool | Delegates to |
|------|--------------|
| `claude_mgr_inventory` | `inventory --format json` |
| `claude_mgr_health` | `health --format json` |
| `claude_mgr_conflicts` | `conflicts --format json` |
| `claude_mgr_doctor` | `doctor --format json` (**passive checks only** — active probes stay a human opt-in) |

Each tool returns the same `version:1` JSON envelope the CLI prints (secret
redaction and diagnostics included). The tools take no inputs. Write commands
are **not** exposed as tools — they stay behind the CLI's `--apply` gate.

**Prerequisite**: run `npm install` once in the repo (installs the exact-pinned
official `@modelcontextprotocol/sdk` — the project's first runtime dependency,
owner-sanctioned 2026-06-10; see `docs/threat-model.md` §5.10).

**Register with Claude Code** (substitute your absolute repo path):

```sh
claude mcp add claude-mgr -- node C:/Dev/Projects/claude-mgr/src/mcp/server.mjs
```

The server speaks stdio pipes only — it opens no network listener and makes no
outbound connection; claude-mgr's own code remains machine-enforced
zero-network (`selftest --boundary`).

---

## Output formats

| Format | Description |
|--------|-------------|
| `table` (default) | Human-readable aligned output with a diagnostics footer |
| `json` | `{"version":1,"command":"…","result":…,"diagnostics":[…]}` envelope |
| `ndjson` | One JSON record per line (result line then one line per diagnostic); suitable for streaming consumers |
| `quiet` | Single-line counts of errors and warnings only |

Select with `--format <name>`. An unrecognized format value falls back to
`table` with a warning diagnostic.

---

## Safety model

### Dry-run by default

Every write command (rollback, recover, remove, update, mcp remove, snapshot
with `--apply`) runs a read-only preflight and exits without touching any
governed file unless `--apply` is explicitly supplied.

### Write gate (dry-run + `--apply`, with an opt-out lock)

Performing a governed-config write requires the `--apply` flag on the command
line. Without it, the command runs a read-only preflight and writes nothing, so
a copy-pasted command line or a mistyped flag cannot accidentally trigger a
write.

The environment variable `CLAUDE_MGR_ENABLE_WRITES` is an explicit **opt-out
lock**: set it to `0` to hard-disable all governed writes (the value is trimmed
before the check). A locked write refuses with exit code 3 **before** the write
machinery is loaded. Unset, `1` (back-compat), or any other value leaves writes
enabled with `--apply`.

> The write gate used to require both `--apply` and `CLAUDE_MGR_ENABLE_WRITES=1`.
> That second factor was relaxed on 2026-06-09 (see `CHANGELOG.md`): `--apply`
> alone now writes, and the env var became the opt-out lock described above.

```powershell
# Windows PowerShell — --apply is all that's needed:
.\claude-mgr.ps1 remove agent:foo --apply

# To hard-disable writes (e.g. in CI):
$env:CLAUDE_MGR_ENABLE_WRITES = "0"
```

```sh
# POSIX:
./claude-mgr.sh remove agent:foo --apply

# To hard-disable writes (e.g. in CI):
CLAUDE_MGR_ENABLE_WRITES=0 ./claude-mgr.sh remove agent:foo --apply
```

### Auto-snapshot + rollback reversibility

Before any governed-config write (remove, rollback restore, recover, update
delegation), `claude-mgr` takes a snapshot of the governed surface into
`.mgr-state/snapshots/<id>/`. The snapshot is the undo point:

```
claude-mgr rollback <snapshot-id> --apply
```

Every snapshot contains a manifest with per-file SHA-256 hashes. `rollback`
verifies the archive against those hashes before restoring.

### Zero-network

`claude-mgr`'s own code makes zero network calls. The `update` and `mcp remove`
commands delegate to the external `claude` CLI via a sandboxed spawn — the
network activity (if any) belongs to that process, not to `claude-mgr`.

### Secret and path redaction

- Sensitive values in settings (e.g. the `env` map) are redacted to
  `{"redacted":true,"sha256":"…"}` in all output formats before they leave the
  command handler.
- Secret-shaped strings (PEM blocks, API token patterns, URL credentials) are
  redacted from hook command strings, MCP args, and component descriptions.
- Add `--redact-paths` to replace the home-directory prefix in output paths
  with `~` (opt-in; without this flag output is unchanged).

---

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | Ran cleanly — no error-severity diagnostics |
| `1` | Ran, but one or more error-severity diagnostics were produced |
| `2` | Usage error (unknown command or flag) or an unexpected internal throw. Write commands also use `2` for a refused/invalid target (e.g. `remove agent:<missing>` → target not found, unsupported kind, bad `--scope`) |
| `3` | A write was refused — write gate locked (`CLAUDE_MGR_ENABLE_WRITES=0`), missing spec, or `--force` required |
| `4` | Snapshot integrity failure (archive hash mismatch) — write command aborted |

Write commands (remove, update, mcp remove) may additionally use:

| Code | Meaning |
|------|---------|
| `6` | Apply lock could not be acquired (another apply may be running) |

---

## Status

Stable. All read commands are safe to run at any time — they are pure and
modify nothing. Governed writes are gated by `--apply` (with a
`CLAUDE_MGR_ENABLE_WRITES=0` opt-out lock) and are reversible via the
auto-snapshot and `rollback`.
