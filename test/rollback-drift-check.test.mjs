/**
 * P3.U15 — rollback-drift-check.test.mjs
 *
 * HERMETIC unit tests for checkRollbackDrift with INJECTED seams (no real fs).
 * readManifestFn returns a fixed manifest; readFileFn is a recording seam mapping
 * an absolute path → Buffer (or throwing an ENOENT/EACCES error). We assert:
 *   - clean / modified / deleted / unreadable drift classification,
 *   - PER-FILE CONTAINMENT: a manifest path that escapes the target is NEVER read,
 *   - manifest-not-found / future-version / cross-target → ok:false with no reads,
 *   - PATH-TRAVERSAL on snapshotId is refused BEFORE readManifest is ever called,
 *   - never-throws on a throwing seam and on garbage input.
 *
 * The whole point of this unit is that it WRITES NOTHING — there is no write seam
 * to inject because there is no write path; the integration test proves the on-disk
 * no-write property.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { checkRollbackDrift } from '../src/ops/rollback-drift-check.mjs';

const VALID_ID = '2026-05-30T12-34-56Z';
const STATE_DIR = resolve('/tmp/cmgr-drift-unit/.mgr-state');
const TARGET = resolve('/tmp/cmgr-drift-unit/.claude');

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
    createdAt: '2026-05-30T12:34:56.000Z',
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

/**
 * A recording readFileFn seam. `contents` maps an ABSOLUTE path → Buffer|string.
 * A missing key throws ENOENT (deleted). `errors` maps a path → an Error to throw.
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

const absFor = (rel) => resolve(join(TARGET, ...rel.split('/')));

test('clean: every file hashes to its currentSha256 → ok:true, clean:true, no changes', () => {
  const bytesA = Buffer.from('alpha\n');
  const bytesB = Buffer.from([0, 1, 2, 255, 254]);
  const manifest = manifestWith([
    { path: 'settings.json', preSha256: hashOf(bytesA), currentSha256: hashOf(bytesA) },
    { path: 'agents/a.md', preSha256: hashOf(bytesB), currentSha256: hashOf(bytesB) },
  ]);
  const calls = [];
  const reads = [];
  const res = checkRollbackDrift({
    mgrStateDir: STATE_DIR, snapshotId: VALID_ID,
    seams: {
      readManifestFn: manifestSeam(manifest, calls),
      readFileFn: fileSeam({ [absFor('settings.json')]: bytesA, [absFor('agents/a.md')]: bytesB }, reads),
    },
  });
  assert.equal(res.ok, true, JSON.stringify(res.diagnostics));
  assert.equal(res.clean, true);
  assert.deepEqual(res.changes, []);
  assert.equal(res.snapshotId, VALID_ID);
  assert.equal(res.targetClaudeDir, TARGET);
  assert.equal(calls.length, 1);
  assert.ok(!res.diagnostics.some((d) => d.code === 'rollback-drift-detected'));
});

test('modified: one file differs → ok:true, clean:false, a modified change with the new hash', () => {
  const old = Buffer.from('v1\n');
  const live = Buffer.from('v2-edited\n');
  const manifest = manifestWith([
    { path: 'settings.json', preSha256: hashOf(old), currentSha256: hashOf(old) },
  ]);
  const reads = [];
  const res = checkRollbackDrift({
    mgrStateDir: STATE_DIR, snapshotId: VALID_ID,
    seams: {
      readManifestFn: manifestSeam(manifest, []),
      readFileFn: fileSeam({ [absFor('settings.json')]: live }, reads),
    },
  });
  assert.equal(res.ok, true);
  assert.equal(res.clean, false);
  assert.equal(res.changes.length, 1);
  assert.deepEqual(res.changes[0], {
    path: 'settings.json', kind: 'modified', expected: hashOf(old), actual: hashOf(live),
  });
  assert.ok(res.diagnostics.some((d) => d.code === 'rollback-drift-detected' && d.severity === 'warn'));
});

test('deleted: readFileFn throws ENOENT → a deleted change with actual:null', () => {
  const old = Buffer.from('gone\n');
  const manifest = manifestWith([
    { path: 'commands/x.md', preSha256: hashOf(old), currentSha256: hashOf(old) },
  ]);
  const reads = [];
  const res = checkRollbackDrift({
    mgrStateDir: STATE_DIR, snapshotId: VALID_ID,
    seams: {
      readManifestFn: manifestSeam(manifest, []),
      readFileFn: fileSeam({}, reads), // no contents → ENOENT
    },
  });
  assert.equal(res.ok, true);
  assert.equal(res.clean, false);
  assert.deepEqual(res.changes, [
    { path: 'commands/x.md', kind: 'deleted', expected: hashOf(old), actual: null },
  ]);
});

test('unreadable: a non-ENOENT error (EACCES) → a modified(actual:null) change + drift-file-unreadable warn', () => {
  const old = Buffer.from('secret\n');
  const manifest = manifestWith([
    { path: 'hooks/h.mjs', preSha256: hashOf(old), currentSha256: hashOf(old) },
  ]);
  const eacces = new Error('EACCES: permission denied');
  eacces.code = 'EACCES';
  const reads = [];
  const res = checkRollbackDrift({
    mgrStateDir: STATE_DIR, snapshotId: VALID_ID,
    seams: {
      readManifestFn: manifestSeam(manifest, []),
      readFileFn: fileSeam({}, reads, { [absFor('hooks/h.mjs')]: eacces }),
    },
  });
  assert.equal(res.ok, true);
  assert.equal(res.clean, false);
  assert.deepEqual(res.changes, [
    { path: 'hooks/h.mjs', kind: 'modified', expected: hashOf(old), actual: null },
  ]);
  assert.ok(res.diagnostics.some((d) => d.code === 'drift-file-unreadable' && d.severity === 'warn'));
});

test('per-file containment: an escaping manifest path is NEVER read + warns', () => {
  const ok = Buffer.from('inside\n');
  const manifest = manifestWith([
    { path: 'settings.json', preSha256: hashOf(ok), currentSha256: hashOf(ok) },
    { path: '../../escape.txt', preSha256: 'x'.repeat(64), currentSha256: 'x'.repeat(64) },
  ]);
  const reads = [];
  const res = checkRollbackDrift({
    mgrStateDir: STATE_DIR, snapshotId: VALID_ID,
    seams: {
      readManifestFn: manifestSeam(manifest, []),
      readFileFn: fileSeam({ [absFor('settings.json')]: ok }, reads),
    },
  });
  assert.equal(res.ok, true);
  // The escaping entry is skipped (not a change), the contained one is clean.
  assert.equal(res.clean, true);
  assert.deepEqual(res.changes, []);
  assert.ok(res.diagnostics.some((d) => d.code === 'drift-manifest-path-escape' && d.severity === 'warn'));
  // CRITICAL: readFileFn was NEVER called with any path outside the target root.
  const base = resolve(TARGET);
  for (const p of reads) {
    assert.ok(p.startsWith(base), `readFileFn must never read outside target; read: ${p}`);
  }
  // And specifically the escape path was never read.
  assert.ok(!reads.some((p) => p.includes('escape.txt')), 'escape.txt must never be read');
});

test('manifest not found → ok:false, surfaces the read diagnostic, no file reads', () => {
  const reads = [];
  const res = checkRollbackDrift({
    mgrStateDir: STATE_DIR, snapshotId: VALID_ID,
    seams: {
      readManifestFn: () => ({ manifest: null, diagnostics: [
        { severity: 'error', code: 'manifest-not-found', message: 'gone', phase: 'snapshot' },
      ] }),
      readFileFn: fileSeam({}, reads),
    },
  });
  assert.equal(res.ok, false);
  assert.equal(res.clean, false);
  assert.equal(res.snapshotId, VALID_ID);
  assert.ok(res.diagnostics.some((d) => d.code === 'manifest-not-found'));
  assert.equal(reads.length, 0, 'no files should be read when the manifest is missing');
});

test('future version → ok:false (verifyManifest refuses), no file reads', () => {
  const manifest = manifestWith([], { manifestVersion: 999 });
  const reads = [];
  const res = checkRollbackDrift({
    mgrStateDir: STATE_DIR, snapshotId: VALID_ID,
    seams: { readManifestFn: manifestSeam(manifest, []), readFileFn: fileSeam({}, reads) },
  });
  assert.equal(res.ok, false);
  assert.ok(res.diagnostics.some((d) => d.code === 'manifest-version-unsupported'));
  assert.equal(reads.length, 0);
});

test('cross-target → ok:false (verifyManifest refuses), no file reads', () => {
  const manifest = manifestWith([]);
  const reads = [];
  const res = checkRollbackDrift({
    mgrStateDir: STATE_DIR, snapshotId: VALID_ID, expectedTarget: resolve('/some/other/.claude'),
    seams: { readManifestFn: manifestSeam(manifest, []), readFileFn: fileSeam({}, reads) },
  });
  assert.equal(res.ok, false);
  assert.ok(res.diagnostics.some((d) => d.code === 'manifest-target-mismatch'));
  assert.equal(reads.length, 0);
});

test('path-traversal / bad snapshotId → ok:false drift-bad-id, readManifestFn NOT called', () => {
  for (const bad of ['../../etc', 'a/b', '', 'not-an-id', '..\\..\\evil']) {
    let called = false;
    const res = checkRollbackDrift({
      mgrStateDir: STATE_DIR, snapshotId: bad,
      seams: {
        readManifestFn: () => { called = true; return { manifest: null, diagnostics: [] }; },
        readFileFn: () => { throw new Error('should not read'); },
      },
    });
    assert.equal(res.ok, false, `bad id ${JSON.stringify(bad)} should fail`);
    assert.ok(res.diagnostics.some((d) => d.code === 'drift-bad-id'),
      `bad id ${JSON.stringify(bad)} → drift-bad-id, got ${JSON.stringify(res.diagnostics)}`);
    assert.equal(called, false, 'readManifestFn must not be called for a bad id');
  }
});

test('bad args: missing/empty mgrStateDir → ok:false drift-bad-args', () => {
  for (const bad of [undefined, '', 123, null]) {
    const res = checkRollbackDrift({ mgrStateDir: bad, snapshotId: VALID_ID });
    assert.equal(res.ok, false);
    assert.ok(res.diagnostics.some((d) => d.code === 'drift-bad-args'));
  }
});

test('never-throws: a throwing readFileFn (non-ENOENT throw) is contained', () => {
  const old = Buffer.from('x\n');
  const manifest = manifestWith([
    { path: 'settings.json', preSha256: hashOf(old), currentSha256: hashOf(old) },
  ]);
  const res = checkRollbackDrift({
    mgrStateDir: STATE_DIR, snapshotId: VALID_ID,
    seams: {
      readManifestFn: manifestSeam(manifest, []),
      readFileFn: () => { throw new Error('disk on fire'); }, // a plain Error, no .code
    },
  });
  // A plain throw (no ENOENT) is treated as a conservative 'modified' + warn.
  assert.equal(res.ok, true);
  assert.equal(res.clean, false);
  assert.deepEqual(res.changes, [
    { path: 'settings.json', kind: 'modified', expected: hashOf(old), actual: null },
  ]);
  assert.ok(res.diagnostics.some((d) => d.code === 'drift-file-unreadable'));
});

test('never-throws: a throwing readManifestFn is contained → ok:false drift-unexpected-error', () => {
  const res = checkRollbackDrift({
    mgrStateDir: STATE_DIR, snapshotId: VALID_ID,
    seams: { readManifestFn: () => { throw new Error('seam blew up'); } },
  });
  assert.equal(res.ok, false);
  assert.ok(res.diagnostics.some((d) => d.code === 'drift-unexpected-error'));
});

test('never-throws: garbage input checkRollbackDrift(undefined) / ({}) → ok:false, no throw', () => {
  const r1 = checkRollbackDrift(undefined);
  assert.equal(r1.ok, false);
  assert.ok(Array.isArray(r1.diagnostics) && r1.diagnostics.length > 0);
  const r2 = checkRollbackDrift({});
  assert.equal(r2.ok, false);
  assert.ok(r2.diagnostics.some((d) => d.code === 'drift-bad-args'));
});

test('result shape: always the full DriftResult contract', () => {
  const res = checkRollbackDrift({});
  for (const k of ['ok', 'clean', 'snapshotId', 'targetClaudeDir', 'changes', 'diagnostics']) {
    assert.ok(Object.prototype.hasOwnProperty.call(res, k), `missing field ${k}`);
  }
  assert.equal(typeof res.ok, 'boolean');
  assert.equal(typeof res.clean, 'boolean');
  assert.ok(Array.isArray(res.changes));
  assert.ok(Array.isArray(res.diagnostics));
});
