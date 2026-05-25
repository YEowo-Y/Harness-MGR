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

// ── B2. #24 insecure-permissions — direct via ACCESS_CHECKS ──────────────────

/** Find check #24 in ACCESS_CHECKS. */
function check24() {
  const c = ACCESS_CHECKS.find((ch) => ch.id === 24);
  assert.ok(c, 'check #24 not found in ACCESS_CHECKS');
  return c;
}

test('#24: status broad + two principals → one warn insecure-permissions mentioning both', () => {
  const check = check24();
  const diags = check.run({ acl: { path: '/s', status: 'broad', broadPrincipals: ['BUILTIN\\Users', 'Everyone'] } });
  assert.equal(diags.length, 1);
  assert.equal(diags[0].severity, 'warn');
  assert.equal(diags[0].code, 'insecure-permissions');
  assert.equal(diags[0].phase, 'doctor');
  assert.equal(diags[0].path, '/s');
  assert.match(diags[0].message, /BUILTIN\\Users/);
  assert.match(diags[0].message, /Everyone/);
  assert.ok(typeof diags[0].fix === 'string' && diags[0].fix.length > 0);
});

test('#24: status owner-only → [] (no finding)', () => {
  const check = check24();
  const diags = check.run({ acl: { path: '/s', status: 'owner-only', broadPrincipals: [] } });
  assert.deepEqual(diags, []);
});

test('#24: status absent → [] (benign: dir not yet created)', () => {
  const check = check24();
  const diags = check.run({ acl: { path: '/s', status: 'absent', broadPrincipals: [] } });
  assert.deepEqual(diags, []);
});

test('#24: status unsupported → [] (non-Windows, icacls unavailable)', () => {
  const check = check24();
  const diags = check.run({ acl: { path: '', status: 'unsupported', broadPrincipals: [] } });
  assert.deepEqual(diags, []);
});

test('#24: status indeterminate → [] (fail-safe: no false positive)', () => {
  const check = check24();
  const diags = check.run({ acl: { path: '/s', status: 'indeterminate', broadPrincipals: [] } });
  assert.deepEqual(diags, []);
});

test('#24: acl null → [] (no finding)', () => {
  const check = check24();
  const diags = check.run({ acl: null });
  assert.deepEqual(diags, []);
});

test('#24: acl missing (undefined) → []', () => {
  const check = check24();
  const diags = check.run({});
  assert.deepEqual(diags, []);
});

test('#24: via runDoctor() — status broad → one insecure-permissions warn', () => {
  const r = runDoctor({ acl: { path: '/mgr-state', status: 'broad', broadPrincipals: ['Everyone'] } });
  const found = byCode(r.diagnostics, 'insecure-permissions');
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, 'warn');
  assert.equal(found[0].path, '/mgr-state');
  assert.match(found[0].message, /Everyone/);
});

test('#24: via runDoctor() — status owner-only → no insecure-permissions findings', () => {
  const r = runDoctor({ acl: { path: '/s', status: 'owner-only', broadPrincipals: [] } });
  assert.equal(byCode(r.diagnostics, 'insecure-permissions').length, 0);
});

test('#24: via runDoctor() — acl absent → no findings, no throw', () => {
  let r;
  assert.doesNotThrow(() => { r = runDoctor({}); });
  assert.equal(byCode(r.diagnostics, 'insecure-permissions').length, 0);
});

// ── C. ACCESS_CHECKS registry ────────────────────────────────────────────────

test('ACCESS_CHECKS ids === [17, 24]', () => {
  assert.deepEqual(ACCESS_CHECKS.map((c) => c.id), [17, 24]);
});

test('ACCESS_CHECKS is frozen', () => {
  assert.ok(Object.isFrozen(ACCESS_CHECKS));
  assert.ok(Object.isFrozen(ACCESS_CHECKS[0]));
});

// ── D. Full CHECKS registry ──────────────────────────────────────────────────

test('full CHECKS registry length is 24', () => {
  assert.equal(CHECKS.length, 24);
});

test('full CHECKS id order is [1,2,3,5,18,6,7,8,9,10,11,12,22,23,13,14,16,20,21,25,17,24,4,15]', () => {
  assert.deepEqual(
    CHECKS.map((c) => c.id),
    [1, 2, 3, 5, 18, 6, 7, 8, 9, 10, 11, 12, 22, 23, 13, 14, 16, 20, 21, 25, 17, 24, 4, 15],
  );
});
