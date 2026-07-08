/**
 * P2.U6b-3 — probe-access.test.mjs
 *
 * Tests for gatherLockProbe (src/discovery/probe-access.mjs).
 * The openFn is injected so no real locking is needed for most tests.
 * Two real-filesystem tests at the end use a temp dir.
 *
 * Lock detection is a WINDOWS-ONLY probe: off win32, gatherLockProbe short-circuits
 * to status 'unsupported' before the opener runs. The lock-classification tests
 * therefore inject platform:'win32' (via winLockProbe) so they exercise the
 * open+classify path deterministically on ANY host; a dedicated section asserts the
 * non-win32 'unsupported' behaviour.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { gatherLockProbe } from '../src/discovery/probe-access.mjs';

/** Probe as if on Windows, so the open+classify path runs regardless of host OS. */
const winLockProbe = (opts) => gatherLockProbe({ platform: 'win32', ...opts });

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
  const result = winLockProbe({ configDir: '/fake/dir', openFn: () => {} });
  assert.ok(result.lock);
  assert.equal(result.lock.status, 'free');
  assert.equal(result.diagnostics.length, 0);
});

test('lock.path contains configDir portion and settings.json', () => {
  const result = winLockProbe({ configDir: '/my/config', openFn: () => {} });
  assert.ok(result.lock.path.includes('settings.json'), 'path should include settings.json');
  assert.ok(result.lock.path.includes('my') && result.lock.path.includes('config'), 'path should include configDir segments');
});

// ── C. injected openFn — ENOENT ───────────────────────────────────────────────

test('openFn throws ENOENT → status absent', () => {
  const err = Object.assign(new Error('not found'), { code: 'ENOENT' });
  const result = winLockProbe({ configDir: '/fake/dir', openFn: () => { throw err; } });
  assert.equal(result.lock.status, 'absent');
  assert.equal(result.diagnostics.length, 0);
});

// ── D. injected openFn — lock codes ──────────────────────────────────────────

for (const code of ['EBUSY', 'EACCES', 'EPERM', 'ELOCK']) {
  test(`openFn throws ${code} → status locked`, () => {
    const err = Object.assign(new Error('locked'), { code });
    const result = winLockProbe({ configDir: '/fake/dir', openFn: () => { throw err; } });
    assert.equal(result.lock.status, 'locked');
    assert.equal(result.diagnostics.length, 0);
  });
}

// ── E. injected openFn — indeterminate ───────────────────────────────────────

test('openFn throws unknown code EOTHER → status indeterminate', () => {
  const err = Object.assign(new Error('other'), { code: 'EOTHER' });
  const result = winLockProbe({ configDir: '/fake/dir', openFn: () => { throw err; } });
  assert.equal(result.lock.status, 'indeterminate');
  assert.equal(result.diagnostics.length, 0);
});

test('openFn throws error with no code → status indeterminate', () => {
  const result = winLockProbe({ configDir: '/fake/dir', openFn: () => { throw new Error('no code'); } });
  assert.equal(result.lock.status, 'indeterminate');
});

test('openFn throws a non-Error (string) → status indeterminate, no throw', () => {
  let result;
  assert.doesNotThrow(() => {
    result = winLockProbe({ configDir: '/fake/dir', openFn: () => { throw 'whoops'; } });
  });
  assert.equal(result.lock.status, 'indeterminate');
});

// ── F. real filesystem tests ──────────────────────────────────────────────────

test('real: settings.json present in temp dir → status free', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'probe-access-'));
  try {
    writeFileSync(join(tmp, 'settings.json'), '{}');
    const result = winLockProbe({ configDir: tmp });
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
    const result = winLockProbe({ configDir: tmp });
    assert.equal(result.lock.status, 'absent');
    assert.equal(result.diagnostics.length, 0);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── G. non-win32 → unsupported (lock detection is a Windows-only concern) ──────
// P1-3 regression guard: on POSIX a shared read-open never fails on another
// process's lock, so the probe must NOT run the opener and must NOT classify a
// permission error as 'locked'. It reports 'unsupported' and the doctor skips #17.

for (const platform of ['linux', 'darwin']) {
  test(`platform ${platform}: status unsupported, opener NOT called, no diagnostics`, () => {
    let opened = false;
    const result = gatherLockProbe({ configDir: '/fake/dir', platform, openFn: () => { opened = true; } });
    assert.ok(result.lock);
    assert.equal(result.lock.status, 'unsupported');
    assert.equal(opened, false, 'opener must not run off win32');
    assert.equal(result.diagnostics.length, 0);
    assert.ok(result.lock.path.includes('settings.json'), 'path is still populated for the fact');
  });
}

test('non-win32 with bad configDir still yields discover-bad-root (validation precedes platform gate)', () => {
  const result = gatherLockProbe({ configDir: '', platform: 'linux' });
  assert.strictEqual(result.lock, null);
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0].code, 'discover-bad-root');
});
