/**
 * Rollback mode-restore (deferred follow-up #1: snapshot POSIX file-mode
 * preservation) — the PERMISSION-BIT half of the rollback write-back, split out of
 * rollback-restore.mjs so that safety-critical module stays under the 200-SLOC
 * ceiling and the two concerns are cleanly separated:
 *   - rollback-restore.mjs restores the CONTENT bytes (atomicApplyWrite);
 *   - this unit restores the FILE MODE (chmod) once those bytes have landed.
 *
 * restoreFileMode is called by restoreFile AFTER the content atomic-write succeeds.
 * It is BEST-EFFORT and ORTHOGONAL to content: the bytes are already safely written,
 * so a chmod failure is a WARN pushed onto the caller's DiagnosticBag — it does NOT
 * flip `restored` (only a content failure does; the maintainer's decision). The chmod
 * is SKIPPED entirely on win32 (no meaningful POSIX mode) and for a v1 / uncaptured
 * record (no `file.mode` → nothing to restore).
 *
 * `platform` is INJECTABLE (default process.platform) so the POSIX-chmod vs
 * win32-skip branch is deterministically testable on any host (the author's machine
 * is Windows-only). `chmodFn` is injectable (default chmodSync) for the same reason.
 *
 * Ops-layer constraint: imports only node:* stdlib + the sibling manifest model.
 * Never throws — every failure becomes a warn Diagnostic, never an exception.
 */

import { chmodSync } from 'node:fs';
import { isValidMode } from './snapshot-manifest.mjs';

/** @typedef {import('../lib/diagnostic.mjs').DiagnosticBag} DiagnosticBag */

/** Stable diagnostic phase tag — shared with rollback-restore.mjs so the mode warn
 *  reads as part of the same restore operation. */
const PHASE = 'rollback-restore';

/** Message from an unknown thrown value; never throws. */
function errMsg(e) {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Restore a captured POSIX `mode` onto `targetAbs` — but only on a POSIX host and
 * only when the record actually carried a valid mode. A chmod failure is a WARN on
 * `bag` (the content is already restored byte-identically). Never throws.
 *
 * @param {object} opts
 * @param {string}  [opts.platform]  OS id (default process.platform); win32 → skip
 * @param {(p:string, mode:number)=>void} [opts.chmodFn]  injectable (default chmodSync)
 * @param {string}  opts.targetAbs   absolute live path just written
 * @param {number|undefined} opts.mode  the record's captured mode ('' / absent → skip)
 * @param {string}  opts.rel         POSIX-relative path (for the diagnostic)
 * @param {DiagnosticBag} opts.bag
 */
export function restoreFileMode({ platform, chmodFn, targetAbs, mode, rel, bag }) {
  const plat = typeof platform === 'string' ? platform : process.platform;
  if (plat === 'win32' || !isValidMode(mode)) return; // nothing to restore
  const chmod = typeof chmodFn === 'function' ? chmodFn : chmodSync;
  try {
    chmod(targetAbs, mode);
  } catch (e) {
    bag.add({ severity: 'warn', code: 'rollback-restore-chmod-failed', phase: PHASE, path: rel,
      message: `restored ${rel} content but could not set its mode 0o${mode.toString(8)}: ${errMsg(e)}` });
  }
}
