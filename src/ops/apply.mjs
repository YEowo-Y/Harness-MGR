/**
 * Apply orchestrator (P3.U12) — the FIRST unit of the apply path. It wires the
 * three already-built apply primitives into the start of the apply lifecycle and
 * then DELIBERATELY STOPS:
 *
 *   acquire-lock  →  SNAPSHOTTED (createSnapshot)  →  journal planned→snapshotted
 *                                                     →  *** STOP (writes disabled) ***
 *
 * This unit drives the journal from `planned` to `snapshotted` only. It performs
 * NO governed-config write: the `applying` state (which writes the actual ops into
 * `~/.claude`) is the NEXT unit (P3.U13) and is intentionally absent here. The
 * value this unit ships is the safe, recoverable PREAMBLE every apply needs — a
 * lock so two applies can't race, a snapshot so a future apply can be rolled back,
 * and a persisted journal recording that we got that far — all proven to touch
 * nothing under the governed config.
 *
 * SECURITY / SAFETY invariants (each mirrors the sibling ops modules):
 *   1. NO governed-config write. The only filesystem writes this unit causes are
 *      inside `.mgr-state` (the lock file, the snapshot dir, the journal) — all
 *      gated by the INJECTED assertWritable. There is NO transition to `applying`.
 *   2. assertWritable is INJECTED + REQUIRED (fail-safe: refuse if absent, never
 *      silently bypass), exactly like lock.mjs / snapshot.mjs / apply-journal-writer.
 *      It is threaded into acquireLock, createSnapshot, AND writeJournal.
 *   3. The lock is acquired OUTSIDE any try/finally; the finally that releases it
 *      runs ONLY when we actually acquired it (we never release a lock we do not
 *      own — releaseLock is called with the SAME pid acquireLock used).
 *   4. Redaction of sensitive plan ops is createJournal's job (it calls
 *      redactPatchOp internally); this unit does NOT duplicate it.
 *
 * PARTIAL FAILURE: if the snapshot succeeds but the journal transition/write then
 * fails, the (valid) snapshot dir is left in `.mgr-state` for inspection — `gc` /
 * `list` tolerate a snapshot dir without an apply-journal.json, so the P3.U13
 * author must not assume every snapshot dir has a journal.
 *
 * M2-SAFETY: this module never imports src/paths.mjs (which carries a top-level
 * await) — not statically, not via dynamic import(). It takes the governed-write
 * gate + the two dir paths as params; the CLI layer (a later unit) dynamically
 * imports paths.mjs and injects them, keeping the static graph paths.mjs-free.
 *
 * Ops-layer constraint: imports only node:* stdlib + src/lib/** + sibling
 * src/ops/*. NEVER THROWS — every failure (including a thrown seam) becomes a
 * Diagnostic + `{ ok:false }`. Injectable seams make every path hermetically
 * unit-testable without a real lock / snapshot / fs. Zero npm deps.
 *
 * Spec: plan claude-mgr-v5.md, the apply lifecycle `planned`→`snapshotted` step
 * (lines 493-519).
 */

import { DiagnosticBag } from '../lib/diagnostic.mjs';
import { acquireLock, releaseLock } from './lock.mjs';
import { createSnapshot } from './snapshot.mjs';
import { createJournal, transition, writeJournal } from './apply-journal-writer.mjs';

/** @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic */
/** @typedef {import('../lib/plan.mjs').Plan} Plan */

/** Stable diagnostic phase tag for this module's own findings. */
const PHASE = 'apply';

/**
 * @typedef {Object} ApplyLock
 * @property {boolean} acquired
 * @property {boolean} [reclaimed]   true when a stale lock was reclaimed
 * @property {string}  [reason]      lock-failure reason when acquired is false
 */

/**
 * @typedef {Object} ApplyResult
 * @property {boolean} ok            true ONLY when the snapshot succeeded AND the
 *                                   journal was written in state 'snapshotted'.
 * @property {string|null} state     the journal state reached (null before any).
 * @property {false} applied         ALWAYS false in U12 (governed writes disabled).
 * @property {string|null} snapshotId
 * @property {string|null} journalPath
 * @property {string|null} manifestPath
 * @property {string|null} archivePath
 * @property {ApplyLock} lock
 * @property {Diagnostic[]} diagnostics  aggregated across every step.
 */

/** True for a non-empty string. */
function isNonEmptyStr(v) {
  return typeof v === 'string' && v.length > 0;
}

/**
 * Build an ApplyResult, defaulting every field so callers always get the full
 * shape. `applied` is hard-wired false (U12 never writes governed config).
 * @param {Partial<ApplyResult>} fields
 * @param {DiagnosticBag} bag
 * @returns {ApplyResult}
 */
function buildResult(fields, bag) {
  return {
    ok: false, state: null, applied: false,
    snapshotId: null, journalPath: null, manifestPath: null, archivePath: null,
    lock: { acquired: false },
    ...fields,
    diagnostics: bag.all(),
  };
}

/**
 * Create + transition + persist the journal for a successful snapshot. Drives
 * `planned`→`snapshotted` ONLY (never `applying`). Returns the success result on
 * a written journal, or a failure result on any sub-step failure. Extracted from
 * applyPlan to keep both functions under the SLOC limit. Never throws.
 *
 * @param {object} args
 * @param {Plan}   args.plan
 * @param {string} args.targetClaudeDir
 * @param {string} args.mgrStateDir
 * @param {(path:string, ctx:string)=>string} args.assertWritable
 * @param {() => Date} [args.now]
 * @param {{snapshotId:string|null, manifestPath:string|null, archivePath:string|null, reclaimed?:boolean}} args.snap
 * @param {{createJournalFn:Function, transitionFn:Function, writeJournalFn:Function}} args.fns
 * @param {DiagnosticBag} args.bag
 * @returns {ApplyResult}
 */
function persistJournal(args) {
  const { plan, targetClaudeDir, mgrStateDir, assertWritable, now, snap, fns, bag } = args;
  // Carry the snapshot's id/paths onto every (success OR failure) result.
  const base = {
    snapshotId: snap.snapshotId, manifestPath: snap.manifestPath, archivePath: snap.archivePath,
    lock: { acquired: true, ...(snap.reclaimed ? { reclaimed: snap.reclaimed } : {}) },
  };
  const fail = (code, message, fields) => {
    bag.add({ severity: 'error', code, message, phase: PHASE });
    return buildResult({ ...base, ...fields }, bag);
  };

  // planned (in-memory) — ops are redacted INSIDE createJournal.
  const { journal: planned, diagnostics: cjD } = fns.createJournalFn({
    snapshotId: snap.snapshotId, targetClaudeDir, plan, now,
  });
  for (const d of cjD) bag.add(d);
  if (!planned) return fail('apply-journal-create-failed', 'could not build the apply journal');

  // planned → snapshotted (pure state-machine move).
  const t = fns.transitionFn(planned, 'snapshotted', { now });
  for (const d of t.diagnostics) bag.add(d);
  if (!t.ok) return fail('apply-transition-failed', "could not transition journal to 'snapshotted'",
    { state: planned.state });

  // Persist the snapshotted journal (gated write into .mgr-state, verify-after-write).
  const w = fns.writeJournalFn({ stateDir: mgrStateDir, snapshotId: snap.snapshotId, journal: t.journal, assertWritable });
  for (const d of w.diagnostics) bag.add(d);
  if (!w.written) return fail('apply-journal-write-failed', 'could not persist the apply journal',
    { state: 'snapshotted' });

  // STOP at 'snapshotted' — the DoD criterion. No 'applying' transition, no
  // governed write. Surface an INFO so the caller knows why nothing was applied.
  bag.add({ severity: 'info', code: 'apply-writes-disabled', phase: PHASE,
    message: "apply reached 'snapshotted'; governed-config writes are not yet implemented (P3.U13) — no files were modified" });
  return buildResult({ ...base, ok: true, state: 'snapshotted', journalPath: w.path }, bag);
}

/**
 * Run the apply preamble for a Plan: acquire the apply lock, capture a snapshot,
 * and persist a journal in the `snapshotted` state. Performs NO governed-config
 * write (the `applying` step is P3.U13). NEVER throws — every failure, including a
 * thrown seam, becomes a Diagnostic + `{ ok:false }` with the aggregated
 * diagnostics from every step that ran. `applied` is always false.
 *
 * @param {object} opts
 * @param {Plan}    opts.plan                       the plan to (eventually) apply
 * @param {string}  opts.targetClaudeDir            absolute path to the governed dir
 * @param {string}  opts.mgrStateDir                absolute path to the .mgr-state dir
 * @param {(path:string, ctx:string)=>string} opts.assertWritable  REQUIRED governed-write gate
 * @param {string}  [opts.reason='']                snapshot reason
 * @param {boolean} [opts.includeAuth=false]        opt in to capturing the auth-cache file
 * @param {number}  [opts.pid]                      lock pid (defaults to process.pid); SAME pid used to release
 * @param {() => Date} [opts.now]                   clock injection (defaults to Date)
 * @param {object}  [opts.seams]                    { acquireFn, releaseFn, createSnapshotFn, createJournalFn, transitionFn, writeJournalFn }
 * @returns {Promise<ApplyResult>}
 */
export async function applyPlan(opts) {
  const bag = new DiagnosticBag();
  const o = opts && typeof opts === 'object' ? opts : {};
  const { plan, targetClaudeDir, mgrStateDir, assertWritable, reason = '', includeAuth = false } = o;
  const now = typeof o.now === 'function' ? o.now : () => new Date();
  const seams = o.seams && typeof o.seams === 'object' ? o.seams : {};
  const acquireFn = seams.acquireFn ?? acquireLock;
  const releaseFn = seams.releaseFn ?? releaseLock;
  const createSnapshotFn = seams.createSnapshotFn ?? createSnapshot;
  const fns = {
    createJournalFn: seams.createJournalFn ?? createJournal,
    transitionFn: seams.transitionFn ?? transition,
    writeJournalFn: seams.writeJournalFn ?? writeJournal,
  };

  const fail = (code, message) => {
    bag.add({ severity: 'error', code, message, phase: PHASE });
    return buildResult({}, bag);
  };

  try {
    // 1. Validate — on any failure, refuse BEFORE acquiring a lock (no lock taken
    //    means no release path; fail-safe on a missing/invalid write gate).
    if (!plan || typeof plan !== 'object') return fail('apply-bad-args', 'plan must be an object');
    if (!isNonEmptyStr(targetClaudeDir)) return fail('apply-bad-args', 'targetClaudeDir must be a non-empty string');
    if (!isNonEmptyStr(mgrStateDir)) return fail('apply-bad-args', 'mgrStateDir must be a non-empty string');
    if (typeof assertWritable !== 'function') {
      return fail('apply-bad-args', 'assertWritable (the governed-write gate) must be injected');
    }

    // 2. Acquire the lock OUTSIDE the try/finally so a failed acquire never reaches
    //    the release path (we never release a lock we did not acquire). The SAME
    //    pid is threaded into acquire + release.
    const lockPid = Number.isInteger(o.pid) ? o.pid : process.pid;
    const acq = acquireFn({ stateDir: mgrStateDir, assertWritable, pid: lockPid, now });
    for (const d of acq.diagnostics ?? []) bag.add(d);
    if (!acq.acquired) {
      return buildResult({ lock: { acquired: false, reason: acq.reason } }, bag);
    }

    // 3. Lock held → from here a finally MUST release it (with the same pid).
    try {
      const snap = await createSnapshotFn({
        targetClaudeDir, mgrStateDir, reason, includeAuth, assertWritable, now, dryRun: false,
      });
      for (const d of snap.diagnostics ?? []) bag.add(d);
      if (!snap.ok) {
        bag.add({ severity: 'error', code: 'apply-snapshot-failed', phase: PHASE,
          message: 'could not capture a snapshot before applying; aborting (no changes made)' });
        return buildResult({ lock: { acquired: true, ...(acq.reclaimed ? { reclaimed: acq.reclaimed } : {}) } }, bag);
      }
      return persistJournal({
        plan, targetClaudeDir, mgrStateDir, assertWritable, now,
        snap: { snapshotId: snap.snapshotId, manifestPath: snap.manifestPath, archivePath: snap.archivePath, reclaimed: acq.reclaimed },
        fns, bag,
      });
    } finally {
      const rel = releaseFn({ stateDir: mgrStateDir, pid: lockPid });
      for (const d of rel?.diagnostics ?? []) bag.add(d);
    }
  } catch (e) {
    // Absolute backstop: a thrown seam / unexpected error becomes a diagnostic.
    return fail('apply-unexpected-error', `unexpected error during apply: ${e instanceof Error ? e.message : String(e)}`);
  }
}
