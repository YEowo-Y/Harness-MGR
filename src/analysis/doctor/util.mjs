/**
 * Shared pure helpers for the doctor layer. No I/O, no clock; never throw.
 * Zero npm dependencies. Node stdlib only.
 */

/**
 * Coerce to a non-empty string, else the fallback.
 * @param {unknown} v
 * @param {string} fallback
 * @returns {string}
 */
export function strOr(v, fallback) {
  return typeof v === 'string' && v.length > 0 ? v : fallback;
}

/**
 * Coerce to a finite number, else the fallback.
 * @param {unknown} v
 * @param {number} fallback
 * @returns {number}
 */
export function numOr(v, fallback) {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
