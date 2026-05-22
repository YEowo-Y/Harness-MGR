/**
 * P1.U14 (sub-unit B) — output-table.test.mjs
 *
 * Golden + boundary tests for the human table adapter: column alignment (left +
 * right) against fixed expected strings, the empty-rows / empty-columns edge
 * cases, never-throws cell coercion, and the NO_COLOR-aware colorize helper.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { formatTable, colorize } from '../src/output/table.mjs';

// ── A. ALIGNMENT (fixed golden strings) ───────────────────────────────────────────

test('alignment: left + right columns produce exact expected layout', () => {
  const columns = [
    { key: 'name', header: 'Name' },
    { key: 'age', header: 'Age', align: 'right' },
  ];
  const rows = [
    { name: 'Al', age: 3 },
    { name: 'Robert', age: 100 },
  ];
  // name width = max(4,2,6)=6 ; age width = max(3,1,3)=3 ; gap = 2 spaces.
  const expected = [
    'Name    Age', // 'Name' + 2 fill + 2 gap + 'Age'
    '------  ---', // dashes per width, joined by gap
    'Al        3', // 'Al' + 4 fill (=width 6) + 2 gap + (right) 2 fill + '3'
    'Robert  100', // 'Robert' (=width) + 2 gap + '100' (=width)
  ].join('\n');
  assert.equal(formatTable(columns, rows), expected);
});

test('alignment: every data line shares the same column-start offsets', () => {
  const columns = [
    { key: 'a', header: 'AA' },
    { key: 'b', header: 'B' },
  ];
  const rows = [
    { a: 'x', b: 'yy' },
    { a: 'xxx', b: 'y' },
  ];
  const lines = formatTable(columns, rows).split('\n');
  // First column width = max('AA'=2,'x'=1,'xxx'=3)=3, + 2-space gap → second
  // column starts at index 5 on every line that carries a second-column token.
  const offsets = [
    lines[0].indexOf('B'), // header
    lines[2].indexOf('yy'), // row 1 second cell
    lines[3].indexOf('y'), // row 2 second cell
  ];
  assert.deepEqual(offsets, [5, 5, 5]);
});

test('right-align pads on the left', () => {
  const out = formatTable([{ key: 'n', header: 'N', align: 'right' }], [{ n: 5 }]);
  // width = max('N'=1,'5'=1) = 1 → no padding needed; header 'N', sep '-', row '5'.
  assert.equal(out, 'N\n-\n5');
});

test('right-align widens correctly when a cell is the widest', () => {
  const out = formatTable([{ key: 'n', header: 'N', align: 'right' }], [{ n: 42 }]);
  // width = max(1,2) = 2 → header ' N', sep '--', row '42'.
  assert.equal(out, ' N\n--\n42');
});

// ── B. EMPTY CASES ──────────────────────────────────────────────────────────────

test('empty rows → header + separator only', () => {
  const out = formatTable([{ key: 'name', header: 'Name' }], []);
  assert.equal(out, 'Name\n----');
});

test('empty columns → empty string', () => {
  assert.equal(formatTable([], [{ a: 1 }]), '');
  assert.equal(formatTable([], []), '');
});

// ── C. NEVER-THROWS CELL COERCION ─────────────────────────────────────────────────

test('non-string cells are coerced via String(); null/undefined → empty', () => {
  const columns = [
    { key: 'num', header: 'Num' },
    { key: 'nil', header: 'Nil' },
    { key: 'undef', header: 'Undef' },
    { key: 'obj', header: 'Obj' },
  ];
  const rows = [{ num: 42, nil: null, undef: undefined, obj: { toString: () => 'OBJ' } }];
  let out;
  assert.doesNotThrow(() => { out = formatTable(columns, rows); });
  const dataLine = out.split('\n')[2];
  assert.ok(dataLine.includes('42'));
  assert.ok(dataLine.includes('OBJ'));
  // null/undefined render as empty (padded) — never the literal text.
  assert.ok(!dataLine.includes('null'));
  assert.ok(!dataLine.includes('undefined'));
});

test('missing row keys and a missing row object never throw', () => {
  const columns = [{ key: 'a', header: 'A' }];
  assert.doesNotThrow(() => formatTable(columns, [{}, null, undefined]));
});

test('non-array columns/rows degrade without throwing', () => {
  assert.equal(formatTable(/** @type {any} */ (null), []), '');
  assert.doesNotThrow(() => formatTable([{ key: 'a', header: 'A' }], /** @type {any} */ (null)));
});

// ── D. NO_COLOR-AWARE COLORIZE ─────────────────────────────────────────────────────

test('colorize wraps text in an SGR code + reset when color is enabled', () => {
  const saved = process.env.NO_COLOR;
  delete process.env.NO_COLOR;
  try {
    const out = colorize('x', 31, { color: true });
    assert.equal(out, '[31mx[0m');
  } finally {
    if (saved !== undefined) process.env.NO_COLOR = saved;
  }
});

test('colorize returns text unchanged when NO_COLOR is set (no escapes)', () => {
  const saved = process.env.NO_COLOR;
  process.env.NO_COLOR = '1';
  try {
    assert.equal(colorize('x', 31), 'x');
    // Even an explicit color:true yields to NO_COLOR.
    assert.equal(colorize('x', 31, { color: true }), 'x');
  } finally {
    if (saved === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = saved;
  }
});

test('colorize returns text unchanged when opts.color === false', () => {
  const saved = process.env.NO_COLOR;
  delete process.env.NO_COLOR;
  try {
    assert.equal(colorize('x', 31, { color: false }), 'x');
  } finally {
    if (saved !== undefined) process.env.NO_COLOR = saved;
  }
});

test('colorize is enabled by default when NO_COLOR is unset and no opts given', () => {
  const saved = process.env.NO_COLOR;
  delete process.env.NO_COLOR;
  try {
    assert.equal(colorize('hi', '1;32'), '[1;32mhi[0m');
  } finally {
    if (saved !== undefined) process.env.NO_COLOR = saved;
  }
});

test('colorize coerces non-string text without throwing', () => {
  const saved = process.env.NO_COLOR;
  process.env.NO_COLOR = '1';
  try {
    assert.equal(colorize(/** @type {any} */ (null), 31), '');
    assert.equal(colorize(/** @type {any} */ (42), 31), '42');
  } finally {
    if (saved === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = saved;
  }
});
