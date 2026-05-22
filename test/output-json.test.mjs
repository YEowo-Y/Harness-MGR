/**
 * P1.U14 (sub-unit B) — output-json.test.mjs
 *
 * Golden + boundary tests for the JSON output adapter: the versioned envelope,
 * the deterministic stable-stringifier (sorted object keys, preserved array
 * order, insertion-order independence), formatJson, and the never-throws
 * degradation to an error envelope on unserializable input.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  JSON_ENVELOPE_VERSION,
  toEnvelope,
  stableStringify,
  formatJson,
} from '../src/output/json.mjs';

// ── A. ENVELOPE ──────────────────────────────────────────────────────────────────

test('version constant is 1', () => {
  assert.equal(JSON_ENVELOPE_VERSION, 1);
});

test('toEnvelope spreads a plain object alongside version', () => {
  assert.deepEqual(toEnvelope({ a: 1 }), { version: 1, a: 1 });
});

test('toEnvelope nests an array under data', () => {
  assert.deepEqual(toEnvelope([1, 2]), { version: 1, data: [1, 2] });
});

test('toEnvelope nests a primitive under data', () => {
  assert.deepEqual(toEnvelope('x'), { version: 1, data: 'x' });
});

test('toEnvelope nests null under data (null is not a plain object)', () => {
  assert.deepEqual(toEnvelope(null), { version: 1, data: null });
});

test('toEnvelope never throws on awkward input', () => {
  assert.doesNotThrow(() => toEnvelope(undefined));
  assert.doesNotThrow(() => toEnvelope(0));
});

test('toEnvelope: envelope version always wins over a payload `version` key', () => {
  // A payload carrying its own `version` must NOT clobber the envelope schema version.
  assert.equal(toEnvelope({ version: 99 }).version, 1);
  assert.equal(toEnvelope({ version: 99, a: 1 }).version, 1);
});

// ── B. STABLE-STRINGIFY: SORTED KEYS ──────────────────────────────────────────────

test('stableStringify sorts object keys lexicographically (parsed + raw order)', () => {
  const out = stableStringify({ b: 1, a: 2 });
  assert.deepEqual(JSON.parse(out), { a: 2, b: 1 });
  // The raw string must place "a" before "b".
  assert.ok(out.indexOf('"a"') < out.indexOf('"b"'), `expected "a" before "b" in: ${out}`);
});

test('stableStringify is insertion-order independent (same keys → same string)', () => {
  const s1 = stableStringify({ a: 1, b: 2, c: 3 });
  const s2 = stableStringify({ c: 3, a: 1, b: 2 });
  assert.equal(s1, s2);
});

test('stableStringify sorts nested objects recursively', () => {
  const out = stableStringify({ outer: { z: 1, a: 2 } }, { indent: 0 });
  assert.equal(out, '{"outer":{"a":2,"z":1}}');
});

// ── C. STABLE-STRINGIFY: ARRAYS PRESERVED ─────────────────────────────────────────

test('stableStringify preserves array order (not sorted), compact at indent 0', () => {
  assert.equal(stableStringify([3, 1, 2], { indent: 0 }), '[3,1,2]');
});

test('stableStringify recurses into array elements while keeping element order', () => {
  const out = stableStringify([{ b: 1, a: 2 }, { d: 3, c: 4 }], { indent: 0 });
  assert.equal(out, '[{"a":2,"b":1},{"c":4,"d":3}]');
});

// ── D. INDENT OPTION ──────────────────────────────────────────────────────────────

test('stableStringify defaults to 2-space indentation', () => {
  const out = stableStringify({ a: 1 });
  assert.equal(out, '{\n  "a": 1\n}');
});

test('stableStringify indent 0 is compact', () => {
  assert.equal(stableStringify({ a: 1, b: 2 }, { indent: 0 }), '{"a":1,"b":2}');
});

test('stableStringify tolerates a bad indent option (falls back to 2)', () => {
  assert.doesNotThrow(() => stableStringify({ a: 1 }, { indent: -5 }));
  assert.equal(stableStringify({ a: 1 }, { indent: NaN }), '{\n  "a": 1\n}');
});

// ── E. FORMATJSON (ENVELOPE + STRINGIFY) ──────────────────────────────────────────

test('formatJson wraps payload in a version-1 envelope', () => {
  const parsed = JSON.parse(formatJson({ conflicts: [] }));
  assert.equal(parsed.version, 1);
  assert.deepEqual(parsed.conflicts, []);
});

test('formatJson keeps version present and keys sorted', () => {
  const out = formatJson({ z: 1, a: 2 }, { indent: 0 });
  // version + payload keys all sorted together lexicographically.
  assert.equal(out, '{"a":2,"version":1,"z":1}');
});

// ── F. NEVER-THROWS DEGRADATION ───────────────────────────────────────────────────

test('stableStringify on a circular object → error envelope, never throws', () => {
  const cyclic = {};
  cyclic.self = cyclic;
  let out;
  assert.doesNotThrow(() => { out = stableStringify(cyclic); });
  assert.ok(out.includes('"version":1'), `expected version in error envelope: ${out}`);
  assert.deepEqual(JSON.parse(out), { version: 1, error: 'unserializable' });
});

test('stableStringify on BigInt → error envelope, never throws', () => {
  let out;
  assert.doesNotThrow(() => { out = stableStringify({ big: 10n }); });
  assert.deepEqual(JSON.parse(out), { version: 1, error: 'unserializable' });
});

test('formatJson on a circular payload → error envelope, never throws', () => {
  const cyclic = {};
  cyclic.self = cyclic;
  let out;
  assert.doesNotThrow(() => { out = formatJson(cyclic); });
  assert.ok(out.includes('"version":1'));
});

// ── G. HARDENING ──────────────────────────────────────────────────────────────────

test('stableStringify drops prototype-poisoning keys from output', () => {
  // JSON.parse makes `__proto__` an OWN enumerable key (a hostile payload shape).
  const malicious = JSON.parse('{"__proto__":{"polluted":true},"a":1}');
  const out = stableStringify(malicious, { indent: 0 });
  assert.equal(out, '{"a":1}');
  assert.equal(({}).polluted, undefined);
});

// ── H. DETERMINISM ──────────────────────────────────────────────────────────────────

test('determinism: two identical calls produce identical strings', () => {
  const value = { permissions: { allow: ['a', 'b'] }, version: 1, env: { B: '2', A: '1' } };
  assert.equal(stableStringify(value), stableStringify(value));
});
