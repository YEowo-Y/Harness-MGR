/**
 * P3.U17 — test/rollback.test.mjs
 *
 * Hermetic unit tests for the rollback orchestrator (src/ops/rollback.mjs). Every
 * sub-unit (drift-check / verify / restore / acquire / release) is injected as a
 * stub via `seams`, so NO real fs / lock / tar is touched. The oracles are
 * falsifiable: each pins a specific status + code + which seams were (not) called,
 * so a regression that wires the flow wrong (e.g. restores under drift, or forgets
 * to release the lock) turns a test red.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { rollbackSnapshot } from '../src/ops/rollback.mjs';

const SID = '2026-05-31T12-00-00Z';
const DIR = '/abs/.mgr-state';
const TGT = '/abs/.claude';
const GATE = (p) => p; // passthrough write gate

/** A call-recording stub factory. Returns { fn, calls }. */
function spy(impl) {
  const calls = [];
  const fn = (...args) => { calls.push(args); return impl ? impl(...args) : undefined; };
  return { fn, calls };
}

/** Default "happy" sub-unit results. */
const driftClean = () => ({ ok: true, clean: true, snapshotId: SID, targetClaudeDir: TGT, changes: [], diagnostics: [] });
const driftDirty = () => ({ ok: true, clean: false, snapshotId: SID, targetClaudeDir: TGT,
  changes: [{ path: 'CLAUDE.md', kind: 'modified', expected: 'a', actual: 'b' }], diagnostics: [] });
const verifyOk = () => ({ ok: true, verified: true, snapshotId: SID, fileCount: 3, verifiedCount: 3, mismatches: [], diagnostics: [] });
const restoreOk = () => ({ ok: true, restored: true, snapshotId: SID, targetClaudeDir: TGT,
  fileCount: 3, restoredCount: 3, skipped: [], leftovers: null, diagnostics: [] });

/** Build a seams bundle from per-seam impls (defaults to the happy path). */
function seamsOf({ drift = driftClean, verify = verifyOk, restore = restoreOk, acquire, release } = {}) {
  const acquireImpl = acquire ?? (() => ({ acquired: true, diagnostics: [] }));
  const releaseImpl = release ?? (() => ({ released: true, diagnostics: [] }));
  const s = {
    driftFn: spy(drift), verifyFn: spy(verify), restoreFn: spy(restore),
    acquireFn: spy(acquireImpl), releaseFn: spy(releaseImpl),
  };
  return {
    seams: {
      driftFn: s.driftFn.fn, verifyFn: s.verifyFn.fn, restoreFn: s.restoreFn.fn,
      acquireFn: s.acquireFn.fn, releaseFn: s.releaseFn.fn,
    },
    spies: s,
  };
}

function hasCode(res, code) {
  return res.diagnostics.some((d) => d.code === code);
}

// ── DRY-RUN (default) ────────────────────────────────────────────────────────

test('dry-run clean: drift clean + verify ok → status dry-run, ok, code 0, no write', async () => {
  const { seams, spies } = seamsOf();
  const res = await rollbackSnapshot({ mgrStateDir: DIR, targetClaudeDir: TGT, snapshotId: SID, seams });

  assert.equal(res.status, 'dry-run');
  assert.equal(res.ok, true);
  assert.equal(res.code, 0);
  assert.equal(res.dryRun, true);
  assert.equal(res.snapshotId, SID);
  assert.equal(res.lock.acquired, false);
  assert.ok(hasCode(res, 'rollback-writes-disabled'), 'dry-run info present');
  // The restore + lock seams must NEVER be touched on a dry-run.
  assert.equal(spies.restoreFn.calls.length, 0, 'restoreFn must NOT be called');
  assert.equal(spies.acquireFn.calls.length, 0, 'acquireFn must NOT be called');
  assert.equal(spies.releaseFn.calls.length, 0, 'releaseFn must NOT be called');
  // drift + verify DID run (the preview).
  assert.equal(spies.driftFn.calls.length, 1);
  assert.equal(spies.verifyFn.calls.length, 1);
});

test('dry-run with drift (no force): status refused-drift, code 3, restore never called', async () => {
  const { seams, spies } = seamsOf({ drift: driftDirty });
  const res = await rollbackSnapshot({ mgrStateDir: DIR, targetClaudeDir: TGT, snapshotId: SID, seams });

  assert.equal(res.status, 'refused-drift');
  assert.equal(res.code, 3);
  assert.equal(res.ok, false);
  assert.equal(res.dryRun, true);
  assert.equal(res.drift.clean, false);
  assert.ok(hasCode(res, 'rollback-refused-drift'));
  assert.equal(spies.restoreFn.calls.length, 0);
  // verify must be SKIPPED once drift refuses (no point verifying).
  assert.equal(spies.verifyFn.calls.length, 0, 'verify skipped after drift refusal');
});

test('dry-run drift-error: drift could not run → status drift-error, code 1', async () => {
  const { seams, spies } = seamsOf({ drift: () => ({ ok: false, clean: false, snapshotId: SID, changes: [], diagnostics: [] }) });
  const res = await rollbackSnapshot({ mgrStateDir: DIR, targetClaudeDir: TGT, snapshotId: SID, seams });

  assert.equal(res.status, 'drift-error');
  assert.equal(res.code, 1);
  assert.equal(res.ok, false);
  assert.equal(spies.verifyFn.calls.length, 0);
  assert.equal(spies.restoreFn.calls.length, 0);
});

test('dry-run archive corrupt: verify not verified → status archive-corrupt, code 4', async () => {
  const { seams, spies } = seamsOf({ verify: () => ({ ok: true, verified: false, snapshotId: SID, fileCount: 3, verifiedCount: 2, mismatches: [{ path: 'x', kind: 'hash-mismatch', expected: 'a', actual: 'b' }], diagnostics: [] }) });
  const res = await rollbackSnapshot({ mgrStateDir: DIR, targetClaudeDir: TGT, snapshotId: SID, seams });

  assert.equal(res.status, 'archive-corrupt');
  assert.equal(res.code, 4);
  assert.equal(res.ok, false);
  assert.ok(hasCode(res, 'rollback-archive-corrupt'));
  assert.equal(spies.restoreFn.calls.length, 0);
});

// ── --apply ───────────────────────────────────────────────────────────────────

test('--apply happy: drift clean + verify ok + restore ok → status restored, ok, code 0', async () => {
  const { seams, spies } = seamsOf();
  const res = await rollbackSnapshot({
    mgrStateDir: DIR, targetClaudeDir: TGT, snapshotId: SID, assertWritable: GATE,
    enableWrites: true, expectedTarget: TGT, pid: 4242, seams,
  });

  assert.equal(res.status, 'restored');
  assert.equal(res.ok, true);
  assert.equal(res.code, 0);
  assert.equal(res.dryRun, false);
  assert.equal(res.lock.acquired, true);
  assert.ok(res.restore, 'restore result carried');

  // acquire called with the pid + gate.
  assert.equal(spies.acquireFn.calls.length, 1);
  const acqArg = spies.acquireFn.calls[0][0];
  assert.equal(acqArg.pid, 4242);
  assert.equal(acqArg.assertWritable, GATE);
  assert.equal(acqArg.stateDir, DIR);

  // restore called with the right wiring (the headline contract).
  assert.equal(spies.restoreFn.calls.length, 1);
  const rArg = spies.restoreFn.calls[0][0];
  assert.equal(rArg.snapshotId, SID);
  assert.equal(rArg.targetClaudeDir, TGT);
  assert.equal(rArg.assertWritable, GATE);
  assert.equal(rArg.expectedTarget, TGT);

  // release called with the SAME pid.
  assert.equal(spies.releaseFn.calls.length, 1);
  assert.equal(spies.releaseFn.calls[0][0].pid, 4242);
});

test('--apply drift refused (no force): restore NEVER called, lock STILL acquired+released', async () => {
  const { seams, spies } = seamsOf({ drift: driftDirty });
  const res = await rollbackSnapshot({
    mgrStateDir: DIR, targetClaudeDir: TGT, snapshotId: SID, assertWritable: GATE, enableWrites: true, seams,
  });

  assert.equal(res.status, 'refused-drift');
  assert.equal(res.code, 3);
  assert.equal(res.ok, false);
  assert.equal(res.lock.acquired, true, 'preflight runs UNDER the lock, so the lock was acquired');
  assert.equal(spies.restoreFn.calls.length, 0, 'restore must not run on drift refusal');
  // The lock MUST still be released even though we refused.
  assert.equal(spies.acquireFn.calls.length, 1);
  assert.equal(spies.releaseFn.calls.length, 1, 'lock released in the finally');
});

test('--apply drift + force: drift dirty but force:true → proceeds to verify + restore', async () => {
  const { seams, spies } = seamsOf({ drift: driftDirty });
  const res = await rollbackSnapshot({
    mgrStateDir: DIR, targetClaudeDir: TGT, snapshotId: SID, assertWritable: GATE,
    enableWrites: true, force: true, seams,
  });

  assert.equal(res.status, 'restored');
  assert.equal(res.ok, true);
  assert.equal(spies.verifyFn.calls.length, 1, 'force lets the flow reach verify');
  assert.equal(spies.restoreFn.calls.length, 1, 'force lets the flow reach restore');
  assert.equal(spies.releaseFn.calls.length, 1);
});

test('--apply archive corrupt: verify not verified → archive-corrupt code 4, restore never called, lock released', async () => {
  const { seams, spies } = seamsOf({ verify: () => ({ ok: true, verified: false, snapshotId: SID, fileCount: 1, verifiedCount: 0, mismatches: [{ path: 'x', kind: 'missing', expected: 'a', actual: null }], diagnostics: [] }) });
  const res = await rollbackSnapshot({
    mgrStateDir: DIR, targetClaudeDir: TGT, snapshotId: SID, assertWritable: GATE, enableWrites: true, seams,
  });

  assert.equal(res.status, 'archive-corrupt');
  assert.equal(res.code, 4);
  assert.equal(res.ok, false);
  assert.equal(res.lock.acquired, true);
  assert.equal(spies.restoreFn.calls.length, 0, 'corrupt archive must never reach the write');
  assert.equal(spies.releaseFn.calls.length, 1, 'lock released after abort');
});

test('--apply lock fail: acquire {acquired:false} → status lock-failed, code 3, restore + release never called', async () => {
  const { seams, spies } = seamsOf({ acquire: () => ({ acquired: false, reason: 'held', diagnostics: [] }) });
  const res = await rollbackSnapshot({
    mgrStateDir: DIR, targetClaudeDir: TGT, snapshotId: SID, assertWritable: GATE, enableWrites: true, seams,
  });

  assert.equal(res.status, 'lock-failed');
  assert.equal(res.code, 3);
  assert.equal(res.ok, false);
  assert.equal(res.lock.acquired, false);
  assert.equal(res.lock.reason, 'held');
  assert.ok(hasCode(res, 'rollback-lock-failed'));
  // We never acquired → never run drift/verify/restore, and NEVER release.
  assert.equal(spies.driftFn.calls.length, 0, 'no preflight without the lock');
  assert.equal(spies.restoreFn.calls.length, 0);
  assert.equal(spies.releaseFn.calls.length, 0, 'never release a lock we did not acquire');
});

test('--apply restore incomplete: restore {ok:true, restored:false} → restore-incomplete, ok false, code 1, lock released', async () => {
  const { seams, spies } = seamsOf({ restore: () => ({ ok: true, restored: false, snapshotId: SID, targetClaudeDir: TGT,
    fileCount: 3, restoredCount: 1, skipped: [{ path: 'x', reason: 'verify-mismatch' }], leftovers: null, diagnostics: [] }) });
  const res = await rollbackSnapshot({
    mgrStateDir: DIR, targetClaudeDir: TGT, snapshotId: SID, assertWritable: GATE, enableWrites: true, seams,
  });

  assert.equal(res.status, 'restore-incomplete');
  assert.equal(res.ok, false);
  assert.equal(res.code, 1);
  assert.equal(res.lock.acquired, true);
  assert.ok(res.restore, 'restore result carried');
  assert.equal(res.restore.restored, false);
  assert.ok(hasCode(res, 'rollback-restore-incomplete'));
  assert.equal(spies.releaseFn.calls.length, 1);
});

test('--apply reclaimed lock surfaces lock.reclaimed', async () => {
  const { seams } = seamsOf({ acquire: () => ({ acquired: true, reclaimed: true, diagnostics: [] }) });
  const res = await rollbackSnapshot({
    mgrStateDir: DIR, targetClaudeDir: TGT, snapshotId: SID, assertWritable: GATE, enableWrites: true, seams,
  });
  assert.equal(res.status, 'restored');
  assert.equal(res.lock.acquired, true);
  assert.equal(res.lock.reclaimed, true);
});

// ── gate / arg validation ───────────────────────────────────────────────────

test('--apply requires the gate: enableWrites + no assertWritable → bad-args, code 1, acquire never called', async () => {
  const { seams, spies } = seamsOf();
  const res = await rollbackSnapshot({ mgrStateDir: DIR, targetClaudeDir: TGT, snapshotId: SID, enableWrites: true, seams });

  assert.equal(res.status, 'bad-args');
  assert.equal(res.code, 1);
  assert.equal(res.ok, false);
  assert.ok(hasCode(res, 'rollback-bad-args'));
  assert.equal(spies.acquireFn.calls.length, 0, 'no lock taken on bad args');
});

test('bad args (missing mgrStateDir) → bad-args, nothing called', async () => {
  const { seams, spies } = seamsOf();
  const res = await rollbackSnapshot({ targetClaudeDir: TGT, snapshotId: SID, seams });

  assert.equal(res.status, 'bad-args');
  assert.equal(res.code, 1);
  assert.equal(spies.driftFn.calls.length, 0);
  assert.equal(spies.acquireFn.calls.length, 0);
});

test('bad args (missing targetClaudeDir) → bad-args', async () => {
  const { seams } = seamsOf();
  const res = await rollbackSnapshot({ mgrStateDir: DIR, snapshotId: SID, seams });
  assert.equal(res.status, 'bad-args');
});

test('non-object opts → bad-args (never throws)', async () => {
  const res = await rollbackSnapshot(undefined);
  assert.equal(res.status, 'bad-args');
  assert.equal(res.code, 1);
  assert.ok(Array.isArray(res.diagnostics));
});

// ── never-throws ────────────────────────────────────────────────────────────

test('never-throws: a thrown driftFn → status error, code 1 + diagnostic (no throw)', async () => {
  const drift = () => { throw new Error('boom in drift'); };
  const { seams, spies } = seamsOf({ drift });
  const res = await rollbackSnapshot({ mgrStateDir: DIR, targetClaudeDir: TGT, snapshotId: SID, seams });

  assert.equal(res.status, 'error');
  assert.equal(res.code, 1);
  assert.equal(res.ok, false);
  assert.ok(hasCode(res, 'rollback-unexpected-error'));
  assert.ok(res.diagnostics.some((d) => /boom in drift/.test(d.message)));
  assert.equal(spies.restoreFn.calls.length, 0);
});

test('lock release on throw: enableWrites + acquire ok + restore THROWS → error, release STILL called', async () => {
  const restore = () => { throw new Error('boom in restore'); };
  const { seams, spies } = seamsOf({ restore });
  const res = await rollbackSnapshot({
    mgrStateDir: DIR, targetClaudeDir: TGT, snapshotId: SID, assertWritable: GATE, enableWrites: true, pid: 99, seams,
  });

  assert.equal(res.status, 'error');
  assert.equal(res.code, 1);
  assert.ok(hasCode(res, 'rollback-unexpected-error'));
  // The lock was acquired before the throw → the finally MUST have released it.
  assert.equal(spies.acquireFn.calls.length, 1);
  assert.equal(spies.releaseFn.calls.length, 1, 'finally releases the lock even on a thrown restore');
  assert.equal(spies.releaseFn.calls[0][0].pid, 99, 'released with the same pid');
});

test('never-throws: a thrown acquireFn (enableWrites) → error, no release (never acquired)', async () => {
  const acquire = () => { throw new Error('boom in acquire'); };
  const { seams, spies } = seamsOf({ acquire });
  const res = await rollbackSnapshot({
    mgrStateDir: DIR, targetClaudeDir: TGT, snapshotId: SID, assertWritable: GATE, enableWrites: true, seams,
  });
  assert.equal(res.status, 'error');
  assert.equal(res.code, 1);
  // acquire threw → the lock was never held → release must NOT run.
  assert.equal(spies.releaseFn.calls.length, 0, 'no release when acquire itself threw');
});

// ── diagnostics aggregation ───────────────────────────────────────────────────

test('aggregates sub-unit diagnostics from drift + verify + restore', async () => {
  const drift = () => ({ ok: true, clean: true, snapshotId: SID, targetClaudeDir: TGT, changes: [],
    diagnostics: [{ severity: 'info', code: 'from-drift', message: 'd' }] });
  const verify = () => ({ ok: true, verified: true, snapshotId: SID, fileCount: 1, verifiedCount: 1, mismatches: [],
    diagnostics: [{ severity: 'info', code: 'from-verify', message: 'v' }] });
  const restore = () => ({ ok: true, restored: true, snapshotId: SID, targetClaudeDir: TGT, fileCount: 1, restoredCount: 1, skipped: [], leftovers: null,
    diagnostics: [{ severity: 'info', code: 'from-restore', message: 'r' }] });
  const { seams } = seamsOf({ drift, verify, restore });
  const res = await rollbackSnapshot({
    mgrStateDir: DIR, targetClaudeDir: TGT, snapshotId: SID, assertWritable: GATE, enableWrites: true, seams,
  });
  assert.equal(res.status, 'restored');
  assert.ok(hasCode(res, 'from-drift'));
  assert.ok(hasCode(res, 'from-verify'));
  assert.ok(hasCode(res, 'from-restore'));
});

test('expectedTarget defaults to targetClaudeDir when omitted (forwarded to drift + verify)', async () => {
  const { seams, spies } = seamsOf();
  await rollbackSnapshot({ mgrStateDir: DIR, targetClaudeDir: TGT, snapshotId: SID, assertWritable: GATE, enableWrites: true, seams });
  assert.equal(spies.driftFn.calls[0][0].expectedTarget, TGT);
  assert.equal(spies.verifyFn.calls[0][0].expectedTarget, TGT);
});

// ── LOW-2 regression: throwing releaseFn must not mask a successful restore ──

test('LOW-2: throwing releaseFn → status stays restored, ok true, rollback-lock-release-failed warn present', async () => {
  // Inject a releaseFn that throws. Before the LOW-2 fix the throw would propagate
  // out of the finally, be caught by the outer try/catch, and flip the result to
  // status:'error'. After the fix the finally wraps releaseFn in its own try/catch
  // so the successful 'restored' result is preserved and the throw surfaces as a warn.
  const { seams, spies } = seamsOf({
    release: () => { throw new Error('lock release exploded'); },
  });
  const res = await rollbackSnapshot({
    mgrStateDir: DIR, targetClaudeDir: TGT, snapshotId: SID, assertWritable: GATE, enableWrites: true, seams,
  });

  // The restore itself succeeded — that result must NOT be masked.
  assert.equal(res.status, 'restored', 'throwing releaseFn must not flip status to error');
  assert.equal(res.ok, true, 'ok must remain true');
  assert.equal(res.code, 0);
  // The throw surfaces as a warn, not silently dropped.
  assert.ok(hasCode(res, 'rollback-lock-release-failed'), 'rollback-lock-release-failed warn must be present');
  assert.ok(
    res.diagnostics.some((d) => d.code === 'rollback-lock-release-failed' && d.severity === 'warn'),
    'must be severity warn',
  );
  // The acquire still ran (sanity).
  assert.equal(spies.acquireFn.calls.length, 1);
});
