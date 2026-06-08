# claude-mgr — Stability Log

Empirical findings from dogfooding the read-only tool against the real `~/.claude` harness
during the Phase-1 → Phase-2 stability gate. Log every false positive, false negative,
crash, or surprise — with the date, root cause, and resolution.

## 2026-05-24 — doctor #8/#10 keyed off the wrong "enabled" signal (false positive + latent false negative)

**Found during:** P2.U5a dogfood round (`inventory`/`conflicts`/`orphans`/`selftest` via the
wired CLI, plus the not-yet-wired doctor exercised over real scan facts).

**Observed:** `#8 plugin-installed-not-enabled` fired for ALL 14 installed plugins
("installed but disabled") — yet every one is actively in use (`#7` found 0
enabled-not-installed, and the settings `enabledPlugins` map carries all 14 as `true`).

**Root cause:** `#8`/`#10` read each install record's OWN `enabled` field (from
`installed_plugins.json`). On the real harness all 14 entries have `enabled:false`, while the
settings `enabledPlugins` map marks all 14 `true`. **The settings `enabledPlugins` map is the
authoritative enable signal; `installed_plugins.json`'s per-entry `enabled` is `false` even
for active plugins.** The `plugins-groundtruth` fixture had `enabled:true` for every entry,
which masked the gap — the assumption passed unit tests AND code review but not the harness.

**Impact:**
- `#8`: 14 false-positive `info` diagnostics on a healthy config.
- `#10 plugin-cache-missing`: latent false NEGATIVE — it would miss a missing cache on any
  enabled plugin because every record reads `enabled:false`. (On 2026-05-24 the harness
  happened to have all 14 caches present, so the live count was 0 regardless.)

**Resolution:** `#8` and `#10` now read the settings `enabledPlugins` map (the same
authoritative source as `#7`). `#8` = installed AND not settings-enabled → info; `#10` =
settings-enabled AND `cachePresent === false` → warn. Fixture tests updated to supply an
`enabledPlugins` map. See the corrected unified model in `src/analysis/doctor/index.mjs`.

**Lesson:** Validate fixture-encoded assumptions about EXTERNAL tool behavior against the real
harness before trusting them — unit tests + review cannot catch an unfaithful fixture.

## 2026-05-25 — Phase-2 gate consolidated dogfood (P2.U12): all commands clean, no defects

**Found during:** P2.U12, the Phase-2 gate. P2.U11 had just wired `doctor`/`drift`/`audit` into
the CLI (joining `permissions audit` from U8 + the read commands from Phase 1), so for the first
time the COMPLETE Phase-2 surface is user-runnable end-to-end. This is the gate validation pass.

**Run (real `~/.claude`, no `--config-dir`, `--format quiet`):** `inventory`, `conflicts`,
`orphans`, `config show-effective`, `hooks`, `permissions --audit`, `doctor`,
`doctor --active-probes`, `drift`, `audit`, `selftest --all`.

**Observed — every command exit 0:**
- Read commands (`inventory`/`conflicts`/`orphans`/`config show-effective`/`hooks`/`drift`/`audit`/`selftest --all`): **0 errors, 0 warnings.**
- `permissions --audit`: 0 errors, **14 warnings** — the 14 genuine overbroad `allow` wildcards the user has configured (`Edit(*)`/`Write(*)`/`NotebookEdit(*)`/`mcp__*`/`WebFetch(domain:*)`/`Skill(…:*)`/several `Bash(…:*)`). Advisory, not a defect.
- `doctor` (passive, 25 checks, 22 ran): 0 errors, **14 warnings** (the same #23 overbroad-permission advisories) **+ 18 #12 `orphan-files` infos** (real CC runtime files — `history.jsonl`, logs, `.last-cleanup`, OMC state, `CLAUDE.md.backup.*` — that the conservative `KNOWN_TOP_FILES` doesn't yet list; this exactly mirrors the `orphans` command output, so it is faithful reporting, not a doctor bug).
- `doctor --active-probes` (all 3 active checks ran): identical 0 errors / 14 warnings — #4 hook-syntax 0 findings, #15 cli 0 findings, #19 loader-probe 1 *info*. The loader probe wrote `agents/__mgr-probe-<uuid>.md`, observed it via discovery, and removed it: **post-run residue check = 0** (`ls ~/.claude/agents/__mgr-probe-*` → none).
- `drift`: read-only by default — afterwards **`~/.claude/.mgr-state` does not exist**, confirming the dry-run-by-default contract (only `drift --update` writes the baseline lockfile, separately verified in U11).
- `audit`: 0 entries (benign — the audit-log WRITER is Phase-3 P3.U20, so the log is legitimately absent).

**Root cause / resolution:** none — no false positive, false negative, crash, or surprise. The
only non-clean output is the 14 overbroad-permission warnings + 18 orphan infos, both of which are
TRUE facts about the live config, surfaced for the user's awareness.

**Carried (non-blocking) follow-ups confirmed still open:** (1) expand orphan-detector
`KNOWN_TOP_FILES` so the 18 #12 infos shrink to genuine orphans (de-dups with #13 backup
ownership); (2) `safe-spawn`'s flag gate only rejects `-`-prefixed tokens (`/flag` would slip) —
harden before more Windows spawners arrive; (3) drift's tracked surface omits
`installed_plugins.json`/`known_marketplaces.json`/`.mcp.json` (plugin/MCP config drift not
detected). None block the gate.

**Lesson:** A read-mostly tool's "clean" gate is *exit 0 with zero ERROR-severity diagnostics* —
warnings/infos that faithfully report real config facts (overbroad perms, orphan files) are the
tool WORKING, not failing. Tag `phase-2-stable`; the 30-day stability gate begins.

## 2026-05-26 — active-probe dogfood clean + orphan-noise follow-up (#1) resolved

**Found during:** wiring the Doctor's active probes into the TUI front-end (Go), which shells out
to the Node CLI `doctor --active-probes --format json`; plus a re-check of carried orphan-noise
follow-up (1).

**Observed — active probes (real `~/.claude`, `doctor --active-probes --format json`):** exit 0;
envelope `{command,diagnostics,result,version}`, `result.probeLevel:active`, 25 checks. All 3
active checks ran — #4 `hook-node-syntax` 0 findings, #15 `claude-cli-resolvable` 0 findings,
#19 `loader-probe` 1 *info* (the honest "precedence best-effort (likely); claude version
unknown"). Post-run residue check: **0 `__mgr-probe-*` files** in `~/.claude/agents` — the #19
transient governed-dir write was written, observed via discovery, and cleaned up. No false +/−, no crash.

**Observed — orphan follow-up (1) now RESOLVED:** the carried follow-up "expand orphan-detector
`KNOWN_TOP_FILES`" landed in commits `2366da0` + `decd873` — `KNOWN_TOP_FILES` +
`KNOWN_TOP_FILE_PATTERNS` (`security_warnings_state_*` / `CLAUDE.md.backup.*` / `.omc-*.json`) +
`KNOWN_ECOSYSTEM_TOP_DIRS` (`.omc` / `homunculus` / `metrics` / `session-data` / `teams`).
Real-harness re-check: `orphans` = **hard 0 / soft 0 / total 0**; doctor **#12 `orphan-files` = 0**
(was 16–18 at the U6a/U12 gate). The 31 orphan-detector/orphans unit tests stay green; #13
`claude-md-backup-bloat` still independently owns the backup "too many" judgment (no double-count).

**Root cause / resolution:** none needed — both clean. The orphan list was intentionally
conservative at U11 (orphans are facts; the doctor judges); it is now widened to real ground truth.
CLAUDE.md carried follow-up (1) marked ✅ resolved.

**Lesson:** the build-cursor follow-up list can lag the code — the orphan expansion was already
committed before this check, so verifying against the live harness + `git log` beats trusting the
cursor snapshot. Reinforces the read-the-code-first rule on a shared multi-session tree.

## 2026-05-27 — CC 2.1.146 → 2.1.152 update: full read-only dogfood clean, discovery survived the version bump

**Found during:** Claude Code updated from 2.1.146 (the gate-start baseline) to **2.1.152** during
the stability-gate window — the trigger event for the gate's "≥1 CC release" condition. Ran the full
command surface against the live `~/.claude` to confirm the discovery layer survived the version change.

**Run (real `~/.claude`, `--format quiet`):** `inventory`, `conflicts`, `orphans`, `hooks`, `drift`,
`audit`, `config show-effective`, `permissions --audit`, `doctor`, `selftest --all`.

**Observed — every command exit 0, no crash, no new error:**
- Read commands + `selftest --all`: **0 error / 0 warn** — identical to the 2026-05-26 baseline.
- `permissions --audit` + `doctor`: 0 error / **16 warn** — UP from **14** at baseline. The 2 new
  entries are two path-scoped `Read(...**)` allow-globs that appeared in `settings.json` since:
  `Read(//c/Users/alice/.claude/plans/**)` and `Read(//c/Users/alice/AppData/Local/Temp/**)`. These
  are genuine new `allow` rules (read-only, path-scoped, with `**`), **NOT CC 2.1.152 defaults**
  (they are user-specific absolute paths — added by normal CC session use, then persisted). The tool
  correctly flags them per #23 (any `allow` entry containing `*`).

**Root cause / resolution:** none — no false positive, false negative, crash, or surprise. The 14→16
delta is the tool FAITHFULLY reporting 2 genuinely-new overbroad-by-the-rule Read globs in the live
settings, not a CC-update regression. Discovery (components/plugins/marketplaces/mcp/settings) and all
25 doctor checks produce identical results across the 2.1.146 → 2.1.152 bump.

**Gate impact:** the **"≥1 Claude Code release" condition is now SATISFIED** and the schema-canary risk
(CC changing config schema/format and silently breaking discovery) is **RETIRED** — the tool survived a
real CC version transition with zero regression, the only delta being 2 faithfully-reported new config
rules. (The 30-day calendar soak is ~2 days in; that duration is a separate, softer "confidence over
time" measure, not the schema-canary signal.)

**Note (reinforces carried follow-up):** the 2 new `Read(dir/**)` entries are path-scoped read-only
globs — far more benign than `Edit(*)` / `Bash(curl:*)`. #23's flat "contains `*` ⇒ overbroad" stays
conservative; a future severity-ranking refinement would rank scoped `Read(dir/**)` below a bare
`Edit(*)` (already flagged as a possible refinement on 2026-05-25).

**Lesson:** a CC version bump is the gate's KEY TEST EVENT, not merely a waiting milestone — dogfood
immediately on update. The discovery layer surviving 2.1.146 → 2.1.152 with the only delta being 2
faithfully-reported new config rules is the strongest gate signal to date.

## 2026-05-29 — gate-exit infrastructure shipped; `selftest --release-gate` green on CC 2.1.156

**Found during:** the user-directed "build gate-exit infra before resuming U5" mini-phase (executing the
2026-05-29 multi-agent review's resequencing). Built via a dynamic workflow (build→review→fix) + a
round-2 hardening pass; two independent opus code-reviewer APPROVEs (0 Blocker / 0 High).

**Built:** `selftest --release-gate` — a 6-step orchestrator (1 catalog-tests / 2 changed-file ≥80%
line coverage / 3 invariants / 4 boundary / 5 lint / 6 doctor-passive; abort-on-first-failure; exit
0=pass, 2=step 1-5 fail, 1=step 6 fail) — plus the `c8` dev-dependency + coverage scripts and this
machine-countable `STABILITY-LOG.jsonl` sibling (`{ts, cc_version, gate_pass, error_diag_count}` per
run; `src/ops/stability-log.mjs::countGatePass` tallies the ≥20 exit condition). 4 historical runs
back-filled + this one = **5 `gate_pass:true` rows**.

**Observed (real `~/.claude`, live):** `node src/cli.mjs selftest --release-gate --format json` →
**exit 0, `pass:true`, all 6 steps pass**, 0 diagnostics. Step 6 doctor passive = **25 checks, 0
errors** on **CC 2.1.156**. Full suite **1195 / 0 fail** (+73).

**Gate signal — 3rd CC release survived:** the window has now seen 2.1.146 → 2.1.152 → **2.1.156**
with zero discovery regression. The schema-canary RISK stays retired; the schema-fingerprint-canary
MECHANISM (review item C) is still unbuilt.

**A real bug the end-to-end run caught (unit tests could not):** spawning `node --test` from inside
the gate — while the gate itself ran under `node --test` during dev — makes the child inherit
`NODE_TEST_CONTEXT=child-v8`, which flips it into reporter mode → it discovers ZERO test files →
exits 0: a **false green**. Fixed by `childEnv()` stripping that one var before the spawn
(behavior-preserving on the real CLI path, where the var is absent). The round-2 reviewer empirically
reproduced the trap. This is exactly why the DoD's "run it end-to-end for real" step exists.

**Still open for gate-EXIT (logged, not blocking):** ≥20 `gate_pass` rows (15 more, ~1/session), the
immovable ≥30-day calendar floor (~2026-06-24), the schema-fingerprint-canary, and review item C's
`test/manifest.json` / `test/golden/` / redacted scannable `real-snapshot/` tree + the fn≤30-vs-80
decision (step 5 kept at ≤80 per P1.U16).

**Lesson:** the gate-EXIT is now MECHANICALLY testable — `selftest --release-gate` exits 0/non-0 over
6 falsifiable checks and `countGatePass` gives a script-countable tally, replacing human-adjudicated
"is it stable?" prose (the S4 gate-theater risk for a non-coder owner). What remains is mechanical:
15 more dogfood rows + the calendar.

---

## 2026-06-08 — OFF-RAMP EVIDENCE #1: real-harness reversible-write dogfood (2 reps, pristine)

After the off-ramp was reframed evidence-driven (relax `CLAUDE_MGR_ENABLE_WRITES` only on a real
governed-write track record with zero incidents), accumulated the FIRST real-write evidence on the
live `~/.claude` (CC **2.1.160**). The safe protocol (P4a-validated): **dummy-only + bounded-clean +
NEVER a full rollback** (a real `rollback` would rewrite all 663 governed files — forbidden; instead
PROVE reversibility by verifying the auto-snapshot is a byte-identical undo point, leaving the real
surface untouched).

**Rep #1 — `remove agent:__mgr-dogfood-evidence --apply`:** dry-run exit 0 (dummy survived, zero
writes) → real `--apply` (two-factor gate armed) exit 0, dummy deleted, auto-snapshot taken →
tar-extract of the dummy member from `files.tar` == the dummy's pre-delete sha256 ✓ (rollback WOULD
restore byte-identical) → bounded-clean → **PRISTINE** (agents 19==19, no leftover, no `.mgr-new`/
`.mgr-old` sidecar, snapshots back to empty, audit.log still absent).

**Rep #2 — `remove command:__mgr-dogfood-evidence --apply`:** same flow, BOTH verifications green —
manifest `preSha256` == dummy sha (683 files captured) AND tar-extract == dummy bytes ✓ → **PRISTINE**
(commands 79==79, no residue, snapshots back to empty).

**Lesson (environment, not a claude-mgr bug):** rep #1's manifest cross-check threw `ENOENT
.../C:\c\Users\...` because an MSYS `/c/Users/...` path was handed to **Windows node**, which prepends
the current drive (`/c` → `C:\c\...`). `tar` is MSYS-aware and ate the same path fine — so two tools
disagree on one path. Fix when feeding Windows node a path from Git Bash: pipe the file (`cat f | node`)
or `cygpath -m` → `C:/...`. The integration suite never hit this because it uses `os.tmpdir()` native
Windows paths, not MSYS forms. Rep #2 used the `cat | node` fix and both checks passed.

**Off-ramp status:** condition (a) "real `--apply` round-trips verified reversible, zero incidents"
now has 2 clean reps covering BOTH single-file kinds (agent + command). Condition (b) "schema-canary
survives ≥1 CC version change" is OPEN — CC is updatable **2.1.160 → 2.1.168** (latest); a future
session should re-baseline the drifted canary then soak it across that bump. Condition (c) the
not-before floor **2026-07-07** is not yet reached. So the gate correctly stays in force.

### 2026-06-08 (cont.) — reps #3 + #4: skill-directory + cascade write paths (4 reps total)

Extended the (a) evidence to cover ALL reversible governed-write paths (user: "再补几次 (a)").

**Rep #3 — `remove skill:__mgr-dogfood-skill --apply` (DIRECTORY recursive delete):** created a
multi-file dummy skill (`SKILL.md` + `sub/helper.md`) → `--apply` recursively deleted the whole dir
→ the auto-snapshot captured BOTH files byte-identical (manifest preSha256 == dummy AND a real
tar-extract of each member == dummy bytes, **nested `sub/helper.md` included** = recursive capture
proven) → bounded-clean → **PRISTINE** (skills 244==244, no leftover, snapshots empty). Exercises the
`atomic-dir-delete` / `'remove-skill'` gate-context path (distinct from single-file delete).

**Rep #4 — `remove agent:__mgr-dogfood-tracer --cascade --force --apply` (MULTI-OP):** a dummy skill
(`skills/__mgr-dogfood-tracedep`, frontmatter `agent: __mgr-dogfood-tracer`) made the dummy agent's
dependent. SAFETY-FIRST: a **dry-run cascade preview** first confirmed `wouldRemove` was EXACTLY the
2 dummies (target agent + the 1 dependent skill), zero real components — only then `--apply`.
**The `--force` gate was empirically confirmed on the live harness:** `--cascade --apply` WITHOUT
`--force` → **exit 3, nothing deleted** (the aggressive multi-delete refuses without explicit
`--force`). Then `--cascade --force --apply` → exit 0, BOTH the agent AND the skill dir deleted under
**ONE** snapshot, both restorable byte-identical from that single snapshot (manifest + tar verified)
→ bounded-clean → **PRISTINE** (agents 19==19, skills 244==244, no leftover, snapshots empty).

**(a) status now: 4 clean real `--apply` round-trips, ZERO incidents, every reversible write path
covered** — single-file delete (agent #1, command #2), directory recursive delete (skill #3), and
cascade multi-delete (#4, + the `--force` refusal gate proven). The real `~/.claude` governed surface
(19 agents / 79 commands / 244 skill dirs) is byte-for-byte unchanged after all four; `.mgr-state`
back to empty each time; no `.mgr-new`/`.mgr-old` residue ever. `update`/`mcp remove` real writes
remain DELIBERATELY un-run (they delegate to the external `claude` + are partially irreversible).
Conditions (b) [CC-version canary soak — pending a fresh 2.1.168 session] and (c) [floor 2026-07-07]
are unchanged.

## 2026-06-08 (cont.) — OFF-RAMP CONDITION (b) COMPLETE: schema-canary soak across CC 2.1.160 → 2.1.168, re-baselined clean

**Found during:** the user-directed "把退场条件 canary 收尾" (finish the canary off-ramp condition).
This is the FIRST schema-canary run in a FRESH session that actually launched under **CC 2.1.168**
(the prior session updated CC on disk but ran in-memory as 2.1.160, so re-baselining then would have
baked in the OLD surface — see the 2026-06-08 CC-update note in CLAUDE.md). Running under 2.1.168 means
the on-disk `~/.claude` has now been migrated to the new version's shape, so the canary sees the real
2.1.168 surface.

**Observed — drift = 3 changes, ALL ADDITIVE (zero removals):** `selftest --schema-canary` vs the
committed 2026-05-31 baseline reported exactly:
- `settingsKeys: +[model]` — settings.json gained a top-level `model` key (persisted model pin).
- `appKeys: +[pluginUsage, tipLifetimeShownCounts]` — two new CC-internal keys in `~/.claude.json`.
- `topDirs: +[file-history]` — a new `file-history` directory under `~/.claude`.

Every change is a NEW key/dir that CC 2.1.168 introduced — **nothing was removed**. A `removed` entry
would be the danger signal (CC changed a format and discovery may have silently dropped a dimension);
there were none. The canary even enumerated the brand-new `file-history` dir, which by itself proves
topDir discovery still works on the new surface.

**No write regression — verified three ways on the live `~/.claude` + the source tree (CC 2.1.168):**
- `selftest --release-gate` → **pass:true, all 6 steps PASS, 0 error diagnostics**; the doctor-smoke
  step = **25 checks, 0 errors** (synthetic fixture, deterministic); the schema-canary step correctly
  reported "3 schema change(s) (WARN, non-blocking)" without flipping pass.
- live read-only `doctor --format json` → **25 checks, probeLevel passive, 0 ERRORS** / 19 warn / 29
  info (the warns/infos are the usual faithfully-reported facts — overbroad allow-wildcards + orphan
  files incl. the new `file-history` dir — i.e. the tool WORKING, per the 2026-05-25 "clean = exit 0 +
  0 ERROR-severity" rule). The 14→19 warn / 18→29 info drift vs the 2.1.146 baseline is all new
  user-config rules + new CC runtime files, not a discovery regression.
- full `node --test` suite → **2440 / 0 fail / 0 skipped** both BEFORE and AFTER the re-baseline.

**Action — re-baselined:** `selftest --schema-canary --update-baseline` rewrote
`src/selftest/schema-baseline.json` (status `baseline-updated`, 0 error diags). The `git diff` is
exactly the 3 additive key/dir insertions + the fingerprint recompute
(`006a0b51…` → `433ec45a…`) + the `generatedAt` timestamp — **no removals, no value leakage** (the
baseline holds key NAMES only, by the canary's names-only privacy design). A re-run of
`selftest --schema-canary` then reported **status `clean`, 0 changes, no `schema-drift-detected`
WARN**. No test pins the committed baseline (the two canary test files are hermetic — they use
injected fake seams + synthetic tmp baselines), so the re-baseline broke nothing.

**Off-ramp status now — (a) ✅ + (b) ✅; only (c) the calendar floor remains:**
- (a) clean real-write track record / zero incidents — **MET** (4 reversible `--apply` round-trips,
  reps #1–#4 above, every reversible write path covered, zero incidents).
- (b) schema-canary survives ≥1 CC version change with no write regression — **MET NOW** (survived the
  CC 2.1.160 → 2.1.168 bump — and the whole 2.1.146 → 2.1.168 arc since the baseline — with zero
  discovery errors; re-baselined to the 2.1.168 surface; release-gate green; 2440 tests green).
- (c) not-before floor **2026-07-07** (~30d after `phase-4b-stable`) — **NOT YET REACHED** (today is
  2026-06-08, ~29 days out).

**Therefore the write-gate's `CLAUDE_MGR_ENABLE_WRITES` second factor STAYS MANDATORY.** Completing the
canary does NOT open the off-ramp — it retires condition (b). The earliest the env-var could be relaxed
to optional is 2026-07-07, and only then subject to a final clean stability review; `--apply` is never
removed regardless.

**Lesson:** re-baseline the canary ONLY from a session that genuinely launched under the new CC (not
just a CC updated on disk under an old running process) — otherwise the baseline captures the pre-
migration surface and immediately re-drifts on the next launch. The "3 additive / 0 removed" shape is
the clean-soak signature: additions are CC adding features; a removal would be the format-break alarm.
