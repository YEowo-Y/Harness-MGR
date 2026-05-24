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
 *     `claude --version`, loader-probe). Those are registered in P2.U7. The dispatch
 *     here already filters by `probeLevel` so an active check NEVER runs unless the
 *     caller opts in — that is what makes "passive produces zero side effects" true.
 *   INVARIANT (plan): active probes never invoke hook command strings from settings.
 *
 * --- U4 checks (all passive) ---
 *   #6  settings-json-valid           escalate settings-* facts (dup key → error)
 *   #7  plugin-enabled-not-installed  enabledPlugins true with no matching install
 *   #11 duplicate-component-shadowing conflict cluster (size > 1) → warn
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

/**
 * @typedef {import('../../lib/diagnostic.mjs').Diagnostic} Diagnostic
 * @typedef {import('../../discovery/plugins.mjs').PluginRecord} PluginRecord
 * @typedef {import('../conflicts.mjs').ConflictCluster} ConflictCluster
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
 * @property {Record<string, unknown>} [enabledPlugins]  merged enabledPlugins map (name@marketplace → bool)
 * @property {PluginRecord[]} [installedPlugins]   installed plugins (scan.plugins) — the "installed" set for #7
 * @property {ConflictCluster[]} [conflicts]       shadowing clusters (analyzeConflicts(...).conflicts)
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
  const enabled = input.enabledPlugins && typeof input.enabledPlugins === 'object' ? input.enabledPlugins : {};
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
  Object.freeze({ id: 6, code: 'settings-json-valid', probeLevel: 'passive', run: checkSettingsJsonValid }),
  Object.freeze({ id: 7, code: 'plugin-enabled-not-installed', probeLevel: 'passive', run: checkPluginEnabledNotInstalled }),
  Object.freeze({ id: 11, code: 'duplicate-component-shadowing', probeLevel: 'passive', run: checkDuplicateComponentShadowing }),
]);

/**
 * Run the doctor over a gathered facts bundle.
 *
 * @param {DoctorInput} input  the facts to judge (defensively read; undefined is fine)
 * @param {Object} [opts]
 * @param {boolean} [opts.activeProbes=false]  opt in to active checks (none registered until P2.U7)
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
    bag.add({ severity: 'info', code: 'doctor-active-probes', message: 'active probes enabled: checks may invoke external tools (never hook command strings)', phase: 'doctor' });
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

/** @param {unknown} v @param {string} fallback @returns {string} */
function strOr(v, fallback) {
  return typeof v === 'string' && v.length > 0 ? v : fallback;
}

/** @param {unknown} v @param {number} fallback @returns {number} */
function numOr(v, fallback) {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
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
