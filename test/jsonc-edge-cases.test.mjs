/**
 * P2.U2 — jsonc-edge-cases.test.mjs
 *
 * Edge-case hardening tests for parseJsonc:
 *   - BOM stripping (leading U+FEFF, in-code and on-disk)
 *   - Nested block comments pinned to first-*​/ wins behaviour
 *   - Escaped Unicode including surrogate pairs and lone surrogates
 *   - Duplicate-key line:column precision across LF and CRLF
 *   - multiline error position
 *   - Trailing junk after a top-level value
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseJsonc } from '../src/lib/jsonc-parser.mjs';

/**
 * Recursively re-home parsed (null-proto) objects onto Object.prototype so
 * assert.deepEqual compares VALUES, not prototypes. Matches the helper in
 * jsonc-parser.test.mjs.
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

/** Load a fixture relative to this file. */
function fix(name) {
  return readFileSync(new URL(`./fixtures/jsonc-edge-cases/${name}`, import.meta.url), 'utf8');
}

// ── BOM (U+FEFF) ───────────────────────────────────────────────────────────────

test('parseJsonc BOM: in-code leading BOM → value parsed, no errors', () => {
  // The BOM character is the first char of this string literal.
  const r = parseJsonc('﻿{"a":1}');
  assert.deepEqual(r.errors, []);
  assert.equal(plain(r.value).a, 1);
});

test('parseJsonc BOM: in-code BOM + line comment → value parsed, no errors', () => {
  const r = parseJsonc('﻿{ // c\n "a":1 }');
  assert.deepEqual(r.errors, []);
  assert.equal(plain(r.value).a, 1);
});

test('parseJsonc BOM: bom.json fixture (on-disk EF BB BF bytes) → {a:1,b:2}, no errors', () => {
  const r = parseJsonc(fix('bom.json'));
  assert.deepEqual(r.errors, []);
  assert.deepEqual(plain(r.value), { a: 1, b: 2 });
});

test('parseJsonc BOM: interior BOM inside a string value is preserved verbatim', () => {
  // U+FEFF in the middle of a string is ordinary data, not stripped.
  const r = parseJsonc('{"a":"x﻿y"}');
  assert.deepEqual(r.errors, []);
  assert.equal(r.value.a, 'x﻿y');
});

// ── Nested block comments (first *​/ wins — by design) ──────────────────────────

test('parseJsonc nested-comments: nested-comments.json → error reported (first */ wins)', () => {
  // The fixture is:  "a": 1 /* outer /* inner */ */
  // The first */ closes after "inner"; the trailing " */" is a stray *.
  // afterMember sees * where it expects , or }, emitting an error on line 2.
  const r = parseJsonc(fix('nested-comments.json'));
  assert.ok(r.errors.length >= 1, 'has at least one error');
  assert.equal(r.errors[0].line, 2, 'error is on line 2');
  assert.ok(typeof r.errors[0].column === 'number' && r.errors[0].column >= 1);
});

test('parseJsonc nested-comments: in-code variant also triggers first-*/-wins error', () => {
  const r = parseJsonc('{"a":1 /* outer /* inner */ */ }');
  assert.ok(r.errors.length >= 1, 'has at least one error');
});

test('parseJsonc nested-comments: unterminated block comment → error at comment start', () => {
  const r = parseJsonc('{ /* never closes');
  assert.ok(r.errors.length >= 1, 'has at least one error');
  assert.equal(r.errors[0].line, 1);
  assert.equal(r.errors[0].column, 3); // /* starts at column 3
  assert.ok(r.errors[0].message.includes('unterminated'));
});

// ── Escaped Unicode ─────────────────────────────────────────────────────────────

test('parseJsonc unicode: \\u0041 decodes to ASCII "A"', () => {
  const r = parseJsonc('"\\u0041"');
  assert.deepEqual(r.errors, []);
  assert.equal(r.value, 'A');
});

test('parseJsonc unicode: lowercase hex \\u00E9 decodes to "é"', () => {
  const r = parseJsonc('"\\u00E9"');
  assert.deepEqual(r.errors, []);
  assert.equal(r.value, 'é');
});

test('parseJsonc unicode: surrogate pair \\uD83D\\uDE00 → "😀"', () => {
  const r = parseJsonc('"\\uD83D\\uDE00"');
  assert.deepEqual(r.errors, []);
  assert.equal(r.value, '😀');
});

test('parseJsonc unicode: escaped-unicode.json fixture → expected deep value', () => {
  const r = parseJsonc(fix('escaped-unicode.json'));
  assert.deepEqual(r.errors, []);
  assert.deepEqual(plain(r.value), { ascii: 'A', accent: 'é', emoji: '😀', tab: '\t' });
});

test('parseJsonc unicode: lone surrogate \\uD83D → no throw, no errors, value length 1', () => {
  // A lone high surrogate in a JSON string is lenient: no throw, no error.
  const r = parseJsonc('"\\uD83D"');
  assert.doesNotThrow(() => parseJsonc('"\\uD83D"'));
  assert.deepEqual(r.errors, []);
  assert.equal(typeof r.value, 'string');
  assert.equal(r.value.length, 1);
});

// ── Duplicate-key line:column precision ─────────────────────────────────────────

test('parseJsonc duplicates: duplicate-keys.json → correct positions for top-level "name"', () => {
  // duplicate-keys.json line 3 col 3 is the second "name"
  const r = parseJsonc(fix('duplicate-keys.json'));
  assert.deepEqual(r.errors, []);
  const topDup = r.duplicateKeys.find(d => d.key === 'name');
  assert.ok(topDup, 'found duplicate "name"');
  assert.equal(topDup.line, 3);
  assert.equal(topDup.column, 3);
  assert.equal(r.value.name, 'second'); // LAST-wins
});

test('parseJsonc duplicates: duplicate-keys.json → correct positions for nested "dup"', () => {
  // nested "dup" second occurrence: line 6 col 5
  const r = parseJsonc(fix('duplicate-keys.json'));
  const nestedDup = r.duplicateKeys.find(d => d.key === 'dup');
  assert.ok(nestedDup, 'found duplicate "dup"');
  assert.equal(nestedDup.line, 6);
  assert.equal(nestedDup.column, 5);
  assert.equal(r.value.nested.dup, 2); // LAST-wins
});

test('parseJsonc duplicates: crlf-duplicate.json → duplicate "k" at correct line under CRLF', () => {
  // CRLF file: line 3 col 3 for the second "k"
  const r = parseJsonc(fix('crlf-duplicate.json'));
  assert.deepEqual(r.errors, []);
  assert.equal(r.duplicateKeys.length, 1);
  assert.equal(r.duplicateKeys[0].key, 'k');
  assert.equal(r.duplicateKeys[0].line, 3);
  assert.equal(r.duplicateKeys[0].column, 3);
});

// ── multiline error position ─────────────────────────────────────────────────────

test('parseJsonc multiline-error: error line is the offending } on line 5', () => {
  // multiline-error.json has "c": on line 4 then } on line 5 → unexpected char
  const r = parseJsonc(fix('multiline-error.json'));
  assert.equal(r.value, undefined);
  assert.ok(r.errors.length >= 1);
  assert.equal(r.errors[0].line, 5);
  assert.ok(r.errors[0].column >= 1);
});

// ── Trailing junk ────────────────────────────────────────────────────────────────

test('parseJsonc trailing junk: extra text after top-level value → error with position', () => {
  const r = parseJsonc('{"a":1} extra');
  assert.equal(r.value, undefined);
  assert.ok(r.errors.length >= 1);
  assert.equal(r.errors[0].line, 1);
  assert.equal(r.errors[0].column, 9); // 'e' of 'extra' is at col 9
  assert.ok(typeof r.errors[0].message === 'string');
});
