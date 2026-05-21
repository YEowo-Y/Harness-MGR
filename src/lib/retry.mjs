/**
 * Retry helpers for transient Windows filesystem failures.
 *
 * Windows frequently throws EBUSY / EPERM (and friends) when a file is briefly
 * held by AV scanners, indexers, or another handle. Per plan, retry.mjs offers
 * withRetry(fn, {tries, backoffMs, codes}) plus a readFileWithRetry convenience
 * (the SAME retry is applied to READS — closes the v3 gap).
 *
 * `backoffMs` is an explicit per-attempt schedule (default [50,100,200,400,800]):
 * the delay before retry N is backoffMs[N-1], clamped to the last entry if the
 * schedule is shorter than `tries`. Backoff uses node:timers/promises setTimeout.
 *
 * Zero npm dependencies.
 */

import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';

/** Default error codes treated as transient + retryable on Windows. */
export const DEFAULT_RETRY_CODES = Object.freeze(['EBUSY', 'EPERM']);

/** Default per-attempt backoff schedule (ms). */
export const DEFAULT_BACKOFF_MS = Object.freeze([50, 100, 200, 400, 800]);

/**
 * @typedef {Object} RetryOptions
 * @property {number} [tries]       max attempts including the first (default 5)
 * @property {number[]} [backoffMs] per-attempt delay schedule (default DEFAULT_BACKOFF_MS)
 * @property {string[]} [codes]     err.code values to retry on (default DEFAULT_RETRY_CODES)
 */

/**
 * Resolve the delay before the next attempt from the schedule, clamping to the
 * last entry when the schedule is shorter than the attempt index.
 * @param {number[]} schedule
 * @param {number} attempt  1-based attempt that just failed
 * @returns {number}
 */
function backoffFor(schedule, attempt) {
  if (!schedule.length) return 0;
  const idx = Math.min(attempt - 1, schedule.length - 1);
  const ms = schedule[idx];
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

/**
 * Run an async fn, retrying on transient error codes with scheduled backoff.
 * Re-throws the last error if all tries are exhausted, or immediately if the
 * error code is not in the retryable set.
 *
 * @template T
 * @param {() => Promise<T> | T} fn
 * @param {RetryOptions} [options]
 * @returns {Promise<T>}
 */
export async function withRetry(fn, options = {}) {
  const tries = Number.isInteger(options.tries) && options.tries > 0 ? options.tries : 5;
  const schedule = Array.isArray(options.backoffMs) ? options.backoffMs : DEFAULT_BACKOFF_MS;
  const codes = Array.isArray(options.codes) ? options.codes : DEFAULT_RETRY_CODES;

  let lastErr;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const code = err && typeof err === 'object' ? err.code : undefined;
      const retryable = code !== undefined && codes.includes(code);
      if (!retryable || attempt === tries) {
        throw err;
      }
      const delay = backoffFor(schedule, attempt);
      if (delay > 0) await sleep(delay);
    }
  }
  // Unreachable, but keeps types honest.
  throw lastErr;
}

/**
 * Read a file with retry on transient FS errors.
 * @param {string} path
 * @param {{encoding?: BufferEncoding} & RetryOptions} [options]
 * @returns {Promise<string|Buffer>}
 */
export async function readFileWithRetry(path, options = {}) {
  const { encoding = 'utf-8', ...retryOpts } = options;
  return withRetry(() => readFile(path, encoding), retryOpts);
}
