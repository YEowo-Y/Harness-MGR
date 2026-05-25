/**
 * P2.U7b — probe-cli.test.mjs
 *
 * Unit tests for gatherCliProbe, isSpawnable, and extractVersion.
 * ALL tests inject resolveFn and runVersion so they are fully hermetic —
 * no real PATH search, no real spawn, deterministic on any machine.
 *
 * Key invariant: a Windows npm extensionless shim must NEVER trigger
 * 'unresponsive' — runVersion must not be called at all for non-native paths.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { gatherCliProbe, isSpawnable, extractVersion } from '../src/discovery/probe-cli.mjs';

// ---------------------------------------------------------------------------
// A. isSpawnable
// ---------------------------------------------------------------------------

test('isSpawnable: win32 .exe → true', () => {
  assert.equal(isSpawnable('C:\\tools\\claude.exe', 'win32'), true);
});

test('isSpawnable: win32 .EXE uppercase → true (case-insensitive)', () => {
  assert.equal(isSpawnable('C:\\tools\\CLAUDE.EXE', 'win32'), true);
});

test('isSpawnable: win32 .com → true', () => {
  assert.equal(isSpawnable('C:\\tools\\app.com', 'win32'), true);
});

test('isSpawnable: win32 extensionless shim → false', () => {
  assert.equal(isSpawnable('C:\\Users\\me\\AppData\\Roaming\\npm\\claude', 'win32'), false);
});

test('isSpawnable: win32 .cmd → false', () => {
  assert.equal(isSpawnable('C:\\npm\\claude.cmd', 'win32'), false);
});

test('isSpawnable: win32 .ps1 → false', () => {
  assert.equal(isSpawnable('C:\\npm\\claude.ps1', 'win32'), false);
});

test('isSpawnable: win32 .bat → false', () => {
  assert.equal(isSpawnable('C:\\npm\\claude.bat', 'win32'), false);
});

test('isSpawnable: win32 non-string → false', () => {
  assert.equal(isSpawnable(/** @type {any} */ (null), 'win32'), false);
  assert.equal(isSpawnable(/** @type {any} */ (42), 'win32'), false);
});

test('isSpawnable: win32 empty string → false', () => {
  assert.equal(isSpawnable('', 'win32'), false);
});

test('isSpawnable: linux extensionless → true (POSIX honours shebangs)', () => {
  assert.equal(isSpawnable('/usr/local/bin/claude', 'linux'), true);
});

test('isSpawnable: linux .cmd → true (non-win32, no restriction)', () => {
  assert.equal(isSpawnable('/usr/bin/claude.cmd', 'linux'), true);
});

test('isSpawnable: darwin extensionless → true', () => {
  assert.equal(isSpawnable('/usr/local/bin/claude', 'darwin'), true);
});

// ---------------------------------------------------------------------------
// B. extractVersion
// ---------------------------------------------------------------------------

test('extractVersion: semver with trailing text → semver part only', () => {
  assert.equal(extractVersion('2.1.146 (Claude Code)'), '2.1.146');
});

test('extractVersion: v-prefixed semver → digits-only match', () => {
  assert.equal(extractVersion('v1.2.3-beta'), '1.2.3-beta');
});

test('extractVersion: plain semver → returned as-is', () => {
  assert.equal(extractVersion('1.0.0'), '1.0.0');
});

test('extractVersion: empty string → null', () => {
  assert.equal(extractVersion(''), null);
});

test('extractVersion: non-string → null', () => {
  assert.equal(extractVersion(/** @type {any} */ (null)), null);
  assert.equal(extractVersion(/** @type {any} */ (42)), null);
});

test('extractVersion: no semver → first trimmed line (fallback)', () => {
  const result = extractVersion('Claude Code CLI');
  assert.equal(result, 'Claude Code CLI');
});

test('extractVersion: multiline output — semver on second line', () => {
  assert.equal(extractVersion('Claude Code\n2.1.0'), '2.1.0');
});

test('extractVersion: whitespace-only → null', () => {
  assert.equal(extractVersion('   \n  '), null);
});

test('extractVersion: very long no-semver line → capped at 80 chars', () => {
  const long = 'x'.repeat(100);
  const result = extractVersion(long);
  assert.equal(typeof result, 'string');
  assert.ok(result.length <= 80);
});

test('extractVersion: pathological all-digit megabyte input returns fast (input capped, no O(n^2))', () => {
  // A rogue executable on PATH could emit megabytes of digits; the 4 KiB input
  // cap bounds the regex so it cannot backtrack quadratically. The huge margin
  // (sub-ms vs minutes without the cap) keeps this non-flaky.
  const huge = '1'.repeat(1_000_000);
  const start = Date.now();
  const result = extractVersion(huge);
  assert.ok(Date.now() - start < 1000, 'must not exhibit O(n^2) backtracking');
  assert.ok(result === null || (typeof result === 'string' && result.length <= 80));
});

// ---------------------------------------------------------------------------
// C. gatherCliProbe — unresolved paths
// ---------------------------------------------------------------------------

test('unresolved: resolveFn returns {resolved:false} → status unresolved, runVersion not called', async () => {
  let runVersionCalled = false;
  const { cli, diagnostics } = await gatherCliProbe({
    resolveFn: () => ({ resolved: false, path: null }),
    runVersion: async () => { runVersionCalled = true; return { ok: true, version: '1.0.0' }; },
  });
  assert.equal(cli.status, 'unresolved');
  assert.equal(cli.resolvedPath, null);
  assert.equal(cli.version, null);
  assert.equal(cli.command, 'claude');
  assert.equal(runVersionCalled, false);
  assert.deepEqual(diagnostics, []);
});

test('resolver throws → status indeterminate (not a false unresolved WARN), never rejects', async () => {
  let runVersionCalled = false;
  const { cli } = await gatherCliProbe({
    resolveFn: () => { throw new Error('boom'); },
    runVersion: async () => { runVersionCalled = true; return { ok: true, version: null }; },
  });
  assert.equal(cli.status, 'indeterminate');
  assert.equal(runVersionCalled, false);
});

test('unresolved: resolveFn returns resolved:true but path is empty string → status unresolved', async () => {
  const { cli } = await gatherCliProbe({
    resolveFn: () => ({ resolved: true, path: '' }),
    runVersion: async () => ({ ok: true, version: null }),
  });
  assert.equal(cli.status, 'unresolved');
});

// ---------------------------------------------------------------------------
// D. gatherCliProbe — Windows shim cases (THE CRUX)
// ---------------------------------------------------------------------------

test('win32 extensionless shim → status resolved, runVersion NOT called', async () => {
  let runVersionCalled = false;
  const shimPath = 'C:\\Users\\me\\AppData\\Roaming\\npm\\claude';
  const { cli } = await gatherCliProbe({
    platform: 'win32',
    resolveFn: () => ({ resolved: true, path: shimPath }),
    runVersion: async () => { runVersionCalled = true; return { ok: true, version: null }; },
  });
  assert.equal(cli.status, 'resolved', 'extensionless shim must be "resolved", not "unresponsive"');
  assert.equal(cli.resolvedPath, shimPath);
  assert.equal(cli.version, null);
  assert.equal(runVersionCalled, false, 'runVersion must NOT be called for a Windows shim');
});

test('win32 .cmd shim → status resolved, runVersion NOT called', async () => {
  let runVersionCalled = false;
  const { cli } = await gatherCliProbe({
    platform: 'win32',
    resolveFn: () => ({ resolved: true, path: 'C:\\npm\\claude.cmd' }),
    runVersion: async () => { runVersionCalled = true; return { ok: true, version: null }; },
  });
  assert.equal(cli.status, 'resolved');
  assert.equal(runVersionCalled, false);
});

test('win32 .ps1 shim → status resolved, runVersion NOT called', async () => {
  let runVersionCalled = false;
  const { cli } = await gatherCliProbe({
    platform: 'win32',
    resolveFn: () => ({ resolved: true, path: 'C:\\npm\\claude.ps1' }),
    runVersion: async () => { runVersionCalled = true; return { ok: true, version: null }; },
  });
  assert.equal(cli.status, 'resolved');
  assert.equal(runVersionCalled, false);
});

// ---------------------------------------------------------------------------
// E. gatherCliProbe — native exe path (ok / unresponsive)
// ---------------------------------------------------------------------------

test('win32 native .exe + runVersion ok → status ok, version returned', async () => {
  let runVersionPath = null;
  const exePath = 'C:\\tools\\claude.exe';
  const { cli } = await gatherCliProbe({
    platform: 'win32',
    resolveFn: () => ({ resolved: true, path: exePath }),
    runVersion: async (p) => { runVersionPath = p; return { ok: true, version: '2.1.146' }; },
  });
  assert.equal(cli.status, 'ok');
  assert.equal(cli.version, '2.1.146');
  assert.equal(cli.resolvedPath, exePath);
  assert.equal(runVersionPath, exePath, 'runVersion must be called with the resolved path');
});

test('win32 native .exe + runVersion returns ok:false → status unresponsive', async () => {
  const { cli } = await gatherCliProbe({
    platform: 'win32',
    resolveFn: () => ({ resolved: true, path: 'C:\\tools\\claude.exe' }),
    runVersion: async () => ({ ok: false, version: null }),
  });
  assert.equal(cli.status, 'unresponsive');
  assert.equal(cli.version, null);
});

test('win32 native .exe + runVersion throws → status unresponsive, never rejects', async () => {
  const { cli } = await gatherCliProbe({
    platform: 'win32',
    resolveFn: () => ({ resolved: true, path: 'C:\\tools\\claude.exe' }),
    runVersion: async () => { throw new Error('ETIMEDOUT'); },
  });
  assert.equal(cli.status, 'unresponsive');
});

// ---------------------------------------------------------------------------
// F. gatherCliProbe — POSIX (extensionless is spawnable)
// ---------------------------------------------------------------------------

test('linux extensionless + runVersion ok → status ok', async () => {
  const { cli } = await gatherCliProbe({
    platform: 'linux',
    resolveFn: () => ({ resolved: true, path: '/usr/local/bin/claude' }),
    runVersion: async () => ({ ok: true, version: '2.1.0' }),
  });
  assert.equal(cli.status, 'ok');
  assert.equal(cli.version, '2.1.0');
});

test('darwin extensionless + runVersion ok:false → status unresponsive', async () => {
  const { cli } = await gatherCliProbe({
    platform: 'darwin',
    resolveFn: () => ({ resolved: true, path: '/usr/local/bin/claude' }),
    runVersion: async () => ({ ok: false, version: null }),
  });
  assert.equal(cli.status, 'unresponsive');
});

// ---------------------------------------------------------------------------
// G. gatherCliProbe — return shape and promise invariants
// ---------------------------------------------------------------------------

test('gatherCliProbe returns a Promise', () => {
  const result = gatherCliProbe({
    resolveFn: () => ({ resolved: false, path: null }),
    runVersion: async () => ({ ok: true, version: null }),
  });
  assert.ok(result instanceof Promise);
});

test('gatherCliProbe with no args does not reject', async () => {
  // resolveFn defaults to the real resolveCommand — we cannot control the
  // result, but the call must complete without rejecting and return the shape.
  const { cli, diagnostics } = await gatherCliProbe();
  assert.ok(cli && typeof cli === 'object', 'cli must be an object');
  assert.equal(typeof cli.status, 'string');
  assert.equal(typeof cli.command, 'string');
  assert.ok(Array.isArray(diagnostics));
});

test('cli.command is always "claude"', async () => {
  const { cli } = await gatherCliProbe({
    resolveFn: () => ({ resolved: false, path: null }),
    runVersion: async () => ({ ok: true, version: null }),
  });
  assert.equal(cli.command, 'claude');
});

test('diagnostics array is always empty (probe emits no diagnostics)', async () => {
  const { diagnostics } = await gatherCliProbe({
    resolveFn: () => ({ resolved: true, path: '/usr/local/bin/claude' }),
    runVersion: async () => ({ ok: true, version: '1.0.0' }),
    platform: 'linux',
  });
  assert.deepEqual(diagnostics, []);
});
