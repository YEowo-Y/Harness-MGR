# Harness-MGR Evolution Roadmap

Evidence cutoff: 2026-07-12, repository HEAD `3f2bbee35c253b70bfe127f06eaf5cd49630a1ee`.

This roadmap contains only repository-grounded follow-up work that was not approved for the current
strengthening pass. Order reflects impact, evidence strength, risk, cost, and reversibility. A
roadmap item is not implementation authorization: remote writes, permission-boundary changes, new
dependencies, major upgrades, and new state locations still require confirmation.

## Short term (no more than 1 month)

### S1. Classify the live schema-canary drift before changing its baseline

- **Goal:** Restore a meaningful live-schema signal without accepting user scratch directories as
  supported vendor schema.
- **Trigger:** Immediate. The current canary reports
  `topDirs: +[backups-audit-20260712] -[homunculus]` while the release gate remains non-blocking.
- **Impact scope:** `src/selftest/schema-baseline.json`, schema-probe classification, and operator
  runbooks; the live user config is read-only during investigation.
- **Prerequisites:** Determine the owner and lifecycle of both directories. User approval is needed
  before deleting live files or accepting a new baseline.
- **Migration steps:** Reproduce `selftest --schema-canary`; classify each delta as vendor surface,
  known temporary state, or user-owned data; add an explicit exclusion only for a stable temporary
  class; update the baseline only for verified vendor changes; pin the classification in tests.
- **Risk and benefit:** A broad exclusion could hide loader drift, while blind baseline acceptance
  creates warning fatigue. A narrow classification restores the canary's evidentiary value.
- **Acceptance:** Every current delta has an owner and reason; temporary entries are excluded by a
  documented rule; genuine vendor-surface changes still emit `schema-drift-detected`.
- **Rollback:** Revert the classification/baseline commit and retain the warning.
- **Evidence:** `src/selftest/schema-baseline.json`; `src/selftest/release-gate-seams.mjs`; the
  2026-07-12 release-gate result recorded in `STRENGTHENING_PLAN.md`.

### S2. Close the hosted-CI loop and harden workflow authority

- **Goal:** Turn the locally validated Web/release jobs and existing Node/TUI matrices into enforced
  merge evidence with least-privilege credentials and immutable Action inputs.
- **Trigger:** The next authorized push or PR, before describing this ref as remotely CI-green.
- **Impact scope:** `.github/workflows/ci.yml`, branch protection, and GitHub Actions update policy;
  no product code.
- **Prerequisites:** Push/PR authorization and repository-admin authority. Permission changes and
  branch-protection writes require explicit confirmation.
- **Migration steps:** Push the task branch; inspect every job on one commit; resolve real hosted
  OS/runtime differences; declare `permissions: contents: read`; pin external Actions to reviewed
  full commit SHAs; set Node, Web, release-gate, and TUI checks as required.
- **Risk and benefit:** A bad workflow or flaky hosted dependency can temporarily block merges;
  immutable inputs add update work. The benefit is continuous, non-bypassable cross-platform proof.
- **Acceptance:** All hosted jobs pass on the same SHA; required checks prevent an unverified merge;
  the workflow token has no write permission; every external `uses:` reference is immutable.
- **Rollback:** Revert the workflow hardening commit and, if necessary, temporarily remove only the
  failing required check while keeping local release evidence.
- **Evidence:** `.github/workflows/ci.yml` currently uses movable `@v4`/`@v5` tags and has no explicit
  `permissions`; Phase 3 records the hosted run as `Not-tested`.

### S3. Fail closed for sensitive keys whose structured values span lines

- **Goal:** Prevent a sensitive JSON/JSONC/YAML/TOML key on one line and its value on a later line
  from reaching unified or structured diff output.
- **Trigger:** Before relying on diff output for multiline configuration files, or immediately after
  a real instance is observed.
- **Impact scope:** `src/lib/redact-secrets-text.mjs`, config/snapshot/proposal diff tests, and the
  documented display contract. Arbitrary opaque values under benign keys remain excluded.
- **Prerequisites:** Approve the over-redaction/display marker for ambiguous bounded input; retain
  the 64 KiB limits and raw-change semantics established in Phase 1.
- **Migration steps:** Add a zero-leak regression for each output surface; implement a bounded,
  line-preserving sensitive-key state machine; fail closed on incomplete/oversized structures;
  repeat ordinary and adversarial benchmarks.
- **Risk and benefit:** More conservative display may hide benign context; an unbounded parser would
  add complexity and denial-of-service risk. Bounded fail-closed handling closes a reproduced leak
  shape without entropy guessing.
- **Acceptance:** Synthetic multiline sentinels never appear in any output surface; source line
  count and raw `changed` semantics remain stable; ordinary median stays below the approved 2x
  investigation threshold; adversarial scaling remains linear.
- **Rollback:** Revert the isolated redaction-policy commit; keep the regression as a documented
  expected-failure only if the product tradeoff is explicitly rejected.
- **Evidence:** A local 2026-07-12 reproduction showed a four-line JSON `token` value remained
  visible; `src/lib/redact-secrets-text.mjs`; `docs/threat-model.md`; Phase 1 residual policy in
  `STRENGTHENING_PLAN.md`.

### S4. Converge settings-layer parsing on the existing JSONC contract

- **Goal:** Ensure inventory, effective config, hooks, permissions, and doctor interpret the same
  valid settings file consistently.
- **Trigger:** Immediate: the divergence is an explicit code TODO.
- **Impact scope:** `src/cli/settings-layers.mjs` and consumers of merged settings; no schema change.
- **Prerequisites:** Lock contracts for comments, trailing commas, duplicate keys, and
  `settings.local.json`; decide whether duplicate-key diagnostics affect exit status.
- **Migration steps:** Add cross-command contract tests; reuse `readJsoncFile`; propagate precise
  duplicate-key locations; verify both settings layers and malformed-input containment.
- **Risk and benefit:** New diagnostics can change an exit code for duplicate keys. The benefit is
  eliminating false unreadable results and silently omitted effective permissions/hooks.
- **Acceptance:** Comments and trailing commas work everywhere; last-value-wins and duplicate-key
  line/column diagnostics agree; malformed files remain fail-safe; the release gate passes.
- **Rollback:** Revert the reader integration commit and preserve the strict-path diagnostic.
- **Evidence:** `src/cli/settings-layers.mjs` documents strict `JSON.parse` plus `TODO(P2)`;
  `src/discovery/settings.mjs` already uses `readJsoncFile`.

### S5. Restore repository-local authoritative documentation

- **Goal:** Make a fresh clone self-sufficient and align security documentation with shipped write
  and dependency surfaces.
- **Trigger:** Immediate. Both absolute paths declared authoritative by `AGENTS.md` are absent on the
  current host.
- **Impact scope:** `AGENTS.md`, `docs/threat-model.md`, and a stable repository-local architecture
  or decision record; no transient progress belongs in `AGENTS.md`.
- **Prerequisites:** Search Git history/backups for the original plan and memory; independently
  revalidate any decision that cannot be recovered.
- **Migration steps:** Extract stable decisions into one versioned document; replace dead absolute
  references; correct the core-CLI versus optional-MCP dependency wording and outdated future-write
  notes; add a local-link/required-reference check.
- **Risk and benefit:** Compressing history can lose context. Repository-local authority removes a
  major onboarding/recovery single point and reduces decisions based on stale claims.
- **Acceptance:** Every mandatory reference exists in a fresh clone; no authoritative `C:\Users\...`
  path remains; the threat model matches current commands and dependencies.
- **Rollback:** Revert the documentation commit while retaining recovered source material outside
  the canonical document until discrepancies are resolved.
- **Evidence:** `AGENTS.md` lines 6–7 point to missing files; `docs/threat-model.md` contains stale
  runtime-dependency and future remove/update wording; `STRENGTHENING_PLAN.md` explicitly deferred
  this debt.

### S6. Establish three-ecosystem dependency and workflow scanning

- **Goal:** Convert today's clean audit into a repeatable npm, Go, and GitHub Actions vulnerability
  and update process.
- **Trigger:** Start a regular cadence; handle any applicable high/critical advisory immediately.
- **Impact scope:** Root/Web npm locks, `tui/go.mod`/`go.sum`, Actions references, and CI policy.
- **Prerequisites:** Approve any scheduled remote workflow, dependency bot, or pinned development
  scanner; define severity SLA and ownership.
- **Migration steps:** Add machine-readable root/Web audits; select a pinned Go vulnerability source;
  separate root, Web, Go, and Actions update streams; keep major upgrades isolated; require the full
  release/Web/TUI gates on every update.
- **Risk and benefit:** Network failures and update PR churn can create noise. The process reduces
  exposure time without forcing speculative upgrades.
- **Acceptance:** Scheduled evidence is retained; no unexplained high/critical issue exceeds its SLA;
  update changes are ecosystem-scoped, reversible, and gate-green.
- **Rollback:** Disable the scheduler/bot and revert the individual lock/module/workflow commit; do
  not roll back a necessary security fix without an explicit compensating control.
- **Evidence:** Root/Web audits were 0 on 2026-07-12, but CI has no periodic audit; `package.json`,
  `web/package.json`, and `tui/go.mod` expose three distinct dependency surfaces.

## Medium term (1–3 months)

### M1. Make performance evidence repeatable and trendable

- **Goal:** Continuously detect redactor/diff superlinear behavior and Web bundle growth without
  treating noisy hosted timing as an immediate hard gate.
- **Trigger:** Changes to redaction, diff/parsing code, Web dependencies, or bundling configuration.
- **Impact scope:** Benchmark fixtures/scripts and non-blocking CI artifacts; later, evidence-backed
  thresholds.
- **Prerequisites:** Fix Node version, corpus bytes, warm-up/sample protocol, and a comparison-host
  policy.
- **Migration steps:** Encode ordinary, dense-assignment, malformed-JSON, and oversized corpora;
  emit p25/p50/p75 and size slope; record Web gzip bytes; collect at least three stable runs before
  making any threshold blocking.
- **Risk and benefit:** Shared-runner variance can false-alarm. Relative ratios and slope checks
  preserve useful denial-of-service evidence and catch bundle bloat early.
- **Acceptance:** 4–60 KiB hostile scaling remains near-linear; ordinary median above 2x is flagged;
  Web gzip changes are compared with an approved budget.
- **Rollback:** Make the check informational while retaining artifacts; never relax security caps or
  redaction to satisfy a timing target.
- **Evidence:** Phase 1 recorded reproducible percentiles and removed two O(n^2) paths; Web's current
  JS baseline is 366.23 kB / 115.10 kB gzip; there is no benchmark package script.

### M2. Verify and serialize the optional audit hash chain

- **Goal:** Make hash-chain integrity testable before audit output is used for recovery decisions or
  forensic claims.
- **Trigger:** Before describing the log as tamper-evident, or before multiple writers use chained
  appends.
- **Impact scope:** `src/ops/audit-writer.mjs`, audit reader/CLI, apply locking, fixtures, and possibly
  the audit schema version.
- **Prerequisites:** Choose legacy unchained-log behavior and whether chain mode remains opt-in.
- **Migration steps:** Define genesis/version semantics; serialize chained tail-read+append under the
  apply lock; add `audit --verify-chain`; test mutation, deletion, reordering, and fork detection.
- **Risk and benefit:** Old/manual logs can warn and lock coupling adds complexity. Verification turns
  a best-effort field into an explicit integrity contract.
- **Acceptance:** All four corruption classes identify a stable first break; valid logs and the
  chosen legacy mode do not false-alarm; concurrent chain writes cannot fork.
- **Rollback:** Disable chain generation/verification while retaining the legacy metadata reader.
- **Evidence:** `src/ops/audit-writer.mjs` reads the prior line without serialization;
  `docs/threat-model.md` explicitly says the reader does not verify and concurrent chains may fork.

### M3. Add an offline recovery exercise for the `.mgr-state` single point

- **Goal:** Recover when the governed config and its colocated local snapshots are lost together.
- **Trigger:** Regular use of real write commands, or before `.mgr-state` becomes the only rollback
  source.
- **Impact scope:** Initially a runbook and sandbox exercise; a future export/import command would
  expand the write and secret-storage boundary and needs separate approval.
- **Prerequisites:** User-selected external location, owner-only ACL/encryption policy, and explicit
  treatment of snapshots that intentionally contain original secrets.
- **Migration steps:** Export only completed, hash-verified recovery bundles; restore into a temporary
  config root; compare manifest, modes, and bytes; schedule periodic exercises; consider a gated
  offline exporter only after the manual contract is proven.
- **Risk and benefit:** External copies expand the sensitive-data surface. A verified offline copy
  removes the current same-root/same-disk disaster-recovery single point.
- **Acceptance:** After deleting a sandbox config and its `.mgr-state`, the external bundle restores
  the governed surface byte-for-byte and passes integrity/permission checks.
- **Rollback:** Remove the exporter and external copy, returning to the documented manual runbook and
  existing local snapshots.
- **Evidence:** `src/paths.mjs` fixes state under `<targetClaudeDir>/.mgr-state`; snapshot traversal
  deliberately excludes that state; existing chaos tests prove local rollback, not media-loss
  recovery.

### M4. Exercise Windows POSIX wrapper parity on a real supported runtime

- **Goal:** Distinguish honest local capability skips from an actual support claim for Git Bash or
  WSL with Node 24.
- **Trigger:** A documented Windows-POSIX support promise, or a hosted Windows runner that continues
  to skip both runtime parity legs.
- **Impact scope:** Test environment and CI matrix; product wrapper only if a real parity failure is
  reproduced.
- **Prerequisites:** Install/discover a supported Node inside the chosen POSIX runtime and define
  which runtime is supported.
- **Migration steps:** Add a dedicated smoke lane with skip forbidden; run core parity and neutral-CWD
  tests; record shell-native root paths; keep the generic Windows job capability-based.
- **Risk and benefit:** Extra toolchain setup costs time and can be flaky. It closes the only current
  platform execution gap without turning missing optional tooling into a product failure.
- **Acceptance:** Both runtime legs execute, not skip, on the declared runtime and match direct Node
  stdout/exit bytes.
- **Rollback:** Remove the dedicated lane and narrow the documented support claim; keep structural
  wrapper tests.
- **Evidence:** `test/integration/posix-entry-parity.test.mjs` and
  `test/helpers/posix-shell-capability.mjs`; the current Windows host lacks a complete runtime, while
  `harness-mgr.sh` retains LF and executable mode.

### M5. Model the bundled loader tier only from version-matched evidence

- **Goal:** Detect bundled-versus-user component shadowing without fabricating precedence.
- **Trigger:** A `loader-rules-unverified-version` diagnostic or a captured bundled/user name
  collision.
- **Impact scope:** Source records, discovery, `load-order.mjs`, conflicts/advice, and golden tests.
- **Prerequisites:** Version-matched official documentation or a reproducible local loader probe.
- **Migration steps:** Capture actual load order; introduce a bundled tier in the single precedence
  source; add real/synthetic collisions; preserve `likely` confidence outside verified versions.
- **Risk and benefit:** Incorrect precedence is worse than conservative omission. Evidence-backed
  modeling closes a known analysis blind spot.
- **Acceptance:** Probe and ranking agree for the supported version; bundled/user fixtures identify
  the correct winner; unknown versions never claim a verified winner.
- **Rollback:** Remove the tier and return to conservative `likely` results.
- **Evidence:** `src/analysis/conflicts.mjs` explicitly documents the unmodeled bundled tier;
  `src/analysis/load-order.mjs` guards verified rules by version.

## Long term (more than 3 months)

### L1. Redesign journal payloads before arbitrary content-bearing PlanOps

- **Goal:** Prevent create/overwrite content or secrets under benign pointers from becoming
  plaintext recovery state while retaining crash recovery.
- **Trigger:** Hard gate before any CLI, Web, TUI, or MCP surface accepts arbitrary content-bearing
  operations.
- **Impact scope:** Plan and journal schema, replay/recover, version migration, ACL/encryption, and
  zero-leak tests.
- **Prerequisites:** Choose hash+snapshot reconstruction versus an owner-only encrypted payload;
  define old-journal compatibility.
- **Migration steps:** Add shape/content-aware protection; bump journal version; migrate or explicitly
  refuse old states; test every op shape for byte-level secret absence and successful recovery.
- **Risk and benefit:** Removing replay material can break recovery, while encryption introduces key
  lifecycle risk. A gated redesign prevents a dormant boundary from becoming an exploitable one.
- **Acceptance:** No synthetic secret appears in journal/audit bytes for any supported op; crash
  recovery remains successful; old versions are handled explicitly.
- **Rollback:** Continue reading the previous schema and disable all new arbitrary-content commands.
- **Evidence:** `src/ops/apply-journal-writer.mjs` preserves non-sensitive `content` for replay;
  current real callers use constrained shapes, so this is a trigger-bound future gate rather than a
  present exploit.

### L2. Migrate runtimes and framework majors by lifecycle, one ecosystem at a time

- **Goal:** Avoid unsupported Node/Go/framework versions without combining unrelated breaking
  upgrades.
- **Trigger:** Maintenance/end-of-support windows, runner removal, or a security fix available only
  in a new major.
- **Impact scope:** Root/Web Node, TUI Go, dependencies, CI, and performance/output contracts.
- **Prerequisites:** Version-specific official compatibility evidence, lock/module snapshots, and a
  temporary dual-version matrix.
- **Migration steps:** Upgrade one ecosystem; dual-run old/new; repeat release, Web, TUI, audit, and
  performance checks; remove the old runtime only after two green cycles.
- **Risk and benefit:** Major upgrades can change output or runtime semantics. Isolation and dual-run
  evidence make the migration reversible and prevent a multi-ecosystem failure cliff.
- **Acceptance:** Both versions pass during transition; no unexplained output, security, or
  performance drift; the new pins and locks are reviewable and clean.
- **Rollback:** Restore the previous runtime pin and its matching lock/module commit.
- **Evidence:** `.nvmrc` and CI select Node 24; `tui/go.mod` pins the Go line; Web contains several
  independently versioned framework/toolchain majors.

### L3. Consider an independently located state root only after recovery evidence demands it

- **Goal:** Remove the long-term same-root storage coupling without casually expanding the write
  boundary.
- **Trigger:** Offline recovery exercises show that bundles are operationally insufficient, or a
  real media-loss requirement is adopted.
- **Impact scope:** Public CLI configuration, path/write gates, migrations, ACLs, discovery, and
  rollback. This is an architecture and state-location change requiring fresh approval.
- **Prerequisites:** Stable M3 export/restore evidence, a user-selected location, cross-platform path
  rules, and a secrets-at-rest policy.
- **Migration steps:** Add an opt-in path; canonicalize and gate it; migrate by verified copy; run
  both roots during a bounded transition; retain rollback to the colocated default.
- **Risk and benefit:** A second writable root increases path/symlink and confidentiality risk. When
  justified, it separates the recovery control plane from the protected data's failure domain.
- **Acceptance:** Traversal/symlink escapes are denied; old and new roots round-trip byte-identically;
  interrupted migration is recoverable; default behavior remains unchanged until explicitly chosen.
- **Rollback:** Point back to `<targetClaudeDir>/.mgr-state` and remove the verified external copy.
- **Evidence:** The current invariant in `src/paths.mjs` intentionally colocates state; no current
  media-loss incident justifies implementing this before M3 evidence.

## Contingency playbooks

### Single-point-of-failure contingency

If `.mgr-state`, the archive tool, or manifest verification is unavailable, set
`HARNESS_MGR_ENABLE_WRITES=0`, remain read-only, and do not use `--force` to bypass snapshot or
integrity checks. Restore only from a completed, hash-verified, owner-protected offline bundle into a
sandbox before touching the live root.

### Performance contingency

If ordinary input exceeds the comparable 2x baseline or hostile inputs become superlinear, block the
responsible release and revert/bisect the responsible commit. Do not regain speed by increasing the
64 KiB exposure window, weakening fail-closed behavior, or skipping secret filtering.

### Dependency contingency

For an applicable high/critical issue, freeze unrelated upgrades, identify the affected surface, and
run the full ecosystem gates. Disable an optional MCP server or Web surface when that safely reduces
exposure; keep the core local CLI available when unaffected. Restore the exact prior lock/module only
when the vulnerability is proven inapplicable or an explicit compensating control exists.

### Security contingency

On any reproduced secret leak or write-boundary escape, set `HARNESS_MGR_ENABLE_WRITES=0`, stop
sharing the affected output, preserve only secret-safe evidence, rotate exposed credentials, and
inspect journal/audit/snapshot copies. Fix the exact syntax or path shape with a non-weaponized
regression test; do not introduce unbounded parsing or repository-wide entropy guessing.
