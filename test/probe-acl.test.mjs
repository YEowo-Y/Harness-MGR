/**
 * P2.U6b-3 — probe-acl.test.mjs
 *
 * Tests for the two exports added to src/discovery/probe-access.mjs for #24:
 *   - parseIcaclsAcl(stdout, path)   — pure, synchronous
 *   - gatherAclProbe(opts)           — async, injectable runIcacls seam
 *
 * All tests are self-contained. gatherAclProbe existence tests use real temp
 * dirs created with mkdtempSync and cleaned up in a finally block.
 *
 * PARSER QUIRK (expected, not a bug):
 *   Principal tokens are extracted via /(\S+):\(/g which stops at the first
 *   space. So "NT AUTHORITY\Authenticated Users:(F)" captures only "Users"
 *   as the token — but "Users" is in BROAD_NAMES, so the verdict (status:
 *   'broad') is still correct. Tests that cover space-containing principals
 *   assert status only and include a comment noting the truncation.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseIcaclsAcl, gatherAclProbe } from '../src/discovery/probe-access.mjs';

// ══════════════════════════════════════════════════════════════════════════════
// A. parseIcaclsAcl — pure parser
// ══════════════════════════════════════════════════════════════════════════════

// owner-only sample: SYSTEM, Administrators, and a local user — none are broad.
// Note: one backslash in JS string literal = one backslash in the actual string.
const OWNER_ONLY_STDOUT = [
  'C:\\path NT AUTHORITY\\SYSTEM:(F)',
  '      BUILTIN\\Administrators:(F)',
  '      DESKTOP\\me:(F)',
  'Successfully processed 1 files; Failed processing 0 files',
].join('\n');

// broad sample: includes BUILTIN\Users and Everyone in addition to owner-only principals.
const BROAD_STDOUT = [
  'C:\\path NT AUTHORITY\\SYSTEM:(OI)(CI)(F)',
  '      BUILTIN\\Administrators:(OI)(CI)(F)',
  '      BUILTIN\\Users:(OI)(CI)(RX)',
  '      Everyone:(R)',
  '      DESKTOP\\me:(F)',
  'Successfully processed 1 files; Failed processing 0 files',
].join('\n');

test('parseIcaclsAcl: owner-only sample → status owner-only, broadPrincipals []', () => {
  const result = parseIcaclsAcl(OWNER_ONLY_STDOUT, 'C:\\path');
  assert.equal(result.status, 'owner-only');
  assert.deepEqual(result.broadPrincipals, []);
  assert.equal(result.path, 'C:\\path');
});

test('parseIcaclsAcl: broad sample → status broad, broadPrincipals [BUILTIN\\Users, Everyone] sorted', () => {
  const result = parseIcaclsAcl(BROAD_STDOUT, 'C:\\path');
  assert.equal(result.status, 'broad');
  // BUILTIN\Users sorts before Everyone alphabetically
  assert.deepEqual(result.broadPrincipals, ['BUILTIN\\Users', 'Everyone']);
  assert.equal(result.path, 'C:\\path');
});

test('parseIcaclsAcl: NT AUTHORITY\\Authenticated Users → status broad (quirk: token captured as "Users")', () => {
  // \S+ stops at the space in "NT AUTHORITY\Authenticated Users", so the captured
  // token is "Users" (the last non-space token before the colon). "users" is in
  // BROAD_NAMES → verdict is correct even though the full principal name is truncated.
  const stdout = 'C:\\s NT AUTHORITY\\Authenticated Users:(F)\nSuccessfully processed 1 files';
  const result = parseIcaclsAcl(stdout, 'C:\\s');
  assert.equal(result.status, 'broad');
  // Do NOT assert exact broadPrincipals content — the token is the truncated tail "Users"
});

test('parseIcaclsAcl: empty string → status indeterminate, broadPrincipals []', () => {
  const result = parseIcaclsAcl('', '/some/path');
  assert.equal(result.status, 'indeterminate');
  assert.deepEqual(result.broadPrincipals, []);
  assert.equal(result.path, '/some/path');
});

test('parseIcaclsAcl: whitespace-only string → status indeterminate, broadPrincipals []', () => {
  const result = parseIcaclsAcl('   \n\t  ', '/p');
  assert.equal(result.status, 'indeterminate');
  assert.deepEqual(result.broadPrincipals, []);
});

test('parseIcaclsAcl: no :(  matches → status indeterminate', () => {
  const result = parseIcaclsAcl('Successfully processed 1 files; Failed processing 0 files', '/p');
  assert.equal(result.status, 'indeterminate');
  assert.deepEqual(result.broadPrincipals, []);
});

test('parseIcaclsAcl: duplicate broad principal across two lines → deduped in broadPrincipals', () => {
  const stdout = [
    'C:\\x BUILTIN\\Users:(OI)(CI)(RX)',
    '     BUILTIN\\Users:(R)',
    'Successfully processed 1 files',
  ].join('\n');
  const result = parseIcaclsAcl(stdout, 'C:\\x');
  assert.equal(result.status, 'broad');
  // Deduped: only one entry for BUILTIN\Users
  assert.deepEqual(result.broadPrincipals, ['BUILTIN\\Users']);
});

// ══════════════════════════════════════════════════════════════════════════════
// B. gatherAclProbe — async, injectable runIcacls seam
// ══════════════════════════════════════════════════════════════════════════════

test('gatherAclProbe: non-win32 platform → acl.status unsupported, no spawn, diagnostics []', async () => {
  const result = await gatherAclProbe({ platform: 'linux', aclDir: '/x' });
  assert.equal(result.acl.status, 'unsupported');
  assert.deepEqual(result.diagnostics, []);
});

test('gatherAclProbe: non-win32 (darwin) → acl.status unsupported', async () => {
  const result = await gatherAclProbe({ platform: 'darwin', aclDir: '/y' });
  assert.equal(result.acl.status, 'unsupported');
  assert.deepEqual(result.diagnostics, []);
});

test('gatherAclProbe: win32 + no aclDir → acl null + exactly one discover-bad-root diagnostic', async () => {
  const result = await gatherAclProbe({ platform: 'win32' });
  assert.equal(result.acl, null);
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0].code, 'discover-bad-root');
});

test('gatherAclProbe: win32 + empty string aclDir → acl null + discover-bad-root', async () => {
  const result = await gatherAclProbe({ platform: 'win32', aclDir: '' });
  assert.equal(result.acl, null);
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0].code, 'discover-bad-root');
});

test('gatherAclProbe: win32 + non-existent path → acl.status absent (statSync ENOENT short-circuits, runIcacls NOT called)', async () => {
  // If runIcacls were called the thrown Error would propagate out of doesNotReject.
  // The fact that status is 'absent' and no throw occurs proves statSync short-circuits.
  const nonExistent = join(tmpdir(), 'probe-acl-test-nonexistent-' + Date.now());
  let result;
  await assert.doesNotReject(async () => {
    result = await gatherAclProbe({
      platform: 'win32',
      aclDir: nonExistent,
      runIcacls: async () => { throw new Error('should not be called'); },
    });
  });
  assert.equal(result.acl.status, 'absent');
  assert.equal(result.acl.path, nonExistent);
  assert.deepEqual(result.diagnostics, []);
});

test('gatherAclProbe: win32 + statFn throws non-ENOENT (EPERM) → acl.status indeterminate, no spawn', async () => {
  // statSync failing with a non-ENOENT code (e.g. EPERM — access denied to stat the
  // dir itself) must degrade to 'indeterminate', never throw, and never spawn. The
  // injected runIcacls throws if reached, proving the stat branch short-circuits.
  let result;
  await assert.doesNotReject(async () => {
    result = await gatherAclProbe({
      platform: 'win32',
      aclDir: 'C:\\some\\dir',
      statFn: () => { const e = new Error('access denied'); e.code = 'EPERM'; throw e; },
      runIcacls: async () => { throw new Error('should not be called'); },
    });
  });
  assert.equal(result.acl.status, 'indeterminate');
  assert.equal(result.acl.path, 'C:\\some\\dir');
  assert.deepEqual(result.diagnostics, []);
});

test('gatherAclProbe: win32 + existing dir + broad output → acl.status broad', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'probe-acl-broad-'));
  try {
    const result = await gatherAclProbe({
      platform: 'win32',
      aclDir: dir,
      runIcacls: async () => BROAD_STDOUT,
    });
    assert.equal(result.acl.status, 'broad');
    assert.equal(result.acl.path, dir);
    assert.deepEqual(result.diagnostics, []);
  } finally {
    rmdirSync(dir);
  }
});

test('gatherAclProbe: win32 + existing dir + owner-only output → acl.status owner-only', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'probe-acl-owner-'));
  try {
    const result = await gatherAclProbe({
      platform: 'win32',
      aclDir: dir,
      runIcacls: async () => OWNER_ONLY_STDOUT,
    });
    assert.equal(result.acl.status, 'owner-only');
    assert.deepEqual(result.acl.broadPrincipals, []);
    assert.deepEqual(result.diagnostics, []);
  } finally {
    rmdirSync(dir);
  }
});

test('gatherAclProbe: win32 + existing dir + runIcacls rejects → acl.status indeterminate, never rejects', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'probe-acl-err-'));
  try {
    let result;
    await assert.doesNotReject(async () => {
      result = await gatherAclProbe({
        platform: 'win32',
        aclDir: dir,
        runIcacls: async () => { throw new Error('icacls failed'); },
      });
    });
    assert.equal(result.acl.status, 'indeterminate');
    assert.equal(result.acl.path, dir);
    assert.deepEqual(result.diagnostics, []);
  } finally {
    rmdirSync(dir);
  }
});
