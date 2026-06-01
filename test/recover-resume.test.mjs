/**
 * P3.U18 — recover-resume.test.mjs (unit, hermetic)
 *
 * Drives `recover({ mode:'resume' })` through INJECTED seams (readJournalFn /
 * transitionFn / writeJournalFn / readFileFn) so no real journal or fs is touched.
 * The headline safety property: resume marks an 'applying' apply 'committed' ONLY
 * after re-hashing the op's target and proving it matches the planned content — the
 * crash window (target absent / content mismatch) is REFUSED, not falsely committed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { recover } from '../src/ops/recover.mjs';

const PASS_GATE = (p) => p;
const VALID_ID = '2026-05-30T12-00-00Z';
const STATE_DIR = '/tmp/cmgr-state';
const CLAUDE_DIR = '/tmp/cmgr-claude';
const TARGET = '/tmp/cmgr-claude/settings.json';

/** A recording seam: remembers every call's first-arg, returns a canned value. */
function recorder(retVal) {
  const calls = [];
  const fn = (arg) => { calls.push(arg); return retVal; };
  fn.calls = calls;
  return fn;
}

/** A journal with the given state + ops. */
function journalOf(state, ops = []) {
  return { state, snapshotId: VALID_ID, ops };
}

/** Run resume with seam overrides; defaults make the happy path succeed. */
async function runResume({ journal, ops, fileBytes, seamsOverride = {}, ...rest } = {}) {
  const j = journal ?? journalOf('applying', ops ?? []);
  const readJournalFn = recorder({ journal: j, diagnostics: [] });
  const committed = { ...j, state: 'committed' };
  const transitionFn = recorder({ ok: true, journal: committed, diagnostics: [] });
  const writeJournalFn = recorder({ written: true, path: `${STATE_DIR}/snapshots/${VALID_ID}/apply-journal.json`, diagnostics: [] });
  // readFileFn returns the planned content bytes by default (write LANDED).
  const readFileFn = recorder(fileBytes ?? Buffer.from('hello\n', 'utf8'));
  const seams = { readJournalFn, transitionFn, writeJournalFn, readFileFn, ...seamsOverride };
  const res = await recover({
    mode: 'resume', snapshotId: VALID_ID, mgrStateDir: STATE_DIR, targetClaudeDir: CLAUDE_DIR,
    assertWritable: PASS_GATE, seams, ...rest,
  });
  return { res, readJournalFn, transitionFn, writeJournalFn, readFileFn };
}

test('resume happy path: a landed write (matching hash) is finalized to committed', async () => {
  const content = 'model: opus\n';
  const ops = [{ kind: 'overwrite', target: TARGET, content }];
  const { res, transitionFn, writeJournalFn } = await runResume({
    ops, fileBytes: Buffer.from(content, 'utf8'),
  });
  assert.equal(res.ok, true, JSON.stringify(res.diagnostics));
  assert.equal(res.mode, 'resume');
  assert.equal(res.code, 0);
  assert.equal(res.state, 'committed');
  assert.equal(transitionFn.calls.length, 1, 'transition to committed attempted');
  assert.equal(writeJournalFn.calls.length, 1, 'committed journal persisted');
  assert.ok(res.diagnostics.some((d) => d.code === 'recover-resumed' && d.severity === 'info'));
});

test('resume CRASH WINDOW: target absent (read throws) → refuses, NOT committed', async () => {
  const ops = [{ kind: 'overwrite', target: TARGET, content: 'X\n' }];
  const throwingRead = () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };
  const { res, transitionFn, writeJournalFn } = await runResume({
    ops, seamsOverride: { readFileFn: throwingRead },
  });
  assert.equal(res.ok, false);
  assert.equal(res.state, 'applying', 'journal left at applying');
  assert.ok(res.diagnostics.some((d) => d.code === 'recover-resume-unverified'));
  assert.equal(transitionFn.calls.length, 0, 'NEVER transitions to committed when the write did not land');
  assert.equal(writeJournalFn.calls.length, 0, 'NEVER writes the journal on an unverified resume');
});

test('resume content mismatch: on-disk bytes differ from the plan → refuses', async () => {
  const ops = [{ kind: 'create', target: TARGET, content: 'PLANNED\n' }];
  const { res, transitionFn } = await runResume({
    ops, fileBytes: Buffer.from('SOMETHING ELSE\n', 'utf8'),
  });
  assert.equal(res.ok, false);
  assert.ok(res.diagnostics.some((d) => d.code === 'recover-resume-unverified'));
  assert.equal(transitionFn.calls.length, 0);
});

test('resume 0-op apply: vacuously verified → committed without reading any file', async () => {
  const { res, transitionFn, readFileFn } = await runResume({ ops: [] });
  assert.equal(res.ok, true);
  assert.equal(res.state, 'committed');
  assert.equal(readFileFn.calls.length, 0, 'no op → no target read');
  assert.equal(transitionFn.calls.length, 1);
});

test('resume idempotent: an already-committed journal is a no-op success', async () => {
  const { res, transitionFn, writeJournalFn } = await runResume({ journal: journalOf('committed') });
  assert.equal(res.ok, true);
  assert.equal(res.state, 'committed');
  assert.ok(res.diagnostics.some((d) => d.code === 'recover-resume-noop'));
  assert.equal(transitionFn.calls.length, 0, 'no transition for an already-committed apply');
  assert.equal(writeJournalFn.calls.length, 0);
});

test('resume wrong state: a snapshotted apply cannot be resumed forward', async () => {
  const { res, transitionFn } = await runResume({ journal: journalOf('snapshotted') });
  assert.equal(res.ok, false);
  assert.equal(res.state, 'snapshotted');
  assert.ok(res.diagnostics.some((d) => d.code === 'recover-resume-not-applying'));
  assert.equal(transitionFn.calls.length, 0);
});

test('resume out-of-target op path: refuses and NEVER reads the escaping path', async () => {
  const ops = [{ kind: 'overwrite', target: '/etc/shadow', content: 'x' }];
  const { res, readFileFn, transitionFn } = await runResume({ ops });
  assert.equal(res.ok, false);
  assert.ok(res.diagnostics.some((d) => d.code === 'recover-resume-unverified'));
  assert.equal(readFileFn.calls.length, 0, 'an escaping op target is NEVER read');
  assert.equal(transitionFn.calls.length, 0);
});

test('resume multi-op ALL match: every op target re-hashes clean → committed', async () => {
  // Both ops share the SAME content so the default recorder readFileFn (one canned
  // value for every call) matches BOTH targets — a landed multi-op write.
  const ops = [
    { kind: 'overwrite', target: TARGET, content: 'X\n' },
    { kind: 'create', target: `${CLAUDE_DIR}/.mcp.json`, content: 'X\n' },
  ];
  const { res, transitionFn, writeJournalFn, readFileFn } = await runResume({
    ops, fileBytes: Buffer.from('X\n', 'utf8'),
  });
  assert.equal(res.ok, true, JSON.stringify(res.diagnostics));
  assert.equal(res.state, 'committed');
  assert.ok(res.diagnostics.some((d) => d.code === 'recover-resumed' && d.severity === 'info'));
  assert.equal(transitionFn.calls.length, 1, 'a fully-verified multi-op apply transitions once');
  assert.equal(writeJournalFn.calls.length, 1, 'committed journal persisted');
  assert.equal(readFileFn.calls.length, 2, 'both op targets are re-hashed');
});

test('resume multi-op ONE mismatch: any unverified op → refuse, never transition', async () => {
  // op1 (settings.json) matches; op2 (.mcp.json) reads DIFFERENT bytes → unverified.
  const ops = [
    { kind: 'overwrite', target: TARGET, content: 'X\n' },
    { kind: 'create', target: `${CLAUDE_DIR}/.mcp.json`, content: 'X\n' },
  ];
  const perTargetRead = (p) =>
    p.endsWith('.mcp.json') ? Buffer.from('WRONG\n', 'utf8') : Buffer.from('X\n', 'utf8');
  const { res, transitionFn, writeJournalFn } = await runResume({
    ops, seamsOverride: { readFileFn: perTargetRead },
  });
  assert.equal(res.ok, false);
  assert.equal(res.state, 'applying', 'journal left at applying');
  assert.ok(res.diagnostics.some((d) => d.code === 'recover-resume-unverified'));
  assert.equal(transitionFn.calls.length, 0, 'NEVER transitions when any op is unverified');
  assert.equal(writeJournalFn.calls.length, 0, 'NEVER writes the journal on an unverified resume');
});

test('resume missing targetClaudeDir: refuses with recover-bad-args', async () => {
  const res = await recover({
    mode: 'resume', snapshotId: VALID_ID, mgrStateDir: STATE_DIR, assertWritable: PASS_GATE,
  });
  assert.equal(res.ok, false);
  assert.equal(res.mode, 'resume');
  assert.ok(res.diagnostics.some((d) => d.code === 'recover-bad-args'));
});

test('resume never-rejects: a throwing writeJournalFn becomes a diagnostic', async () => {
  const ops = [{ kind: 'overwrite', target: TARGET, content: 'Z\n' }];
  const throwingWrite = () => { throw new Error('boom from write seam'); };
  let res;
  await assert.doesNotReject(async () => {
    ({ res } = await runResume({ ops, fileBytes: Buffer.from('Z\n', 'utf8'), seamsOverride: { writeJournalFn: throwingWrite } }));
  });
  assert.equal(res.ok, false);
  assert.ok(res.diagnostics.some((d) => d.code === 'recover-unexpected-error'));
});

test('resume hostile snapshotId: refused before any seam runs (dispatcher guard)', async () => {
  const readJournalFn = recorder({ journal: journalOf('applying'), diagnostics: [] });
  const res = await recover({
    mode: 'resume', snapshotId: '../../etc/passwd', mgrStateDir: STATE_DIR, targetClaudeDir: CLAUDE_DIR,
    assertWritable: PASS_GATE, seams: { readJournalFn },
  });
  assert.equal(res.ok, false);
  assert.ok(res.diagnostics.some((d) => d.code === 'recover-bad-id' || d.code === 'recover-path-escape'));
  assert.equal(readJournalFn.calls.length, 0, 'no journal read for a hostile id');
});
