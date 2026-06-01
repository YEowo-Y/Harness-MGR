/**
 * Recover (P3.U14 + P3.U18) — the crash-recovery entry point. ONE async dispatcher
 * `recover({mode, ...})` routes to the four recovery modes; the CLI (P3.U22) maps
 * its flags to a mode. The heavy per-mode logic lives in sibling modules so each
 * file stays under the 200-SLOC lint ceiling:
 *
 *   --mark-failed   (here)                  park an interrupted journal at 'failed'
 *                                           and STOP — leave every on-disk file as-is
 *                                           for inspection / a later rollback.
 *   --resume        (recover-resume.mjs)    FORWARD: a write that LANDED but whose
 *                                           journal never reached 'committed' →
 *                                           verify the bytes, then finalize 'committed'.
 *   --rollback      (recover-rollback.mjs)  BACKWARD (journal-aware): restore the
 *                                           snapshot's bytes onto the live tree, then
 *                                           mark the journal 'rolled-back'.
 *   --from-manifest (recover-rollback.mjs)  BACKWARD (journal-agnostic): restore from
 *                                           the MANIFEST alone — recovers even when
 *                                           apply-journal.json is corrupt/missing.
 *
 * SHARED SAFETY (all modes, via recover-shared.mjs::validateRecoverTarget, run BEFORE
 * any filesystem access):
 *   1. assertWritable is INJECTED + REQUIRED (fail-safe: refuse, never silently
 *      bypass) — recover is a repair tool; every mode either writes the journal or
 *      previews/performs a governed write, so the gate is uniformly required.
 *   2. PATH-TRAVERSAL DEFENSE — strict SNAPSHOT_ID_RE THEN a resolve()-containment
 *      check; a non-conforming id NEVER reaches a journal/manifest read or a write.
 *
 * Async because the rollback modes await the U17 `rollbackSnapshot` orchestrator;
 * --mark-failed stays synchronous internally (no await) and is returned as-is.
 *
 * M2-SAFETY: this module never imports src/paths.mjs (its top-level await would poison
 * the M2-safe ops graph) — the gate + state dir are params; the CLI injects them.
 *
 * Ops-layer constraint: node:* stdlib + src/lib/** + sibling src/ops/* only. NEVER
 * THROWS / never rejects — every failure (incl. a thrown seam) becomes a Diagnostic +
 * a full-shape RecoverResult. Injectable seams make every path hermetically testable.
 *
 * Spec: plan claude-mgr-v5.md, the apply-lifecycle recover step (P3.U14 mark-failed;
 * P3.U18 resume / rollback / from-manifest).
 */

import { DiagnosticBag } from '../lib/diagnostic.mjs';
import { isValidSnapshotId } from './snapshot-manifest.mjs';
import { readJournal, transition, writeJournal } from './apply-journal-writer.mjs';
import { PHASE, CODE, buildResult, validateRecoverTarget } from './recover-shared.mjs';
import { resumeApply } from './recover-resume.mjs';
import { rollbackRecover, recoverFromManifest } from './recover-rollback.mjs';

/** @typedef {import('./recover-shared.mjs').RecoverResult} RecoverResult */

/** The default mode when none is given (P3.U14 behavior). */
const DEFAULT_MODE = 'mark-failed';

/**
 * --mark-failed: mark an interrupted apply journal 'failed' and STOP. Reads the
 * journal, applies the legal `→ failed` transition, and persists it (gated, into
 * `.mgr-state`). Performs NO governed-config write and NO snapshot restore — the
 * on-disk files are left exactly as they are. Synchronous; the dispatcher's
 * try/catch is the never-throws backstop. Common args are already validated.
 * @param {object} o  the recover opts
 * @param {DiagnosticBag} bag
 * @returns {RecoverResult}
 */
function markFailed(o, bag) {
  const { snapshotId, mgrStateDir, assertWritable } = o;
  const now = typeof o.now === 'function' ? o.now : () => new Date();
  const seams = o.seams && typeof o.seams === 'object' ? o.seams : {};
  const readJournalFn = seams.readJournalFn ?? readJournal;
  const transitionFn = seams.transitionFn ?? transition;
  const writeJournalFn = seams.writeJournalFn ?? writeJournal;
  const fail = (code, message, fields) => {
    bag.add({ severity: 'error', code, message, phase: PHASE });
    return buildResult({ mode: DEFAULT_MODE, code: CODE.error, snapshotId, ...fields }, bag);
  };

  // 1. Read the journal (the first fs access, only on an already-validated safe id).
  const { journal, diagnostics: readD } = readJournalFn({ stateDir: mgrStateDir, snapshotId });
  for (const d of readD ?? []) bag.add(d);
  if (!journal) return buildResult({ mode: DEFAULT_MODE, code: CODE.error, snapshotId }, bag);

  // 2. Apply the legal `→ failed` transition. committed / rolled-back refuse here.
  const t = transitionFn(journal, 'failed', { now });
  for (const d of t.diagnostics ?? []) bag.add(d);
  if (!t.ok) {
    return fail('recover-illegal-transition',
      `cannot mark a '${journal.state}' apply failed; only an in-progress apply can be marked failed`,
      { state: journal.state });
  }

  // 3. Persist the now-failed journal (the ONLY write — gated, into .mgr-state).
  const w = writeJournalFn({ stateDir: mgrStateDir, snapshotId, journal: t.journal, assertWritable });
  for (const d of w.diagnostics ?? []) bag.add(d);
  if (!w.written) {
    return fail('recover-journal-write-failed', 'could not persist the journal after marking it failed', { state: 'failed' });
  }

  // 4. SUCCESS — the journal is parked at 'failed'; on-disk files are untouched.
  bag.add({ severity: 'info', code: 'recover-marked-failed', phase: PHASE,
    message: "the apply journal was marked 'failed'; on-disk files are left as-is for inspection or a later rollback" });
  return buildResult({ ok: true, mode: DEFAULT_MODE, code: CODE.ok, snapshotId, state: 'failed', journalPath: w.path }, bag);
}

/**
 * Recover an interrupted apply. Validates the shared target (gate + traversal
 * defense) then dispatches on `mode`. NEVER throws / never rejects: every failure,
 * including a thrown seam, becomes a Diagnostic + a full-shape RecoverResult.
 *
 * @param {object} opts
 * @param {string}  opts.snapshotId                 strict snapshot id (SNAPSHOT_ID_RE)
 * @param {string}  opts.mgrStateDir                absolute path to the .mgr-state dir
 * @param {'mark-failed'|'resume'|'rollback'|'from-manifest'} [opts.mode='mark-failed']
 * @param {(path:string, ctx:string)=>string} opts.assertWritable  REQUIRED governed-write gate
 * @param {string}  [opts.targetClaudeDir]          REQUIRED by resume/rollback/from-manifest
 * @param {boolean} [opts.enableWrites]             rollback/from-manifest: perform (else dry-run)
 * @param {boolean} [opts.force]                    rollback/from-manifest: override the drift refusal
 * @param {string}  [opts.expectedTarget]           rollback/from-manifest: cross-target guard
 * @param {number}  [opts.pid]                      rollback/from-manifest: lock pid
 * @param {() => Date} [opts.now]                   clock injection (defaults to Date)
 * @param {object}  [opts.retry]                    rollback/from-manifest: atomic-write retry schedule
 * @param {object}  [opts.seams]                    per-mode injectable seams
 * @returns {Promise<RecoverResult>}
 */
export async function recover(opts) {
  const bag = new DiagnosticBag();
  const o = opts && typeof opts === 'object' ? opts : {};
  const mode = typeof o.mode === 'string' && o.mode.length > 0 ? o.mode : DEFAULT_MODE;
  const safeId = isValidSnapshotId(o.snapshotId) ? o.snapshotId : null;

  try {
    // Shared validation (fail-safe, NO filesystem touch) — refuse a bad gate / id
    // before any mode can read or write.
    const v = validateRecoverTarget(o);
    if (!v.ok) {
      bag.add({ severity: 'error', code: v.code, message: v.message, phase: PHASE });
      return buildResult({ mode, code: v.exitCode, snapshotId: safeId }, bag);
    }

    switch (mode) {
      case 'mark-failed': return markFailed(o, bag);
      case 'resume': return await resumeApply(o);
      case 'rollback': return await rollbackRecover(o);
      case 'from-manifest': return await recoverFromManifest(o);
      default:
        bag.add({ severity: 'error', code: 'recover-mode-unsupported', phase: PHASE,
          message: `unsupported recover mode ${JSON.stringify(mode)}; expected mark-failed | resume | rollback | from-manifest` });
        return buildResult({ mode, code: CODE.usage, snapshotId: safeId }, bag);
    }
  } catch (e) {
    // Absolute backstop: a thrown seam / unexpected error becomes a diagnostic.
    bag.add({ severity: 'error', code: 'recover-unexpected-error', phase: PHASE,
      message: `unexpected error during recover: ${e instanceof Error ? e.message : String(e)}` });
    return buildResult({ mode, code: CODE.error, snapshotId: safeId }, bag);
  }
}
