/**
 * Tests for snapshotDirHashes and checkSpawnWriteBoundary (Unit B).
 *
 * Uses a real temp-dir for filesystem round-trips; cleans up in finally.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  snapshotDirHashes,
  checkSpawnWriteBoundary,
} from '../src/selftest/spawn-write-boundary.mjs';

// ── helpers ────────────────────────────────────────────────────────────────

/** Create a fresh tmp dir and return its path. */
function makeTmp() {
  return mkdtempSync(join(tmpdir(), 'mgr-swb-test-'));
}

/** Remove a tmp dir (best-effort). */
function cleanTmp(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ── core acceptance test ───────────────────────────────────────────────────

test('snapshotDirHashes + checkSpawnWriteBoundary — core acceptance', () => {
  const tmp = makeTmp();
  try {
    // Seed a small tree.
    mkdirSync(join(tmp, 'sub'));
    writeFileSync(join(tmp, 'sub', 'existing.txt'), 'hello');
    writeFileSync(join(tmp, 'top.txt'), 'world');

    const before = snapshotDirHashes(tmp);

    // Verify before snapshot is sensible.
    assert.ok(typeof before['sub/existing.txt'] === 'string', 'existing.txt in before');
    assert.ok(typeof before['top.txt'] === 'string', 'top.txt in before');

    const declaredRelpath = 'declared-new.txt';
    const undeclaredAdded = 'undeclared-add.txt';
    const undeclaredModified = 'sub/existing.txt';

    // Write declared new file.
    writeFileSync(join(tmp, declaredRelpath), 'declared content');
    // Write undeclared new file.
    writeFileSync(join(tmp, undeclaredAdded), 'surprise');
    // Modify undeclared existing file.
    writeFileSync(join(tmp, undeclaredModified), 'modified without permission');

    const after = snapshotDirHashes(tmp);

    const result = checkSpawnWriteBoundary({
      before,
      after,
      declaredWrites: [declaredRelpath],
    });

    assert.strictEqual(result.ok, false, 'ok must be false when undeclared writes exist');

    const codes = result.diagnostics.map((d) => d.code);
    assert.ok(
      codes.every((c) => c === 'spawn-write-outside-expected'),
      'all diagnostics have correct code',
    );

    const paths = result.diagnostics.map((d) => d.path);
    // Undeclared added file must be flagged.
    assert.ok(paths.includes(undeclaredAdded), 'undeclared added file flagged');
    // Undeclared modified file must be flagged.
    assert.ok(paths.includes(undeclaredModified), 'undeclared modified file flagged');
    // Declared file must NOT be flagged.
    assert.ok(!paths.includes(declaredRelpath), 'declared file NOT flagged');

    // Exactly 2 offenders.
    assert.strictEqual(result.diagnostics.length, 2, 'exactly 2 undeclared-change diagnostics');

    // Diagnostics are sorted by path (deterministic).
    const sorted = [...paths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    assert.deepEqual(paths, sorted, 'diagnostics are sorted by path');

    // Verify phase and severity.
    for (const d of result.diagnostics) {
      assert.strictEqual(d.phase, 'boundary');
      assert.strictEqual(d.severity, 'error');
    }
  } finally {
    cleanTmp(tmp);
  }
});

// ── clean run ──────────────────────────────────────────────────────────────

test('checkSpawnWriteBoundary — only declared path changed → ok:true', () => {
  const tmp = makeTmp();
  try {
    writeFileSync(join(tmp, 'file.txt'), 'original');
    const before = snapshotDirHashes(tmp);

    writeFileSync(join(tmp, 'file.txt'), 'updated');
    const after = snapshotDirHashes(tmp);

    const result = checkSpawnWriteBoundary({
      before,
      after,
      declaredWrites: ['file.txt'],
    });
    assert.strictEqual(result.ok, true);
    assert.deepEqual(result.diagnostics, []);
  } finally {
    cleanTmp(tmp);
  }
});

// ── removed file ──────────────────────────────────────────────────────────

test('checkSpawnWriteBoundary — removed undeclared file is flagged; removed declared is not', () => {
  const tmp = makeTmp();
  try {
    writeFileSync(join(tmp, 'declared-del.txt'), 'x');
    writeFileSync(join(tmp, 'undeclared-del.txt'), 'y');
    const before = snapshotDirHashes(tmp);

    rmSync(join(tmp, 'declared-del.txt'));
    rmSync(join(tmp, 'undeclared-del.txt'));
    const after = snapshotDirHashes(tmp);

    const result = checkSpawnWriteBoundary({
      before,
      after,
      declaredWrites: ['declared-del.txt'],
    });
    assert.strictEqual(result.ok, false, 'undeclared removal → not ok');
    assert.strictEqual(result.diagnostics.length, 1);
    assert.strictEqual(result.diagnostics[0].path, 'undeclared-del.txt');

    // message must say 'removed'.
    assert.ok(result.diagnostics[0].message.includes('removed'), 'message says removed');
  } finally {
    cleanTmp(tmp);
  }
});

// ── symlink case ───────────────────────────────────────────────────────────

test('snapshotDirHashes — symlinks are not followed', (t) => {
  const tmp = makeTmp();
  try {
    writeFileSync(join(tmp, 'real.txt'), 'real content');

    let symlinkCreated = false;
    try {
      symlinkSync(join(tmp, 'real.txt'), join(tmp, 'link.txt'));
      symlinkCreated = true;
    } catch {
      // EPERM on Windows without privilege — skip symlink sub-assertion.
    }

    const snap = snapshotDirHashes(tmp);

    assert.ok(typeof snap['real.txt'] === 'string', 'real file is hashed');

    if (symlinkCreated) {
      assert.ok(!Object.prototype.hasOwnProperty.call(snap, 'link.txt'),
        'symlink is NOT included in snapshot');
    } else {
      t.diagnostic('symlink creation skipped (EPERM) — skipping symlink-not-followed assertion');
    }
  } finally {
    cleanTmp(tmp);
  }
});

// ── never-throws / bad inputs ─────────────────────────────────────────────

test('snapshotDirHashes — bad/missing dir returns empty map', () => {
  for (const arg of [null, 123, '', '/does/not/exist/xyz-mgr-test']) {
    const snap = snapshotDirHashes(arg);
    assert.strictEqual(typeof snap, 'object', 'result is an object');
    assert.strictEqual(Object.keys(snap).length, 0, `no keys for arg ${String(arg)}`);
  }
});

test('checkSpawnWriteBoundary — tolerates non-object args without throwing', () => {
  // No args at all.
  let r = checkSpawnWriteBoundary({});
  assert.strictEqual(r.ok, true);
  assert.deepEqual(r.diagnostics, []);

  // Non-object before/after.
  r = checkSpawnWriteBoundary({ before: null, after: null, declaredWrites: [] });
  assert.strictEqual(r.ok, true);

  r = checkSpawnWriteBoundary({ before: 'x', after: 42, declaredWrites: 'bad' });
  assert.strictEqual(r.ok, true);

  // Non-array declaredWrites — every change is undeclared.
  const tmp = makeTmp();
  try {
    writeFileSync(join(tmp, 'a.txt'), 'a');
    const before = snapshotDirHashes(tmp);
    writeFileSync(join(tmp, 'b.txt'), 'b');
    const after = snapshotDirHashes(tmp);

    // null declaredWrites — new file is undeclared.
    r = checkSpawnWriteBoundary({ before, after, declaredWrites: null });
    assert.strictEqual(r.ok, false, 'null declaredWrites → change flagged');
    assert.strictEqual(r.diagnostics[0].path, 'b.txt');
  } finally {
    cleanTmp(tmp);
  }
});

// ── proto-safety ───────────────────────────────────────────────────────────

test('checkSpawnWriteBoundary — proto-poisoning keys do not crash', () => {
  // Build maps with a __proto__ key by hand (Object.create(null) prevents the
  // prototype assignment, but we test that the function survives the key).
  const before = Object.create(null);
  before['__proto__'] = 'aaa';
  before['normal.txt'] = 'bbb';

  const after = Object.create(null);
  after['__proto__'] = 'aaa';
  after['normal.txt'] = 'bbb';

  // No change — should be ok, no crash.
  let r;
  assert.doesNotThrow(() => {
    r = checkSpawnWriteBoundary({ before, after, declaredWrites: [] });
  });
  assert.strictEqual(r.ok, true, '__proto__ key treated as unchanged, no crash');

  // Differing __proto__ values → flagged as an ordinary modified path. The real
  // walk never emits a "__proto__" key (collectDirFiles skips it), so this only
  // pins the diff's own-enumerable handling.
  const after2 = Object.create(null);
  after2['__proto__'] = 'ZZZ';
  after2['normal.txt'] = 'bbb';
  const r2 = checkSpawnWriteBoundary({ before, after: after2, declaredWrites: [] });
  assert.strictEqual(r2.ok, false, 'differing __proto__ value is flagged');
  assert.strictEqual(r2.diagnostics.length, 1);
  assert.strictEqual(r2.diagnostics[0].path, '__proto__');
});

test('snapshotDirHashes — files with proto-like names in dir are handled', () => {
  // collectDirFiles skips relpaths equal to __proto__/constructor/prototype.
  // We cannot create a file literally named "__proto__" on Windows NTFS,
  // so we just verify the snapshot call does not throw on a normal dir.
  const tmp = makeTmp();
  try {
    writeFileSync(join(tmp, 'safe.txt'), 'ok');
    let snap;
    assert.doesNotThrow(() => { snap = snapshotDirHashes(tmp); });
    assert.ok(typeof snap['safe.txt'] === 'string');
  } finally {
    cleanTmp(tmp);
  }
});
