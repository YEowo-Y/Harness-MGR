/**
 * P1.U13 (sub-unit B) — settings-merge.test.mjs
 *
 * Golden + boundary tests for mergeSettings(): the per-key settings resolver.
 * Covers the two headline criteria (permissions array-union; unknown key →
 * mergeConfidence 'unknown' with per-layer raw values), the scalar/object/hooks
 * strategies, boundary degradation (never throws), and determinism.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeSettings } from '../src/analysis/settings-merge.mjs';

/** Build a layer with the given name + raw settings object. */
const layer = (name, settings) => ({ name, settings });

const bySeverity = (diags, sev) => diags.filter((d) => d.severity === sev);

// ── A. HEADLINE: permissions array-union ────────────────────────────────────────

test('headline: permissions.allow is array-union across layers (dedup, first-seen order)', () => {
  const { effective, keys } = mergeSettings([
    layer('user', { permissions: { allow: ['a', 'b'] } }),
    layer('project', { permissions: { allow: ['b', 'c'] } }),
  ]);
  assert.deepEqual(effective.permissions.allow, ['a', 'b', 'c']);
  assert.equal(keys.permissions.mergeConfidence, 'known');
  assert.equal(keys.permissions.strategy, 'permissions-merge');
});

test('permissions: allow/ask/deny each union independently; other subkeys highest-wins', () => {
  const { effective } = mergeSettings([
    layer('user', { permissions: { allow: ['a'], ask: ['x'], deny: ['z'], defaultMode: 'plan' } }),
    layer('project', { permissions: { allow: ['a', 'b'], deny: ['z', 'y'], defaultMode: 'acceptEdits' } }),
  ]);
  assert.deepEqual(effective.permissions.allow, ['a', 'b']);
  assert.deepEqual(effective.permissions.ask, ['x']);
  assert.deepEqual(effective.permissions.deny, ['z', 'y']);
  // non-union subkey → highest (project) wins
  assert.equal(effective.permissions.defaultMode, 'acceptEdits');
});

// ── B. HEADLINE: unknown key → mergeConfidence 'unknown' ────────────────────────

test('headline: unknown top-level key → unknown confidence, no effective value, per-layer raw values', () => {
  const { effective, keys } = mergeSettings([
    layer('user', { wibble: 1 }),
    layer('project', { wibble: 2 }),
  ]);
  assert.equal(keys.wibble.mergeConfidence, 'unknown');
  assert.equal(keys.wibble.strategy, 'unknown');
  // No fabricated effective value for an unknown key.
  assert.equal(Object.prototype.hasOwnProperty.call(effective, 'wibble'), false);
  // Raw per-layer values recorded in layer order.
  assert.deepEqual(keys.wibble.perLayer, [
    { name: 'user', value: 1 },
    { name: 'project', value: 2 },
  ]);
});

// ── C. SCALAR HIGHEST-WINS ──────────────────────────────────────────────────────

test('scalar: highest layer that defines `model` wins', () => {
  const { effective, keys } = mergeSettings([
    layer('user', { model: 'opus' }),
    layer('project', { model: 'sonnet' }),
  ]);
  assert.equal(effective.model, 'sonnet');
  assert.equal(keys.model.strategy, 'scalar-highest');
  assert.equal(keys.model.mergeConfidence, 'known');
});

test('scalar: a lower-layer scalar still wins when no higher layer defines it', () => {
  const { effective } = mergeSettings([
    layer('user', { cleanupPeriodDays: 30 }),
    layer('project', { model: 'sonnet' }),
  ]);
  assert.equal(effective.cleanupPeriodDays, 30);
  assert.equal(effective.model, 'sonnet');
});

// ── D. OBJECT-MERGE LATER-WINS ──────────────────────────────────────────────────

test('env: object-merge, later layer wins per key', () => {
  const { effective, keys } = mergeSettings([
    layer('user', { env: { A: '1', B: '2' } }),
    layer('project', { env: { B: '3', C: '4' } }),
  ]);
  assert.deepEqual(effective.env, { A: '1', B: '3', C: '4' });
  assert.equal(keys.env.strategy, 'object-merge');
});

test('enabledPlugins: object-merge, later layer overrides the same key', () => {
  const { effective, keys } = mergeSettings([
    layer('user', { enabledPlugins: { 'plug-a': true, 'plug-b': false } }),
    layer('project', { enabledPlugins: { 'plug-b': true, 'plug-c': true } }),
  ]);
  assert.deepEqual(effective.enabledPlugins, { 'plug-a': true, 'plug-b': true, 'plug-c': true });
  assert.equal(keys.enabledPlugins.strategy, 'object-merge');
});

// ── E. HOOKS PER-EVENT CONCAT ───────────────────────────────────────────────────

test('hooks: per-event array concatenation in layer order (no dedup in Phase 1)', () => {
  const { effective, keys } = mergeSettings([
    layer('user', { hooks: { PreToolUse: [{ x: 1 }] } }),
    layer('project', { hooks: { PreToolUse: [{ x: 2 }] } }),
  ]);
  assert.deepEqual(effective.hooks.PreToolUse, [{ x: 1 }, { x: 2 }]);
  assert.equal(keys.hooks.strategy, 'hooks-concat');
  assert.equal(keys.hooks.mergeConfidence, 'known');
});

test('hooks: distinct events are kept separate; concat is per-event', () => {
  const { effective } = mergeSettings([
    layer('user', { hooks: { PreToolUse: [{ x: 1 }], Stop: [{ s: 1 }] } }),
    layer('project', { hooks: { PreToolUse: [{ x: 2 }] } }),
  ]);
  assert.deepEqual(effective.hooks.PreToolUse, [{ x: 1 }, { x: 2 }]);
  assert.deepEqual(effective.hooks.Stop, [{ s: 1 }]);
});

// ── F. BOUNDARY ──────────────────────────────────────────────────────────────────

test('boundary: null input → bad-input error, never throws, empty result', () => {
  let result;
  assert.doesNotThrow(() => { result = mergeSettings(/** @type {any} */ (null)); });
  assert.deepEqual(result.effective, {});
  assert.deepEqual(result.keys, {});
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0].code, 'settings-merge-bad-input');
  assert.equal(result.diagnostics[0].severity, 'error');
  assert.equal(result.diagnostics[0].phase, 'settings-merge');
});

test('boundary: numeric input → bad-input error, never throws', () => {
  let result;
  assert.doesNotThrow(() => { result = mergeSettings(/** @type {any} */ (42)); });
  assert.deepEqual(result.effective, {});
  assert.deepEqual(result.keys, {});
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0].code, 'settings-merge-bad-input');
});

test('boundary: empty layer array → empty effective/keys, no diagnostics', () => {
  const result = mergeSettings([]);
  assert.deepEqual(result.effective, {});
  assert.deepEqual(result.keys, {});
  assert.equal(result.diagnostics.length, 0);
});

test('boundary: a layer with non-object settings is skipped, never throws', () => {
  let result;
  assert.doesNotThrow(() => {
    result = mergeSettings(/** @type {any} */ ([
      layer('user', { model: 'opus' }),
      layer('broken', null),
      layer('also-broken', 42),
      { name: 'no-settings' },
      null,
      layer('project', { model: 'sonnet' }),
    ]));
  });
  // Only the two valid layers contribute; project (higher) wins the scalar.
  assert.equal(result.effective.model, 'sonnet');
  assert.equal(bySeverity(result.diagnostics, 'error').length, 0);
});

test('boundary: malformed permissions/hooks values are tolerated, never throw', () => {
  let result;
  assert.doesNotThrow(() => {
    result = mergeSettings([
      layer('user', { permissions: 'not-an-object', hooks: 42 }),
      layer('project', { permissions: { allow: ['a'] }, hooks: { PreToolUse: 'not-an-array' } }),
    ]);
  });
  // malformed layer contributes nothing; the valid allow survives
  assert.deepEqual(result.effective.permissions.allow, ['a']);
  // a declared-but-malformed hooks event is kept as a key with its value coerced
  // to an empty array (the event was present; only its value was malformed).
  assert.deepEqual(result.effective.hooks, { PreToolUse: [] });
  assert.equal(bySeverity(result.diagnostics, 'error').length, 0);
});

// ── G. DETERMINISM ───────────────────────────────────────────────────────────────

test('determinism: two identical calls produce identical results', () => {
  const layers = [
    layer('user', { permissions: { allow: ['a', 'b'] }, model: 'opus', env: { A: '1' }, wibble: 1 }),
    layer('project', { permissions: { allow: ['b', 'c'] }, model: 'sonnet', env: { A: '2', B: '3' }, wibble: 2 }),
  ];
  const r1 = mergeSettings(layers);
  const r2 = mergeSettings(layers);
  assert.deepEqual(r1, r2);
});

// ── H. HARDENING + IMMUTABILITY + SINGLE-LAYER ──────────────────────────────────

test('hardening: prototype-poisoning keys (__proto__) are skipped, no pollution', () => {
  // JSON.parse makes `__proto__` an OWN enumerable key (unlike an object literal),
  // which is exactly how a hostile/malformed settings.json would arrive.
  const malicious = JSON.parse('{"__proto__":{"polluted":true},"model":"opus","env":{"__proto__":{"p":1},"A":"1"}}');
  let result;
  assert.doesNotThrow(() => { result = mergeSettings([layer('user', malicious)]); });
  // No global prototype pollution; the result object keeps a clean prototype.
  assert.equal(({}).polluted, undefined);
  assert.equal(Object.getPrototypeOf(result.effective), Object.prototype);
  // `__proto__` never becomes a reported key.
  assert.equal(Object.prototype.hasOwnProperty.call(result.keys, '__proto__'), false);
  // Legitimate keys still resolve; the env `__proto__` subkey is dropped.
  assert.equal(result.effective.model, 'opus');
  assert.deepEqual(result.effective.env, { A: '1' });
});

test('immutability: input layers are not mutated', () => {
  const layers = [
    layer('user', { permissions: { allow: ['a', 'b'] }, env: { A: '1' }, hooks: { PreToolUse: [{ x: 1 }] } }),
    layer('project', { permissions: { allow: ['b', 'c'] }, env: { B: '2' }, hooks: { PreToolUse: [{ x: 2 }] } }),
  ];
  const snapshot = structuredClone(layers);
  mergeSettings(layers);
  assert.deepEqual(layers, snapshot);
});

test('single layer: known keys resolve; an unknown key is still excluded from effective', () => {
  const { effective, keys } = mergeSettings([
    layer('user', { model: 'opus', permissions: { allow: ['a'] }, wibble: 9 }),
  ]);
  assert.equal(effective.model, 'opus');
  assert.deepEqual(effective.permissions.allow, ['a']);
  assert.equal(Object.prototype.hasOwnProperty.call(effective, 'wibble'), false);
  assert.equal(keys.wibble.mergeConfidence, 'unknown');
});
