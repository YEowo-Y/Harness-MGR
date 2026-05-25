/**
 * P2.U6b-3 — probe-access.test.mjs
 *
 * Tests for gatherLockProbe (src/discovery/probe-access.mjs).
 * The openFn is injected so no real locking is needed for most tests.
 * Two real-filesystem tests at the end use a temp dir.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { gatherLockProbe } from '../src/discovery/probe-access.mjs';

// ── A. bad configDir ──────────────────────────────────────────────────────────

test('bad configDir (missing) → lock null + one discover-bad-root error, no throw', () => {
  let result;
  assert.doesNotThrow(() => { result = gatherLockProbe({}); });
  assert.strictEqual(result.lock, null);
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0].code, 'discover-bad-root');
  assert.equal(result.diagnostics[0].severity, 'error');
  assert.equal(result.diagnostics[0].phase, 'access-probe');
});

test('bad configDir (empty string) → lock null + one discover-bad-root error', () => {
  const result = gatherLockProbe({ configDir: '' });
  assert.strictEqual(result.lock, null);
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0].code, 'discover-bad-root');
});

test('bad configDir (number) → lock null + one discover-bad-root error', () => {
  const result = gatherLockProbe({ configDir: /** @type {any} */ (42) });
  assert.strictEqual(result.lock, null);
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0].code, 'discover-bad-root');
});

test('no args at all → lock null + one discover-bad-root error, no throw', () => {
  let result;
  assert.doesNotThrow(() => { result = gatherLockProbe(); });
  assert.strictEqual(result.lock, null);
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0].code, 'discover-bad-root');
});

// ── B. injected openFn — success path ────────────────────────────────────────

test('openFn returns normally → status free, no diagnostics', () => {
  const result = gatherLockProbe({ configDir: '/fake/dir', openFn: () => {} });
  assert.ok(result.lock);
  assert.equal(result.lock.status, 'free');
  assert.equal(result.diagnostics.length, 0);
});

test('lock.path contains configDir portion and settings.json', () => {
  const result = gatherLockProbe({ configDir: '/my/config', openFn: () => {} });
  assert.ok(result.lock.path.includes('settings.json'), 'path should include settings.json');
  assert.ok(result.lock.path.includes('my') && result.lock.path.includes('config'), 'path should include configDir segments');
});

// ── C. injected openFn — ENOENT ───────────────────────────────────────────────

test('openFn throws ENOENT → status absent', () => {
  const err = Object.assign(new Error('not found'), { code: 'ENOENT' });
  const result = gatherLockProbe({ configDir: '/fake/dir', openFn: () => { throw err; } });
  assert.equal(result.lock.status, 'absent');
  assert.equal(result.diagnostics.length, 0);
});

// ── D. injected openFn — lock codes ──────────────────────────────────────────

for (const code of ['EBUSY', 'EACCES', 'EPERM', 'ELOCK']) {
  test(`openFn throws ${code} → status locked`, () => {
    const err = Object.assign(new Error('locked'), { code });
    const result = gatherLockProbe({ configDir: '/fake/dir', openFn: () => { throw err; } });
    assert.equal(result.lock.status, 'locked');
    assert.equal(result.diagnostics.length, 0);
  });
}

// ── E. injected openFn — indeterminate ───────────────────────────────────────

test('openFn throws unknown code EOTHER → status indeterminate', () => {
  const err = Object.assign(new Error('other'), { code: 'EOTHER' });
  const result = gatherLockProbe({ configDir: '/fake/dir', openFn: () => { throw err; } });
  assert.equal(result.lock.status, 'indeterminate');
  assert.equal(result.diagnostics.length, 0);
});

test('openFn throws error with no code → status indeterminate', () => {
  const result = gatherLockProbe({ configDir: '/fake/dir', openFn: () => { throw new Error('no code'); } });
  assert.equal(result.lock.status, 'indeterminate');
});

test('openFn throws a non-Error (string) → status indeterminate, no throw', () => {
  let result;
  assert.doesNotThrow(() => {
    result = gatherLockProbe({ configDir: '/fake/dir', openFn: () => { throw 'whoops'; } });
  });
  assert.equal(result.lock.status, 'indeterminate');
});

// ── F. real filesystem tests ──────────────────────────────────────────────────

test('real: settings.json present in temp dir → status free', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'probe-access-'));
  try {
    writeFileSync(join(tmp, 'settings.json'), '{}');
    const result = gatherLockProbe({ configDir: tmp });
    assert.equal(result.lock.status, 'free');
    assert.equal(result.diagnostics.length, 0);
    assert.ok(result.lock.path.endsWith(`${sep}settings.json`) || result.lock.path.endsWith('/settings.json'));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('real: settings.json absent from temp dir → status absent', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'probe-access-'));
  try {
    // Do NOT create settings.json — temp dir is empty
    const result = gatherLockProbe({ configDir: tmp });
    assert.equal(result.lock.status, 'absent');
    assert.equal(result.diagnostics.length, 0);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
