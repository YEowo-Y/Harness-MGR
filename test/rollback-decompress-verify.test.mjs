/**
 * P3.U16 — rollback-decompress-verify.test.mjs
 *
 * HERMETIC unit tests for verifyRollbackArchive with INJECTED seams (no real tar /
 * fs). mkdtempFn returns a FAKE temp path; extractFn returns { ok:true }; readFileFn
 * maps "<destDir>/<path>" → Buffer (or throws ENOENT); rmFn is a recording seam. We
 * assert:
 *   - verified / hash-mismatch / missing classification against preSha256,
 *   - extract failed → ok:false + the temp cleanup STILL runs (finally),
 *   - tar unavailable → ok:false with no mkdtemp/extract,
 *   - PER-FILE CONTAINMENT: a manifest path that escapes destDir is NEVER read,
 *   - PATH-TRAVERSAL on snapshotId is refused BEFORE readManifest is ever called,
 *   - manifest-not-found / future-version / cross-target → ok:false with no extract,
 *   - the temp cleanup runs even when a seam THROWS (finally),
 *   - never-throws on garbage input.
 *
 * The whole point of this unit is that the ONLY write is a throwaway temp dir and it
 * is always cleaned up; the integration test proves the on-disk no-residue property.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { verifyRollbackArchive } from '../src/ops/rollback-decompress-verify.mjs';

const VALID_ID = '2026-05-31T09-08-07Z';
const STATE_DIR = resolve('/tmp/cmgr-verify-unit/.mgr-state');
const TARGET = resolve('/tmp/cmgr-verify-unit/.claude');
// A FAKE temp dir the mkdtempFn seam returns (never created on disk — readFileFn is
// also a seam, so nothing real is touched).
const FAKE_DEST = resolve('/tmp/cmgr-verify-unit/fake-extract');

/** sha256 hex over bytes (Buffer or string). */
function hashOf(data) {
  return createHash('sha256').update(Buffer.isBuffer(data) ? data : Buffer.from(data)).digest('hex');
}

/** Build a manifest the readManifestFn seam returns. */
function manifestWith(files, overrides = {}) {
  return {
    manifestVersion: 1,
    planVersion: 1,
    snapshotId: VALID_ID,
    targetClaudeDir: TARGET,
    createdAt: '2026-05-31T09:08:07.000Z',
    reason: 'unit',
    files,
    ...overrides,
  };
}

/** A readManifestFn seam returning a fixed manifest, recording its call. */
function manifestSeam(manifest, calls) {
  return (opts) => {
    calls.push(opts);
    return { manifest, diagnostics: [] };
  };
}

/** A resolveFn seam returning a fixed tar path (default: a non-empty path). */
function tarSeam(tarPath = '/usr/bin/tar') {
  return () => ({ tarPath, diagnostics: [] });
}

/** An mkdtempFn seam returning FAKE_DEST and recording the requested prefix. */
function mkdtempSeam(prefixes) {
  return (prefix) => {
    prefixes.push(prefix);
    return FAKE_DEST;
  };
}

/** An extractFn seam returning { ok } and recording its call args. */
function extractSeam(ok, calls) {
  return (args) => {
    calls.push(args);
    return { ok, diagnostics: [] };
  };
}

/**
 * A recording readFileFn seam. `contents` maps an ABSOLUTE path → Buffer|string.
 * A missing key throws ENOENT (missing). `errors` maps a path → an Error to throw.
 * Every call's abs path is pushed into `reads`.
 */
function fileSeam(contents, reads, errors = {}) {
  return (abs) => {
    reads.push(abs);
    if (Object.prototype.hasOwnProperty.call(errors, abs)) throw errors[abs];
    if (Object.prototype.hasOwnProperty.call(contents, abs)) {
      const v = contents[abs];
      return Buffer.isBuffer(v) ? v : Buffer.from(v);
    }
    const err = new Error(`ENOENT: no such file ${abs}`);
    err.code = 'ENOENT';
    throw err;
  };
}

/** A recording rmFn seam capturing every removed dir. */
function rmSeam(removed) {
  return (dir) => { removed.push(dir); };
}

const extractedAbs = (rel) => resolve(join(FAKE_DEST, ...rel.split('/')));

test('verified: every extracted file hashes to preSha256 → ok:true, verified:true, cleanup ran', async () => {
  const bytesA = Buffer.from('alpha\n');
  const bytesB = Buffer.from([0, 1, 2, 255, 254]);
  const manifest = manifestWith([
    { path: 'settings.json', preSha256: hashOf(bytesA), currentSha256: hashOf(bytesA) },
    { path: 'agents/a.md', preSha256: hashOf(bytesB), currentSha256: hashOf(bytesB) },
  ]);
  const calls = [];
  const extractCalls = [];
  const reads = [];
  const removed = [];
  const res = await verifyRollbackArchive({
    mgrStateDir: STATE_DIR, snapshotId: VALID_ID,
    seams: {
      resolveFn: tarSeam(),
      readManifestFn: manifestSeam(manifest, calls),
      mkdtempFn: mkdtempSeam([]),
      extractFn: extractSeam(true, extractCalls),
      readFileFn: fileSeam(
        { [extractedAbs('settings.json')]: bytesA, [extractedAbs('agents/a.md')]: bytesB }, reads),
      rmFn: rmSeam(removed),
    },
  });
  assert.equal(res.ok, true, JSON.stringify(res.diagnostics));
  assert.equal(res.verified, true);
  assert.deepEqual(res.mismatches, []);
  assert.equal(res.snapshotId, VALID_ID);
  assert.equal(res.fileCount, 2);
  assert.equal(res.verifiedCount, 2);
  assert.equal(calls.length, 1);
  assert.equal(extractCalls.length, 1);
  // The extract used the temp dir + the snapshot's files.tar.
  assert.equal(extractCalls[0].destDir, FAKE_DEST);
  assert.ok(extractCalls[0].archivePath.endsWith('files.tar'));
  // CRITICAL: cleanup removed the temp dir.
  assert.deepEqual(removed, [FAKE_DEST]);
  assert.ok(!res.diagnostics.some((d) => d.code === 'rollback-archive-corrupt'));
});

test('hash-mismatch: one file differs → verified:false, a hash-mismatch with the actual hash', async () => {
  const captured = Buffer.from('v1\n');
  const corrupt = Buffer.from('v1-CORRUPTED\n');
  const manifest = manifestWith([
    { path: 'settings.json', preSha256: hashOf(captured), currentSha256: hashOf(captured) },
  ]);
  const removed = [];
  const res = await verifyRollbackArchive({
    mgrStateDir: STATE_DIR, snapshotId: VALID_ID,
    seams: {
      resolveFn: tarSeam(),
      readManifestFn: manifestSeam(manifest, []),
      mkdtempFn: mkdtempSeam([]),
      extractFn: extractSeam(true, []),
      readFileFn: fileSeam({ [extractedAbs('settings.json')]: corrupt }, []),
      rmFn: rmSeam(removed),
    },
  });
  assert.equal(res.ok, true);
  assert.equal(res.verified, false);
  assert.equal(res.fileCount, 1);
  assert.equal(res.verifiedCount, 0);
  assert.deepEqual(res.mismatches, [
    { path: 'settings.json', kind: 'hash-mismatch', expected: hashOf(captured), actual: hashOf(corrupt) },
  ]);
  assert.ok(res.diagnostics.some((d) => d.code === 'rollback-archive-corrupt' && d.severity === 'warn'));
  assert.deepEqual(removed, [FAKE_DEST]);
});

test('missing: readFileFn throws ENOENT → a missing mismatch with actual:null', async () => {
  const captured = Buffer.from('gone\n');
  const manifest = manifestWith([
    { path: 'commands/x.md', preSha256: hashOf(captured), currentSha256: hashOf(captured) },
  ]);
  const removed = [];
  const res = await verifyRollbackArchive({
    mgrStateDir: STATE_DIR, snapshotId: VALID_ID,
    seams: {
      resolveFn: tarSeam(),
      readManifestFn: manifestSeam(manifest, []),
      mkdtempFn: mkdtempSeam([]),
      extractFn: extractSeam(true, []),
      readFileFn: fileSeam({}, []), // no contents → ENOENT
      rmFn: rmSeam(removed),
    },
  });
  assert.equal(res.ok, true);
  assert.equal(res.verified, false);
  assert.deepEqual(res.mismatches, [
    { path: 'commands/x.md', kind: 'missing', expected: hashOf(captured), actual: null },
  ]);
  assert.deepEqual(removed, [FAKE_DEST]);
});

test('unreadable: a non-ENOENT error (EACCES) → a hash-mismatch(actual:null) + verify-file-unreadable warn', async () => {
  const captured = Buffer.from('secret\n');
  const manifest = manifestWith([
    { path: 'hooks/h.mjs', preSha256: hashOf(captured), currentSha256: hashOf(captured) },
  ]);
  const eacces = new Error('EACCES: permission denied');
  eacces.code = 'EACCES';
  const removed = [];
  const res = await verifyRollbackArchive({
    mgrStateDir: STATE_DIR, snapshotId: VALID_ID,
    seams: {
      resolveFn: tarSeam(),
      readManifestFn: manifestSeam(manifest, []),
      mkdtempFn: mkdtempSeam([]),
      extractFn: extractSeam(true, []),
      readFileFn: fileSeam({}, [], { [extractedAbs('hooks/h.mjs')]: eacces }),
      rmFn: rmSeam(removed),
    },
  });
  assert.equal(res.ok, true);
  assert.equal(res.verified, false);
  assert.deepEqual(res.mismatches, [
    { path: 'hooks/h.mjs', kind: 'hash-mismatch', expected: hashOf(captured), actual: null },
  ]);
  assert.ok(res.diagnostics.some((d) => d.code === 'verify-file-unreadable' && d.severity === 'warn'));
  assert.deepEqual(removed, [FAKE_DEST]);
});

test('extract failed: extractFn → { ok:false } → ok:false verify-extract-failed, cleanup STILL ran', async () => {
  const manifest = manifestWith([
    { path: 'settings.json', preSha256: 'a'.repeat(64), currentSha256: 'a'.repeat(64) },
  ]);
  const reads = [];
  const removed = [];
  const res = await verifyRollbackArchive({
    mgrStateDir: STATE_DIR, snapshotId: VALID_ID,
    seams: {
      resolveFn: tarSeam(),
      readManifestFn: manifestSeam(manifest, []),
      mkdtempFn: mkdtempSeam([]),
      extractFn: extractSeam(false, []),
      readFileFn: fileSeam({}, reads),
      rmFn: rmSeam(removed),
    },
  });
  assert.equal(res.ok, false);
  assert.equal(res.verified, false);
  assert.ok(res.diagnostics.some((d) => d.code === 'verify-extract-failed'));
  // No per-file reads happened (extract failed before verification).
  assert.equal(reads.length, 0);
  // CRITICAL: the finally cleanup still removed the temp dir even though extract failed.
  assert.deepEqual(removed, [FAKE_DEST]);
});

test('tar unavailable: resolveFn → { tarPath:null } → ok:false verify-tar-unavailable, no mkdtemp/extract', async () => {
  const manifest = manifestWith([]);
  const prefixes = [];
  const extractCalls = [];
  const removed = [];
  const res = await verifyRollbackArchive({
    mgrStateDir: STATE_DIR, snapshotId: VALID_ID,
    seams: {
      resolveFn: () => ({ tarPath: null, diagnostics: [
        { severity: 'error', code: 'tar-not-found', message: 'no tar', phase: 'snapshot' },
      ] }),
      readManifestFn: manifestSeam(manifest, []),
      mkdtempFn: mkdtempSeam(prefixes),
      extractFn: extractSeam(true, extractCalls),
      readFileFn: fileSeam({}, []),
      rmFn: rmSeam(removed),
    },
  });
  assert.equal(res.ok, false);
  assert.ok(res.diagnostics.some((d) => d.code === 'verify-tar-unavailable'));
  // The resolveTar diagnostic is aggregated too.
  assert.ok(res.diagnostics.some((d) => d.code === 'tar-not-found'));
  // No temp dir was created → nothing to extract → nothing to clean up.
  assert.equal(prefixes.length, 0);
  assert.equal(extractCalls.length, 0);
  assert.equal(removed.length, 0);
});

test('per-file containment: an escaping manifest path is NEVER read + warns + counts as corrupt', async () => {
  const inside = Buffer.from('inside\n');
  const manifest = manifestWith([
    { path: 'settings.json', preSha256: hashOf(inside), currentSha256: hashOf(inside) },
    { path: '../../escape.txt', preSha256: 'x'.repeat(64), currentSha256: 'x'.repeat(64) },
  ]);
  const reads = [];
  const removed = [];
  const res = await verifyRollbackArchive({
    mgrStateDir: STATE_DIR, snapshotId: VALID_ID,
    seams: {
      resolveFn: tarSeam(),
      readManifestFn: manifestSeam(manifest, []),
      mkdtempFn: mkdtempSeam([]),
      extractFn: extractSeam(true, []),
      readFileFn: fileSeam({ [extractedAbs('settings.json')]: inside }, reads),
      rmFn: rmSeam(removed),
    },
  });
  assert.equal(res.ok, true);
  // The escaping entry counts as corrupt (not silently passed); the inside one matches.
  assert.equal(res.verified, false);
  assert.equal(res.mismatches.length, 1);
  assert.deepEqual(res.mismatches[0], {
    path: '../../escape.txt', kind: 'hash-mismatch', expected: 'x'.repeat(64), actual: null,
  });
  assert.ok(res.diagnostics.some((d) => d.code === 'verify-extract-path-escape' && d.severity === 'warn'));
  // CRITICAL: readFileFn was NEVER called with any path outside the temp dir.
  const base = resolve(FAKE_DEST);
  for (const p of reads) {
    assert.ok(p.startsWith(base), `readFileFn must never read outside destDir; read: ${p}`);
  }
  assert.ok(!reads.some((p) => p.includes('escape.txt')), 'escape.txt must never be read');
  assert.deepEqual(removed, [FAKE_DEST]);
});

test('path-traversal / bad snapshotId → ok:false verify-bad-id, readManifestFn NOT called', async () => {
  for (const bad of ['../../etc', 'a/b', '', 'not-an-id', '..\\..\\evil']) {
    let called = false;
    const res = await verifyRollbackArchive({
      mgrStateDir: STATE_DIR, snapshotId: bad,
      seams: {
        resolveFn: () => { throw new Error('should not resolve tar'); },
        readManifestFn: () => { called = true; return { manifest: null, diagnostics: [] }; },
        mkdtempFn: () => { throw new Error('should not mkdtemp'); },
        extractFn: () => { throw new Error('should not extract'); },
        readFileFn: () => { throw new Error('should not read'); },
        rmFn: () => { throw new Error('should not rm'); },
      },
    });
    assert.equal(res.ok, false, `bad id ${JSON.stringify(bad)} should fail`);
    assert.ok(res.diagnostics.some((d) => d.code === 'verify-bad-id'),
      `bad id ${JSON.stringify(bad)} → verify-bad-id, got ${JSON.stringify(res.diagnostics)}`);
    assert.equal(called, false, 'readManifestFn must not be called for a bad id');
  }
});

test('bad args: missing/empty mgrStateDir → ok:false verify-bad-args', async () => {
  for (const bad of [undefined, '', 123, null]) {
    const res = await verifyRollbackArchive({ mgrStateDir: bad, snapshotId: VALID_ID });
    assert.equal(res.ok, false);
    assert.ok(res.diagnostics.some((d) => d.code === 'verify-bad-args'));
  }
});

test('manifest not found → ok:false, surfaces the read diagnostic, no extract', async () => {
  const extractCalls = [];
  const prefixes = [];
  const res = await verifyRollbackArchive({
    mgrStateDir: STATE_DIR, snapshotId: VALID_ID,
    seams: {
      resolveFn: tarSeam(),
      readManifestFn: () => ({ manifest: null, diagnostics: [
        { severity: 'error', code: 'manifest-not-found', message: 'gone', phase: 'snapshot' },
      ] }),
      mkdtempFn: mkdtempSeam(prefixes),
      extractFn: extractSeam(true, extractCalls),
      readFileFn: fileSeam({}, []),
      rmFn: rmSeam([]),
    },
  });
  assert.equal(res.ok, false);
  assert.equal(res.verified, false);
  assert.equal(res.snapshotId, VALID_ID);
  assert.ok(res.diagnostics.some((d) => d.code === 'manifest-not-found'));
  assert.equal(extractCalls.length, 0, 'no extract when the manifest is missing');
  assert.equal(prefixes.length, 0, 'no temp dir when the manifest is missing');
});

test('future version → ok:false (verifyManifest refuses), no extract', async () => {
  const manifest = manifestWith([], { manifestVersion: 999 });
  const extractCalls = [];
  const res = await verifyRollbackArchive({
    mgrStateDir: STATE_DIR, snapshotId: VALID_ID,
    seams: {
      resolveFn: tarSeam(),
      readManifestFn: manifestSeam(manifest, []),
      mkdtempFn: mkdtempSeam([]),
      extractFn: extractSeam(true, extractCalls),
      readFileFn: fileSeam({}, []),
      rmFn: rmSeam([]),
    },
  });
  assert.equal(res.ok, false);
  assert.ok(res.diagnostics.some((d) => d.code === 'manifest-version-unsupported'));
  assert.equal(extractCalls.length, 0);
});

test('cross-target → ok:false (verifyManifest refuses), no extract', async () => {
  const manifest = manifestWith([]);
  const extractCalls = [];
  const res = await verifyRollbackArchive({
    mgrStateDir: STATE_DIR, snapshotId: VALID_ID, expectedTarget: resolve('/some/other/.claude'),
    seams: {
      resolveFn: tarSeam(),
      readManifestFn: manifestSeam(manifest, []),
      mkdtempFn: mkdtempSeam([]),
      extractFn: extractSeam(true, extractCalls),
      readFileFn: fileSeam({}, []),
      rmFn: rmSeam([]),
    },
  });
  assert.equal(res.ok, false);
  assert.ok(res.diagnostics.some((d) => d.code === 'manifest-target-mismatch'));
  assert.equal(extractCalls.length, 0);
});

test('cleanup on throw: a throwing extractFn → ok:false + diagnostic (no throw) AND rmFn still ran', async () => {
  const manifest = manifestWith([
    { path: 'settings.json', preSha256: 'a'.repeat(64), currentSha256: 'a'.repeat(64) },
  ]);
  const removed = [];
  const res = await verifyRollbackArchive({
    mgrStateDir: STATE_DIR, snapshotId: VALID_ID,
    seams: {
      resolveFn: tarSeam(),
      readManifestFn: manifestSeam(manifest, []),
      mkdtempFn: mkdtempSeam([]),
      extractFn: () => { throw new Error('extract seam blew up'); },
      readFileFn: fileSeam({}, []),
      rmFn: rmSeam(removed),
    },
  });
  assert.equal(res.ok, false);
  assert.ok(res.diagnostics.some((d) => d.code === 'verify-unexpected-error'));
  // CRITICAL: the temp dir was created before the throw, so the finally cleaned it up.
  assert.deepEqual(removed, [FAKE_DEST]);
});

test('cleanup failure degrades to a no-throw (a throwing rmFn does not propagate)', async () => {
  const bytes = Buffer.from('ok\n');
  const manifest = manifestWith([
    { path: 'settings.json', preSha256: hashOf(bytes), currentSha256: hashOf(bytes) },
  ]);
  // rmFn throws — verifyRollbackArchive must NOT throw; the verified result still stands.
  const res = await verifyRollbackArchive({
    mgrStateDir: STATE_DIR, snapshotId: VALID_ID,
    seams: {
      resolveFn: tarSeam(),
      readManifestFn: manifestSeam(manifest, []),
      mkdtempFn: mkdtempSeam([]),
      extractFn: extractSeam(true, []),
      readFileFn: fileSeam({ [extractedAbs('settings.json')]: bytes }, []),
      rmFn: () => { throw new Error('rm failed'); },
    },
  });
  // The result was already built before the finally, so it still reports verified:true.
  assert.equal(res.ok, true);
  assert.equal(res.verified, true);
});

test('never-throws: garbage input verifyRollbackArchive(undefined) / ({}) → ok:false, no throw', async () => {
  const r1 = await verifyRollbackArchive(undefined);
  assert.equal(r1.ok, false);
  assert.ok(Array.isArray(r1.diagnostics) && r1.diagnostics.length > 0);
  const r2 = await verifyRollbackArchive({});
  assert.equal(r2.ok, false);
  assert.ok(r2.diagnostics.some((d) => d.code === 'verify-bad-args'));
});

test('result shape: always the full VerifyResult contract', async () => {
  const res = await verifyRollbackArchive({});
  for (const k of ['ok', 'verified', 'snapshotId', 'fileCount', 'verifiedCount', 'mismatches', 'diagnostics']) {
    assert.ok(Object.prototype.hasOwnProperty.call(res, k), `missing field ${k}`);
  }
  assert.equal(typeof res.ok, 'boolean');
  assert.equal(typeof res.verified, 'boolean');
  assert.equal(typeof res.fileCount, 'number');
  assert.equal(typeof res.verifiedCount, 'number');
  assert.ok(Array.isArray(res.mismatches));
  assert.ok(Array.isArray(res.diagnostics));
});
