/**
 * Tests for src/lib/toml-parser.mjs (P6 TOML wave, unit 1).
 *
 * Falsifiable golden oracles for the config.toml subset: a real-shaped document
 * deepEquals an exact expected structure; plus per-construct coverage (string
 * escapes, literal strings, arrays-of-tables, quoted keys, multi-line arrays,
 * integer bases, floats), proto-safety, never-throws, 1-based error positions,
 * and the deliberate out-of-subset clean errors (multi-line strings, inline tables).
 *
 * Structure is compared via a JSON round-trip so a parsed null-proto table
 * deepStrictEquals a plain-object expected (and is proven JSON-serializable).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseToml } from '../src/lib/toml-parser.mjs';

/** JSON round-trip: normalise null-proto tables to plain objects for comparison. */
const plain = (v) => JSON.parse(JSON.stringify(v));

// ── headline golden oracle ─────────────────────────────────────────────────────

test('golden: a real-shaped config.toml subset parses to the exact structure', () => {
  const src = [
    '# oh-my-codex top-level settings',
    'model = "gpt-5.5"',
    'model_context_window = 250000',
    'suppress_unstable_features_warning = true',
    'notify = [ "a.exe", "turn-ended" ]',
    '',
    '[projects."C:\\\\Users\\\\alice"]',
    'trust_level = "trusted"',
    '',
    '[mcp_servers.pencil]',
    'command = "npx"',
    'args = [ "--app", "code" ]',
    '',
    '[[skills.config]]',
    'name = "ab-test-setup"',
    'enabled = false',
    '',
    '[[skills.config]]',
    'name = "ad-creative"',
    'enabled = true   # inline comment after a value',
  ].join('\n');

  const { value, errors } = parseToml(src);
  assert.deepEqual(errors, []);
  assert.deepStrictEqual(plain(value), {
    model: 'gpt-5.5',
    model_context_window: 250000,
    suppress_unstable_features_warning: true,
    notify: ['a.exe', 'turn-ended'],
    projects: { 'C:\\Users\\alice': { trust_level: 'trusted' } },
    mcp_servers: { pencil: { command: 'npx', args: ['--app', 'code'] } },
    skills: {
      config: [
        { name: 'ab-test-setup', enabled: false },
        { name: 'ad-creative', enabled: true },
      ],
    },
  });
});

// ── strings ─────────────────────────────────────────────────────────────────────

test('basic string escapes: \\\\ \\" \\n \\uXXXX', () => {
  const { value } = parseToml('p = "C:\\\\x\\ty\\n\\u0041"');
  assert.equal(value.p, 'C:\\x\ty\nA');
});

test('literal string is verbatim — backslashes are NOT escapes', () => {
  const { value } = parseToml("p = 'C:\\Users\\alice\\.codex'");
  assert.equal(value.p, 'C:\\Users\\alice\\.codex');
});

test('a quoted key in an assignment (e.g. "gpt-5.5" = 4)', () => {
  const { value } = parseToml('"gpt-5.5" = 4');
  assert.equal(value['gpt-5.5'], 4);
});

test('a basic-quoted key segment in a table header decodes escapes', () => {
  const { value } = parseToml('[a."b\\\\c"]\nx = 1');
  assert.deepStrictEqual(plain(value), { a: { 'b\\c': { x: 1 } } });
});

// ── arrays ──────────────────────────────────────────────────────────────────────

test('multi-line array with a trailing comma and an interior comment', () => {
  const src = [
    'list = [',
    '  "one",',
    '  "two",   # trailing element comment',
    '  "three",', // trailing comma
    ']',
  ].join('\n');
  const { value, errors } = parseToml(src);
  assert.deepEqual(errors, []);
  assert.deepStrictEqual(plain(value).list, ['one', 'two', 'three']);
});

test('nested arrays', () => {
  const { value } = parseToml('m = [ [1, 2], [3] ]');
  assert.deepStrictEqual(plain(value).m, [[1, 2], [3]]);
});

// ── numbers ─────────────────────────────────────────────────────────────────────

test('integers: decimal / signed / underscores / hex / oct / bin', () => {
  const { value } = parseToml([
    'a = 250000',
    'b = -7',
    'c = 1_000_000',
    'd = 0xFF',
    'e = 0o17',
    'f = 0b1010',
  ].join('\n'));
  assert.deepStrictEqual(plain(value), { a: 250000, b: -7, c: 1000000, d: 255, e: 15, f: 10 });
});

test('floats: decimal point + exponent', () => {
  const { value } = parseToml('a = 1.5\nb = -0.25\nc = 6.0e2');
  assert.deepStrictEqual(plain(value), { a: 1.5, b: -0.25, c: 600 });
});

// ── proto-safety ────────────────────────────────────────────────────────────────

test('a __proto__ key is ordinary data, never pollution', () => {
  const { value } = parseToml('[projects."__proto__"]\nx = 1\n[a]\n__proto__ = 5');
  assert.equal(({}).polluted, undefined, 'Object.prototype must be untouched');
  // the literal __proto__ keys are present as OWN data, not the prototype.
  assert.equal(Object.prototype.hasOwnProperty.call(value.projects, '__proto__'), true);
  assert.equal(Object.prototype.hasOwnProperty.call(value.a, '__proto__'), true);
  assert.equal(value.a.__proto__ ?? value.a['__proto__'], 5);
});

// ── empty / comments ──────────────────────────────────────────────────────────────

test('a comment-only / blank document → empty table, no errors', () => {
  const { value, errors } = parseToml('# just a comment\n\n   \n# another');
  assert.deepEqual(errors, []);
  assert.deepStrictEqual(plain(value), {});
});

// ── never-throws + error positions ─────────────────────────────────────────────

test('non-string input → error, never throws', () => {
  for (const bad of [null, undefined, 42, {}, []]) {
    assert.doesNotThrow(() => parseToml(bad));
    const r = parseToml(bad);
    assert.equal(r.value, undefined);
    assert.equal(r.errors[0].message, 'input is not a string');
  }
});

test('malformed input never throws and reports a 1-based position', () => {
  const r = parseToml('a = 1\nb = @nope');
  assert.equal(r.value, undefined);
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].line, 2, 'error on the second line');
  assert.ok(r.errors[0].column >= 1);
});

test('a missing = is a clean error', () => {
  const r = parseToml('key value');
  assert.equal(r.value, undefined);
  assert.match(r.errors[0].message, /expected '='/);
});

// ── deliberate out-of-subset clean errors (documented scope) ────────────────────

test('multi-line basic string (""") → clean out-of-subset error, not a throw', () => {
  const r = parseToml('x = """multi\nline"""');
  assert.equal(r.value, undefined);
  assert.match(r.errors[0].message, /multi-line basic strings/);
});

test("inline table ({...}) → clean out-of-subset error", () => {
  const r = parseToml('x = { a = 1 }');
  assert.equal(r.value, undefined);
  assert.match(r.errors[0].message, /inline tables/);
});

test('an out-of-subset bare value (a date) → clean error, never throws', () => {
  const r = parseToml('d = 2026-01-01');
  assert.equal(r.value, undefined);
  assert.match(r.errors[0].message, /invalid value/);
});

// ── array-of-tables semantics ─────────────────────────────────────────────────

test('a later [table] header descends into the LAST array-of-tables element', () => {
  // TOML rule: [[a]] then [a.b] attaches b to the last a element.
  const src = ['[[a]]', 'n = 1', '[[a]]', 'n = 2', '[a.sub]', 'k = "v"'].join('\n');
  const { value, errors } = parseToml(src);
  assert.deepEqual(errors, []);
  assert.deepStrictEqual(plain(value).a, [{ n: 1 }, { n: 2, sub: { k: 'v' } }]);
});
