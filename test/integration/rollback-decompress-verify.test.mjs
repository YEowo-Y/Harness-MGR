/**
 * P3.U16 — integration/rollback-decompress-verify.test.mjs
 *
 * The HEADLINE DoD for the rollback decompress+verify unit: a FULL end-to-end run
 * of verifyRollbackArchive against a REAL snapshot produced by the REAL createSnapshot
 * + the REAL system tar (no injected tar/extract seams), proving the unit correctly
 * (a) PASSES a sound archive, (b) FAILS a corrupted one without throwing, AND
 * (c) NEVER writes the live tree + leaves NO temp residue.
 *
 * Golden oracle (all must hold):
 *   (a) GOOD archive: verifyRollbackArchive → ok:true, verified:true,
 *       verifiedCount === fileCount.
 *   (b) CORRUPT archive: overwrite files.tar with garbage → ok:true (it RAN) but
 *       verified:false (extract fails OR hashes mismatch) — and it does NOT throw.
 *   (c) NO live-tree write: a {relpath → sha256} map of the temp claudeDir is
 *       deepEqual before/after; AND NO 'cmgr-rollback-verify-*' dir created by this
 *       test remains under os.tmpdir() (the finally cleanup removed it).
 *
 * GRACEFUL-SKIP when the system tar is unavailable (mirrors the other
 * test/integration/ probes). assertWritable is injected as a passthrough for the
 * snapshot CREATION only (the real gate is exercised by selftest --boundary);
 * verifyRollbackArchive itself takes NO write gate.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { createSnapshot } from '../../src/ops/snapshot.mjs';
import { resolveTar } from '../../src/ops/snapshot-tar.mjs';
import { verifyRollbackArchive } from '../../src/ops/rollback-decompress-verify.mjs';

const PASS_GATE = (p) => p; // passthrough write gate for snapshot creation only

function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/** Write a file at a POSIX-relative path under base, creating parent dirs. */
function put(base, rel, bytes) {
  const abs = join(base, ...rel.split('/'));
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, bytes);
}

/** Recursively map POSIX-relative file paths → sha256 under dir (for no-write proof). */
function hashTree(dir) {
  /** @type {Record<string,string>} */
  const out = {};
  const walk = (d) => {
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      const abs = join(d, ent.name);
      if (ent.isDirectory()) walk(abs);
      else if (ent.isFile()) out[relative(dir, abs).split(sep).join('/')] = sha256Hex(readFileSync(abs));
    }
  };
  walk(dir);
  return out;
}

/** Count the cmgr-rollback-verify-* temp dirs currently under os.tmpdir(). */
function verifyTempDirs() {
  return readdirSync(tmpdir(), { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith('cmgr-rollback-verify-'))
    .map((e) => e.name);
}

const keptFixtures = () => [
  { rel: 'agents/a.md', bytes: Buffer.from('# agent a\nline2\n', 'utf8') },
  { rel: 'skills/s/SKILL.md', bytes: Buffer.from('# 技能 — unicode body café\nx\n', 'utf8') },
  { rel: 'settings.json', bytes: Buffer.from('{\r\n  "model": "opus"\n}\n', 'utf8') },
];

test('integration: verifyRollbackArchive passes a sound archive, fails a corrupt one, writes nothing live', async (t) => {
  const { tarPath, diagnostics } = resolveTar();
  if (!tarPath) {
    t.skip(`system tar not found (${diagnostics.map((d) => d.code).join(',')}) — skipping rollback verify round-trip`);
    return;
  }

  const root = mkdtempSync(join(tmpdir(), 'cmgr-verify-rt-'));
  const claudeDir = join(root, '.claude');
  const stateDir = join(claudeDir, '.mgr-state');
  mkdirSync(claudeDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });

  // Snapshot CREATE writes into .mgr-state, so it is NOT part of the governed live
  // surface; capture the live-tree hash AFTER creation (drops .mgr-state) so the
  // before/after comparison isolates verifyRollbackArchive's writes.
  const liveHashIgnoringState = (base) => {
    const all = hashTree(base);
    /** @type {Record<string,string>} */
    const out = {};
    for (const k of Object.keys(all)) if (!k.startsWith('.mgr-state/')) out[k] = all[k];
    return out;
  };

  // Snapshot existing temp dirs so we only assert about ones THIS test creates.
  const preExistingTemp = new Set(verifyTempDirs());

  try {
    for (const f of keptFixtures()) put(claudeDir, f.rel, f.bytes);

    // Produce a REAL snapshot (archive + manifest) with the REAL tar.
    const snap = await createSnapshot({
      targetClaudeDir: claudeDir, mgrStateDir: stateDir, reason: 'verify-it', assertWritable: PASS_GATE,
    });
    assert.equal(snap.ok, true, `snapshot failed: ${JSON.stringify(snap.diagnostics)}`);
    const snapshotId = snap.snapshotId;

    // Baseline of the live tree (excluding .mgr-state) BEFORE any verify.
    const liveBefore = liveHashIgnoringState(claudeDir);

    // (a) GOOD archive → ok + verified + every file verified.
    const good = await verifyRollbackArchive({ mgrStateDir: stateDir, snapshotId });
    assert.equal(good.ok, true, `good verify should run: ${JSON.stringify(good.diagnostics)}`);
    assert.equal(good.verified, true, `good archive should verify: ${JSON.stringify(good.mismatches)}`);
    assert.equal(good.verifiedCount, good.fileCount);
    assert.equal(good.fileCount, keptFixtures().length);
    assert.deepEqual(good.mismatches, []);
    // Cross-target refusal still works end-to-end.
    const wrong = await verifyRollbackArchive({
      mgrStateDir: stateDir, snapshotId, expectedTarget: join(root, 'OTHER'),
    });
    assert.equal(wrong.ok, false);
    assert.ok(wrong.diagnostics.some((d) => d.code === 'manifest-target-mismatch'));

    // (b) CORRUPT the archive bytes, then verify → ran (ok:true) but NOT verified,
    //     and crucially it does NOT throw. (Either extract fails → verify-extract-
    //     failed/ok:false, OR it extracts to wrong bytes → hash-mismatch; both are an
    //     honest "do not trust this archive". We accept either as long as verified is
    //     false and nothing throws.)
    writeFileSync(snap.archivePath, Buffer.from('THIS IS NOT A TAR ARCHIVE — GARBAGE BYTES\n', 'utf8'));
    const bad = await verifyRollbackArchive({ mgrStateDir: stateDir, snapshotId });
    assert.equal(bad.verified, false, 'a corrupt archive must not verify');
    assert.ok(
      bad.diagnostics.some((d) => d.code === 'verify-extract-failed' || d.code === 'rollback-archive-corrupt'),
      `corrupt archive should report extract-failed or archive-corrupt: ${JSON.stringify(bad.diagnostics)}`);

    // (c) NO live-tree write: the governed tree hash is byte-identical before/after
    //     both the good AND the corrupt verify.
    const liveAfter = liveHashIgnoringState(claudeDir);
    assert.deepEqual(liveAfter, liveBefore, 'verifyRollbackArchive must never write the live tree');

    // (c) NO temp residue: no NEW cmgr-rollback-verify-* dir remains (finally cleaned up).
    const leftover = verifyTempDirs().filter((n) => !preExistingTemp.has(n));
    assert.deepEqual(leftover, [], `verify left temp residue: ${leftover.join(', ')}`);
  } finally {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
    // Defensive: remove any temp dir this test may have leaked (should be none).
    for (const n of verifyTempDirs()) {
      if (!preExistingTemp.has(n)) {
        try { rmSync(join(tmpdir(), n), { recursive: true, force: true }); } catch { /* best-effort */ }
      }
    }
  }
});
