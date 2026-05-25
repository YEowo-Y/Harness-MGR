/**
 * P2.U5b-2 — doctor-hook-checks.test.mjs
 *
 * Tests for the two pure hook-fact doctor checks:
 *   #3 hook-file-exists       — kind:'file' + status:'missing' → error
 *   #5 hook-external-command  — kind:'external' + status:'missing' → warn
 *
 * Exercised through the public runDoctor() API. 'indeterminate' status MUST
 * NOT be flagged (it means a runtime variable could not be expanded at probe
 * time — flagging it would be a false positive).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { runDoctor } from '../src/analysis/doctor/index.mjs';

const byCode = (d, c) => d.filter((x) => x.code === c);

/** @param {Partial<import('../src/discovery/probe-hooks.mjs').HookFact>} over */
const fact = (over) => ({
  event: 'PreToolUse',
  command: 'node x',
  kind: 'file',
  target: '/hook/x.mjs',
  status: 'found',
  ...over,
});

// ── A. #3 hook-file-exists ────────────────────────────────────────────────────

test('#3: kind:file + status:missing → exactly one hook-file-exists error', () => {
  const r = runDoctor({ hookFacts: [fact({ kind: 'file', status: 'missing', event: 'PreToolUse', target: '/h/x.mjs', command: 'node x' })] });
  const found = byCode(r.diagnostics, 'hook-file-exists');
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, 'error');
  assert.match(found[0].message, /PreToolUse/);
  assert.match(found[0].message, /\/h\/x\.mjs/);
  assert.equal(found[0].phase, 'doctor');
  assert.equal(typeof found[0].fix, 'string');
});

test('#3: kind:file + status:found → 0 findings', () => {
  const r = runDoctor({ hookFacts: [fact({ kind: 'file', status: 'found' })] });
  assert.equal(byCode(r.diagnostics, 'hook-file-exists').length, 0);
});

test('#3: kind:file + status:indeterminate → 0 findings (must NOT be flagged)', () => {
  const r = runDoctor({ hookFacts: [fact({ kind: 'file', status: 'indeterminate' })] });
  assert.equal(byCode(r.diagnostics, 'hook-file-exists').length, 0);
});

test('#3: kind:external + status:missing → 0 hook-file-exists findings (kind filter)', () => {
  const r = runDoctor({ hookFacts: [fact({ kind: 'external', status: 'missing', target: 'some-cmd' })] });
  assert.equal(byCode(r.diagnostics, 'hook-file-exists').length, 0);
});

test('#3: two missing file facts → sorted by message', () => {
  const r = runDoctor({
    hookFacts: [
      fact({ kind: 'file', status: 'missing', event: 'Stop', target: '/z/hook.mjs' }),
      fact({ kind: 'file', status: 'missing', event: 'PreToolUse', target: '/a/hook.mjs' }),
    ],
  });
  const found = byCode(r.diagnostics, 'hook-file-exists');
  assert.equal(found.length, 2);
  // sorted by message ascending — "PreToolUse" < "Stop"
  assert.match(found[0].message, /PreToolUse/);
  assert.match(found[1].message, /Stop/);
});

// ── B. #5 hook-external-command ───────────────────────────────────────────────

test('#5: kind:external + status:missing → exactly one hook-external-command warn', () => {
  const r = runDoctor({ hookFacts: [fact({ kind: 'external', status: 'missing', event: 'PreToolUse', target: 'any-buddy', command: 'any-buddy apply' })] });
  const found = byCode(r.diagnostics, 'hook-external-command');
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, 'warn');
  assert.match(found[0].message, /PreToolUse/);
  assert.match(found[0].message, /any-buddy/);
  assert.equal(found[0].phase, 'doctor');
  assert.equal(typeof found[0].fix, 'string');
});

test('#5: kind:external + status:found → 0 findings', () => {
  const r = runDoctor({ hookFacts: [fact({ kind: 'external', status: 'found', target: 'node' })] });
  assert.equal(byCode(r.diagnostics, 'hook-external-command').length, 0);
});

test('#5: kind:external + status:indeterminate → 0 findings (must NOT be flagged)', () => {
  const r = runDoctor({ hookFacts: [fact({ kind: 'external', status: 'indeterminate', target: 'node' })] });
  assert.equal(byCode(r.diagnostics, 'hook-external-command').length, 0);
});

test('#5: kind:file + status:missing → 0 hook-external-command findings (kind filter)', () => {
  const r = runDoctor({ hookFacts: [fact({ kind: 'file', status: 'missing', target: '/missing/script.mjs' })] });
  assert.equal(byCode(r.diagnostics, 'hook-external-command').length, 0);
});

test('#5: two missing external facts → sorted by message', () => {
  const r = runDoctor({
    hookFacts: [
      fact({ kind: 'external', status: 'missing', event: 'Stop', target: 'zebra-cmd' }),
      fact({ kind: 'external', status: 'missing', event: 'PreToolUse', target: 'alpha-cmd' }),
    ],
  });
  const found = byCode(r.diagnostics, 'hook-external-command');
  assert.equal(found.length, 2);
  // sorted by message ascending — "PreToolUse" < "Stop"
  assert.match(found[0].message, /PreToolUse/);
  assert.match(found[1].message, /Stop/);
});

// ── C. INTEGRATION ────────────────────────────────────────────────────────────

test('integration: mixed file+external missing facts → both checks fire; registry is [1,2,3,5,18,6,7,8,9,10,11,12,22,23,13,14,16,20,21,25,17,24,4]', () => {
  const r = runDoctor({
    hookFacts: [
      fact({ kind: 'file', status: 'missing', event: 'E', target: '/x', command: 'c' }),
      fact({ kind: 'external', status: 'missing', event: 'E', target: 't', command: 'c' }),
    ],
  });

  assert.deepEqual(r.checks.map((c) => c.id), [1, 2, 3, 5, 18, 6, 7, 8, 9, 10, 11, 12, 22, 23, 13, 14, 16, 20, 21, 25, 17, 24, 4, 15]);
  assert.equal(r.probeLevel, 'passive');

  const s3 = r.checks.find((c) => c.id === 3);
  assert.ok(s3.ran);
  assert.equal(s3.findings, 1);

  const s5 = r.checks.find((c) => c.id === 5);
  assert.ok(s5.ran);
  assert.equal(s5.findings, 1);

  assert.equal(byCode(r.diagnostics, 'hook-file-exists')[0].severity, 'error');
  assert.equal(byCode(r.diagnostics, 'hook-external-command')[0].severity, 'warn');
});

// ── D. NEVER-THROWS boundary ──────────────────────────────────────────────────

test('never-throws: hookFacts is a non-array string → no throw, 0 hook findings', () => {
  let r;
  assert.doesNotThrow(() => { r = runDoctor({ hookFacts: /** @type {any} */ ('x') }); });
  assert.equal(byCode(r.diagnostics, 'hook-file-exists').length, 0);
  assert.equal(byCode(r.diagnostics, 'hook-external-command').length, 0);
});

test('never-throws: hookFacts contains null/number/empty-object entries → no throw, 0 hook findings', () => {
  let r;
  assert.doesNotThrow(() => { r = runDoctor({ hookFacts: /** @type {any} */ ([null, 5, {}]) }); });
  assert.equal(byCode(r.diagnostics, 'hook-file-exists').length, 0);
  assert.equal(byCode(r.diagnostics, 'hook-external-command').length, 0);
});
