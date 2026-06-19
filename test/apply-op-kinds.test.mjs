/**
 * Tests for src/ops/apply-op-kinds.mjs (extracted from apply.mjs — P6 config-edit unit).
 *
 * Pure oracle for the op-kind tables + invalidOpReason, including the new config-edit
 * arm (boolean desired + selector object + NO content) and that the kind-unsupported
 * message now lists config-edit. Never-throws on garbage.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WRITABLE_KINDS, DELETABLE_KINDS, DIR_DELETABLE_KINDS, CONFIG_EDIT_KINDS, invalidOpReason,
} from '../src/ops/apply-op-kinds.mjs';

test('kind tables are the expected frozen values', () => {
  assert.deepEqual([...WRITABLE_KINDS], ['create', 'overwrite']);
  assert.deepEqual([...DELETABLE_KINDS], ['delete']);
  assert.deepEqual([...DIR_DELETABLE_KINDS], ['delete-dir']);
  assert.deepEqual([...CONFIG_EDIT_KINDS], ['config-edit']);
});

test('valid ops of every kind return null', () => {
  assert.equal(invalidOpReason({ kind: 'create', target: '/x', content: 'c' }), null);
  assert.equal(invalidOpReason({ kind: 'overwrite', target: '/x', content: '' }), null);
  assert.equal(invalidOpReason({ kind: 'delete', target: '/x' }), null);
  assert.equal(invalidOpReason({ kind: 'delete-dir', target: '/x' }), null);
  assert.equal(invalidOpReason({ kind: 'config-edit', target: '/x', selector: { kind: 'plugin', name: 'a@b' }, desired: false }), null);
});

test('an unsupported kind → apply-op-kind-unsupported, message lists config-edit', () => {
  const r = invalidOpReason({ kind: 'patch', target: '/x' });
  assert.equal(r.code, 'apply-op-kind-unsupported');
  assert.match(r.message, /config-edit/);
});

test('every kind needs a non-empty target', () => {
  assert.equal(invalidOpReason({ kind: 'config-edit', selector: {}, desired: true }).code, 'apply-op-invalid');
  assert.equal(invalidOpReason({ kind: 'delete', target: '' }).code, 'apply-op-invalid');
});

test('config-edit op: desired must be boolean, selector must be an object, content forbidden', () => {
  const base = { kind: 'config-edit', target: '/x', selector: { kind: 'plugin', name: 'a@b' }, desired: false };
  assert.match(invalidOpReason({ ...base, desired: 'no' }).message, /boolean desired/);
  assert.match(invalidOpReason({ ...base, desired: 1 }).message, /boolean desired/);
  assert.match(invalidOpReason({ ...base, selector: null }).message, /selector object/);
  assert.match(invalidOpReason({ ...base, selector: 'x' }).message, /selector object/);
  assert.match(invalidOpReason({ ...base, content: 'x' }).message, /must not carry content/);
  assert.match(invalidOpReason({ ...base, content: '' }).message, /must not carry content/);
});

test('create/overwrite needs string content', () => {
  assert.equal(invalidOpReason({ kind: 'create', target: '/x' }).code, 'apply-op-invalid');
  assert.match(invalidOpReason({ kind: 'overwrite', target: '/x' }).message, /string content/);
});

test('invalidOpReason never throws on garbage', () => {
  for (const g of [null, undefined, 42, 'x', {}, { kind: 'config-edit' }, { kind: 123 }]) {
    assert.doesNotThrow(() => invalidOpReason(g));
  }
});
