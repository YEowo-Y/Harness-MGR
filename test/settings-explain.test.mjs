/**
 * Falsifiable unit tests for explainEffective() in settings-merge.mjs.
 *
 * Each test pins a SPECIFIC value (winner name, perLayer contents, etc.) so that
 * a mutation — e.g. picking the wrong layer as winner — turns the assertion RED.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { explainEffective } from '../src/analysis/settings-merge.mjs';

/** Build a minimal layer. */
const layer = (name, settings) => ({ name, settings });

// ── 1. scalar-highest: winner is the LAST present layer ─────────────────────────

test('scalar-highest model: winner is the last (highest) layer, perLayer lists both in order', () => {
  const ex = explainEffective([
    layer('user', { model: 'sonnet' }),
    layer('local', { model: 'opus' }),
  ]);
  const km = ex.keys.model;
  assert.equal(km.strategy, 'scalar-highest');
  assert.equal(km.mergeConfidence, 'known');
  // Merged value from the engine — highest layer wins.
  assert.equal(km.value, 'opus');
  // Winner is the deciding layer name.
  assert.equal(km.winner, 'local', 'winner must be the LAST (highest) layer');
  // perLayer covers both layers in lowest→highest order.
  assert.deepEqual(km.perLayer, [
    { name: 'user', value: 'sonnet' },
    { name: 'local', value: 'opus' },
  ]);
});

test('scalar-highest: picking the FIRST layer as winner must be RED (mutation guard)', () => {
  const ex = explainEffective([
    layer('user', { model: 'sonnet' }),
    layer('local', { model: 'opus' }),
  ]);
  // If someone mutates the winner logic to pick perLayer[0], this assertion fires.
  assert.notEqual(ex.keys.model.winner, 'user', 'winner must NOT be the user (lower) layer');
});

test('scalar-highest: only one layer defines the key → winner is that layer', () => {
  const ex = explainEffective([
    layer('user', { model: 'haiku' }),
    layer('local', { env: { X: '1' } }),
  ]);
  const km = ex.keys.model;
  assert.equal(km.winner, 'user');
  assert.deepEqual(km.perLayer, [{ name: 'user', value: 'haiku' }]);
});

// ── 2. object-merge: winner null, perLayer lists each layer's raw object ─────────

test('object-merge env: winner null, perLayer lists both layers raw env objects', () => {
  const ex = explainEffective([
    layer('user', { env: { A: '1' } }),
    layer('local', { env: { B: '2' } }),
  ]);
  const km = ex.keys.env;
  assert.equal(km.strategy, 'object-merge');
  assert.equal(km.winner, null, 'object-merge has no single winner');
  assert.equal(km.perLayer.length, 2);
  assert.deepEqual(km.perLayer[0], { name: 'user', value: { A: '1' } });
  assert.deepEqual(km.perLayer[1], { name: 'local', value: { B: '2' } });
  // Merged value is the engine's merged object.
  assert.deepEqual(km.value, { A: '1', B: '2' });
});

// ── 3. permissions-merge: winner null ────────────────────────────────────────────

test('permissions-merge: winner null, perLayer lists contributing layers', () => {
  const ex = explainEffective([
    layer('user', { permissions: { allow: ['a'] } }),
    layer('local', { permissions: { allow: ['b'] } }),
  ]);
  const km = ex.keys.permissions;
  assert.equal(km.strategy, 'permissions-merge');
  assert.equal(km.winner, null);
  assert.equal(km.perLayer.length, 2);
  assert.equal(km.perLayer[0].name, 'user');
  assert.equal(km.perLayer[1].name, 'local');
});

// ── 4. hooks-concat: winner null ─────────────────────────────────────────────────

test('hooks-concat: winner null, perLayer lists each layer', () => {
  const ex = explainEffective([
    layer('user', { hooks: { PreToolUse: [{ x: 1 }] } }),
    layer('local', { hooks: { PreToolUse: [{ x: 2 }] } }),
  ]);
  const km = ex.keys.hooks;
  assert.equal(km.strategy, 'hooks-concat');
  assert.equal(km.winner, null);
  assert.equal(km.perLayer.length, 2);
});

// ── 5. unknown key: mergeConfidence 'unknown', winner null, perLayer raw values ──

test('unknown key fooBar: mergeConfidence unknown, winner null, perLayer raw values, no fabricated effective value', () => {
  const ex = explainEffective([
    layer('user', { fooBar: 42 }),
    layer('local', { fooBar: 99 }),
  ]);
  const km = ex.keys.fooBar;
  assert.equal(km.mergeConfidence, 'unknown');
  assert.equal(km.strategy, 'unknown');
  assert.equal(km.winner, null);
  assert.deepEqual(km.perLayer, [
    { name: 'user', value: 42 },
    { name: 'local', value: 99 },
  ]);
  // The engine does not fabricate an effective value for unknown keys.
  assert.equal(Object.prototype.hasOwnProperty.call(km, 'value'), false);
});

// ── 6. never-throws on garbage input ─────────────────────────────────────────────

test('never-throws on non-array input → empty keys', () => {
  let result;
  assert.doesNotThrow(() => { result = explainEffective(/** @type {any} */ (null)); });
  assert.deepEqual(result.keys, {});
  assert.deepEqual(result.diagnostics, []);
});

test('never-throws on empty array → empty keys', () => {
  let result;
  assert.doesNotThrow(() => { result = explainEffective([]); });
  assert.deepEqual(result.keys, {});
});

test('never-throws on array with null/invalid layer entries', () => {
  let result;
  assert.doesNotThrow(() => {
    result = explainEffective(/** @type {any} */ ([null, undefined, 42, layer('ok', { model: 'sonnet' })]));
  });
  assert.equal(result.keys.model.winner, 'ok');
});

// ── 7. proto-safety: __proto__ key does not pollute output ───────────────────────

test('proto-safety: __proto__ top key does not pollute output keys or result object', () => {
  const poisoned = JSON.parse('{"__proto__":{"polluted":true},"model":"haiku"}');
  let result;
  assert.doesNotThrow(() => { result = explainEffective([layer('user', poisoned)]); });
  assert.equal(({}).polluted, undefined, 'prototype must not be polluted');
  assert.equal(Object.prototype.hasOwnProperty.call(result.keys, '__proto__'), false);
  assert.equal(result.keys.model.winner, 'user');
});

// ── 8. diagnostics always empty (no duplication) ─────────────────────────────────

test('explainEffective returns diagnostics:[] to avoid duplicating mergeSettings diagnostics', () => {
  const ex = explainEffective([layer('user', { model: 'sonnet' })]);
  assert.deepEqual(ex.diagnostics, []);
});

// ── 9. keys not defined in any layer have no perLayer entry ──────────────────────

test('a key absent from a layer is NOT listed in that layer\'s perLayer entry', () => {
  const ex = explainEffective([
    layer('user', { model: 'opus' }),
    layer('local', { env: { X: '1' } }),
  ]);
  // model is only in user layer
  assert.equal(ex.keys.model.perLayer.length, 1);
  assert.equal(ex.keys.model.perLayer[0].name, 'user');
  // env is only in local layer
  assert.equal(ex.keys.env.perLayer.length, 1);
  assert.equal(ex.keys.env.perLayer[0].name, 'local');
});
