/**
 * Apply orchestrator (P3.U12 preamble + P3.U13 sub-unit C governed write). It
 * wires the apply primitives into the apply lifecycle:
 *
 *   acquire-lock → SNAPSHOTTED (createSnapshot) → journal planned→snapshotted
 *      ├─ enableWrites !== true (DEFAULT):  *** STOP (writes disabled) ***
 *      └─ enableWrites === true:  snapshotted → applying → committed (single op)
 *                                              (or → failed on refusal / write fail)
 *
 * By DEFAULT (no `enableWrites`) this drives the journal `planned`→`snapshotted`
 * only and performs NO governed-config write — the safe, recoverable PREAMBLE
 * (a lock so two applies can't race, a snapshot so a future apply can be rolled
 * back, a persisted journal recording that we got that far). That default path is
 * byte-identical to P3.U12 and proven to touch nothing under the governed config.
 *
 * With `enableWrites === true` the lifecycle CONTINUES past `snapshotted`: a
 * SINGLE create/overwrite op is written via the atomic-write primitive
 * (sub-unit B), driving the journal `applying`→`committed` (or `→ failed`).
 * Multi-op is deferred to P3.U19 — more than one op REFUSES (`failed`).
 *
 * SECURITY / SAFETY invariants (each mirrors the sibling ops modules):
 *   1. The ONLY governed-config write is the atomic write of the single op, and it
 *      happens ONLY under `enableWrites === true`. Every governed write routes
 *      through atomicApplyWrite, which calls assertWritable(target,'apply')
 *      internally — there is NO local path allowlist; the gate is the single
 *      source of truth (an op targeting CLAUDE.md / marketplaces is denied → the
 *      write fails → the journal moves to `failed`). All .mgr-state writes (lock,
 *      snapshot, journal) are likewise gated by the INJECTED assertWritable.
 *   2. assertWritable is INJECTED + REQUIRED (fail-safe: refuse if absent, never
 *      silently bypass), exactly like lock.mjs / snapshot.mjs / apply-journal-writer.
 *      It is threaded into acquireLock, createSnapshot, writeJournal, AND the
 *      atomic write.
 *   3. The lock is acquired OUTSIDE any try/finally; the finally that releases it
 *      runs ONLY when we actually acquired it (we never release a lock we do not
 *      own — releaseLock is called with the SAME pid acquireLock used). The
 *      governed write runs INSIDE that lock, so the single-writer assumption the
 *      atomic primitive relies on holds.
 *   4. Redaction of sensitive plan ops is createJournal's job (it calls
 *      redactPatchOp internally); this unit does NOT duplicate it.
 *
 * PARTIAL FAILURE: if the snapshot succeeds but the journal transition/write then
 * fails, the (valid) snapshot dir is left in `.mgr-state` for inspection — `gc` /
 * `list` tolerate a snapshot dir without an apply-journal.json. If the GOVERNED
 * write succeeds but the final `committed` journal-persist fails, the on-disk file
 * IS already changed: the result reports `applied:true` but `ok:false` and the
 * journal stays at `applying` — a `recover --resume`/`--rollback` reconciles it.
 *
 * M2-SAFETY: this module never imports src/paths.mjs (which carries a top-level
 * await) — not statically, not via dynamic import(). It takes the governed-write
 * gate + the two dir paths as params; the CLI layer (a later unit) dynamically
 * imports paths.mjs and injects them, keeping the static graph paths.mjs-free.
 *
 * Ops-layer constraint: imports only node:* stdlib + src/lib/** + sibling
 * src/ops/*. NEVER THROWS — every failure (including a thrown seam) becomes a
 * Diagnostic + `{ ok:false }`. Injectable seams make every path hermetically
 * unit-testable without a real lock / snapshot / fs / write. Zero npm deps.
 *
 * Spec: plan claude-mgr-v5.md, the apply lifecycle `planned`→`snapshotted`→
 * `applying`→`committed` steps (lines 493-519).
 */

import { DiagnosticBag } from '../lib/diagnostic.mjs';
import { acquireLock, releaseLock } from './lock.mjs';
import { createSnapshot } from './snapshot.mjs';
import { createJournal, transition, writeJournal } from './apply-journal-writer.mjs';
import { atomicApplyWrite } from './atomic-write.mjs';

/** @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic */
/** @typedef {import('../lib/plan.mjs').Plan} Plan */
/** @typedef {import('../lib/plan.mjs').PlanOp} PlanOp */

/** The op kinds this unit can write (they carry `content`); multi-op is P3.U19. */
const WRITABLE_KINDS = Object.freeze(['create', 'overwrite']);

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
 * @property {boolean} ok            true when the lifecycle completed cleanly: for
 *                                   the default (writes-disabled) path, snapshot +
 *                                   journal written at 'snapshotted'; for the
 *                                   enableWrites path, journal reached 'committed'.
 * @property {string|null} state     the journal state reached (null before any).
 * @property {boolean} applied       true once a governed write committed (always
 *                                   false on the default writes-disabled path).
 * @property {number} [opsWritten]   count of governed ops written (0 for a no-op
 *                                   apply; 1 for a committed single op).
 * @property {{newPath:string|null, oldPath:string|null}} [leftovers]  sidecar files
 *                                   stranded by a catastrophic atomic-write failure.
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
 * shape. `applied` defaults false; the commit path sets it true once a governed
 * write lands. `applied` is overridable via `fields` (it spreads after the
 * defaults), so a falsy default never clobbers an explicit true.
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
 * Create + transition + persist the journal for a successful snapshot, driving
 * `planned`→`snapshotted`. When `enableWrites` is true it then CONTINUES the
 * lifecycle into the governed write (`snapshotted`→`applying`→`committed`) via
 * performApply; otherwise it STOPS at 'snapshotted' with an apply-writes-disabled
 * info (the U12 default). Returns the lifecycle result, or a failure result on any
 * sub-step failure. Extracted from applyPlan to keep both functions under the SLOC
 * limit. Never throws (performApply is itself async + never-throws).
 *
 * @param {object} args
 * @param {Plan}   args.plan
 * @param {string} args.targetClaudeDir
 * @param {string} args.mgrStateDir
 * @param {(path:string, ctx:string)=>string} args.assertWritable
 * @param {() => Date} [args.now]
 * @param {boolean} [args.enableWrites]  continue past 'snapshotted' into the write
 * @param {object}  [args.retry]         forwarded to the atomic write
 * @param {{snapshotId:string|null, manifestPath:string|null, archivePath:string|null, reclaimed?:boolean}} args.snap
 * @param {{createJournalFn:Function, transitionFn:Function, writeJournalFn:Function, atomicWriteFn:Function}} args.fns
 * @param {DiagnosticBag} args.bag
 * @returns {Promise<ApplyResult>}
 */
async function persistJournal(args) {
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

  // Default (writes-disabled) path: STOP at 'snapshotted'. No 'applying'
  // transition, no governed write. Surface an INFO so the caller knows why nothing
  // was applied. (P3.U12 behavior, preserved byte-identically.)
  if (args.enableWrites !== true) {
    bag.add({ severity: 'info', code: 'apply-writes-disabled', phase: PHASE,
      message: "apply reached 'snapshotted'; governed-config writes are disabled (pass enableWrites) — no files were modified" });
    return buildResult({ ...base, ok: true, state: 'snapshotted', journalPath: w.path }, bag);
  }

  // enableWrites: CONTINUE the lifecycle into the governed write.
  return performApply({
    plan, mgrStateDir, assertWritable, now, retry: args.retry, snap,
    fns, bag, base, journal: t.journal, journalPath: w.path,
  });
}

/**
 * Validate the op set is a SINGLE writable op (P3.U13; multi-op is P3.U19), then
 * drive the governed write: `snapshotted`→`applying`, atomic write, →`committed`.
 * Any refusal (multi-op / bad kind / invalid op) marks the journal `failed`
 * WITHOUT an 'applying' transition or a write. A failed atomic write marks the
 * journal `failed` and surfaces res.leftovers. Never throws.
 *
 * @param {object} a  { plan, mgrStateDir, assertWritable, now, retry, snap, fns,
 *                       bag, base, journal, journalPath }
 * @returns {Promise<ApplyResult>}
 */
async function performApply(a) {
  const { plan, mgrStateDir, assertWritable, snap, fns, bag, base, journal, journalPath } = a;
  // Refuse before any 'applying' transition: persist a `failed` journal + return.
  const refuse = (code, message, fields) => toFailed(a, journal, code, message, fields);

  const ops = Array.isArray(plan.ops) ? plan.ops : [];
  if (ops.length > 1) {
    return refuse('apply-multi-op-unsupported', 'apply supports a single op in P3.U13; multi-op is P3.U19');
  }
  if (ops.length === 1) {
    const bad = invalidOpReason(ops[0]);
    if (bad) return refuse(bad.code, bad.message, {});
  }

  // snapshotted → applying, then persist. No governed write has happened yet.
  const t = fns.transitionFn(journal, 'applying', { now: a.now });
  for (const d of t.diagnostics) bag.add(d);
  if (!t.ok) {
    bag.add({ severity: 'error', code: 'apply-transition-failed', phase: PHASE,
      message: "could not transition journal to 'applying'" });
    return buildResult({ ...base, state: 'snapshotted', journalPath }, bag);
  }
  const wp = persistAt(a, t.journal);
  if (!wp.written) {
    bag.add({ severity: 'error', code: 'apply-journal-write-failed', phase: PHASE,
      message: "could not persist the apply journal at 'applying'" });
    return buildResult({ ...base, state: 'snapshotted', journalPath }, bag);
  }

  // The single governed write (or a clean no-op when ops.length === 0).
  let opsWritten = 0;
  if (ops.length === 1) {
    const op = ops[0];
    const res = await fns.atomicWriteFn({ target: op.target, content: op.content, assertWritable, retry: a.retry });
    for (const d of res.diagnostics ?? []) bag.add(d);
    if (!res.ok) {
      return toFailed(a, t.journal, 'apply-op-failed',
        'the governed write failed; the journal is marked failed (snapshot intact for rollback)',
        { applied: false, leftovers: res.leftovers, journalPath: wp.path });
    }
    opsWritten = 1;
  }
  return commitApply({ ...a, journal: t.journal, journalPath: wp.path, opsWritten });
}

/**
 * applying → committed + persist. The governed write has ALREADY landed, so on a
 * commit-transition / persist failure we report `applied:true` but `ok:false`
 * (the on-disk file changed; do not claim a clean commit — recover reconciles).
 * @param {object} a  { mgrStateDir, assertWritable, now, fns, bag, base, journal,
 *                       journalPath, opsWritten }
 * @returns {ApplyResult}
 */
function commitApply(a) {
  const { fns, bag, base, journal, journalPath, opsWritten } = a;
  const t = fns.transitionFn(journal, 'committed', { now: a.now });
  for (const d of t.diagnostics) bag.add(d);
  if (!t.ok) {
    bag.add({ severity: 'error', code: 'apply-commit-incomplete', phase: PHASE,
      message: "the file was written but the journal could not reach 'committed' — recover --resume/--rollback to reconcile" });
    return buildResult({ ...base, applied: true, opsWritten, state: 'applying', journalPath }, bag);
  }
  const w = persistAt(a, t.journal);
  if (!w.written) {
    bag.add({ severity: 'error', code: 'apply-commit-incomplete', phase: PHASE,
      message: "the file was written but the committed journal could not be persisted — recover --resume/--rollback to reconcile" });
    return buildResult({ ...base, applied: true, opsWritten, state: 'applying', journalPath }, bag);
  }
  return buildResult({ ...base, ok: true, applied: true, opsWritten, state: 'committed', journalPath: w.path }, bag);
}

/**
 * Reason a single op is not a writable create/overwrite op, or null when it is
 * valid. Kind errors and missing-field errors carry distinct codes. Pure.
 * @param {unknown} op
 * @returns {{code:string, message:string}|null}
 */
function invalidOpReason(op) {
  if (!op || typeof op !== 'object' || !WRITABLE_KINDS.includes(op.kind)) {
    return { code: 'apply-op-kind-unsupported',
      message: `apply supports only ${WRITABLE_KINDS.join('/')} ops in P3.U13` };
  }
  if (!isNonEmptyStr(op.target) || typeof op.content !== 'string') {
    return { code: 'apply-op-invalid', message: 'op must have a non-empty string target and a string content' };
  }
  return null;
}

/**
 * Transition `journal` (in any active state) to 'failed', persist it, and return a
 * `failed` ApplyResult carrying `code`/`message` + any extra `fields`. Used by the
 * refusal paths and the write-failure path so a refused/failed apply always leaves
 * a persisted `failed` journal. Never throws.
 * @param {object} a   the performApply arg bundle (mgrStateDir/assertWritable/fns/bag/base)
 * @param {object} journal    the journal to transition
 * @param {string} code @param {string} message @param {object} fields  extra result fields
 * @returns {ApplyResult}
 */
function toFailed(a, journal, code, message, fields) {
  const { fns, bag, base } = a;
  bag.add({ severity: 'error', code, message, phase: PHASE });
  const t = fns.transitionFn(journal, 'failed', { now: a.now });
  for (const d of t.diagnostics) bag.add(d);
  if (t.ok) persistAt(a, t.journal);
  return buildResult({ ...base, state: 'failed', ...fields }, bag);
}

/**
 * Persist a journal into `.mgr-state` via the injected writeJournalFn + gate.
 * Diagnostics are aggregated into the shared bag. Thin shared helper.
 * @param {object} a  { mgrStateDir, assertWritable, snap, fns, bag }
 * @param {object} journal
 * @returns {{written:boolean, path:string|null}}
 */
function persistAt(a, journal) {
  const w = a.fns.writeJournalFn({
    stateDir: a.mgrStateDir, snapshotId: a.snap.snapshotId, journal, assertWritable: a.assertWritable,
  });
  for (const d of w.diagnostics ?? []) a.bag.add(d);
  return { written: !!w.written, path: w.path ?? null };
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
 * @param {boolean} [opts.enableWrites=false]       continue past 'snapshotted' and
 *                                                  perform the single governed write
 *                                                  (otherwise stop at 'snapshotted')
 * @param {object}  [opts.retry]                    retry schedule forwarded to the atomic write
 * @param {() => Date} [opts.now]                   clock injection (defaults to Date)
 * @param {object}  [opts.seams]                    { acquireFn, releaseFn, createSnapshotFn, createJournalFn, transitionFn, writeJournalFn, atomicWriteFn }
 * @returns {Promise<ApplyResult>}
 */
export async function applyPlan(opts) {
  const bag = new DiagnosticBag();
  const o = opts && typeof opts === 'object' ? opts : {};
  const { plan, targetClaudeDir, mgrStateDir, assertWritable, reason = '', includeAuth = false } = o;
  const enableWrites = o.enableWrites === true;
  const now = typeof o.now === 'function' ? o.now : () => new Date();
  const seams = o.seams && typeof o.seams === 'object' ? o.seams : {};
  const acquireFn = seams.acquireFn ?? acquireLock;
  const releaseFn = seams.releaseFn ?? releaseLock;
  const createSnapshotFn = seams.createSnapshotFn ?? createSnapshot;
  const fns = {
    createJournalFn: seams.createJournalFn ?? createJournal,
    transitionFn: seams.transitionFn ?? transition,
    writeJournalFn: seams.writeJournalFn ?? writeJournal,
    atomicWriteFn: seams.atomicWriteFn ?? atomicApplyWrite,
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
      return await persistJournal({
        plan, targetClaudeDir, mgrStateDir, assertWritable, now, enableWrites, retry: o.retry,
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
