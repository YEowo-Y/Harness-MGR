/**
 * Recover --rollback + --from-manifest (P3.U18) — the BACKWARD reconciliation of an
 * interrupted apply: restore the snapshot's captured bytes back onto the live tree.
 *
 * Both modes are thin wrappers over the heavily-reviewed U17 orchestrator
 * `rollbackSnapshot` (acquire-lock → drift-check → decompress-verify → restore), so
 * ALL of its safety machinery applies unchanged: DRY-RUN BY DEFAULT, the apply lock,
 * the drift REFUSAL (override only with `force`), the archive-corrupt abort, the
 * per-file gate + preSha256 re-verify, and the cross-target guard. This module ADDS
 * only the journal reconciliation on top:
 *
 *   --rollback  (journal-AWARE):  read the journal → require a legal `→ rolled-back`
 *       edge (refuse 'planned' = no snapshot yet, and 'rolled-back' = already done)
 *       → rollbackSnapshot → on a successful --apply restore, persist the journal at
 *       'rolled-back'. Use when the journal is intact.
 *   --from-manifest (journal-AGNOSTIC): IGNORE the journal entirely → rollbackSnapshot
 *       (it reads the MANIFEST + tar, never the journal) → on success, BEST-EFFORT
 *       transition the journal to 'rolled-back' IF it happens to be readable+eligible,
 *       else just report the restore (the live tree is what matters). This is the
 *       corrupted-journal recovery path — it restores even when apply-journal.json is
 *       unreadable/missing, because the manifest is the source of truth.
 *
 * CRASH WINDOW (target absent + .mgr-old present + journal at 'applying'): handled for
 * free — the snapshot holds the file's ORIGINAL bytes, and the restore primitive
 * writes them regardless of whether the live target currently exists. drift-check
 * reports the absent file as drift, so recovering a crash needs `force` (the missing
 * file IS the drift); the dry-run shows that drift first. Stranded `.mgr-new`/`.mgr-old`
 * sidecars are left for doctor #21 / `gc` (P3.U21) — sidecar cleanup is not recover's job.
 *
 * M2-SAFETY: imports only src/lib + sibling src/ops (never src/paths.mjs). NEVER
 * THROWS — every failure (including a thrown seam) becomes a Diagnostic + a full-shape
 * RecoverResult. Injectable seams make every path hermetic (no real lock/tar/fs).
 */

import { DiagnosticBag } from '../lib/diagnostic.mjs';
import { readJournal, transition, writeJournal } from './apply-journal-writer.mjs';
import { rollbackSnapshot } from './rollback.mjs';
import { PHASE, CODE, isNonEmptyStr, buildResult } from './recover-shared.mjs';

/** @typedef {import('./recover-shared.mjs').RecoverResult} RecoverResult */

/** Resolve the {readJournalFn, transitionFn, writeJournalFn, rollbackFn} seam set. */
function resolveFns(seams) {
  const s = seams && typeof seams === 'object' ? seams : {};
  return {
    readJournalFn: s.readJournalFn ?? readJournal,
    transitionFn: s.transitionFn ?? transition,
    writeJournalFn: s.writeJournalFn ?? writeJournal,
    rollbackFn: s.rollbackFn ?? rollbackSnapshot,
  };
}

/**
 * Call rollbackSnapshot with the recover opts and aggregate its diagnostics. Returns
 * the full RollbackResult. enableWrites defaults FALSE (dry-run), so a plain
 * `recover --rollback` previews without writing — the governed-write modes gate the
 * restore behind enableWrites just like apply/rollback.
 * @param {object} o @param {Function} rollbackFn @param {DiagnosticBag} bag
 * @returns {Promise<object>} the RollbackResult
 */
async function runRollback(o, rollbackFn, bag) {
  const rb = await rollbackFn({
    mgrStateDir: o.mgrStateDir, targetClaudeDir: o.targetClaudeDir, snapshotId: o.snapshotId,
    assertWritable: o.assertWritable, force: o.force === true, enableWrites: o.enableWrites === true,
    expectedTarget: o.expectedTarget, pid: o.pid, now: o.now, retry: o.retry,
  });
  for (const d of rb?.diagnostics ?? []) bag.add(d);
  return rb ?? { ok: false, status: 'error', code: CODE.error, dryRun: o.enableWrites !== true, diagnostics: [] };
}

/**
 * --rollback: journal-aware restore. Reads the journal, requires a legal
 * `→ rolled-back` edge, runs rollbackSnapshot, and on a successful --apply restore
 * persists the journal at 'rolled-back'. Never throws.
 *
 * @param {object} opts  { mgrStateDir, targetClaudeDir, snapshotId, assertWritable,
 *   force?, enableWrites?, expectedTarget?, pid?, now?, retry?, seams? }
 * @returns {Promise<RecoverResult>}
 */
export async function rollbackRecover(opts) {
  const bag = new DiagnosticBag();
  const o = opts && typeof opts === 'object' ? opts : {};
  const now = typeof o.now === 'function' ? o.now : () => new Date();
  const fns = resolveFns(o.seams);
  const dryRun = o.enableWrites !== true;
  const fail = (code, message, exitCode, fields) => {
    bag.add({ severity: 'error', code, message, phase: PHASE });
    return buildResult({ mode: 'rollback', code: exitCode, dryRun, snapshotId: o.snapshotId, ...fields }, bag);
  };

  try {
    if (!isNonEmptyStr(o.targetClaudeDir)) {
      return fail('recover-bad-args', 'targetClaudeDir must be a non-empty string for --rollback', CODE.usage);
    }

    // 1. Read the journal (rollback is journal-aware; corrupt → recommend --from-manifest).
    const { journal, diagnostics: readD } = fns.readJournalFn({ stateDir: o.mgrStateDir, snapshotId: o.snapshotId });
    for (const d of readD ?? []) bag.add(d);
    if (!journal) {
      return fail('recover-rollback-no-journal',
        'could not read the apply journal; use --from-manifest to roll back from the manifest alone', CODE.error);
    }

    // 2. Eligibility: the journal must have a legal edge to 'rolled-back'. 'planned'
    //    (no snapshot captured yet) and 'rolled-back' (already done) are refused.
    const t = fns.transitionFn(journal, 'rolled-back', { now });
    for (const d of t.diagnostics ?? []) bag.add(d);
    if (!t.ok) {
      return fail('recover-rollback-ineligible',
        `cannot roll back a '${journal.state}' apply (no snapshot to restore, or already rolled back)`,
        CODE.error, { state: journal.state });
    }

    // 3. Run the restore (dry-run by default; --apply performs it).
    const rb = await runRollback(o, fns.rollbackFn, bag);
    if (dryRun || !(rb.ok && rb.status === 'restored')) {
      // Preview, or a failed/refused restore: do NOT touch the journal. The `??`
      // fallback keeps code consistent with ok even if a seam omits code (the real
      // rollbackSnapshot always sets it; this guards a malformed injected seam).
      return buildResult({ ok: rb.ok === true, mode: 'rollback', code: rb.code ?? (rb.ok ? CODE.ok : CODE.error),
        dryRun, snapshotId: o.snapshotId, state: journal.state, rollback: rb }, bag);
    }

    // 4. Restore succeeded → persist the journal at 'rolled-back'.
    const w = fns.writeJournalFn({ stateDir: o.mgrStateDir, snapshotId: o.snapshotId, journal: t.journal, assertWritable: o.assertWritable });
    for (const d of w.diagnostics ?? []) bag.add(d);
    if (!w.written) {
      bag.add({ severity: 'error', code: 'recover-rollback-journal-write-failed', phase: PHASE,
        message: 'the live tree was restored, but the journal could not be marked rolled-back (re-run recover to reconcile the journal)' });
      return buildResult({ ok: false, mode: 'rollback', code: CODE.error, dryRun, snapshotId: o.snapshotId, state: 'applying', rollback: rb }, bag);
    }
    bag.add({ severity: 'info', code: 'recover-rolled-back', phase: PHASE,
      message: "restored the snapshot onto the live tree and marked the journal 'rolled-back'" });
    return buildResult({ ok: true, mode: 'rollback', code: CODE.ok, dryRun: false,
      snapshotId: o.snapshotId, state: 'rolled-back', journalPath: w.path, rollback: rb }, bag);
  } catch (e) {
    return fail('recover-unexpected-error', `unexpected error during rollback recover: ${e instanceof Error ? e.message : String(e)}`, CODE.error);
  }
}

/**
 * Best-effort journal reconciliation for --from-manifest after a successful restore:
 * if the journal is readable AND has a legal `→ rolled-back` edge, persist it there;
 * otherwise emit an INFO and move on (the manifest-based restore already succeeded —
 * a missing/corrupt/ineligible journal must NOT turn a good restore into a failure).
 * Never throws. Returns the resulting {state, journalPath}.
 * @param {object} o @param {object} fns @param {DiagnosticBag} bag
 * @returns {{ state: string|null, journalPath: string|null }}
 */
function reconcileManifestJournal(o, fns, bag) {
  const { journal } = fns.readJournalFn({ stateDir: o.mgrStateDir, snapshotId: o.snapshotId });
  if (!journal) {
    bag.add({ severity: 'info', code: 'recover-from-manifest-no-journal', phase: PHASE,
      message: 'restored from the manifest; no readable journal to mark rolled-back (this is expected for corrupted-journal recovery)' });
    return { state: null, journalPath: null };
  }
  const t = fns.transitionFn(journal, 'rolled-back', { now: o.now ?? (() => new Date()) });
  if (!t.ok) {
    bag.add({ severity: 'info', code: 'recover-from-manifest-journal-ineligible', phase: PHASE,
      message: `restored from the manifest; the journal state '${journal.state}' has no rolled-back edge, leaving it as-is` });
    return { state: journal.state, journalPath: null };
  }
  const w = fns.writeJournalFn({ stateDir: o.mgrStateDir, snapshotId: o.snapshotId, journal: t.journal, assertWritable: o.assertWritable });
  for (const d of w.diagnostics ?? []) bag.add(d);
  return w.written ? { state: 'rolled-back', journalPath: w.path } : { state: journal.state, journalPath: null };
}

/**
 * --from-manifest: journal-AGNOSTIC restore. Rolls back from the MANIFEST + tar
 * (never the journal), so it recovers even when apply-journal.json is corrupt or
 * missing. On a successful --apply restore it best-effort marks the journal
 * rolled-back. Never throws.
 *
 * @param {object} opts  same shape as rollbackRecover
 * @returns {Promise<RecoverResult>}
 */
export async function recoverFromManifest(opts) {
  const bag = new DiagnosticBag();
  const o = opts && typeof opts === 'object' ? opts : {};
  const fns = resolveFns(o.seams);
  const dryRun = o.enableWrites !== true;
  const fail = (code, message, exitCode) => {
    bag.add({ severity: 'error', code, message, phase: PHASE });
    return buildResult({ mode: 'from-manifest', code: exitCode, dryRun, snapshotId: o.snapshotId }, bag);
  };

  try {
    if (!isNonEmptyStr(o.targetClaudeDir)) {
      return fail('recover-bad-args', 'targetClaudeDir must be a non-empty string for --from-manifest', CODE.usage);
    }

    // Restore straight from the manifest (rollbackSnapshot never reads the journal).
    const rb = await runRollback(o, fns.rollbackFn, bag);
    if (dryRun || !(rb.ok && rb.status === 'restored')) {
      return buildResult({ ok: rb.ok === true, mode: 'from-manifest', code: rb.code ?? (rb.ok ? CODE.ok : CODE.error),
        dryRun, snapshotId: o.snapshotId, rollback: rb }, bag);
    }

    // Restore succeeded → best-effort journal reconciliation (never fails the result).
    const { state, journalPath } = reconcileManifestJournal(o, fns, bag);
    bag.add({ severity: 'info', code: 'recover-from-manifest-restored', phase: PHASE,
      message: 'restored the snapshot onto the live tree from the manifest' });
    return buildResult({ ok: true, mode: 'from-manifest', code: CODE.ok, dryRun: false,
      snapshotId: o.snapshotId, state, journalPath, rollback: rb }, bag);
  } catch (e) {
    return fail('recover-unexpected-error', `unexpected error during from-manifest recover: ${e instanceof Error ? e.message : String(e)}`, CODE.error);
  }
}
