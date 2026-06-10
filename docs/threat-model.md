# Threat model — `claude-mgr`

**Status: revised 2026-06-02 — now covers the Phase-3 write surface as shipped.**
The original P2.U12 cut documented the read-mostly phase; this revision reflects the
landed Phase-3 write-side (snapshot / rollback / apply / recover / lock / audit
writer / gc). The shape of the security model is unchanged — still exactly two
privileged operations behind two choke points — but governed-config WRITES now
exist (behind the `--apply` write gate with an env opt-out lock, dry-run-by-default), the spawn-write boundary check
is now wired LIVE into the snapshot create path (it runs post-tar in `createSnapshot`),
and several formerly "Phase-3, not yet implemented" items below are now implemented and re-cited. A 2026-06-02 read-only
security re-scan of Phases 1–3 (six surfaces) found the invariants here HOLD and
fixed three issues (discovery symlink-follow, output secret-shape leakage, drift
symlink-follow) now reflected in §5.2 / §5.3 / §5.9.

**Security posture in one breath:** `claude-mgr` is a zero-runtime-dependency
Node ESM CLI that **inspects** a Claude Code `~/.claude` install (inventory /
conflicts / effective-config / doctor / drift / audit / permissions audit). It is
**read-mostly**, **dry-run-by-default**, lives **outside** Claude Code's loader,
parses the governed config as **untrusted input it never executes**, and is
**Windows-hardened**. There are exactly two privileged operations — **writing a
file** and **spawning a process** — and each is funnelled through a single,
allowlisting choke point.

Every mitigation below is **cited to source** (`file` + line/function) so a
reviewer can verify the claim against the actual code, and the two most important
invariants (the write-allowlist and the forbidden-import graph) are
**continuously enforced** by `claude-mgr selftest --boundary` — see
[Continuous verification](#8-continuous-verification). This document is a
contract: if the code and this document disagree, that is a bug in one of them.

Source cross-references use relative links, e.g. [`src/paths.mjs`](../src/paths.mjs).

---

## 1. What this document is

An honest engineering threat model for the read-mostly phase. It enumerates the
**assets** worth protecting, the **trust model** we operate under, the **trust
boundaries** in the code, the **threats and their mitigations** (each cited), and
— importantly — the **residual risks** that are detective rather than preventive,
or simply deferred. It is deliberately **not exhaustive**; it is accurate.

---

## 2. Assets

| Asset | Why it matters |
|---|---|
| The user's **`~/.claude` config** (CLAUDE.md, settings, skills/agents/commands/hooks, plugins, MCP config) | A large, precious, hand-curated harness. The whole reason the tool is read-mostly and dry-run-by-default is to inspect it **without risking it**. |
| **Secrets referenced by that config** | MCP server `env` blocks may hold API keys/tokens; `mcp-needs-auth-cache.json` and similar files exist. These must never leak into inventory output, snapshots, or logs — with ONE audited exception: `mcp-needs-auth-cache.json` is **default-excluded** from snapshots and captured only via the explicit `snapshot --include-auth` opt-in, which emits a per-capture `snapshot-auth-included` INFO notice (plan L420; enforced in `src/ops/snapshot-secrets-filter.mjs`). The secrets allowlist proper (keys/certs/`.env`/`id_rsa`/content-sniffed PEM+tokens) is **never** captured, even with `--include-auth`. |
| **`claude-mgr`'s own state** — `~/.claude/.mgr-state/` | Holds the drift lockfile (Phase 2) and, in Phase 3, snapshots / apply-journal / audit log. Its integrity and confidentiality matter; it is deliberately *excluded* from the governed config surface and from snapshot capture (recursive-bloat guard). |
| **Integrity & availability of the user's machine and config** | The tool must not corrupt the config, must not execute attacker-controlled content found in the config, and must remain usable even when its environment is partly broken. |

---

## 3. Trust model & assumptions

- **Single trusted local user.** The tool runs as one local OS user with that
  user's own privileges. It does not elevate, sandbox, or cross user boundaries.
- **Trusted toolchain.** Node, npm, and the OS are assumed trustworthy. The tool
  has **zero runtime npm dependencies** (Node stdlib only), shrinking the
  supply-chain surface to Node itself.
- **The governed config content is UNTRUSTED INPUT.** This is the load-bearing
  assumption. `~/.claude` content (JSON/JSONC, YAML frontmatter, hook command
  strings, file/dir names) is treated as potentially **malformed or adversarial**
  — parsed defensively, **never executed**, never trusted to be well-formed.
- **Explicitly NOT** a multi-user model, a sandbox-escape model, or a
  supply-chain model. See [Out of scope](#7-out-of-scope).

---

## 4. Trust boundaries

1. **Read path (untrusted-input parser).** All of `src/discovery/**` and
   `src/analysis/**` consume config content. They **parse, never execute**, and
   every module honours a **never-throws** contract (bad input degrades to a
   `Diagnostic`, not an exception). The doctor judgment layer
   ([`src/analysis/doctor/index.mjs`](../src/analysis/doctor/index.mjs)) is
   **pure**: its only import is `DiagnosticBag` plus sibling pure check tables
   (`index.mjs:66-72`) — no `fs`, `crypto`, or `child_process` — so it does no
   I/O at all and can only emit verdicts over facts gathered elsewhere.
2. **The single WRITE choke point.** Every governed-surface write passes through
   `assertWritable(target, context)` in
   [`src/paths.mjs`](../src/paths.mjs) (`paths.mjs:222`).
3. **The single SPAWN choke point.** Every external process is launched through
   `safeSpawn` / `validateSpawnSpec` in
   [`src/lib/safe-spawn.mjs`](../src/lib/safe-spawn.mjs) (`validateSpawnSpec`
   `safe-spawn.mjs:71`, `safeSpawn` `:138`). `execFile` is used with `shell:false`
   (`safe-spawn.mjs:146-149`) — never `exec` or a shell.
4. **Outside the CC loader.** `claude-mgr` is a separate package that the Claude
   Code loader does not load; inspecting the harness cannot perturb it.

---

## 5. Threats & mitigations

Each mitigation is cited to the code that implements it.

### 5.1 Unauthorized or scope-escaping writes

The "Forbidden vs Rollback-Writable" model (plan §"Forbidden vs Rollback-Writable",
plan line ~417) is enforced entirely in `assertWritable`
([`src/paths.mjs`](../src/paths.mjs), `paths.mjs:222`):

- **Outside the governed dir → refused.** Anything not under `targetClaudeDir`
  (and not under `.mgr-state`) throws `write-outside-target` (`paths.mjs:237-240`).
- **Forbidden subtrees → always refused**, even in rollback:
  `plugins/marketplaces/**` and `projects/**` throw `write-forbidden`
  (`paths.mjs:249-251`).
- **Apply-writable files.** Only the three exact basenames in `APPLY_WRITABLE_FILES`
  — `settings.json`, `settings.local.json`, `.mcp.json` (`paths.mjs:52`) — are
  writable DIRECTLY in the config root in BOTH `apply` and `rollback`, via
  `isApplyWritableFile` (`paths.mjs:193-195`, checked `paths.mjs:277`). This is the
  surface the Phase-3 apply path may create/overwrite.
- **Rollback-only surfaces.** `CLAUDE.md` and `agents/skills/commands/hooks` are
  writable **only** with `context === 'rollback'`; an `apply`-context attempt
  throws `write-rollback-only` (`paths.mjs:290-295`).
- **Deny-by-default tail.** Any other path under the config dir that is not on the
  allowlist throws `write-not-allowed` (`paths.mjs:304`) — unknown surfaces
  are rejected, not allowed.
- **`.mgr-state` passthrough.** The tool's own state dir is writable in any
  context (`paths.mjs:232-233`); this is what lets the drift lockfile, snapshots,
  apply-journal, and audit log persist without a bespoke write flag.

Governed-config writes are now live (Phase 3) but **dry-run-by-default and behind
the write gate (`--apply`, plus a `CLAUDE_MGR_ENABLE_WRITES=0` opt-out lock —
relaxed from the original two-factor model by the 2026-06-09 off-ramp)**: the
`apply`/`rollback`/`recover`/`lock` CLI commands write only
when `--apply` is passed (and `CLAUDE_MGR_ENABLE_WRITES=0` is NOT set)
([`src/cli/write-gate.mjs`](../src/cli/write-gate.mjs) `resolveWriteIntent`); a
closed gate exits before `paths.mjs` is even loaded. Every writer (apply,
rollback-restore, snapshot manifest/journal, lock, audit) takes `assertWritable` as
a **REQUIRED injected** dependency and fails safe (refuses) if it is absent. The
atomic single-file replace ([`src/ops/atomic-write.mjs`](../src/ops/atomic-write.mjs))
gate-checks FIRST, before staging. The loader probe (5.4) remains the only governed
write that runs without the write gate (it is behind `--active-probes` and
self-cleans).

### 5.2 Symlink & path traversal (allowlist escape)

`assertWritable` is **fail-closed** against symlink and traversal escapes:

- `canonical()` ([`src/paths.mjs`](../src/paths.mjs), `paths.mjs:137`) resolves
  the target via `realpathSync` **before** the allowlist comparison (plan finding
  **L1**, plan line ~560), so a symlink cannot point an allowed name at a
  forbidden location.
- It **fails closed on any non-ENOENT error**: `ELOOP`/`EACCES`/`ENOTDIR` throw
  `write-canonicalize-failed` rather than being treated as writable
  (`paths.mjs:141-164`). Only `ENOENT` (the legitimate "to-be-created file" case)
  falls through, and even then the **deepest existing ancestor is realpath-resolved**
  so a symlinked parent dir still cannot escape (`paths.mjs:149-153`).
- Prefix comparison is canonicalized on both sides and Windows-case-normalized
  (`isUnder`, `paths.mjs:178-181`; `canonical` lowercases on win32,
  `paths.mjs:169`), defeating case-insensitive-FS bypasses.
- The `'probe'` context recomputes `canonical()` for both target and `agents/`
  and requires the resolved parent to equal the canonical `agents/` dir, so a
  symlinked `agents/` is still denied (`paths.mjs:262-267`).

### 5.3 Secret leakage

- **MCP `env` values are never captured.** MCP discovery records env **key names
  only**, never values: `toRecord` does
  `rec.envKeys = Object.keys(cfg.env).sort()` with the explicit "NAMES ONLY —
  never values" contract ([`src/discovery/mcp.mjs`](../src/discovery/mcp.mjs),
  `mcp.mjs:128`; see also the module header `mcp.mjs:13-16`). So inventory output
  cannot leak an MCP secret value. (Snapshots are a separate local backup under
  `.mgr-state`; they archive config files to be restorable and exclude dedicated
  credential files via the secrets-filter — see §2 and the snapshot bullet below.)
- **`config show-effective` redacts settings secret VALUES.** The merged
  `settings.json` surface is NOT names-only — `settings.json` can carry an `env`
  map (e.g. `ANTHROPIC_API_KEY`) and sensitive-keyed scalars (e.g.
  `apiKeyHelper`). Before `configShowEffectiveCommand` returns, every value under
  the top-level `env` map AND any value whose KEY matches the sensitive patterns
  (`token`/`secret`/`key`/`password`/`credential`/`auth`) is replaced with the
  project's standard `{redacted:true, sha256}` sentinel across BOTH value-bearing
  surfaces (the merged `effective` object and the per-key `keys` map's
  `value`/`perLayer[].value`). Redaction happens in the handler, so EVERY output
  format (json, ndjson, table, quiet) is uniformly safe; key NAMES stay visible
  for governance and the stable hash allows config-diffing without revealing the
  secret. Single source: the patterns + hash come from
  [`src/lib/plan.mjs`](../src/lib/plan.mjs) (`isSensitivePointer`,
  `sha256OfValue`) and the walk lives in
  [`src/analysis/redact-effective.mjs`](../src/analysis/redact-effective.mjs);
  the wiring is [`src/cli/commands.mjs`](../src/cli/commands.mjs)
  (`configShowEffectiveCommand`).
- **Output command strings + non-sensitively-keyed values are shape-redacted.** A
  credential can hide in a string the key-name redactor above would miss — a token
  inside a hook or statusLine `command`, or a connection string under a benign key
  name (e.g. `myDatabaseUrl: postgres://u:p@h`). `redactSecretsInString` /
  `redactSecretsDeep` ([`src/analysis/redact-secrets-text.mjs`](../src/analysis/redact-secrets-text.mjs))
  replace high-confidence secret SUBSTRINGS — PEM blocks, self-identifying token
  shapes (single-sourced from `secrets-content-sniff.mjs`), URL userinfo,
  Bearer/Basic, and a sensitive `name=value` — with `<redacted>`, leaving the
  surrounding command/URL text intact. The high-entropy heuristic is deliberately
  excluded (low false-positive) and input is length-bounded so matching stays linear
  (no ReDoS). Wired into `redactDeep` (so `config show-effective` is covered across
  the effective/keys/`--key` surfaces) and into [`src/cli/commands.mjs`](../src/cli/commands.mjs)
  for inventory `statusLine`, `hooks`, `permissions` rules, and `--detail` component
  descriptions (2026-06-02 audit P1).
- **The audit log is metadata-only — on BOTH read and write.** The reader examines
  only metadata for sort/filter ([`src/ops/audit.mjs`](../src/ops/audit.mjs)); the
  writer ([`src/ops/audit-writer.mjs`](../src/ops/audit-writer.mjs), P3.U20) enforces
  a strict metadata whitelist `{timestamp, command, planVersion, snapshotId,
  exitCode, opCount}` TWICE — on build AND again at the I/O boundary — so file
  contents / before / after / diffs can never reach `audit.log` (plan finding **M3**).
- **Snapshot-time secret EXCLUSION is implemented (Phase 3).** The snapshot walker's
  file list is filtered by [`src/ops/snapshot-secrets-filter.mjs`](../src/ops/snapshot-secrets-filter.mjs)
  — DROP = a basename match against `secrets-allowlist.json` OR a content-sniff hit
  via `secrets-content-sniff.mjs` — BEFORE the `tar` spawn, so a credential never
  enters the archive; `mcp-needs-auth-cache.json` is default-excluded and captured
  only via the audited `--include-auth` opt-in (§2). The apply-journal redacts each
  op via `redactPatchOp` ([`src/lib/plan.mjs`](../src/lib/plan.mjs)) before
  persisting — see §6 for its pointer-name residual.
- **The reversibility snapshot (taken before any governed mutation) bypasses the
  secret-name filter** (`skipSecretFilter: true` in `applyPlan`,
  [`src/ops/apply.mjs`](../src/ops/apply.mjs); `createSnapshot` passes
  `keepAll: true` to the filter). This ensures a file whose *name* matches a secret
  glob (e.g. `commands/rotate-secret.md`) is always captured in the undo-point so
  `rollback` can restore it. The sharing/output secret filter is a *separate, correct
  surface* and is not affected by this change.
- **Op-target cross-check (Part 2 backstop):** after the reversibility snapshot is
  taken and *before* any mutation, `applyPlan` calls `checkOpTargetsInManifest`
  ([`src/ops/apply-manifest-check.mjs`](../src/ops/apply-manifest-check.mjs)) to
  verify that every `overwrite`/`delete`/`delete-dir` op target appears in the
  snapshot manifest. If any is absent the apply is refused (`apply-target-not-snapshotted`)
  — making a silently-irreversible deletion structurally impossible. The check fails
  closed: an unreadable manifest is treated as empty (no captured files) and the
  apply is refused.
- **Accepted residual (same trust domain):** because the reversibility snapshot keeps
  the full walked governed surface, a credential-shaped file a user has parked *inside*
  a walked governed dir (e.g. a `.pem` under `hooks/`) will now reside in the LOCAL
  `.mgr-state` snapshot archive. This adds no new exposure — the file already lives in
  `~/.claude` on the same machine in the same single-trusted-user trust domain, and the
  snapshot archive is local and owner-only. The output/sharing redactors are unaffected.
- **The `update` / `mcp remove` delegate-path reversibility snapshots also bypass
  the secret filter** (`skipSecretFilter: true` added 2026-06-10 to
  [`src/ops/update.mjs`](../src/ops/update.mjs) and
  [`src/ops/mcp-write.mjs`](../src/ops/mcp-write.mjs)), closing the follow-up
  recorded in the 2026-06-10 adversarial audit. A `plugins/installed_plugins.json`
  or `.mcp.json` whose *content* triggers the github-token content-sniff leg was
  previously dropped from those snapshots, making the delegated mutation silently
  irreversible. Both modules now pass `skipSecretFilter: true` to `createSnapshot`
  and apply a Part-2 cross-check (`checkDelegateTargetSnapshotted` in
  [`src/ops/delegate-manifest-check.mjs`](../src/ops/delegate-manifest-check.mjs))
  that REFUSES the spawn when the target is absent from the manifest — making a
  silently-irreversible delegation structurally impossible. Scope-conditioned: the
  mcp cross-check applies only to `--scope project` (`.mcp.json` is in the governed
  tree); `user`/`local` scopes write `~/.claude.json` which is already outside
  snapshot scope and documented as partial-reversibility via
  `mcp-user-scope-not-snapshotted`.

### 5.4 Arbitrary code execution via probes

The doctor's "active probes" are the only place the tool runs anything, and they
are built to **never execute attacker-controlled config content**:

- **Hook-syntax probe (#4) never executes a hook's command string.** It runs only
  `node --check <FILE_PATH>` (parse-only) via `safeSpawn`, with a schema pinning
  `allowedFlags:['--check']`, an absolute-node-path `positionalPattern`, and
  `maxArgs:2` ([`src/discovery/probe-hook-syntax.mjs`](../src/discovery/probe-hook-syntax.mjs),
  `probe-hook-syntax.mjs:78-85`; invariant stated `probe-hook-syntax.mjs:8-11`).
  A numeric non-zero exit **without** a real `SyntaxError:` in stderr (e.g. the
  file vanished after the passive probe found it) is **demoted to
  `indeterminate`**, never reported as a false syntax error
  (`probe-hook-syntax.mjs:89-100`) — the TOCTOU-safe behaviour.
- **Loader probe (#19) is the only governed-dir write, and it is bounded and
  self-cleaning.** It writes a transient `__mgr-probe-<uuid>.md` into the real
  `agents/` **through `assertWritable(p,'probe')`** (the 5.2 gate, not a bypass),
  confirms `claude-mgr`'s own discovery sees it, and **always removes it in a
  `finally`** ([`src/discovery/probe-loader.mjs`](../src/discovery/probe-loader.mjs),
  `probe-loader.mjs:111`, `:140-144`). The function is `async` but `await`-free in
  the write/observe body, so no interposed rejection can skip the cleanup. It is
  gated behind `--active-probes` (`src/cli/doctor-facts.mjs:81`,
  `doctor-facts.mjs:139-151`).
- **All probes go through the spawn gate.** The icacls ACL probe (#24) and the
  `claude --version` probe (#15) spawn only via `safeSpawn`
  (`probe-access.mjs:197`, `probe-cli.mjs:108`). The ACL probe passes exactly one
  positional (the path), and icacls *mutation* flags (`/grant`, `/deny`, …) begin
  with `/`, so they are now rejected by the spawn gate's secure-by-default
  flag handling (a `/`-token is a flag unless a consumer opts into
  `allowSlashPositionals`, which the ACL probe does not), in addition to the path
  `positionalPattern` and `maxArgs:1` (`probe-access.mjs:195-209`, and the note at
  `probe-access.mjs:186-194`).
- **The non-execution invariant is test-enforced** by
  `test/integration/doctor-no-hook-execution.test.mjs` (plan invariant **L3**,
  plan line ~436/562) and the default-passive invariant test.

### 5.5 Prototype pollution from untrusted JSON

Config JSON/JSONC is untrusted, so every place that copies attacker-controlled
keys into an object guards against `__proto__` / `constructor` / `prototype` via
an `isSafeKey` check (or an equivalent inline guard):

- [`src/analysis/settings-merge.mjs`](../src/analysis/settings-merge.mjs) — guarded
  at every key-iteration site: `settings-merge.mjs:134`, `:180`, `:207`, `:228`.
- [`src/analysis/doctor/index.mjs`](../src/analysis/doctor/index.mjs) —
  `enabledPlugins` iteration guarded at `index.mjs:213`.
- [`src/discovery/probe-mcp.mjs`](../src/discovery/probe-mcp.mjs) — `probe-mcp.mjs:77`.
- [`src/discovery/probe-hooks.mjs`](../src/discovery/probe-hooks.mjs) — hook-event
  keys guarded at `probe-hooks.mjs:103`.
- [`src/output/json.mjs`](../src/output/json.mjs) — `stableStringify` drops unsafe
  keys at `json.mjs:99`.
- [`src/discovery/probe-state.mjs`](../src/discovery/probe-state.mjs) — the drift
  walk skips poisoning relpath keys at `probe-state.mjs:123`.
- Frontmatter maps are built with `Object.create(null)` so a frontmatter key can
  never reach `Object.prototype` ([`src/discovery/frontmatter.mjs`](../src/discovery/frontmatter.mjs),
  `frontmatter.mjs:33-36`). The JSONC parser likewise produces null-prototype
  objects (P2.U1).

### 5.6 Resource exhaustion / denial of service

- **Recursive walks are depth-capped at 64.** `safeDirSize` returns `0` past
  depth 64 ([`src/discovery/probe-fs.mjs`](../src/discovery/probe-fs.mjs),
  `probe-fs.mjs:72`); the drift walk stops past `WALK_MAX_DEPTH = 64`
  ([`src/discovery/probe-state.mjs`](../src/discovery/probe-state.mjs),
  `probe-state.mjs:44`, `:108`). Neither follows symlinks
  (`probe-state.mjs:116`), so a self-referential link cannot spin the walker.
- **Untrusted process stdout is length-capped before regex work.**
  `extractVersion` slices to 4 KiB before matching to bound regex backtracking on
  a pathological all-digit stream from a rogue executable
  ([`src/discovery/probe-cli.mjs`](../src/discovery/probe-cli.mjs),
  `probe-cli.mjs:87`).
- **Spawns are time-boxed.** Every `safeSpawn` call sets a `timeoutMs`
  (`probe-hook-syntax.mjs:84` = 10 s, `probe-cli.mjs:114` = 15 s,
  `probe-access.mjs:204` = 5 s); the gate honours it via execFile's `timeout`
  option (`safe-spawn.mjs:146-149`).

### 5.7 TOCTOU (time-of-check / time-of-use)

Concurrent edits to `~/.claude` are explicitly in scope (multiple sessions may
touch the tree). Handled detectively rather than by locking the user's config:

- The hook-syntax probe demotes a vanished-file exit to `indeterminate` instead of
  mislabelling it a syntax error (`probe-hook-syntax.mjs:89-100`, see 5.4).
- The loader probe's cleanup is in a `finally` and verifies the file is gone via
  an `existsFn` check (`probe-loader.mjs:55-62`, `:140-144`).
- For *spawned* writes (Phase 3's snapshot `tar`), the design is **detective, not
  preventive**: the syscall gate does not see a child process's writes, so they are
  bounded by the argv allowlist (`safeSpawn`) PLUS the post-hoc **spawn-write
  boundary check** ([`src/lib/spawn-write-boundary.mjs`](../src/lib/spawn-write-boundary.mjs)),
  now wired LIVE into the snapshot create path (`createSnapshot`, `src/ops/snapshot.mjs`):
  it diffs a before/after sha256 snapshot of the dir around the tar spawn and REFUSES
  the snapshot if tar wrote any undeclared file — not by the syscall gate (plan
  **P1-7**, plan line ~100). See [Residual risks](#6-residual-risks--detective-not-preventive).

### 5.8 Availability — degrading gracefully when the environment is broken

A governance tool must still inspect a *broken* config. Two mechanisms:

- **Never-throws everywhere.** Discovery, analysis, and ops modules catch their
  own errors and emit `Diagnostic`s instead of propagating exceptions (e.g.
  `readAuditLog` treats a missing log as benign and returns empty,
  `audit.mjs:155-158`; `gatherTrackedState` degrades per-file hash failures
  silently, `probe-state.mjs:77-84`). The CLI wraps its whole body so the worst
  case is a JSON error envelope, never a bare stack (P1.U15).
- **The M2 missing-hooks-lib fallback.** Importing
  [`src/paths.mjs`](../src/paths.mjs) triggers a top-level await (via
  `lib/reexport.mjs`) that **rejects** when `~/.claude/hooks/lib` is absent.
  [`src/cli/resolve-config.mjs`](../src/cli/resolve-config.mjs) catches that and
  degrades to a direct `CLAUDE_CONFIG_DIR`/`~/.claude` fallback plus a single
  `missing-hooks-lib` warn — **read commands still work; writes stay unavailable
  until the lib is restored** (`resolve-config.mjs:61-76`, `:84-99`). To keep that
  fallback intact, every `paths.mjs`-touching probe is **dynamically imported**
  under try/catch so the static graph stays `paths.mjs`-free: the loader probe in
  [`src/cli/doctor-facts.mjs`](../src/cli/doctor-facts.mjs) (`doctor-facts.mjs:161-168`)
  and `probe-state.mjs` in [`src/cli/ops-commands.mjs`](../src/cli/ops-commands.mjs)
  (`ops-commands.mjs:69-79`). A failed import becomes a `drift-unavailable` /
  `loader-probe-unavailable` warn, not a CLI crash.

### 5.9 Untrusted / malformed config parsing

- **Defensive readers.** MCP discovery tolerates a missing file (benign),
  unreadable JSON (`mcp-unreadable`), a non-object root (`mcp-malformed`), and a
  malformed per-server entry (`mcp-entry-malformed`) — each a `Diagnostic`, never
  a throw ([`src/discovery/mcp.mjs`](../src/discovery/mcp.mjs), `mcp.mjs:91-113`).
  Junk `opts` destructure safely via `?? {}` (`mcp.mjs:63`).
- **Symlinks in the config are never followed to read foreign content.** The
  snapshot walker, the drift walk, AND the discovery readers all refuse to
  dereference a symlink out of the config dir: `collectDirFiles` skips symlinked
  entries (`probe-state.mjs:125`) and `gatherTrackedState` guards both the
  TRACKED_DIRS roots and the top-level tracked FILES with `lstatSync().isSymbolicLink()`;
  [`src/discovery/components.mjs`](../src/discovery/components.mjs) `collectSkills`
  skips a symlinked `skills/<n>/SKILL.md` (emitting `component-symlink-skipped`); and
  [`src/discovery/read-json.mjs`](../src/discovery/read-json.mjs) refuses a symlinked
  `settings.json`/`.mcp.json`/plugins JSON (error-shaped result). A 2026-06-02 audit
  proved the pre-fix discovery readers leaked foreign frontmatter (a `ghp_`-shaped
  token) into `inventory --format json`; these guards close that. The existing
  `ent.isFile()` / `ent.isDirectory()` gates already covered symlinked flat
  `agents/`/`commands/` `.md` and skill DIR-symlinks. (HARDLINKS are a documented
  residual — see §6.)
- The JSONC tokenizer (P2.U1/U2) is never-throws, last-wins on duplicate keys with
  `line:column`, and produces null-prototype values — malformed input becomes
  `errors[]`, never an exception.

---

## 6. Residual risks / detective-not-preventive

This section is deliberately honest — these are real gaps or
detective-only controls today, not a victory lap.

- **Spawned-write residual TOCTOU is detective, not preventive.**
  `assertWritable` governs **direct `fs` writes only**. Phase 3's snapshot `tar`
  spawn ([`src/ops/snapshot-tar.mjs`](../src/ops/snapshot-tar.mjs)) writes via a
  child process the syscall gate does not see, so it is bounded by the **argv
  allowlist** ([`src/lib/safe-spawn.mjs`](../src/lib/safe-spawn.mjs),
  `validateSpawnSpec`, `safe-spawn.mjs:71`) plus the post-hoc **spawn-write boundary
  check** ([`src/lib/spawn-write-boundary.mjs`](../src/lib/spawn-write-boundary.mjs)),
  now wired LIVE into `createSnapshot` (`src/ops/snapshot.mjs`): it diffs a before/after
  sha256 snapshot of the dir around the tar spawn and REFUSES the snapshot
  (`snapshot-tar-wrote-undeclared`) on any undeclared write. A race between the
  spawned process and that check is a documented detective control (plan **P1-7**).
- **`update <plugin>` delegates a governed mutation to the external `claude` CLI
  (P4b.U5) — bounded, not syscall-gated.** Unlike every other write, "updating a
  plugin" requires refetching code from a marketplace (network + git), which this
  zero-network tool cannot do; so `update --apply` spawns `claude plugin update
  <key>` ([`src/ops/update.mjs`](../src/ops/update.mjs)). That spawn is bounded by
  (a) the deny-by-default argv schema `CLAUDE_PLUGIN_UPDATE_SCHEMA` (`allowedFlags:[]`
  so NO flag — incl. `--lock-version` — can reach the CLI, `positionalPattern`
  `/^[A-Za-z0-9._@-]+$/`, `maxArgs:3`, `allowSlashPositionals` unset so `/grant`-style
  flags are denied); (b) the spawn target resolved ONLY by
  [`resolveClaudeExe`](../src/lib/resolve-claude-exe.mjs) to an absolute, isFile,
  isSpawnable native exe (the Windows npm shim is unspawnable → REFUSE-with-guidance,
  never a guessed binary); (c) a defense-in-depth re-validation of the resolved
  `record.key` (not just the raw spec) BEFORE any snapshot/spawn; (d) an auto-snapshot
  of `installed_plugins.json` taken FIRST as the undo point; (e) the `--apply` write
  gate (with the `CLAUDE_MGR_ENABLE_WRITES=0` opt-out lock) + dry-run-by-default. **Residual (deliberate, user-chosen — Option A):** the
  actual code fetch + `plugins/cache/**` mutation + the required restart are performed
  by `claude`, *outside* `assertWritable` and *outside* the snapshot scope (cache is
  deliberately excluded), so a `rollback` restores the manifest but NOT the downloaded
  code — partial reversibility, surfaced as `update-cache-not-snapshotted`. The
  network I/O is `claude`'s, not the tool's; the zero-network property holds for
  claude-mgr's own code. **`mcp remove <name>` (P4b.U6) shares this exact boundary:**
  it delegates `claude mcp remove <name> [--scope ...]` via safeSpawn with its own
  deny-by-default `MCP_REMOVE_SCHEMA` (`allowedFlags:['--scope']`, `positionalPattern`
  `/^[A-Za-z0-9._-]+$/`, `maxArgs:5`); the server NAME is validated TWICE (the engine's
  `NAME_RE` additionally rejects a leading dash, so a flag-shaped name like `--scope`
  can't be smuggled past the gate's one allowed flag) and the SCOPE is enum-restricted
  to `local|user|project` before becoming an argv token. Reversibility is
  **scope-dependent**: `--scope project` mutates `.mcp.json` (snapshot-captured →
  reversible), but `--scope user`/`local` mutates `~/.claude.json` (outside the governed
  tree, NOT snapshot-captured) — surfaced as `mcp-user-scope-not-snapshotted`.
- **The Windows ACL check (#24) is advisory and read-only.** `icacls` is invoked
  read-only (`probe-access.mjs:195-206`); the tool **reports** broad principals
  but does not *fix* permissions. The parser also has a known false-positive:
  a custom principal whose last word is a broad name (e.g. `Remote Desktop Users`
  → `Users`) is flagged broad (`probe-access.mjs:140-143`). Auto-tightening
  `.mgr-state` ACLs (plan **M1**, plan line ~556) is deferred to the write phase.
- **The lock probe (#17) detects only exclusive locks.** A read-only shared open
  cannot see shared locks held by other readers
  (`probe-access.mjs:8-13`, `:53-56`) — the honest limit for a read-only tool.
- **Audit-log tamper-evidence is opt-in via `--audit-chain`.** The writer
  ([`src/ops/audit-writer.mjs`](../src/ops/audit-writer.mjs), P3.U20) computes an
  optional `prevHash` chain off the prior log bytes; the reader does not yet
  *validate* the chain, and concurrent chained appends may fork unless serialized by
  the apply lock (plan **L2**). Tamper-evidence is therefore present but best-effort.
- **Apply-journal redaction is by pointer-NAME, with a content residual.** The
  snapshot content-sniff allowlist and the `--include-auth` gate ARE implemented
  (§5.3). The apply-journal redacts each op through `redactPatchOp`
  ([`src/lib/plan.mjs`](../src/lib/plan.mjs)) — but redaction keys off the op's
  JSON-pointer NAME, so a secret VALUE written under a non-sensitively-named pointer
  would persist in the journal, and a create/overwrite op's `content` is kept
  verbatim for replay. This is **only reachable once a real plan-producing apply
  command exists** (none ships today — `apply` is engine-level plumbing for the
  future remove/update commands); closing it (shape-based journal redaction,
  mirroring §5.3's output redactor) is a HARD DoD criterion for that future unit.
- **A transiently-unreadable tracked file can surface as spurious drift.** A
  locked/EACCES file is omitted from the drift fingerprint and reads as a
  `removed` change on the next diff (`probe-state.mjs:63-84`) — best-effort by
  design, documented so the user verifies readability before assuming deletion.
- **Hardlinks are an accepted residual of the symlink-never-follow guards.** The
  §5.9 guards use `lstatSync().isSymbolicLink()`, which cannot detect a HARDLINK to a
  foreign file (a hardlink carries no link bit). Under the single-trusted-local-user
  model (§3) this is acceptable — an attacker who can plant a hardlink inside
  `~/.claude` already has the user's own FS privileges and could read the target
  directly; the TOCTOU posture (§5.7) is likewise detective.
- **CJK table width is cosmetic.** Double-width glyph alignment in the table
  renderer is a known Phase-1 display limitation; it has no security impact.
- **`safe-spawn`'s flag gate is secure-by-default for `/`-prefixed tokens
  (resolved).** Previously only `-`-prefixed tokens were treated as flags, so a
  Windows-style `/flag` was caught only incidentally (by failing a consumer's
  `positionalPattern`). The gate now treats a `/`-token as a FLAG by default —
  allowed only if listed in `schema.allowedFlags` — so an injected `/grant`,
  `/deny`, etc. is rejected with `spawn-flag-not-allowed`
  (`safe-spawn.mjs:110-116`). A consumer whose legitimate positionals are POSIX
  absolute paths (e.g. `node --check /abs.mjs` on Linux/macOS) opts out via
  `schema.allowSlashPositionals:true`, which routes `/`-tokens back to the
  `positionalPattern` branch; only the hook-syntax probe sets it
  (`probe-hook-syntax.mjs:83`). The icacls probe (#24) deliberately stays on the
  secure default, so `/grant`-style mutation flags are now blocked by the flag
  gate itself, not merely by its drive-lettered `positionalPattern`
  (`probe-access.mjs:195-209`). Residual: the `/`-token guarantee is conditional
  on the opting-out consumer supplying a TIGHT `positionalPattern` —
  `allowSlashPositionals:true` combined with a permissive pattern (e.g. `/.*/`)
  would reintroduce the gap, so any opt-out spec must keep its positional pattern
  strict.

---

## 7. Out of scope

- **Multi-user / privilege escalation.** Single trusted local user only (§3).
- **A compromised Node / npm / OS.** The toolchain is trusted (§3); the tool has
  zero runtime npm dependencies, but it cannot defend a hostile runtime.
- **Network threats.** The tool **makes no network calls** — since P5.U1 this
  is machine-enforced by the zero-network boundary invariant (§8), not only
  review-audited. (The MCP `--with-net` resolvability probe envisioned in the
  plan is *not* implemented; `gatherMcpProbes` resolves commands on `PATH` only.)
- **The contents of plugins / marketplaces the user installed.** Those subtrees
  are forbidden to write (`paths.mjs:249-251`) and their executable content is the
  user's own supply-chain decision, not `claude-mgr`'s.

---

## 8. Continuous verification

The invariants above are kept true by automated, repeatable checks — not by
trust:

- **`claude-mgr selftest --boundary`** runs these checks from
  [`src/selftest/boundary.mjs`](../src/selftest/boundary.mjs):
  1. A **runtime write-allowlist probe** (`checkWriteAllowlist`,
     `boundary.mjs:197`) that drives the **real** `assertWritable` against a
     representative matrix — allowed `.mgr-state` and `rollback` writes, denied
     `write-outside-target` / `write-forbidden` / `write-rollback-only`, and the
     three `'probe'`-context cases (allow `__mgr-probe-*.md`, deny a real agent
     name, deny a probe name in `apply`) — asserting each returns or throws the
     exact expected code (`buildAllowlistCases`, `boundary.mjs:129-155`).
  2. A **static import-graph scan** (`checkStaticImports`, `boundary.mjs:98`) over
     all `src/**/*.mjs` — including dynamic `import()` specifiers
     (`extractAllSpecifiers`, `boundary.mjs:78-86`) — that fails on any forbidden
     import prefix. The regex errs toward **false positives** by design
     (`boundary.mjs:70-73`): noise is safe, a missed forbidden import is not.
  3. The **zero-network invariant** (P5.U1, `checkZeroNetwork` in
     [`src/selftest/zero-network.mjs`](../src/selftest/zero-network.mjs)): no
     `src/` module may import a network-capable module (the `node:http`/`net`/
     `tls`/`dgram`/`dns` families plus bare and userland forms like `undici`/`ws`
     — static, dynamic, *and* side-effect import forms) or call an ambient
     network API (bare/global `fetch`, `new WebSocket`; scanned on
     comment/string-stripped projected source to avoid prose false positives).
     This turns §7's "makes no network calls" from a review-time claim into a
     gate that fails `selftest --boundary` / release-gate step 4 on regression;
     known residuals (computed specifiers, `createRequire`, aliased `fetch`)
     are documented in the module header.
- **Per-unit independent security/code review.** Every work unit has a
  *separate* `code-reviewer` pass (never self-approval); Blocker/High findings are
  fixed before commit. The write-gate change (P2.U7c-1) and each probe received a
  dedicated security pass that empirically fuzzed traversal, symlink, NTFS-ADS,
  and 8.3-short-name escapes against the real gate.
- **The never-throws test suite.** Each module has tests asserting it degrades to
  `Diagnostic`s on hostile input rather than throwing; the doctor's
  non-execution invariant has a dedicated integration test
  (`test/integration/doctor-no-hook-execution.test.mjs`).
- **The dogfood stability log.** Each unit is exercised against the *real*
  `~/.claude` and the result (e.g. "doctor reports 0 diagnostics across all 25
  checks; loader probe leaves 0 residue") is recorded in `STABILITY-LOG.md`. The
  30-day gate accumulates this evidence and feeds the expansion of this document.

---

*Revised 2026-06-02 to cover the landed Phase-3 write surface. Keep it in sync as
the apply/rollback CLI commands and the 30-day dogfood log evolve.*
