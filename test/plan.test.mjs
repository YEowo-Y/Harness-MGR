import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  emptyPlan, addOp, PLAN_VERSION,
  SENSITIVE_KEY_PATTERNS, isSensitivePointer, redactPatchOp,
} from '../src/lib/plan.mjs';

/** Recompute the redaction hash the same way plan.mjs does, for assertions. */
function sha256(value) {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  return createHash('sha256').update(typeof s === 'string' ? s : String(value), 'utf8').digest('hex');
}

test('emptyPlan produces a versioned dry-run plan', () => {
  const p = emptyPlan('remove skill foo');
  assert.equal(p.planVersion, 1);
  assert.equal(PLAN_VERSION, 1);
  assert.equal(p.command, 'remove skill foo');
  assert.deepEqual(p.ops, []);
  assert.equal(p.apply, false);
  assert.equal('wouldSnapshot' in p, false);
});

test('emptyPlan honors apply + wouldSnapshot options', () => {
  const p = emptyPlan('rollback 2026-05-21T00-00-00Z', {
    apply: true,
    wouldSnapshot: '2026-05-21T00-00-00Z',
  });
  assert.equal(p.apply, true);
  assert.equal(p.wouldSnapshot, '2026-05-21T00-00-00Z');
});

test('emptyPlan tolerates a non-string command', () => {
  const p = emptyPlan(/** @type {any} */ (null));
  assert.equal(p.command, '');
  assert.equal(p.planVersion, 1);
});

test('addOp appends an op and is chainable, returning the same plan', () => {
  const p = emptyPlan('demo');
  const op = { kind: 'create', target: '/c/x/y.md', summary: 'create y.md', content: 'hi' };
  const returned = addOp(p, op);
  assert.equal(returned, p);
  assert.equal(p.ops.length, 1);
  assert.deepEqual(p.ops[0], op);
});

test('addOp ignores malformed ops without throwing', () => {
  const p = emptyPlan('demo');
  assert.doesNotThrow(() => addOp(p, /** @type {any} */ (null)));
  assert.doesNotThrow(() => addOp(p, /** @type {any} */ (42)));
  assert.equal(p.ops.length, 0);
});

// ── sensitive-key redaction (P3.U10) ──────────────────────────────────────────

test('isSensitivePointer matches each pattern, case-insensitively', () => {
  for (const word of SENSITIVE_KEY_PATTERNS) {
    assert.equal(isSensitivePointer(`/a/${word}/b`), true, `lower ${word}`);
    assert.equal(isSensitivePointer(`/a/${word.toUpperCase()}`), true, `upper ${word}`);
  }
  // realistic pointers
  assert.equal(isSensitivePointer('/mcpServers/foo/env/API_KEY'), true);
  assert.equal(isSensitivePointer('/auth/githubToken'), true);
  assert.equal(isSensitivePointer('/permissions/allow/0'), false);
  assert.equal(isSensitivePointer('/model'), false);
});

test('isSensitivePointer rejects non-string / empty without throwing', () => {
  for (const bad of [null, undefined, 42, {}, [], '']) {
    assert.equal(isSensitivePointer(/** @type {any} */ (bad)), false);
  }
});

test('redactPatchOp redacts before+after with correct sha256 when pointer is sensitive', () => {
  const op = {
    kind: 'patch', target: '/c/x/settings.json', summary: 'rotate key',
    pointer: '/env/API_KEY', before: 'sk-old-secret', after: 'sk-new-secret',
  };
  const out = redactPatchOp(op);
  assert.notEqual(out, op, 'returns a copy when redacting');
  assert.deepEqual(out.before, { redacted: true, sha256: sha256('sk-old-secret') });
  assert.deepEqual(out.after, { redacted: true, sha256: sha256('sk-new-secret') });
  // non-redacted fields preserved
  assert.equal(out.kind, 'patch');
  assert.equal(out.pointer, '/env/API_KEY');
  // original op untouched (no mutation)
  assert.equal(op.before, 'sk-old-secret');
});

test('redactPatchOp leaves a non-sensitive op unchanged (same reference, raw values)', () => {
  const op = {
    kind: 'patch', target: '/c/x/settings.json', summary: 'set model',
    pointer: '/model', before: 'sonnet', after: 'opus',
  };
  assert.equal(redactPatchOp(op), op, 'same reference when not sensitive');
});

test('redactPatchOp redacts only the present side (after-only)', () => {
  const op = { kind: 'patch', pointer: '/secret', after: 'value' };
  const out = redactPatchOp(op);
  assert.deepEqual(out.after, { redacted: true, sha256: sha256('value') });
  assert.equal('before' in out, false, 'absent before is not fabricated');
});

test('redactPatchOp hashes non-string values via JSON form', () => {
  const op = { kind: 'patch', pointer: '/token', before: { a: 1 }, after: [1, 2] };
  const out = redactPatchOp(op);
  assert.equal(out.before.sha256, sha256({ a: 1 }));
  assert.equal(out.after.sha256, sha256([1, 2]));
});

test('redactPatchOp never throws on junk / unserializable values', () => {
  assert.doesNotThrow(() => assert.equal(redactPatchOp(null), null));
  assert.doesNotThrow(() => assert.equal(redactPatchOp(/** @type {any} */ (42)), 42));
  assert.doesNotThrow(() => redactPatchOp({ pointer: '/secret', before: undefined, after: 10n }));
  // a cyclic after value must not throw (JSON.stringify would) — falls back to a sentinel
  const cyclic = {}; cyclic.self = cyclic;
  assert.doesNotThrow(() => {
    const out = redactPatchOp({ pointer: '/key', after: cyclic });
    assert.equal(out.after.redacted, true);
    assert.equal(typeof out.after.sha256, 'string');
  });
});

test('redactPatchOp: unserializable value does NOT hash-collide with its String() text (M1)', () => {
  const a = redactPatchOp({ pointer: '/key', after: undefined }).after.sha256;
  const b = redactPatchOp({ pointer: '/key', after: 'undefined' }).after.sha256;
  assert.notEqual(a, b, 'the value undefined must not collide with the string "undefined"');
});

test('redactPatchOp: string redaction matches a known golden sha256 (contract anchor)', () => {
  // Independent of the local sha256() helper: pins the exact digest of a known
  // string so the hashing contract cannot silently drift.
  const out = redactPatchOp({ kind: 'patch', pointer: '/env/API_KEY', before: 'sk-old-secret' });
  assert.equal(out.before.sha256, '122abf2ef84afca4c7e2344f443fd7a0c7636b8fde78b5bc155b4575f5014aa3');
});
