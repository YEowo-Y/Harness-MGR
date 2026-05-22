/**
 * P1.U16 — selftest-lint.test.mjs
 *
 * Golden + boundary tests for the SOURCE-SIZE LINTER:
 *   - clean small module → zero diagnostics,
 *   - oversize function → lint-function-too-large naming it,
 *   - GOLDEN PRAGMA: the same oversize fn with a valid mgr-lint-ignore directly
 *     above → exempt (the key acceptance criterion),
 *   - 6 params → lint-too-many-params; 5 params → none,
 *   - empty-reason pragma → lint-pragma-empty-reason AND no exemption,
 *   - braces inside a string / inside a comment do NOT corrupt span counting,
 *   - SLOC ≠ physical: a ~250-physical-line mostly-comment file < 200 code lines
 *     produces NO module violation,
 *   - lintSource never throws on '' / non-string input.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_MODULE_SLOC,
  MAX_FUNCTION_SLOC,
  MAX_PARAMS,
  lintSource,
  lintTree,
} from '../src/selftest/lint.mjs';
import { projectLines, regexStarts } from '../src/selftest/projection.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(HERE, '..', 'src');

/** Find diagnostics of a given code. */
const byCode = (diags, code) => diags.filter((d) => d.code === code);
/** Build a function body with `n` distinct code statements. */
const bodyLines = (n) => Array.from({ length: n }, (_, k) => `  const v${k} = ${k};`).join('\n');

// ── constants ─────────────────────────────────────────────────────────────────────

test('constants: the three ceilings are the documented values', () => {
  assert.equal(MAX_MODULE_SLOC, 200);
  assert.equal(MAX_FUNCTION_SLOC, 80);
  assert.equal(MAX_PARAMS, 5);
});

// ── clean module ────────────────────────────────────────────────────────────────

test('clean small module → zero diagnostics', () => {
  const src = [
    '// a tidy little module',
    'export function add(a, b) {',
    '  return a + b;',
    '}',
    '',
    'export const inc = (x) => add(x, 1);',
  ].join('\n');
  assert.deepEqual(lintSource('clean.mjs', src), []);
});

// ── function too large ──────────────────────────────────────────────────────────

test('a function of MAX_FUNCTION_SLOC+1 code lines → lint-function-too-large naming it', () => {
  // signature(1) + bodyLines(MAX_FUNCTION_SLOC-1)(79) + close(1) = 81 SLOC > 80.
  const src = `function bloated() {\n${bodyLines(MAX_FUNCTION_SLOC - 1)}\n}\n`;
  const hits = byCode(lintSource('big.mjs', src), 'lint-function-too-large');
  assert.equal(hits.length, 1);
  assert.match(hits[0].message, /bloated/);
  assert.match(hits[0].message, new RegExp(`max ${MAX_FUNCTION_SLOC}`));
  assert.equal(hits[0].severity, 'error');
  assert.equal(hits[0].phase, 'lint');
  assert.equal(hits[0].path, 'big.mjs');
});

test('a function at exactly MAX_FUNCTION_SLOC SLOC → no function-too-large', () => {
  // signature(1) + bodyLines(MAX_FUNCTION_SLOC-2)(78) + close(1) = 80 SLOC (inclusive max, allowed).
  const src = `function snug() {\n${bodyLines(MAX_FUNCTION_SLOC - 2)}\n}\n`;
  assert.equal(byCode(lintSource('snug.mjs', src), 'lint-function-too-large').length, 0);
});

// ── GOLDEN PRAGMA TEST (key acceptance) ──────────────────────────────────────────

test('GOLDEN: oversize fn with a valid mgr-lint-ignore directly above → exempt', () => {
  const src = `// mgr-lint-ignore: irreducible state machine\nfunction bloated() {\n${bodyLines(MAX_FUNCTION_SLOC - 1)}\n}\n`;
  const diags = lintSource('exempt.mjs', src);
  assert.equal(byCode(diags, 'lint-function-too-large').length, 0);
  // and no spurious empty-reason warning for a well-formed pragma.
  assert.equal(byCode(diags, 'lint-pragma-empty-reason').length, 0);
});

test('a blank line between pragma and fn breaks adjacency → NOT exempt', () => {
  const src = `// mgr-lint-ignore: reason\n\nfunction bloated() {\n${bodyLines(MAX_FUNCTION_SLOC - 1)}\n}\n`;
  assert.equal(byCode(lintSource('gap.mjs', src), 'lint-function-too-large').length, 1);
});

// ── parameter count ───────────────────────────────────────────────────────────────

test('6 params → lint-too-many-params naming it', () => {
  const src = 'function many(a, b, c, d, e, f) {\n  return a;\n}\n';
  const hits = byCode(lintSource('params.mjs', src), 'lint-too-many-params');
  assert.equal(hits.length, 1);
  assert.match(hits[0].message, /many/);
  assert.match(hits[0].message, /6 params/);
  assert.match(hits[0].message, /max 5/);
});

test('5 params → no too-many-params', () => {
  const src = 'function five(a, b, c, d, e) {\n  return a;\n}\n';
  assert.equal(byCode(lintSource('five.mjs', src), 'lint-too-many-params').length, 0);
});

test('a destructured object param counts as ONE (not its fields)', () => {
  const src = 'function opt({ a, b, c, d, e, f, g }) {\n  return a;\n}\n';
  assert.equal(byCode(lintSource('destruct.mjs', src), 'lint-too-many-params').length, 0);
});

test('empty param list → 0 params, no violation', () => {
  const src = 'function noop() {\n  return 0;\n}\n';
  assert.equal(byCode(lintSource('noop.mjs', src), 'lint-too-many-params').length, 0);
});

test('a valid pragma also exempts the parameter check', () => {
  const src = '// mgr-lint-ignore: external signature, fixed shape\nfunction many(a, b, c, d, e, f) {\n  return a;\n}\n';
  assert.equal(byCode(lintSource('p2.mjs', src), 'lint-too-many-params').length, 0);
});

// ── empty-reason pragma ───────────────────────────────────────────────────────────

test('empty-reason pragma → lint-pragma-empty-reason AND exemption NOT granted', () => {
  const src = `// mgr-lint-ignore:   \nfunction bloated() {\n${bodyLines(MAX_FUNCTION_SLOC - 1)}\n}\n`;
  const diags = lintSource('emptyreason.mjs', src);
  const warns = byCode(diags, 'lint-pragma-empty-reason');
  assert.equal(warns.length, 1);
  assert.equal(warns[0].severity, 'warn');
  // exemption NOT granted → the oversize function is still reported.
  assert.equal(byCode(diags, 'lint-function-too-large').length, 1);
});

test('a no-colon comment is not a pragma and emits nothing', () => {
  const src = '// mgr-lint-ignore but no colon here\nexport const x = 1;\n';
  assert.deepEqual(lintSource('nocolon.mjs', src), []);
});

// ── braces inside strings / comments do not corrupt spans ────────────────────────

test('braces inside a string and inside a comment do NOT corrupt span counting', () => {
  // A `}` in a string literal and a `// }` line both sit INSIDE the body; if the
  // projection failed to blank them, the span would close early and the SLOC
  // count (and the fn name attribution) would be wrong. With MAX_FUNCTION_SLOC-1
  // real statements plus these two decoy lines, the function is oversize and named.
  const decoys = '  const s = "}";\n  // }\n';
  const src = `function tricky() {\n${decoys}${bodyLines(MAX_FUNCTION_SLOC - 1)}\n}\n`;
  const hits = byCode(lintSource('tricky.mjs', src), 'lint-function-too-large');
  assert.equal(hits.length, 1);
  assert.match(hits[0].message, /tricky/);
});

test('a brace-in-string decoy does not split one function into two', () => {
  // The decoy `{` inside the string must not be read as a nested body opener;
  // a small function with such a decoy stays under the limit (no false positive).
  const src = 'function ok() {\n  const open = "{";\n  const close = "}";\n  return open + close;\n}\n';
  assert.deepEqual(lintSource('decoy.mjs', src), []);
});

// ── SLOC ≠ physical ───────────────────────────────────────────────────────────────

test('~250-physical-line mostly-comment file with <200 code lines → NO module violation', () => {
  const header = Array.from({ length: 220 }, (_, k) => ` * doc line ${k}`);
  const block = ['/**', ...header, ' */'].join('\n'); // ~222 physical comment lines
  const code = Array.from({ length: 30 }, (_, k) => `export const c${k} = ${k};`).join('\n');
  const src = `${block}\n${code}\n`; // ~253 physical lines, 30 SLOC
  const diags = lintSource('mostly-comments.mjs', src);
  assert.equal(byCode(diags, 'lint-module-too-large').length, 0);
});

test('a module that genuinely exceeds 200 SLOC → lint-module-too-large with the count', () => {
  const code = Array.from({ length: 201 }, (_, k) => `const m${k} = ${k};`).join('\n');
  const hits = byCode(lintSource('toobig.mjs', code), 'lint-module-too-large');
  assert.equal(hits.length, 1);
  assert.match(hits[0].message, /201 SLOC/);
  assert.match(hits[0].message, /max 200/);
});

test('a header pragma exempts an oversize module', () => {
  const code = Array.from({ length: 201 }, (_, k) => `const m${k} = ${k};`).join('\n');
  const src = `// mgr-lint-ignore: generated table, intentionally flat\n${code}`;
  assert.equal(byCode(lintSource('exempt-mod.mjs', src), 'lint-module-too-large').length, 0);
});

// ── never-throws on bad input ─────────────────────────────────────────────────────

test('lintSource never throws on empty / non-string input', () => {
  assert.deepEqual(lintSource('e.mjs', ''), []);
  assert.deepEqual(lintSource('e.mjs', undefined), []);
  assert.deepEqual(lintSource('e.mjs', null), []);
  assert.deepEqual(lintSource('e.mjs', 42), []);
  assert.deepEqual(lintSource('e.mjs', {}), []);
  // a non-string filePath must not throw and must omit path.
  const src = `function bloated() {\n${bodyLines(MAX_FUNCTION_SLOC - 1)}\n}\n`;
  const hits = byCode(lintSource(undefined, src), 'lint-function-too-large');
  assert.equal(hits.length, 1);
  assert.equal('path' in hits[0], false);
});

test('an unterminated string / block comment does not throw', () => {
  assert.doesNotThrow(() => lintSource('u.mjs', 'const s = "unterminated\nconst t = 1;\n'));
  assert.doesNotThrow(() => lintSource('u.mjs', '/* open block\nconst t = 1;\n'));
  assert.doesNotThrow(() => lintSource('u.mjs', 'function broke() {\n  const x = 1;\n'));
});

// ── arrow / method styles ─────────────────────────────────────────────────────────

test('an oversize arrow-assigned function is detected and named', () => {
  const src = `export const big = () => {\n${bodyLines(MAX_FUNCTION_SLOC - 1)}\n};\n`;
  const hits = byCode(lintSource('arrow.mjs', src), 'lint-function-too-large');
  assert.equal(hits.length, 1);
  assert.match(hits[0].message, /big/);
});

// ── projection (direct unit) ──────────────────────────────────────────────────────

test('projectLines blanks string/comment contents but keeps structural braces', () => {
  const proj = projectLines([
    'const s = "a } b ( c";',     // braces inside a string → blanked
    'foo(); // trailing } note',  // code kept, line comment (with brace) dropped
    '/* block { ( */ bar();',     // block comment stripped, code after kept
  ]);
  assert.ok(proj[0].includes('{') === false && proj[0].includes('(') === false);
  assert.ok(proj[0].startsWith('const s = '));
  assert.equal(proj[1].trim(), 'foo();');
  assert.equal(proj[2].trim(), 'bar();');
});

test('projectLines carries block-comment state across lines', () => {
  const proj = projectLines(['code1();', '/* open', '  still comment }', 'close */ code2();']);
  assert.equal(proj[0].trim(), 'code1();');
  assert.equal(proj[1].trim(), '');
  assert.equal(proj[2].trim(), '');
  assert.equal(proj[3].trim(), 'code2();');
});

test('regexStarts: expression position vs division', () => {
  assert.equal(regexStarts(''), true);              // start of line
  assert.equal(regexStarts('return '), true);       // keyword → opens regex (fix #1)
  assert.equal(regexStarts('const re = '), true);   // after '='
  assert.equal(regexStarts('str.replace('), true);  // after '('
  assert.equal(regexStarts('a + b'), false);        // after an operand (identifier)
  // Other REGEX_KEYWORDS
  assert.equal(regexStarts('typeof '), true);
  assert.equal(regexStarts('void '), true);
  assert.equal(regexStarts('throw '), true);
  assert.equal(regexStarts('  return'), true);      // leading whitespace stripped
  // Non-keyword identifiers are NOT regex position
  assert.equal(regexStarts('foo'), false);
  assert.equal(regexStarts('result'), false);
});

test('a regex literal containing a brace does not corrupt span counting', () => {
  // `/\}/` inside the body: the projection must blank its content so the body span
  // does not close early. The function is small → no false positive.
  const src = 'function re() {\n  const m = /\\}/.test("x");\n  return m;\n}\n';
  assert.deepEqual(lintSource('re.mjs', src), []);
});

test('REGRESSION fix#1: return /\\}/ in oversize fn still triggers lint-function-too-large', () => {
  // Before fix #1: `return` ends with a word char, so regexStarts returned false,
  // the `/` was treated as division, the regex body `/\}/` was left un-blanked, and
  // the `}` inside it closed the brace span early — silently undercounting the
  // function's SLOC (false negative). After fix #1 `return` is a REGEX_KEYWORD so
  // the slash is correctly consumed as a regex and the span runs to the real `}`.
  const returnRegex = '  const m = x.toString();\n  return /\\}/.test(m);\n';
  // signature(1) + returnRegex(2) + bodyLines(MAX_FUNCTION_SLOC-1)(79) + close(1) = 83 SLOC > 80
  const src = `function hasReturnRegex() {\n${returnRegex}${bodyLines(MAX_FUNCTION_SLOC - 1)}\n}\n`;
  const hits = byCode(lintSource('fix1.mjs', src), 'lint-function-too-large');
  assert.equal(hits.length, 1, 'return /\\}/ must not close span early');
  assert.match(hits[0].message, /hasReturnRegex/);
});

// ── lintTree (fs wrapper) ─────────────────────────────────────────────────────────

test('lintTree recursively scans every .mjs under a real dir and never throws', () => {
  const r = lintTree(SRC_DIR);
  assert.ok(Array.isArray(r.scanned) && r.scanned.length > 0);
  assert.ok(r.scanned.every((p) => /\.mjs$/i.test(p)));
  // scanned is sorted for determinism.
  assert.deepEqual(r.scanned, [...r.scanned].sort());
  assert.ok(Array.isArray(r.diagnostics));
});

test('lintTree on a missing dir → a lint-read-failed diagnostic, no throw', () => {
  const r = lintTree(join(SRC_DIR, 'no-such-dir-xyz'));
  assert.deepEqual(r.scanned, []);
  assert.equal(byCode(r.diagnostics, 'lint-read-failed').length, 1);
  assert.equal(r.diagnostics[0].phase, 'lint');
});

test('lintTree on empty / non-string root → empty result, no throw', () => {
  for (const bad of ['', undefined, null, 42, {}]) {
    const r = lintTree(bad);
    assert.deepEqual(r, { diagnostics: [], scanned: [] });
  }
});
