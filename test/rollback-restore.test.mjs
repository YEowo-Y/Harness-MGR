/**
 * P3.U17 — rollback-restore.test.mjs
 *
 * HERMETIC unit tests for restoreSnapshot with INJECTED seams (no real tar / fs).
 * mkdtempFn returns a FAKE temp path; extractFn returns { ok:true }; readFileFn maps
 * "<destDir>/<path>" → Buffer; atomicWriteFn is a recording/configurable seam; rmFn /
 * mkdirFn are recording seams. Every oracle is FALSIFIABLE (asserts specific values,
 * never just "no throw"). We assert:
 *   - happy path: writable files restored, atomicWriteFn called with context:'rollback'
 *     and Buffer content,
 *   - gate-denied skip (the headline): denied files land in skipped(out-of-surface),
 *     are NEVER passed to atomicWriteFn, writable ones ARE restored, restored stays
 *     true, the partial-surface INFO is present,
 *   - preSha256 mismatch → skipped(verify-mismatch), not written, restored:false, ERROR,
 *   - bad id / bad args / path-escape → ok:false, ZERO writes,
 *   - manifest-not-found / future-version / tar-unavailable / extract-failed → ok:false,
 *     no writes,
 *   - hard write failure → loop STOPS, restored:false, leftovers surfaced, ERROR,
 *   - temp cleanup runs on extract-fail AND on success,
 *   - never-throws on a thrown extractFn / readFileFn.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { restoreSnapshot } from '../src/ops/rollback-restore.mjs';

const VALID_ID = '2026-05-31T09-08-07Z';
const STATE_DIR = resolve('/tmp/cmgr-restore-unit/.mgr-state');
const TARGET = resolve('/tmp/cmgr-restore-unit/.claude');
// A FAKE temp dir the mkdtempFn seam returns (never created on disk — readFileFn is
// also a seam, so nothing real is touched).
const FAKE_DEST = resolve('/tmp/cmgr-restore-unit/fake-extract');
const PASS = (p) => p; // a passthrough gate that allows everything

/** sha256 hex over bytes (Buffer or string). */
function hashOf(data) {
  return createHash('sha256').update(Buffer.isBuffer(data) ? data : Buffer.from(data)).digest('hex');
}

/**
 * Build a manifest the readManifestFn seam returns. A real manifest FileRecord is
 * { path, preSha256, currentSha256 } (verifyManifest requires all three non-empty);
 * at capture time pre === current. Tests pass { path, preSha256 } and we fill in
 * currentSha256 := preSha256 here so the records pass verifyManifest. Restore itself
 * only re-verifies against preSha256 (the archived bytes).
 */
function manifestWith(files, overrides = {}) {
  const full = files.map((f) => ({ currentSha256: f.preSha256, ...f }));
  return {
    manifestVersion: 1, planVersion: 1, snapshotId: VALID_ID, targetClaudeDir: TARGET,
    createdAt: '2026-05-31T09:08:07.000Z', reason: 'unit', files: full, ...overrides,
  };
}

/** A readManifestFn seam returning a fixed manifest, recording its call. */
function manifestSeam(manifest, calls) {
  return (opts) => { calls.push(opts); return { manifest, diagnostics: [] }; };
}

/** A resolveFn seam returning a fixed tar path (default: a non-empty path). */
function tarSeam(tarPath = '/usr/bin/tar') {
  return () => ({ tarPath, diagnostics: [] });
}

/** An mkdtempFn seam returning FAKE_DEST and recording the requested prefix. */
function mkdtempSeam(prefixes) {
  return (prefix) => { prefixes.push(prefix); return FAKE_DEST; };
}

/** An extractFn seam returning { ok } and recording its call args. */
function extractSeam(ok, calls) {
  return (args) => { calls.push(args); return { ok, diagnostics: [] }; };
}

/**
 * A recording readFileFn seam. `contents` maps an ABSOLUTE path → Buffer|string.
 * A missing key throws ENOENT. Every call's abs path is pushed into `reads`.
 */
function fileSeam(contents, reads) {
  return (abs) => {
    reads.push(abs);
    if (!Object.prototype.hasOwnProperty.call(contents, abs)) {
      const e = new Error(`ENOENT: ${abs}`); e.code = 'ENOENT'; throw e;
    }
    const v = contents[abs];
    return Buffer.isBuffer(v) ? v : Buffer.from(v);
  };
}

/**
 * A recording atomicWriteFn seam. By default every write succeeds. `failOn` (a Set of
 * absolute target paths) makes those writes fail with the given leftovers. Every call's
 * { target, content, context } is recorded.
 */
function writeSeam(calls, { failOn = new Set(), leftovers = null } = {}) {
  return async (args) => {
    calls.push({ target: args.target, content: args.content, context: args.context });
    if (failOn.has(args.target)) {
      return { ok: false, wrote: false, leftovers, diagnostics: [{ severity: 'error', code: 'apply-write-staging-failed', message: 'simulated' }] };
    }
    return { ok: true, wrote: true, leftovers: { newPath: null, oldPath: null }, diagnostics: [] };
  };
}

/** The full default seam bundle for a "given a manifest, run the restore" call. */
function baseSeams(manifest, { writeCalls = [], readContents = {}, extractOk = true } = {}) {
  return {
    seams: {
      resolveFn: tarSeam(),
      extractFn: extractSeam(extractOk, []),
      readManifestFn: manifestSeam(manifest, []),
      mkdtempFn: mkdtempSeam([]),
      readFileFn: fileSeam(readContents, []),
      rmFn: () => {},
      mkdirFn: () => {},
      atomicWriteFn: writeSeam(writeCalls),
    },
  };
}

// ── happy path ────────────────────────────────────────────────────────────────────

test('happy path: 2 writable files restored with rollback context + Buffer content', async () => {
  const files = [
    { path: 'CLAUDE.md', preSha256: hashOf('claude-bytes') },
    { path: 'agents/a.md', preSha256: hashOf('agent-bytes') },
  ];
  const manifest = manifestWith(files);
  const writeCalls = [];
  const readContents = {
    [resolve(FAKE_DEST, 'CLAUDE.md')]: 'claude-bytes',
    [resolve(FAKE_DEST, 'agents/a.md')]: 'agent-bytes',
  };
  const r = await restoreSnapshot({
    mgrStateDir: STATE_DIR, snapshotId: VALID_ID, targetClaudeDir: TARGET, assertWritable: PASS,
    ...baseSeams(manifest, { writeCalls, readContents }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.restored, true);
  assert.equal(r.restoredCount, 2);
  assert.deepEqual(r.skipped, []);
  assert.equal(r.leftovers, null);
  assert.equal(r.fileCount, 2);
  // Both writes used context:'rollback' and a Buffer payload.
  assert.equal(writeCalls.length, 2);
  for (const c of writeCalls) {
    assert.equal(c.context, 'rollback');
    assert.equal(Buffer.isBuffer(c.content), true);
  }
  // The targets are the contained live paths.
  assert.equal(writeCalls[0].target, resolve(TARGET, 'CLAUDE.md'));
  assert.equal(writeCalls[1].target, resolve(TARGET, 'agents/a.md'));
});

// ── gate-denied skip (THE HEADLINE) ─────────────────────────────────────────────────

test('gate-denied files are skipped(out-of-surface), never written; writable ones restored', async () => {
  const files = [
    { path: 'CLAUDE.md', preSha256: hashOf('ok1') },
    { path: 'hud/omc-hud.mjs', preSha256: hashOf('hud') },
    { path: 'plugins/installed_plugins.json', preSha256: hashOf('plug') },
    { path: 'settings.json', preSha256: hashOf('ok2') },
  ];
  const manifest = manifestWith(files);
  const writeCalls = [];
  const readContents = {
    [resolve(FAKE_DEST, 'CLAUDE.md')]: 'ok1',
    [resolve(FAKE_DEST, 'hud/omc-hud.mjs')]: 'hud',
    [resolve(FAKE_DEST, 'plugins/installed_plugins.json')]: 'plug',
    [resolve(FAKE_DEST, 'settings.json')]: 'ok2',
  };
  // A gate that DENIES the two non-rollback-writable surfaces as genuine WriteForbiddenErrors.
  const denied = new Set([resolve(TARGET, 'hud/omc-hud.mjs'), resolve(TARGET, 'plugins/installed_plugins.json')]);
  const gate = (p) => {
    if (denied.has(p)) throw Object.assign(new Error('rollback-only'), { name: 'WriteForbiddenError', code: 'write-rollback-only' });
    return p;
  };

  const r = await restoreSnapshot({
    mgrStateDir: STATE_DIR, snapshotId: VALID_ID, targetClaudeDir: TARGET, assertWritable: gate,
    ...baseSeams(manifest, { writeCalls, readContents }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.restored, true); // skips do NOT fail the restore
  assert.equal(r.restoredCount, 2);
  assert.deepEqual(r.skipped.sort((a, b) => a.path < b.path ? -1 : 1), [
    { path: 'hud/omc-hud.mjs', reason: 'out-of-surface' },
    { path: 'plugins/installed_plugins.json', reason: 'out-of-surface' },
  ]);
  // The denied paths were NEVER written.
  const writtenTargets = writeCalls.map((c) => c.target);
  assert.equal(writtenTargets.includes(resolve(TARGET, 'hud/omc-hud.mjs')), false);
  assert.equal(writtenTargets.includes(resolve(TARGET, 'plugins/installed_plugins.json')), false);
  assert.equal(writtenTargets.includes(resolve(TARGET, 'CLAUDE.md')), true);
  assert.equal(writtenTargets.includes(resolve(TARGET, 'settings.json')), true);
  // The partial-surface INFO is present.
  assert.equal(r.diagnostics.some((d) => d.code === 'rollback-restore-partial-surface'), true);
  assert.equal(r.diagnostics.some((d) => d.code === 'rollback-restore-skipped-out-of-surface'), true);
});

// ── preSha256 mismatch ──────────────────────────────────────────────────────────────

test('preSha256 mismatch: file skipped(verify-mismatch), NOT written, restored:false, ERROR', async () => {
  const files = [
    { path: 'CLAUDE.md', preSha256: hashOf('the-captured-bytes') },
  ];
  const manifest = manifestWith(files);
  const writeCalls = [];
  // The extracted bytes DIFFER from the captured hash → corruption.
  const readContents = { [resolve(FAKE_DEST, 'CLAUDE.md')]: 'TAMPERED-DIFFERENT-BYTES' };
  const r = await restoreSnapshot({
    mgrStateDir: STATE_DIR, snapshotId: VALID_ID, targetClaudeDir: TARGET, assertWritable: PASS,
    ...baseSeams(manifest, { writeCalls, readContents }),
  });
  assert.equal(r.ok, true); // the run completed
  assert.equal(r.restored, false); // but a mismatch is a real failure
  assert.equal(r.restoredCount, 0);
  assert.deepEqual(r.skipped, [{ path: 'CLAUDE.md', reason: 'verify-mismatch' }]);
  assert.equal(writeCalls.length, 0); // never wrote garbage
  assert.equal(r.diagnostics.some((d) => d.code === 'rollback-restore-verify-mismatch' && d.severity === 'error'), true);
});

// ── refusal paths (ZERO writes) ─────────────────────────────────────────────────────

test('bad id: ok:false, rollback-restore-bad-id, ZERO writes, readManifest NEVER called', async () => {
  const writeCalls = [];
  const manifestCalls = [];
  const r = await restoreSnapshot({
    mgrStateDir: STATE_DIR, snapshotId: '../../etc', targetClaudeDir: TARGET, assertWritable: PASS,
    seams: { readManifestFn: manifestSeam(manifestWith([]), manifestCalls), atomicWriteFn: writeSeam(writeCalls) },
  });
  assert.equal(r.ok, false);
  assert.equal(r.diagnostics.some((d) => d.code === 'rollback-restore-bad-id'), true);
  assert.equal(writeCalls.length, 0);
  assert.equal(manifestCalls.length, 0); // refused before any fs access
});

test('missing assertWritable: ok:false, rollback-restore-bad-args, ZERO writes', async () => {
  const writeCalls = [];
  const manifestCalls = [];
  const r = await restoreSnapshot({
    mgrStateDir: STATE_DIR, snapshotId: VALID_ID, targetClaudeDir: TARGET, // no assertWritable
    seams: { readManifestFn: manifestSeam(manifestWith([]), manifestCalls), atomicWriteFn: writeSeam(writeCalls) },
  });
  assert.equal(r.ok, false);
  assert.equal(r.diagnostics.some((d) => d.code === 'rollback-restore-bad-args'), true);
  assert.equal(writeCalls.length, 0);
  assert.equal(manifestCalls.length, 0);
});

test('empty mgrStateDir / empty targetClaudeDir: ok:false, rollback-restore-bad-args, ZERO writes', async () => {
  const writeCalls = [];
  for (const bad of [{ mgrStateDir: '', targetClaudeDir: TARGET }, { mgrStateDir: STATE_DIR, targetClaudeDir: '' }]) {
    const r = await restoreSnapshot({
      snapshotId: VALID_ID, assertWritable: PASS, ...bad,
      seams: { atomicWriteFn: writeSeam(writeCalls) },
    });
    assert.equal(r.ok, false);
    assert.equal(r.diagnostics.some((d) => d.code === 'rollback-restore-bad-args'), true);
  }
  assert.equal(writeCalls.length, 0);
});

test('restoreSnapshot(undefined): ok:false, full-shape result, does not throw', async () => {
  const r = await restoreSnapshot(undefined);
  assert.equal(r.ok, false);
  assert.equal(r.restored, false);
  assert.deepEqual(r.skipped, []);
  assert.equal(r.leftovers, null);
  assert.equal(r.fileCount, 0);
  assert.equal(r.restoredCount, 0);
  assert.equal(r.diagnostics.some((d) => d.code === 'rollback-restore-bad-args'), true);
});

test('manifest-not-found: ok:false, no writes (read diag surfaced by the seam)', async () => {
  const writeCalls = [];
  const r = await restoreSnapshot({
    mgrStateDir: STATE_DIR, snapshotId: VALID_ID, targetClaudeDir: TARGET, assertWritable: PASS,
    seams: {
      readManifestFn: () => ({ manifest: null, diagnostics: [{ severity: 'error', code: 'manifest-not-found', message: 'gone' }] }),
      atomicWriteFn: writeSeam(writeCalls),
    },
  });
  assert.equal(r.ok, false);
  assert.equal(r.snapshotId, VALID_ID);
  assert.equal(r.targetClaudeDir, TARGET);
  assert.equal(r.diagnostics.some((d) => d.code === 'manifest-not-found'), true);
  assert.equal(writeCalls.length, 0);
});

test('verifyManifest refuses a FUTURE manifestVersion: ok:false, no extract, no writes', async () => {
  const writeCalls = [];
  const extractCalls = [];
  const manifest = manifestWith([{ path: 'CLAUDE.md', preSha256: hashOf('x') }], { manifestVersion: 999 });
  const r = await restoreSnapshot({
    mgrStateDir: STATE_DIR, snapshotId: VALID_ID, targetClaudeDir: TARGET, assertWritable: PASS,
    seams: {
      resolveFn: tarSeam(), extractFn: extractSeam(true, extractCalls),
      readManifestFn: manifestSeam(manifest, []), mkdtempFn: mkdtempSeam([]),
      readFileFn: fileSeam({}, []), rmFn: () => {}, mkdirFn: () => {}, atomicWriteFn: writeSeam(writeCalls),
    },
  });
  assert.equal(r.ok, false);
  assert.equal(r.diagnostics.some((d) => d.code === 'manifest-version-unsupported'), true);
  assert.equal(extractCalls.length, 0); // never extracted
  assert.equal(writeCalls.length, 0);
});

test('cross-target manifest (expectedTarget mismatch): ok:false, no writes', async () => {
  const writeCalls = [];
  const manifest = manifestWith([{ path: 'CLAUDE.md', preSha256: hashOf('x') }]); // target=TARGET
  const r = await restoreSnapshot({
    mgrStateDir: STATE_DIR, snapshotId: VALID_ID, targetClaudeDir: TARGET, assertWritable: PASS,
    expectedTarget: resolve('/some/other/.claude'),
    seams: {
      resolveFn: tarSeam(), extractFn: extractSeam(true, []),
      readManifestFn: manifestSeam(manifest, []), mkdtempFn: mkdtempSeam([]),
      readFileFn: fileSeam({}, []), rmFn: () => {}, mkdirFn: () => {}, atomicWriteFn: writeSeam(writeCalls),
    },
  });
  assert.equal(r.ok, false);
  assert.equal(r.diagnostics.some((d) => d.code === 'manifest-target-mismatch'), true);
  assert.equal(writeCalls.length, 0);
});

test('tar unavailable: ok:false, rollback-restore-tar-unavailable, no mkdtemp/extract/writes', async () => {
  const writeCalls = [];
  const extractCalls = [];
  const prefixes = [];
  const manifest = manifestWith([{ path: 'CLAUDE.md', preSha256: hashOf('x') }]);
  const r = await restoreSnapshot({
    mgrStateDir: STATE_DIR, snapshotId: VALID_ID, targetClaudeDir: TARGET, assertWritable: PASS,
    seams: {
      resolveFn: tarSeam(null), extractFn: extractSeam(true, extractCalls),
      readManifestFn: manifestSeam(manifest, []), mkdtempFn: mkdtempSeam(prefixes),
      readFileFn: fileSeam({}, []), rmFn: () => {}, mkdirFn: () => {}, atomicWriteFn: writeSeam(writeCalls),
    },
  });
  assert.equal(r.ok, false);
  assert.equal(r.diagnostics.some((d) => d.code === 'rollback-restore-tar-unavailable'), true);
  assert.equal(prefixes.length, 0); // never made a temp dir
  assert.equal(extractCalls.length, 0);
  assert.equal(writeCalls.length, 0);
});

test('extract failed: ok:false, rollback-restore-extract-failed, no writes, temp CLEANED UP', async () => {
  const writeCalls = [];
  const rmCalls = [];
  const manifest = manifestWith([{ path: 'CLAUDE.md', preSha256: hashOf('x') }]);
  const r = await restoreSnapshot({
    mgrStateDir: STATE_DIR, snapshotId: VALID_ID, targetClaudeDir: TARGET, assertWritable: PASS,
    seams: {
      resolveFn: tarSeam(), extractFn: extractSeam(false, []), // extract FAILS
      readManifestFn: manifestSeam(manifest, []), mkdtempFn: mkdtempSeam([]),
      readFileFn: fileSeam({}, []), rmFn: (d) => rmCalls.push(d), mkdirFn: () => {}, atomicWriteFn: writeSeam(writeCalls),
    },
  });
  assert.equal(r.ok, false);
  assert.equal(r.diagnostics.some((d) => d.code === 'rollback-restore-extract-failed'), true);
  assert.equal(writeCalls.length, 0);
  assert.deepEqual(rmCalls, [FAKE_DEST]); // the temp dir was cleaned up in finally
});

// ── hard write failure ──────────────────────────────────────────────────────────────

test('hard write failure: loop STOPS, restored:false, leftovers surfaced, ERROR', async () => {
  const files = [
    { path: 'CLAUDE.md', preSha256: hashOf('a') },
    { path: 'settings.json', preSha256: hashOf('b') }, // would be 2nd; loop must NOT reach it
  ];
  const manifest = manifestWith(files);
  const writeCalls = [];
  const readContents = {
    [resolve(FAKE_DEST, 'CLAUDE.md')]: 'a',
    [resolve(FAKE_DEST, 'settings.json')]: 'b',
  };
  // The FIRST write (CLAUDE.md) fails hard with leftovers.
  const lo = { newPath: resolve(TARGET, 'CLAUDE.md') + '.mgr-new', oldPath: resolve(TARGET, 'CLAUDE.md') + '.mgr-old' };
  const failingWrite = writeSeam(writeCalls, { failOn: new Set([resolve(TARGET, 'CLAUDE.md')]), leftovers: lo });
  const r = await restoreSnapshot({
    mgrStateDir: STATE_DIR, snapshotId: VALID_ID, targetClaudeDir: TARGET, assertWritable: PASS,
    seams: {
      resolveFn: tarSeam(), extractFn: extractSeam(true, []),
      readManifestFn: manifestSeam(manifest, []), mkdtempFn: mkdtempSeam([]),
      readFileFn: fileSeam(readContents, []), rmFn: () => {}, mkdirFn: () => {}, atomicWriteFn: failingWrite,
    },
  });
  assert.equal(r.ok, true); // the run itself completed (extract ok)
  assert.equal(r.restored, false); // a hard write failure
  assert.equal(r.restoredCount, 0);
  assert.deepEqual(r.leftovers, lo); // sidecars surfaced for recover/doctor
  assert.equal(writeCalls.length, 1); // loop STOPPED — settings.json never attempted
  assert.equal(r.diagnostics.some((d) => d.code === 'rollback-restore-write-failed' && d.severity === 'error'), true);
  // The failing primitive's own diagnostics were aggregated.
  assert.equal(r.diagnostics.some((d) => d.code === 'apply-write-staging-failed'), true);
});

// ── temp cleanup on success ─────────────────────────────────────────────────────────

test('temp cleanup: rmFn is called with the mkdtemp dir on a SUCCESSFUL restore too', async () => {
  const manifest = manifestWith([{ path: 'CLAUDE.md', preSha256: hashOf('a') }]);
  const rmCalls = [];
  const r = await restoreSnapshot({
    mgrStateDir: STATE_DIR, snapshotId: VALID_ID, targetClaudeDir: TARGET, assertWritable: PASS,
    seams: {
      resolveFn: tarSeam(), extractFn: extractSeam(true, []),
      readManifestFn: manifestSeam(manifest, []), mkdtempFn: mkdtempSeam([]),
      readFileFn: fileSeam({ [resolve(FAKE_DEST, 'CLAUDE.md')]: 'a' }, []),
      rmFn: (d) => rmCalls.push(d), mkdirFn: () => {}, atomicWriteFn: writeSeam([]),
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.restored, true);
  assert.deepEqual(rmCalls, [FAKE_DEST]);
});

// ── never-throws ────────────────────────────────────────────────────────────────────

test('never-throws: a thrown extractFn becomes rollback-restore-unexpected-error', async () => {
  const manifest = manifestWith([{ path: 'CLAUDE.md', preSha256: hashOf('a') }]);
  const rmCalls = [];
  const r = await restoreSnapshot({
    mgrStateDir: STATE_DIR, snapshotId: VALID_ID, targetClaudeDir: TARGET, assertWritable: PASS,
    seams: {
      resolveFn: tarSeam(), extractFn: () => { throw new Error('boom-extract'); },
      readManifestFn: manifestSeam(manifest, []), mkdtempFn: mkdtempSeam([]),
      readFileFn: fileSeam({}, []), rmFn: (d) => rmCalls.push(d), mkdirFn: () => {}, atomicWriteFn: writeSeam([]),
    },
  });
  assert.equal(r.ok, false);
  assert.equal(r.diagnostics.some((d) => d.code === 'rollback-restore-unexpected-error'), true);
  // Even on a thrown seam after mkdtemp, the finally cleanup still ran.
  assert.deepEqual(rmCalls, [FAKE_DEST]);
});

test('never-throws: a thrown readFileFn (non-ENOENT) → verify-mismatch skip, no throw', async () => {
  const manifest = manifestWith([{ path: 'CLAUDE.md', preSha256: hashOf('a') }]);
  const writeCalls = [];
  const r = await restoreSnapshot({
    mgrStateDir: STATE_DIR, snapshotId: VALID_ID, targetClaudeDir: TARGET, assertWritable: PASS,
    seams: {
      resolveFn: tarSeam(), extractFn: extractSeam(true, []),
      readManifestFn: manifestSeam(manifest, []), mkdtempFn: mkdtempSeam([]),
      readFileFn: () => { throw new Error('EACCES boom'); }, // non-ENOENT read error
      rmFn: () => {}, mkdirFn: () => {}, atomicWriteFn: writeSeam(writeCalls),
    },
  });
  assert.equal(r.ok, true); // the run completed; the per-file error is contained
  assert.equal(r.restored, false); // an unreadable extracted file is a failure
  assert.deepEqual(r.skipped, [{ path: 'CLAUDE.md', reason: 'verify-mismatch' }]);
  assert.equal(writeCalls.length, 0);
  assert.equal(r.diagnostics.some((d) => d.code === 'rollback-restore-extract-read-failed'), true);
});

// ── LOW-1 regression tests: gate-error vs surface-deny discrimination ─────────────

test('LOW-1a: write-canonicalize-failed → rollback-restore-gate-error + restored:false, NOT written', async () => {
  // A WriteForbiddenError with code:'write-canonicalize-failed' (e.g. ELOOP symlink)
  // is NOT a surface denial — it must become a gate ERROR so restored:false.
  const files = [
    { path: 'CLAUDE.md', preSha256: hashOf('ok') },
    { path: 'agents/loopy.md', preSha256: hashOf('loopy') }, // this one triggers the error
  ];
  const manifest = manifestWith(files);
  const writeCalls = [];
  const readContents = {
    [resolve(FAKE_DEST, 'CLAUDE.md')]: 'ok',
    [resolve(FAKE_DEST, 'agents/loopy.md')]: 'loopy',
  };
  const loopyTarget = resolve(TARGET, 'agents/loopy.md');
  const gate = (p) => {
    if (p === loopyTarget) {
      // Simulate paths.mjs throwing write-canonicalize-failed (ELOOP / EACCES on realpath).
      throw Object.assign(new Error('ELOOP symlink'), { name: 'WriteForbiddenError', code: 'write-canonicalize-failed' });
    }
    return p;
  };
  const r = await restoreSnapshot({
    mgrStateDir: STATE_DIR, snapshotId: VALID_ID, targetClaudeDir: TARGET, assertWritable: gate,
    seams: {
      resolveFn: tarSeam(), extractFn: extractSeam(true, []),
      readManifestFn: manifestSeam(manifest, []), mkdtempFn: mkdtempSeam([]),
      readFileFn: fileSeam(readContents, []),
      rmFn: () => {}, mkdirFn: () => {}, atomicWriteFn: writeSeam(writeCalls),
    },
  });
  assert.equal(r.ok, true); // run completed
  assert.equal(r.restored, false); // canonicalize failure is a real failure
  // The erroring file lands in skipped with verify-mismatch (not out-of-surface).
  assert.equal(r.skipped.some((s) => s.path === 'agents/loopy.md' && s.reason === 'verify-mismatch'), true);
  // A rollback-restore-gate-error ERROR diagnostic is present for this file.
  assert.equal(r.diagnostics.some((d) => d.code === 'rollback-restore-gate-error' && d.severity === 'error'), true);
  // The erroring file was NEVER written.
  assert.equal(writeCalls.some((c) => c.target === loopyTarget), false);
  // The OTHER file (CLAUDE.md) was still restored successfully.
  assert.equal(writeCalls.some((c) => c.target === resolve(TARGET, 'CLAUDE.md')), true);
  assert.equal(r.restoredCount, 1);
});

test('LOW-1b: genuine write-not-allowed stays out-of-surface + restored:true (surface-deny is non-fatal)', async () => {
  // A WriteForbiddenError with code:'write-not-allowed' IS a surface denial —
  // the file is skipped as out-of-surface and restored stays true.
  const manifest = manifestWith([{ path: 'hud/status.mjs', preSha256: hashOf('hud') }]);
  const writeCalls = [];
  const readContents = { [resolve(FAKE_DEST, 'hud/status.mjs')]: 'hud' };
  const gate = (p) => {
    throw Object.assign(new Error('not in allowlist'), { name: 'WriteForbiddenError', code: 'write-not-allowed' });
  };
  const r = await restoreSnapshot({
    mgrStateDir: STATE_DIR, snapshotId: VALID_ID, targetClaudeDir: TARGET, assertWritable: gate,
    seams: {
      resolveFn: tarSeam(), extractFn: extractSeam(true, []),
      readManifestFn: manifestSeam(manifest, []), mkdtempFn: mkdtempSeam([]),
      readFileFn: fileSeam(readContents, []),
      rmFn: () => {}, mkdirFn: () => {}, atomicWriteFn: writeSeam(writeCalls),
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.restored, true); // surface deny is NON-fatal
  assert.deepEqual(r.skipped, [{ path: 'hud/status.mjs', reason: 'out-of-surface' }]);
  assert.equal(writeCalls.length, 0); // never written
  assert.equal(r.diagnostics.some((d) => d.code === 'rollback-restore-skipped-out-of-surface'), true);
  assert.equal(r.diagnostics.some((d) => d.code === 'rollback-restore-gate-error'), false); // no error
});

// ── mode restore (v2: chmod the restored file on POSIX; skip on win32) ───────────────

/** A recording chmodFn seam. Records every { path, mode } it was asked to set. */
function chmodSeam(calls) {
  return (p, mode) => { calls.push({ path: p, mode }); };
}

test('mode restore: on POSIX, a captured mode is chmod\'d onto the restored file AFTER the write', async () => {
  const manifest = manifestWith([{ path: 'hooks/run.sh', preSha256: hashOf('#!/bin/sh\n'), mode: 0o755 }]);
  const writeCalls = [];
  const chmodCalls = [];
  const readContents = { [resolve(FAKE_DEST, 'hooks/run.sh')]: '#!/bin/sh\n' };
  const r = await restoreSnapshot({
    mgrStateDir: STATE_DIR, snapshotId: VALID_ID, targetClaudeDir: TARGET, assertWritable: PASS, platform: 'linux',
    seams: {
      resolveFn: tarSeam(), extractFn: extractSeam(true, []),
      readManifestFn: manifestSeam(manifest, []), mkdtempFn: mkdtempSeam([]),
      readFileFn: fileSeam(readContents, []), rmFn: () => {}, mkdirFn: () => {},
      atomicWriteFn: writeSeam(writeCalls), chmodFn: chmodSeam(chmodCalls),
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.restored, true);
  assert.equal(r.restoredCount, 1);
  assert.equal(writeCalls.length, 1); // the write happened
  // chmod ran with the CONTAINED live target + the captured mode.
  assert.deepEqual(chmodCalls, [{ path: resolve(TARGET, 'hooks/run.sh'), mode: 0o755 }]);
});

test('mode restore: on win32, chmod is SKIPPED (no meaningful POSIX mode); content still restored', async () => {
  const manifest = manifestWith([{ path: 'hooks/run.sh', preSha256: hashOf('x'), mode: 0o755 }]);
  const writeCalls = [];
  const chmodCalls = [];
  const r = await restoreSnapshot({
    mgrStateDir: STATE_DIR, snapshotId: VALID_ID, targetClaudeDir: TARGET, assertWritable: PASS, platform: 'win32',
    seams: {
      resolveFn: tarSeam(), extractFn: extractSeam(true, []),
      readManifestFn: manifestSeam(manifest, []), mkdtempFn: mkdtempSeam([]),
      readFileFn: fileSeam({ [resolve(FAKE_DEST, 'hooks/run.sh')]: 'x' }, []), rmFn: () => {}, mkdirFn: () => {},
      atomicWriteFn: writeSeam(writeCalls), chmodFn: chmodSeam(chmodCalls),
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.restored, true);
  assert.equal(r.restoredCount, 1);
  assert.deepEqual(chmodCalls, [], 'no chmod on win32');
});

test('mode restore: a v1 / no-mode record does NOT chmod (nothing captured) even on POSIX', async () => {
  const manifest = manifestWith([{ path: 'CLAUDE.md', preSha256: hashOf('a') }]); // no mode
  const chmodCalls = [];
  const r = await restoreSnapshot({
    mgrStateDir: STATE_DIR, snapshotId: VALID_ID, targetClaudeDir: TARGET, assertWritable: PASS, platform: 'linux',
    seams: {
      resolveFn: tarSeam(), extractFn: extractSeam(true, []),
      readManifestFn: manifestSeam(manifest, []), mkdtempFn: mkdtempSeam([]),
      readFileFn: fileSeam({ [resolve(FAKE_DEST, 'CLAUDE.md')]: 'a' }, []), rmFn: () => {}, mkdirFn: () => {},
      atomicWriteFn: writeSeam([]), chmodFn: chmodSeam(chmodCalls),
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.restored, true);
  assert.deepEqual(chmodCalls, [], 'no mode captured → no chmod');
});

test('mode restore: chmod runs AFTER the content write (rename-based atomic write would discard an earlier chmod)', async () => {
  const manifest = manifestWith([{ path: 'hooks/run.sh', preSha256: hashOf('#!/bin/sh\n'), mode: 0o755 }]);
  const events = []; // ONE shared ordered log for both seams → the ordering is falsifiable
  const orderedWrite = async (args) => {
    events.push({ op: 'write', target: args.target });
    return { ok: true, wrote: true, leftovers: { newPath: null, oldPath: null }, diagnostics: [] };
  };
  const orderedChmod = (p) => { events.push({ op: 'chmod', path: p }); };
  const r = await restoreSnapshot({
    mgrStateDir: STATE_DIR, snapshotId: VALID_ID, targetClaudeDir: TARGET, assertWritable: PASS, platform: 'linux',
    seams: {
      resolveFn: tarSeam(), extractFn: extractSeam(true, []),
      readManifestFn: manifestSeam(manifest, []), mkdtempFn: mkdtempSeam([]),
      readFileFn: fileSeam({ [resolve(FAKE_DEST, 'hooks/run.sh')]: '#!/bin/sh\n' }, []), rmFn: () => {}, mkdirFn: () => {},
      atomicWriteFn: orderedWrite, chmodFn: orderedChmod,
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.restored, true);
  const target = resolve(TARGET, 'hooks/run.sh');
  assert.deepEqual(events, [{ op: 'write', target }, { op: 'chmod', path: target }],
    'the content write MUST precede the chmod for this file');
});

test('mode restore: mode 0 is a VALID captured mode → chmod\'d, NOT skipped as if absent', async () => {
  // isValidMode(0) is true, so mode:0 is distinct from an absent mode — restore must
  // chmod it (guards against a `!isValidMode(mode)` → `!mode` truthiness simplification).
  const manifest = manifestWith([{ path: 'agents/locked.md', preSha256: hashOf('x'), mode: 0 }]);
  const chmodCalls = [];
  const r = await restoreSnapshot({
    mgrStateDir: STATE_DIR, snapshotId: VALID_ID, targetClaudeDir: TARGET, assertWritable: PASS, platform: 'linux',
    seams: {
      resolveFn: tarSeam(), extractFn: extractSeam(true, []),
      readManifestFn: manifestSeam(manifest, []), mkdtempFn: mkdtempSeam([]),
      readFileFn: fileSeam({ [resolve(FAKE_DEST, 'agents/locked.md')]: 'x' }, []), rmFn: () => {}, mkdirFn: () => {},
      atomicWriteFn: writeSeam([]), chmodFn: chmodSeam(chmodCalls),
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.restored, true);
  assert.deepEqual(chmodCalls, [{ path: resolve(TARGET, 'agents/locked.md'), mode: 0 }], 'mode 0 is chmod\'d, not skipped');
});

test('mode restore: a chmod FAILURE is a WARN, not fatal — content stays restored (maintainer decision)', async () => {
  const manifest = manifestWith([{ path: 'hooks/run.sh', preSha256: hashOf('x'), mode: 0o600 }]);
  const writeCalls = [];
  const r = await restoreSnapshot({
    mgrStateDir: STATE_DIR, snapshotId: VALID_ID, targetClaudeDir: TARGET, assertWritable: PASS, platform: 'linux',
    seams: {
      resolveFn: tarSeam(), extractFn: extractSeam(true, []),
      readManifestFn: manifestSeam(manifest, []), mkdtempFn: mkdtempSeam([]),
      readFileFn: fileSeam({ [resolve(FAKE_DEST, 'hooks/run.sh')]: 'x' }, []), rmFn: () => {}, mkdirFn: () => {},
      atomicWriteFn: writeSeam(writeCalls), chmodFn: () => { throw new Error('EPERM'); },
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.restored, true, 'chmod failure does NOT flip restored (content is byte-identical)');
  assert.equal(r.restoredCount, 1);
  assert.equal(writeCalls.length, 1);
  assert.equal(r.diagnostics.some((d) => d.code === 'rollback-restore-chmod-failed' && d.severity === 'warn'), true);
});
