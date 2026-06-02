/**
 * Falsifiable oracle for the spawn-write boundary check wired into the snapshot
 * create path (src/ops/snapshot.mjs step 8b). The syscall write-gate cannot see a
 * spawned process's writes, so after the `tar` spawn createSnapshot snapshots the
 * dir and calls checkSpawnWriteBoundary — any file tar wrote OTHER than the declared
 * files.tar must abort the snapshot.
 *
 * PRE-WIRING this FAILS: without the boundary check, a tar that also wrote a stray
 * file would still return ok:true. POST-WIRING: ok:false + spawn-write-outside-expected
 * + snapshot-tar-wrote-undeclared. The well-behaved-tar case proves no false positive.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createSnapshot } from '../src/ops/snapshot.mjs';

/** A real temp target (with one allowlisted file to archive) + a real .mgr-state. */
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'mgr-spawnbound-'));
  const target = join(root, 'claude');
  const state = join(root, '.mgr-state');
  mkdirSync(join(target, 'agents'), { recursive: true });
  writeFileSync(join(target, 'agents', 'a.md'), 'agent body');
  mkdirSync(state, { recursive: true });
  return { root, target, state, cleanup() { try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } } };
}

/** createSnapshot opts with a pass-through gate + a fake tar driven by `spawnFn`. */
const baseOpts = (target, state, spawnFn) => ({
  targetClaudeDir: target,
  mgrStateDir: state,
  reason: 'test',
  assertWritable: (p) => p, // pass-through gate (not under test here)
  now: () => new Date('2026-01-02T03:04:05Z'),
  seams: {
    resolveFn: () => ({ tarPath: '/fake/tar', diagnostics: [] }),
    spawnFn,
    // real readFileFn / mkdirFn / unlinkFn / rmdirFn via defaults
  },
});

/** Extract the archive path (token after `-f`) from a tar spawn spec. */
const archiveOf = (spec) => spec.args[spec.args.indexOf('-f') + 1];

test('snapshot REFUSES when the tar spawn writes an undeclared file into the snapshot dir', async () => {
  const { target, state, cleanup } = setup();
  try {
    // A misbehaving tar: writes the declared archive AND a stray, undeclared file.
    const spawnFn = async (spec) => {
      const archivePath = archiveOf(spec);
      writeFileSync(archivePath, 'TAR-ARCHIVE-BYTES');
      writeFileSync(join(dirname(archivePath), 'sneaky.txt'), 'undeclared stray');
      return { stdout: '', stderr: '' };
    };
    const res = await createSnapshot(baseOpts(target, state, spawnFn));
    assert.equal(res.ok, false, 'snapshot must refuse on an undeclared spawned write');
    const codes = res.diagnostics.map((d) => d.code);
    assert.ok(codes.includes('spawn-write-outside-expected'), 'boundary check flagged the stray file');
    assert.ok(codes.includes('snapshot-tar-wrote-undeclared'), 'snapshot failed with the boundary refusal');
  } finally {
    cleanup();
  }
});

test('snapshot SUCCEEDS when the tar spawn writes only the declared archive (no false positive)', async () => {
  const { target, state, cleanup } = setup();
  try {
    const spawnFn = async (spec) => {
      writeFileSync(archiveOf(spec), 'TAR-ARCHIVE-BYTES');
      return { stdout: '', stderr: '' };
    };
    const res = await createSnapshot(baseOpts(target, state, spawnFn));
    assert.equal(res.ok, true, 'a well-behaved tar must not trip the boundary check');
    const codes = res.diagnostics.map((d) => d.code);
    assert.ok(!codes.includes('spawn-write-outside-expected'), 'no boundary false positive');
    assert.ok(!codes.includes('snapshot-tar-wrote-undeclared'), 'no boundary refusal on a clean tar');
  } finally {
    cleanup();
  }
});
