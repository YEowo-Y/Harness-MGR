/**
 * Recover --resume (P3.U18) — the FORWARD reconciliation of an interrupted apply.
 *
 * When an apply's governed write LANDS but the journal cannot reach 'committed'
 * (apply.mjs's `apply-commit-incomplete`: the on-disk file IS already changed, only
 * the final journal-persist failed / the process died), the journal is stranded at
 * 'applying'. `recover --resume` finishes the job — it marks the journal 'committed'
 * — but ONLY after PROVING the write actually landed:
 *
 *   readJournal → (state must be 'applying') → RE-HASH each op's target on disk and
 *   compare to sha256(op.content) → if ALL match → transition applying→committed.
 *
 * The re-hash is the load-bearing safety check. It distinguishes the two ways an
 * apply can be stranded at 'applying':
 *   • write LANDED, journal not persisted  → target hash matches → resume to committed.
 *   • write did NOT land (the atomic-write CRASH WINDOW: target absent / .mgr-old
 *     holds the original) → target hash mismatches → REFUSE resume + recommend
 *     `--rollback`. Resume NEVER lies that an apply committed when the file is wrong.
 *
 * The ONLY filesystem write is the journal (in `.mgr-state`, via the injected gate);
 * the target is READ-ONLY here (resume finalizes bookkeeping, it does not re-write
 * the governed file — the write already happened). No lock is taken (journal-only,
 * like recover --mark-failed); the governed-write modes (--rollback) take the lock.
 *
 * SCOPE: apply (P3.U13) writes a SINGLE create/overwrite op, so resume verifies 0 or
 * 1 op. A redacted/patch/unknown op, a multi-op journal, an out-of-target path, or an
 * unreadable target are all UNVERIFIABLE → resume refuses conservatively (recommend
 * --rollback). Multi-op resume lands with multi-op apply (P3.U19).
 *
 * M2-SAFETY: imports only node:crypto/path + src/lib + sibling src/ops (never
 * src/paths.mjs). NEVER THROWS — every failure (including a thrown seam) becomes a
 * Diagnostic + a full-shape RecoverResult. Injectable seams make it hermetic.
 */

import { resolve, sep } from 'node:path';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { DiagnosticBag } from '../lib/diagnostic.mjs';
import { readJournal, transition, writeJournal } from './apply-journal-writer.mjs';
import { PHASE, CODE, isNonEmptyStr, buildResult } from './recover-shared.mjs';

/** @typedef {import('./recover-shared.mjs').RecoverResult} RecoverResult */

/** Op kinds apply writes (they carry a verbatim string `content`). */
const VERIFIABLE_KINDS = new Set(['create', 'overwrite']);

/** sha256 hex over a Buffer. Mirrors the sibling ops modules. */
function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/** Resolve a target path and confirm it stays under the governed root. */
function containedUnder(root, target) {
  const abs = resolve(target);
  return abs.startsWith(resolve(root) + sep) ? abs : null;
}

/**
 * Prove every op's write landed: re-hash each op's target and compare to
 * sha256(op.content). Returns true only when ALL ops are verifiably present with
 * matching content. 0 ops is vacuously verified. Any unverifiable op (bad kind /
 * non-string content / out-of-target path / unreadable target / hash mismatch)
 * → false, with a diagnostic explaining which. Never throws.
 * @param {object} journal
 * @param {{ targetClaudeDir: string, readFileFn: Function, bag: DiagnosticBag }} ctx
 * @returns {boolean}
 */
function opsLanded(journal, ctx) {
  const { targetClaudeDir, readFileFn, bag } = ctx;
  const ops = Array.isArray(journal.ops) ? journal.ops : [];
  if (ops.length > 1) {
    bag.add({ severity: 'error', code: 'recover-resume-unverified', phase: PHASE,
      message: 'cannot verify a multi-op apply (P3.U19); refusing to resume — use --rollback' });
    return false;
  }
  for (const op of ops) {
    if (!op || typeof op !== 'object' || !VERIFIABLE_KINDS.has(op.kind) || typeof op.content !== 'string' || !isNonEmptyStr(op.target)) {
      bag.add({ severity: 'error', code: 'recover-resume-unverified', phase: PHASE,
        message: 'op is not a verifiable create/overwrite with string content; refusing to resume — use --rollback' });
      return false;
    }
    const abs = containedUnder(targetClaudeDir, op.target);
    if (abs === null) {
      bag.add({ severity: 'error', code: 'recover-resume-unverified', phase: PHASE, path: op.target,
        message: 'op target escapes the governed dir; refusing to resume — use --rollback' });
      return false;
    }
    let buf;
    try { buf = readFileFn(abs); }
    catch {
      bag.add({ severity: 'error', code: 'recover-resume-unverified', phase: PHASE, path: op.target,
        message: 'op target is unreadable / absent on disk (the write did not land); refusing to resume — use --rollback' });
      return false;
    }
    if (sha256Hex(buf) !== sha256Hex(Buffer.from(op.content, 'utf8'))) {
      bag.add({ severity: 'error', code: 'recover-resume-unverified', phase: PHASE, path: op.target,
        message: 'on-disk content does not match the planned write; refusing to resume — use --rollback' });
      return false;
    }
  }
  return true;
}

/**
 * Resume an interrupted apply by finalizing its journal to 'committed' — but only
 * after proving the governed write landed (see the module header). Common args
 * (mgrStateDir / assertWritable / snapshotId) are validated by the dispatcher; this
 * adds the resume-specific targetClaudeDir. Never throws.
 *
 * @param {object} opts
 * @param {string}  opts.snapshotId
 * @param {string}  opts.mgrStateDir
 * @param {string}  opts.targetClaudeDir            governed dir the op targets must stay under
 * @param {(path:string, ctx:string)=>string} opts.assertWritable  REQUIRED journal-write gate
 * @param {() => Date} [opts.now]
 * @param {object}  [opts.seams]  { readJournalFn, transitionFn, writeJournalFn, readFileFn }
 * @returns {Promise<RecoverResult>}
 */
export async function resumeApply(opts) {
  const bag = new DiagnosticBag();
  const o = opts && typeof opts === 'object' ? opts : {};
  const { snapshotId, mgrStateDir, targetClaudeDir, assertWritable } = o;
  const now = typeof o.now === 'function' ? o.now : () => new Date();
  const seams = o.seams && typeof o.seams === 'object' ? o.seams : {};
  const readJournalFn = seams.readJournalFn ?? readJournal;
  const transitionFn = seams.transitionFn ?? transition;
  const writeJournalFn = seams.writeJournalFn ?? writeJournal;
  const readFileFn = seams.readFileFn ?? ((p) => readFileSync(p));

  const fail = (code, message, exitCode, fields) => {
    bag.add({ severity: 'error', code, message, phase: PHASE });
    return buildResult({ mode: 'resume', code: exitCode, snapshotId, ...fields }, bag);
  };

  try {
    if (!isNonEmptyStr(targetClaudeDir)) {
      return fail('recover-bad-args', 'targetClaudeDir must be a non-empty string for --resume', CODE.usage);
    }

    const { journal, diagnostics: readD } = readJournalFn({ stateDir: mgrStateDir, snapshotId });
    for (const d of readD ?? []) bag.add(d);
    if (!journal) return buildResult({ mode: 'resume', code: CODE.error, snapshotId }, bag);

    // Idempotent: an already-committed apply needs no resume.
    if (journal.state === 'committed') {
      bag.add({ severity: 'info', code: 'recover-resume-noop', phase: PHASE,
        message: "the apply is already 'committed'; nothing to resume" });
      return buildResult({ ok: true, mode: 'resume', code: CODE.ok, snapshotId, state: 'committed' }, bag);
    }
    // Only an 'applying' apply can be resumed forward.
    if (journal.state !== 'applying') {
      return fail('recover-resume-not-applying',
        `cannot resume a '${journal.state}' apply; only an interrupted 'applying' apply can be resumed (use --rollback / --mark-failed)`,
        CODE.error, { state: journal.state });
    }

    // PROVE the write landed before finalizing. A mismatch (e.g. the crash window)
    // refuses here — opsLanded already added the explanatory diagnostic.
    if (!opsLanded(journal, { targetClaudeDir, readFileFn, bag })) {
      return buildResult({ mode: 'resume', code: CODE.error, snapshotId, state: 'applying' }, bag);
    }

    // applying → committed, then persist (the only write — gated, into .mgr-state).
    const t = transitionFn(journal, 'committed', { now });
    for (const d of t.diagnostics ?? []) bag.add(d);
    if (!t.ok) {
      return fail('recover-resume-failed', "could not transition the journal to 'committed'", CODE.error, { state: 'applying' });
    }
    const w = writeJournalFn({ stateDir: mgrStateDir, snapshotId, journal: t.journal, assertWritable });
    for (const d of w.diagnostics ?? []) bag.add(d);
    if (!w.written) {
      return fail('recover-resume-failed', 'could not persist the committed journal', CODE.error, { state: 'committed' });
    }

    bag.add({ severity: 'info', code: 'recover-resumed', phase: PHASE,
      message: "verified the governed write landed; the apply journal is now 'committed'" });
    return buildResult({ ok: true, mode: 'resume', code: CODE.ok, snapshotId, state: 'committed', journalPath: w.path }, bag);
  } catch (e) {
    return fail('recover-unexpected-error', `unexpected error during resume: ${e instanceof Error ? e.message : String(e)}`, CODE.error);
  }
}
