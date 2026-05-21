import test from 'node:test';
import assert from 'node:assert/strict';
import { ok, err, isOk, isErr } from '../src/lib/result.mjs';

test('ok wraps a value as a success result', () => {
  const r = ok(42);
  assert.deepEqual(r, { ok: true, value: 42 });
  assert.equal(isOk(r), true);
  assert.equal(isErr(r), false);
});

test('err wraps a diagnostic as a failure result', () => {
  const d = { severity: 'error', code: 'read-failed', message: 'ENOENT' };
  const r = err(d);
  assert.deepEqual(r, { ok: false, error: d });
  assert.equal(isErr(r), true);
  assert.equal(isOk(r), false);
});

test('isOk / isErr are exhaustive and tolerate junk', () => {
  assert.equal(isOk(ok(null)), true);
  assert.equal(isErr(err({ severity: 'error', code: 'x', message: '' })), true);
  assert.equal(isOk(/** @type {any} */ (null)), false);
  assert.equal(isErr(/** @type {any} */ (undefined)), false);
  assert.equal(isOk(/** @type {any} */ ({})), false);
});

test('ok preserves falsy values distinctly from failure', () => {
  const r = ok(false);
  assert.equal(isOk(r), true);
  assert.equal(r.value, false);
});
