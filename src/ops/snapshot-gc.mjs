/**
 * Snapshot gc machinery (P3.U21) — the retention-partition + BOUNDED-delete helpers
 * for `gcSnapshots`. Extracted from snapshot-store.mjs so that module stays under the
 * 200-SLOC lint ceiling (the sanctioned fix, not a pragma) along a clean seam:
 * snapshot-store.mjs keeps the `listSnapshots` / `gcSnapshots` PUBLIC orchestrators,
 * this module holds the pure retention logic + the security-critical single-dir delete.
 *
 * SECURITY-CRITICAL — the gc DELETE path (`deleteSnapshotDir`). A retention prune
 * removes whole snapshot dirs, so the delete is provably BOUNDED to
 * `<mgrStateDir>/snapshots/<id>/` and can NEVER rm-rf, recurse, or escape:
 *   1. Every id is re-validated against SNAPSHOT_ID_RE (the strict timestamp shape
 *      doubles as a path-traversal guard — an id holds no separators/dots/`..`).
 *   2. The dir path is always RECONSTRUCTED from `snapshotDir(...)`, never taken from
 *      a readdir result, so a crafted entry name can never become a delete target.
 *   3. The delete is targeted: readdir the ONE dir, `unlink` each DIRECT REGULAR FILE
 *      only (a subdir or symlink is skipped + warned, never followed/recursed), then
 *      `rmdir` which removes an EMPTY dir only. There is NO `rmSync({recursive})`.
 * This mirrors `snapshot.mjs::cleanupFailedSnapshot`, the established D2 pattern.
 *
 * Ops-layer constraint: imports only node:* stdlib + src/lib/** + the sibling
 * snapshot-manifest model + audit (toEpochMs). Never throws — every failure becomes a
 * Diagnostic (or a safe fallback). Zero npm dependencies.
 */

import { join } from 'node:path';
import { isValidSnapshotId, snapshotDir } from './snapshot-manifest.mjs';
import { isPinned } from './snapshot-pin.mjs';
import { toEpochMs } from './audit.mjs';

/** @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic */
/** @typedef {import('./snapshot-store.mjs').SnapshotSummary} SnapshotSummary */

/** Stable diagnostic phase tag for this module's findings. */
const PHASE = 'snapshot';

/** Message from an unknown thrown value; never throws. */
function errMsg(e) {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Compute the RETAIN decision for an ordered (newest-first) snapshot list.
 *
 * `keep`:        retain the N NEWEST (the first N in newest-first order).
 * `olderThanMs`: retain those whose effective time is NEWER than `now - olderThanMs`
 *                (so "older than" deletes the OLD ones). A snapshot's effective time
 *                is its manifest createdAt epoch, falling back to its id-timestamp
 *                epoch; an unresolvable time is treated as VERY OLD (epoch -Infinity)
 *                so an unparseable/incomplete snapshot is a prune CANDIDATE under
 *                --older-than rather than retained forever.
 * BOTH given:    retain only if BOTH say retain (the stricter intersection).
 * PINNED:        a pinned id (in `pinnedIds`) is ALWAYS retained — a pin force-
 *                retains, overriding `keep`/`olderThanMs` (P3.U21).
 *
 * @param {SnapshotSummary[]} ordered   newest-first
 * @param {number|null} keep            count to keep, or null
 * @param {number|null} olderThanMs     age window in ms, or null
 * @param {number} nowMs                current epoch ms
 * @param {Set<string>} pinnedIds       ids force-retained regardless of criteria
 * @returns {{ retained: string[], toDelete: string[], pinSaved: string[] }}
 *   `pinSaved` = pinned ids the criteria WOULD have deleted (surfaced as info).
 */
export function partitionRetention(ordered, keep, olderThanMs, nowMs, pinnedIds) {
  const cutoff = olderThanMs !== null ? nowMs - olderThanMs : null;
  /** @type {string[]} */
  const retained = [];
  /** @type {string[]} */
  const toDelete = [];
  /** @type {string[]} */
  const pinSaved = [];
  for (let i = 0; i < ordered.length; i++) {
    const snap = ordered[i];
    const byKeep = keep !== null ? i < keep : true;            // among the N newest
    let byAge = true;
    if (cutoff !== null) {
      const epoch = snapshotEpoch(snap);
      byAge = epoch > cutoff;                                  // newer than the window
    }
    // A pin force-retains, overriding every other criterion. Record when the pin
    // is what saved the snapshot (the criteria alone would have pruned it).
    if (pinnedIds.has(snap.id)) {
      retained.push(snap.id);
      if (!(byKeep && byAge)) pinSaved.push(snap.id);
      continue;
    }
    // Retain only if EVERY active criterion retains (stricter intersection).
    if (byKeep && byAge) retained.push(snap.id);
    else toDelete.push(snap.id);
  }
  return { retained, toDelete, pinSaved };
}

/**
 * The set of listed ids that are PINNED (force-retained). The pin check is the
 * injectable `seams.isPinnedFn` (default `isPinned`) so a test can control pin
 * status without real `.pin` files; the marker probe uses `seams.existsFn`. An
 * invalid id is naturally not pinned (isPinned returns false). Never throws — a
 * non-string id is skipped (Low-2), and a throwing injected `isPinnedFn` is treated
 * as "not pinned" (Low-1: fail-open is safe — an un-evaluatable pin is simply
 * prunable, and the default isPinned never throws).
 * @param {string} mgrStateDir
 * @param {SnapshotSummary[]} snapshots
 * @param {object} seams
 * @returns {Set<string>}
 */
export function computePinnedIds(mgrStateDir, snapshots, seams) {
  const pinFn = typeof seams.isPinnedFn === 'function' ? seams.isPinnedFn : isPinned;
  /** @type {Set<string>} */
  const pinned = new Set();
  for (const snap of snapshots) {
    const id = snap?.id;
    if (typeof id !== 'string') continue; // Low-2: a non-string id can never be pinned
    let isP = false;
    // Low-1: a hostile injected isPinnedFn that throws must not abort gc — fail open.
    try { isP = pinFn({ mgrStateDir, snapshotId: id, existsFn: seams.existsFn }) === true; }
    catch { isP = false; }
    if (isP) pinned.add(id);
  }
  return pinned;
}

/**
 * The effective epoch-ms of a snapshot for age comparison: manifest createdAt,
 * else the id timestamp, else -Infinity (treat as very old → a prune candidate).
 * @param {SnapshotSummary} snap
 * @returns {number}
 */
export function snapshotEpoch(snap) {
  const fromCreated = toEpochMs(snap && snap.createdAt);
  if (fromCreated !== null) return fromCreated;
  const fromId = toEpochMs(idToIso(snap && snap.id));
  if (fromId !== null) return fromId;
  return -Infinity;
}

/**
 * Convert a snapshot id (YYYY-MM-DDTHH-MM-SSZ) back into a parseable ISO string
 * (YYYY-MM-DDTHH:MM:SSZ) by restoring the time-segment colons. Returns '' for a
 * non-id input so toEpochMs yields null. Never throws.
 * @param {unknown} id
 * @returns {string}
 */
export function idToIso(id) {
  if (!isValidSnapshotId(id)) return '';
  // Split on 'T'; only the time half's '-' separators become ':'.
  const [date, time] = id.split('T');
  return `${date}T${time.replace(/-/g, ':')}`;
}

/**
 * BOUNDED DELETE of ONE snapshot dir (the security-critical helper). Re-validates
 * the id, RECONSTRUCTS the dir via `snapshotDir(...)`, readdir's that ONE dir, and
 * `unlink`s each DIRECT REGULAR FILE; a subdir or symlink entry is SKIPPED + warned
 * (never followed, never recursed). Then `rmdir` removes the dir ONLY if it is now
 * empty. NEVER recursive / rm-rf. A delete error → a warn (the caller continues
 * with the next id). Returns true iff the dir was removed. Never throws.
 *
 * @param {string} mgrStateDir
 * @param {string} id
 * @param {{ readdirFn:(p:string)=>import('node:fs').Dirent[], unlinkFn:(p:string)=>void, rmdirFn:(p:string)=>void }} seams
 * @param {import('../lib/diagnostic.mjs').DiagnosticBag} bag
 * @returns {boolean}
 */
export function deleteSnapshotDir(mgrStateDir, id, seams, bag) {
  // Defense-in-depth: refuse a corrupted id rather than touch an unexpected path.
  if (!isValidSnapshotId(id)) {
    bag.add({ severity: 'warn', code: 'gc-delete-skipped', phase: PHASE,
      message: 'gc skipped an entry whose id failed re-validation (refusing to remove an unexpected path)' });
    return false;
  }
  const dir = snapshotDir(mgrStateDir, id);

  /** @type {import('node:fs').Dirent[]} */
  let entries;
  try {
    const r = seams.readdirFn(dir);
    entries = Array.isArray(r) ? r : [];
  } catch (e) {
    if (e && e.code === 'ENOENT') return false; // already gone
    bag.add({ severity: 'warn', code: 'gc-delete-failed', phase: PHASE, path: id,
      message: `could not read snapshot dir for deletion: ${errMsg(e)}` });
    return false;
  }

  // Unlink each DIRECT regular file only. A subdir or symlink is never followed
  // or recursed — it is skipped + warned, and will keep the dir non-empty so the
  // rmdir below fails safe (the dir survives).
  for (const ent of entries) {
    const name = ent && typeof ent.name === 'string' ? ent.name : String(ent);
    if (!ent || typeof ent.isFile !== 'function' || !ent.isFile() || ent.isSymbolicLink()) {
      bag.add({ severity: 'warn', code: 'gc-delete-skipped-entry', phase: PHASE, path: `${id}/${name}`,
        message: 'gc left a non-regular-file entry untouched (no recursion / no symlink follow)' });
      continue;
    }
    try { seams.unlinkFn(join(dir, name)); }
    catch (e) {
      if (!(e && e.code === 'ENOENT')) {
        bag.add({ severity: 'warn', code: 'gc-delete-failed', phase: PHASE, path: `${id}/${name}`,
          message: `could not remove snapshot file: ${errMsg(e)}` });
      }
    }
  }

  // rmdir removes the dir ONLY if empty (never recursive). A leftover (an
  // untouched subdir/symlink) makes this fail → warn, leave the dir in place.
  try { seams.rmdirFn(dir); return true; }
  catch (e) {
    if (!(e && e.code === 'ENOENT')) {
      bag.add({ severity: 'warn', code: 'gc-delete-failed', phase: PHASE, path: id,
        message: `could not remove snapshot dir (left in place): ${errMsg(e)}` });
    }
    return false;
  }
}

/**
 * Normalize the `keep` option: a finite integer >= 0, else null (criterion absent).
 * @param {unknown} keep
 * @returns {number|null}
 */
export function normalizeKeep(keep) {
  if (typeof keep !== 'number' || !Number.isInteger(keep) || keep < 0) return null;
  return keep;
}

/**
 * Normalize the `olderThanMs` option: a finite number > 0, else null (absent).
 * @param {unknown} ms
 * @returns {number|null}
 */
export function normalizeOlderThan(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return null;
  return ms;
}
