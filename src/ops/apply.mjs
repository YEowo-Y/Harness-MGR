/**
 * Apply orchestrator (P3.U12 preamble + P3.U13 governed write + P3.U19 multi-op).
 * It wires the apply primitives into the apply lifecycle:
 *
 *   acquire-lock → SNAPSHOTTED (createSnapshot) → journal planned→snapshotted
 *      ├─ enableWrites !== true (DEFAULT):  *** STOP (writes disabled) ***
 *      └─ enableWrites === true:  snapshotted → applying → committed (N ops)
 *                                              (or → failed on refusal / write fail)
 *
 * By DEFAULT (no `enableWrites`) this drives the journal `planned`→`snapshotted`
 * only and performs NO governed-config write — the safe, recoverable PREAMBLE
 * (a lock so two applies can't race, a snapshot so a future apply can be rolled
 * back, a persisted journal recording that we got that far). That default path is
 * byte-identical to P3.U12 and proven to touch nothing under the governed config.
 *
 * With `enableWrites === true` the lifecycle CONTINUES past `snapshotted`: EVERY op
 * is executed via its primitive, IN PLAN ORDER, driving the journal
 * `applying`→`committed` (or `→ failed`). A create/overwrite op is WRITTEN via the
 * atomic-write primitive (sub-unit B, gate context 'apply'); a delete op (no
 * `content`; the target file is removed) is DELETED via the atomic-delete primitive
 * (P4a.U1b, gate context 'remove'); a delete-dir op (no `content`; the target skill
 * directory is removed) is DELETED via the atomic-dir-delete primitive (P4b.S2, gate
 * context 'remove-skill'). All ops are validated BEFORE any write/delete — if ANY op
 * is invalid the apply REFUSES (marks the journal `failed`) without an `applying`
 * transition or a single mutation. The partial-failure / recover semantics are
 * IDENTICAL for all op classes.
 *
 * --paranoid: after each governed write of a *.json target, the file is re-read
 * from disk and re-parsed with the tolerant JSONC parser. A parse failure ABORTS
 * the apply (journal → `failed`); the snapshot is intact, so `recover --rollback`
 * restores the pre-apply bytes. Non-JSON targets are never re-read.
 *
 * MULTI-OP PARTIAL-FAILURE MODEL: ops are written one at a time. On a mid-sequence
 * write failure (or a paranoid parse failure) the loop STOPS — op N+1.. are never
 * attempted, the journal is marked `failed`, and `applied` reflects whether at
 * least one op's bytes landed (`opsWritten > 0`). Apply does NOT auto-rollback the
 * ops that already wrote; the snapshot + `recover --rollback` is the recovery path.
 *
 * SECURITY / SAFETY invariants (each mirrors the sibling ops modules):
 *   1. The ONLY governed-config mutations are the atomic write/delete of the ops,
 *      and they happen ONLY under `enableWrites === true`. A create/overwrite routes
 *      through atomicApplyWrite (assertWritable(target,'apply')); a delete routes
 *      through atomicApplyDelete (assertWritable(target,'remove')); a delete-dir
 *      routes through atomicApplyDirDelete (assertWritable(target,'remove-skill')) —
 *      each primitive calls the gate INTERNALLY. There is NO local path allowlist;
 *      the gate is the single source of truth. All .mgr-state writes (lock, snapshot,
 *      journal) are likewise gated by the INJECTED assertWritable.
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
 * PARTIAL FAILURE (journal vs governed writes): if the snapshot succeeds but the
 * journal transition/write then fails, the (valid) snapshot dir is left in
 * `.mgr-state` for inspection — `gc` / `list` tolerate a snapshot dir without an
 * apply-journal.json. If one or more GOVERNED writes succeed but the final
 * `committed` journal-persist fails, the on-disk files ARE already changed: the
 * result reports `applied:true` but `ok:false` and the journal stays at `applying`
 * — a `recover --resume`/`--rollback` reconciles it. A mid-sequence write/paranoid
 * failure marks the journal `failed` (see the MULTI-OP model above).
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

import { readFileSync } from 'node:fs';
import { DiagnosticBag } from '../lib/diagnostic.mjs';
import { acquireLock, releaseLock } from './lock.mjs';
import { createSnapshot } from './snapshot.mjs';
import { createJournal, transition, writeJournal } from './apply-journal-writer.mjs';
import { atomicApplyWrite } from './atomic-write.mjs';
import { atomicApplyDelete } from './atomic-delete.mjs';
import { atomicApplyDirDelete } from './atomic-dir-delete.mjs';
import { paranoidVerify } from './apply-paranoid.mjs';
import { checkOpTargetsInManifest } from './apply-manifest-check.mjs';

/** @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic */
/** @typedef {import('../lib/plan.mjs').Plan} Plan */
/** @typedef {import('../lib/plan.mjs').PlanOp} PlanOp */

/** The op kinds this unit can write (they carry `content`). */
const WRITABLE_KINDS = Object.freeze(['create', 'overwrite']);

/** The op kinds this unit can DELETE (no `content`; the target file is removed). */
const DELETABLE_KINDS = Object.freeze(['delete']);

/** The op kinds this unit can DELETE as a DIRECTORY (no `content`; the dir is removed). */
const DIR_DELETABLE_KINDS = Object.freeze(['delete-dir']);

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
 * @property {number} [opsWritten]   count of governed ops whose bytes landed (0 for
 *                                   a no-op apply; N for N committed ops). Also
 *                                   present on a PARTIAL-FAILURE result, where it is
 *                                   the number of ops written before the failure.
 * @property {{newPath?:string|null, oldPath:string|null}} [leftovers]  sidecar files
 *                                   stranded by a catastrophic op failure, passed
 *                                   through verbatim from the primitive: a write
 *                                   failure carries {newPath,oldPath}; a delete
 *                                   failure carries only {oldPath} (atomic-delete
 *                                   never strands a newPath).
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
  const defaults = { ok: false, state: null, applied: false,
    snapshotId: null, journalPath: null, manifestPath: null, archivePath: null, lock: { acquired: false } };
  // `diagnostics` is written LAST so a payload field can never clobber it.
  return { ...defaults, ...fields, diagnostics: bag.all() };
}

/**
 * Create + transition + persist the journal for a successful snapshot, driving
 * `planned`→`snapshotted`; when `enableWrites` is true, CONTINUES into the governed
 * write (`snapshotted`→`applying`→`committed`) via performApply. Extracted from
 * applyPlan to keep both functions under the SLOC limit. Never throws.
 * @param {object} args  { plan, targetClaudeDir, mgrStateDir, assertWritable, now,
 *   enableWrites, paranoid, retry, snap, fns, bag }
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
  const { journal: planned, diagnostics: cjD } = fns.createJournalFn({ snapshotId: snap.snapshotId, targetClaudeDir, plan, now });
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

  // enableWrites: CONTINUE. PART 2 — every op target MUST appear in the snapshot
  // manifest; if any is absent the write would be irreversible — refuse the apply.
  const mchk = checkOpTargetsInManifest(plan, snap, targetClaudeDir, fns.manifestReadFileFn, bag);
  if (!mchk.ok) return fail('apply-target-not-snapshotted', mchk.message, {});

  return performApply({
    plan, mgrStateDir, assertWritable, now, paranoid: args.paranoid, retry: args.retry, snap,
    fns, bag, base, journal: t.journal, journalPath: w.path,
  });
}

/**
 * Drive `snapshotted`→`applying`→`committed` (or `→failed`): validate all ops,
 * execute each in plan order, then commit. Never throws.
 * @param {object} a  { plan, mgrStateDir, assertWritable, now, paranoid, retry,
 *                       snap, fns, bag, base, journal, journalPath }
 * @returns {Promise<ApplyResult>}
 */
async function performApply(a) {
  const { plan, assertWritable, fns, bag, base, journalPath } = a;
  const ops = Array.isArray(plan.ops) ? plan.ops : [];

  // Validate ALL ops BEFORE any 'applying' transition or write.
  for (const op of ops) {
    const bad = invalidOpReason(op);
    if (bad) return toFailed(a, a.journal, bad.code, bad.message, {});
  }

  // snapshotted → applying, then persist. No governed write has happened yet; a
  // failure here leaves the journal at 'snapshotted' (nothing written).
  const stuck = (code, message) => {
    bag.add({ severity: 'error', code, message, phase: PHASE });
    return buildResult({ ...base, state: 'snapshotted', journalPath }, bag);
  };
  const t = fns.transitionFn(a.journal, 'applying', { now: a.now });
  for (const d of t.diagnostics) bag.add(d);
  if (!t.ok) return stuck('apply-transition-failed', "could not transition journal to 'applying'");
  const wp = persistAt(a, t.journal);
  if (!wp.written) return stuck('apply-journal-write-failed', "could not persist the apply journal at 'applying'");

  // Write/delete each op in plan order; a failure (or, for a written op under
  // --paranoid, a *.json re-parse failure) stops the sequence.
  const journal = t.journal;
  let opsWritten = 0;
  for (const op of ops) {
    const isDelete = DELETABLE_KINDS.includes(op.kind);
    const isDirDelete = DIR_DELETABLE_KINDS.includes(op.kind);
    let res;
    if (isDirDelete) {
      res = await fns.atomicDirDeleteFn({ target: op.target, assertWritable, retry: a.retry });
    } else if (isDelete) {
      res = await fns.atomicDeleteFn({ target: op.target, assertWritable, retry: a.retry });
    } else {
      res = await fns.atomicWriteFn({ target: op.target, content: op.content, assertWritable, retry: a.retry });
    }
    for (const d of res.diagnostics ?? []) bag.add(d);
    if (!res.ok) {
      const failCode = isDirDelete ? 'apply-op-dir-delete-failed' : (isDelete ? 'apply-op-delete-failed' : 'apply-op-failed');
      return toFailed(a, journal, failCode,
        `the governed ${isDirDelete ? 'dir-delete' : (isDelete ? 'delete' : 'write')} failed at op ${opsWritten + 1} of ${ops.length}; the journal is marked failed ` +
          '(snapshot intact — run recover --rollback to restore)',
        { applied: opsWritten > 0, opsWritten, leftovers: res.leftovers, journalPath: wp.path });
    }
    opsWritten += 1;
    // paranoid re-parse applies ONLY to written *.json files — deletes have nothing to re-read.
    if (!isDelete && !isDirDelete && a.paranoid && !paranoidVerify(op.target, fns.readFileFn, bag).ok) {
      return toFailed(a, journal, 'apply-paranoid-failed',
        `op ${opsWritten} of ${ops.length} wrote an unparseable file (paranoid re-parse failed); ` +
          'the journal is marked failed (snapshot intact — run recover --rollback to restore)',
        { applied: true, opsWritten, journalPath: wp.path });
    }
  }
  return commitApply({ ...a, journal, journalPath: wp.path, opsWritten });
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
  // The write(s) already landed; an incomplete commit reports applied:true/ok:false
  // and leaves the journal at 'applying' for recover --resume/--rollback to reconcile.
  const incomplete = (message) => {
    bag.add({ severity: 'error', code: 'apply-commit-incomplete', phase: PHASE, message });
    return buildResult({ ...base, applied: true, opsWritten, state: 'applying', journalPath }, bag);
  };
  const t = fns.transitionFn(journal, 'committed', { now: a.now });
  for (const d of t.diagnostics) bag.add(d);
  if (!t.ok) return incomplete("the file was written but the journal could not reach 'committed' — recover --resume/--rollback to reconcile");
  const w = persistAt(a, t.journal);
  if (!w.written) return incomplete('the file was written but the committed journal could not be persisted — recover --resume/--rollback to reconcile');
  return buildResult({ ...base, ok: true, applied: true, opsWritten, state: 'committed', journalPath: w.path }, bag);
}

/**
 * Reason a single op is not a supported create/overwrite/delete op, or null when it
 * is valid. A create/overwrite needs a non-empty `target` AND a string `content`; a
 * delete needs a non-empty `target` and NO content. Kind errors and missing-field
 * errors carry distinct codes. Pure.
 * @param {unknown} op
 * @returns {{code:string, message:string}|null}
 */
function invalidOpReason(op) {
  const obj = op && typeof op === 'object';
  const isWrite = obj && WRITABLE_KINDS.includes(op.kind);
  const isDelete = obj && DELETABLE_KINDS.includes(op.kind);
  const isDirDelete = obj && DIR_DELETABLE_KINDS.includes(op.kind);
  if (!isWrite && !isDelete && !isDirDelete) {
    return { code: 'apply-op-kind-unsupported',
      message: `apply supports only ${[...WRITABLE_KINDS, ...DELETABLE_KINDS, ...DIR_DELETABLE_KINDS].join('/')} ops` };
  }
  if (!isNonEmptyStr(op.target)) {
    return { code: 'apply-op-invalid', message: 'op must have a non-empty string target' };
  }
  if (isWrite && typeof op.content !== 'string') {
    return { code: 'apply-op-invalid', message: 'create/overwrite op must have a string content' };
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
  const w = a.fns.writeJournalFn({ stateDir: a.mgrStateDir, snapshotId: a.snap.snapshotId, journal, assertWritable: a.assertWritable });
  for (const d of w.diagnostics ?? []) a.bag.add(d);
  return { written: !!w.written, path: w.path ?? null };
}

/**
 * Run the apply lifecycle for a Plan: acquire the apply lock, capture a snapshot,
 * and persist a journal in the `snapshotted` state. By DEFAULT it STOPS there (no
 * governed-config write, `applied:false`); with `enableWrites` it CONTINUES into the
 * governed write(s) `applying`→`committed` (or `→ failed`). NEVER throws — every
 * failure, including a thrown seam, becomes a Diagnostic + `{ ok:false }` with the
 * aggregated diagnostics from every step that ran.
 *
 * @param {object} opts
 * @param {Plan}    opts.plan                       the plan to (eventually) apply
 * @param {string}  opts.targetClaudeDir            absolute path to the governed dir
 * @param {string}  opts.mgrStateDir                absolute path to the .mgr-state dir
 * @param {(path:string, ctx:string)=>string} opts.assertWritable  REQUIRED governed-write gate
 * @param {string}  [opts.reason='']                snapshot reason
 * @param {boolean} [opts.includeAuth=false]        opt in to capturing the auth-cache file
 * @param {import('./snapshot-walk.mjs').SnapshotScope} [opts.scope]  per-target snapshot
 *           scope forwarded to the auto-snapshot's createSnapshot (Codex). Absent → Claude scope.
 * @param {number}  [opts.pid]                      lock pid (defaults to process.pid); SAME pid used to release
 * @param {boolean} [opts.enableWrites=false]       continue past 'snapshotted' and
 *                                                  perform the governed write(s)
 *                                                  (otherwise stop at 'snapshotted')
 * @param {boolean} [opts.paranoid=false]           after each governed write of a
 *                                                  *.json target, re-read + re-parse
 *                                                  it; a parse failure aborts → failed
 * @param {object}  [opts.retry]                    retry schedule forwarded to the atomic write
 * @param {() => Date} [opts.now]                   clock injection (defaults to Date)
 * @param {object}  [opts.seams]                    { acquireFn, releaseFn, createSnapshotFn, createJournalFn, transitionFn, writeJournalFn, atomicWriteFn, atomicDeleteFn, atomicDirDeleteFn, readFileFn }
 * @returns {Promise<ApplyResult>}
 */
export async function applyPlan(opts) {
  const bag = new DiagnosticBag();
  const o = opts && typeof opts === 'object' ? opts : {};
  const { plan, targetClaudeDir, mgrStateDir, assertWritable, reason = '', includeAuth = false, scope } = o;
  const enableWrites = o.enableWrites === true;
  const paranoid = o.paranoid === true;
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
    atomicDeleteFn: seams.atomicDeleteFn ?? atomicApplyDelete,
    atomicDirDeleteFn: seams.atomicDirDeleteFn ?? atomicApplyDirDelete,
    readFileFn: seams.readFileFn ?? ((p) => readFileSync(p, 'utf8')),
    manifestReadFileFn: seams.manifestReadFileFn ?? ((p) => readFileSync(p, 'utf8')),
  };

  const fail = (code, message) => { bag.add({ severity: 'error', code, message, phase: PHASE }); return buildResult({}, bag); };

  try {
    // 1. Validate — refuse BEFORE acquiring a lock (no lock means no release path).
    if (!plan || typeof plan !== 'object') return fail('apply-bad-args', 'plan must be an object');
    if (!isNonEmptyStr(targetClaudeDir)) return fail('apply-bad-args', 'targetClaudeDir must be a non-empty string');
    if (!isNonEmptyStr(mgrStateDir)) return fail('apply-bad-args', 'mgrStateDir must be a non-empty string');
    if (typeof assertWritable !== 'function') return fail('apply-bad-args', 'assertWritable (the governed-write gate) must be injected');

    // 2. Acquire lock OUTSIDE try/finally — never release a lock we did not acquire.
    const lockPid = Number.isInteger(o.pid) ? o.pid : process.pid;
    const acq = acquireFn({ stateDir: mgrStateDir, assertWritable, pid: lockPid, now });
    for (const d of acq.diagnostics ?? []) bag.add(d);
    if (!acq.acquired) return buildResult({ lock: { acquired: false, reason: acq.reason } }, bag);

    // 3. Lock held → from here a finally MUST release it (with the same pid).
    try {
      const snap = await createSnapshotFn({
        targetClaudeDir, mgrStateDir, reason, includeAuth, assertWritable, now, dryRun: false,
        skipSecretFilter: true, scope,
      });
      for (const d of snap.diagnostics ?? []) bag.add(d);
      if (!snap.ok) {
        bag.add({ severity: 'error', code: 'apply-snapshot-failed', phase: PHASE,
          message: 'could not capture a snapshot before applying; aborting (no changes made)' });
        return buildResult({ lock: { acquired: true, ...(acq.reclaimed ? { reclaimed: acq.reclaimed } : {}) } }, bag);
      }
      return await persistJournal({
        plan, targetClaudeDir, mgrStateDir, assertWritable, now, enableWrites, paranoid, retry: o.retry,
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
