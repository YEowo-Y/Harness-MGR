/**
 * Recover (P3.U14) — the crash-recovery primitive, `--mark-failed` mode ONLY.
 *
 * When an apply is interrupted (a crash between `snapshotted` and `committed`),
 * the apply-journal is left in a non-terminal state. `recover --mark-failed`
 * moves that journal to the `failed` state and DELIBERATELY STOPS:
 *
 *   readJournal  →  transition(journal,'failed')  →  writeJournal
 *                                                     *** that's the whole job ***
 *
 * It LEAVES THE DISK OTHERWISE AS-IS — no governed-config write, no snapshot
 * restore, no archive extraction. The ONLY filesystem write is the journal file
 * itself, inside `.mgr-state`, gated by the INJECTED assertWritable. Marking the
 * apply `failed` is a bookkeeping move that records "this apply did not complete";
 * a later `recover --rollback` / `--resume` / `--from-manifest` (P3.U18, NOT built
 * here) is what actually restores or finishes — recover-mark-failed only parks the
 * journal in a terminal-ish state and leaves every on-disk file for inspection.
 *
 * SECURITY / SAFETY invariants (each mirrors the sibling ops modules):
 *   1. NO governed-config write, NO snapshot restore. The only write this unit
 *      causes is the journal file in `.mgr-state` (via the injected assertWritable
 *      ctx 'apply'). There is no restore path.
 *   2. assertWritable is INJECTED + REQUIRED (fail-safe: if it is not a function we
 *      refuse and touch nothing — no read, no write), exactly like lock.mjs /
 *      snapshot-manifest-io.mjs / apply-journal-writer.
 *   3. PATH-TRAVERSAL DEFENSE (the headline DoD): a snapshotId is validated BEFORE
 *      any fs access — first the strict SNAPSHOT_ID_RE (which admits no '.', '/' or
 *      '\\', so a valid id can carry no traversal), then a belt-and-suspenders
 *      resolve() check that the snapshot dir is exactly `<snapshots>/<id>` and stays
 *      under the snapshots root. A non-conforming id NEVER reaches readJournal /
 *      writeJournal.
 *   4. `failed` is reached only via the legal state-machine transition: committed
 *      and rolled-back correctly REFUSE (committed→failed / rolled-back→failed are
 *      not edges), so a completed or already-rolled-back apply is never re-marked.
 *
 * M2-SAFETY: this module never imports src/paths.mjs (which carries a top-level
 * await) — not statically, not via dynamic import(). It takes the governed-write
 * gate + the state dir as params; the CLI layer (a later unit) dynamically imports
 * paths.mjs and injects them, keeping the static graph paths.mjs-free.
 *
 * Ops-layer constraint: imports only node:* stdlib + src/lib/** + sibling
 * src/ops/*. NEVER THROWS — every failure (including a thrown seam) becomes a
 * Diagnostic + `{ ok:false }`. Injectable seams make every path hermetically
 * unit-testable without a real journal / fs. Zero npm deps.
 *
 * Spec: plan claude-mgr-v5.md, the apply lifecycle recover step — the
 * `mark-failed` slice of recover (P3.U18 owns the other modes).
 */

import { join, resolve, sep } from 'node:path';
import { DiagnosticBag } from '../lib/diagnostic.mjs';
import { isValidSnapshotId, snapshotDir, SNAPSHOTS_DIRNAME, SNAPSHOT_ID_RE } from './snapshot-manifest.mjs';
import { readJournal, transition, writeJournal } from './apply-journal-writer.mjs';

/** @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic */

/** Stable diagnostic phase tag for this module's own findings. */
const PHASE = 'recover';

/** The only recover mode this unit supports (others are P3.U18). */
const SUPPORTED_MODE = 'mark-failed';

/**
 * @typedef {Object} RecoverResult
 * @property {boolean} ok            true ONLY when the journal was transitioned to
 *                                   'failed' AND persisted.
 * @property {string|null} snapshotId
 * @property {string|null} state     the resulting journal state ('failed' on
 *                                   success; the original state on an illegal move).
 * @property {string|null} journalPath  the written journal path on success.
 * @property {Diagnostic[]} diagnostics  aggregated across every step.
 */

/** True for a non-empty string. */
function isNonEmptyStr(v) {
  return typeof v === 'string' && v.length > 0;
}

/**
 * Build a RecoverResult, defaulting every field so callers always get the full
 * shape.
 * @param {Partial<RecoverResult>} fields
 * @param {DiagnosticBag} bag
 * @returns {RecoverResult}
 */
function buildResult(fields, bag) {
  return {
    ok: false, snapshotId: null, state: null, journalPath: null,
    ...fields,
    diagnostics: bag.all(),
  };
}

/**
 * Belt-and-suspenders path-traversal guard run AFTER the regex passes: confirm the
 * resolved snapshot dir is exactly `<snapshots>/<id>` and stays under the snapshots
 * root. The strict id regex already forbids separators/dots, so this can only fail
 * on a pathological input — but defense in depth is cheap and the DoD's headline.
 * @param {string} mgrStateDir
 * @param {string} snapshotId
 * @returns {boolean} true when the target is safely contained.
 */
function isContainedSnapshotDir(mgrStateDir, snapshotId) {
  const base = resolve(join(mgrStateDir, SNAPSHOTS_DIRNAME));
  const target = resolve(snapshotDir(mgrStateDir, snapshotId));
  return target === join(base, snapshotId) && target.startsWith(base + sep);
}

/**
 * Recover an interrupted apply by marking its journal `failed`. Reads the journal
 * for `snapshotId` under `mgrStateDir`, applies the legal `→ failed` transition,
 * and persists it (gated by the injected assertWritable). Performs NO governed-
 * config write and NO snapshot restore — the on-disk files are left exactly as
 * they are for inspection / a later rollback. NEVER throws: every failure,
 * including a thrown seam, becomes a Diagnostic + `{ ok:false }`.
 *
 * @param {object} opts
 * @param {string}  opts.snapshotId                 strict snapshot id (SNAPSHOT_ID_RE)
 * @param {string}  opts.mgrStateDir                absolute path to the .mgr-state dir
 * @param {string}  [opts.mode='mark-failed']       only 'mark-failed' is supported in U14
 * @param {(path:string, ctx:string)=>string} opts.assertWritable  REQUIRED governed-write gate
 * @param {() => Date} [opts.now]                   clock injection (defaults to Date)
 * @param {object}  [opts.seams]                    { readJournalFn, transitionFn, writeJournalFn }
 * @returns {RecoverResult}
 */
export function recover(opts) {
  const bag = new DiagnosticBag();
  const o = opts && typeof opts === 'object' ? opts : {};
  const { snapshotId, mgrStateDir, assertWritable, mode = SUPPORTED_MODE } = o;
  const now = typeof o.now === 'function' ? o.now : () => new Date();
  const seams = o.seams && typeof o.seams === 'object' ? o.seams : {};
  const readJournalFn = seams.readJournalFn ?? readJournal;
  const transitionFn = seams.transitionFn ?? transition;
  const writeJournalFn = seams.writeJournalFn ?? writeJournal;

  const fail = (code, message, fields) => {
    bag.add({ severity: 'error', code, message, phase: PHASE });
    return buildResult({ ...fields }, bag);
  };

  try {
    // 1. Validate — refuse BEFORE any fs access. The order matters: a bad gate,
    //    an unsupported mode, or a non-conforming id must never reach readJournal.
    if (!isNonEmptyStr(mgrStateDir)) {
      return fail('recover-bad-args', 'mgrStateDir must be a non-empty string');
    }
    if (typeof assertWritable !== 'function') {
      return fail('recover-bad-args', 'assertWritable (the governed-write gate) must be injected');
    }
    if (mode !== SUPPORTED_MODE) {
      return fail('recover-mode-unsupported',
        `unsupported recover mode ${JSON.stringify(mode)}; only '${SUPPORTED_MODE}' is implemented`);
    }
    // 1d. PATH-TRAVERSAL DEFENSE — strict regex THEN resolve-containment, both
    //     before any readJournal/writeJournal.
    if (!isValidSnapshotId(snapshotId)) {
      return fail('recover-bad-id', `snapshotId must match the strict id format ${SNAPSHOT_ID_RE}`);
    }
    if (!isContainedSnapshotDir(mgrStateDir, snapshotId)) {
      return fail('recover-path-escape',
        'resolved snapshot dir escapes the snapshots root; refusing to touch the filesystem');
    }

    // 2. Read the journal for this snapshot (the first fs access, only on a safe id).
    const { journal, diagnostics: readD } = readJournalFn({ stateDir: mgrStateDir, snapshotId });
    for (const d of readD ?? []) bag.add(d);
    if (!journal) {
      // The journal-not-found / journal-unreadable diag is already aggregated above.
      return buildResult({ snapshotId }, bag);
    }

    // 3. Apply the legal `→ failed` transition. committed / rolled-back refuse here.
    const t = transitionFn(journal, 'failed', { now });
    for (const d of t.diagnostics ?? []) bag.add(d);
    if (!t.ok) {
      bag.add({ severity: 'error', code: 'recover-illegal-transition', phase: PHASE,
        message: `cannot mark a '${journal.state}' apply failed; only an in-progress apply can be marked failed` });
      return buildResult({ snapshotId, state: journal.state }, bag);
    }

    // 4. Persist the now-failed journal (the ONLY write — gated, into .mgr-state).
    const w = writeJournalFn({ stateDir: mgrStateDir, snapshotId, journal: t.journal, assertWritable });
    for (const d of w.diagnostics ?? []) bag.add(d);
    if (!w.written) {
      bag.add({ severity: 'error', code: 'recover-journal-write-failed', phase: PHASE,
        message: 'could not persist the journal after marking it failed' });
      return buildResult({ snapshotId, state: 'failed' }, bag);
    }

    // 5. SUCCESS — the journal is parked at 'failed'; on-disk files are untouched.
    bag.add({ severity: 'info', code: 'recover-marked-failed', phase: PHASE,
      message: "the apply journal was marked 'failed'; on-disk files are left as-is for inspection or a later rollback" });
    return buildResult({ ok: true, snapshotId, state: 'failed', journalPath: w.path }, bag);
  } catch (e) {
    // Absolute backstop: a thrown seam / unexpected error becomes a diagnostic.
    return fail('recover-unexpected-error',
      `unexpected error during recover: ${e instanceof Error ? e.message : String(e)}`,
      { snapshotId: isValidSnapshotId(snapshotId) ? snapshotId : null });
  }
}
