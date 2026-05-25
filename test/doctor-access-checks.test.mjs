/**
 * P2.U6b-3 — doctor-access-checks.test.mjs
 *
 * Tests for the pure access doctor check:
 *   #17 windows-file-locks  — LockFact status 'locked' → warn
 *
 * Exercised directly via ACCESS_CHECKS and via runDoctor() for integration.
 * Also asserts the full CHECKS registry length and id order.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { runDoctor, CHECKS } from '../src/analysis/doctor/index.mjs';
import { ACCESS_CHECKS } from '../src/analysis/doctor/access-checks.mjs';

/** Find check #17 in ACCESS_CHECKS. */
function check17() {
  const c = ACCESS_CHECKS.find((ch) => ch.id === 17);
  assert.ok(c, 'check #17 not found in ACCESS_CHECKS');
  return c;
}

/** Filter diagnostics by code. */
const byCode = (diags, code) => diags.filter((d) => d.code === code);

// ── A. #17 windows-file-locks — direct via ACCESS_CHECKS ─────────────────────

test('#17: status locked → one warn windows-file-locks', () => {
  const check = check17();
  const diags = check.run({ lock: { path: '/a/.claude/settings.json', status: 'locked' } });
  assert.equal(diags.length, 1);
  assert.equal(diags[0].severity, 'warn');
  assert.equal(diags[0].code, 'windows-file-locks');
  assert.equal(diags[0].phase, 'doctor');
  assert.match(diags[0].message, /locked/i);
  assert.equal(diags[0].path, '/a/.claude/settings.json');
  assert.ok(typeof diags[0].fix === 'string' && diags[0].fix.length > 0);
});

test('#17: status free → no findings', () => {
  const check = check17();
  const diags = check.run({ lock: { path: '/x/settings.json', status: 'free' } });
  assert.deepEqual(diags, []);
});

test('#17: status absent → no findings', () => {
  const check = check17();
  const diags = check.run({ lock: { path: '/x/settings.json', status: 'absent' } });
  assert.deepEqual(diags, []);
});

test('#17: status indeterminate → no findings', () => {
  const check = check17();
  const diags = check.run({ lock: { path: '/x/settings.json', status: 'indeterminate' } });
  assert.deepEqual(diags, []);
});

test('#17: lock null → no findings', () => {
  const check = check17();
  const diags = check.run({ lock: null });
  assert.deepEqual(diags, []);
});

test('#17: lock missing (undefined) → no findings', () => {
  const check = check17();
  const diags = check.run({});
  assert.deepEqual(diags, []);
});

test('#17: lock is a non-object (string) → no findings, no throw', () => {
  const check = check17();
  let diags;
  assert.doesNotThrow(() => { diags = check.run({ lock: /** @type {any} */ ('bad') }); });
  assert.deepEqual(diags, []);
});

test('#17: path is a non-string → finding has no path property', () => {
  const check = check17();
  const diags = check.run({ lock: { path: /** @type {any} */ (42), status: 'locked' } });
  assert.equal(diags.length, 1);
  assert.equal(diags[0].path, undefined);
  // message should still mention something about locked/settings.json
  assert.ok(typeof diags[0].message === 'string');
});

// ── B. #17 via runDoctor() integration ───────────────────────────────────────

test('runDoctor: lock status locked → one warn windows-file-locks', () => {
  const r = runDoctor({ lock: { path: '/c/.claude/settings.json', status: 'locked' } });
  const found = byCode(r.diagnostics, 'windows-file-locks');
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, 'warn');
});

test('runDoctor: lock status free → no windows-file-locks findings', () => {
  const r = runDoctor({ lock: { path: '/c/.claude/settings.json', status: 'free' } });
  assert.equal(byCode(r.diagnostics, 'windows-file-locks').length, 0);
});

test('runDoctor: no lock in input → no windows-file-locks findings', () => {
  const r = runDoctor({});
  assert.equal(byCode(r.diagnostics, 'windows-file-locks').length, 0);
});

// ── C. ACCESS_CHECKS registry ────────────────────────────────────────────────

test('ACCESS_CHECKS ids === [17]', () => {
  assert.deepEqual(ACCESS_CHECKS.map((c) => c.id), [17]);
});

test('ACCESS_CHECKS is frozen', () => {
  assert.ok(Object.isFrozen(ACCESS_CHECKS));
  assert.ok(Object.isFrozen(ACCESS_CHECKS[0]));
});

// ── D. Full CHECKS registry ──────────────────────────────────────────────────

test('full CHECKS registry length is 21', () => {
  assert.equal(CHECKS.length, 21);
});

test('full CHECKS id order is [1,2,3,5,18,6,7,8,9,10,11,12,22,23,13,14,16,20,21,25,17]', () => {
  assert.deepEqual(
    CHECKS.map((c) => c.id),
    [1, 2, 3, 5, 18, 6, 7, 8, 9, 10, 11, 12, 22, 23, 13, 14, 16, 20, 21, 25, 17],
  );
});
