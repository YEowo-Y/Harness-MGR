/**
 * gc EXTRA cleanup categories (P3.U21) — the THREE non-snapshot categories of the
 * `gc` command. The snapshot category (whole-dir retention prune) lives in
 * snapshot-store.mjs::gcSnapshots and is NOT touched here; this module prunes:
 *   1. audit-large ORPHANS  — `<mgrStateDir>/audit-large/<uuid>.json` files no
 *      longer referenced by any pointer line in audit.log (a split entry whose
 *      pointer was never written, or whose log was rotated/lost). A file modified
 *      in the last 60s is SKIPPED (race guard — it may be an in-flight split whose
 *      pointer line is about to be appended).
 *   2. orphan apply-lock    — `<mgrStateDir>/locks/apply.lock` left by a crashed
 *      apply. Reaped ONLY when its holder is DEAD (not just unreadable/alive) AND
 *      older than 24h (a recent-but-dead lock is left for a possible in-flight
 *      retry; a corrupt/unreadable lock is left for the explicit `--break-lock`).
 *   3. leftover sidecars    — stranded `.mgr-new` / `.mgr-old` atomic-write
 *      recovery files at the `.mgr-state` TOP LEVEL only (older than 7 days).
 *
 * SCOPING (deliberate, to avoid stepping on other owners):
 *   - The leftover-sidecar scan is `.mgr-state` TOP-LEVEL ONLY. It does NOT recurse:
 *     snapshot dirs are gcSnapshots' domain, and sidecars stranded inside the
 *     GOVERNED config tree (agents/skills/commands/hooks) are doctor #21's detection
 *     + recover's restore domain — gc NEVER touches governed `~/.claude` config.
 *   - An audit-large file is an ORPHAN iff NO audit.log pointer line's `ref` names it.
 *   - The lock is reaped only when DEAD AND >24h (never an alive/recent/corrupt lock).
 *
 * DRY-RUN BY DEFAULT: every function takes `apply` (default false). With apply:false
 * it returns a preview (`wouldDelete[]` / `wouldReap`) and deletes NOTHING; only
 * apply:true performs the removal.
 *
 * BOUNDED to `.mgr-state`: all deletes are of DIRECT REGULAR FILES reconstructed via
 * `join(...)` — a subdir or symlink is SKIPPED + warned, never followed, never
 * recursed; there is NO `rmSync({recursive})` / rm-rf anywhere. No assertWritable is
 * injected, matching gcSnapshots' bounded-by-construction posture (the targets are
 * fixed, `.mgr-state`-relative paths, never governed config).
 *
 * Ops-layer constraint: imports only node:* stdlib + src/lib/** + the sibling
 * lock.mjs. Never throws — every failure becomes a Diagnostic via DiagnosticBag.
 * Zero npm dependencies.
 */

import { readFileSync, readdirSync, unlinkSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { DiagnosticBag } from '../lib/diagnostic.mjs';
import { isLeftoverSidecar } from '../lib/leftover-sidecars.mjs';
import { inspectLock, lockPath } from './lock.mjs';

/** @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic */

/** Stable diagnostic phase tag for this module's findings. */
const PHASE = 'gc';

/** Subdir holding oversized audit entries (mirrors audit-writer.AUDIT_LARGE_DIRNAME). */
const AUDIT_LARGE_DIRNAME = 'audit-large';
/** JSONL audit log filename (mirrors audit-writer.AUDIT_LOG_NAME). */
const AUDIT_LOG_NAME = 'audit.log';

/** Race guard: skip an audit-large file modified within this window (in-flight split). */
const AUDIT_LARGE_RACE_MS = 60 * 1000;
/** A dead apply-lock is an orphan only when older than this. */
const LOCK_ORPHAN_MS = 24 * 3600 * 1000;
/** A leftover sidecar is prunable only when older than this. */
const SIDECAR_ORPHAN_MS = 7 * 86400 * 1000;

// ── shared helpers ────────────────────────────────────────────────────────────

/** Message from an unknown thrown value; never throws. */
function errMsg(e) {
  return e instanceof Error ? e.message : String(e);
}

/** True for a non-empty string. */
function isNonEmptyStr(v) {
  return typeof v === 'string' && v.length > 0;
}

/** Resolve the clock seam (defaults to Date.now). */
function clock(o) {
  return typeof o.now === 'function' ? o.now : () => Date.now();
}

/** Normalize opts to an object + extract the seams object. */
function normOpts(opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const seams = o.seams && typeof o.seams === 'object' ? o.seams : {};
  return { o, seams };
}

/**
 * mtime (epoch ms) of `p` via the stat seam, or null if it cannot be determined.
 * Never throws.
 * @param {string} p @param {(p:string)=>import('node:fs').Stats} statFn
 * @returns {number|null}
 */
function mtimeMs(p, statFn) {
  try {
    const st = statFn(p);
    return st && Number.isFinite(st.mtimeMs) ? st.mtimeMs : null;
  } catch { return null; }
}

/**
 * readdir withFileTypes; ENOENT → [] (benign), other error → [] + warn. Never throws.
 * @param {string} dir @param {(p:string)=>import('node:fs').Dirent[]} direntFn
 * @param {string} code @param {DiagnosticBag} bag @returns {import('node:fs').Dirent[]}
 */
function safeDirents(dir, direntFn, code, bag) {
  try {
    const r = direntFn(dir);
    return Array.isArray(r) ? r : [];
  } catch (e) {
    if (e && e.code === 'ENOENT') return [];
    bag.add({ severity: 'warn', code, phase: PHASE, path: dir,
      message: `could not read directory: ${errMsg(e)}` });
    return [];
  }
}

/** True iff `ent` is a DIRECT regular file (not a subdir, not a symlink). */
function isRegularFile(ent) {
  return !!ent && typeof ent.isFile === 'function' && ent.isFile() && !ent.isSymbolicLink();
}

// ── 1. audit-large orphans ──────────────────────────────────────────────────────

/**
 * Read audit.log and collect every string `ref` from pointer-line objects (a
 * `large:true` split entry names its full file via `ref`). A missing log → empty
 * set (benign). Parse failures are skipped. Never throws.
 * @param {string} auditLog @param {(p:string)=>string} readFn @returns {Set<string>}
 */
function referencedRefs(auditLog, readFn) {
  /** @type {Set<string>} */
  const refs = new Set();
  let text = '';
  try { text = readFn(auditLog); }
  catch (e) { if (e && e.code === 'ENOENT') return refs; return refs; }
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed;
    try { parsed = JSON.parse(trimmed); }
    catch { continue; }
    if (parsed && typeof parsed === 'object' && typeof parsed.ref === 'string') {
      // BARE-BASENAME CONTRACT: audit-large files are named/compared by basename
      // (gcAuditLarge tests `referenced.has(<dirent basename>)`). Today the writer
      // emits a bare basename ref, but normalizing here means a future writer that
      // ever emits a path-shaped ref (e.g. 'audit-large/x.json') still PROTECTS the
      // referenced file from deletion rather than letting it be treated as an orphan.
      refs.add(basename(parsed.ref));
    }
  }
  return refs;
}

/**
 * @typedef {Object} GcFileResult
 * @property {string[]} deleted       basenames actually deleted (apply:true)
 * @property {string[]} wouldDelete   basenames that WOULD be deleted (dry-run)
 * @property {Diagnostic[]} diagnostics
 */

/**
 * Prune unreferenced `audit-large/<uuid>.json` files. DRY-RUN BY DEFAULT.
 *
 * A `.json` file directly in `audit-large/` is an ORPHAN iff its name is in no
 * audit.log pointer's `ref`. A file modified within the last 60s is SKIPPED (race
 * guard — a split whose pointer is about to land). Returned names are basenames.
 *
 * @param {object} opts
 * @param {string}  opts.mgrStateDir
 * @param {boolean} [opts.apply=false]
 * @param {() => number} [opts.now]
 * @param {{readFn?:Function, direntFn?:Function, statFn?:Function, unlink?:Function}} [opts.seams]
 * @returns {GcFileResult}
 */
export function gcAuditLarge(opts) {
  const { o, seams } = normOpts(opts);
  const { mgrStateDir, apply = false } = o;
  const now = clock(o);
  const bag = new DiagnosticBag();
  if (!isNonEmptyStr(mgrStateDir)) {
    bag.add({ severity: 'error', code: 'gc-bad-state-dir', phase: PHASE,
      message: 'mgrStateDir must be a non-empty string' });
    return { deleted: [], wouldDelete: [], diagnostics: bag.all() };
  }
  const readFn = seams.readFn ?? ((p) => readFileSync(p, 'utf8'));
  const direntFn = seams.direntFn ?? ((p) => readdirSync(p, { withFileTypes: true }));
  const statFn = seams.statFn ?? ((p) => statSync(p));
  const unlinkFn = seams.unlink ?? unlinkSync;

  const largeDir = join(mgrStateDir, AUDIT_LARGE_DIRNAME);
  const referenced = referencedRefs(join(mgrStateDir, AUDIT_LOG_NAME), readFn);
  const entries = safeDirents(largeDir, direntFn, 'gc-audit-large-unreadable', bag);
  const cutoff = now() - AUDIT_LARGE_RACE_MS;

  /** @type {string[]} */ const deleted = [];
  /** @type {string[]} */ const wouldDelete = [];
  for (const ent of entries) {
    if (!isRegularFile(ent)) continue; // skip subdir / symlink (never follow/recurse)
    const name = ent.name;
    if (typeof name !== 'string' || !name.endsWith('.json')) continue;
    if (referenced.has(name)) continue;                       // referenced → keep
    const mt = mtimeMs(join(largeDir, name), statFn);
    if (mt !== null && mt > cutoff) continue;                 // race guard: in-flight split
    if (!apply) { wouldDelete.push(name); continue; }
    if (removeFile(join(largeDir, name), unlinkFn, 'gc-audit-large-failed', name, bag)) {
      deleted.push(name);
    }
  }
  return { deleted, wouldDelete, diagnostics: bag.all() };
}

// ── 2. orphan apply-lock ────────────────────────────────────────────────────────

/**
 * @typedef {Object} GcLockResult
 * @property {boolean} reaped        true iff the lock was removed (apply:true)
 * @property {boolean} wouldReap     true iff a dry-run WOULD reap it
 * @property {object|null} holder    the dead holder, when reapable; else null
 * @property {Diagnostic[]} diagnostics
 */

/**
 * Reap an ORPHAN apply-lock. DRY-RUN BY DEFAULT.
 *
 * Inspects the lock (read-only) via inspectLock; reaps ONLY when the holder is DEAD
 * (`alive===false`) AND its startTime parses AND it is older than 24h. An absent
 * lock is a no-op; an unreadable/corrupt lock is left (info `gc-lock-corrupt` —
 * use `--break-lock`); an alive holder is left (info `gc-lock-alive`); a dead but
 * recent (or unparseable-startTime) holder is left (info `gc-lock-recent`).
 *
 * @param {object} opts
 * @param {string}  opts.mgrStateDir
 * @param {boolean} [opts.apply=false]
 * @param {() => number} [opts.now]
 * @param {{readFn?:Function, killFn?:Function, unlink?:Function}} [opts.seams]
 * @returns {GcLockResult}
 */
export function gcOrphanLock(opts) {
  const { o, seams } = normOpts(opts);
  const { mgrStateDir, apply = false } = o;
  const now = clock(o);
  const bag = new DiagnosticBag();
  const none = { reaped: false, wouldReap: false, holder: null };
  if (!isNonEmptyStr(mgrStateDir)) {
    bag.add({ severity: 'error', code: 'gc-bad-state-dir', phase: PHASE,
      message: 'mgrStateDir must be a non-empty string' });
    return { ...none, diagnostics: bag.all() };
  }

  const ins = inspectLock({ stateDir: mgrStateDir, readFn: seams.readFn, killFn: seams.killFn });
  for (const d of ins.diagnostics) bag.add(d);
  if (!ins.present) return { ...none, diagnostics: bag.all() };          // nothing to do
  if (ins.holder === null) {
    bag.add({ severity: 'info', code: 'gc-lock-corrupt', phase: PHASE,
      message: 'apply lock present but unreadable; use --break-lock to remove' });
    return { ...none, diagnostics: bag.all() };
  }
  if (ins.alive === true) {
    bag.add({ severity: 'info', code: 'gc-lock-alive', phase: PHASE,
      message: `apply lock held by live pid ${ins.holder.pid}; left in place` });
    return { ...none, diagnostics: bag.all() };
  }

  // Dead holder — orphan only if startTime parses AND it is older than 24h.
  const started = Date.parse(ins.holder.startTime);
  const age = Number.isNaN(started) ? null : now() - started;
  if (age === null || age <= LOCK_ORPHAN_MS) {
    bag.add({ severity: 'info', code: 'gc-lock-recent', phase: PHASE,
      message: `apply lock held by dead pid ${ins.holder.pid} but not yet stale (<24h or unparseable startTime); left in place` });
    return { ...none, diagnostics: bag.all() };
  }

  if (!apply) return { reaped: false, wouldReap: true, holder: ins.holder, diagnostics: bag.all() };

  const lockFile = lockPath(mgrStateDir);
  const unlinkFn = seams.unlink ?? unlinkSync;
  try { unlinkFn(lockFile); }
  catch (e) {
    if (e && e.code === 'ENOENT') return { reaped: false, wouldReap: false, holder: ins.holder, diagnostics: bag.all() };
    bag.add({ severity: 'warn', code: 'gc-lock-reap-failed', phase: PHASE, path: lockFile,
      message: `could not remove orphan lock: ${errMsg(e)}` });
    return { reaped: false, wouldReap: false, holder: ins.holder, diagnostics: bag.all() };
  }
  bag.add({ severity: 'warn', code: 'gc-lock-reaped', phase: PHASE, path: lockFile,
    message: `reaped orphan apply lock held by dead pid ${ins.holder.pid} (started ${ins.holder.startTime})` });
  return { reaped: true, wouldReap: false, holder: ins.holder, diagnostics: bag.all() };
}

// ── 3. leftover sidecars (.mgr-state top level only) ─────────────────────────────

/**
 * Prune stranded `.mgr-new` / `.mgr-old` atomic-write recovery sidecars at the
 * `.mgr-state` TOP LEVEL only (no recursion — see header SCOPING). DRY-RUN BY
 * DEFAULT. A direct regular file whose basename `isLeftoverSidecar` AND whose mtime
 * is older than 7 days is an orphan. Returned names are basenames.
 *
 * @param {object} opts
 * @param {string}  opts.mgrStateDir
 * @param {boolean} [opts.apply=false]
 * @param {() => number} [opts.now]
 * @param {{direntFn?:Function, statFn?:Function, unlink?:Function}} [opts.seams]
 * @returns {GcFileResult}
 */
export function gcLeftoverSidecars(opts) {
  const { o, seams } = normOpts(opts);
  const { mgrStateDir, apply = false } = o;
  const now = clock(o);
  const bag = new DiagnosticBag();
  if (!isNonEmptyStr(mgrStateDir)) {
    bag.add({ severity: 'error', code: 'gc-bad-state-dir', phase: PHASE,
      message: 'mgrStateDir must be a non-empty string' });
    return { deleted: [], wouldDelete: [], diagnostics: bag.all() };
  }
  const direntFn = seams.direntFn ?? ((p) => readdirSync(p, { withFileTypes: true }));
  const statFn = seams.statFn ?? ((p) => statSync(p));
  const unlinkFn = seams.unlink ?? unlinkSync;

  // TOP-LEVEL ONLY: read .mgr-state itself, never descend.
  const entries = safeDirents(mgrStateDir, direntFn, 'gc-leftover-unreadable', bag);
  const nowMs = now();

  /** @type {string[]} */ const deleted = [];
  /** @type {string[]} */ const wouldDelete = [];
  for (const ent of entries) {
    if (!isRegularFile(ent)) continue;            // skip subdir / symlink (no recurse)
    const name = ent.name;
    if (!isLeftoverSidecar(name)) continue;
    const mt = mtimeMs(join(mgrStateDir, name), statFn);
    if (mt === null || nowMs - mt <= SIDECAR_ORPHAN_MS) continue;   // too fresh / unknown age → keep
    if (!apply) { wouldDelete.push(name); continue; }
    if (removeFile(join(mgrStateDir, name), unlinkFn, 'gc-leftover-failed', name, bag)) {
      deleted.push(name);
    }
  }
  return { deleted, wouldDelete, diagnostics: bag.all() };
}

/**
 * BOUNDED single-file unlink. ENOENT is benign (already gone → false, no diag); any
 * other error → a warn under `code` and false. Returns true iff removed. Never throws.
 * @param {string} path @param {(p:string)=>void} unlinkFn @param {string} code
 * @param {string} label @param {DiagnosticBag} bag @returns {boolean}
 */
function removeFile(path, unlinkFn, code, label, bag) {
  try { unlinkFn(path); return true; }
  catch (e) {
    if (e && e.code === 'ENOENT') return false; // already gone
    bag.add({ severity: 'warn', code, phase: PHASE, path: label,
      message: `could not remove file: ${errMsg(e)}` });
    return false;
  }
}

// ── orchestrator ────────────────────────────────────────────────────────────────

/**
 * Run all three extra gc categories with the same options, merging diagnostics.
 * DRY-RUN BY DEFAULT (each sub-result reflects `apply`). Never throws.
 *
 * @param {object} opts
 * @param {string}  opts.mgrStateDir
 * @param {boolean} [opts.apply=false]
 * @param {() => number} [opts.now]
 * @param {object}  [opts.seams]   passed through to each sub-category
 * @returns {{ auditLarge: GcFileResult, lock: GcLockResult, leftovers: GcFileResult, diagnostics: Diagnostic[] }}
 */
export function gcExtras(opts) {
  const auditLarge = gcAuditLarge(opts);
  const lock = gcOrphanLock(opts);
  const leftovers = gcLeftoverSidecars(opts);
  const diagnostics = [
    ...auditLarge.diagnostics, ...lock.diagnostics, ...leftovers.diagnostics,
  ];
  return { auditLarge, lock, leftovers, diagnostics };
}
