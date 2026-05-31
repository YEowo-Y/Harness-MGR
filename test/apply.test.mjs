/**
 * P3.U12 — apply.test.mjs (orchestrator unit tests, fully hermetic).
 *
 * Drives applyPlan with INJECTED seams (acquireFn / releaseFn / createSnapshotFn
 * / createJournalFn / transitionFn / writeJournalFn) so NO real lock, snapshot,
 * or fs is touched. The assertions prove the WIRING + the DoD invariants:
 *   - happy path drives the journal planned→snapshotted ONLY and STOPS (ok:true,
 *     state 'snapshotted', applied:false, an apply-writes-disabled INFO present);
 *   - the DoD pin: transitionFn is NEVER called with 'applying';
 *   - the SAME pid flows into acquireFn AND releaseFn;
 *   - a held lock → ok:false, no snapshot, no release (we never acquired it);
 *   - a snapshot failure / journal-write failure → ok:false with the right code;
 *   - assertWritable is REQUIRED (absent → ok:false, lock never acquired);
 *   - never-throws on a throwing seam + on garbage input.
 *
 * The real-fs end-to-end oracle (writes-nothing-to-governed-config) lives in
 * test/integration/apply-roundtrip.test.mjs.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { applyPlan } from '../src/ops/apply.mjs';
import { transition, createJournal } from '../src/ops/apply-journal-writer.mjs';

const FIXED_NOW = () => new Date('2026-05-30T00:00:00.000Z');
const FIXED_ID = '2026-05-30T00-00-00Z';
const STATE = 'C:\\tmp\\.mgr-state';
const TARGET = 'C:\\tmp\\.claude';
const PASS = (p) => p; // passthrough write gate

/** A minimal valid Plan with one patch op (it is never applied — writes disabled). */
function makePlan() {
  return {
    planVersion: 1,
    command: 'config set',
    ops: [{ kind: 'patch', target: `${TARGET}\\settings.json`, summary: 'set model', pointer: '/model', before: 'sonnet', after: 'opus' }],
    apply: true,
  };
}

/** A Plan with `ops` exactly as given (writable-kind matrix for enableWrites). */
function planWith(ops) {
  return { planVersion: 1, command: 'config set', ops, apply: true };
}

/** A single create/overwrite op writing CONTENT to a settings.json target. */
function writeOp(kind, content = '{"model":"opus"}\n') {
  return { kind, target: `${TARGET}\\settings.json`, summary: `${kind} settings`, content };
}

/** A recording acquireLock seam. */
function makeAcquire(result = { acquired: true }) {
  const calls = [];
  const fn = (opts) => { calls.push(opts); return { diagnostics: [], ...result }; };
  fn.calls = calls;
  return fn;
}

/** A recording releaseLock seam. */
function makeRelease(result = { released: true }) {
  const calls = [];
  const fn = (opts) => { calls.push(opts); return { diagnostics: [], ...result }; };
  fn.calls = calls;
  return fn;
}

/** A recording createSnapshot seam (async). */
function makeSnapshot(result = {}) {
  const calls = [];
  const fn = (opts) => {
    calls.push(opts);
    if (result.throw) return Promise.reject(result.throw);
    return Promise.resolve({
      ok: true, snapshotId: FIXED_ID,
      snapshotDir: `${STATE}\\snapshots\\${FIXED_ID}`,
      archivePath: `${STATE}\\snapshots\\${FIXED_ID}\\files.tar`,
      manifestPath: `${STATE}\\snapshots\\${FIXED_ID}\\manifest.json`,
      kept: [], dropped: [], fileCount: 0, diagnostics: [],
      ...result,
    });
  };
  fn.calls = calls;
  return fn;
}

/** A recording createJournal seam (pure). */
function makeCreateJournal(result = {}) {
  const calls = [];
  const fn = (opts) => {
    calls.push(opts);
    if ('journal' in result) return { journal: result.journal, diagnostics: result.diagnostics ?? [] };
    return { journal: { state: 'planned', snapshotId: opts.snapshotId, ops: [] }, diagnostics: [] };
  };
  fn.calls = calls;
  return fn;
}

/** A recording transition seam (pure). Records (journal, toState). */
function makeTransition(result = {}) {
  const calls = [];
  const fn = (journal, toState) => {
    calls.push({ journal, toState });
    if (result.ok === false) return { ok: false, journal, diagnostics: result.diagnostics ?? [] };
    return { ok: true, journal: { ...journal, state: toState }, diagnostics: [] };
  };
  fn.calls = calls;
  return fn;
}

/** A recording writeJournal seam. */
function makeWriteJournal(result = {}) {
  const calls = [];
  const fn = (opts) => {
    calls.push(opts);
    if (result.written === false) return { written: false, path: null, diagnostics: result.diagnostics ?? [] };
    return { written: true, path: `${STATE}\\snapshots\\${FIXED_ID}\\apply-journal.json`, diagnostics: [] };
  };
  fn.calls = calls;
  return fn;
}

/** A recording atomicApplyWrite seam (async). Defaults to a clean successful write. */
function makeAtomicWrite(result = {}) {
  const calls = [];
  const fn = (opts) => {
    calls.push(opts);
    if (result.throw) return Promise.reject(result.throw);
    if (result.ok === false) {
      return Promise.resolve({ ok: false, wrote: false,
        leftovers: result.leftovers ?? { newPath: null, oldPath: null },
        diagnostics: result.diagnostics ?? [] });
    }
    return Promise.resolve({ ok: true, wrote: true, leftovers: { newPath: null, oldPath: null }, diagnostics: [] });
  };
  fn.calls = calls;
  return fn;
}

/** A real-state-machine transition seam (delegates to the actual transition). */
function realTransition() {
  const calls = [];
  const fn = (journal, toState, opts) => { calls.push({ journal, toState }); return transition(journal, toState, opts); };
  fn.calls = calls;
  return fn;
}

/** Bundle a full set of happy-path seams, allowing per-seam overrides. */
function happySeams(over = {}) {
  return {
    acquireFn: over.acquireFn ?? makeAcquire(),
    releaseFn: over.releaseFn ?? makeRelease(),
    createSnapshotFn: over.createSnapshotFn ?? makeSnapshot(),
    createJournalFn: over.createJournalFn ?? makeCreateJournal(),
    transitionFn: over.transitionFn ?? makeTransition(),
    writeJournalFn: over.writeJournalFn ?? makeWriteJournal(),
    atomicWriteFn: over.atomicWriteFn ?? makeAtomicWrite(),
  };
}

function baseOpts(seams, over = {}) {
  return {
    plan: makePlan(), targetClaudeDir: TARGET, mgrStateDir: STATE,
    assertWritable: PASS, reason: 'unit', now: FIXED_NOW, seams, ...over,
  };
}

// ── (1) happy path: planned→snapshotted, STOP, applied:false ────────────────────

test('applyPlan: happy path reaches snapshotted and stops (applied:false, writes-disabled info)', async () => {
  const seams = happySeams();
  const res = await applyPlan(baseOpts(seams));
  assert.equal(res.ok, true, JSON.stringify(res.diagnostics));
  assert.equal(res.state, 'snapshotted');
  assert.equal(res.applied, false);
  assert.equal(res.snapshotId, FIXED_ID);
  assert.equal(res.journalPath, `${STATE}\\snapshots\\${FIXED_ID}\\apply-journal.json`);
  assert.equal(res.manifestPath, `${STATE}\\snapshots\\${FIXED_ID}\\manifest.json`);
  assert.equal(res.archivePath, `${STATE}\\snapshots\\${FIXED_ID}\\files.tar`);
  assert.equal(res.lock.acquired, true);
  // the writes-disabled INFO diagnostic is present.
  const info = res.diagnostics.find((d) => d.code === 'apply-writes-disabled');
  assert.ok(info, 'an apply-writes-disabled info must be present');
  assert.equal(info.severity, 'info');
  // every step ran exactly once.
  assert.equal(seams.acquireFn.calls.length, 1);
  assert.equal(seams.createSnapshotFn.calls.length, 1);
  assert.equal(seams.createJournalFn.calls.length, 1);
  assert.equal(seams.writeJournalFn.calls.length, 1);
  assert.equal(seams.releaseFn.calls.length, 1);
  // createSnapshot got dryRun:false + the injected gate.
  assert.equal(seams.createSnapshotFn.calls[0].dryRun, false);
  assert.equal(seams.createSnapshotFn.calls[0].assertWritable, PASS);
  // writeJournal got the gate too.
  assert.equal(seams.writeJournalFn.calls[0].assertWritable, PASS);
});

// ── (2) DoD pin: transition reaches 'snapshotted' and NEVER 'applying' ──────────

test('applyPlan DoD: transition is called with snapshotted and NEVER applying', async () => {
  const seams = happySeams();
  const res = await applyPlan(baseOpts(seams));
  assert.equal(res.ok, true);
  const states = seams.transitionFn.calls.map((c) => c.toState);
  assert.deepEqual(states, ['snapshotted'], 'transition must be called exactly once, with snapshotted');
  assert.ok(!states.includes('applying'), 'transition must NEVER be called with applying (writes disabled)');
  // applied stays false → no governed write happened.
  assert.equal(res.applied, false);
});

// ── (3) consistent pid into acquire AND release ─────────────────────────────────

test('applyPlan: the SAME pid flows into acquireFn and releaseFn', async () => {
  const seams = happySeams();
  const res = await applyPlan(baseOpts(seams, { pid: 424242 }));
  assert.equal(res.ok, true);
  assert.equal(seams.acquireFn.calls[0].pid, 424242, 'acquire got the explicit pid');
  assert.equal(seams.releaseFn.calls[0].pid, 424242, 'release got the SAME pid');
  // and the gate + stateDir were threaded into acquire.
  assert.equal(seams.acquireFn.calls[0].assertWritable, PASS);
  assert.equal(seams.acquireFn.calls[0].stateDir, STATE);
});

// ── (4) lock held → no snapshot, no release (we never acquired it) ──────────────

test('applyPlan: a held lock → ok:false, lock.reason held, no snapshot, no release', async () => {
  const acquireFn = makeAcquire({ acquired: false, reason: 'held',
    diagnostics: [{ severity: 'error', code: 'apply-lock-held', message: 'held by pid 4242', phase: 'lock' }] });
  const seams = happySeams({ acquireFn });
  const res = await applyPlan(baseOpts(seams));
  assert.equal(res.ok, false);
  assert.equal(res.state, null);
  assert.equal(res.applied, false);
  assert.equal(res.lock.acquired, false);
  assert.equal(res.lock.reason, 'held');
  // the lock diagnostic was aggregated.
  assert.ok(res.diagnostics.some((d) => d.code === 'apply-lock-held'));
  // CRITICAL: no snapshot taken, and release NOT called (we never acquired the lock).
  assert.equal(seams.createSnapshotFn.calls.length, 0, 'no snapshot on a held lock');
  assert.equal(seams.releaseFn.calls.length, 0, 'must NOT release a lock we never acquired');
});

// ── (5) snapshot fails → ok:false, no journal write, lock IS released ────────────

test('applyPlan: a snapshot failure → ok:false + apply-snapshot-failed, no journal write, lock released', async () => {
  const createSnapshotFn = makeSnapshot({ ok: false, snapshotId: null,
    diagnostics: [{ severity: 'error', code: 'snapshot-archive-failed', message: 'tar failed', phase: 'snapshot' }] });
  const seams = happySeams({ createSnapshotFn });
  const res = await applyPlan(baseOpts(seams));
  assert.equal(res.ok, false);
  assert.equal(res.state, null);
  assert.ok(res.diagnostics.some((d) => d.code === 'snapshot-archive-failed'), 'aggregates snapshot diag');
  assert.ok(res.diagnostics.some((d) => d.code === 'apply-snapshot-failed'), 'own rollup code');
  // no journal was created/written...
  assert.equal(seams.createJournalFn.calls.length, 0);
  assert.equal(seams.writeJournalFn.calls.length, 0);
  // ...but the lock WAS released (we acquired it before the snapshot).
  assert.equal(seams.releaseFn.calls.length, 1, 'lock must be released after a snapshot failure');
});

// ── (6) journal write fails → ok:false, state snapshotted, lock released ─────────

test('applyPlan: a journal-write failure → ok:false, state snapshotted, lock released', async () => {
  const writeJournalFn = makeWriteJournal({ written: false,
    diagnostics: [{ severity: 'error', code: 'journal-write-error', message: 'gate denied', phase: 'apply' }] });
  const seams = happySeams({ writeJournalFn });
  const res = await applyPlan(baseOpts(seams));
  assert.equal(res.ok, false);
  assert.equal(res.state, 'snapshotted', 'the transition succeeded; only the persist failed');
  assert.ok(res.diagnostics.some((d) => d.code === 'journal-write-error'), 'aggregates the write diag');
  assert.ok(res.diagnostics.some((d) => d.code === 'apply-journal-write-failed'), 'own rollup code');
  // snapshot id/paths are still surfaced on the failure result.
  assert.equal(res.snapshotId, FIXED_ID);
  assert.equal(res.manifestPath, `${STATE}\\snapshots\\${FIXED_ID}\\manifest.json`);
  // lock released.
  assert.equal(seams.releaseFn.calls.length, 1);
});

// ── (6b) journal CREATE fails → ok:false, apply-journal-create-failed ────────────

test('applyPlan: a journal-create failure → ok:false + apply-journal-create-failed, lock released', async () => {
  const createJournalFn = makeCreateJournal({ journal: null,
    diagnostics: [{ severity: 'error', code: 'journal-plan-invalid', message: 'bad plan', phase: 'apply' }] });
  const seams = happySeams({ createJournalFn });
  const res = await applyPlan(baseOpts(seams));
  assert.equal(res.ok, false);
  assert.ok(res.diagnostics.some((d) => d.code === 'apply-journal-create-failed'));
  assert.equal(seams.transitionFn.calls.length, 0, 'no transition without a journal');
  assert.equal(seams.writeJournalFn.calls.length, 0);
  assert.equal(seams.releaseFn.calls.length, 1, 'lock released');
});

// ── (6c) transition fails → ok:false, apply-transition-failed ───────────────────

test('applyPlan: a transition failure → ok:false + apply-transition-failed, no journal write', async () => {
  const transitionFn = makeTransition({ ok: false,
    diagnostics: [{ severity: 'error', code: 'journal-illegal-transition', message: 'no', phase: 'apply' }] });
  const seams = happySeams({ transitionFn });
  const res = await applyPlan(baseOpts(seams));
  assert.equal(res.ok, false);
  assert.ok(res.diagnostics.some((d) => d.code === 'apply-transition-failed'));
  assert.equal(seams.writeJournalFn.calls.length, 0, 'no write after a failed transition');
  assert.equal(seams.releaseFn.calls.length, 1);
});

// ── (7) assertWritable missing → ok:false, lock NEVER acquired ──────────────────

test('applyPlan: a missing assertWritable refuses (ok:false, acquireFn NOT called)', async () => {
  const seams = happySeams();
  // omit assertWritable entirely.
  const res = await applyPlan({ plan: makePlan(), targetClaudeDir: TARGET, mgrStateDir: STATE, now: FIXED_NOW, seams });
  assert.equal(res.ok, false);
  assert.equal(res.lock.acquired, false);
  assert.equal(res.diagnostics[0].code, 'apply-bad-args');
  assert.match(res.diagnostics[0].message, /assertWritable/);
  // CRITICAL: we refused BEFORE acquiring a lock.
  assert.equal(seams.acquireFn.calls.length, 0, 'no lock acquired without a write gate');
});

// ── (8) bad args (plan / dirs) ──────────────────────────────────────────────────

test('applyPlan: a non-object plan → apply-bad-args, no lock', async () => {
  const seams = happySeams();
  const res = await applyPlan(baseOpts(seams, { plan: 'not-a-plan' }));
  assert.equal(res.ok, false);
  assert.equal(res.diagnostics[0].code, 'apply-bad-args');
  assert.equal(seams.acquireFn.calls.length, 0);
});

test('applyPlan: empty targetClaudeDir / mgrStateDir → apply-bad-args', async () => {
  const a = await applyPlan(baseOpts(happySeams(), { targetClaudeDir: '' }));
  assert.equal(a.ok, false);
  assert.equal(a.diagnostics[0].code, 'apply-bad-args');
  const b = await applyPlan(baseOpts(happySeams(), { mgrStateDir: '' }));
  assert.equal(b.ok, false);
  assert.equal(b.diagnostics[0].code, 'apply-bad-args');
});

// ── (9) never-throws ────────────────────────────────────────────────────────────

test('applyPlan: a throwing createSnapshotFn → ok:false + apply-unexpected-error (never throws)', async () => {
  const createSnapshotFn = makeSnapshot({ throw: new Error('boom') });
  const seams = happySeams({ createSnapshotFn });
  let res;
  await assert.doesNotReject(async () => { res = await applyPlan(baseOpts(seams)); });
  assert.equal(res.ok, false);
  assert.ok(res.diagnostics.some((d) => d.code === 'apply-unexpected-error'), JSON.stringify(res.diagnostics));
  assert.match(res.diagnostics.find((d) => d.code === 'apply-unexpected-error').message, /boom/);
  // even on a thrown snapshot, the lock (acquired before the try) is still released.
  assert.equal(seams.releaseFn.calls.length, 1, 'finally still releases the lock on a thrown seam');
});

test('applyPlan: a throwing acquireFn → ok:false + apply-unexpected-error, no release', async () => {
  const acquireFn = () => { throw new Error('acquire boom'); };
  const releaseFn = makeRelease();
  const seams = happySeams({ acquireFn, releaseFn });
  let res;
  await assert.doesNotReject(async () => { res = await applyPlan(baseOpts(seams)); });
  assert.equal(res.ok, false);
  assert.ok(res.diagnostics.some((d) => d.code === 'apply-unexpected-error'));
  // acquire threw before returning acquired:true → release must NOT run.
  assert.equal(releaseFn.calls.length, 0, 'no release when acquire itself threw');
});

test('applyPlan: tolerates undefined / null / empty opts without throwing', async () => {
  await assert.doesNotReject(async () => {
    const a = await applyPlan(undefined);
    assert.equal(a.ok, false);
    assert.equal(a.applied, false);
    assert.equal(a.lock.acquired, false);
    assert.equal(a.diagnostics[0].code, 'apply-bad-args');
    const b = await applyPlan(null);
    assert.equal(b.ok, false);
    const c = await applyPlan({});
    assert.equal(c.ok, false);
    assert.equal(c.diagnostics[0].code, 'apply-bad-args');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
//  P3.U13 sub-unit C — enableWrites: snapshotted → applying → committed
// ════════════════════════════════════════════════════════════════════════════════

// ── (C1) DEFAULT (no enableWrites) still stops at snapshotted ────────────────────

test('applyPlan: WITHOUT enableWrites still stops at snapshotted, NEVER applying', async () => {
  const seams = happySeams();
  const res = await applyPlan(baseOpts(seams)); // no enableWrites
  assert.equal(res.ok, true);
  assert.equal(res.state, 'snapshotted');
  assert.equal(res.applied, false);
  assert.ok(res.diagnostics.some((d) => d.code === 'apply-writes-disabled'), 'writes-disabled info still present');
  // the DoD pin holds: transition NEVER called with 'applying', atomic write never called.
  const states = seams.transitionFn.calls.map((c) => c.toState);
  assert.deepEqual(states, ['snapshotted']);
  assert.equal(seams.atomicWriteFn.calls.length, 0, 'no governed write on the default path');
});

// ── (C2) enableWrites + single create op → committed, applied:true, opsWritten:1 ─

test('applyPlan enableWrites: single create op reaches committed (applied, opsWritten:1)', async () => {
  const seams = happySeams();
  const res = await applyPlan(baseOpts(seams, { enableWrites: true, plan: planWith([writeOp('create')]) }));
  assert.equal(res.ok, true, JSON.stringify(res.diagnostics));
  assert.equal(res.state, 'committed');
  assert.equal(res.applied, true);
  assert.equal(res.opsWritten, 1);
  // no writes-disabled info on the enableWrites path.
  assert.ok(!res.diagnostics.some((d) => d.code === 'apply-writes-disabled'));
  // transitions are exactly the full lifecycle tail.
  const states = seams.transitionFn.calls.map((c) => c.toState);
  assert.deepEqual(states, ['snapshotted', 'applying', 'committed']);
  // atomicWriteFn called ONCE with the op's target+content and the injected gate.
  assert.equal(seams.atomicWriteFn.calls.length, 1);
  assert.equal(seams.atomicWriteFn.calls[0].target, `${TARGET}\\settings.json`);
  assert.equal(seams.atomicWriteFn.calls[0].content, '{"model":"opus"}\n');
  assert.equal(seams.atomicWriteFn.calls[0].assertWritable, PASS);
  // journal persisted three times: snapshotted, applying, committed.
  assert.equal(seams.writeJournalFn.calls.length, 3);
  // lock released.
  assert.equal(seams.releaseFn.calls.length, 1);
});

// ── (C3) enableWrites + single overwrite op → committed ──────────────────────────

test('applyPlan enableWrites: single overwrite op reaches committed', async () => {
  const seams = happySeams();
  const res = await applyPlan(baseOpts(seams, { enableWrites: true, plan: planWith([writeOp('overwrite')]) }));
  assert.equal(res.ok, true, JSON.stringify(res.diagnostics));
  assert.equal(res.state, 'committed');
  assert.equal(res.applied, true);
  assert.equal(res.opsWritten, 1);
  assert.equal(seams.atomicWriteFn.calls.length, 1);
  assert.equal(seams.atomicWriteFn.calls[0].target, `${TARGET}\\settings.json`);
});

// ── (C4) enableWrites + atomic write fails (with leftovers) → failed ─────────────

test('applyPlan enableWrites: a failed atomic write → journal failed, applied:false, leftovers surfaced', async () => {
  const leftovers = { newPath: `${TARGET}\\settings.json.mgr-new`, oldPath: `${TARGET}\\settings.json.mgr-old` };
  const atomicWriteFn = makeAtomicWrite({ ok: false, leftovers,
    diagnostics: [{ severity: 'error', code: 'apply-write-commit-unrecoverable', message: 'boom', phase: 'apply' }] });
  const seams = happySeams({ atomicWriteFn });
  const res = await applyPlan(baseOpts(seams, { enableWrites: true, plan: planWith([writeOp('overwrite')]) }));
  assert.equal(res.ok, false);
  assert.equal(res.applied, false);
  assert.equal(res.state, 'failed');
  assert.ok(res.diagnostics.some((d) => d.code === 'apply-op-failed'), 'own rollup code');
  assert.ok(res.diagnostics.some((d) => d.code === 'apply-write-commit-unrecoverable'), 'aggregates write diag');
  assert.deepEqual(res.leftovers, leftovers, 'res.leftovers surfaced on the result');
  // the write WAS attempted; transitions reached applying then failed (not committed).
  const states = seams.transitionFn.calls.map((c) => c.toState);
  assert.deepEqual(states, ['snapshotted', 'applying', 'failed']);
  assert.equal(seams.releaseFn.calls.length, 1, 'lock released');
});

// ── (C5) enableWrites + 2 ops → multi-op refusal (atomicWriteFn NEVER called) ────

test('applyPlan enableWrites: 2 ops → failed + apply-multi-op-unsupported, NO write, NO applying', async () => {
  const seams = happySeams();
  const res = await applyPlan(baseOpts(seams, {
    enableWrites: true, plan: planWith([writeOp('create'), writeOp('overwrite')]),
  }));
  assert.equal(res.ok, false);
  assert.equal(res.applied, false);
  assert.equal(res.state, 'failed');
  assert.ok(res.diagnostics.some((d) => d.code === 'apply-multi-op-unsupported'));
  // CRITICAL: no write, and no 'applying' transition (refused while snapshotted).
  assert.equal(seams.atomicWriteFn.calls.length, 0, 'atomicWriteFn NEVER called for multi-op');
  const states = seams.transitionFn.calls.map((c) => c.toState);
  assert.ok(!states.includes('applying'), 'never transitions to applying on a multi-op refusal');
  assert.deepEqual(states, ['snapshotted', 'failed']);
});

// ── (C6) enableWrites + unsupported kind (patch) → kind refusal, no write ────────

test('applyPlan enableWrites: a single patch op → failed + apply-op-kind-unsupported, NO write, NO applying', async () => {
  const seams = happySeams();
  // makePlan() is a single patch op — unsupported for writing.
  const res = await applyPlan(baseOpts(seams, { enableWrites: true, plan: makePlan() }));
  assert.equal(res.ok, false);
  assert.equal(res.applied, false);
  assert.equal(res.state, 'failed');
  assert.ok(res.diagnostics.some((d) => d.code === 'apply-op-kind-unsupported'));
  assert.equal(seams.atomicWriteFn.calls.length, 0, 'atomicWriteFn NEVER called for an unsupported kind');
  const states = seams.transitionFn.calls.map((c) => c.toState);
  assert.ok(!states.includes('applying'), 'transition NEVER called with applying on a kind refusal');
  assert.deepEqual(states, ['snapshotted', 'failed']);
});

// ── (C6b) enableWrites + create op missing content → apply-op-invalid ────────────

test('applyPlan enableWrites: a create op with no content → failed + apply-op-invalid, no write', async () => {
  const seams = happySeams();
  const res = await applyPlan(baseOpts(seams, {
    enableWrites: true,
    plan: planWith([{ kind: 'create', target: `${TARGET}\\settings.json`, summary: 'no content' }]),
  }));
  assert.equal(res.ok, false);
  assert.equal(res.state, 'failed');
  assert.ok(res.diagnostics.some((d) => d.code === 'apply-op-invalid'));
  assert.equal(seams.atomicWriteFn.calls.length, 0);
});

// ── (C7) enableWrites + 0 ops → clean no-op commit (opsWritten:0, no write) ───────

test('applyPlan enableWrites: 0 ops → committed no-op (applied:true, opsWritten:0, NO write)', async () => {
  const seams = happySeams();
  const res = await applyPlan(baseOpts(seams, { enableWrites: true, plan: planWith([]) }));
  assert.equal(res.ok, true, JSON.stringify(res.diagnostics));
  assert.equal(res.state, 'committed');
  assert.equal(res.applied, true);
  assert.equal(res.opsWritten, 0);
  assert.equal(seams.atomicWriteFn.calls.length, 0, 'no governed write for a zero-op apply');
  const states = seams.transitionFn.calls.map((c) => c.toState);
  assert.deepEqual(states, ['snapshotted', 'applying', 'committed'], 'still drives the full lifecycle');
});

// ── (C8) enableWrites but missing assertWritable still refuses BEFORE the lock ────

test('applyPlan enableWrites: a missing assertWritable refuses before the lock (no acquire, no write)', async () => {
  const seams = happySeams();
  const res = await applyPlan({
    plan: planWith([writeOp('create')]), targetClaudeDir: TARGET, mgrStateDir: STATE,
    now: FIXED_NOW, enableWrites: true, seams, // assertWritable omitted
  });
  assert.equal(res.ok, false);
  assert.equal(res.applied, false);
  assert.equal(res.lock.acquired, false);
  assert.equal(res.diagnostics[0].code, 'apply-bad-args');
  assert.match(res.diagnostics[0].message, /assertWritable/);
  assert.equal(seams.acquireFn.calls.length, 0, 'no lock without a write gate');
  assert.equal(seams.atomicWriteFn.calls.length, 0, 'no write without a write gate');
});

// ── (C9) enableWrites with the REAL state machine accepts the full lifecycle ─────

test('applyPlan enableWrites: the REAL transition state machine accepts snapshotted→applying→committed', async () => {
  // Use the REAL createJournal (so the journal carries a real lifecycle `state`)
  // and the REAL transition (records calls but delegates to the actual TRANSITIONS
  // table) — a regression guard proving the table admits the edges this unit drives
  // even if the mocks ever drift from the real state machine.
  const transitionFn = realTransition();
  const seams = happySeams({ transitionFn, createJournalFn: createJournal });
  const res = await applyPlan(baseOpts(seams, { enableWrites: true, plan: planWith([writeOp('create')]) }));
  assert.equal(res.ok, true, JSON.stringify(res.diagnostics));
  assert.equal(res.state, 'committed');
  assert.equal(res.applied, true);
  assert.equal(res.opsWritten, 1);
  const states = transitionFn.calls.map((c) => c.toState);
  assert.deepEqual(states, ['snapshotted', 'applying', 'committed']);
});
