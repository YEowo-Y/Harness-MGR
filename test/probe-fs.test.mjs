/**
 * P2.U6b — probe-fs.test.mjs
 *
 * Tests for gatherFsProbes: real temp-dir I/O covering all five fact categories
 * (#13 claudeMdBackups, #14 snapshots, #20 probeResidue, #21 applyLeftovers,
 * #25 configRulesDoc). All cases must never throw; degrade to diagnostics on
 * missing/bad configDir. Temp dirs are cleaned up in finally blocks.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, writeFileSync, mkdirSync, rmSync, utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gatherFsProbes } from '../src/discovery/probe-fs.mjs';

// ── helpers ──────────────────────────────────────────────────────────────────

function mktmp() {
  return mkdtempSync(join(tmpdir(), 'mgr-fs-'));
}

function touch(path) {
  writeFileSync(path, '', 'utf-8');
}

// ── 1. populated configDir — all fact categories ─────────────────────────────

test('populated configDir: claudeMdBackups count + files are correct', () => {
  const tmp = mktmp();
  try {
    // 4 backup files
    for (let i = 1; i <= 4; i++) {
      touch(join(tmp, `CLAUDE.md.backup.${i}`));
    }
    // unrelated file — must NOT be counted
    touch(join(tmp, 'CLAUDE.md'));

    const { fsFacts, diagnostics } = gatherFsProbes({ configDir: tmp });
    assert.equal(diagnostics.length, 0, 'no diagnostics expected for valid dir');
    assert.equal(fsFacts.claudeMdBackups.count, 4, 'count must be 4');
    assert.equal(fsFacts.claudeMdBackups.files.length, 4, 'files array must have 4 entries');
    // every file must be an absolute path inside configDir
    for (const f of fsFacts.claudeMdBackups.files) {
      assert.ok(f.startsWith(tmp), `file ${f} must start with ${tmp}`);
      assert.match(f, /CLAUDE\.md\.backup\./);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('populated configDir: probeResidue contains top-level and agents/ probe files, not normal files', () => {
  const tmp = mktmp();
  try {
    // top-level probe residue
    touch(join(tmp, '__mgr-probe-top'));
    // agents/ dir with one probe and one normal file
    mkdirSync(join(tmp, 'agents'));
    touch(join(tmp, 'agents', '__mgr-probe-abc'));
    touch(join(tmp, 'agents', 'reviewer.md'));

    const { fsFacts } = gatherFsProbes({ configDir: tmp });
    assert.equal(fsFacts.probeResidue.length, 2, 'must find exactly 2 probe residue entries');
    const paths = fsFacts.probeResidue;
    assert.ok(paths.some((p) => p.includes('__mgr-probe-top')), 'top-level probe missing');
    assert.ok(paths.some((p) => p.includes('__mgr-probe-abc')), 'agents/ probe missing');
    assert.ok(!paths.some((p) => p.includes('reviewer.md')), 'reviewer.md must NOT appear in probeResidue');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('populated configDir: applyLeftovers contains .mgr-new in configDir and .mgr-old in mgrStateDir', () => {
  const tmp = mktmp();
  try {
    // configDir .mgr-new
    touch(join(tmp, 'settings.json.mgr-new'));
    // .mgr-state dir with .mgr-old
    mkdirSync(join(tmp, '.mgr-state'));
    touch(join(tmp, '.mgr-state', 'foo.mgr-old'));
    // a normal file — must NOT appear
    touch(join(tmp, 'settings.json'));

    const { fsFacts } = gatherFsProbes({ configDir: tmp });
    assert.equal(fsFacts.applyLeftovers.length, 2, 'must find exactly 2 apply leftover entries');
    const paths = fsFacts.applyLeftovers;
    assert.ok(paths.some((p) => p.includes('settings.json.mgr-new')), '.mgr-new missing');
    assert.ok(paths.some((p) => p.includes('foo.mgr-old')), '.mgr-old missing');
    assert.ok(!paths.some((p) => p.endsWith('settings.json')), 'plain settings.json must NOT appear');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('populated configDir: snapshots has length 1 with finite positive mtimeMs', () => {
  const tmp = mktmp();
  try {
    const mgrState = join(tmp, '.mgr-state');
    const snapsDir = join(mgrState, 'snapshots');
    mkdirSync(snapsDir, { recursive: true });
    // create a snapshot entry (a file)
    const snapPath = join(snapsDir, 'snap-1');
    touch(snapPath);

    const { fsFacts } = gatherFsProbes({ configDir: tmp });
    assert.equal(fsFacts.snapshots.length, 1, 'must find exactly 1 snapshot');
    const snap = fsFacts.snapshots[0];
    assert.ok(snap.path.includes('snap-1'), 'path must include snap-1');
    assert.ok(Number.isFinite(snap.mtimeMs), 'mtimeMs must be finite');
    assert.ok(snap.mtimeMs > 0, 'mtimeMs must be positive');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── 2. snapshot mtime is actually captured ────────────────────────────────────

test('snapshot mtimeMs reflects actual file mtime (utimesSync pinning)', () => {
  const tmp = mktmp();
  try {
    const mgrState = join(tmp, '.mgr-state');
    const snapsDir = join(mgrState, 'snapshots');
    mkdirSync(snapsDir, { recursive: true });
    const snapPath = join(snapsDir, 'snap-pinned');
    touch(snapPath);
    // Pin mtime to a known epoch (2020-01-01 00:00:00 UTC)
    const knownTime = new Date(1577836800000);
    utimesSync(snapPath, knownTime, knownTime);

    const { fsFacts } = gatherFsProbes({ configDir: tmp });
    assert.equal(fsFacts.snapshots.length, 1);
    // Allow ±1000 ms for filesystem rounding
    const diff = Math.abs(fsFacts.snapshots[0].mtimeMs - 1577836800000);
    assert.ok(diff < 1000, `mtimeMs ${fsFacts.snapshots[0].mtimeMs} deviates more than 1s from pinned time`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── 3. rulesDocPath handling ──────────────────────────────────────────────────

test('rulesDocPath existing file → configRulesDoc with finite mtimeMs', () => {
  const tmp = mktmp();
  try {
    const rulesPath = join(tmp, 'effective-config-rules.md');
    touch(rulesPath);

    const { fsFacts } = gatherFsProbes({ configDir: tmp, rulesDocPath: rulesPath });
    assert.ok(fsFacts.configRulesDoc !== null, 'configRulesDoc must be set');
    assert.equal(fsFacts.configRulesDoc.path, rulesPath);
    assert.ok(Number.isFinite(fsFacts.configRulesDoc.mtimeMs), 'mtimeMs must be finite');
    assert.ok(fsFacts.configRulesDoc.mtimeMs > 0, 'mtimeMs must be positive');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('rulesDocPath omitted → configRulesDoc === null', () => {
  const tmp = mktmp();
  try {
    const { fsFacts } = gatherFsProbes({ configDir: tmp });
    assert.equal(fsFacts.configRulesDoc, null);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('rulesDocPath pointing at non-existent file → configRulesDoc === null', () => {
  const tmp = mktmp();
  try {
    const { fsFacts } = gatherFsProbes({ configDir: tmp, rulesDocPath: join(tmp, 'no-such-file.md') });
    assert.equal(fsFacts.configRulesDoc, null);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── 4. empty configDir — all fact arrays are empty ────────────────────────────

test('empty configDir: all facts empty, no diagnostics, no throw', () => {
  const tmp = mktmp();
  try {
    let result;
    assert.doesNotThrow(() => { result = gatherFsProbes({ configDir: tmp }); });
    const { fsFacts, diagnostics } = result;
    assert.equal(diagnostics.length, 0);
    assert.equal(fsFacts.claudeMdBackups.count, 0);
    assert.deepEqual(fsFacts.claudeMdBackups.files, []);
    assert.deepEqual(fsFacts.snapshots, []);
    assert.deepEqual(fsFacts.probeResidue, []);
    assert.deepEqual(fsFacts.applyLeftovers, []);
    assert.equal(fsFacts.configRulesDoc, null);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── 5. missing subdirs are benign ─────────────────────────────────────────────

test('missing agents/ and .mgr-state/snapshots/ are silently treated as empty', () => {
  const tmp = mktmp();
  try {
    // Only create configDir — no agents/, no .mgr-state/
    const { fsFacts, diagnostics } = gatherFsProbes({ configDir: tmp });
    assert.equal(diagnostics.length, 0);
    assert.deepEqual(fsFacts.probeResidue, []);
    assert.deepEqual(fsFacts.snapshots, []);
    assert.deepEqual(fsFacts.applyLeftovers, []);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── 6. custom mgrStateDir ─────────────────────────────────────────────────────

test('explicit mgrStateDir overrides the default join(configDir, .mgr-state)', () => {
  const tmp = mktmp();
  const customState = mktmp();
  try {
    mkdirSync(join(customState, 'snapshots'));
    touch(join(customState, 'snapshots', 'custom-snap'));
    touch(join(customState, 'staged.mgr-old'));

    const { fsFacts } = gatherFsProbes({ configDir: tmp, mgrStateDir: customState });
    assert.equal(fsFacts.snapshots.length, 1, 'snapshot in custom state dir must be found');
    assert.ok(fsFacts.snapshots[0].path.includes('custom-snap'));
    assert.equal(fsFacts.applyLeftovers.length, 1, '.mgr-old in custom state dir must be found');
    assert.ok(fsFacts.applyLeftovers[0].includes('staged.mgr-old'));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(customState, { recursive: true, force: true });
  }
});

// ── 7. bad configDir → discover-bad-root + all-empty facts ───────────────────

test('gatherFsProbes({}) → discover-bad-root error, all-empty facts, no throw', () => {
  let result;
  assert.doesNotThrow(() => { result = gatherFsProbes({}); });
  const { fsFacts, diagnostics } = result;
  const err = diagnostics.find((d) => d.code === 'discover-bad-root');
  assert.ok(err, 'expected discover-bad-root diagnostic');
  assert.equal(err.severity, 'error');
  assert.equal(fsFacts.claudeMdBackups.count, 0);
  assert.deepEqual(fsFacts.claudeMdBackups.files, []);
  assert.deepEqual(fsFacts.snapshots, []);
  assert.deepEqual(fsFacts.probeResidue, []);
  assert.deepEqual(fsFacts.applyLeftovers, []);
  assert.equal(fsFacts.configRulesDoc, null);
});

test('gatherFsProbes({ configDir: "" }) → discover-bad-root error, no throw', () => {
  let result;
  assert.doesNotThrow(() => { result = gatherFsProbes({ configDir: '' }); });
  const err = result.diagnostics.find((d) => d.code === 'discover-bad-root');
  assert.ok(err, 'expected discover-bad-root diagnostic');
  assert.equal(err.severity, 'error');
});

test('gatherFsProbes(null/undefined/42/string) → discover-bad-root, no throw', () => {
  for (const junk of [null, undefined, 42, 'x']) {
    assert.doesNotThrow(
      () => {
        const { diagnostics } = gatherFsProbes(/** @type {any} */ (junk));
        const err = diagnostics.find((d) => d.code === 'discover-bad-root');
        assert.ok(err, `expected discover-bad-root for junk=${JSON.stringify(junk)}`);
      },
      `gatherFsProbes(${JSON.stringify(junk)}) must not throw`,
    );
  }
});

test('exactly one discover-bad-root diagnostic emitted for bad configDir', () => {
  const { diagnostics } = gatherFsProbes({ configDir: '' });
  const errs = diagnostics.filter((d) => d.code === 'discover-bad-root');
  assert.equal(errs.length, 1, 'must emit exactly 1 discover-bad-root');
});
