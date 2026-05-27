/**
 * P3.U11 — apply-journal-writer.test.mjs
 *
 * Tests for src/ops/apply-journal-writer.mjs: createJournal / transition /
 * writeJournal / readJournal + the helpers (journalPath, isJournalState,
 * isJournal) and the state-machine table.
 *
 * Acceptance (DoD): the state machine moves correctly across all 4 core
 * transitions in isolation (planned→snapshotted, snapshotted→applying,
 * applying→committed, applying→failed) and rejects every illegal move; a
 * create → write → read round-trip is byte-stable (golden property); and a
 * sensitive patch op never lands in the persisted journal as plaintext (the
 * redaction is anchored to an independently-computed sha256 golden hex). All
 * filesystem access uses a real temp dir; the write gate + clock are injected.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { serialize, snapshotDir } from '../src/ops/snapshot-manifest.mjs';
import { PLAN_VERSION } from '../src/lib/plan.mjs';
import {
  JOURNAL_VERSION,
  JOURNAL_NAME,
  JOURNAL_STATES,
  INITIAL_STATE,
  journalPath,
  isJournalState,
  isJournal,
  createJournal,
  transition,
  writeJournal,
  readJournal,
} from '../src/ops/apply-journal-writer.mjs';

// ── shared helpers / fixtures ──────────────────────────────────────────────────

function makeTmpDir() {
  const dir = mkdtempSync(join(tmpdir(), 'cmgr-journal-'));
  return {
    dir,
    cleanup() { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } },
  };
}

const FIXED_NOW = () => new Date('2026-05-27T00:00:00.000Z');
const FIXED_ISO = '2026-05-27T00:00:00.000Z';
const LATER_NOW = () => new Date('2026-05-27T01:30:00.000Z');
const LATER_ISO = '2026-05-27T01:30:00.000Z';
const FIXED_ID = '2026-05-27T00-00-00Z';
const TARGET = '/c/Users/test/.claude';
const PASS_GATE = (p) => p; // passthrough write gate

// Independently-computed sha256 golden anchors (node:crypto, outside the module).
const SHA_TOK_OLD = '82675cfb250ffc88948e7c251f74b63b157f3f5f92745aeb37ee62a36231d4e0';
const SHA_TOK_NEW = '2cb3e362808c82e72f087acfe6fcb44a6a915d98e502ba256ff6f0cbef847b34';

/** A plan with one SENSITIVE patch op (auth.token) + one plain create op. */
function samplePlan() {
  return {
    planVersion: 1,
    command: 'remove',
    ops: [
      { kind: 'patch', target: `${TARGET}/settings.json`, summary: 'rotate token',
        pointer: 'auth.token', before: 'tok-old', after: 'tok-new' },
      { kind: 'create', target: `${TARGET}/skills/x/SKILL.md`, summary: 'add skill',
        content: 'plain-content' },
    ],
  };
}

/** Build a valid journal forced into a given state (for transitions in isolation). */
function journalIn(state) {
  const { journal } = createJournal({
    snapshotId: FIXED_ID, targetClaudeDir: TARGET,
    plan: { command: 'x', ops: [] }, now: FIXED_NOW,
  });
  journal.state = state;
  return journal;
}

function codes(diags) { return diags.map((d) => d.code); }

// ── constants / helpers ─────────────────────────────────────────────────────────

test('exports: JOURNAL_VERSION/NAME, the 6 states, and INITIAL_STATE', () => {
  assert.equal(JOURNAL_VERSION, 1);
  assert.equal(JOURNAL_NAME, 'apply-journal.json');
  assert.equal(INITIAL_STATE, 'planned');
  assert.deepEqual([...JOURNAL_STATES],
    ['planned', 'snapshotted', 'applying', 'committed', 'failed', 'rolled-back']);
});

test('journalPath: lands inside <stateDir>/snapshots/<id>/', () => {
  const p = journalPath('/state', FIXED_ID).replace(/\\/g, '/');
  assert.ok(p.endsWith(`snapshots/${FIXED_ID}/apply-journal.json`));
});

test('isJournalState: only the 6 known states are valid', () => {
  for (const s of JOURNAL_STATES) assert.equal(isJournalState(s), true);
  for (const bad of ['banana', '', 'PLANNED', null, 42, undefined]) {
    assert.equal(isJournalState(bad), false);
  }
});

test('isJournal: needs an object with a known state', () => {
  assert.equal(isJournal({ state: 'planned' }), true);
  assert.equal(isJournal({ state: 'banana' }), false);
  assert.equal(isJournal(null), false);
  assert.equal(isJournal([]), false);
  assert.equal(isJournal('planned'), false);
});

// ── createJournal ────────────────────────────────────────────────────────────────

test('createJournal: builds a planned-state journal with fixed fields', () => {
  const { journal, diagnostics } = createJournal({
    snapshotId: FIXED_ID, targetClaudeDir: TARGET, plan: samplePlan(), now: FIXED_NOW,
  });
  assert.equal(diagnostics.length, 0);
  assert.equal(journal.journalVersion, JOURNAL_VERSION);
  assert.equal(journal.planVersion, 1);
  assert.equal(journal.command, 'remove');
  assert.equal(journal.snapshotId, FIXED_ID);
  assert.equal(journal.targetClaudeDir, TARGET);
  assert.equal(journal.state, 'planned');
  assert.equal(journal.createdAt, FIXED_ISO);
  assert.equal(journal.updatedAt, FIXED_ISO);
  assert.equal(journal.ops.length, 2);
});

test('createJournal: REDACTS sensitive patch ops to {redacted,sha256} golden anchors', () => {
  const { journal } = createJournal({
    snapshotId: FIXED_ID, targetClaudeDir: TARGET, plan: samplePlan(), now: FIXED_NOW,
  });
  const patchOp = journal.ops[0];
  assert.deepEqual(patchOp.before, { redacted: true, sha256: SHA_TOK_OLD });
  assert.deepEqual(patchOp.after, { redacted: true, sha256: SHA_TOK_NEW });
  // The single strongest oracle: NO plaintext secret survives in the journal.
  const text = serialize(journal);
  assert.ok(!text.includes('tok-old'), 'plaintext before must not appear');
  assert.ok(!text.includes('tok-new'), 'plaintext after must not appear');
});

test('createJournal: leaves non-sensitive ops verbatim (recovery replay needs them)', () => {
  const { journal } = createJournal({
    snapshotId: FIXED_ID, targetClaudeDir: TARGET, plan: samplePlan(), now: FIXED_NOW,
  });
  assert.equal(journal.ops[1].kind, 'create');
  assert.equal(journal.ops[1].content, 'plain-content');
});

test('createJournal: skips malformed ops with a warn, keeps the rest', () => {
  const { journal, diagnostics } = createJournal({
    snapshotId: FIXED_ID, targetClaudeDir: TARGET, now: FIXED_NOW,
    plan: { command: 'x', ops: [{ kind: 'create', target: 't', summary: 's' }, null, 42] },
  });
  assert.equal(journal.ops.length, 1);
  assert.equal(diagnostics.filter((d) => d.code === 'journal-op-skipped').length, 2);
});

test('createJournal: defaults planVersion + command when absent', () => {
  const { journal } = createJournal({
    snapshotId: FIXED_ID, targetClaudeDir: TARGET, plan: {}, now: FIXED_NOW,
  });
  assert.equal(journal.planVersion, PLAN_VERSION);
  assert.equal(journal.command, '');
  assert.deepEqual(journal.ops, []);
});

test('createJournal: rejects bad input → null + diagnostic', () => {
  assert.equal(createJournal({ snapshotId: 'bad', targetClaudeDir: TARGET, plan: {} }).journal, null);
  assert.equal(codes(createJournal({ snapshotId: 'bad', targetClaudeDir: TARGET, plan: {} }).diagnostics)[0],
    'journal-snapshot-id-invalid');
  assert.equal(codes(createJournal({ snapshotId: FIXED_ID, targetClaudeDir: '', plan: {} }).diagnostics)[0],
    'journal-target-invalid');
  assert.equal(codes(createJournal({ snapshotId: FIXED_ID, targetClaudeDir: TARGET, plan: 42 }).diagnostics)[0],
    'journal-plan-invalid');
});

test('createJournal: never throws on junk', () => {
  assert.doesNotThrow(() => createJournal(undefined));
  assert.doesNotThrow(() => createJournal({}));
  assert.equal(createJournal(undefined).journal, null);
});

// ── transition: the 4 CORE transitions in isolation ───────────────────────────────

test('transition #1: planned → snapshotted', () => {
  const res = transition(journalIn('planned'), 'snapshotted', { now: LATER_NOW });
  assert.equal(res.ok, true);
  assert.equal(res.journal.state, 'snapshotted');
  assert.equal(res.diagnostics.length, 0);
});

test('transition #2: snapshotted → applying', () => {
  const res = transition(journalIn('snapshotted'), 'applying', { now: LATER_NOW });
  assert.equal(res.ok, true);
  assert.equal(res.journal.state, 'applying');
});

test('transition #3: applying → committed', () => {
  const res = transition(journalIn('applying'), 'committed', { now: LATER_NOW });
  assert.equal(res.ok, true);
  assert.equal(res.journal.state, 'committed');
});

test('transition #4: applying → failed', () => {
  const res = transition(journalIn('applying'), 'failed', { now: LATER_NOW });
  assert.equal(res.ok, true);
  assert.equal(res.journal.state, 'failed');
});

test('transition: updatedAt advances, createdAt is preserved', () => {
  const res = transition(journalIn('planned'), 'snapshotted', { now: LATER_NOW });
  assert.equal(res.journal.updatedAt, LATER_ISO);
  assert.equal(res.journal.createdAt, FIXED_ISO);
});

// ── transition: rollback / failed edges ──────────────────────────────────────────

test('transition: rollback edges from snapshotted/applying/committed/failed', () => {
  for (const from of ['snapshotted', 'applying', 'committed', 'failed']) {
    const res = transition(journalIn(from), 'rolled-back');
    assert.equal(res.ok, true, `${from} → rolled-back should be allowed`);
    assert.equal(res.journal.state, 'rolled-back');
  }
});

test('transition: mark-failed edges from planned/snapshotted/applying', () => {
  for (const from of ['planned', 'snapshotted', 'applying']) {
    const res = transition(journalIn(from), 'failed');
    assert.equal(res.ok, true, `${from} → failed should be allowed`);
  }
});

// ── transition: illegal / invalid rejection ───────────────────────────────────────

test('transition: INVARIANT planned cannot roll back (no snapshot exists yet)', () => {
  const res = transition(journalIn('planned'), 'rolled-back');
  assert.equal(res.ok, false);
  assert.equal(res.diagnostics[0].code, 'journal-illegal-transition');
});

test('transition: rejects representative illegal moves', () => {
  const illegal = [
    ['planned', 'committed'], ['planned', 'applying'],
    ['snapshotted', 'committed'], ['committed', 'applying'],
    ['failed', 'applying'], ['rolled-back', 'applying'], ['rolled-back', 'failed'],
  ];
  for (const [from, to] of illegal) {
    const res = transition(journalIn(from), to);
    assert.equal(res.ok, false, `${from} → ${to} must be rejected`);
    assert.equal(res.diagnostics[0].code, 'journal-illegal-transition');
  }
});

test('transition: rolled-back is terminal (no outgoing edges)', () => {
  for (const to of JOURNAL_STATES) {
    assert.equal(transition(journalIn('rolled-back'), to).ok, false);
  }
});

test('transition: rejects an unknown target state', () => {
  const res = transition(journalIn('planned'), 'banana');
  assert.equal(res.ok, false);
  assert.equal(res.diagnostics[0].code, 'journal-invalid-state');
});

test('transition: rejects a non-journal input', () => {
  assert.equal(transition(null, 'failed').journal, null);
  assert.equal(transition(null, 'failed').diagnostics[0].code, 'journal-invalid');
  assert.equal(transition({ state: 'banana' }, 'failed').ok, false);
  assert.equal(transition({}, 'failed').diagnostics[0].code, 'journal-invalid');
});

test('transition: does NOT mutate the input + returns a new object on success', () => {
  const j = journalIn('planned');
  const res = transition(j, 'snapshotted', { now: LATER_NOW });
  assert.equal(j.state, 'planned', 'input journal must be untouched');
  assert.equal(j.updatedAt, FIXED_ISO);
  assert.notEqual(res.journal, j, 'a new journal object is returned');
  // Documented contract for U12-U14: ops are shared by reference (never mutated).
  assert.equal(res.journal.ops, j.ops, 'ops array is shared by reference, not cloned');
});

test('transition: returns the SAME journal ref (unchanged) on an illegal move', () => {
  const j = journalIn('committed');
  const res = transition(j, 'applying');
  assert.equal(res.ok, false);
  assert.equal(res.journal, j);
});

test('transition: never throws on junk', () => {
  assert.doesNotThrow(() => transition(undefined, undefined));
  assert.doesNotThrow(() => transition(42, 'planned'));
});

// ── writeJournal / readJournal (real temp dir) ─────────────────────────────────────

test('ACCEPTANCE: create → write → read round-trip is byte-stable + still transitions', () => {
  const { dir, cleanup } = makeTmpDir();
  try {
    const { journal } = createJournal({
      snapshotId: FIXED_ID, targetClaudeDir: TARGET, plan: samplePlan(), now: FIXED_NOW,
    });
    const w = writeJournal({ stateDir: dir, snapshotId: FIXED_ID, journal, assertWritable: PASS_GATE });
    assert.equal(w.written, true);
    assert.equal(w.diagnostics.length, 0);
    assert.ok(w.path.replace(/\\/g, '/').endsWith(`snapshots/${FIXED_ID}/apply-journal.json`));

    const r = readJournal({ stateDir: dir, snapshotId: FIXED_ID });
    assert.equal(r.diagnostics.length, 0);
    assert.deepEqual(r.journal, journal);
    assert.equal(serialize(r.journal), serialize(journal)); // byte-stable golden property

    const t = transition(r.journal, 'snapshotted', { now: FIXED_NOW });
    assert.equal(t.ok, true);
    assert.equal(t.journal.state, 'snapshotted');
  } finally { cleanup(); }
});

test('writeJournal: REQUIRES an injected assertWritable (fail-safe)', () => {
  const { dir, cleanup } = makeTmpDir();
  try {
    const { journal } = createJournal({
      snapshotId: FIXED_ID, targetClaudeDir: TARGET, plan: {}, now: FIXED_NOW,
    });
    const res = writeJournal({ stateDir: dir, snapshotId: FIXED_ID, journal });
    assert.equal(res.written, false);
    assert.equal(res.diagnostics[0].code, 'journal-write-error');
    assert.match(res.diagnostics[0].message, /must be injected/);
  } finally { cleanup(); }
});

test('writeJournal: a denying gate blocks the write', () => {
  const { dir, cleanup } = makeTmpDir();
  try {
    const deny = () => { const e = new Error('nope'); e.code = 'write-forbidden'; throw e; };
    const { journal } = createJournal({
      snapshotId: FIXED_ID, targetClaudeDir: TARGET, plan: {}, now: FIXED_NOW,
    });
    const res = writeJournal({ stateDir: dir, snapshotId: FIXED_ID, journal, assertWritable: deny });
    assert.equal(res.written, false);
    assert.equal(res.diagnostics[0].code, 'journal-write-error');
    assert.match(res.diagnostics[0].message, /write gate denied/);
  } finally { cleanup(); }
});

test('writeJournal: rejects bad stateDir / snapshotId / journal', () => {
  const { journal } = createJournal({
    snapshotId: FIXED_ID, targetClaudeDir: TARGET, plan: {}, now: FIXED_NOW,
  });
  assert.equal(writeJournal({ stateDir: '', snapshotId: FIXED_ID, journal, assertWritable: PASS_GATE })
    .diagnostics[0].code, 'journal-write-error');
  assert.equal(writeJournal({ stateDir: '/s', snapshotId: 'bad', journal, assertWritable: PASS_GATE })
    .diagnostics[0].code, 'journal-snapshot-id-invalid');
  // Traversal-shaped id must be rejected on the WRITE side too (path-traversal guard).
  assert.equal(writeJournal({ stateDir: '/s', snapshotId: '../escape', journal, assertWritable: PASS_GATE })
    .diagnostics[0].code, 'journal-snapshot-id-invalid');
  assert.equal(writeJournal({ stateDir: '/s', snapshotId: FIXED_ID, journal: null, assertWritable: PASS_GATE })
    .diagnostics[0].code, 'journal-write-error');
});

test('writeJournal: verify-after-write catches a lying writer', () => {
  const { journal } = createJournal({
    snapshotId: FIXED_ID, targetClaudeDir: TARGET, plan: {}, now: FIXED_NOW,
  });
  const seams = { mkdir() {}, write() {}, read() { return 'different bytes'; } };
  const res = writeJournal({ stateDir: '/s', snapshotId: FIXED_ID, journal, assertWritable: PASS_GATE, seams });
  assert.equal(res.written, false);
  assert.equal(res.diagnostics[0].code, 'journal-write-verify-failed');
});

test('writeJournal: never throws + fails cleanly on a non-serializable journal', () => {
  // A non-sensitive op value left verbatim can be unserializable (BigInt/cyclic);
  // serialize() must not escape the never-throws contract.
  const journal = {
    journalVersion: 1, state: 'planned', snapshotId: FIXED_ID, targetClaudeDir: TARGET,
    ops: [{ kind: 'patch', pointer: 'model', before: 1n }],
  };
  const seams = { mkdir() {}, write() {}, read: () => '' };
  let res;
  assert.doesNotThrow(() => {
    res = writeJournal({ stateDir: '/s', snapshotId: FIXED_ID, journal, assertWritable: PASS_GATE, seams });
  });
  assert.equal(res.written, false);
  assert.equal(res.diagnostics[0].code, 'journal-write-error');
  assert.match(res.diagnostics[0].message, /serialize/);
});

test('readJournal: a missing journal → journal-not-found', () => {
  const { dir, cleanup } = makeTmpDir();
  try {
    const res = readJournal({ stateDir: dir, snapshotId: FIXED_ID });
    assert.equal(res.journal, null);
    assert.equal(res.diagnostics[0].code, 'journal-not-found');
  } finally { cleanup(); }
});

test('readJournal: malformed JSON → journal-unreadable', () => {
  const { dir, cleanup } = makeTmpDir();
  try {
    mkdirSync(snapshotDir(dir, FIXED_ID), { recursive: true });
    writeFileSync(journalPath(dir, FIXED_ID), '{ not json', 'utf8');
    const res = readJournal({ stateDir: dir, snapshotId: FIXED_ID });
    assert.equal(res.journal, null);
    assert.equal(res.diagnostics[0].code, 'journal-unreadable');
  } finally { cleanup(); }
});

test('readJournal: strips all top-level prototype-poisoning keys (__proto__/constructor/prototype)', () => {
  const payload = '{"__proto__":{"polluted":true},"constructor":{"c":1},"prototype":{"p":1},'
    + '"state":"planned","journalVersion":1}';
  const res = readJournal({ stateDir: '/s', snapshotId: FIXED_ID, readFn: () => payload });
  assert.equal(res.diagnostics.length, 0);
  assert.equal(res.journal.state, 'planned');
  assert.equal(({}).polluted, undefined, 'Object.prototype must not be polluted');
  assert.equal(Object.hasOwn(res.journal, 'constructor'), false);
  assert.equal(Object.hasOwn(res.journal, 'prototype'), false);
  assert.equal(Object.getPrototypeOf(res.journal), Object.prototype);
});

test('readJournal: refuses a FUTURE journal version', () => {
  const payload = JSON.stringify({ journalVersion: 999, state: 'planned' });
  const res = readJournal({ stateDir: '/s', snapshotId: FIXED_ID, readFn: () => payload });
  assert.equal(res.journal, null);
  assert.equal(res.diagnostics[0].code, 'journal-version-unsupported');
});

test('readJournal: rejects bad stateDir / snapshotId', () => {
  assert.equal(readJournal({ stateDir: '', snapshotId: FIXED_ID }).diagnostics[0].code, 'journal-read-error');
  assert.equal(readJournal({ stateDir: '/s', snapshotId: '../escape' }).diagnostics[0].code,
    'journal-snapshot-id-invalid');
});

test('readJournal: never throws on a throwing readFn', () => {
  assert.doesNotThrow(() => readJournal({
    stateDir: '/s', snapshotId: FIXED_ID, readFn() { throw new Error('boom'); },
  }));
  const res = readJournal({ stateDir: '/s', snapshotId: FIXED_ID, readFn() { throw new Error('boom'); } });
  assert.equal(res.diagnostics[0].code, 'journal-unreadable');
});
