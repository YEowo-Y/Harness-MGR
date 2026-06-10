/**
 * Offline best-practice advice engine (P5.U3).
 *
 * Pure matching of already-gathered FACTS against the distilled offline rule
 * pack `src/config/best-practice-rules.json`: a rule FIRES iff at least one
 * fact's `code` is in the rule's `triggerCodes`. Output feeds the P5.U5
 * `health` CLI command and the TUI/MCP front-ends. No network, no fs — the
 * pack ships as static JSON loaded via `import ... with { type: 'json' }`,
 * exactly the src/lib/secrets-allowlist.mjs precedent (a static JSON import is
 * data bundling, not runtime I/O; the zero-network boundary gate forbids only
 * network modules/calls).
 *
 * --- Distillation stance (risk R2: a wrong rule actively misleads) ---
 * The pack was distilled ONCE, offline, from fetched official pages at
 * https://code.claude.com/docs (each rule carries `docUrl` + `docVersion` +
 * `sourceStatement` as the audit trail for the SEPARATE distillation-QC
 * review). PRECISION BEATS RECALL here — the opposite of the snapshot secrets
 * filter: a candidate rule that could not be genuinely grounded in a fetched
 * page was dropped, not shipped shaky.
 *
 * --- Fact-channel contract ---
 * Three channels, all optional:
 *   - `diagnostics`        flat Diagnostic[] (scan/discovery channel)
 *   - `doctorDiagnostics`  flat Diagnostic[] (doctor channel)
 *   - `health`             a P5.U2 HealthResult: every
 *                          components[i].reasons[j] is treated as a fact whose
 *                          path is that component's `path`
 * A fact contributes its `code` always and its `path` only when it is a
 * non-empty string (path-less facts still fire rules but add no affectedPaths).
 *
 * --- Junk tolerance / purity ---
 * Never throws: malformed pack entries, malformed rules, non-array channels,
 * and junk facts are SKIPPED silently (a malformed rule must not crash the
 * engine); an outer guard backstops any unexpected throw with an empty result.
 * Deterministic: advice sorted by (severity rank error>warn>info, then ruleId);
 * affectedPaths and matchedCodes sorted + deduped. Inputs are never mutated.
 * Proto-safe: untrusted codes are only ever Map/Set keys.
 *
 * @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic
 * @typedef {import('./health.mjs').HealthResult} HealthResult
 */

import BUNDLED_RULE_PACK from '../config/best-practice-rules.json' with { type: 'json' };

export { BUNDLED_RULE_PACK };

/**
 * @typedef {Object} AdviceRule
 * @property {string} id            unique `advice-<kebab>` id
 * @property {string} title         short imperative
 * @property {'error'|'warn'|'info'} severity
 * @property {string[]} triggerCodes  emitted diagnostic codes that fire the rule
 * @property {string} advice
 * @property {string} fix
 * @property {string} docUrl        official page grounding the rule
 * @property {string} [docVersion]  fetch date of that page
 * @property {string} [sourceStatement]  QC audit trail (not surfaced in records)
 */

/**
 * @typedef {Object} AdviceRecord
 * @property {string} ruleId
 * @property {string} title
 * @property {'error'|'warn'|'info'} severity
 * @property {string} advice
 * @property {string} fix
 * @property {string[]} affectedPaths  sorted unique paths of matching facts
 * @property {string[]} matchedCodes   sorted unique trigger codes seen in facts
 * @property {string} docUrl
 * @property {string} docVersion
 */

/** Severities, worst first (index = sort rank; mirrors health.mjs). */
const SEVERITIES = Object.freeze(['error', 'warn', 'info']);

/** Code-unit string compare (locale-independent, mirrors health.mjs cmp). */
function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** @param {unknown} v @returns {unknown[]} v when it is an array, else [] */
function arr(v) {
  return Array.isArray(v) ? v : [];
}

/** @param {unknown} v @returns {boolean} non-empty string */
function nes(v) {
  return typeof v === 'string' && v.length > 0;
}

/**
 * Rule validity predicate (the test's pack-validity oracle uses this REAL
 * predicate): non-empty string id/title/advice/fix/docUrl, severity in the
 * 3-value set, and a non-empty triggerCodes array of non-empty strings.
 * Never throws on junk. `docVersion`/`sourceStatement` are QC metadata, not
 * required for the engine to fire a rule.
 *
 * @param {unknown} rule @returns {boolean}
 */
export function isValidAdviceRule(rule) {
  if (!rule || typeof rule !== 'object') return false;
  const r = /** @type {any} */ (rule);
  if (!nes(r.id) || !nes(r.title) || !nes(r.advice) || !nes(r.fix) || !nes(r.docUrl)) return false;
  if (!SEVERITIES.includes(r.severity)) return false;
  if (!Array.isArray(r.triggerCodes) || r.triggerCodes.length === 0) return false;
  return r.triggerCodes.every(nes);
}

/**
 * Collect `{code, path|null}` facts from the three channels (module header
 * contract). Junk entries are skipped; never throws.
 * @param {unknown} diagnostics
 * @param {unknown} doctorDiagnostics
 * @param {unknown} health
 * @returns {Map<string, Set<string>>} code → set of paths (set may be empty)
 */
function indexFacts(diagnostics, doctorDiagnostics, health) {
  /** @type {Map<string, Set<string>>} */
  const byCode = new Map();
  const add = (code, path) => {
    if (!nes(code)) return;
    let paths = byCode.get(code);
    if (!paths) {
      paths = new Set();
      byCode.set(code, paths);
    }
    if (nes(path)) paths.add(path);
  };
  for (const channel of [diagnostics, doctorDiagnostics]) {
    for (const d of arr(channel)) {
      if (!d || typeof d !== 'object') continue;
      add(/** @type {any} */ (d).code, /** @type {any} */ (d).path);
    }
  }
  const comps = health && typeof health === 'object' ? arr(/** @type {any} */ (health).components) : [];
  for (const c of comps) {
    if (!c || typeof c !== 'object') continue;
    const path = /** @type {any} */ (c).path;
    for (const reason of arr(/** @type {any} */ (c).reasons)) {
      if (!reason || typeof reason !== 'object') continue;
      add(/** @type {any} */ (reason).code, path);
    }
  }
  return byCode;
}

/**
 * Build one AdviceRecord for a fired rule.
 * @param {any} rule @param {Map<string, Set<string>>} byCode @param {string[]} matched
 * @returns {AdviceRecord}
 */
function buildRecord(rule, byCode, matched) {
  const paths = new Set();
  for (const code of matched) {
    for (const p of byCode.get(code) ?? []) paths.add(p);
  }
  return {
    ruleId: rule.id,
    title: rule.title,
    severity: rule.severity,
    advice: rule.advice,
    fix: rule.fix,
    affectedPaths: [...paths].sort(cmp),
    matchedCodes: [...new Set(matched)].sort(cmp),
    docUrl: rule.docUrl,
    docVersion: nes(rule.docVersion) ? rule.docVersion : '',
  };
}

/**
 * Match facts against the rule pack. Pure; never throws; inputs never mutated.
 * `rules` (an AdviceRule[]) is the injectable seam overriding the bundled pack.
 *
 * @param {{ diagnostics?: Diagnostic[], doctorDiagnostics?: Diagnostic[],
 *           health?: HealthResult, rules?: AdviceRule[] }} [input]
 * @returns {{ advice: AdviceRecord[],
 *             summary: { total: number, error: number, warn: number, info: number },
 *             diagnostics: Diagnostic[] }}
 */
export function analyzeAdvice(input = {}) {
  try {
    const { diagnostics, doctorDiagnostics, health, rules } = input ?? {};
    const ruleList = Array.isArray(rules) ? rules : arr(/** @type {any} */ (BUNDLED_RULE_PACK)?.rules);
    const byCode = indexFacts(diagnostics, doctorDiagnostics, health);

    /** @type {AdviceRecord[]} */
    const advice = [];
    for (const rule of ruleList) {
      if (!isValidAdviceRule(rule)) continue; // malformed rule: skipped silently (header)
      const matched = /** @type {any} */ (rule).triggerCodes.filter((c) => byCode.has(c));
      if (matched.length === 0) continue;
      advice.push(buildRecord(rule, byCode, matched));
    }
    advice.sort((a, b) => (SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity))
      || cmp(a.ruleId, b.ruleId));

    const summary = { total: advice.length, error: 0, warn: 0, info: 0 };
    for (const a of advice) summary[a.severity] += 1;
    return { advice, summary, diagnostics: [] };
  } catch {
    // Never-throws backstop (header): hostile input (e.g. throwing getters)
    // degrades to an empty result rather than crashing the caller.
    return { advice: [], summary: { total: 0, error: 0, warn: 0, info: 0 }, diagnostics: [] };
  }
}
