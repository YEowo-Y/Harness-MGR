/**
 * Doctor codex-fact checks — #26 config-toml-valid, #27 trust-overbroad,
 * #28 codex-state-tmp-bloat.
 *
 * The PURE judgment layer for the codex facts gathered by
 * discovery/probe-codex-config.mjs (CodexConfigFacts on input.codexConfig):
 *   #26 escalates a config.toml parse/read failure (tomlError) into an ERROR.
 *   #27 judges each trusted [projects."P"] path for overbroad trust (the home dir
 *       itself, an ancestor of it, or a bare drive root → everything under it is
 *       transitively trusted).
 *   #28 flags an accumulation of leftover ..codex-global-state.json.tmp-* files
 *       (interrupted state writes) → INFO (the codex analog of #13 backup-bloat).
 *
 * These checks are CODEX-GUARDED: input.codexConfig is only gathered for a codex
 * target, so on a Claude (or absent) run they read undefined and return [] — they
 * contribute nothing to a Claude doctor. No I/O, no clock; pure data in,
 * Diagnostic[] out. Never throws.
 *
 * Zero npm dependencies. Node stdlib only.
 */

/**
 * @typedef {import('./index.mjs').DoctorInput} DoctorInput
 * @typedef {import('../../lib/diagnostic.mjs').Diagnostic} Diagnostic
 */

/**
 * #26 config-toml-valid — when the codex config.toml failed to parse/read, the
 * probe records the reason in `tomlError`; escalate it to an ERROR. A valid or
 * missing config (tomlError null) yields nothing.
 * @param {DoctorInput} input
 * @returns {Diagnostic[]}
 */
function checkConfigTomlValid(input) {
  const cc = input.codexConfig;
  if (!cc || typeof cc !== 'object') return [];
  const err = cc.tomlError;
  if (typeof err !== 'string' || err.length === 0) return [];
  return [{
    severity: 'error',
    code: 'config-toml-valid',
    message: `Codex config.toml is invalid: ${err}`,
    phase: 'doctor',
    fix: 'fix the TOML syntax error in config.toml',
  }];
}

/**
 * #27 trust-overbroad — a [projects."P"] table with trust_level="trusted" whose
 * path P transitively trusts the whole home dir (P === home, or P is an ancestor
 * of home) or a bare drive root grants far more than likely intended → WARN.
 * One finding per offending path, deduped + sorted by message.
 * @param {DoctorInput} input
 * @returns {Diagnostic[]}
 */
function checkTrustOverbroad(input) {
  const cc = input.codexConfig;
  if (!cc || typeof cc !== 'object') return [];
  const projects = Array.isArray(cc.trustedProjects) ? cc.trustedProjects : [];
  const home = typeof cc.homeDir === 'string' ? cc.homeDir : '';
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {Diagnostic[]} */
  const out = [];
  for (const p of projects) {
    if (typeof p !== 'string' || seen.has(p)) continue;
    if (!isOverbroadTrust(p, home)) continue;
    seen.add(p);
    out.push({
      severity: 'warn',
      code: 'trust-overbroad',
      message: `Codex trusts "${p}" (trust_level=trusted), which transitively trusts your entire home directory or a whole drive`,
      phase: 'doctor',
      fix: 'scope trust to specific project directories, not your home directory or a drive root',
    });
  }
  out.sort((a, b) => (a.message < b.message ? -1 : a.message > b.message ? 1 : 0));
  return out;
}

/**
 * Normalize a path for trust comparison: lowercase, backslashes → forward slashes,
 * strip a Windows `\\?\` long-path prefix, strip trailing slashes. Pure, never throws.
 * @param {*} x
 * @returns {string}
 */
function normalizeTrustPath(x) {
  return String(x)
    .toLowerCase()
    .replace(/\\/g, '/')
    .replace(/^\/\/\?\//, '')
    .replace(/\/+$/, '');
}

/**
 * True when trusting path `p` overbroadly trusts the home dir or a whole drive.
 * Windows-aware (case-insensitive, both separators). PURE, never throws.
 *
 *   - empty pN                  → false (nothing to judge)
 *   - pN is a bare drive root   → true  (e.g. "C:" / "D:" — the whole drive)
 *   - hN === pN                 → true  (home itself is trusted)
 *   - hN starts with pN + "/"   → true  (P is an ancestor of home)
 *   - else                      → false (a specific subdir like home/projects/foo)
 *
 * @param {string} p   the trusted project path
 * @param {string} home  the OS home dir
 * @returns {boolean}
 */
function isOverbroadTrust(p, home) {
  const pN = normalizeTrustPath(p);
  const hN = normalizeTrustPath(home);
  if (pN === '') return false;
  if (/^[a-z]:$/.test(pN)) return true;
  if (hN === pN) return true;
  if (hN.startsWith(pN + '/')) return true;
  return false;
}

/** A handful of leftover state-tmp files is normal churn; an accumulation is cruft. */
const STATE_TMP_BLOAT_THRESHOLD = 3;

/**
 * #28 codex-state-tmp-bloat — too many leftover `..codex-global-state.json.tmp-*`
 * files (interrupted atomic writes of .codex-global-state.json) accumulating in
 * ~/.codex → INFO. The codex analog of #13 claude-md-backup-bloat: the descriptor
 * recognizes these as KNOWN (not orphans), this check owns the "too many" judgment.
 * count > 3 fires (a few is normal churn). Codex-guarded (input.codexConfig absent on
 * a Claude run → []).
 * @param {DoctorInput} input
 * @returns {Diagnostic[]}
 */
function checkCodexStateTmpBloat(input) {
  const cc = input.codexConfig;
  if (!cc || typeof cc !== 'object') return [];
  const lt = cc.leftoverStateTmp;
  const count = lt && typeof lt === 'object' && typeof lt.count === 'number' ? lt.count : 0;
  if (count <= STATE_TMP_BLOAT_THRESHOLD) return [];
  return [{
    severity: 'info',
    code: 'codex-state-tmp-bloat',
    message: `Codex has ${count} leftover ..codex-global-state.json.tmp-* files (interrupted state writes)`,
    phase: 'doctor',
    fix: 'delete the stale ..codex-global-state.json.tmp-* files in ~/.codex (the live state is .codex-global-state.json)',
  }];
}

/**
 * The pure codex-fact checks, frozen in registry order. Spread into index.mjs CHECKS
 * after the passive checks and BEFORE ...ACTIVE_CHECKS, so passive checks stay grouped
 * and the active checks remain last → registry order ends [...,17,24,26,27,28,4,15,19].
 * @type {ReadonlyArray<import('./index.mjs').DoctorCheck>}
 */
export const CODEX_CHECKS = Object.freeze([
  Object.freeze({ id: 26, code: 'config-toml-valid', probeLevel: 'passive', run: checkConfigTomlValid }),
  Object.freeze({ id: 27, code: 'trust-overbroad', probeLevel: 'passive', run: checkTrustOverbroad }),
  Object.freeze({ id: 28, code: 'codex-state-tmp-bloat', probeLevel: 'passive', run: checkCodexStateTmpBloat }),
]);
