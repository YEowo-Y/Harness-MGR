/**
 * P2.U1 — jsonc-parser.test.mjs
 *
 * Happy-path unit tests for parseJsonc (no filesystem). The through-line is the
 * never-throw contract plus the three tolerated extensions over strict JSON:
 * comments, trailing commas, and duplicate-key reporting (LAST-wins value). Two
 * data-safety cases pin that comment/comma syntax INSIDE a string literal stays
 * verbatim, and that bad input degrades to errors rather than throwing.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseJsonc } from '../src/lib/jsonc-parser.mjs';

/**
 * Recursively re-home parsed objects onto Object.prototype so deepEqual (which is
 * prototype-strict) compares VALUES, not prototypes. The parser uses null-proto
 * objects on purpose (prototype-pollution safety, like frontmatter.mjs), so the
 * structural assertions normalize that away rather than weaken the parser.
 */
function plain(v) {
  if (Array.isArray(v)) return v.map(plain);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v)) out[k] = plain(v[k]);
    return out;
  }
  return v;
}

test('parseJsonc: plain valid JSON object round-trips with no errors/dups', () => {
  const r = parseJsonc('{ "a": 1, "b": "two", "c": true, "d": null, "e": [1, 2, 3] }');
  assert.deepEqual(plain(r.value), { a: 1, b: 'two', c: true, d: null, e: [1, 2, 3] });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.duplicateKeys, []);
});

test('parseJsonc: // line comments (own line and trailing) are stripped', () => {
  const text = [
    '{',
    '  // leading comment on its own line',
    '  "a": 1, // trailing comment after a value',
    '  "b": 2',
    '}',
  ].join('\n');
  const r = parseJsonc(text);
  assert.deepEqual(plain(r.value), { a: 1, b: 2 });
  assert.deepEqual(r.errors, []);
});

test('parseJsonc: /* block comment */ is stripped', () => {
  const r = parseJsonc('{ /* block */ "a": /* inline */ 1 }');
  assert.deepEqual(plain(r.value), { a: 1 });
  assert.deepEqual(r.errors, []);
});

test('parseJsonc: trailing comma in an object parses', () => {
  const r = parseJsonc('{ "a": 1, "b": 2, }');
  assert.deepEqual(plain(r.value), { a: 1, b: 2 });
  assert.deepEqual(r.errors, []);
});

test('parseJsonc: trailing comma in an array parses', () => {
  const r = parseJsonc('[1, 2, 3, ]');
  assert.deepEqual(r.value, [1, 2, 3]);
  assert.deepEqual(r.errors, []);
});

test('parseJsonc: duplicate key records LATER occurrence with 1-based line:column; LAST wins', () => {
  const text = [
    '{',
    '  "dup": 1,',
    '  "dup": 2',
    '}',
  ].join('\n');
  const r = parseJsonc(text);
  assert.equal(r.value.dup, 2, 'value is LAST-wins');
  assert.equal(r.duplicateKeys.length, 1);
  assert.deepEqual(r.duplicateKeys[0], { key: 'dup', line: 3, column: 3 });
  assert.deepEqual(r.errors, []);
});

test('parseJsonc: comment/comma syntax INSIDE a string literal is preserved verbatim', () => {
  const r = parseJsonc('{ "a": "//x", "b": "/* not a comment */", "c": "a,}" }');
  assert.deepEqual(plain(r.value), { a: '//x', b: '/* not a comment */', c: 'a,}' });
  assert.deepEqual(r.errors, []);
});

test('parseJsonc: backslash escapes inside strings do not mis-terminate', () => {
  const r = parseJsonc('{ "q": "a\\"b", "n": "line1\\nline2", "u": "\\u0041" }');
  assert.deepEqual(plain(r.value), { q: 'a"b', n: 'line1\nline2', u: 'A' });
  assert.deepEqual(r.errors, []);
});

test('parseJsonc: nested object + array with comments and trailing commas mixed', () => {
  const text = [
    '{',
    '  // top-level',
    '  "outer": {',
    '    "list": [',
    '      1, // one',
    '      2,',
    '      { "deep": true, }, /* trailing in object inside array */',
    '    ],',
    '    "name": "ok",',
    '  },',
    '}',
  ].join('\n');
  const r = parseJsonc(text);
  assert.deepEqual(plain(r.value), { outer: { list: [1, 2, { deep: true }], name: 'ok' } });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.duplicateKeys, []);
});

test('parseJsonc: syntax error reports line:column, value undefined, never throws', () => {
  const r = parseJsonc('{ "a": }');
  assert.equal(r.value, undefined);
  assert.ok(r.errors.length >= 1, 'has at least one error');
  assert.equal(typeof r.errors[0].message, 'string');
  assert.equal(r.errors[0].line, 1);
  assert.equal(typeof r.errors[0].column, 'number');
  assert.ok(r.errors[0].column >= 1, '1-based column');
});

test('parseJsonc: non-string input (null, number, undefined) → errors, no throw', () => {
  for (const bad of [null, 42, undefined, {}, [], true]) {
    const r = parseJsonc(bad);
    assert.equal(r.value, undefined);
    assert.deepEqual(r.errors, [{ message: 'input is not a string', line: 1, column: 1 }]);
    assert.deepEqual(r.duplicateKeys, []);
  }
});

test('parseJsonc: empty and whitespace-only input degrade gracefully (no throw)', () => {
  for (const text of ['', '   ', '\n\t  \n', '// only a comment\n']) {
    const r = parseJsonc(text);
    assert.equal(r.value, undefined);
    assert.ok(r.errors.length >= 1, `error for ${JSON.stringify(text)}`);
    assert.equal(typeof r.errors[0].message, 'string');
  }
});

test('parseJsonc: a bare string / number / keyword as the whole document parses', () => {
  assert.deepEqual(parseJsonc('"hello"').value, 'hello');
  assert.deepEqual(parseJsonc('-12.5e3').value, -12500);
  assert.deepEqual(parseJsonc('  true  ').value, true);
  assert.deepEqual(parseJsonc('null').value, null);
});

test('parseJsonc: __proto__ as a key is ordinary data, not prototype pollution', () => {
  const r = parseJsonc('{ "__proto__": { "polluted": true }, "safe": 1 }');
  assert.deepEqual(r.errors, []);
  assert.equal(r.value.safe, 1);
  // The literal key is own-data; Object.prototype is untouched.
  assert.equal(({}).polluted, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(r.value, '__proto__'), true);
});
