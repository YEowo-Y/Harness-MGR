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
  WRITABLE_KINDS, DELETABLE_KINDS, DIR_DELETABLE_KINDS, CONFIG_EDIT_KINDS, CONFIG_BLOCK_DELETE_KINDS, JSON_EDIT_KINDS, JSON_MAP_SET_KINDS, invalidOpReason,
} from '../src/ops/apply-op-kinds.mjs';

/** A skill-block selector (the only shape config-block-delete accepts). */
const SKILL_SEL = { kind: 'skill', match: { field: 'name', value: 'foo' } };

test('kind tables are the expected frozen values', () => {
  assert.deepEqual([...WRITABLE_KINDS], ['create', 'overwrite']);
  assert.deepEqual([...DELETABLE_KINDS], ['delete']);
  assert.deepEqual([...DIR_DELETABLE_KINDS], ['delete-dir']);
  assert.deepEqual([...CONFIG_EDIT_KINDS], ['config-edit']);
  assert.deepEqual([...CONFIG_BLOCK_DELETE_KINDS], ['config-block-delete']);
  assert.deepEqual([...JSON_EDIT_KINDS], ['json-edit']);
  assert.deepEqual([...JSON_MAP_SET_KINDS], ['json-map-set']);
});

test('valid ops of every kind return null', () => {
  assert.equal(invalidOpReason({ kind: 'create', target: '/x', content: 'c' }), null);
  assert.equal(invalidOpReason({ kind: 'overwrite', target: '/x', content: '' }), null);
  assert.equal(invalidOpReason({ kind: 'delete', target: '/x' }), null);
  assert.equal(invalidOpReason({ kind: 'delete-dir', target: '/x' }), null);
  assert.equal(invalidOpReason({ kind: 'config-edit', target: '/x', selector: { kind: 'plugin', name: 'a@b' }, desired: false }), null);
  assert.equal(invalidOpReason({ kind: 'config-block-delete', target: '/x', selector: SKILL_SEL }), null);
  assert.equal(invalidOpReason({ kind: 'json-edit', target: '/x', selector: { key: 'a@b' }, desired: true }), null);
  assert.equal(invalidOpReason({ kind: 'json-map-set', target: '/x', selector: { mapKey: 'skillOverrides', memberKey: 'tdd' }, value: 'off' }), null);
});

test('an unsupported kind → apply-op-kind-unsupported, message lists config-edit + config-block-delete', () => {
  const r = invalidOpReason({ kind: 'patch', target: '/x' });
  assert.equal(r.code, 'apply-op-kind-unsupported');
  assert.match(r.message, /config-edit/);
  assert.match(r.message, /config-block-delete/);
  assert.match(r.message, /json-edit/);
  assert.match(r.message, /json-map-set/);
});

test('every kind needs a non-empty target', () => {
  assert.equal(invalidOpReason({ kind: 'config-edit', selector: {}, desired: true }).code, 'apply-op-invalid');
  assert.equal(invalidOpReason({ kind: 'config-block-delete', selector: SKILL_SEL }).code, 'apply-op-invalid');
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

test('config-block-delete op: selector must be an object, content + desired both forbidden', () => {
  const base = { kind: 'config-block-delete', target: '/x', selector: SKILL_SEL };
  assert.equal(invalidOpReason(base), null); // the clean shape passes
  assert.match(invalidOpReason({ ...base, selector: null }).message, /selector object/);
  assert.match(invalidOpReason({ ...base, selector: 'x' }).message, /selector object/);
  assert.match(invalidOpReason({ ...base, content: 'x' }).message, /must not carry content/);
  assert.match(invalidOpReason({ ...base, content: '' }).message, /must not carry content/);
  // desired is meaningless for a whole-block delete — carrying it is an error, even `false`.
  assert.match(invalidOpReason({ ...base, desired: false }).message, /must not carry desired/);
  assert.match(invalidOpReason({ ...base, desired: true }).message, /must not carry desired/);
});

test('json-edit op: desired must be boolean, selector must be an object, content forbidden', () => {
  const base = { kind: 'json-edit', target: '/x', selector: { key: 'a@b' }, desired: false };
  assert.equal(invalidOpReason(base), null); // the clean shape passes
  assert.match(invalidOpReason({ ...base, desired: 'no' }).message, /boolean desired/);
  assert.match(invalidOpReason({ ...base, desired: undefined }).message, /boolean desired/);
  assert.match(invalidOpReason({ ...base, selector: null }).message, /selector object/);
  assert.match(invalidOpReason({ ...base, selector: 'x' }).message, /selector object/);
  assert.match(invalidOpReason({ ...base, content: 'x' }).message, /must not carry content/);
  assert.match(invalidOpReason({ ...base, content: '' }).message, /must not carry content/);
});

test('json-map-set op: selector needs mapKey+memberKey, value must be string, content+desired forbidden', () => {
  const base = { kind: 'json-map-set', target: '/x', selector: { mapKey: 'skillOverrides', memberKey: 'tdd' }, value: 'off' };
  assert.equal(invalidOpReason(base), null); // the clean shape passes
  assert.match(invalidOpReason({ ...base, selector: null }).message, /selector object/);
  assert.match(invalidOpReason({ ...base, selector: { mapKey: 'skillOverrides' } }).message, /mapKey and memberKey/);
  assert.match(invalidOpReason({ ...base, selector: { memberKey: 'tdd' } }).message, /mapKey and memberKey/);
  assert.match(invalidOpReason({ ...base, selector: { mapKey: '', memberKey: 'tdd' } }).message, /mapKey and memberKey/);
  assert.match(invalidOpReason({ ...base, value: undefined }).message, /string value/);
  assert.match(invalidOpReason({ ...base, value: 5 }).message, /string value/);
  assert.match(invalidOpReason({ ...base, content: 'x' }).message, /must not carry content/);
  // desired is meaningless for a string-map set — carrying it is an error, even `false`.
  assert.match(invalidOpReason({ ...base, desired: false }).message, /must not carry desired/);
});

test('create/overwrite needs string content', () => {
  assert.equal(invalidOpReason({ kind: 'create', target: '/x' }).code, 'apply-op-invalid');
  assert.match(invalidOpReason({ kind: 'overwrite', target: '/x' }).message, /string content/);
});

test('invalidOpReason never throws on garbage', () => {
  for (const g of [null, undefined, 42, 'x', {}, { kind: 'config-edit' }, { kind: 'config-block-delete' }, { kind: 123 }]) {
    assert.doesNotThrow(() => invalidOpReason(g));
  }
});
