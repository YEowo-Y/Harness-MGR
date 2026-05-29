# real-snapshot — SYNTHETIC hermetic doctor fixture

SYNTHETIC TEST FIXTURE - NOT REAL. Every file in this tree is invented. NO content is copied from any real ~/.claude. No real secrets, API keys, PII, usernames, emails, or absolute home paths. Paths use the `<CLAUDE_DIR>` placeholder.

This tree serves TWO purposes:

1. **snapshot.json** (pre-existing) — a redacted snapshot blob tested by `test/fixtures.test.mjs` (lines 162-205). Do NOT delete or modify snapshot.json; those 8 tests depend on it.

2. **Scannable tree** (new) — a minimal but representative config directory the doctor's 25 passive checks can walk. Used by release-gate step 6 (doctor-smoke) for a deterministic, portable gate run.

## Doctor-clean recipe

`doctor --passive` over this tree reports 0 ERROR-severity diagnostics. The per-check rationale:

- **#3 hook-file-exists**: `hooks/session-start.mjs` and `hooks/pre-tool-use.mjs` exist and are found via `cwd=fixtureDir` threading.
- **#6 settings-json-valid**: `settings.json` is valid JSONC with no duplicate keys.
- **#7 plugin-enabled-not-installed**: the one `enabledPlugins:true` key (`sample-plugin@synthetic-marketplace`) is present in `plugins/installed_plugins.json`.
- **#10 plugin-cache-missing**: the cache dir `plugins/cache/synthetic-marketplace/sample-plugin/1.0.0/` exists (the `.gitkeep` file creates it).
- **#22 claude-config-schema-version**: `installed_plugins.json` version is 2 (known) → no fact → silent.
- **#23 permissions-overbroad**: `permissions.allow` contains no `*` substring (wildcards are in `ask`/`deny` only).
- **All other checks**: either no relevant facts in this minimal tree, or the check emits info/warn severity at worst (never error).

## KEY DETERMINISM CONTRACT

The step-6 gather threads `cwd=<this fixture dir>` into the hook and statusLine probes. Relative hook commands (`node hooks/x.mjs`) resolve against THIS directory regardless of ambient `CLAUDE_PROJECT_DIR` or process cwd. Do NOT change hook commands to absolute paths (non-portable) or to `${CLAUDE_PROJECT_DIR}` forms (env-fragile).
