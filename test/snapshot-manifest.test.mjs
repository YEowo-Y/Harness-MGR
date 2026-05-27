/**
 * P3.U8 — snapshot-manifest.test.mjs
 *
 * Tests for src/ops/snapshot-manifest.mjs: makeSnapshotId / isValidSnapshotId /
 * buildManifest / writeManifest / readManifest / verifyManifest.
 *
 * Acceptance (DoD): a build -> write -> read -> verify round-trip is byte-stable
 * (golden property) and verifies clean. All filesystem access uses a real temp
 * dir; all seams (assertWritable, now, read/write/mkdir) are injected.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

import {
  MANIFEST_VERSION,
  SNAPSHOT_ID_RE,
  makeSnapshotId,
  isValidSnapshotId,
  snapshotDir,
  manifestPath,
  buildManifest,
  verifyManifest,
  serialize,
} from '../src/ops/snapshot-manifest.mjs';
import { writeManifest, readManifest } from '../src/ops/snapshot-manifest-io.mjs';

// ── shared helpers ────────────────────────────────────────────────────────────

function makeTmpDir() {
  const dir = mkdtempSync(join(tmpdir(), 'cmgr-snap-'));
  return {
    dir,
    cleanup() { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } },
  };
}

const FIXED_NOW = () => new Date('2026-05-27T00:00:00.000Z');
const FIXED_ID = '2026-05-27T00-00-00Z';
const TARGET = '/c/Users/test/.claude';
const PASS_GATE = (p) => p; // passthrough write gate

/** Build a valid manifest for the common case. */
function builtManifest(overrides = {}) {
  const { manifest } = buildManifest({
    snapshotId: FIXED_ID,
    targetClaudeDir: TARGET,
    files: [
      { path: 'skills/b/SKILL.md', sha256: 'bbb' },
      { path: 'skills/a/SKILL.md', sha256: 'aaa' },
    ],
    now: FIXED_NOW,
    ...overrides,
  });
  return manifest;
}

// ── makeSnapshotId / isValidSnapshotId ────────────────────────────────────────

test('makeSnapshotId: formats a Date as YYYY-MM-DDTHH-MM-SSZ and matches the regex', () => {
  const id = makeSnapshotId(new Date('2026-05-27T13:04:09.123Z'));
  assert.equal(id, '2026-05-27T13-04-09Z');
  assert.ok(SNAPSHOT_ID_RE.test(id));
  assert.equal(isValidSnapshotId(id), true);
});

test('makeSnapshotId: invalid Date falls back to a valid id', () => {
  const id = makeSnapshotId(new Date('not-a-date'));
  assert.equal(isValidSnapshotId(id), true);
});

test('makeSnapshotId: no-arg produces a valid id', () => {
  assert.equal(isValidSnapshotId(makeSnapshotId()), true);
});

test('isValidSnapshotId: rejects traversal-ish + malformed ids (path-traversal guard)', () => {
  for (const bad of ['', '../../etc', 'a/b', '..', '2026-05-27', '2026-05-27T00:00:00Z',
    'x'.repeat(10), null, undefined, 42, '2026-05-27T00-00-00Z/..']) {
    assert.equal(isValidSnapshotId(bad), false, `should reject ${JSON.stringify(bad)}`);
  }
});

// ── buildManifest ─────────────────────────────────────────────────────────────

test('buildManifest: builds a well-formed manifest with fixed fields', () => {
  const m = builtManifest();
  assert.equal(m.manifestVersion, MANIFEST_VERSION);
  assert.equal(m.planVersion, 1);
  assert.equal(m.snapshotId, FIXED_ID);
  assert.equal(m.targetClaudeDir, TARGET);
  assert.equal(m.createdAt, '2026-05-27T00:00:00.000Z');
  assert.equal(m.reason, '');
  assert.equal(m.files.length, 2);
});

test('buildManifest: each file record expands sha256 -> pre === current', () => {
  const m = builtManifest();
  for (const f of m.files) {
    assert.equal(f.preSha256, f.currentSha256, 'pre and current equal at creation');
    assert.ok(typeof f.path === 'string' && f.path.length > 0);
  }
});

test('buildManifest: files are path-sorted regardless of input order (determinism)', () => {
  const m = builtManifest();
  assert.deepEqual(m.files.map((f) => f.path), ['skills/a/SKILL.md', 'skills/b/SKILL.md']);
});

test('buildManifest: duplicate paths serialize byte-identically across input order (total sort)', () => {
  const dup = (files) => buildManifest({
    snapshotId: FIXED_ID, targetClaudeDir: TARGET, now: FIXED_NOW, files,
  }).manifest;
  const a = dup([{ path: 'z', sha256: '1' }, { path: 'z', sha256: '2' }, { path: 'z', sha256: '3' }]);
  const b = dup([{ path: 'z', sha256: '3' }, { path: 'z', sha256: '2' }, { path: 'z', sha256: '1' }]);
  assert.equal(serialize(a), serialize(b), 'dup-path manifests must be byte-stable regardless of order');
});

test('buildManifest: carries planVersion + reason when given', () => {
  const m = builtManifest({ planVersion: 1, reason: 'pre-remove backup' });
  assert.equal(m.reason, 'pre-remove backup');
});

test('buildManifest: malformed file entries are skipped with a warn, manifest still built', () => {
  const { manifest, diagnostics } = buildManifest({
    snapshotId: FIXED_ID, targetClaudeDir: TARGET, now: FIXED_NOW,
    files: [
      { path: 'ok.md', sha256: 'h' },
      { path: 'no-hash.md' },          // missing sha256
      { sha256: 'orphan' },            // missing path
      null, 42, 'string',              // non-objects
    ],
  });
  assert.ok(manifest, 'manifest still built from the readable records');
  assert.equal(manifest.files.length, 1);
  const warns = diagnostics.filter((d) => d.code === 'manifest-file-skipped');
  assert.equal(warns.length, 5);
  for (const w of warns) assert.equal(w.severity, 'warn');
});

test('buildManifest: invalid snapshotId -> error, manifest null', () => {
  const { manifest, diagnostics } = buildManifest({
    snapshotId: '../escape', targetClaudeDir: TARGET, files: [],
  });
  assert.equal(manifest, null);
  assert.equal(diagnostics.filter((d) => d.code === 'manifest-snapshot-id-invalid').length, 1);
});

test('buildManifest: empty targetClaudeDir -> error, manifest null', () => {
  const { manifest, diagnostics } = buildManifest({
    snapshotId: FIXED_ID, targetClaudeDir: '', files: [],
  });
  assert.equal(manifest, null);
  assert.equal(diagnostics.filter((d) => d.code === 'manifest-target-invalid').length, 1);
});

test('buildManifest: files not an array -> error, manifest null', () => {
  const { manifest, diagnostics } = buildManifest({
    snapshotId: FIXED_ID, targetClaudeDir: TARGET, files: 'nope',
  });
  assert.equal(manifest, null);
  assert.equal(diagnostics.filter((d) => d.code === 'manifest-files-invalid').length, 1);
});

// ── write -> read -> verify round-trip (golden) ───────────────────────────────

test('round-trip: build -> write -> read deep-equals, verify ok, bytes byte-stable', () => {
  const { dir, cleanup } = makeTmpDir();
  try {
    const m = builtManifest();
    const w = writeManifest({ stateDir: dir, snapshotId: FIXED_ID, manifest: m, assertWritable: PASS_GATE });
    assert.equal(w.written, true);
    assert.equal(w.diagnostics.length, 0);
    assert.ok(existsSync(manifestPath(dir, FIXED_ID)), 'manifest.json on disk');

    const r = readManifest({ stateDir: dir, snapshotId: FIXED_ID });
    assert.equal(r.diagnostics.length, 0);
    assert.deepEqual(r.manifest, m, 'readback deep-equals the built manifest');

    const v = verifyManifest(r.manifest, { expectedTarget: TARGET });
    assert.equal(v.ok, true);
    assert.equal(v.diagnostics.length, 0);

    // Byte-stable: re-serialize by re-running write into a 2nd dir, compare files.
    const { dir: dir2, cleanup: c2 } = makeTmpDir();
    try {
      writeManifest({ stateDir: dir2, snapshotId: FIXED_ID, manifest: builtManifest(), assertWritable: PASS_GATE });
      assert.equal(
        readFileSync(manifestPath(dir, FIXED_ID), 'utf8'),
        readFileSync(manifestPath(dir2, FIXED_ID), 'utf8'),
        'two builds with same inputs serialize byte-identically',
      );
    } finally { c2(); }
  } finally { cleanup(); }
});

test('round-trip: file is written under snapshots/<id>/manifest.json', () => {
  const { dir, cleanup } = makeTmpDir();
  try {
    writeManifest({ stateDir: dir, snapshotId: FIXED_ID, manifest: builtManifest(), assertWritable: PASS_GATE });
    const expected = join(dir, 'snapshots', FIXED_ID, 'manifest.json');
    assert.equal(manifestPath(dir, FIXED_ID), expected);
    assert.ok(existsSync(expected));
  } finally { cleanup(); }
});

// ── writeManifest: fail-safe gate + path-traversal guard ──────────────────────

test('writeManifest: missing assertWritable -> written:false, NOTHING written (fail-safe)', () => {
  const { dir, cleanup } = makeTmpDir();
  try {
    const w = writeManifest({ stateDir: dir, snapshotId: FIXED_ID, manifest: builtManifest() });
    assert.equal(w.written, false);
    const errs = w.diagnostics.filter((d) => d.code === 'manifest-write-error');
    assert.equal(errs.length, 1);
    assert.ok(/assertWritable/.test(errs[0].message));
    assert.equal(existsSync(snapshotDir(dir, FIXED_ID)), false, 'no snapshot dir created');
  } finally { cleanup(); }
});

test('writeManifest: assertWritable rejection -> written:false, error names the gate, nothing written', () => {
  const { dir, cleanup } = makeTmpDir();
  try {
    const w = writeManifest({
      stateDir: dir, snapshotId: FIXED_ID, manifest: builtManifest(),
      assertWritable: () => { throw new Error('write-outside-target'); },
    });
    assert.equal(w.written, false);
    const errs = w.diagnostics.filter((d) => d.code === 'manifest-write-error');
    assert.equal(errs.length, 1);
    assert.ok(/write gate denied/.test(errs[0].message));
    assert.equal(existsSync(snapshotDir(dir, FIXED_ID)), false);
  } finally { cleanup(); }
});

test('writeManifest: invalid snapshotId -> written:false (path-traversal guard), nothing written', () => {
  const { dir, cleanup } = makeTmpDir();
  try {
    const w = writeManifest({
      stateDir: dir, snapshotId: '../../evil', manifest: builtManifest(), assertWritable: PASS_GATE,
    });
    assert.equal(w.written, false);
    assert.equal(w.diagnostics.filter((d) => d.code === 'manifest-snapshot-id-invalid').length, 1);
  } finally { cleanup(); }
});

test('writeManifest: verify-after-write mismatch -> manifest-write-verify-failed', () => {
  const { dir, cleanup } = makeTmpDir();
  try {
    // read seam returns bytes that differ from what was written
    const w = writeManifest({
      stateDir: dir, snapshotId: FIXED_ID, manifest: builtManifest(), assertWritable: PASS_GATE,
      seams: { read: () => 'tampered-bytes' },
    });
    assert.equal(w.written, false);
    assert.equal(w.diagnostics.filter((d) => d.code === 'manifest-write-verify-failed').length, 1);
  } finally { cleanup(); }
});

test('writeManifest: non-object manifest -> written:false, error', () => {
  const { dir, cleanup } = makeTmpDir();
  try {
    const w = writeManifest({ stateDir: dir, snapshotId: FIXED_ID, manifest: null, assertWritable: PASS_GATE });
    assert.equal(w.written, false);
    assert.equal(w.diagnostics.filter((d) => d.code === 'manifest-write-error').length, 1);
  } finally { cleanup(); }
});

// ── readManifest ──────────────────────────────────────────────────────────────

test('readManifest: missing manifest -> manifest-not-found error, null', () => {
  const { dir, cleanup } = makeTmpDir();
  try {
    const r = readManifest({ stateDir: dir, snapshotId: FIXED_ID });
    assert.equal(r.manifest, null);
    assert.equal(r.diagnostics.filter((d) => d.code === 'manifest-not-found').length, 1);
  } finally { cleanup(); }
});

test('readManifest: empty stateDir -> manifest-read-error, null', () => {
  const r = readManifest({ stateDir: '', snapshotId: FIXED_ID });
  assert.equal(r.manifest, null);
  assert.equal(r.diagnostics.filter((d) => d.code === 'manifest-read-error').length, 1);
});

test('readManifest: corrupt JSON -> manifest-unreadable error, null', () => {
  const { dir, cleanup } = makeTmpDir();
  try {
    const file = manifestPath(dir, FIXED_ID);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '{ not json');
    const r = readManifest({ stateDir: dir, snapshotId: FIXED_ID });
    assert.equal(r.manifest, null);
    assert.equal(r.diagnostics.filter((d) => d.code === 'manifest-unreadable').length, 1);
  } finally { cleanup(); }
});

test('readManifest: non-object JSON (array) -> manifest-unreadable error', () => {
  const { dir, cleanup } = makeTmpDir();
  try {
    const file = manifestPath(dir, FIXED_ID);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '[1,2,3]');
    const r = readManifest({ stateDir: dir, snapshotId: FIXED_ID });
    assert.equal(r.manifest, null);
    assert.equal(r.diagnostics.filter((d) => d.code === 'manifest-unreadable').length, 1);
  } finally { cleanup(); }
});

test('readManifest: __proto__ key in file is stripped (no prototype pollution)', () => {
  const { dir, cleanup } = makeTmpDir();
  try {
    const file = manifestPath(dir, FIXED_ID);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '{"__proto__":{"polluted":true},"manifestVersion":1,"snapshotId":"x"}');
    const r = readManifest({ stateDir: dir, snapshotId: FIXED_ID });
    assert.ok(r.manifest);
    assert.equal(Object.prototype.hasOwnProperty.call(r.manifest, '__proto__'), false);
    assert.equal(({}).polluted, undefined, 'Object.prototype not polluted');
  } finally { cleanup(); }
});

// ── verifyManifest ────────────────────────────────────────────────────────────

test('verifyManifest: a freshly-built manifest verifies clean', () => {
  const v = verifyManifest(builtManifest());
  assert.equal(v.ok, true);
  assert.equal(v.diagnostics.length, 0);
});

test('verifyManifest: FUTURE manifestVersion is refused', () => {
  const m = { ...builtManifest(), manifestVersion: MANIFEST_VERSION + 1 };
  const v = verifyManifest(m);
  assert.equal(v.ok, false);
  assert.equal(v.diagnostics.filter((d) => d.code === 'manifest-version-unsupported').length, 1);
});

test('verifyManifest: missing/non-number manifestVersion -> version-invalid', () => {
  const m = { ...builtManifest() };
  delete m.manifestVersion;
  const v = verifyManifest(m);
  assert.equal(v.ok, false);
  assert.equal(v.diagnostics.filter((d) => d.code === 'manifest-version-invalid').length, 1);
});

test('verifyManifest: zero/negative/float manifestVersion -> version-invalid (positive int only)', () => {
  for (const bad of [0, -1, 0.5, 1.5, NaN, Infinity]) {
    const v = verifyManifest({ ...builtManifest(), manifestVersion: bad });
    assert.equal(v.ok, false, `manifestVersion ${bad} must be rejected`);
    assert.equal(v.diagnostics.filter((d) => d.code === 'manifest-version-invalid').length, 1);
  }
});

test('verifyManifest: zero/negative/float planVersion -> plan-version-invalid', () => {
  for (const bad of [0, -2, 1.5]) {
    const v = verifyManifest({ ...builtManifest(), planVersion: bad });
    assert.equal(v.ok, false, `planVersion ${bad} must be rejected`);
    assert.equal(v.diagnostics.filter((d) => d.code === 'manifest-plan-version-invalid').length, 1);
  }
});

test('verifyManifest: missing createdAt -> created-at-invalid', () => {
  const m = { ...builtManifest() };
  delete m.createdAt;
  const v = verifyManifest(m);
  assert.equal(v.ok, false);
  assert.equal(v.diagnostics.filter((d) => d.code === 'manifest-created-at-invalid').length, 1);
});

test('verifyManifest: non-string reason -> reason-invalid', () => {
  const v = verifyManifest({ ...builtManifest(), reason: 42 });
  assert.equal(v.ok, false);
  assert.equal(v.diagnostics.filter((d) => d.code === 'manifest-reason-invalid').length, 1);
});

test('verifyManifest: cross-target is refused', () => {
  const v = verifyManifest(builtManifest(), { expectedTarget: '/some/other/.claude' });
  assert.equal(v.ok, false);
  assert.equal(v.diagnostics.filter((d) => d.code === 'manifest-target-mismatch').length, 1);
});

test('verifyManifest: matching expectedTarget passes', () => {
  const v = verifyManifest(builtManifest(), { expectedTarget: TARGET });
  assert.equal(v.ok, true);
});

test('verifyManifest: bad file entry (missing currentSha256) -> file-entry-invalid', () => {
  const m = { ...builtManifest(), files: [{ path: 'x', preSha256: 'h' }] };
  const v = verifyManifest(m);
  assert.equal(v.ok, false);
  assert.equal(v.diagnostics.filter((d) => d.code === 'manifest-file-entry-invalid').length, 1);
});

test('verifyManifest: files not an array -> files-invalid', () => {
  const m = { ...builtManifest(), files: 'nope' };
  const v = verifyManifest(m);
  assert.equal(v.ok, false);
  assert.equal(v.diagnostics.filter((d) => d.code === 'manifest-files-invalid').length, 1);
});

// ── never-throws robustness ───────────────────────────────────────────────────

test('buildManifest: null/undefined opts -> never throws, manifest null', () => {
  assert.doesNotThrow(() => {
    assert.equal(buildManifest(null).manifest, null);
    assert.equal(buildManifest(undefined).manifest, null);
  });
});

test('writeManifest: null opts -> never throws, written:false', () => {
  assert.doesNotThrow(() => assert.equal(writeManifest(null).written, false));
});

test('readManifest: null opts -> never throws, manifest null', () => {
  assert.doesNotThrow(() => assert.equal(readManifest(null).manifest, null));
});

test('verifyManifest: junk inputs -> never throws, ok:false', () => {
  assert.doesNotThrow(() => {
    for (const junk of [null, undefined, 42, 'string', [], true]) {
      assert.equal(verifyManifest(junk).ok, false);
    }
  });
});

// ── diagnostic code coverage ──────────────────────────────────────────────────

test('all manifest diagnostic codes are distinct kebab strings prefixed manifest-', () => {
  const KNOWN_CODES = [
    'manifest-snapshot-id-invalid',
    'manifest-target-invalid',
    'manifest-files-invalid',
    'manifest-file-skipped',
    'manifest-write-error',
    'manifest-write-verify-failed',
    'manifest-not-found',
    'manifest-unreadable',
    'manifest-read-error',
    'manifest-invalid',
    'manifest-version-invalid',
    'manifest-version-unsupported',
    'manifest-plan-version-invalid',
    'manifest-created-at-invalid',
    'manifest-reason-invalid',
    'manifest-target-mismatch',
    'manifest-file-entry-invalid',
  ];
  assert.equal(new Set(KNOWN_CODES).size, KNOWN_CODES.length, 'codes must be distinct');
  for (const code of KNOWN_CODES) {
    assert.ok(code.startsWith('manifest-'), `${code} must start with manifest-`);
  }
});
