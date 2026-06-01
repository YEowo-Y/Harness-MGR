/**
 * P3.U18 — integration/recover-from-manifest.test.mjs
 *
 * The HEADLINE DoD oracle: a FULL end-to-end recovery against a REAL temp
 * `~/.claude`-like tree, the REAL governed-write gate (src/paths.mjs::assertWritable
 * via CLAUDE_CONFIG_DIR), and the REAL system tar (no injected seams). Two oracles:
 *
 *   1. CORRUPTED-JOURNAL RECOVERY (the plan's named criterion): a snapshot exists
 *      (manifest + files.tar) but apply-journal.json is GARBAGE. `recover
 *      --from-manifest --apply --force` restores the snapshot onto a mutated live
 *      tree using the MANIFEST alone — it never depends on the unreadable journal.
 *
 *   2. CRASH-WINDOW RESTORE (atomic-write.mjs's mandated first-class case): an apply
 *      crashed at 'applying' with the target file ABSENT. `recover --rollback
 *      --apply --force` restores the file from the snapshot's ORIGINAL bytes even
 *      though the live target no longer exists, then marks the journal 'rolled-back'.
 *
 * GRACEFUL-SKIP when system tar is unavailable (mirrors claude-md-rollback.test.mjs).
 * Uses the REAL gate (CLAUDE_CONFIG_DIR → temp), restored in a finally.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSnapshot } from '../../src/ops/snapshot.mjs';
import { recover } from '../../src/ops/recover.mjs';
import { resolveTar } from '../../src/ops/snapshot-tar.mjs';
import { createJournal, transition, writeJournal, readJournal } from '../../src/ops/apply-journal-writer.mjs';
import { assertWritable } from '../../src/paths.mjs';

/** Write a file at a POSIX-relative path under base, creating parent dirs. */
function put(base, rel, bytes) {
  const abs = join(base, ...rel.split('/'));
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, bytes);
}

/** Recursively collect every absolute file path under dir (for residue scan). */
function allFilePaths(dir) {
  /** @type {string[]} */
  const out = [];
  const walk = (d) => {
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      const abs = join(d, ent.name);
      if (ent.isDirectory()) walk(abs);
      else out.push(abs);
    }
  };
  walk(dir);
  return out;
}

/** Build the live tree + snapshot it (real tar, real gate). Returns the snapshot. */
async function seedSnapshot(tmp, stateDir, files) {
  for (const [rel, bytes] of files) put(tmp, rel, bytes);
  const snap = await createSnapshot({
    targetClaudeDir: tmp, mgrStateDir: stateDir, reason: 'recover-test',
    includeAuth: false, assertWritable, now: () => new Date(), dryRun: false,
  });
  return snap;
}

test('recover --from-manifest recovers a mutated tree despite a CORRUPT journal', async (t) => {
  const { tarPath, diagnostics } = resolveTar();
  if (!tarPath) {
    t.skip(`system tar not found (${diagnostics.map((d) => d.code).join(',')}) — skipping`);
    return;
  }

  const saved = process.env.CLAUDE_CONFIG_DIR;
  const tmp = mkdtempSync(join(tmpdir(), 'cmgr-recover-fm-'));
  process.env.CLAUDE_CONFIG_DIR = tmp;
  const stateDir = join(tmp, '.mgr-state');
  mkdirSync(stateDir, { recursive: true });

  const claudeV1 = Buffer.from('# CLAUDE v1\nrule one\n', 'utf8');
  const settingsV1 = Buffer.from('{\n  "model": "sonnet"\n}\n', 'utf8');

  try {
    const snap = await seedSnapshot(tmp, stateDir, [
      ['CLAUDE.md', claudeV1],
      ['settings.json', settingsV1],
    ]);
    if (!snap.ok && snap.diagnostics.some((d) => /tar/.test(d.code))) {
      t.skip(`snapshot could not run (tar issue): ${snap.diagnostics.map((d) => d.code).join(',')}`);
      return;
    }
    assert.equal(snap.ok, true, `snapshot failed: ${JSON.stringify(snap.diagnostics)}`);
    const snapshotId = snap.snapshotId;

    // CORRUPT the journal: write garbage where apply-journal.json would live. The
    // manifest + files.tar are intact, so from-manifest must still recover.
    const snapDir = join(stateDir, 'snapshots', snapshotId);
    writeFileSync(join(snapDir, 'apply-journal.json'), Buffer.from('{ this is not valid json ::::', 'utf8'));

    // MUTATE the live tree → drift (recovering this drift needs --force).
    const claudeV2 = Buffer.from('# CLAUDE v2 BROKEN\n', 'utf8');
    writeFileSync(join(tmp, 'CLAUDE.md'), claudeV2);
    writeFileSync(join(tmp, 'settings.json'), Buffer.from('{ "model": "haiku-WRONG" }\n', 'utf8'));

    // DRY-RUN first: must write NOTHING + report it would restore.
    const dry = await recover({
      mode: 'from-manifest', snapshotId, mgrStateDir: stateDir, targetClaudeDir: tmp,
      assertWritable, force: true, expectedTarget: tmp, // enableWrites omitted → dry-run
    });
    assert.equal(dry.dryRun, true, `dry-run expected: ${JSON.stringify(dry.diagnostics)}`);
    assert.ok(Buffer.compare(readFileSync(join(tmp, 'CLAUDE.md')), claudeV2) === 0,
      'dry-run must NOT modify the live tree');

    // --apply --force: restore from the manifest, despite the corrupt journal.
    const res = await recover({
      mode: 'from-manifest', snapshotId, mgrStateDir: stateDir, targetClaudeDir: tmp,
      assertWritable, force: true, enableWrites: true, expectedTarget: tmp,
    });

    assert.equal(res.ok, true, `from-manifest recovery failed: ${JSON.stringify(res.diagnostics)}`);
    // The corrupt journal could not be advanced — but recovery still succeeded.
    assert.ok(res.diagnostics.some((d) => d.code === 'recover-from-manifest-no-journal'),
      'the unreadable journal is reported, not fatal');
    assert.ok(res.diagnostics.some((d) => d.code === 'recover-from-manifest-restored'));

    // The live tree is restored byte-identical from the manifest's captured bytes.
    assert.ok(Buffer.compare(readFileSync(join(tmp, 'CLAUDE.md')), claudeV1) === 0,
      'CLAUDE.md restored to v1 from the manifest');
    assert.ok(Buffer.compare(readFileSync(join(tmp, 'settings.json')), settingsV1) === 0,
      'settings.json restored to v1 from the manifest');

    // No atomic-write sidecar residue from the restore.
    const residue = allFilePaths(tmp).filter((p) => /\.mgr-(new|old)$/.test(p));
    assert.deepEqual(residue, [], `no .mgr-new/.mgr-old residue, found: ${residue.join(', ')}`);
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

test('recover --rollback restores a DELETED target (the crash window) + marks journal rolled-back', async (t) => {
  const { tarPath } = resolveTar();
  if (!tarPath) { t.skip('system tar not found — skipping'); return; }

  const saved = process.env.CLAUDE_CONFIG_DIR;
  const tmp = mkdtempSync(join(tmpdir(), 'cmgr-recover-cw-'));
  process.env.CLAUDE_CONFIG_DIR = tmp;
  const stateDir = join(tmp, '.mgr-state');
  mkdirSync(stateDir, { recursive: true });

  const settingsV1 = Buffer.from('{\n  "model": "opus"\n}\n', 'utf8');

  try {
    const snap = await seedSnapshot(tmp, stateDir, [['settings.json', settingsV1]]);
    if (!snap.ok && snap.diagnostics.some((d) => /tar/.test(d.code))) {
      t.skip(`snapshot could not run (tar issue): ${snap.diagnostics.map((d) => d.code).join(',')}`);
      return;
    }
    assert.equal(snap.ok, true, `snapshot failed: ${JSON.stringify(snap.diagnostics)}`);
    const snapshotId = snap.snapshotId;

    // Seed a REAL apply-journal stranded at 'applying' (planned→snapshotted→applying),
    // simulating an apply that crashed mid-write.
    const plan = { planVersion: 1, command: 'config set', ops: [{ kind: 'overwrite', target: join(tmp, 'settings.json'), content: '{ "model": "haiku" }\n' }] };
    const created = createJournal({ snapshotId, targetClaudeDir: tmp, plan });
    assert.ok(created.journal, 'createJournal should produce a planned journal');
    let j = transition(created.journal, 'snapshotted', {});
    j = transition(j.journal, 'applying', {});
    assert.ok(j.ok, 'planned→snapshotted→applying must be legal');
    const seedWrite = writeJournal({ stateDir, snapshotId, journal: j.journal, assertWritable });
    assert.ok(seedWrite.written, `seed journal write failed: ${JSON.stringify(seedWrite.diagnostics)}`);

    // THE CRASH WINDOW: the target file is ABSENT (backup happened, commit did not).
    rmSync(join(tmp, 'settings.json'));
    assert.ok(!existsSync(join(tmp, 'settings.json')), 'target is absent (crash window)');

    // recover --rollback --apply --force: the missing file IS the drift, so --force is
    // required; the snapshot holds the ORIGINAL bytes, restored regardless of absence.
    const res = await recover({
      mode: 'rollback', snapshotId, mgrStateDir: stateDir, targetClaudeDir: tmp,
      assertWritable, force: true, enableWrites: true, expectedTarget: tmp,
    });

    assert.equal(res.ok, true, `crash-window rollback failed: ${JSON.stringify(res.diagnostics)}`);
    assert.equal(res.state, 'rolled-back', 'journal advanced to rolled-back');
    // The absent target was restored from the snapshot's original bytes.
    assert.ok(existsSync(join(tmp, 'settings.json')), 'target restored from the snapshot');
    assert.ok(Buffer.compare(readFileSync(join(tmp, 'settings.json')), settingsV1) === 0,
      'settings.json restored byte-identical to its captured v1');
    // The on-disk journal re-read is now rolled-back.
    const post = readJournal({ stateDir, snapshotId });
    assert.equal(post.journal && post.journal.state, 'rolled-back', 'on-disk journal is rolled-back');
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});
