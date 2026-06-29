/**
 * Rollback orchestrator (P3.U17) — the THIN wiring that turns the three rollback
 * pieces into ONE "roll a snapshot back onto the live tree" operation:
 *
 *   drift-check (U15)  →  decompress-verify (U16)  →  restore (the write-back)
 *
 * It mirrors apply.mjs's structure: validate → (for the write path) acquire the
 * apply lock OUTSIDE the try/finally → run the preflight + restore UNDER the lock
 * → release in the finally with the SAME pid. The headline behaviors:
 *
 *   • DRY-RUN BY DEFAULT (enableWrites !== true): runs drift-check + verify (both
 *     READ-ONLY — they never write the live tree), reports what WOULD happen, and
 *     touches nothing. NO lock, NO gate, NO restore. The same preflight the --apply
 *     path runs, so the dry-run preview is faithful.
 *   • --apply (enableWrites === true): acquires the lock, re-runs the preflight
 *     UNDER the lock (authoritative — no TOCTOU window between drift-check and the
 *     write), then restores via restoreSnapshot.
 *
 * REFUSAL LADDER (each maps to a CLI exit-code HINT in `code` for the U22 CLI):
 *   drift-check could not run            → status:'drift-error',     code:1
 *   drift found + NOT --force            → status:'refused-drift',   code:3 (headline)
 *   archive failed verification          → status:'archive-corrupt', code:4 (plan line 517)
 *   lock could not be acquired           → status:'lock-failed',     code:3
 *   bad args / missing gate              → status:'bad-args',        code:1
 *   restore ran but had a hard failure   → status:'restore-incomplete', code:1
 *   restore succeeded                    → status:'restored',        code:0
 *   dry-run preflight passed             → status:'dry-run',         code:0
 *   any unexpected throw                 → status:'error',           code:1
 *
 * SECURITY / SAFETY invariants (each mirrors the sibling ops modules):
 *   1. assertWritable is INJECTED + REQUIRED *for the --apply path* (fail-safe:
 *      refuse with bad-args BEFORE any lock if it is absent, never silently
 *      bypass). It is threaded into acquireLock AND restoreSnapshot (which gates
 *      every governed write with context:'rollback'). The dry-run path performs no
 *      write, so it needs no gate.
 *   2. The lock is acquired OUTSIDE the try/finally; the finally that releases it
 *      runs ONLY when we actually acquired it (we never release a lock we do not
 *      own — releaseLock is called with the SAME pid acquireLock used). The
 *      drift-recheck + restore run INSIDE that lock, so the single-writer
 *      assumption the restore primitive relies on holds and no concurrent writer
 *      can drift the tree between the recheck and the write.
 *   3. PREFLIGHT UNDER THE LOCK. The --apply path re-runs drift-check + verify
 *      AFTER acquiring the lock (not just the dry-run check), so the drift decision
 *      is authoritative at write time — a file edited after the dry-run but before
 *      the lock is still caught.
 *   4. expectedTarget CROSS-TARGET GUARD. The live `targetClaudeDir` is forwarded as
 *      `expectedTarget` to BOTH drift-check and verify so verifyManifest refuses a
 *      snapshot captured from a DIFFERENT tree (a wrong-tree manifest never drives a
 *      restore). Defaults to targetClaudeDir.
 *   5. ARCHIVE-CORRUPT ABORTS BEFORE THE WRITE. If verify reports the archive is not
 *      intact, the orchestrator returns code:4 and NEVER calls restoreSnapshot — a
 *      corrupt archive can never write garbage onto the governed tree.
 *
 * JOURNAL RECONCILIATION (deferred): this orchestrator is the STANDALONE
 * snapshot→live restore. It does NOT consult or transition an apply-journal — the
 * `apply --rollback`-style reconciliation of an interrupted apply's journal to
 * 'rolled-back' is P3.U18 (`recover --rollback`). Here drift + verify + restore is
 * the whole flow.
 *
 * M2-SAFETY: this module never imports src/paths.mjs (which carries a top-level
 * await) — not statically, not via dynamic import(). It takes the governed-write
 * gate + the two dir paths as params; the CLI layer dynamically imports paths.mjs
 * and injects them, keeping the static graph paths.mjs-free.
 *
 * Ops-layer constraint: imports only node:* stdlib + src/lib/** + sibling
 * src/ops/*. NEVER THROWS — every failure (including a thrown seam, garbage input)
 * becomes a Diagnostic + a full-shape result; a lock acquired before a throw is
 * still released in the finally. Injectable seams make every path hermetically
 * unit-testable without a real lock / drift / verify / restore / fs. Zero npm deps.
 *
 * Spec: plan harness-mgr-v5.md, the rollback orchestration (drift-refuse +
 * verify-abort + restore), P3.U17.
 */

import { DiagnosticBag } from '../lib/diagnostic.mjs';
import { acquireLock, releaseLock } from './lock.mjs';
import { checkRollbackDrift } from './rollback-drift-check.mjs';
import { verifyRollbackArchive } from './rollback-decompress-verify.mjs';
import { restoreSnapshot } from './rollback-restore.mjs';

/** @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic */

/** Stable diagnostic phase tag for this module's own findings. */
const PHASE = 'rollback';

/**
 * @typedef {Object} RollbackLock
 * @property {boolean} acquired
 * @property {boolean} [reclaimed]   true when a stale lock was reclaimed
 * @property {string}  [reason]      lock-failure reason when acquired is false
 */

/**
 * @typedef {Object} RollbackResult
 * @property {boolean} ok            true when the rollback completed cleanly: for a
 *                                   dry-run, the preflight passed; for --apply, the
 *                                   restore ran AND `restored` (no hard failure).
 * @property {'dry-run'|'restored'|'restore-incomplete'|'refused-drift'|'archive-corrupt'|'drift-error'|'lock-failed'|'bad-args'|'error'} status
 * @property {number} code           exit-code HINT for the CLI (see the ladder above).
 * @property {boolean} dryRun        true when no write was attempted (the default path).
 * @property {string|null} snapshotId
 * @property {object|null} drift     the DriftResult (or null if drift-check never ran).
 * @property {object|null} verify    the VerifyResult (or null if verify never ran).
 * @property {object|null} restore   the RestoreResult (or null if restore never ran).
 * @property {RollbackLock} lock     lock state ({acquired:false} on every no-lock path).
 * @property {Diagnostic[]} diagnostics  aggregated across every step.
 */

/** True for a non-empty string. */
function isNonEmptyStr(v) {
  return typeof v === 'string' && v.length > 0;
}

/** Message from an unknown thrown value; never throws. */
function errMsg(e) {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Build a RollbackResult, defaulting every field so callers always get the full
 * shape. `fields` spreads after the defaults, so an explicit value always wins.
 * @param {Partial<RollbackResult>} fields
 * @param {DiagnosticBag} bag
 * @returns {RollbackResult}
 */
function buildResult(fields, bag) {
  return {
    ok: false, status: 'error', code: 1, dryRun: false, snapshotId: null,
    drift: null, verify: null, restore: null, lock: { acquired: false },
    ...fields,
    diagnostics: bag.all(),
  };
}

/**
 * Run the READ-ONLY preflight: drift-check then (if drift is clean OR forced)
 * archive verify. Aggregates every step's diagnostics into the shared bag and
 * classifies the outcome. Used by BOTH the dry-run path and the --apply path
 * (under the lock), so the decision is identical. Never throws (its callees never
 * throw; the orchestrator's outer try/catch is the absolute backstop).
 *
 * @param {object} args
 * @param {string}  args.mgrStateDir
 * @param {string}  args.snapshotId
 * @param {string}  args.expectedTarget
 * @param {boolean} args.force
 * @param {{driftFn:Function, verifyFn:Function}} args.fns
 * @param {DiagnosticBag} args.bag
 * @returns {Promise<{proceed:boolean, status?:string, code?:number, drift:object|null, verify:object|null}>}
 */
async function runPreflight(args) {
  const { mgrStateDir, snapshotId, expectedTarget, force, fns, bag } = args;

  // 1. DRIFT — would the restore clobber post-snapshot edits?
  const drift = await fns.driftFn({ mgrStateDir, snapshotId, expectedTarget });
  for (const d of drift?.diagnostics ?? []) bag.add(d);
  if (!drift?.ok) {
    return { proceed: false, status: 'drift-error', code: 1, drift, verify: null };
  }
  if (!drift.clean && force !== true) {
    bag.add({ severity: 'warn', code: 'rollback-refused-drift', phase: PHASE,
      message: `live tree drifted from snapshot ${snapshotId}; refusing to roll back without --force (it would overwrite newer changes)`,
      fix: 'review the drift, then re-run with --force to overwrite the live changes' });
    return { proceed: false, status: 'refused-drift', code: 3, drift, verify: null };
  }

  // 2. VERIFY — is the archive intact enough to restore the captured bytes?
  const verify = await fns.verifyFn({ mgrStateDir, snapshotId, expectedTarget });
  for (const d of verify?.diagnostics ?? []) bag.add(d);
  if (!verify?.ok || !verify.verified) {
    bag.add({ severity: 'error', code: 'rollback-archive-corrupt', phase: PHASE,
      message: `snapshot ${snapshotId} archive failed verification; aborting before touching the live tree`,
      fix: 'the archive cannot be trusted to restore (do not proceed); inspect the snapshot' });
    return { proceed: false, status: 'archive-corrupt', code: 4, drift, verify };
  }

  return { proceed: true, drift, verify };
}

/**
 * The --apply path: acquire the lock OUTSIDE the try/finally, run the preflight +
 * restore UNDER the lock, release with the SAME pid in the finally. Extracted from
 * rollbackSnapshot to keep both functions under the SLOC limit. Never throws (the
 * orchestrator's outer try/catch still wraps this, and the finally always runs).
 *
 * @param {object} a
 * @param {string}  a.mgrStateDir
 * @param {string}  a.targetClaudeDir
 * @param {string}  a.snapshotId
 * @param {string}  a.expectedTarget
 * @param {Function} a.assertWritable
 * @param {boolean} a.force
 * @param {number}  a.lockPid
 * @param {() => Date} a.now
 * @param {object}  [a.retry]
 * @param {{driftFn:Function, verifyFn:Function, restoreFn:Function, acquireFn:Function, releaseFn:Function}} a.fns
 * @param {DiagnosticBag} a.bag
 * @returns {Promise<RollbackResult>}
 */
async function applyPath(a) {
  const { mgrStateDir, snapshotId, expectedTarget, assertWritable, force, lockPid, now, fns, bag } = a;

  // Acquire the lock OUTSIDE the try/finally so a failed acquire never reaches the
  // release path (we never release a lock we did not acquire). The SAME pid threads
  // into acquire + release.
  const acq = fns.acquireFn({ stateDir: mgrStateDir, assertWritable, pid: lockPid, now });
  for (const d of acq?.diagnostics ?? []) bag.add(d);
  if (!acq?.acquired) {
    bag.add({ severity: 'error', code: 'rollback-lock-failed', phase: PHASE,
      message: `could not acquire the apply lock (${acq?.reason ?? 'unknown'}); another apply/rollback may be running`,
      fix: 'wait for the other operation, or use --break-lock after confirming the process is gone' });
    return buildResult({ status: 'lock-failed', code: 3, dryRun: false, snapshotId,
      lock: { acquired: false, reason: acq?.reason } }, bag);
  }
  const lock = { acquired: true, ...(acq.reclaimed ? { reclaimed: true } : {}) };

  // Capture the result in a `let` so the finally can append release diagnostics to
  // the already-built result object directly (buildResult snapshots bag.all() at
  // call time, so a finally-side bag.add would be lost). The pattern mirrors the
  // bounded temp-cleanup in rollback-restore.mjs which also mutates the snapshot.
  let result;
  try {
    // Preflight UNDER the lock (authoritative — no TOCTOU between check and write).
    const pf = await runPreflight({ mgrStateDir, snapshotId, expectedTarget, force, fns, bag });
    if (!pf.proceed) {
      result = buildResult({ status: pf.status, code: pf.code, dryRun: false, snapshotId,
        drift: pf.drift, verify: pf.verify, lock }, bag);
      return result;
    }

    // The governed write-back. restoreSnapshot gates every write (context:'rollback').
    const restore = await fns.restoreFn({
      mgrStateDir, snapshotId, targetClaudeDir: a.targetClaudeDir, assertWritable, expectedTarget, retry: a.retry,
    });
    for (const d of restore?.diagnostics ?? []) bag.add(d);
    const ok = !!(restore?.ok && restore.restored);
    if (!ok) {
      bag.add({ severity: 'error', code: 'rollback-restore-incomplete', phase: PHASE,
        message: `rollback restore did not complete cleanly for snapshot ${snapshotId}; some files may not be restored` });
    }
    result = buildResult({ ok, status: ok ? 'restored' : 'restore-incomplete', code: ok ? 0 : 1,
      dryRun: false, snapshotId, drift: pf.drift, verify: pf.verify, restore, lock }, bag);
    return result;
  } finally {
    // Release with the SAME pid (runs on success, refusal, AND a thrown restore).
    // Wrapped in try/catch so a throwing releaseFn degrades to a WARN and never
    // masks a successful 'restored' result as 'error'. Mirrors the bounded cleanup
    // pattern in rollback-restore.mjs. Production releaseLock never throws; this
    // guard is defense-in-depth against a buggy or injected seam.
    // The warn is pushed onto result.diagnostics directly (not via bag.add) because
    // buildResult already snapshotted bag.all() when result was built above — any
    // bag.add after that point would not appear in the returned diagnostics array.
    try {
      const rel = fns.releaseFn({ stateDir: mgrStateDir, pid: lockPid });
      for (const d of rel?.diagnostics ?? []) {
        bag.add(d);
        if (result) result.diagnostics.push(d);
      }
    } catch (e) {
      const warn = { severity: 'warn', code: 'rollback-lock-release-failed', phase: PHASE,
        message: `could not release the apply lock: ${errMsg(e)}` };
      bag.add(warn);
      if (result) result.diagnostics.push(warn);
    }
  }
}

/**
 * Roll snapshot `snapshotId` (under `mgrStateDir`) back onto the live governed tree
 * `targetClaudeDir`. DRY-RUN BY DEFAULT — runs drift-check + verify (both read-only)
 * and reports what would happen, touching nothing. With `enableWrites === true` it
 * acquires the apply lock, re-runs the preflight UNDER the lock, and restores via
 * restoreSnapshot. NEVER throws: every failure (including a thrown seam, garbage
 * input) becomes a Diagnostic + a full-shape result; a lock acquired before a throw
 * is still released.
 *
 * @param {object} opts
 * @param {string}  opts.mgrStateDir          absolute path to the .mgr-state dir
 * @param {string}  opts.targetClaudeDir      absolute governed dir to restore INTO
 * @param {string}  opts.snapshotId           strict snapshot id (validated by the sub-units)
 * @param {(path:string, ctx:string)=>string} [opts.assertWritable]  REQUIRED for --apply (the write gate)
 * @param {boolean} [opts.force=false]        override the drift REFUSAL (overwrite live changes)
 * @param {boolean} [opts.enableWrites=false] perform the restore (otherwise dry-run preview)
 * @param {string}  [opts.expectedTarget]     cross-target guard fed to drift+verify (defaults to targetClaudeDir)
 * @param {number}  [opts.pid]                lock pid (defaults to process.pid); SAME pid acquire+release
 * @param {() => Date} [opts.now]             clock injection (defaults to Date)
 * @param {object}  [opts.retry]              forwarded to the restore's atomic writes
 * @param {object}  [opts.seams]              { driftFn, verifyFn, restoreFn, acquireFn, releaseFn }
 * @returns {Promise<RollbackResult>}
 */
export async function rollbackSnapshot(opts) {
  const bag = new DiagnosticBag();
  const o = opts && typeof opts === 'object' ? opts : {};
  const { mgrStateDir, targetClaudeDir, snapshotId, assertWritable, expectedTarget, retry } = o;
  const force = o.force === true;
  const enableWrites = o.enableWrites === true;
  const now = typeof o.now === 'function' ? o.now : () => new Date();
  const seams = o.seams && typeof o.seams === 'object' ? o.seams : {};
  const fns = {
    driftFn: seams.driftFn ?? checkRollbackDrift,
    verifyFn: seams.verifyFn ?? verifyRollbackArchive,
    restoreFn: seams.restoreFn ?? restoreSnapshot,
    acquireFn: seams.acquireFn ?? acquireLock,
    releaseFn: seams.releaseFn ?? releaseLock,
  };

  const fail = (status, message, fields) => {
    bag.add({ severity: 'error', code: 'rollback-bad-args', message, phase: PHASE });
    return buildResult({ status, code: 1, ...fields }, bag);
  };

  try {
    // 1. Validate — refuse BEFORE any lock. (snapshotId validity is enforced by the
    //    sub-units; we only require the two dirs here, mirroring apply.mjs.)
    if (!isNonEmptyStr(mgrStateDir)) return fail('bad-args', 'mgrStateDir must be a non-empty string');
    if (!isNonEmptyStr(targetClaudeDir)) return fail('bad-args', 'targetClaudeDir must be a non-empty string');

    const expectedTgt = isNonEmptyStr(expectedTarget) ? expectedTarget : targetClaudeDir;

    // 2. DRY-RUN (default): read-only preflight, NO lock, NO gate, NO restore.
    if (!enableWrites) {
      const pf = await runPreflight({ mgrStateDir, snapshotId, expectedTarget: expectedTgt, force, fns, bag });
      bag.add({ severity: 'info', code: 'rollback-writes-disabled', phase: PHASE,
        message: 'dry-run: pass enableWrites/--apply to perform the rollback; no files were modified' });
      return buildResult({
        ok: pf.proceed, status: pf.proceed ? 'dry-run' : pf.status, code: pf.proceed ? 0 : pf.code,
        dryRun: true, snapshotId: snapshotId ?? null, drift: pf.drift, verify: pf.verify,
      }, bag);
    }

    // 3. --apply: the write gate is REQUIRED (fail-safe BEFORE any lock).
    if (typeof assertWritable !== 'function') {
      return fail('bad-args', 'assertWritable (the governed-write gate) must be injected for --apply', { dryRun: false });
    }
    const lockPid = Number.isInteger(o.pid) ? o.pid : process.pid;
    return await applyPath({
      mgrStateDir, targetClaudeDir, snapshotId, expectedTarget: expectedTgt, assertWritable,
      force, lockPid, now, retry, fns, bag,
    });
  } catch (e) {
    // Absolute backstop: a thrown seam / unexpected error becomes a diagnostic.
    bag.add({ severity: 'error', code: 'rollback-unexpected-error', phase: PHASE,
      message: `unexpected error during rollback: ${e instanceof Error ? e.message : String(e)}` });
    return buildResult({ status: 'error', code: 1, snapshotId: isNonEmptyStr(snapshotId) ? snapshotId : null }, bag);
  }
}
