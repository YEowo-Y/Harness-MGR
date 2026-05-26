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
