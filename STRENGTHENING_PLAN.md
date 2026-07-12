# Repository Strengthening Plan

## Recovery state

- Status: `executing`
- Approved: 2026-07-12 (all four phases)
- Current phase: Phase 2 — independent review and local commit
- Branch: `config-diff-redaction`
- HEAD at approval: `2a1e6128d998cb84807e4813c02376e01ecc18b1`
- Worktree at approval: clean; branch was 8 commits ahead of `main` and aligned with its upstream
- Worktree now: 6 task-owned changed/untracked paths; no staged files
- Last verification: 2026-07-12T10:46:44-04:00
- Blockers: none
- Next action: resolve the independent Phase 2 review, inspect/stage the owned diff, and create its
  Lore-protocol local commit

## Approved scope

1. Close the reproduced diff-output secret leaks while preserving raw change semantics.
2. Restore an honest full-test/release-gate baseline by fixing POSIX-shell capability detection.
3. Add Web test/typecheck/build and the repository release gate to CI without new dependencies.
4. Re-run all applicable checks, obtain an independent read-only review, update this recovery file,
   and publish `EVOLUTION_ROADMAP.md`.

Routine, reversible edits and local Lore-protocol commits inside this scope are approved. No branch
switch or remote mutation is authorized.

## Explicit exclusions

- No push, PR, deployment, release, production/cloud write, branch switch, rebase, amend, reset,
  clean, or stash.
- No public API, data-model, schema, authentication, or authorization-boundary change.
- No new production dependency, major upgrade, framework replacement, or architecture rewrite.
- No entropy-based attempt to guess every arbitrary bare secret and no parser overhaul.
- No Web redesign or multi-platform Web CI matrix.
- Do not rewrite `AGENTS.md`/`CLAUDE.md` with temporary task state. Their missing historical external
  references are recorded as documentation debt for the roadmap unless an authoritative replacement
  is discovered.

## Baseline and decisive evidence

### Security and correctness

- `src/analysis/redact-secrets-text.mjs` returns a line over 64 KiB unchanged; a synthetic 70 KiB
  single-line credential was reproduced verbatim in `config diff` output.
- Line-wise redaction masks a PEM BEGIN header but leaves its body lines verbatim.
- Common sensitive-key forms in JSON, YAML, and TOML were reproduced verbatim in `config diff`.
- Diffing redacted text collapses secret-only rotations: file mode returned `changed:false`, and
  `proposeSkill` returned unequal raw hashes together with `changed:false` / `propose-no-change`.
- `src/ops/propose.mjs` and `src/ops/snapshot-diff.mjs` import `src/analysis/**`, contradicting the
  documented ops-layer contract; the current static boundary does not catch the violation.

### Test and engineering baseline

- Targeted redaction/config-diff/propose tests: 51 passed, 0 failed, but lacked the hostile cases.
- `node src/cli.mjs selftest --all --format json`: passed.
- `npm test`: 3522 tests; 3519 passed, 2 failed, 1 skipped. Both failures are the pre-existing POSIX
  wrapper tests selecting Windows WSL `bash.exe`, which can run `exit 0` but has no `node` command.
- `selftest --release-gate`: stopped at step 1 (`catalog-tests`) because of those two failures.
- Declared-runtime Web baseline (Node 24): 278 Vitest + 24 server tests passed; `tsc --noEmit` and
  production build passed. Build output was 366.23 kB JS / 115.10 kB gzip.
- TUI: `go test ./...`, `go vet ./...`, and `go build ./...` passed.
- Root and Web `npm audit --json`: 0 known vulnerabilities.
- Redactor microbaseline on Node 24.14.0: 238,015-byte multiline corpus median 14.842 ms; 524,328-byte
  single line median 0.027 ms (25 measured iterations after warm-up).

### Known pre-existing failure

- `test/integration/posix-entry-parity.test.mjs` has two environment-capability failures on this
  Windows host. The test only proves `bash -c 'exit 0'`, then assumes that shell can run `node` and
  understands the MSYS path form. Phase 2 owns this baseline failure.

## Decisions

- Oversized diff lines fail closed: replace the display line with a marker instead of returning raw
  text. This security/display tradeoff was explicitly approved.
- Raw text determines `changed`, stats, and line alignment; only emitted display text is redacted.
- Multi-line PEM bodies are redacted line-for-line so source line numbers remain stable.
- Sensitive keyed-value support reuses the existing sensitive-name vocabulary and includes benign
  false-positive guards (`public-key`, `key-id`, etc.).
- An unusable WSL shell (no in-shell Node runtime) is a skipped capability, not a product failure;
  usable POSIX environments retain full parity coverage.
- Web CI is one Node-24 Ubuntu job; release-gate CI uses full Git history and `origin/main` as base.
- No performance improvement will be claimed without a comparable before/after measurement.

## Phase 1 — secret-safe diff semantics and layer repair

### Goal and evidence

Close the four reproduced high-impact leak/correctness cases and prevent the layer violation from
returning.

### Scope

- Add regression tests for oversized single lines, complete PEM blocks, JSON/YAML/TOML sensitive
  keys, secret-only rotations, and every unified/structured output surface.
- Compute raw diff semantics before output redaction; preserve stats/hunks/line numbers.
- Fail closed on oversized lines and preserve line count across PEM blocks.
- Move reusable redaction below the ops layer or otherwise restore the documented dependency graph.
- Add a path-aware static layer invariant and update threat-model/comments to match real behavior.

### Acceptance

- All nine redaction/config-diff/snapshot-diff/propose-related test files pass.
- `node src/cli.mjs selftest --all --format json` passes.
- No synthetic secret appears in unified or structured diff output.
- Repeat the approval-time microbenchmark; investigate a greater-than-2x ordinary-input slowdown.
- `git diff --check` passes; staged diff contains only owned paths.

### Risks, dependencies, rollback

- Risks: over-redaction, diff alignment drift, regex cost, accidental layer inversion.
- Dependencies: none; no package changes.
- Rollback: revert the single Phase 1 local commit.

### Execution evidence (current worktree)

- RED evidence captured before implementation: hostile config/diff tests reproduced compact TOML,
  asymmetric equal-context PEM, oversized PEM-BEGIN state loss, quoted command values, structured
  JSON containers, and side-effect-import gate gaps; a separate propose test reproduced CRLF-only
  bytes being reported unchanged.
- GREEN evidence: 281 affected redaction/config-diff/snapshot/propose/output/boundary tests passed;
  `selftest --all` passed with no diagnostic.
- Full `npm test`: 3541 tests; 3538 passed, 2 failed, 1 skipped. The two failures are byte-for-byte
  the approved Phase 2 POSIX capability baseline; there is no unexplained new failure.
- Comparable Node 24.14.0 benchmark (15 warm-ups + 101 samples): 238,015-byte ordinary corpus
  p25/median/p75 = 15.560/17.029/20.070 ms versus approval median 14.842 ms (+14.74%); five
  independent 25-sample processes had a 16.203 ms median-of-medians (+9.17%). The 524,328-byte
  fail-closed line measured 0.1283/0.1505/0.1615 ms. No speedup is claimed.
- Adversarial performance review reproduced and then eliminated two O(n^2) paths: a 60 KiB dense
  assignment line fell from 6963 ms to 8.23 ms in the regression test, and a 65,520-byte malformed
  JSON tail fell from 3336 ms to 15.6 ms. Independent 4–60 KiB scaling for dense assignments and
  both malformed-JSON variants is linear (roughly 0.04–0.11 ms/KiB).
- `git diff --check` and the repository lint/invariant/boundary gates passed.
- Residual policy remains explicit: arbitrary opaque values under benign names and parser-complex
  multi-line structured values are not guessed; raw inputs exist transiently inside the local diff
  computation but only redacted copies reach result/render surfaces.
- Independent read-only closeout review: `APPROVE`, with no Blocker/High/Medium/Low finding after
  reproducing the leak cases, adversarial scaling, 86 related tests, `selftest --all`, and
  `git diff --check`.

## Phase 2 — trustworthy POSIX capability detection and release gate

### Goal and evidence

Make the full suite distinguish a usable POSIX+Node runtime from a shell executable that cannot run
the wrapper.

### Scope

- Strengthen the parity-test capability probe and its regression coverage.
- Preserve wrapper behavior and parity coverage on capable environments.
- Repair any directly exposed release-gate defect required to make the approved acceptance command
  trustworthy; do not weaken coverage thresholds or suppress live-file failures.

### Acceptance

- `node --test test/integration/posix-entry-parity.test.mjs` passes or capability-skips honestly.
- `npm test` passes with no unexplained new skip/failure.
- `node src/cli.mjs selftest --release-gate --base main --format json` passes.

### Risks, dependencies, rollback

- Risk: an over-broad probe could hide real wrapper regressions.
- Dependency: Phase 1 must be green first.
- Rollback: revert the single Phase 2 local commit.

### Execution evidence (current worktree)

- RED capability evidence: the first regression test failed with `ERR_MODULE_NOT_FOUND`; after the
  helper existed, expanded tests rejected launch-only shells, Node below the supported major, thrown
  spawns, and ambiguous/non-absolute `pwd -P` output. The real Windows WSL launcher still returns
  status 127 because it has no in-shell Node and is therefore not selected.
- The structural wrapper test now always runs. Runtime parity skips only on Windows when no complete
  POSIX+Node runtime exists; non-Windows absence fails. Once selected, spawn errors, exit-status
  drift, and stdout drift are assertions rather than skip paths. `harness-mgr.sh` is unchanged.
- Shell-native `pwd -P` drives wrapper and fixture paths, covering Git Bash `/c/...`, WSL
  `/mnt/c/...`, and native POSIX without guessing a mount convention.
- A second RED failure exposed a release-gate defect: `git diff --name-only` returned a deleted
  pre-move module, while c8 can only report executable current files, so the deletion was treated as
  0% covered. The live-file filter now excludes only `D`, retains `A/C/M/R/T/U/X/B`, and includes
  untracked `.mjs` files even with `--base`.
- A hermetic temporary-repository test pins a pure deletion, an explicitly verified `R100` rename,
  and an untracked source file; only the rename destination and untracked live file are gated.
- Focused POSIX/release-gate tests: 24 tests; 22 passed, 0 failed, 2 honest Windows capability skips.
  The release-gate seam suite separately passed 18/18 after the R100 fixture hardening.
- Full `npm test`: 3545 tests; 3542 passed, 0 failed, 3 skipped. Two skips are the approved Windows
  POSIX runtime legs; the third is the pre-existing baseline skip.
- `selftest --all` passed with no diagnostics. `selftest --release-gate --base main` passed all
  blocking steps: catalog, 16 live changed modules at >=80% line/>=70% branch coverage, invariants,
  boundary, lint, and doctor (29 checks, 0 errors).
- The release gate emitted one non-blocking live-harness schema warning: top-level config dirs changed
  from `homunculus` to `backups-audit-20260712`. This is external state, not a repository regression;
  no baseline update or governed-config write was made.
- `git diff --check` passed. Real Git Bash or WSL with Node 24 is not available locally; the path
  variants are covered through injected capability-probe tests and remain for CI execution.
- Independent read-only closeout review: `APPROVE`, architecture `CLEAR`, with 0
  Blocker/High/Medium/Low findings after inspecting the current diff and reproducing 24 focused
  tests (22 pass, 2 honest capability skips).

## Phase 3 — CI coverage for Web and the release gate

### Goal and evidence

Prevent Web or repository release-gate regressions from merging behind a green root/TUI matrix.

### Scope

- Add a stable Web `typecheck` script.
- Add one Node-24 Ubuntu Web CI job for root/Web install, tests, typecheck, and build.
- Add one Ubuntu release-gate job with full Git history and `origin/main` coverage base.

### Acceptance

- `npm --prefix web test`, `npm --prefix web run typecheck`, and `npm --prefix web run build` pass.
- The release-gate command passes locally.
- Workflow diff is independently reviewed. A real GitHub run remains `Not-tested` without separate
  push authorization.

### Risks, dependencies, rollback

- Risk: roughly one minute additional CI time or workflow-only syntax failure.
- Dependencies: Phases 1–2 green; no new package.
- Rollback: revert the single Phase 3 local commit.

## Phase 4 — final evidence, independent review, and roadmap

### Goal and scope

- Re-run every applicable Node/Web/Go/selftest/audit check on current HEAD.
- Obtain an independent read-only review against this plan, actual diff, and verification output.
- Resolve or explicitly reject every finding with evidence.
- Create `EVOLUTION_ROADMAP.md` with short (<=1 month), medium (1–3 months), and long (>3 months)
  horizons plus SPOF, performance, dependency, and security contingencies.
- Mark this file `complete` only when every approved acceptance criterion is met.

### Final acceptance

- Root: `npm test`, `selftest --all`, and release gate pass.
- Web: tests, typecheck, and build pass.
- TUI: test, vet, and build pass.
- Root/Web dependency audits report no unresolved high/critical issue.
- Independent review has no unresolved high-risk finding.
- Worktree/staged diff contains only expected changes; local commits are cohesive and verified.

### Rollback

Each phase is a separate local commit; revert the affected commit(s). No remote state is changed.

## Completed commits

- `6e7296ae77129de472e0fbe84ec06a08075bdf98` — Phase 1, secret-safe raw diff semantics,
  fail-closed redaction, performance hardening, and ops-layer boundary. Verified with 86 focused
  tests, `selftest --all`, full `npm test` (only the two approved Phase 2 failures), adversarial
  scaling, `git diff --check`, and independent closeout `APPROVE`.

The eight commits between `main` and the approval HEAD predate this plan and remain protected as
existing work.
