/**
 * P3.U6 — snapshot-default-excludes-auth.test.mjs
 *
 * Golden oracle for the `--include-auth` gate of filterSnapshotSecrets.
 *
 * `mcp-needs-auth-cache.json` is NOT produced by the U5 walker (out of snapshot
 * scope), so the filter only captures it on an explicit opt-in:
 *   - includeAuth=false (DEFAULT) → the auth file is NOT in `kept` and NOT in
 *     `dropped` (it was never a candidate; it is simply default-excluded).
 *   - includeAuth=true → the auth file IS in `kept` (it bypasses the secret
 *     filter — a deliberate user choice) and is still never in `dropped`.
 *
 * Uses a real temp dir (mkdtempSync) so existsFn defaults to fs.existsSync and
 * the on-disk presence check is exercised end-to-end. The temp dir is removed
 * in a finally.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { filterSnapshotSecrets } from '../src/ops/snapshot-secrets-filter.mjs';

const AUTH_FILE = 'mcp-needs-auth-cache.json';

/** Make a temp dir with a benign file + the auth-cache file on disk. */
function seedTempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'mgr-auth-'));
  writeFileSync(join(dir, 'settings.json'), '{"benign":true}', 'utf8');
  writeFileSync(join(dir, AUTH_FILE), '{"some-server":{"timestamp":1}}', 'utf8');
  return dir;
}

test('default (includeAuth=false): auth-cache file is NOT captured', () => {
  const dir = seedTempDir();
  try {
    const res = filterSnapshotSecrets({ baseDir: dir, files: ['settings.json'] });
    assert.ok(!res.kept.includes(AUTH_FILE), 'auth file NOT in kept by default');
    assert.ok(!res.dropped.some((d) => d.path === AUTH_FILE), 'auth file NOT in dropped');
    // The benign file is the only thing kept.
    assert.deepStrictEqual(res.kept, ['settings.json'], 'only the benign file kept');
    // No auth-include diagnostic fired.
    assert.ok(
      !res.diagnostics.some((d) => d.code === 'snapshot-auth-included'),
      'no auth-included notice by default',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--include-auth (includeAuth=true): auth-cache file IS captured (bypasses filter)', () => {
  const dir = seedTempDir();
  try {
    const res = filterSnapshotSecrets({
      baseDir: dir, files: ['settings.json'], includeAuth: true,
    });
    assert.ok(res.kept.includes(AUTH_FILE), 'auth file IS in kept on opt-in');
    // It bypasses the secret filter — never dropped, never double-counted.
    assert.ok(!res.dropped.some((d) => d.path === AUTH_FILE), 'auth file NOT in dropped');
    assert.equal(
      res.kept.filter((p) => p === AUTH_FILE).length, 1,
      'auth file appears exactly once (no double-count)',
    );
    // An info notice records the opt-in bypass.
    const notice = res.diagnostics.find((d) => d.code === 'snapshot-auth-included');
    assert.ok(notice, 'auth-included notice emitted');
    assert.equal(notice.severity, 'info', 'notice is info severity');
    assert.equal(notice.path, AUTH_FILE, 'notice carries the auth path');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--include-auth but the file is ABSENT: nothing added, no throw', () => {
  // A temp dir WITHOUT the auth file: opt-in is a no-op (existsFn returns false).
  const dir = mkdtempSync(join(tmpdir(), 'mgr-auth-absent-'));
  try {
    writeFileSync(join(dir, 'settings.json'), '{}', 'utf8');
    const res = filterSnapshotSecrets({
      baseDir: dir, files: ['settings.json'], includeAuth: true,
    });
    assert.ok(!res.kept.includes(AUTH_FILE), 'absent auth file not captured');
    assert.ok(
      !res.diagnostics.some((d) => d.code === 'snapshot-auth-included'),
      'no notice when the file is absent',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--include-auth respects a custom authFileName + injected existsFn', () => {
  // No real I/O: prove the seam is honored and the gate never throws on a
  // hostile existsFn.
  const res = filterSnapshotSecrets({
    baseDir: '/virtual',
    files: [],
    includeAuth: true,
    authFileName: 'custom-auth.json',
    existsFn: (p) => p.endsWith('custom-auth.json'),
  });
  assert.deepStrictEqual(res.kept, ['custom-auth.json'], 'custom auth name captured via injected existsFn');

  const thrown = filterSnapshotSecrets({
    baseDir: '/virtual', files: [], includeAuth: true,
    existsFn: () => { throw new Error('boom'); },
  });
  assert.deepStrictEqual(thrown.kept, [], 'a throwing existsFn degrades to not-captured');
});

test('--include-auth rejects a traversal/nested authFileName (filter cannot be bypassed)', () => {
  // The guard runs BEFORE existsFn. An existsFn that returns true for ANY path
  // means a non-rejected name WOULD be captured — so the guard is the only thing
  // keeping these out of `kept`. This pins fix (b): the auth bypass can target
  // ONLY a single in-directory segment, never a traversal or a nested/host file.
  const alwaysExists = () => true;
  for (const name of ['../x', '../../etc/passwd', '../id_rsa', 'nested/secret.json', 'a\\b']) {
    const res = filterSnapshotSecrets({
      baseDir: '/virtual', files: [], includeAuth: true,
      authFileName: name, existsFn: alwaysExists,
    });
    assert.deepStrictEqual(res.kept, [], `authFileName ${JSON.stringify(name)} must NOT be captured`);
    assert.ok(
      !res.diagnostics.some((d) => d.code === 'snapshot-auth-included'),
      `no auth-included notice for rejected ${JSON.stringify(name)}`,
    );
  }
  // The bare specials are rejected too (no `.`/`..` capture).
  for (const name of ['.', '..']) {
    const res = filterSnapshotSecrets({
      baseDir: '/virtual', files: [], includeAuth: true,
      authFileName: name, existsFn: alwaysExists,
    });
    assert.deepStrictEqual(res.kept, [], `authFileName ${JSON.stringify(name)} must NOT be captured`);
  }
  // Control: a clean single segment that exists IS captured (the gate still works).
  const ok = filterSnapshotSecrets({
    baseDir: '/virtual', files: [], includeAuth: true,
    authFileName: 'id_rsa', existsFn: alwaysExists,
  });
  assert.deepStrictEqual(ok.kept, ['id_rsa'], 'a clean single-segment auth name is still captured');
});
