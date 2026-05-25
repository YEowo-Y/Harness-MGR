/**
 * Access passive probe gatherer (P2.U6b-3).
 *
 * Performs the read-only I/O behind two doctor checks — keeping the doctor
 * itself pure (no I/O) by gathering facts here in the discovery layer:
 *
 *   #17 windows-file-locks — attempt a shared READ open of settings.json and
 *                            close it immediately. Success → free. A lock-type
 *                            error code → locked. ENOENT → absent.
 *                            Limitation: a read-open detects only EXCLUSIVE
 *                            locks; shared locks held by other readers will not
 *                            surface. This is the honest behaviour for a
 *                            dry-run tool that only reads.
 *
 *   #24 insecure-permissions (TODO) — icacls-based ACL probe (async, Windows).
 *                            Will be added as a second export here in a future
 *                            work unit.
 *
 * Never throws. Degrades to diagnostics on any bad input. Zero npm
 * dependencies. Node stdlib only.
 */

import { join } from 'node:path';
import { openSync, closeSync } from 'node:fs';
import { DiagnosticBag } from '../lib/diagnostic.mjs';

/**
 * @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic
 */

/**
 * @typedef {Object} LockFact
 * @property {string} path    absolute path to the file that was probed
 * @property {'free'|'locked'|'absent'|'indeterminate'} status
 *   - free          opened and closed with no error (no exclusive lock detected)
 *   - locked        OS returned EBUSY / EACCES / EPERM / ELOCK (file locked)
 *   - absent        ENOENT — the file does not exist (benign; no settings.json)
 *   - indeterminate an unexpected error; cannot determine lock status
 */

/** Error codes that indicate a lock rather than absence or an unknown error. */
const LOCK_CODES = new Set(['EBUSY', 'EACCES', 'EPERM', 'ELOCK']);

/**
 * The real opener used by default — opens the file for reading (shared) and
 * immediately closes the descriptor. Throws on any OS error (mirrors node:fs).
 * @param {string} p  absolute path
 * @returns {void}
 */
function defaultOpenFn(p) {
  const fd = openSync(p, 'r');
  closeSync(fd);
}

/**
 * Classify a caught error from openFn into a LockFact status.
 * @param {unknown} err
 * @returns {'locked'|'absent'|'indeterminate'}
 */
function classifyError(err) {
  if (err && typeof err === 'object') {
    const code = /** @type {any} */ (err).code;
    if (code === 'ENOENT') return 'absent';
    if (LOCK_CODES.has(code)) return 'locked';
  }
  return 'indeterminate';
}

/**
 * Gather the passive settings.json lock fact for the doctor layer.
 *
 * @param {{ configDir?: string, openFn?: (path: string) => void }} opts
 * @returns {{ lock: LockFact | null, diagnostics: Diagnostic[] }}
 */
export function gatherLockProbe(opts) {
  const bag = new DiagnosticBag();
  const { configDir, openFn } = opts ?? {};

  if (typeof configDir !== 'string' || configDir.length === 0) {
    bag.add({ severity: 'error', code: 'discover-bad-root', message: 'configDir must be a non-empty string', phase: 'access-probe' });
    return { lock: null, diagnostics: bag.all() };
  }

  const target = join(configDir, 'settings.json');
  const opener = typeof openFn === 'function' ? openFn : defaultOpenFn;

  /** @type {'free'|'locked'|'absent'|'indeterminate'} */
  let status;
  try {
    opener(target);
    status = 'free';
  } catch (err) {
    status = classifyError(err);
  }

  return { lock: { path: target, status }, diagnostics: bag.all() };
}
