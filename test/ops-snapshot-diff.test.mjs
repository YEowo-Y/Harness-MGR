/**
 * Tests for src/ops/snapshot-diff.mjs — the snapshot-to-snapshot diff engine for
 * `config diff <idA> <idB> [relpath]`.
 *
 * Falsifiable oracles (assert EXACT values, not just "no throw"):
 *  - MODE A (manifest): exact sorted added/removed/modified arrays + unchanged count.
 *  - proto-safety: a '__proto__' manifest path neither crashes nor poisons.
 *  - bad id / not-found refusals with the exact diagnostic codes.
 *  - MODE B (content): the Myers stats + the unified +/- lines + `changed`; an
 *    identical-content pair → changed:false.
 *  - MODE B traversal: an absolute / '..' relpath is refused BEFORE extracting
 *    (the extract seam is asserted NEVER called) + bounded cleanup runs.
 *  - never-throws on all-garbage input.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { diffSnapshots } from '../src/ops/snapshot-diff.mjs';

const STATE = '/abs/.mgr-state';
const ID_A = '2026-06-08T00-00-00Z';
const ID_B = '2026-06-08T01-00-00Z';

/** Find a diagnostic by code. */
function diag(result, code) {
  return result.diagnostics.find((d) => d.code === code) || null;
}

/** A readManifest seam: returns the given manifest for an id (or a not-found result). */
function fakeManifests(byId) {
  return ({ snapshotId }) => {
    const m = byId[snapshotId];
    if (m === undefined) {
      return { manifest: null, diagnostics: [{ severity: 'error', code: 'manifest-not-found', message: 'gone' }] };
    }
    return { manifest: m, diagnostics: [] };
  };
}

/** Build a manifest with the given {path: preSha256} files. */
function manifest(files) {
  return {
    manifestVersion: 1, planVersion: 1, snapshotId: ID_A,
    targetClaudeDir: '/abs/.claude', createdAt: '2026-06-08T00:00:00.000Z', reason: '',
    files: Object.entries(files).map(([path, preSha256]) => ({ path, preSha256, currentSha256: preSha256 })),
  };
}

// ── MODE A — manifest diff ──────────────────────────────────────────────────────

test('manifest mode: exact added/removed/modified/unchanged', async () => {
  const a = manifest({ 'keep.md': 'h1', 'change.md': 'old', 'gone.md': 'h3', 'also.md': 'h4' });
  const b = manifest({ 'keep.md': 'h1', 'change.md': 'new', 'add.md': 'h5', 'also.md': 'h4' });
  const r = await diffSnapshots({
    mgrStateDir: STATE, idA: ID_A, idB: ID_B,
    readManifestFn: fakeManifests({ [ID_A]: a, [ID_B]: b }),
  });
  assert.equal(r.mode, 'manifest');
  assert.equal(r.ok, true);
  assert.deepEqual(r.added, ['add.md']);
  assert.deepEqual(r.removed, ['gone.md']);
  assert.deepEqual(r.modified, ['change.md']);
  assert.equal(r.unchanged, 2); // keep.md + also.md
});

test('manifest mode: results are sorted ascending', async () => {
  const a = manifest({});
  const b = manifest({ 'z.md': '1', 'a.md': '2', 'm.md': '3' });
  const r = await diffSnapshots({
    mgrStateDir: STATE, idA: ID_A, idB: ID_B,
    readManifestFn: fakeManifests({ [ID_A]: a, [ID_B]: b }),
  });
  assert.deepEqual(r.added, ['a.md', 'm.md', 'z.md']);
  assert.deepEqual(r.removed, []);
  assert.deepEqual(r.modified, []);
  assert.equal(r.unchanged, 0);
});

test('manifest mode: identical manifests → all unchanged, empty deltas', async () => {
  const a = manifest({ 'x.md': 'h', 'y.md': 'h2' });
  const r = await diffSnapshots({
    mgrStateDir: STATE, idA: ID_A, idB: ID_B,
    readManifestFn: fakeManifests({ [ID_A]: a, [ID_B]: a }),
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.added, []);
  assert.deepEqual(r.removed, []);
  assert.deepEqual(r.modified, []);
  assert.equal(r.unchanged, 2);
});

test('manifest mode: proto-safety — __proto__/constructor/prototype paths skipped, no poison', async () => {
  // Build the files array EXPLICITLY: a quoted `'__proto__'` KEY in an object literal
  // is the proto-setter syntax (not an own property), so manifest({'__proto__':..})
  // would never actually inject a __proto__ FILE PATH. Construct the records directly
  // so all three poison-keyed paths really reach shaMap.
  const withProtoPaths = (sha) => ({
    manifestVersion: 1, planVersion: 1, snapshotId: ID_A,
    targetClaudeDir: '/abs/.claude', createdAt: '2026-06-08T00:00:00.000Z', reason: '',
    files: [
      { path: '__proto__', preSha256: `${sha}-p`, currentSha256: `${sha}-p` },
      { path: 'constructor', preSha256: `${sha}-c`, currentSha256: `${sha}-c` },
      { path: 'prototype', preSha256: `${sha}-t`, currentSha256: `${sha}-t` },
      { path: 'real.md', preSha256: sha, currentSha256: sha },
    ],
  });
  const r = await diffSnapshots({
    mgrStateDir: STATE, idA: ID_A, idB: ID_B,
    readManifestFn: fakeManifests({ [ID_A]: withProtoPaths('h1'), [ID_B]: withProtoPaths('h2') }),
  });
  assert.equal(r.ok, true);
  // All three poison-keyed paths are skipped — only real.md (h1→h2) is a real change.
  assert.deepEqual(r.added, []);
  assert.deepEqual(r.removed, []);
  assert.deepEqual(r.modified, ['real.md']);
  assert.equal(r.unchanged, 0);
  // Object.prototype is intact (no poisoning via the proto-keyed paths).
  assert.equal({}.evil, undefined);
  assert.equal(Object.prototype['real.md'], undefined);
});

test('manifest mode: bad id (idA) → snapshot-diff-bad-id, ok:false, no throw', async () => {
  let called = false;
  const r = await diffSnapshots({
    mgrStateDir: STATE, idA: 'not-an-id', idB: ID_B,
    readManifestFn: () => { called = true; return { manifest: null, diagnostics: [] }; },
  });
  assert.equal(r.mode, 'manifest');
  assert.equal(r.ok, false);
  assert.ok(diag(r, 'snapshot-diff-bad-id'));
  assert.equal(called, false); // refused before any read
});

test('manifest mode: bad id (idB) → snapshot-diff-bad-id', async () => {
  const r = await diffSnapshots({
    mgrStateDir: STATE, idA: ID_A, idB: '../escape',
    readManifestFn: () => { throw new Error('must not be called'); },
  });
  assert.equal(r.ok, false);
  assert.ok(diag(r, 'snapshot-diff-bad-id'));
});

test('manifest mode: missing manifest → snapshot-diff-not-found, ok:false', async () => {
  const a = manifest({ 'x.md': 'h' });
  const r = await diffSnapshots({
    mgrStateDir: STATE, idA: ID_A, idB: ID_B,
    readManifestFn: fakeManifests({ [ID_A]: a }), // ID_B missing
  });
  assert.equal(r.ok, false);
  assert.ok(diag(r, 'snapshot-diff-not-found'));
  assert.equal(r.idA, ID_A);
  assert.equal(r.idB, ID_B);
});

// ── MODE B — content diff ───────────────────────────────────────────────────────

const RELPATH = 'settings.json';

/** A resolveTar seam reporting tar present. */
function tarFound() {
  return () => ({ tarPath: '/abs/tar', diagnostics: [] });
}

/**
 * Build the content-mode seams that feed two text versions WITHOUT a real tar.
 * Each `tmpRootFn` call yields a unique dir; the extract for the FIRST dir stores
 * textA and the SECOND stores textB (the engine extracts A then B). `readFileFn`
 * keys the file text off the OS-resolved member path the module computes, so the
 * mapping is robust to win32/posix path normalization. A text of `MISSING` makes
 * the member read as ENOENT (absent in that snapshot).
 */
function contentSeams({ textA, textB, onExtract, onRm } = {}) {
  let dirN = 0;
  const order = []; // dirs in tmpRootFn order
  const dirText = new Map();
  const memberAbs = (dir) => resolve(join(dir, ...RELPATH.split('/')));
  return {
    resolveFn: tarFound(),
    tmpRootFn: () => {
      const dir = `/tmp/diff-${dirN}`;
      order.push(dir);
      dirN += 1;
      return dir;
    },
    extractFn: async ({ destDir }) => {
      if (onExtract) onExtract();
      const idx = order.indexOf(destDir);
      dirText.set(memberAbs(destDir), idx === 0 ? textA : textB);
      return { ok: true, diagnostics: [] };
    },
    readFileFn: (abs) => {
      const t = dirText.get(abs);
      if (t === undefined || t === 'MISSING') { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
      return t;
    },
    rmFn: (dir) => { if (onRm) onRm(dir); },
  };
}

test('content mode: line diff stats + unified +/- lines + changed:true', async () => {
  const seams = contentSeams({ textA: 'line1\nline2\nline3\n', textB: 'line1\nCHANGED\nline3\n' });
  const r = await diffSnapshots({
    mgrStateDir: STATE, idA: ID_A, idB: ID_B, relpath: RELPATH,
    resolveFn: seams.resolveFn, tmpRootFn: seams.tmpRootFn,
    extractFn: seams.extractFn, readFileFn: seams.readFileFn, rmFn: seams.rmFn,
  });
  assert.equal(r.mode, 'content');
  assert.equal(r.ok, true);
  assert.equal(r.relpath, RELPATH);
  assert.equal(r.stats.added, 1);
  assert.equal(r.stats.deleted, 1);
  assert.equal(r.changed, true);
  assert.equal(r.aLabel, `${ID_A}:${RELPATH}`);
  assert.equal(r.bLabel, `${ID_B}:${RELPATH}`);
  assert.ok(r.unified.includes('-line2'));
  assert.ok(r.unified.includes('+CHANGED'));
});

test('content mode: identical content → changed:false, zero stats', async () => {
  const seams = contentSeams({ textA: 'same\ncontent\n', textB: 'same\ncontent\n' });
  const r = await diffSnapshots({
    mgrStateDir: STATE, idA: ID_A, idB: ID_B, relpath: RELPATH,
    resolveFn: seams.resolveFn, tmpRootFn: seams.tmpRootFn,
    extractFn: seams.extractFn, readFileFn: seams.readFileFn, rmFn: seams.rmFn,
  });
  assert.equal(r.ok, true);
  assert.equal(r.changed, false);
  assert.equal(r.stats.added, 0);
  assert.equal(r.stats.deleted, 0);
});

test('content mode: a member absent in one snapshot reads as a pure add', async () => {
  // textA 'MISSING' → readFileFn throws ENOENT for the A extraction → '' → pure add.
  const seams = contentSeams({ textA: 'MISSING', textB: 'new1\nnew2\n' });
  const r = await diffSnapshots({
    mgrStateDir: STATE, idA: ID_A, idB: ID_B, relpath: RELPATH,
    resolveFn: seams.resolveFn, tmpRootFn: seams.tmpRootFn,
    extractFn: seams.extractFn, readFileFn: seams.readFileFn, rmFn: seams.rmFn,
  });
  assert.equal(r.ok, true);
  assert.equal(r.changed, true);
  assert.ok(r.stats.added >= 2);
  assert.equal(r.stats.deleted, 0);
});

test('content mode: extract FAILURE → ok:false (not a silent "no change")', async () => {
  // A tar extract that FAILS (ok:false) for both snapshots: the members read as ''
  // so the diff is empty, but `ok` must be FALSE so a consumer reading only `ok`
  // sees the failure — not just the warn diagnostic. readFileFn must NOT be reached.
  let reads = 0;
  let n = 0;
  const r = await diffSnapshots({
    mgrStateDir: STATE, idA: ID_A, idB: ID_B, relpath: RELPATH,
    resolveFn: () => ({ tarPath: '/abs/tar', diagnostics: [] }),
    tmpRootFn: () => `/tmp/diff-fail-${n++}`,
    extractFn: async () => ({ ok: false, diagnostics: [{ severity: 'error', code: 'tar-extract-failed', message: 'boom' }] }),
    readFileFn: () => { reads += 1; throw new Error('must not read on extract fail'); },
    rmFn: () => {},
  });
  assert.equal(r.mode, 'content');
  assert.equal(r.ok, false, 'an extract failure must surface as ok:false');
  assert.equal(r.changed, false); // both members '' → empty diff
  assert.equal(reads, 0, 'readFileFn must not run when extraction failed');
  assert.ok(diag(r, 'snapshot-diff-extract-failed'), 'the warn is still present');
});

test('content mode: bounded cleanup removes both temp dirs in the finally', async () => {
  const removed = [];
  const seams = contentSeams({ textA: 'a\n', textB: 'b\n', onRm: (d) => removed.push(d) });
  await diffSnapshots({
    mgrStateDir: STATE, idA: ID_A, idB: ID_B, relpath: RELPATH,
    resolveFn: seams.resolveFn, tmpRootFn: seams.tmpRootFn,
    extractFn: seams.extractFn, readFileFn: seams.readFileFn, rmFn: seams.rmFn,
  });
  assert.equal(removed.length, 2);
});

test('content mode: traversal relpath → snapshot-diff-bad-path, extract NEVER called', async () => {
  let extracted = false;
  const seams = contentSeams({ textA: 'a', textB: 'b', onExtract: () => { extracted = true; } });
  for (const bad of ['../escape', '/etc/passwd', 'C:\\windows', 'a/../../b']) {
    const r = await diffSnapshots({
      mgrStateDir: STATE, idA: ID_A, idB: ID_B, relpath: bad,
      resolveFn: seams.resolveFn, tmpRootFn: seams.tmpRootFn,
      extractFn: seams.extractFn, readFileFn: seams.readFileFn, rmFn: seams.rmFn,
    });
    assert.equal(r.mode, 'content');
    assert.equal(r.ok, false);
    assert.ok(diag(r, 'snapshot-diff-bad-path'), `expected bad-path for ${bad}`);
  }
  assert.equal(extracted, false);
});

test('content mode: bad id refuses before resolving tar', async () => {
  let resolved = false;
  const r = await diffSnapshots({
    mgrStateDir: STATE, idA: 'bad', idB: ID_B, relpath: RELPATH,
    resolveFn: () => { resolved = true; return { tarPath: '/abs/tar', diagnostics: [] }; },
  });
  assert.equal(r.ok, false);
  assert.ok(diag(r, 'snapshot-diff-bad-id'));
  assert.equal(resolved, false);
});

test('content mode: tar unavailable → snapshot-diff-tar-unavailable, ok:false', async () => {
  const r = await diffSnapshots({
    mgrStateDir: STATE, idA: ID_A, idB: ID_B, relpath: RELPATH,
    resolveFn: () => ({ tarPath: null, diagnostics: [] }),
  });
  assert.equal(r.ok, false);
  assert.ok(diag(r, 'snapshot-diff-tar-unavailable'));
});

// ── never-throws ────────────────────────────────────────────────────────────────

test('never-throws: all-garbage/empty input returns a result with diagnostics', async () => {
  const r = await diffSnapshots({});
  assert.equal(typeof r, 'object');
  assert.ok(Array.isArray(r.diagnostics));
  assert.equal(r.ok, false);
  assert.ok(r.diagnostics.length > 0);
});

test('never-throws: undefined opts returns a result, no throw', async () => {
  const r = await diffSnapshots(undefined);
  assert.equal(typeof r, 'object');
  assert.equal(r.ok, false);
  assert.ok(Array.isArray(r.diagnostics));
});

test('never-throws: a readManifest seam that throws is contained', async () => {
  const r = await diffSnapshots({
    mgrStateDir: STATE, idA: ID_A, idB: ID_B,
    readManifestFn: () => { throw new Error('boom'); },
  });
  assert.equal(r.ok, false);
  assert.ok(diag(r, 'snapshot-diff-unexpected-error'));
});
