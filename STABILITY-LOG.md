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
