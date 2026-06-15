/**
 * Doctor — health-check dispatcher (P2.U4: scaffold + first 3 passive checks).
 *
 * The doctor is the JUDGMENT layer. Discovery (settings.mjs, plugins.mjs) reports
 * raw FACTS — e.g. a repeated settings key surfaces as a `settings-duplicate-key`
 * warn — and analysis (conflicts.mjs) reshapes facts into clusters. The doctor
 * consumes those gathered facts and decides their HEALTH severity: a duplicate key
 * is escalated to a `settings-json-valid` ERROR with its line:column, an enabled
 * plugin that was never installed is an ERROR, a shadowing cluster is a WARN.
 *
 * --- Passive vs active (the dispatch scaffold) ---
 *   - passive (DEFAULT): only judgments over facts ALREADY gathered by the caller —
 *     no filesystem walks, no spawns, no network. Pure data in, diagnostics out.
 *   - active (`--active-probes`, opt-in): adds checks that spawn (`node --check`,
 *     `claude --version`, loader-probe). #4 hook-node-syntax (P2.U7a), #15
 *     claude-cli-resolvable (P2.U7b), and #19 loader-probe (P2.U7c-2) are registered. The
 *     dispatch here already filters by `probeLevel` so an active check NEVER runs
 *     unless the caller opts in — that is what makes "passive produces zero side
 *     effects" true.
 *   INVARIANT (plan): active probes never invoke hook command strings from settings.
 *
 * --- Registered checks (P2 so far; see the CHECKS array) ---
 *   #4  hook-node-syntax       (active)  node --check per .mjs hook script → syntax-error is an error
 *   #15 claude-cli-resolvable  (active)  claude CLI resolves on PATH; native exe also probed via --version
 *   #19 loader-probe           (active)  write+observe+cleanup a probe agent; carries loader precedence confidence
 *   #1  mcp-auth-stale                 MCP server needs-auth cache entry older than 30/90 days
 *   #2  mcp-server-resolvable          stdio MCP command was not found on PATH at probe time
 *   #6  settings-json-valid            escalate settings-* facts (dup key → error)
 *   #7  plugin-enabled-not-installed   enabledPlugins true with no matching install
 *   #8  plugin-installed-not-enabled   installed but not in the settings enabledPlugins map (info)
 *   #9  plugin-marketplace-unknown     installed plugin's marketplace not in the known set (info)
 *   #10 plugin-cache-missing           settings-enabled install with cachePresent === false (warn)
 *   #11 duplicate-component-shadowing  conflict cluster (size > 1) → warn
 *   #12 orphan-files                  discovered orphan (hard or soft) → info
 *   #22 claude-config-schema-version  escalate plugin-schema-version-unknown fact → warn
 *   #23 permissions-overbroad         wildcard in permissions.allow list → warn
 *   #13 claude-md-backup-bloat        too many CLAUDE.md.backup.* files in configDir → info
 *   #14 snapshot-retention            snapshot older than 90 days → info
 *   #16 disk-budget                   .mgr-state/ recursive size over 5 GB → warn
 *   #18 statusline-resolvable         statusLine command target not found on disk/PATH → warn
 *   #20 probe-residue                 leftover __mgr-probe-* temp file from crashed loader probe → warn
 *   #21 apply-leftover-files          leftover *.mgr-new / *.mgr-old from interrupted atomic write → warn
 *   #25 config-rules-stale            effective-config-rules.md older than 90 days → info
 *   #17 windows-file-locks            settings.json appears exclusively locked by another process → warn
 *   #24 insecure-permissions          .mgr-state/ has a broad Windows ACL (read-only icacls — passive) → warn
 *   #26 config-toml-valid             codex config.toml failed to parse/read → error (codex target only)
 *   #27 trust-overbroad               codex [projects."P"] trusts the home dir / a drive root → warn (codex target only)
 *   #28 codex-state-tmp-bloat         too many leftover ..codex-global-state.json.tmp-* files → info (codex target only)
 *
 * --- Facts gathered by the discovery probe, judged here ---
 * #1 and #2 consume facts from src/discovery/probe-mcp.mjs (McpAuthFact[],
 * McpResolutionFact[]). The probe does the I/O; these checks stay pure.
 *
 * --- Pure consumer, by design ---
 * The doctor takes a DoctorInput bundle the caller has already gathered (scan +
 * analyzeConflicts + merged enabledPlugins). It does NO I/O of its own, so it is
 * sync, trivially testable, and — per the scanner contract — NEVER throws: a bad
 * input degrades to empty findings, and a check that somehow throws is caught and
 * recorded as a `doctor-check-threw` error rather than propagating.
 *
 * NOTE (Phase 1): a real `scan()` does not yet walk plugin component dirs, so it
 * cannot itself produce a shadowing cluster — #11's `conflicts` input is fed by
 * analyzeConflicts over synthetic/plugin records (see conflicts.mjs). The doctor is
 * agnostic to where the clusters came from; it only judges them.
 *
 * Zero npm dependencies. Node stdlib only. Never throws.
 */

import { DiagnosticBag } from '../../lib/diagnostic.mjs';
import { PROBE_CHECKS } from './probe-checks.mjs';
import { CONFIG_CHECKS } from './config-checks.mjs';
import { FS_CHECKS } from './fs-checks.mjs';
import { ACCESS_CHECKS } from './access-checks.mjs';
import { CODEX_CHECKS } from './codex-checks.mjs';
import { ACTIVE_CHECKS } from './active-checks.mjs';
import { strOr, numOr } from './util.mjs';

/**
 * @typedef {import('../../lib/diagnostic.mjs').Diagnostic} Diagnostic
 * @typedef {import('../../discovery/plugins.mjs').PluginRecord} PluginRecord
 * @typedef {import('../../discovery/marketplaces.mjs').MarketplaceRecord} MarketplaceRecord
 * @typedef {import('../conflicts.mjs').ConflictCluster} ConflictCluster
 * @typedef {import('../../discovery/probe-mcp.mjs').McpAuthFact} McpAuthFact
 * @typedef {import('../../discovery/probe-mcp.mjs').McpResolutionFact} McpResolutionFact
 * @typedef {import('../../discovery/probe-hooks.mjs').HookFact} HookFact
 * @typedef {import('../../discovery/probe-statusline.mjs').StatuslineFact} StatuslineFact
 * @typedef {import('../../discovery/orphan-detector.mjs').OrphanRecord} OrphanRecord
 */

/**
 * @typedef {'passive'|'active'} ProbeLevel
 */

/**
 * The facts a doctor run judges. Every field is optional and defensively read, so
 * a partial bundle (or `undefined`) simply yields fewer findings, never a throw.
 *
 * @typedef {Object} DoctorInput
 * @property {Diagnostic[]} [settingsDiagnostics]  settings-discovery facts (scan.settings.diagnostics);
 *                                                 #6 filters by code, so passing the full scan set is safe too
 * @property {Record<string, unknown>} [enabledPlugins]  merged enabledPlugins map (name@marketplace → bool); the
 *                                                 AUTHORITATIVE enable signal used by #7/#8/#10 (the install
 *                                                 record's own `enabled` flag is unreliable — see enabledMap)
 * @property {PluginRecord[]} [installedPlugins]   installed plugins (scan.plugins); the "installed" set. #9 judges
 *                                                 each record's marketplace; #8/#10 cross-reference against enabledPlugins
 * @property {MarketplaceRecord[]} [marketplaces]  known marketplaces (scan.marketplaces) — the baseline for #9
 * @property {ConflictCluster[]} [conflicts]       shadowing clusters (analyzeConflicts(...).conflicts)
 * @property {McpAuthFact[]} [mcpAuth]             MCP needs-auth facts (probe-mcp); judged by #1
 * @property {McpResolutionFact[]} [mcpResolution] stdio command-resolution facts (probe-mcp); judged by #2
 * @property {HookFact[]} [hookFacts]              hook resolution facts (probe-hooks); judged by #3/#5
 * @property {number} [now]                        reference time (ms) for age-based checks; the CLI passes
 *                                                 Date.now(). Absent → age-based checks emit nothing (keeps
 *                                                 the doctor pure).
 * @property {OrphanRecord[]} [orphans]            discovered orphan facts (analyzeOrphans(...).orphans); judged by #12
 * @property {Diagnostic[]} [pluginDiagnostics]   plugin-discovery facts (scan.plugins.diagnostics); #22 filters for plugin-schema-version-unknown
 * @property {{allow?:string[],ask?:string[],deny?:string[]}} [permissions]  merged effective.permissions (mergeSettings); #23 judges .allow for wildcards
 * @property {import('../../discovery/probe-fs.mjs').FsFacts} [fsFacts]  filesystem facts (probe-fs); judged by #13/#14/#16/#20/#21/#25
 * @property {StatuslineFact} [statusline]  statusLine resolution fact (probe-statusline); judged by #18
 * @property {import('../../discovery/probe-access.mjs').LockFact} [lock]  settings.json lock fact (probe-access); judged by #17
 * @property {import('../../discovery/probe-access.mjs').AclFact} [acl]  .mgr-state ACL fact (probe-access, async gather); judged by #24
 * @property {import('../../discovery/probe-hook-syntax.mjs').HookSyntaxFact[]} [hookSyntax]  node --check facts (probe-hook-syntax, active tier); judged by #4
 * @property {import('../../discovery/probe-cli.mjs').CliFact} [cli]  claude CLI resolution/liveness fact (probe-cli, active tier); judged by #15
 * @property {import('../../discovery/probe-loader.mjs').LoaderProbeFact} [loader]  loader-probe fact (probe-loader, active tier); judged by #19
 * @property {{tomlError: string|null, trustedProjects: string[], homeDir: string, leftoverStateTmp: {count: number, sample: string[]}}} [codexConfig]  codex facts (probe-codex-config); judged by #26/#27/#28. Only gathered for a codex target.
 */

/**
 * One registered health check. `run` is pure and total: facts in, Diagnostic[] out.
 *
 * @typedef {Object} DoctorCheck
 * @property {number} id            the plan's check number (#6, #7, #11, …)
 * @property {string} code          stable diagnostic code this check emits
 * @property {ProbeLevel} probeLevel  passive runs always; active only when opted in
 * @property {(input: DoctorInput) => Diagnostic[]} run
 */

/**
 * Per-check execution record for the report (so a TUI can show "ran / skipped" and
 * a finding count without re-deriving it from the flat diagnostics array).
 *
 * @typedef {Object} CheckSummary
 * @property {number} id
 * @property {string} code
 * @property {ProbeLevel} probeLevel
 * @property {boolean} ran          false when an active check was skipped in passive mode
 * @property {number} findings      diagnostics this check contributed
 */

/**
 * @typedef {Object} DoctorReport
 * @property {ProbeLevel} probeLevel  the level this run dispatched at
 * @property {CheckSummary[]} checks  one entry per registered check, in registry order
 * @property {Diagnostic[]} diagnostics  every finding, plus run-level notices
 */

/** settings-discovery fact codes that mean "settings.json is not valid". */
const SETTINGS_INVALID_CODES = new Set(['settings-duplicate-key', 'settings-unreadable', 'settings-malformed']);

/**
 * #6 settings-json-valid — judge the settings-discovery facts. Each duplicate key /
 * unreadable / malformed fact becomes a `settings-json-valid` ERROR carrying the
 * original message (which already holds 1-based line:column for duplicates). Other
 * facts are ignored. Filters by code, so it is safe to feed either the per-scanner
 * `settings.diagnostics` or the whole aggregated scan set.
 * @param {DoctorInput} input
 * @returns {Diagnostic[]}
 */
function checkSettingsJsonValid(input) {
  const facts = Array.isArray(input.settingsDiagnostics) ? input.settingsDiagnostics : [];
  /** @type {Diagnostic[]} */
  const out = [];
  for (const f of facts) {
    if (!f || typeof f !== 'object' || !SETTINGS_INVALID_CODES.has(f.code)) continue;
    /** @type {Diagnostic} */
    const d = {
      severity: 'error',
      code: 'settings-json-valid',
      message: strOr(f.message, 'settings.json is not valid'),
      phase: 'doctor',
      fix: settingsFix(f.code),
    };
    if (typeof f.path === 'string') d.path = f.path;
    out.push(d);
  }
  return out;
}

/**
 * The remediation hint for a settings validity failure, specific to which fact
 * tripped it (a not-an-object error should not advise "remove the duplicate key").
 * @param {string} code
 * @returns {string}
 */
function settingsFix(code) {
  if (code === 'settings-duplicate-key') return 'remove the duplicate key from settings.json (the last value currently wins)';
  if (code === 'settings-malformed') return 'settings.json must be a JSON object, not an array or scalar';
  return 'fix the JSON syntax error in settings.json';
}

/**
 * #7 plugin-enabled-not-installed — a plugin marked `true` in the effective
 * enabledPlugins map but absent from the installed set (installed_plugins.json) can
 * never load; that is an ERROR. Output is sorted by key for stable ordering.
 * @param {DoctorInput} input
 * @returns {Diagnostic[]}
 */
function checkPluginEnabledNotInstalled(input) {
  const enabled = enabledMap(input);
  const installed = Array.isArray(input.installedPlugins) ? input.installedPlugins : [];
  /** @type {Set<string>} */
  const installedKeys = new Set();
  for (const p of installed) {
    if (p && typeof p.key === 'string' && p.key.length > 0) installedKeys.add(p.key);
  }
  /** @type {Diagnostic[]} */
  const out = [];
  for (const key of Object.keys(enabled).sort()) {
    if (!isSafeKey(key) || enabled[key] !== true || installedKeys.has(key)) continue;
    out.push({
      severity: 'error',
      code: 'plugin-enabled-not-installed',
      message: `plugin "${key}" is enabled in settings but is not installed`,
      phase: 'doctor',
      fix: `install it (e.g. claude plugin add) or remove "${key}" from enabledPlugins`,
    });
  }
  return out;
}

/**
 * The installed plugins as a clean list of records carrying a usable string `key`.
 * Shared by #8/#9/#10: #9 judges each record's own marketplace; #8/#10 cross-reference
 * each record's key against the settings enabledPlugins map.
 * @param {DoctorInput} input
 * @returns {PluginRecord[]}
 */
function pluginList(input) {
  const installed = Array.isArray(input.installedPlugins) ? input.installedPlugins : [];
  return installed.filter((p) => p && typeof p.key === 'string' && p.key.length > 0);
}

/**
 * The effective enabledPlugins map (name@marketplace → bool), or {} when absent/malformed.
 * The AUTHORITATIVE enable signal for #7/#8/#10: verified on the real harness, the install
 * record's own `enabled` field is `false` even for actively-used plugins, so it must NOT be
 * used to decide whether a plugin is enabled (STABILITY-LOG 2026-05-24).
 * @param {DoctorInput} input
 * @returns {Record<string, unknown>}
 */
function enabledMap(input) {
  const m = input.enabledPlugins;
  return m && typeof m === 'object' && !Array.isArray(m) ? m : {};
}

/**
 * #8 plugin-installed-not-enabled — an installed plugin that the settings enabledPlugins
 * map does NOT mark `true`. INFO: dormant, not broken. Reads the settings map (the same
 * authoritative signal as #7), NOT the install record's own `enabled` field — that field
 * is `false` even for active plugins on the real harness, so keying off it flagged every
 * installed plugin (STABILITY-LOG 2026-05-24).
 * @param {DoctorInput} input
 * @returns {Diagnostic[]}
 */
function checkPluginInstalledNotEnabled(input) {
  const enabled = enabledMap(input);
  /** @type {Diagnostic[]} */
  const out = [];
  for (const p of pluginList(input)) {
    if (enabled[p.key] !== true) {
      out.push({ severity: 'info', code: 'plugin-installed-not-enabled', message: `plugin "${p.key}" is installed but not enabled in settings`, phase: 'doctor', fix: 'enable it via settings (enabledPlugins) if you want it active, or remove it to declutter' });
    }
  }
  return out;
}

/**
 * #9 plugin-marketplace-unknown — an installed plugin whose `marketplace` is not
 * among the known marketplaces. INFO. Skipped entirely when NO marketplaces are
 * known: with no baseline every plugin would look unknown, and a missing
 * known_marketplaces.json is its own discovery diagnostic, not N repeated findings.
 * @param {DoctorInput} input
 * @returns {Diagnostic[]}
 */
function checkPluginMarketplaceUnknown(input) {
  const marketplaces = Array.isArray(input.marketplaces) ? input.marketplaces : [];
  /** @type {Set<string>} */
  const known = new Set();
  for (const m of marketplaces) {
    if (m && typeof m.name === 'string' && m.name.length > 0) known.add(m.name);
  }
  /** @type {Diagnostic[]} */
  const out = [];
  if (known.size === 0) return out;
  for (const p of pluginList(input)) {
    const mp = typeof p.marketplace === 'string' ? p.marketplace : '';
    if (mp.length > 0 && !known.has(mp)) {
      out.push({ severity: 'info', code: 'plugin-marketplace-unknown', message: `plugin "${p.key}" references marketplace "${mp}", which is not a known marketplace`, phase: 'doctor', fix: 'add or reinstall the marketplace, or reinstall the plugin from a known one' });
    }
  }
  return out;
}

/**
 * #10 plugin-cache-missing — a settings-enabled install whose plugin cache dir is absent
 * (`cachePresent === false`). WARN: it may not load until the cache is rebuilt. cachePresent
 * is a discovered FACT (plugins.mjs), so this stays pure judgment. Like #8 it reads the
 * settings enabledPlugins map — NOT the install record's own enabled flag, which is `false`
 * even for active plugins and would make this miss every real cache gap (STABILITY-LOG 2026-05-24).
 * @param {DoctorInput} input
 * @returns {Diagnostic[]}
 */
function checkPluginCacheMissing(input) {
  const enabled = enabledMap(input);
  /** @type {Diagnostic[]} */
  const out = [];
  for (const p of pluginList(input)) {
    if (enabled[p.key] === true && p.cachePresent === false) {
      out.push({ severity: 'warn', code: 'plugin-cache-missing', message: `plugin "${p.key}" is enabled but its plugin cache is missing`, phase: 'doctor', fix: 'reinstall or refresh the plugin to rebuild its cache' });
    }
  }
  return out;
}

/**
 * #11 duplicate-component-shadowing — each conflict cluster (>= 2 members) means one
 * component shadows another; surface it as a WARN under the canonical doctor code,
 * reusing the cluster's own reason/fix when present. Clusters from analyzeConflicts
 * are already >= 2, so the `count > 1` guard only defends against malformed input.
 * @param {DoctorInput} input
 * @returns {Diagnostic[]}
 */
function checkDuplicateComponentShadowing(input) {
  const clusters = Array.isArray(input.conflicts) ? input.conflicts : [];
  /** @type {Diagnostic[]} */
  const out = [];
  for (const c of clusters) {
    if (!c || typeof c !== 'object') continue;
    const count = Array.isArray(c.possibleWinners) ? c.possibleWinners.length : 0;
    if (count <= 1) continue;
    const kind = strOr(c.kind, 'component');
    const key = strOr(c.key, '(unknown)');
    out.push({
      severity: 'warn',
      code: 'duplicate-component-shadowing',
      message: strOr(c.reason, `${kind} "${key}" is provided by ${count} loaded copies — only one wins`),
      phase: 'doctor',
      fix: strOr(c.fix, `remove or rename one of the duplicate ${kind}s if the override is unintended`),
    });
  }
  return out;
}

/**
 * The registered checks, in report order. Frozen so a caller cannot mutate the
 * routing table. P2.U5/U6 append more passive checks; P2.U7 appends active ones.
 * @type {ReadonlyArray<DoctorCheck>}
 */
export const CHECKS = Object.freeze([
  ...PROBE_CHECKS,
  Object.freeze({ id: 6, code: 'settings-json-valid', probeLevel: 'passive', run: checkSettingsJsonValid }),
  Object.freeze({ id: 7, code: 'plugin-enabled-not-installed', probeLevel: 'passive', run: checkPluginEnabledNotInstalled }),
  Object.freeze({ id: 8, code: 'plugin-installed-not-enabled', probeLevel: 'passive', run: checkPluginInstalledNotEnabled }),
  Object.freeze({ id: 9, code: 'plugin-marketplace-unknown', probeLevel: 'passive', run: checkPluginMarketplaceUnknown }),
  Object.freeze({ id: 10, code: 'plugin-cache-missing', probeLevel: 'passive', run: checkPluginCacheMissing }),
  Object.freeze({ id: 11, code: 'duplicate-component-shadowing', probeLevel: 'passive', run: checkDuplicateComponentShadowing }),
  ...CONFIG_CHECKS,
  ...FS_CHECKS,
  ...ACCESS_CHECKS,
  ...CODEX_CHECKS,
  ...ACTIVE_CHECKS,
]);

/**
 * Run the doctor over a gathered facts bundle.
 *
 * @param {DoctorInput} input  the facts to judge (defensively read; undefined is fine)
 * @param {Object} [opts]
 * @param {boolean} [opts.activeProbes=false]  opt in to active checks (active checks: #4 hook-node-syntax, #15 claude-cli-resolvable, #19 loader-probe — P2.U7a/b/c)
 * @param {ReadonlyArray<DoctorCheck>} [opts.checks]  override the registry (internal/testing seam)
 * @returns {DoctorReport}
 */
export function runDoctor(input, opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const activeProbes = o.activeProbes === true;
  const checks = Array.isArray(o.checks) ? o.checks : CHECKS;
  const safeInput = input && typeof input === 'object' ? /** @type {DoctorInput} */ (input) : {};
  /** @type {ProbeLevel} */
  const probeLevel = activeProbes ? 'active' : 'passive';

  const bag = new DiagnosticBag();
  // Side-effect notice: opting into active probes may invoke external tools. Recorded
  // even before any active check exists so the opt-in is always visible in output.
  if (activeProbes) {
    bag.add({ severity: 'info', code: 'doctor-active-probes', message: 'active probes enabled: checks may spawn external tools (never hook command strings); the loader probe may briefly create and then remove a temporary probe file in the real agents/ directory (gated, symlink-guarded, and removed after the check — residue is reported if removal fails)', phase: 'doctor' });
  }

  /** @type {CheckSummary[]} */
  const summaries = [];
  for (const check of checks) {
    const level = levelOf(check);
    const ran = level === 'passive' || activeProbes;
    const findings = ran ? runOneCheck(check, safeInput, bag) : 0;
    summaries.push({ id: numOr(check && check.id, 0), code: strOr(check && check.code, 'unknown'), probeLevel: level, ran, findings });
  }

  return { probeLevel, checks: summaries, diagnostics: bag.all() };
}

/**
 * Execute one check, funnelling its diagnostics into the bag and returning the
 * count. A check that throws (it should not) is contained as one `doctor-check-threw`
 * error so a single bad check cannot abort the whole run.
 * @param {DoctorCheck} check
 * @param {DoctorInput} input
 * @param {DiagnosticBag} bag
 * @returns {number} diagnostics contributed
 */
function runOneCheck(check, input, bag) {
  let diags;
  try {
    diags = check && typeof check.run === 'function' ? check.run(input) : [];
  } catch (err) {
    bag.add({ severity: 'error', code: 'doctor-check-threw', message: `check "${strOr(check && check.code, 'unknown')}" threw: ${err instanceof Error ? err.message : String(err)}`, phase: 'doctor' });
    return 1;
  }
  if (!Array.isArray(diags)) return 0;
  let n = 0;
  for (const d of diags) { bag.add(d); n += 1; }
  return n;
}

/**
 * A check's probe level, defaulting to 'passive' for anything malformed (fail safe:
 * an unrecognised check is treated as passive, never silently skipped as active).
 * @param {DoctorCheck} check
 * @returns {ProbeLevel}
 */
function levelOf(check) {
  return check && check.probeLevel === 'active' ? 'active' : 'passive';
}

/**
 * Reject prototype-polluting keys when iterating a user-authored map — JSON.parse
 * makes `__proto__` a real own key, so an unscrubbed enabledPlugins map could
 * otherwise yield a bogus finding. Matches the isSafeKey guard used in settings-merge.
 * @param {string} key
 * @returns {boolean}
 */
function isSafeKey(key) {
  return key !== '__proto__' && key !== 'constructor' && key !== 'prototype';
}
