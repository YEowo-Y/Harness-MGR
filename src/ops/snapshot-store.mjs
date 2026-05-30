/**
 * Snapshot store (P3/P4a) — the READ + GARBAGE-COLLECT side of snapshot
 * management. The CREATE side is `snapshot.mjs`; this module lets the user SEE
 * their snapshots (`listSnapshots`) and PRUNE old ones (`gcSnapshots`).
 *
 * SECURITY-CRITICAL — the gc DELETE path. A retention prune removes whole
 * snapshot dirs, so the delete is provably BOUNDED to `<mgrStateDir>/snapshots/<id>/`
 * and can NEVER rm-rf, recurse, or escape:
 *   1. Every id is re-validated against SNAPSHOT_ID_RE (the strict timestamp shape
 *      doubles as a path-traversal guard — an id holds no separators/dots/`..`, so
 *      `snapshotDir(mgrStateDir, id)` can never resolve outside the snapshots dir).
 *   2. The dir path is always RECONSTRUCTED from `snapshotDir(...)`, never taken
 *      from a readdir result, so a crafted entry name (`../evil`, `..`, a symlink)
 *      can never become a delete target.
 *   3. The delete itself is targeted: readdir the ONE dir, `unlink` each DIRECT
 *      REGULAR FILE only (a subdir or symlink is skipped + warned — never followed,
 *      never recursed), then `rmdir` which removes an EMPTY dir only. There is NO
 *      `rmSync({recursive})` / rm-rf anywhere. An unexpected leftover (non-empty
 *      after unlink) makes `rmdir` fail → a warn, and the dir is left in place
 *      (fail-safe).
 * This mirrors `snapshot.mjs::cleanupFailedSnapshot`, the established D2 pattern.
 *
 * DRY-RUN BY DEFAULT: `gcSnapshots` with `apply:false` (the default) computes and
 * returns `wouldDelete[]` and deletes NOTHING. Only `apply:true` performs the
 * bounded delete. gc also REQUIRES at least one retention criterion (`keep` or
 * `olderThanMs`); with neither it deletes nothing and emits a `gc-no-criterion`
 * warn (refusing to interpret "no criteria" as "delete everything").
 *
 * Ops-layer constraint: imports only node:* stdlib and src/lib/** + the sibling
 * snapshot-manifest model. Never throws — every failure becomes a Diagnostic.
 * No paths.mjs / assertWritable: list/gc are pure `.mgr-state` I/O (no governed-
 * config write); the delete is bounded by the id regex + snapshotDir construction,
 * not the write gate. Zero npm dependencies.
 */

import { readdirSync, unlinkSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { DiagnosticBag } from '../lib/diagnostic.mjs';
import { readManifest } from './snapshot-manifest-io.mjs';
import {
  SNAPSHOTS_DIRNAME, isValidSnapshotId, snapshotDir,
} from './snapshot-manifest.mjs';
import { toEpochMs } from './audit.mjs';

/** @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic */

/** Stable diagnostic phase tag for this module's findings. */
const PHASE = 'snapshot';

/**
 * @typedef {Object} SnapshotSummary
 * @property {string} id            the snapshot dir name (matches SNAPSHOT_ID_RE)
 * @property {string} [createdAt]   manifest createdAt (only when complete)
 * @property {string} [reason]      manifest reason (only when complete)
 * @property {number} [fileCount]   manifest files.length (only when complete)
 * @property {boolean} complete     true iff a readable, parseable manifest was found
 */

/** Message from an unknown thrown value; never throws. */
function errMsg(e) {
  return e instanceof Error ? e.message : String(e);
}

/** True for a non-empty string. */
function isNonEmptyStr(v) {
  return typeof v === 'string' && v.length > 0;
}

/**
 * Read the directory entry NAMES of `<mgrStateDir>/snapshots/`. A missing dir is
 * benign (no snapshots taken yet) → empty list, no diagnostic. Any other readdir
 * error → empty list + a warn. Never throws.
 *
 * @param {string} mgrStateDir
 * @param {(p:string)=>string[]} readdirFn
 * @param {DiagnosticBag} bag
 * @returns {string[]}
 */
function listSnapshotDirNames(mgrStateDir, readdirFn, bag) {
  const root = join(mgrStateDir, SNAPSHOTS_DIRNAME);
  try {
    const names = readdirFn(root);
    return Array.isArray(names) ? names : [];
  } catch (e) {
    if (e && e.code === 'ENOENT') return []; // benign: no snapshots dir yet
    bag.add({ severity: 'warn', code: 'snapshot-list-unreadable', phase: PHASE, path: root,
      message: `could not read snapshots dir: ${errMsg(e)}` });
    return [];
  }
}

/**
 * Build one SnapshotSummary for a snapshot id. Reads its manifest.json; a present,
 * parseable, schema-shaped manifest → a COMPLETE summary (createdAt/reason/
 * fileCount); a missing/invalid manifest → an INCOMPLETE summary ({id, complete:
 * false}) which is still LISTED (a half-written or foreign dir should be visible,
 * not hidden). Never throws. Manifest read diagnostics are intentionally NOT
 * surfaced here — an incomplete snapshot is a fact for the user to see, not an
 * error condition for the list command.
 *
 * @param {string} mgrStateDir
 * @param {string} id          (already validated against SNAPSHOT_ID_RE)
 * @param {(p:string)=>string} [readFn]   injectable manifest reader
 * @returns {SnapshotSummary}
 */
function summarizeSnapshotDir(mgrStateDir, id, readFn) {
  const { manifest } = readManifest({ stateDir: mgrStateDir, snapshotId: id, readFn });
  if (!manifest || typeof manifest !== 'object') return { id, complete: false };
  const files = Array.isArray(manifest.files) ? manifest.files : null;
  // A usable summary needs at least the file list; createdAt/reason are best-effort.
  if (!files) return { id, complete: false };
  return {
    id,
    createdAt: typeof manifest.createdAt === 'string' ? manifest.createdAt : '',
    reason: typeof manifest.reason === 'string' ? manifest.reason : '',
    fileCount: files.length,
    complete: true,
  };
}

/**
 * List every snapshot under `<mgrStateDir>/snapshots/`, newest first.
 *
 * Each dir whose name matches SNAPSHOT_ID_RE becomes a SnapshotSummary; a
 * non-id-named entry is ignored (it is not a snapshot this tool created). A dir
 * with a readable manifest is `complete:true` with createdAt/reason/fileCount; a
 * dir with no/invalid manifest is `complete:false` (still listed). Sorted
 * NEWEST-FIRST by id — the id is a sortable UTC timestamp, so a plain string
 * descending sort is chronological. A missing snapshots dir → `{snapshots:[]}`.
 * Never throws.
 *
 * @param {object} opts
 * @param {string} opts.mgrStateDir            absolute path to the .mgr-state dir
 * @param {(p:string)=>string[]} [opts.readdirFn]  injectable dir reader (tests)
 * @param {(p:string)=>string} [opts.readFn]       injectable manifest reader (tests)
 * @returns {{ snapshots: SnapshotSummary[], diagnostics: Diagnostic[] }}
 */
export function listSnapshots(opts) {
  const { mgrStateDir, readdirFn, readFn } = opts ?? {};
  const bag = new DiagnosticBag();
  if (!isNonEmptyStr(mgrStateDir)) {
    bag.add({ severity: 'error', code: 'snapshot-bad-state-dir', phase: PHASE,
      message: 'mgrStateDir must be a non-empty string' });
    return { snapshots: [], diagnostics: bag.all() };
  }
  const reader = typeof readdirFn === 'function' ? readdirFn : ((p) => readdirSync(p));

  const names = listSnapshotDirNames(mgrStateDir, reader, bag);
  /** @type {SnapshotSummary[]} */
  const snapshots = [];
  for (const name of names) {
    if (!isValidSnapshotId(name)) continue; // ignore non-snapshot entries
    snapshots.push(summarizeSnapshotDir(mgrStateDir, name, readFn));
  }
  // Newest first: the id is a lexicographically-sortable UTC timestamp.
  snapshots.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  return { snapshots, diagnostics: bag.all() };
}

// ── gc (retention prune) ──────────────────────────────────────────────────────

/**
 * @typedef {Object} GcResult
 * @property {string[]} deleted       ids actually deleted (apply:true only)
 * @property {string[]} retained      ids kept per the retention criteria
 * @property {string[]} wouldDelete   ids that WOULD be deleted (dry-run preview)
 * @property {Diagnostic[]} diagnostics
 */

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
 *
 * @param {SnapshotSummary[]} ordered   newest-first
 * @param {number|null} keep            count to keep, or null
 * @param {number|null} olderThanMs     age window in ms, or null
 * @param {number} nowMs                current epoch ms
 * @returns {{ retained: string[], toDelete: string[] }}
 */
function partitionRetention(ordered, keep, olderThanMs, nowMs) {
  const cutoff = olderThanMs !== null ? nowMs - olderThanMs : null;
  /** @type {string[]} */
  const retained = [];
  /** @type {string[]} */
  const toDelete = [];
  for (let i = 0; i < ordered.length; i++) {
    const snap = ordered[i];
    const byKeep = keep !== null ? i < keep : true;            // among the N newest
    let byAge = true;
    if (cutoff !== null) {
      const epoch = snapshotEpoch(snap);
      byAge = epoch > cutoff;                                  // newer than the window
    }
    // Retain only if EVERY active criterion retains (stricter intersection).
    if (byKeep && byAge) retained.push(snap.id);
    else toDelete.push(snap.id);
  }
  return { retained, toDelete };
}

/**
 * The effective epoch-ms of a snapshot for age comparison: manifest createdAt,
 * else the id timestamp, else -Infinity (treat as very old → a prune candidate).
 * @param {SnapshotSummary} snap
 * @returns {number}
 */
function snapshotEpoch(snap) {
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
function idToIso(id) {
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
 * @param {DiagnosticBag} bag
 * @returns {boolean}
 */
function deleteSnapshotDir(mgrStateDir, id, seams, bag) {
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
 * Garbage-collect snapshots per a retention policy. DRY-RUN BY DEFAULT.
 *
 * Lists ids newest-first, partitions them into retain vs delete by the criteria,
 * and (only when `apply:true`) performs the BOUNDED delete of each non-retained
 * dir. With `apply:false` (the default) it returns `wouldDelete[]` and deletes
 * nothing.
 *
 * REQUIRES at least one criterion: with neither `keep` nor `olderThanMs` it emits
 * a `gc-no-criterion` warn and deletes NOTHING (refusing to treat "no criteria"
 * as "delete all").
 *
 * @param {object} opts
 * @param {string}  opts.mgrStateDir            absolute path to the .mgr-state dir
 * @param {number}  [opts.keep]                 retain the N newest (>=0 integer)
 * @param {number}  [opts.olderThanMs]          retain snapshots newer than now-this
 * @param {() => number} [opts.now]             clock injection (defaults to Date.now)
 * @param {boolean} [opts.apply=false]          false = dry-run preview; true = delete
 * @param {object}  [opts.seams]                injectable seams (tests):
 *   `listFn`     override the whole list step ({mgrStateDir,readdirFn,readFn}->{snapshots,diagnostics})
 *   `readdirFn`  / `readFn`  passed to the real listSnapshots when listFn is absent
 *   `direntFn(dir)->Dirent[]`  the delete-side dir reader (withFileTypes) — distinct
 *                from the name-listing `readdirFn` so a test can spy on deletes alone
 *   `unlinkFn` / `rmdirFn`   the bounded-delete file/dir removers
 * @returns {{ deleted: string[], retained: string[], wouldDelete: string[], diagnostics: Diagnostic[] }}
 */
export function gcSnapshots(opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const { mgrStateDir, apply = false } = o;
  const nowFn = typeof o.now === 'function' ? o.now : () => Date.now();
  const seams = o.seams && typeof o.seams === 'object' ? o.seams : {};
  const bag = new DiagnosticBag();
  const empty = { deleted: [], retained: [], wouldDelete: [], diagnostics: bag.all() };

  if (!isNonEmptyStr(mgrStateDir)) {
    bag.add({ severity: 'error', code: 'snapshot-bad-state-dir', phase: PHASE,
      message: 'mgrStateDir must be a non-empty string' });
    return { ...empty, diagnostics: bag.all() };
  }

  const keep = normalizeKeep(o.keep);
  const olderThanMs = normalizeOlderThan(o.olderThanMs);

  // REQUIRE a criterion — never delete everything by default.
  if (keep === null && olderThanMs === null) {
    bag.add({ severity: 'warn', code: 'gc-no-criterion', phase: PHASE,
      message: 'gc requires at least one of --keep or --older-than; nothing deleted' });
    // Still surface the full list as retained (nothing pruned).
    const listed = (typeof seams.listFn === 'function' ? seams.listFn : listSnapshots)
      ({ mgrStateDir, readdirFn: seams.readdirFn, readFn: seams.readFn });
    return { deleted: [], retained: listed.snapshots.map((s) => s.id), wouldDelete: [], diagnostics: bag.all() };
  }

  // List (newest-first) and surface listing diagnostics.
  const listed = (typeof seams.listFn === 'function' ? seams.listFn : listSnapshots)
    ({ mgrStateDir, readdirFn: seams.readdirFn, readFn: seams.readFn });
  for (const d of listed.diagnostics) bag.add(d);

  const { retained, toDelete } = partitionRetention(listed.snapshots, keep, olderThanMs, nowFn());

  // DRY-RUN (default): preview only — delete nothing.
  if (!apply) {
    return { deleted: [], retained, wouldDelete: toDelete, diagnostics: bag.all() };
  }

  // APPLY: bounded-delete each non-retained dir; collect the ones actually removed.
  // The delete-side dir reader is a DISTINCT seam (`direntFn`) from the name-listing
  // `readdirFn` so a test can spy on the delete path without affecting listing.
  const direntFn = typeof seams.direntFn === 'function'
    ? seams.direntFn
    : ((p) => readdirSync(p, { withFileTypes: true }));
  const unlinkFn = typeof seams.unlinkFn === 'function' ? seams.unlinkFn : unlinkSync;
  const rmdirFn = typeof seams.rmdirFn === 'function' ? seams.rmdirFn : rmdirSync;
  const delSeams = { readdirFn: direntFn, unlinkFn, rmdirFn };

  /** @type {string[]} */
  const deleted = [];
  for (const id of toDelete) {
    if (deleteSnapshotDir(mgrStateDir, id, delSeams, bag)) deleted.push(id);
  }
  return { deleted, retained, wouldDelete: [], diagnostics: bag.all() };
}

/**
 * Normalize the `keep` option: a finite integer >= 0, else null (criterion absent).
 * @param {unknown} keep
 * @returns {number|null}
 */
function normalizeKeep(keep) {
  if (typeof keep !== 'number' || !Number.isInteger(keep) || keep < 0) return null;
  return keep;
}

/**
 * Normalize the `olderThanMs` option: a finite number > 0, else null (absent).
 * @param {unknown} ms
 * @returns {number|null}
 */
function normalizeOlderThan(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return null;
  return ms;
}
