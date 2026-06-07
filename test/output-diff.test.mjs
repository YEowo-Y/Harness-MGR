/**
 * Falsifiable golden tests for the Myers line-diff engine (src/output/diff.mjs,
 * P4b.U7a). The Myers SES is easy to get subtly wrong, so these pin EXACT op
 * sequences and EXACT unified/JSON strings rather than just shapes — the
 * minimality, CRLF, and golden-unified oracles below prove the algorithm is a real
 * LCS/Myers diff, not a naive delete-all/insert-all.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeLineDiff, formatUnified, diffToJson } from '../src/output/diff.mjs';

/** Compact view of an op sequence for exact assertions. */
function shape(diff) {
  return diff.ops.map((o) => `${o.type}:${o.text}:${o.aLine}:${o.bLine}`);
}

test('computeLineDiff: identical text → all equal, 0 added/deleted', () => {
  const d = computeLineDiff('a\nb\nc', 'a\nb\nc');
  assert.deepEqual(d.stats, { added: 0, deleted: 0, unchanged: 3 });
  assert.ok(d.ops.every((o) => o.type === 'equal'));
  assert.deepEqual(shape(d), ['equal:a:1:1', 'equal:b:2:2', 'equal:c:3:3']);
});

test('computeLineDiff: empty a, non-empty b → all insert; added === b line count', () => {
  // '' splits to [''] (one empty line); b='x\ny\nz' is 3 lines.
  const d = computeLineDiff('', 'x\ny\nz');
  // The single empty a-line matches nothing in b's first line, so every b line is
  // an insert; a's lone '' is a delete OR matches b's trailing — here a='' vs no ''.
  const inserts = d.ops.filter((o) => o.type === 'insert');
  assert.equal(d.stats.added, inserts.length);
  assert.ok(inserts.length >= 3, 'all b lines inserted');
  assert.ok(inserts.every((o) => o.aLine === null && typeof o.bLine === 'number'));
});

test('computeLineDiff: non-empty a, empty b → every a line deleted', () => {
  // a=['p','q','r'] vs b=[''] : no common line, so p,q,r all delete; b's lone ''
  // empty line (the split('') sentinel) has no match in a → it inserts. That insert
  // is correct, not a bug — '' is a real, distinct line.
  const d = computeLineDiff('p\nq\nr', '');
  const deletes = d.ops.filter((o) => o.type === 'delete');
  assert.equal(d.stats.deleted, 3);
  assert.deepEqual(deletes.map((o) => o.text), ['p', 'q', 'r']);
  assert.ok(deletes.every((o) => o.bLine === null && typeof o.aLine === 'number'));
  assert.equal(d.stats.added, 1); // the single trailing '' line in b
});

test('computeLineDiff: interleaved single-line edit → one delete + one insert', () => {
  const d = computeLineDiff('A\nB\nC\nD', 'A\nX\nC\nD');
  // Real Myers: keep A, delete B, insert X, keep C and D — NOT delete-all/insert-all.
  assert.deepEqual(shape(d), [
    'equal:A:1:1',
    'delete:B:2:null',
    'insert:X:null:2',
    'equal:C:3:3',
    'equal:D:4:4',
  ]);
  assert.deepEqual(d.stats, { added: 1, deleted: 1, unchanged: 3 });
});

test('computeLineDiff: MINIMALITY — deletes only the removed lines (real LCS)', () => {
  // a=1,2,3,4,5  b=1,3,5  → LCS is 1,3,5 → delete 2 and 4 ONLY, no inserts.
  const d = computeLineDiff('1\n2\n3\n4\n5', '1\n3\n5');
  assert.deepEqual(shape(d), [
    'equal:1:1:1',
    'delete:2:2:null',
    'equal:3:3:2',
    'delete:4:4:null',
    'equal:5:5:3',
  ]);
  assert.deepEqual(d.stats, { added: 0, deleted: 2, unchanged: 3 });
});

test('computeLineDiff: CRLF normalization — X\\r\\nY vs X\\nY → all equal', () => {
  const d = computeLineDiff('X\r\nY', 'X\nY');
  assert.deepEqual(d.stats, { added: 0, deleted: 0, unchanged: 2 });
  assert.ok(d.ops.every((o) => o.type === 'equal'));
  // lone CR also normalized
  const d2 = computeLineDiff('X\rY', 'X\nY');
  assert.deepEqual(d2.stats, { added: 0, deleted: 0, unchanged: 2 });
});

test('computeLineDiff: trailing newline yields a final empty line (distinct from none)', () => {
  const withNl = computeLineDiff('a\n', 'a\n');
  assert.deepEqual(withNl.ops.map((o) => o.text), ['a', '']);
  // "a" vs "a\n": the trailing empty line is an insert (a real, diffable difference).
  const d = computeLineDiff('a', 'a\n');
  assert.equal(d.stats.added, 1);
  assert.equal(d.stats.deleted, 0);
});

test('computeLineDiff: non-string input (null / number) → treated as empty, no throw', () => {
  assert.doesNotThrow(() => computeLineDiff(null, 42));
  const d = computeLineDiff(null, 'x');
  // a coerces to '' → [''] ; b='x' → ['x']
  assert.equal(d.stats.deleted + d.stats.added + d.stats.unchanged, d.ops.length);
  assert.doesNotThrow(() => computeLineDiff(undefined, undefined));
  const empties = computeLineDiff(undefined, undefined);
  assert.deepEqual(empties.stats, { added: 0, deleted: 0, unchanged: 1 }); // ['']==['']
});

test('formatUnified: GOLDEN — single mid-file edit, context=1', () => {
  const d = computeLineDiff('a\nb\nc\nd\ne', 'a\nb\nC\nd\ne');
  const out = formatUnified(d, { context: 1 });
  // aCount = #context+#delete = 'b','c','d' = 3 ; bCount = 'b','C','d' = 3.
  // hunk starts at A line 2 ('b') and B line 2 ('b').
  const expected = [
    '--- a',
    '+++ b',
    '@@ -2,3 +2,3 @@',
    ' b',
    '-c',
    '+C',
    ' d',
  ].join('\n');
  assert.equal(out, expected);
});

test('formatUnified: GOLDEN — context=0 narrows to the changed lines only', () => {
  const d = computeLineDiff('a\nb\nc\nd\ne', 'a\nb\nC\nd\ne');
  const out = formatUnified(d, { context: 0 });
  const expected = ['--- a', '+++ b', '@@ -3,1 +3,1 @@', '-c', '+C'].join('\n');
  assert.equal(out, expected);
});

test('formatUnified: identical files → header only, NO hunk body', () => {
  const d = computeLineDiff('x\ny', 'x\ny');
  assert.equal(formatUnified(d, {}), '--- a\n+++ b');
  // custom labels honored
  assert.equal(formatUnified(d, { aLabel: 'old', bLabel: 'new' }), '--- old\n+++ new');
});

test('formatUnified: custom labels + default context appear in header/hunks', () => {
  const d = computeLineDiff('a\nb\nc\nd\ne', 'a\nb\nC\nd\ne');
  const out = formatUnified(d, { aLabel: 'L', bLabel: 'R' }); // default context 3
  assert.ok(out.startsWith('--- L\n+++ R\n@@ '));
  assert.ok(out.includes('-c'));
  assert.ok(out.includes('+C'));
});

test('diffToJson: GOLDEN — stats + hunks match the unified hunking exactly', () => {
  const d = computeLineDiff('a\nb\nc\nd\ne', 'a\nb\nC\nd\ne');
  const json = diffToJson(d, { context: 1 });
  assert.equal(json.aLabel, 'a');
  assert.equal(json.bLabel, 'b');
  assert.deepEqual(json.stats, { added: 1, deleted: 1, unchanged: 4 });
  assert.equal(json.hunks.length, 1);
  const h = json.hunks[0];
  // Same @@ counts as formatUnified's '@@ -2,3 +2,3 @@'.
  assert.deepEqual(
    { aStart: h.aStart, aCount: h.aCount, bStart: h.bStart, bCount: h.bCount },
    { aStart: 2, aCount: 3, bStart: 2, bCount: 3 },
  );
  assert.deepEqual(h.lines, [
    { type: 'equal', text: 'b' },
    { type: 'delete', text: 'c' },
    { type: 'insert', text: 'C' },
    { type: 'equal', text: 'd' },
  ]);
});

test('diffToJson / formatUnified: hunk boundaries never drift (shared buildHunks)', () => {
  // A two-change file with a wide gap → two separate hunks at context=1.
  const a = '1\n2\n3\n4\n5\n6\n7\n8\n9';
  const b = '1\nX\n3\n4\n5\n6\n7\nY\n9';
  const json = diffToJson(computeLineDiff(a, b), { context: 1 });
  const unified = formatUnified(computeLineDiff(a, b), { context: 1 });
  // Same number of hunks in both renderings.
  const atCount = (unified.match(/^@@ /gm) || []).length;
  assert.equal(json.hunks.length, atCount);
  assert.equal(json.hunks.length, 2);
  // Each JSON hunk's @@ counts appear verbatim in the unified text.
  for (const h of json.hunks) {
    assert.ok(unified.includes(`@@ -${h.aStart},${h.aCount} +${h.bStart},${h.bCount} @@`));
  }
});

test('never-throws on junk: null/undefined inputs degrade to sane empties', () => {
  assert.doesNotThrow(() => computeLineDiff(null, null));
  const d = computeLineDiff(null, null);
  assert.deepEqual(d.stats, { added: 0, deleted: 0, unchanged: 1 }); // [''] vs ['']

  assert.doesNotThrow(() => formatUnified(null, {}));
  assert.equal(formatUnified(null, {}), '--- a\n+++ b'); // no ops → header only
  assert.equal(formatUnified(null, null), '--- a\n+++ b'); // null opts coerced

  assert.doesNotThrow(() => diffToJson(undefined));
  const j = diffToJson(undefined);
  assert.deepEqual(j, { aLabel: 'a', bLabel: 'b', stats: { added: 0, deleted: 0, unchanged: 0 }, hunks: [] });

  // a malformed diff with non-array ops → empty hunks, no throw
  assert.doesNotThrow(() => formatUnified({ ops: 'nope', stats: null }, {}));
  assert.equal(formatUnified({ ops: 'nope' }, {}), '--- a\n+++ b');
});

test('never-throws: an ops ARRAY containing null/junk elements (boundary filter)', () => {
  // A non-array ops was already covered; this pins the array-of-junk class the
  // documented never-throws invariant also covers (buildHunks filters at the edge).
  assert.doesNotThrow(() => formatUnified({ ops: [null] }, {}));
  assert.doesNotThrow(() => formatUnified({ ops: [null, 42, 'x'] }, {}));
  assert.doesNotThrow(() => diffToJson({ ops: [null, { type: 'weird' }] }));
  // A field-incomplete object op must not emit `undefined` into a @@ header.
  const s = formatUnified({ ops: [{ type: 'delete' }] }, {});
  assert.ok(!s.includes('undefined'), `no undefined in output: ${s}`);
});

test('formatUnified: GOLDEN — pure insert pins ASYMMETRIC @@ counts (aCount≠bCount)', () => {
  // Inserting one line at the top: aCount=2 (the two equal context lines),
  // bCount=3 (insert + two equal). A mutant that swapped aCount/bCount would
  // render `@@ -1,3 +1,2 @@` and turn this RED.
  const d = computeLineDiff('b\nc', 'A\nb\nc');
  assert.equal(
    formatUnified(d, { context: 3 }),
    ['--- a', '+++ b', '@@ -1,2 +1,3 @@', '+A', ' b', ' c'].join('\n'),
  );
});
