/**
 * Precise sensitive-name classification shared by display redactors.
 *
 * The broad `isSensitivePointer` policy in plan.mjs is correct for journal JSON
 * pointers, but unsafe for free-form names: substring matching would treat benign
 * names such as `monkey`, `keychain`, and `publicKey` as credentials. This helper
 * keeps the vocabulary single-sourced while matching separator/camel-case segments
 * and retaining the established public-key/key-id vetoes.
 */

import { SENSITIVE_KEY_PATTERNS } from './plan.mjs';

const AMBIGUOUS_PATTERNS = new Set(['key', 'auth']);
const BENIGN_QUALIFIERS = new Set(['public', 'pub', 'id']);
const ACRONYM_BOUNDARY_RE = /([A-Z]+)([A-Z][a-z])/g;
const CAMEL_BOUNDARY_RE = /([a-z0-9])([A-Z])/g;
const SEGMENT_SEP_RE = /[-_.]+/;
const SENSITIVE_HINT_RE = new RegExp(SENSITIVE_KEY_PATTERNS.join('|'), 'i');

/**
 * Classify a flag, config key, or argument name as sensitive. Leading dashes are
 * ignored; `-`, `_`, and `.` split exact-match segments.
 * Ambiguous `key`/`auth` segments are vetoed by public/pub/id qualifiers unless a
 * non-ambiguous sensitive segment is also present. Pure; never throws.
 * @param {unknown} name
 * @returns {boolean}
 */
export function isSensitiveName(name) {
  if (typeof name !== 'string' || name.length === 0) return false;
  if (!SENSITIVE_HINT_RE.test(name)) return false;
  const normalized = name.replace(/^-+/, '').toLowerCase();
  const segments = normalized.split(SEGMENT_SEP_RE).filter(Boolean);
  const sensitive = segments.filter((segment) => SENSITIVE_KEY_PATTERNS.includes(segment));
  if (sensitive.length === 0) return false;
  if (sensitive.some((word) => !AMBIGUOUS_PATTERNS.has(word))) return true;
  return !segments.some((segment) => BENIGN_QUALIFIERS.has(segment));
}

/** Config-key variant that additionally recognises camelCase/acronyms and plurals. */
export function isSensitiveConfigKey(name) {
  if (typeof name !== 'string') return false;
  if (!SENSITIVE_HINT_RE.test(name)) return false;
  const expanded = name
    .replace(ACRONYM_BOUNDARY_RE, '$1-$2')
    .replace(CAMEL_BOUNDARY_RE, '$1-$2');
  if (isSensitiveName(expanded)) return true;
  const singular = expanded.split(SEGMENT_SEP_RE).map((segment) => {
    const lower = segment.toLowerCase();
    return lower.endsWith('s') && SENSITIVE_KEY_PATTERNS.includes(lower.slice(0, -1))
      ? segment.slice(0, -1) : segment;
  }).join('-');
  return singular !== expanded && isSensitiveName(singular);
}
