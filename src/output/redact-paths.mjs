/**
 * Home-directory path redaction for the CLI boundary (opt-in, --redact-paths).
 *
 * When the user passes `--redact-paths`, every absolute path in a command's
 * output that begins with the user's home directory is rewritten so the OS
 * username does not appear in the output. For example, on Windows:
 *
 *   C:\Users\alice\.claude\daemon   →  ~\.claude\daemon
 *   C:/Users/alice/.claude/hud/x    →  ~/.claude/hud/x
 *
 * The transform is APPLIED AT THE CLI BOUNDARY (src/cli.mjs run()) — after the
 * handler returns {result, diagnostics} and BEFORE render() serialises them.
 * Without the flag the code path is byte-identical to today (no-op).
 *
 * Design notes:
 *   - Two needles are built from homeDir (backslash form AND forward-slash form)
 *     so both separator styles are caught by GLOBAL replace.
 *   - On case-INSENSITIVE filesystems (Windows NTFS and macOS/APFS by default) the
 *     match is case-insensitive, so a differently-cased spelling of the same home
 *     path is still scrubbed; Linux is case-sensitive so the match is exact-case.
 *     The active platform is injectable (defaults to process.platform) so tests are
 *     deterministic on any host.
 *   - The transform is DEEP: plain objects are rebuilt (proto-poisoning keys
 *     skipped via isSafeKey), arrays are mapped, non-string primitives pass
 *     through unchanged. The INPUT is NEVER mutated (fresh copies throughout).
 *   - NEVER throws on any input, including null/undefined/garbage homeDir.
 *
 * Zero npm dependencies. Node stdlib only. Pure; never throws; never mutates.
 */

/**
 * Reject prototype-poisoning keys so a hostile result key can never pollute the
 * output object. Mirrors the project-wide isSafeKey idiom.
 * @param {string} key
 * @returns {boolean}
 */
function isSafeKey(key) {
  return key !== '__proto__' && key !== 'constructor' && key !== 'prototype';
}

/**
 * Escape all regex metacharacters in a literal string so it can be embedded in a
 * RegExp pattern without unintended matching.
 * @param {string} s
 * @returns {string}
 */
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build a RegExp that matches BOTH the backslash form and the forward-slash form
 * of homeDir, globally and (on win32) case-insensitively, so a single replace()
 * call handles all separator styles and case variants in one pass.
 *
 * Returns null when homeDir is falsy/non-string/empty (the caller treats null as
 * "no-op").
 *
 * @param {string} homeDir
 * @param {string} platform  process.platform value; controls case-sensitivity of the match
 * @returns {RegExp|null}
 */
function buildNeedleRe(homeDir, platform) {
  if (typeof homeDir !== 'string' || homeDir.length === 0) return null;

  // Normalise to both canonical forms.
  const bs = homeDir.replace(/\//g, '\\');  // backslash form
  const fs = homeDir.replace(/\\/g, '/');   // forward-slash form

  const parts = [escapeRegex(bs)];
  // Only add the forward-slash form as a separate alternative when it differs.
  if (fs !== bs) parts.push(escapeRegex(fs));

  // Case-insensitive on case-INSENSITIVE filesystems (Windows NTFS + macOS/APFS
  // default); case-sensitive on Linux. For a privacy scrub, erring toward
  // over-redaction on a case-insensitive host is the safe choice.
  const flags = (platform === 'win32' || platform === 'darwin') ? 'gi' : 'g';
  return new RegExp(parts.join('|'), flags);
}

/**
 * Return a deep-copied value with every STRING leaf having all occurrences of
 * homeDir (both backslash and forward-slash forms) replaced with '~'.
 *
 * - Plain objects: rebuilt with isSafeKey proto-safety; input not mutated.
 * - Arrays: element-mapped.
 * - Strings: every occurrence of the home prefix replaced (global).
 * - Other primitives (number, boolean, null, undefined): returned as-is.
 * - A falsy/empty/non-string homeDir: returns value unchanged (no-op; never throws).
 * - null/undefined value: returned as-is.
 *
 * NEVER throws on any input.
 *
 * @param {unknown} value    the result or diagnostics payload to redact
 * @param {string}  homeDir  the user's home directory path
 * @param {string}  [platform]  process.platform (injectable for deterministic tests);
 *                              controls whether the match is case-insensitive
 * @returns {unknown}        a fresh redacted copy (or the original if no-op)
 */
export function redactHomePaths(value, homeDir, platform = process.platform) {
  try {
    const re = buildNeedleRe(homeDir, platform);
    if (re === null) return value; // no-op: homeDir absent or non-string
    return deepRedact(value, re);
  } catch {
    // Safety net: never throw on any input.
    return value;
  }
}

/**
 * Recursive worker — performs the actual deep copy + string replacement.
 * The compiled `re` is passed down so it is built exactly once per call to
 * redactHomePaths.
 *
 * @param {unknown} value
 * @param {RegExp}  re     the compiled global needle regex
 * @returns {unknown}
 */
function deepRedact(value, re) {
  if (typeof value === 'string') {
    // Reset lastIndex because the RegExp is stateful (global flag) and may be
    // reused across recursive calls; String.replace with a /g regex is safe but
    // we reset explicitly to be defensive.
    re.lastIndex = 0;
    return value.replace(re, '~');
  }
  if (Array.isArray(value)) {
    return value.map((item) => deepRedact(item, re));
  }
  if (value !== null && typeof value === 'object') {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const key of Object.keys(value)) {
      if (!isSafeKey(key)) continue;
      out[key] = deepRedact(/** @type {any} */ (value)[key], re);
    }
    return out;
  }
  // number, boolean, null, undefined, symbol → pass through unchanged
  return value;
}
