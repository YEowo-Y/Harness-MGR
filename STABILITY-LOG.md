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
