/**
 * Secrets allowlist matcher (P3.U3).
 *
 * A pure, never-throws predicate over file paths: does this path name a secret
 * file that a snapshot must NEVER capture (even with `--include-auth`)? The
 * pattern data lives in the sibling `src/config/secrets-allowlist.json` so the
 * list is transparent + extensible without code edits (threat-model H2).
 *
 * Matching is on the BASENAME only (the last path segment) and is
 * case-INSENSITIVE — secrets detection errs toward catching more, and Windows
 * filenames are case-insensitive anyway. Matching the basename (not the full
 * path) is what keeps a legitimately-named nested file like
 * `skills/x-api/SKILL.md` from being dropped just because an ancestor directory
 * contains a sensitive word.
 *
 * Three pattern kinds, checked in order (extension → exact → glob):
 *   - extensions: the file's extension, e.g. `pem` matches `server.pem`
 *   - exactNames: the whole basename, e.g. `id_rsa`, `.credentials.json`
 *   - globNames:  a basename glob where `*` = any run, e.g. `.env.*`, `*-token*`
 *
 * SCOPE (P3.U3): this unit only implements "match the configured patterns
 * correctly". WHICH patterns to trust, content-sniffing, and proving that legit
 * `*token*` skills are still captured are the secrets-FILTER's policy concern
 * (P3.U6, `snapshot-secrets-filter.mjs`), which consumes this matcher.
 *
 * Zero npm dependencies. Pure; never throws on any input.
 */

import SECRETS_ALLOWLIST from '../config/secrets-allowlist.json' with { type: 'json' };

export { SECRETS_ALLOWLIST };

/**
 * @typedef {Object} SecretMatch
 * @property {boolean} match
 * @property {'extension'|'exact'|'glob'} [kind]  which rule matched (only when match)
 * @property {string} [pattern]                   the matching pattern (only when match)
 */

/** Last path segment, splitting on BOTH separators (cross-platform). */
function basenameOf(p) {
  if (typeof p !== 'string' || p.length === 0) return '';
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] ?? '';
}

/** Lowercased extension WITHOUT the dot, or '' for no-extension / dotfile. */
function extensionOf(base) {
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return ''; // no dot, or a leading-dot dotfile (e.g. `.env`)
  return base.slice(dot + 1).toLowerCase();
}

/** Compile a basename glob (`*` = any run) to an anchored, case-insensitive RegExp. */
function globToRegExp(glob) {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

/**
 * Classify a path against the allowlist. Returns the FIRST matching rule (so the
 * caller can name the reason in a Diagnostic). A non-string path, an empty
 * basename, or a malformed allowlist yields `{ match: false }`. Never throws.
 *
 * @param {unknown} filePath
 * @param {{extensions?:string[], exactNames?:string[], globNames?:string[]}} [allowlist]
 * @returns {SecretMatch}
 */
export function matchesSecret(filePath, allowlist = SECRETS_ALLOWLIST) {
  const base = basenameOf(filePath).toLowerCase();
  if (base === '') return { match: false };
  const al = allowlist && typeof allowlist === 'object' ? allowlist : {};

  // 1. extension
  const ext = extensionOf(base);
  if (ext && Array.isArray(al.extensions)) {
    for (const e of al.extensions) {
      if (typeof e === 'string' && e.toLowerCase() === ext) {
        return { match: true, kind: 'extension', pattern: `*.${ext}` };
      }
    }
  }
  // 2. exact basename
  if (Array.isArray(al.exactNames)) {
    for (const name of al.exactNames) {
      if (typeof name === 'string' && name.toLowerCase() === base) {
        return { match: true, kind: 'exact', pattern: name };
      }
    }
  }
  // 3. basename glob
  if (Array.isArray(al.globNames)) {
    for (const g of al.globNames) {
      if (typeof g !== 'string') continue;
      let re;
      try { re = globToRegExp(g); } catch { continue; }
      if (re.test(base)) return { match: true, kind: 'glob', pattern: g };
    }
  }
  return { match: false };
}

/**
 * Boolean convenience over matchesSecret. Never throws.
 * @param {unknown} filePath
 * @param {object} [allowlist]
 * @returns {boolean}
 */
export function isSecretFile(filePath, allowlist = SECRETS_ALLOWLIST) {
  return matchesSecret(filePath, allowlist).match;
}
