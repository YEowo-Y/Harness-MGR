import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyPlan, addOp, PLAN_VERSION } from '../src/lib/plan.mjs';

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
