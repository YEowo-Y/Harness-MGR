/**
 * P3.U18 — recover-rollback.test.mjs (unit, hermetic)
 *
 * Drives `recover({ mode:'rollback' })` and `recover({ mode:'from-manifest' })`
 * through an INJECTED `rollbackFn` seam (a stand-in for the U17 rollbackSnapshot
 * orchestrator) plus journal seams — so no real lock / tar / fs is touched. We prove:
 *   • DRY-RUN BY DEFAULT (no journal write without enableWrites);
 *   • --rollback is journal-AWARE (refuses an ineligible / missing journal, and only
 *     marks the journal rolled-back AFTER a successful restore);
 *   • --from-manifest is journal-AGNOSTIC (recovers even when the journal is missing —
 *     the corrupted-journal headline), best-effort updating the journal after.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { recover } from '../src/ops/recover.mjs';

const PASS_GATE = (p) => p;
const VALID_ID = '2026-05-30T12-00-00Z';
const STATE_DIR = '/tmp/cmgr-state';
const CLAUDE_DIR = '/tmp/cmgr-claude';

/** A recording seam. */
function recorder(retVal) {
  const calls = [];
  const fn = (arg) => { calls.push(arg); return retVal; };
  fn.calls = calls;
  return fn;
}
/** An async recording seam (for rollbackFn). */
function asyncRecorder(retVal) {
  const calls = [];
  const fn = async (arg) => { calls.push(arg); return retVal; };
  fn.calls = calls;
  return fn;
}

const DRY_PREVIEW = { ok: true, status: 'dry-run', code: 0, dryRun: true, diagnostics: [] };
const RESTORED = { ok: true, status: 'restored', code: 0, dryRun: false, diagnostics: [] };
const REFUSED_DRIFT = { ok: false, status: 'refused-drift', code: 3, dryRun: false, diagnostics: [] };
const ARCHIVE_CORRUPT = { ok: false, status: 'archive-corrupt', code: 4, dryRun: false, diagnostics: [] };

function journalOf(state) { return { state, snapshotId: VALID_ID, ops: [] }; }

// ── --rollback (journal-aware) ──────────────────────────────────────────────────

test('rollback dry-run (default): previews via rollbackFn, writes NO journal', async () => {
  const readJournalFn = recorder({ journal: journalOf('applying'), diagnostics: [] });
  const transitionFn = recorder({ ok: true, journal: journalOf('rolled-back'), diagnostics: [] });
  const writeJournalFn = recorder({ written: true, path: 'x', diagnostics: [] });
  const rollbackFn = asyncRecorder(DRY_PREVIEW);

  const res = await recover({
    mode: 'rollback', snapshotId: VALID_ID, mgrStateDir: STATE_DIR, targetClaudeDir: CLAUDE_DIR,
    assertWritable: PASS_GATE, seams: { readJournalFn, transitionFn, writeJournalFn, rollbackFn },
  });

  assert.equal(res.ok, true);
  assert.equal(res.mode, 'rollback');
  assert.equal(res.dryRun, true);
  assert.equal(res.state, 'applying', 'journal state unchanged on a dry-run');
  assert.ok(res.rollback && res.rollback.status === 'dry-run');
  assert.equal(rollbackFn.calls.length, 1);
  assert.equal(rollbackFn.calls[0].enableWrites, false, 'dry-run forwards enableWrites:false');
  assert.equal(writeJournalFn.calls.length, 0, 'dry-run NEVER writes the journal');
});

test('rollback --apply success: restores then marks the journal rolled-back', async () => {
  const journal = journalOf('applying');
  const rolledBack = journalOf('rolled-back');
  const readJournalFn = recorder({ journal, diagnostics: [] });
  const transitionFn = recorder({ ok: true, journal: rolledBack, diagnostics: [] });
  const writeJournalFn = recorder({ written: true, path: `${STATE_DIR}/snapshots/${VALID_ID}/apply-journal.json`, diagnostics: [] });
  const rollbackFn = asyncRecorder(RESTORED);

  const res = await recover({
    mode: 'rollback', snapshotId: VALID_ID, mgrStateDir: STATE_DIR, targetClaudeDir: CLAUDE_DIR,
    assertWritable: PASS_GATE, enableWrites: true, force: true, expectedTarget: CLAUDE_DIR,
    seams: { readJournalFn, transitionFn, writeJournalFn, rollbackFn },
  });

  assert.equal(res.ok, true, JSON.stringify(res.diagnostics));
  assert.equal(res.code, 0);
  assert.equal(res.dryRun, false);
  assert.equal(res.state, 'rolled-back');
  assert.equal(writeJournalFn.calls.length, 1, 'journal persisted at rolled-back');
  assert.equal(writeJournalFn.calls[0].journal, rolledBack);
  assert.ok(res.diagnostics.some((d) => d.code === 'recover-rolled-back'));
  // force / enableWrites / expectedTarget were forwarded to the orchestrator.
  assert.equal(rollbackFn.calls[0].force, true);
  assert.equal(rollbackFn.calls[0].enableWrites, true);
  assert.equal(rollbackFn.calls[0].expectedTarget, CLAUDE_DIR);
});

test('rollback --apply refused by drift: surfaces code 3, NO journal write', async () => {
  const readJournalFn = recorder({ journal: journalOf('committed'), diagnostics: [] });
  const transitionFn = recorder({ ok: true, journal: journalOf('rolled-back'), diagnostics: [] });
  const writeJournalFn = recorder({ written: true, path: 'x', diagnostics: [] });
  const rollbackFn = asyncRecorder(REFUSED_DRIFT);

  const res = await recover({
    mode: 'rollback', snapshotId: VALID_ID, mgrStateDir: STATE_DIR, targetClaudeDir: CLAUDE_DIR,
    assertWritable: PASS_GATE, enableWrites: true,
    seams: { readJournalFn, transitionFn, writeJournalFn, rollbackFn },
  });

  assert.equal(res.ok, false);
  assert.equal(res.code, 3, 'carries the rollback refusal exit-code');
  assert.equal(res.state, 'committed', 'journal left as-is on a refused restore');
  assert.equal(writeJournalFn.calls.length, 0);
});

test('rollback ineligible journal (planned): refuses, rollbackFn NEVER runs', async () => {
  const readJournalFn = recorder({ journal: journalOf('planned'), diagnostics: [] });
  // a planned journal has no legal edge to rolled-back.
  const transitionFn = recorder({ ok: false, journal: journalOf('planned'), diagnostics: [] });
  const rollbackFn = asyncRecorder(RESTORED);

  const res = await recover({
    mode: 'rollback', snapshotId: VALID_ID, mgrStateDir: STATE_DIR, targetClaudeDir: CLAUDE_DIR,
    assertWritable: PASS_GATE, enableWrites: true,
    seams: { readJournalFn, transitionFn, rollbackFn },
  });

  assert.equal(res.ok, false);
  assert.equal(res.state, 'planned');
  assert.ok(res.diagnostics.some((d) => d.code === 'recover-rollback-ineligible'));
  assert.equal(rollbackFn.calls.length, 0, 'never attempts a restore for an ineligible journal');
});

test('rollback corrupt/missing journal: refuses + recommends --from-manifest', async () => {
  const readJournalFn = recorder({ journal: null, diagnostics: [{ severity: 'error', code: 'journal-unreadable', message: 'bad' }] });
  const rollbackFn = asyncRecorder(RESTORED);

  const res = await recover({
    mode: 'rollback', snapshotId: VALID_ID, mgrStateDir: STATE_DIR, targetClaudeDir: CLAUDE_DIR,
    assertWritable: PASS_GATE, enableWrites: true, seams: { readJournalFn, rollbackFn },
  });

  assert.equal(res.ok, false);
  assert.ok(res.diagnostics.some((d) => d.code === 'recover-rollback-no-journal'));
  assert.ok(res.diagnostics.some((d) => /from-manifest/.test(d.message)));
  assert.equal(rollbackFn.calls.length, 0);
});

test('rollback restored but journal write fails: ok:false, live tree already restored', async () => {
  const readJournalFn = recorder({ journal: journalOf('applying'), diagnostics: [] });
  const transitionFn = recorder({ ok: true, journal: journalOf('rolled-back'), diagnostics: [] });
  const writeJournalFn = recorder({ written: false, path: null, diagnostics: [{ severity: 'error', code: 'journal-write-error', message: 'denied' }] });
  const rollbackFn = asyncRecorder(RESTORED);

  const res = await recover({
    mode: 'rollback', snapshotId: VALID_ID, mgrStateDir: STATE_DIR, targetClaudeDir: CLAUDE_DIR,
    assertWritable: PASS_GATE, enableWrites: true,
    seams: { readJournalFn, transitionFn, writeJournalFn, rollbackFn },
  });

  assert.equal(res.ok, false);
  assert.ok(res.diagnostics.some((d) => d.code === 'recover-rollback-journal-write-failed'));
  assert.equal(res.state, 'applying', 'journal could not be advanced past applying');
  assert.ok(res.rollback && res.rollback.status === 'restored', 'but the restore itself succeeded');
});

test('rollback missing targetClaudeDir: refuses with recover-bad-args', async () => {
  const res = await recover({
    mode: 'rollback', snapshotId: VALID_ID, mgrStateDir: STATE_DIR, assertWritable: PASS_GATE,
  });
  assert.equal(res.ok, false);
  assert.ok(res.diagnostics.some((d) => d.code === 'recover-bad-args'));
});

test('rollback never-rejects: a throwing rollbackFn becomes a diagnostic', async () => {
  const readJournalFn = recorder({ journal: journalOf('applying'), diagnostics: [] });
  const transitionFn = recorder({ ok: true, journal: journalOf('rolled-back'), diagnostics: [] });
  const rollbackFn = async () => { throw new Error('boom from orchestrator'); };
  let res;
  await assert.doesNotReject(async () => {
    res = await recover({
      mode: 'rollback', snapshotId: VALID_ID, mgrStateDir: STATE_DIR, targetClaudeDir: CLAUDE_DIR,
      assertWritable: PASS_GATE, enableWrites: true, seams: { readJournalFn, transitionFn, rollbackFn },
    });
  });
  assert.equal(res.ok, false);
  assert.ok(res.diagnostics.some((d) => d.code === 'recover-unexpected-error'));
});

// ── --from-manifest (journal-agnostic) ──────────────────────────────────────────

test('from-manifest dry-run: previews without reading the journal', async () => {
  const readJournalFn = recorder({ journal: journalOf('applying'), diagnostics: [] });
  const rollbackFn = asyncRecorder(DRY_PREVIEW);

  const res = await recover({
    mode: 'from-manifest', snapshotId: VALID_ID, mgrStateDir: STATE_DIR, targetClaudeDir: CLAUDE_DIR,
    assertWritable: PASS_GATE, seams: { readJournalFn, rollbackFn },
  });

  assert.equal(res.ok, true);
  assert.equal(res.mode, 'from-manifest');
  assert.equal(res.dryRun, true);
  assert.equal(rollbackFn.calls.length, 1);
  assert.equal(readJournalFn.calls.length, 0, 'dry-run does not reconcile (and never needs) the journal');
});

test('from-manifest --apply with a MISSING journal: STILL recovers (the headline)', async () => {
  // The corrupted-journal recovery: readJournal returns null, but the restore succeeds
  // from the manifest+tar alone. ok stays true; state is null (no journal to advance).
  const readJournalFn = recorder({ journal: null, diagnostics: [{ severity: 'error', code: 'journal-unreadable', message: 'corrupt' }] });
  const transitionFn = recorder({ ok: true, journal: journalOf('rolled-back'), diagnostics: [] });
  const writeJournalFn = recorder({ written: true, path: 'x', diagnostics: [] });
  const rollbackFn = asyncRecorder(RESTORED);

  const res = await recover({
    mode: 'from-manifest', snapshotId: VALID_ID, mgrStateDir: STATE_DIR, targetClaudeDir: CLAUDE_DIR,
    assertWritable: PASS_GATE, enableWrites: true, force: true,
    seams: { readJournalFn, transitionFn, writeJournalFn, rollbackFn },
  });

  assert.equal(res.ok, true, 'restore from the manifest succeeds despite the corrupt journal');
  assert.equal(res.state, null, 'no readable journal to advance');
  assert.ok(res.diagnostics.some((d) => d.code === 'recover-from-manifest-no-journal'));
  assert.ok(res.diagnostics.some((d) => d.code === 'recover-from-manifest-restored'));
  assert.equal(transitionFn.calls.length, 0, 'cannot transition a journal that could not be read');
  assert.equal(writeJournalFn.calls.length, 0);
});

test('from-manifest --apply with a readable+eligible journal: also marks it rolled-back', async () => {
  const journal = journalOf('applying');
  const rolledBack = journalOf('rolled-back');
  const readJournalFn = recorder({ journal, diagnostics: [] });
  const transitionFn = recorder({ ok: true, journal: rolledBack, diagnostics: [] });
  const writeJournalFn = recorder({ written: true, path: `${STATE_DIR}/snapshots/${VALID_ID}/apply-journal.json`, diagnostics: [] });
  const rollbackFn = asyncRecorder(RESTORED);

  const res = await recover({
    mode: 'from-manifest', snapshotId: VALID_ID, mgrStateDir: STATE_DIR, targetClaudeDir: CLAUDE_DIR,
    assertWritable: PASS_GATE, enableWrites: true, seams: { readJournalFn, transitionFn, writeJournalFn, rollbackFn },
  });

  assert.equal(res.ok, true);
  assert.equal(res.state, 'rolled-back');
  assert.equal(writeJournalFn.calls.length, 1);
  assert.ok(res.diagnostics.some((d) => d.code === 'recover-from-manifest-restored'));
});

test('from-manifest --apply with an ineligible journal: restore still succeeds, journal left as-is', async () => {
  const readJournalFn = recorder({ journal: journalOf('planned'), diagnostics: [] });
  const transitionFn = recorder({ ok: false, journal: journalOf('planned'), diagnostics: [] });
  const writeJournalFn = recorder({ written: true, path: 'x', diagnostics: [] });
  const rollbackFn = asyncRecorder(RESTORED);

  const res = await recover({
    mode: 'from-manifest', snapshotId: VALID_ID, mgrStateDir: STATE_DIR, targetClaudeDir: CLAUDE_DIR,
    assertWritable: PASS_GATE, enableWrites: true, seams: { readJournalFn, transitionFn, writeJournalFn, rollbackFn },
  });

  assert.equal(res.ok, true, 'the manifest restore succeeded regardless of journal state');
  assert.equal(res.state, 'planned');
  assert.ok(res.diagnostics.some((d) => d.code === 'recover-from-manifest-journal-ineligible'));
  assert.equal(writeJournalFn.calls.length, 0, 'an ineligible journal is left untouched');
});

test('from-manifest --apply restore fails (archive corrupt): ok:false, NO journal reconcile', async () => {
  const readJournalFn = recorder({ journal: journalOf('applying'), diagnostics: [] });
  const rollbackFn = asyncRecorder(ARCHIVE_CORRUPT);

  const res = await recover({
    mode: 'from-manifest', snapshotId: VALID_ID, mgrStateDir: STATE_DIR, targetClaudeDir: CLAUDE_DIR,
    assertWritable: PASS_GATE, enableWrites: true, seams: { readJournalFn, rollbackFn },
  });

  assert.equal(res.ok, false);
  assert.equal(res.code, 4, 'carries the archive-corrupt exit-code');
  assert.equal(readJournalFn.calls.length, 0, 'no journal reconcile when the restore failed');
});

test('from-manifest missing targetClaudeDir: refuses with recover-bad-args', async () => {
  const res = await recover({
    mode: 'from-manifest', snapshotId: VALID_ID, mgrStateDir: STATE_DIR, assertWritable: PASS_GATE,
  });
  assert.equal(res.ok, false);
  assert.ok(res.diagnostics.some((d) => d.code === 'recover-bad-args'));
});
