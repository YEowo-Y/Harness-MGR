/**
 * P1.U12 — orphans.test.mjs
 *
 * Tests for analyzeOrphans(), the analysis-layer flatten over the discovery
 * orphan detector. Golden shape against the orphan/ fixture (consuming a real
 * detectOrphans result), order preservation, diagnostic pass-through, bad-input
 * boundaries, and determinism.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectOrphans } from '../src/discovery/orphan-detector.mjs';
import { analyzeOrphans } from '../src/analysis/orphans.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fix = (rel) => join(here, 'fixtures', rel);

const bySeverity = (diags, sev) => diags.filter((d) => d.severity === sev);

// ── A. GOLDEN (catalog #3 — distinguishes hard vs soft) ───────────────────────

test('orphan/golden: summary counts hard=2, soft=3, total=5', () => {
  const r = detectOrphans(fix('orphan'));
  const a = analyzeOrphans(r);
  assert.deepEqual(a.summary, { hard: 2, soft: 3, total: 5 });
});

test('orphan/golden: unified list is 5 records, hard-first then soft', () => {
  const r = detectOrphans(fix('orphan'));
  const a = analyzeOrphans(r);
  assert.equal(a.orphans.length, 5);
  // First 2 are the hard orphans, next 3 are the soft ones.
  assert.equal(a.orphans[0].category, 'hard');
  assert.equal(a.orphans[1].category, 'hard');
  assert.equal(a.orphans[2].category, 'soft');
  assert.equal(a.orphans[3].category, 'soft');
  assert.equal(a.orphans[4].category, 'soft');
  assert.equal(a.orphans.filter((o) => o.category === 'hard').length, 2);
  assert.equal(a.orphans.filter((o) => o.category === 'soft').length, 3);
});

test('orphan/golden: zero error-severity diagnostics', () => {
  const r = detectOrphans(fix('orphan'));
  const a = analyzeOrphans(r);
  assert.equal(bySeverity(a.diagnostics, 'error').length, 0);
});

// ── B. ORDER PRESERVATION ─────────────────────────────────────────────────────

test('order preservation: orphans equals [...hard, ...soft]', () => {
  const r = detectOrphans(fix('orphan'));
  const a = analyzeOrphans(r);
  assert.deepEqual(a.orphans, [...r.hard, ...r.soft]);
});

// ── C. DIAGNOSTIC PASS-THROUGH ────────────────────────────────────────────────

test('pass-through: an input diagnostic appears in the output', () => {
  /** @type {any} */
  const synthetic = {
    hard: [],
    soft: [],
    diagnostics: [{ severity: 'warn', code: 'orphans-unreadable', message: 'boom', path: '/x', phase: 'orphans' }],
  };
  const a = analyzeOrphans(synthetic);
  const found = a.diagnostics.find((d) => d.code === 'orphans-unreadable');
  assert.ok(found, 'the synthetic diagnostic must be passed through');
  assert.equal(found.severity, 'warn');
  assert.equal(found.message, 'boom');
});

// ── D. BOUNDARY ───────────────────────────────────────────────────────────────

test('boundary: null input → bad-input error, never throws', () => {
  let a;
  assert.doesNotThrow(() => { a = analyzeOrphans(/** @type {any} */ (null)); });
  assert.deepEqual(a.orphans, []);
  assert.deepEqual(a.summary, { hard: 0, soft: 0, total: 0 });
  assert.equal(a.diagnostics.length, 1);
  assert.equal(a.diagnostics[0].code, 'orphans-bad-input');
  assert.equal(a.diagnostics[0].severity, 'error');
});

test('boundary: undefined input → bad-input error, never throws', () => {
  let a;
  assert.doesNotThrow(() => { a = analyzeOrphans(/** @type {any} */ (undefined)); });
  assert.deepEqual(a.orphans, []);
  assert.equal(a.diagnostics[0].code, 'orphans-bad-input');
});

test('boundary: numeric input → bad-input error, never throws', () => {
  let a;
  assert.doesNotThrow(() => { a = analyzeOrphans(/** @type {any} */ (42)); });
  assert.deepEqual(a.orphans, []);
  assert.deepEqual(a.summary, { hard: 0, soft: 0, total: 0 });
  assert.equal(a.diagnostics.length, 1);
  assert.equal(a.diagnostics[0].code, 'orphans-bad-input');
  assert.equal(a.diagnostics[0].severity, 'error');
});

test('boundary: empty object → coerced empties, no error diagnostic', () => {
  let a;
  assert.doesNotThrow(() => { a = analyzeOrphans({}); });
  assert.deepEqual(a.orphans, []);
  assert.deepEqual(a.summary, { hard: 0, soft: 0, total: 0 });
  assert.equal(bySeverity(a.diagnostics, 'error').length, 0);
});

test('boundary: malformed field types all coerce to empty, no throw', () => {
  let a;
  assert.doesNotThrow(() => {
    a = analyzeOrphans(/** @type {any} */ ({ hard: 'notarray', soft: null, diagnostics: 'nope' }));
  });
  assert.deepEqual(a.orphans, []);
  assert.deepEqual(a.summary, { hard: 0, soft: 0, total: 0 });
  assert.deepEqual(a.diagnostics, []);
});

// ── E. DETERMINISM ────────────────────────────────────────────────────────────

test('determinism: two calls on the same input deepEqual', () => {
  const r = detectOrphans(fix('orphan'));
  const a1 = analyzeOrphans(r);
  const a2 = analyzeOrphans(r);
  assert.deepEqual(a1, a2);
});
