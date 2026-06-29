/**
 * Tagged-result helpers for harness-mgr.
 *
 * A Result is a discriminated union: either `{ ok: true, value }` or
 * `{ ok: false, error }` where `error` is a Diagnostic. This keeps "never throw
 * a bare stack trace" enforceable at the boundary (per plan, the release gate
 * emits "ONE JSON envelope ... never a bare stack"): functions return a tagged
 * Result instead of throwing, and the CLI maps it to an envelope + exit code.
 *
 * Type-imports Diagnostic ONLY (clarification #3: result type-imports diagnostic
 * only — no runtime dependency on the bag).
 *
 * Zero dependencies. Pure; never throws.
 */

/**
 * @typedef {import('./diagnostic.mjs').Diagnostic} Diagnostic
 */

/**
 * @template T
 * @typedef {{ ok: true, value: T }} Ok
 */

/**
 * @typedef {{ ok: false, error: Diagnostic }} Err
 */

/**
 * @template T
 * @typedef {Ok<T> | Err} Result
 */

/**
 * Construct a success result.
 * @template T
 * @param {T} value
 * @returns {Ok<T>}
 */
export function ok(value) {
  return { ok: true, value };
}

/**
 * Construct a failure result from a Diagnostic.
 * @param {Diagnostic} diagnostic
 * @returns {Err}
 */
export function err(diagnostic) {
  return { ok: false, error: diagnostic };
}

/**
 * Type guard: true when the result is a success.
 * @template T
 * @param {Result<T>} result
 * @returns {result is Ok<T>}
 */
export function isOk(result) {
  return Boolean(result) && result.ok === true;
}

/**
 * Type guard: true when the result is a failure.
 * @template T
 * @param {Result<T>} result
 * @returns {result is Err}
 */
export function isErr(result) {
  return Boolean(result) && result.ok === false;
}
