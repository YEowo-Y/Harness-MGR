/**
 * Snapshot pin marker (P3.U21) — pins a snapshot so `gc` retains it. The marker
 * file lives at `<mgrStateDir>/snapshots/<id>/.pin` (plan line 335); its presence
 * is the pin (the small JSON body is informational only).
 *
 * WRITE-SIDE DISCIPLINE (mirrors lock.mjs):
 *   - `pinSnapshot` is a CREATE → it INJECTS + REQUIRES the fail-safe governed-write
 *     gate `assertWritable` (refuses with a diagnostic if absent, never silently
 *     bypasses). The marker lives under `.mgr-state`, so the gate's `.mgr-state`
 *     passthrough permits it in the 'apply' context — no new write context is
 *     needed (same as lock / journal / audit-writer).
 *   - `unpinSnapshot` is a bounded DELETE → it does NOT inject the gate (mirroring
 *     `releaseLock` / `gcSnapshots`): the id is validated and the path is
 *     RECONSTRUCTED via `pinMarkerPath` (built on `snapshotDir`), so the unlink is
 *     bounded to `<mgrStateDir>/snapshots/<id>/.pin` and can never escape.
 *
 * Ops-layer constraint: imports only node:* stdlib + src/lib/** + the sibling
 * snapshot-manifest model. Never throws — every failure becomes a Diagnostic.
 * Zero npm dependencies.
 */

import { existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { DiagnosticBag } from '../lib/diagnostic.mjs';
import { isValidSnapshotId, snapshotDir } from './snapshot-manifest.mjs';

/** @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic */

/** Stable diagnostic phase tag for this module's findings. */
const PHASE = 'snapshot';

/** The pin marker filename inside a snapshot dir. */
export const PIN_MARKER_NAME = '.pin';

/** Message from an unknown thrown value; never throws. */
function errMsg(e) {
  return e instanceof Error ? e.message : String(e);
}

/** Best-effort ISO from an injected clock; never throws. */
function clockIso(now) {
  try {
    const d = typeof now === 'function' ? now() : new Date();
    if (d instanceof Date && !Number.isNaN(d.getTime())) return d.toISOString();
  } catch { /* fall through */ }
  return new Date(0).toISOString();
}

/**
 * Absolute path to a snapshot's pin marker. Pure.
 * @param {string} mgrStateDir
 * @param {string} snapshotId
 * @returns {string}
 */
export function pinMarkerPath(mgrStateDir, snapshotId) {
  return join(snapshotDir(mgrStateDir, snapshotId), PIN_MARKER_NAME);
}

/**
 * Whether a snapshot is pinned (its `.pin` marker exists). Never throws. Returns
 * false for an invalid id or a non-string mgrStateDir (no valid marker path to
 * probe). `existsFn` defaults to `existsSync`.
 *
 * @param {object} opts
 * @param {string} opts.mgrStateDir
 * @param {string} opts.snapshotId
 * @param {(p:string)=>boolean} [opts.existsFn]
 * @returns {boolean}
 */
export function isPinned(opts) {
  const { mgrStateDir, snapshotId, existsFn } = opts ?? {};
  if (typeof mgrStateDir !== 'string' || mgrStateDir.length === 0) return false;
  if (!isValidSnapshotId(snapshotId)) return false;
  const exists = typeof existsFn === 'function' ? existsFn : existsSync;
  try { return exists(pinMarkerPath(mgrStateDir, snapshotId)) === true; }
  catch { return false; }
}

/**
 * Pin a snapshot by writing its `.pin` marker. A CREATE: the governed-write gate
 * is INJECTED + REQUIRED (fail-safe). Refuses to pin a snapshot whose dir does not
 * exist. Never throws.
 *
 * @param {object} opts
 * @param {string} opts.mgrStateDir
 * @param {string} opts.snapshotId
 * @param {(path:string, ctx:string)=>string} opts.assertWritable  REQUIRED governed-write gate
 * @param {() => Date} [opts.now]
 * @param {{write?:Function, existsFn?:Function}} [opts.seams]
 * @returns {{ pinned: boolean, path: string|null, diagnostics: Diagnostic[] }}
 */
export function pinSnapshot(opts) {
  const { mgrStateDir, snapshotId, assertWritable, now, seams = {} } = opts ?? {};
  const bag = new DiagnosticBag();
  const fail = (code, message, path) => {
    bag.add({ severity: 'error', code, message, phase: PHASE, ...(path ? { path } : {}) });
    return { pinned: false, path: path ?? null, diagnostics: bag.all() };
  };

  if (typeof mgrStateDir !== 'string' || mgrStateDir.length === 0) {
    return fail('snapshot-pin-error', 'mgrStateDir must be a non-empty string');
  }
  if (!isValidSnapshotId(snapshotId)) {
    return fail('snapshot-pin-id-invalid', 'snapshotId must be a valid snapshot id');
  }
  // Fail-safe: the governed-write gate is REQUIRED (no default). A missing
  // injection refuses rather than silently bypassing the gate.
  if (typeof assertWritable !== 'function') {
    return fail('snapshot-pin-error', 'assertWritable (the governed-write gate) must be injected');
  }

  const exists = typeof seams.existsFn === 'function' ? seams.existsFn : existsSync;
  // You cannot pin a snapshot that is not there.
  if (exists(snapshotDir(mgrStateDir, snapshotId)) !== true) {
    return fail('snapshot-pin-not-found', `no snapshot ${snapshotId} to pin`);
  }

  const marker = pinMarkerPath(mgrStateDir, snapshotId);
  try { assertWritable(marker, 'apply'); }
  catch (e) { return fail('snapshot-pin-error', `write gate denied: ${errMsg(e)}`, marker); }

  const write = typeof seams.write === 'function'
    ? seams.write : ((p, c) => writeFileSync(p, c, 'utf8'));
  const content = `${JSON.stringify({ pinnedAt: clockIso(now) })}\n`;
  try { write(marker, content); }
  catch (e) { return fail('snapshot-pin-error', `could not write pin marker: ${errMsg(e)}`, marker); }

  // Light verify: confirm the marker is now present.
  let present;
  try { present = exists(marker) === true; }
  catch { present = false; }
  if (!present) {
    return fail('snapshot-pin-verify-failed', 'pin marker not present after write', marker);
  }
  return { pinned: true, path: marker, diagnostics: bag.all() };
}

/**
 * Unpin a snapshot by removing its `.pin` marker. A bounded DELETE: the id is
 * validated and the path RECONSTRUCTED via `pinMarkerPath`, so no gate is needed
 * (mirrors `releaseLock`). An absent marker is benign (unpinned:false, no
 * diagnostic — it simply was not pinned). Never throws.
 *
 * @param {object} opts
 * @param {string} opts.mgrStateDir
 * @param {string} opts.snapshotId
 * @param {{unlink?:Function}} [opts.seams]
 * @returns {{ unpinned: boolean, diagnostics: Diagnostic[] }}
 */
export function unpinSnapshot(opts) {
  const { mgrStateDir, snapshotId, seams = {} } = opts ?? {};
  const bag = new DiagnosticBag();
  const fail = (code, message, path) => {
    bag.add({ severity: 'error', code, message, phase: PHASE, ...(path ? { path } : {}) });
    return { unpinned: false, diagnostics: bag.all() };
  };

  if (typeof mgrStateDir !== 'string' || mgrStateDir.length === 0) {
    return fail('snapshot-pin-error', 'mgrStateDir must be a non-empty string');
  }
  if (!isValidSnapshotId(snapshotId)) {
    return fail('snapshot-pin-id-invalid', 'snapshotId must be a valid snapshot id');
  }

  const marker = pinMarkerPath(mgrStateDir, snapshotId);
  const unlink = typeof seams.unlink === 'function' ? seams.unlink : unlinkSync;
  try { unlink(marker); return { unpinned: true, diagnostics: bag.all() }; }
  catch (e) {
    if (e && e.code === 'ENOENT') return { unpinned: false, diagnostics: bag.all() }; // benign: not pinned
    bag.add({ severity: 'warn', code: 'snapshot-unpin-error', phase: PHASE, path: marker,
      message: `could not remove pin marker: ${errMsg(e)}` });
    return { unpinned: false, diagnostics: bag.all() };
  }
}
