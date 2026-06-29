/**
 * Skill self-iteration ACCEPT engine (P5.U9 sub-unit B) — the user-facing entry for
 * `skill accept <name> [<proposalId>] [--force] [--apply]`.
 *
 * It lands a previously-proposed `skills/<name>/SKILL.proposed-<ts>.md` ONTO the real
 * `skills/<name>/SKILL.md`, snapshotting the governed surface FIRST so the change is
 * reversible by `rollback`. The THIRD governed-write class (after remove/cascade and
 * the delegate update/mcp) and the FIRST that OVERWRITES an existing content component.
 *
 *   acceptProposal(opts)
 *      ├─ validate args + select the proposal + read proposed bytes (the §4 matrix
 *      │     up to the read) + the stale-guard verdict  →  clean refusal, never writes
 *      ├─ enableWrites !== true (DEFAULT): return a PREVIEW (stale/provenance verdict
 *      │     surfaced) — writes NOTHING (no gate, no lock, no snapshot). A stale /
 *      │     missing-provenance dry-run WITHOUT --force still PREVIEWS (the refusal is
 *      │     the apply-path gate); only name-invalid/no-proposal/ambiguous/not-found/
 *      │     symlink refuse on BOTH paths.
 *      └─ enableWrites === true: stale guard (refuse without --force) →
 *            acquireLock → createSnapshot(skipSecretFilter) → manifest backstop (BOTH
 *            the SKILL.md overwrite AND the proposal delete target captured) →
 *            atomicApplyWrite(context:'accept', the proposed bytes) → BEST-EFFORT
 *            atomicApplyDelete(context:'accept', the proposal) → BEST-EFFORT delete the
 *            provenance record → releaseLock.
 *
 * SECURITY / SAFETY:
 *   - DRY-RUN BY DEFAULT. Without enableWrites it only READS (select + stale-guard) and
 *     touches NOTHING — no gate, no lock, no snapshot, no write.
 *   - The ONLY governed writes are the atomicApplyWrite of SKILL.md and the
 *     atomicApplyDelete of the accepted proposal, BOTH under the least-authority
 *     'accept' gate context (paths.mjs::assertAcceptContext) — which permits ONLY
 *     SKILL.md or a proposal leaf directly in skills/<validName>/. assertWritable is
 *     INJECTED + REQUIRED for --apply, never imported here.
 *   - The pre-overwrite snapshot (skipSecretFilter:true) is the undo point; the
 *     manifest backstop makes a silently-irreversible accept structurally impossible.
 *   - lstat (never follows symlinks) guards the skill dir / SKILL.md / the proposal.
 *
 * M2-SAFETY: imports ONLY node:fs / node:path / node:crypto, ../lib/diagnostic, and
 * M2-safe sibling src/ops/* (accept-select, snapshot, lock, atomic-write, atomic-delete,
 * apply-manifest-check). NEVER src/paths.mjs — the assertWritable gate + dirs are
 * injected params, keeping this module's static graph paths.mjs-free (the M2-safe
 * property the boundary self-check enforces). The lock/write/delete/snapshot primitives
 * are injected or imported only as M2-safe siblings. sha256 via node:crypto.
 *
 * Ops-layer constraint: node:* stdlib + src/lib/** + sibling src/ops/* only. Zero npm
 * deps. NEVER THROWS — the whole body is wrapped; any unexpected error becomes a
 * Diagnostic + `{ ok:false }`. An AcceptResult ALWAYS carries the full shape.
 *
 * Spec: docs/phase-5-u9-accept-design.md §1–§5/§7.
 */

import { lstatSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { DiagnosticBag } from '../lib/diagnostic.mjs';
import { selectProposal, staleGuard, errMsg } from './accept-select.mjs';
import { createSnapshot } from './snapshot.mjs';
import { acquireLock, releaseLock } from './lock.mjs';
import { atomicApplyWrite } from './atomic-write.mjs';
import { atomicApplyDelete } from './atomic-delete.mjs';
import { checkOpTargetsInManifest } from './apply-manifest-check.mjs';

/** @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic */

/** Stable diagnostic phase tag for this module's own findings. */
const PHASE = 'accept';

/**
 * @typedef {Object} AcceptResult
 * @property {boolean} ok                  true on a clean dry-run preview or a successful apply.
 * @property {boolean} refused             true when validation/staleness refused (no write/lock).
 * @property {boolean} dryRun              true for the preview path; false for the apply path.
 * @property {string|null} name            the validated skill name, null on early refusal.
 * @property {string|null} skillPath       absolute skills/<name>/SKILL.md, null on early refusal.
 * @property {string|null} proposalId      the chosen SKILL.proposed-<ts>.md leaf, null early.
 * @property {string|null} proposalPath    absolute proposal file, null early.
 * @property {string|null} sourceSha256    hex sha256 of the current SKILL.md bytes (null if absent/unread).
 * @property {string|null} proposedSha256  hex sha256 of the proposal bytes.
 * @property {boolean} stale               true when SKILL.md drifted from the recorded source.
 * @property {boolean} provenanceFound     true when the provenance record was read.
 * @property {boolean} forced              true when --force was supplied.
 * @property {string|null} snapshotId      the pre-overwrite snapshot id (--apply, on success).
 * @property {boolean} manifestChecked     true when the manifest backstop passed (--apply).
 * @property {boolean} overwritten         true when SKILL.md now holds the proposal bytes.
 * @property {boolean} proposalRemoved     true when the accepted proposal was deleted (best-effort).
 * @property {boolean} provenanceRemoved   true when the provenance record was deleted (best-effort).
 * @property {{acquired:boolean, reason?:string}|null} lock  the apply-lock outcome (--apply only).
 * @property {Diagnostic[]} diagnostics    this module's findings + any from the primitives.
 */

/** Default seams; overridable for hermetic tests. */
const DEFAULT_SEAMS = Object.freeze({
  readFileFn: (p) => readFileSync(p),          // returns a Buffer (binary-safe)
  lstatFn: (p) => lstatSync(p),
  readdirFn: (p) => readdirSync(p),
  snapshotFn: createSnapshot,
  manifestCheckFn: checkOpTargetsInManifest,
  atomicWriteFn: atomicApplyWrite,
  atomicDeleteFn: atomicApplyDelete,
  acquireLockFn: acquireLock,
  releaseLockFn: releaseLock,
  unlinkFn: (p) => unlinkSync(p),
});

/** sha256 hex of a Buffer/string. */
function sha256Hex(buf) { return createHash('sha256').update(buf).digest('hex'); }

/**
 * Build an AcceptResult, defaulting every field so callers always get the full shape
 * (no undefined). `diagnostics` is written LAST from the bag.
 * @param {Partial<AcceptResult>} fields @param {DiagnosticBag} bag @returns {AcceptResult}
 */
function buildResult(fields, bag) {
  const defaults = {
    ok: false, refused: false, dryRun: false,
    name: null, skillPath: null, proposalId: null, proposalPath: null,
    sourceSha256: null, proposedSha256: null, stale: false, provenanceFound: false, forced: false,
    snapshotId: null, manifestChecked: false, overwritten: false,
    proposalRemoved: false, provenanceRemoved: false, lock: null,
  };
  return { ...defaults, ...fields, diagnostics: bag.all() };
}

/** Add an error diagnostic and return a refused AcceptResult carrying known fields. */
function refuse(bag, code, message, fields) {
  bag.add({ severity: 'error', code, message, phase: PHASE });
  return buildResult({ refused: true, ...fields }, bag);
}

/** Merge caller seams over the production defaults so a partial override keeps the rest. */
function resolveSeams(seams) {
  const s = seams && typeof seams === 'object' ? seams : {};
  const out = {};
  for (const k of Object.keys(DEFAULT_SEAMS)) {
    out[k] = typeof s[k] === 'function' ? s[k] : DEFAULT_SEAMS[k];
  }
  return out;
}

/**
 * The --apply write sequence (design §5): lock → snapshot(skipSecretFilter) →
 * manifest backstop → atomicApplyWrite('accept') → best-effort delete proposal +
 * provenance → release. Never throws. `base` carries the shared select+stale fields.
 * @param {object} a @returns {Promise<AcceptResult>}
 */
async function applyAccept(a) {
  const { sel, stale, targetClaudeDir, mgrStateDir, assertWritable, reason, pid, now, seams, base, bag } = a;
  const lockPid = Number.isInteger(pid) ? pid : process.pid;
  const acq = seams.acquireLockFn({ stateDir: mgrStateDir, assertWritable, pid: lockPid, now });
  for (const d of acq.diagnostics ?? []) bag.add(d);
  if (!acq.acquired) {
    bag.add({ severity: 'error', code: 'accept-lock-failed', phase: PHASE,
      message: `could not acquire the apply lock (${acq.reason ?? 'unknown'}); another apply may be running` });
    return buildResult({ ...base, refused: true, lock: { acquired: false, reason: acq.reason } }, bag);
  }
  try {
    return await runAccept({ sel, stale, targetClaudeDir, mgrStateDir, assertWritable, reason, now, seams, base, bag });
  } finally {
    const rel = seams.releaseLockFn({ stateDir: mgrStateDir, pid: lockPid });
    for (const d of rel?.diagnostics ?? []) bag.add(d);
  }
}

/**
 * Snapshot → manifest backstop → write → best-effort cleanup. Assumes the lock is
 * held (released by the caller's finally). Never throws. Extracted to keep applyAccept
 * + acceptProposal under the function-SLOC limit.
 * @param {object} a @returns {Promise<AcceptResult>}
 */
async function runAccept(a) {
  const { sel, stale, targetClaudeDir, mgrStateDir, assertWritable, reason, now, seams, base, bag } = a;
  const lockOk = { acquired: true };
  const snapReason = typeof reason === 'string' && reason.length > 0
    ? reason : 'accept ' + sel.name + ' ' + sel.ts;

  // 3. Pre-overwrite snapshot (the undo point). skipSecretFilter:true so SKILL.md /
  //    the proposal are captured byte-identical even if they sniff as secret.
  const snap = await seams.snapshotFn({ targetClaudeDir, mgrStateDir, reason: snapReason,
    skipSecretFilter: true, assertWritable, now });
  for (const d of snap.diagnostics ?? []) bag.add(d);
  if (!snap.ok) {
    return refuse(bag, 'accept-snapshot-failed',
      'the pre-overwrite snapshot did not succeed; refusing to overwrite without an undo point',
      { ...base, stale, lock: lockOk });
  }

  // 4. Manifest backstop: BOTH the SKILL.md overwrite AND the proposal delete target
  //    must be captured in the snapshot manifest, else abort with NO mutation.
  const plan = { ops: [
    { kind: 'overwrite', target: sel.skillPath },
    { kind: 'delete', target: sel.proposalPath },
  ] };
  const mc = seams.manifestCheckFn(plan, { manifestPath: snap.manifestPath },
    targetClaudeDir, seams.readFileFn, bag);
  if (!mc.ok) {
    return refuse(bag, 'accept-target-not-snapshotted', mc.message ?? 'a target is not captured in the snapshot',
      { ...base, stale, snapshotId: snap.snapshotId, lock: lockOk });
  }

  // 5. Overwrite SKILL.md with the proposal bytes under the 'accept' gate context.
  const wr = await seams.atomicWriteFn({ target: sel.skillPath, content: sel.proposedBuf,
    assertWritable, context: 'accept' });
  for (const d of wr.diagnostics ?? []) bag.add(d);
  if (!wr.ok) {
    bag.add({ severity: 'error', code: 'accept-write-failed', phase: PHASE,
      message: `could not overwrite ${sel.skillPath} (the snapshot ${snap.snapshotId} is the undo point)` });
    return buildResult({ ...base, stale, snapshotId: snap.snapshotId, manifestChecked: true, lock: lockOk }, bag);
  }

  // 6+7. BEST-EFFORT cleanups — never flip the landed overwrite to failed.
  const cleanup = await bestEffortCleanup({ sel, mgrStateDir, assertWritable, seams, bag });

  bag.add({ severity: 'info', code: 'accept-applied', phase: PHASE,
    message: `accepted ${sel.proposalId} onto ${sel.skillPath}; reversible via rollback ${snap.snapshotId}` });
  return buildResult({
    ...base, ok: true, stale, snapshotId: snap.snapshotId, manifestChecked: true, overwritten: true,
    proposalRemoved: cleanup.proposalRemoved, provenanceRemoved: cleanup.provenanceRemoved, lock: lockOk,
  }, bag);
}

/**
 * Delete the accepted proposal (via the 'accept' gate) + its provenance record (via
 * the .mgr-state passthrough), both BEST-EFFORT: a failure is a visible warn that does
 * NOT fail the accept (SKILL.md is already updated). Never throws.
 * @param {object} a @returns {Promise<{proposalRemoved:boolean, provenanceRemoved:boolean}>}
 */
async function bestEffortCleanup(a) {
  const { sel, mgrStateDir, assertWritable, seams, bag } = a;
  let proposalRemoved = false;
  let provenanceRemoved = false;

  const del = await seams.atomicDeleteFn({ target: sel.proposalPath, assertWritable, context: 'accept' });
  for (const d of del.diagnostics ?? []) bag.add(d);
  if (del.ok) proposalRemoved = true;
  else bag.add({ severity: 'warn', code: 'accept-proposal-cleanup-failed', phase: PHASE, path: sel.proposalPath,
    message: 'SKILL.md was updated but the accepted proposal file could not be removed (a harmless duplicate remains)' });

  // Provenance record (.mgr-state passthrough = 'apply' context). Gate then unlink.
  const provPath = sel.provenancePath;
  if (typeof provPath === 'string' && provPath.length > 0) {
    try {
      assertWritable(provPath, 'apply');
      seams.unlinkFn(provPath);
      provenanceRemoved = true;
    } catch (e) {
      if (!(e && e.code === 'ENOENT')) {
        bag.add({ severity: 'warn', code: 'accept-provenance-cleanup-failed', phase: PHASE, path: provPath,
          message: `the provenance record could not be removed: ${errMsg(e)}` });
      } else {
        provenanceRemoved = true; // already gone — nothing to clean up
      }
    }
  }
  return { proposalRemoved, provenanceRemoved };
}

/**
 * Accept a skill proposal (`skill accept <name> [<proposalId>] [--force] [--apply]`).
 * Validates name, selects the proposal, runs the stale guard, and either previews
 * (dry-run, the DEFAULT — writes nothing) or performs the governed overwrite +
 * cleanup under a pre-overwrite snapshot. NEVER throws; every failure is a Diagnostic
 * + a full-shape `{ ok:false }` AcceptResult.
 *
 * @param {object} opts
 * @param {string}  opts.name                            the skill name
 * @param {string}  [opts.proposalId]                    the proposal id (full leaf or bare ts)
 * @param {string}  opts.targetClaudeDir                 absolute governed dir
 * @param {string}  opts.mgrStateDir                     absolute .mgr-state dir
 * @param {(p:string,ctx:string)=>string} [opts.assertWritable]  gate; REQUIRED for --apply
 * @param {boolean} [opts.enableWrites]                  true = perform the accept; false/absent = dry-run
 * @param {boolean} [opts.force]                         skip ONLY the staleness check
 * @param {string}  [opts.reason]                        snapshot reason
 * @param {number}  [opts.pid]                           lock pid
 * @param {() => Date} [opts.now]                        clock injection
 * @param {object}  [opts.seams]                         { readFileFn, lstatFn, readdirFn, snapshotFn, manifestCheckFn, atomicWriteFn, atomicDeleteFn, acquireLockFn, releaseLockFn, unlinkFn }
 * @returns {Promise<AcceptResult>}
 */
export async function acceptProposal(opts) {
  const bag = new DiagnosticBag();
  try {
    const o = opts && typeof opts === 'object' ? opts : {};
    const { name, proposalId, targetClaudeDir, mgrStateDir, assertWritable, reason, pid } = o;
    const enableWrites = o.enableWrites === true;
    const force = o.force === true;
    const now = typeof o.now === 'function' ? o.now : () => new Date();
    const seams = resolveSeams(o.seams);

    // 0. Arg shape — targetClaudeDir/mgrStateDir required for both paths.
    if (typeof targetClaudeDir !== 'string' || targetClaudeDir.length === 0) {
      return refuse(bag, 'accept-bad-args', 'targetClaudeDir must be a non-empty string', {});
    }
    if (typeof mgrStateDir !== 'string' || mgrStateDir.length === 0) {
      return refuse(bag, 'accept-bad-args', 'mgrStateDir must be a non-empty string', {});
    }

    // 1. Select the proposal + read its bytes (§4 matrix up to the read). These
    //    refusals fire on BOTH paths — they prevent even building a coherent preview.
    const sel = selectProposal({ name, proposalId, targetClaudeDir, seams });
    if ('refusal' in sel) return refuse(bag, sel.refusal.code, sel.refusal.message,
      { name: typeof name === 'string' ? name : null });

    // 2. Stale guard verdict (read-only). The provenancePath is attached to sel for cleanup.
    const verdict = staleGuard({ name: sel.name, ts: sel.ts, skillPath: sel.skillPath,
      skillMdExists: sel.skillMdExists, mgrStateDir, seams });
    sel.provenancePath = verdict.provenancePath;
    const proposedSha256 = sha256Hex(sel.proposedBuf);
    const base = {
      name: sel.name, skillPath: sel.skillPath, proposalId: sel.proposalId, proposalPath: sel.proposalPath,
      sourceSha256: verdict.sourceSha256, proposedSha256,
      stale: verdict.stale, provenanceFound: verdict.provenanceFound, forced: force,
    };

    // 3a. DRY-RUN (default): preview only — surface the stale/provenance verdict, write
    //     NOTHING (no gate/lock/snapshot). A stale / missing-provenance dry-run WITHOUT
    //     --force still PREVIEWS but notes it would refuse on --apply.
    if (!enableWrites) return previewAccept({ base, verdict, force, sel, bag });

    // 3b. APPLY: require the gate.
    if (typeof assertWritable !== 'function') {
      return refuse(bag, 'accept-bad-args',
        'assertWritable (the governed-write gate) must be injected to --apply an accept', { ...base });
    }
    // Stale / no-provenance refuse on --apply unless --force.
    if (!force) {
      if (!verdict.provenanceFound) {
        return refuse(bag, 'accept-no-provenance',
          'no provenance record to verify staleness against; re-run with --force to accept anyway', { ...base });
      }
      if (verdict.stale) {
        return refuse(bag, 'accept-stale',
          'the current SKILL.md has drifted from the proposal source; re-run with --force to accept anyway', { ...base });
      }
    }
    return await applyAccept({ sel, stale: verdict.stale, targetClaudeDir, mgrStateDir,
      assertWritable, reason, pid, now, seams, base, bag });
  } catch (e) {
    bag.add({ severity: 'error', code: 'accept-unexpected-error', phase: PHASE,
      message: `unexpected error during accept: ${errMsg(e)}` });
    return buildResult({}, bag);
  }
}

/**
 * Dry-run preview: write nothing, surface the selected proposal + stale verdict. A
 * stale / missing-provenance preview without --force notes it WOULD refuse on --apply
 * (but does not refuse here — dry-run is a safe read). Never throws.
 * @param {object} a @returns {AcceptResult}
 */
function previewAccept(a) {
  const { base, verdict, force, sel, bag } = a;
  const blocked = !force && (!verdict.provenanceFound || verdict.stale);
  const note = blocked
    ? (!verdict.provenanceFound
        ? ' (no provenance record — --apply would refuse accept-no-provenance without --force)'
        : ' (SKILL.md has drifted — --apply would refuse accept-stale without --force)')
    : '';
  bag.add({ severity: 'info', code: 'accept-dry-run', phase: PHASE,
    message: `would overwrite ${sel.skillPath} with ${sel.proposalId}; re-run with --apply${note}` });
  return buildResult({ ...base, ok: true, dryRun: true, wouldOverwrite: true }, bag);
}
