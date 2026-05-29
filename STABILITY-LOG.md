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
