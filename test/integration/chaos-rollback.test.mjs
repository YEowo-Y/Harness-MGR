/**
 * P3.U22 (sub-unit D) — integration/chaos-rollback.test.mjs
 *
 * END-TO-END DoD acceptance oracle #2: crash-recovery survives a corrupted/absent
 * journal AND the atomic-write crash window, driven through the REAL CLI `run(argv)`,
 * against a REAL temp `~/.claude`-like tree, the REAL governed-write gate
 * (src/paths.mjs::assertWritable via CLAUDE_CONFIG_DIR), and the REAL system tar.
 *
 * The same three-env-var wiring contract as dry-run-vs-apply:
 *   • CLAUDE_CONFIG_DIR = tmp · --config-dir tmp · CLAUDE_MGR_ENABLE_WRITES = '1'
 * all saved + restored in the finally. SETUP (snapshot) is driven deterministically
 * via createSnapshot; the ACTION under test is `run(['recover', ...])`.
 *
 * Oracles (all via `run()`):
 *   1. CORRUPT-JOURNAL CHAOS: a valid snapshot (manifest + files.tar) whose
 *      apply-journal.json is GARBAGE; a mutated live tree. `recover <id>
 *      --from-manifest --force --apply` → code 0, CLAUDE.md restored byte-identical
 *      to v1 from the MANIFEST despite the unreadable journal, and stdout surfaces
 *      `recover-from-manifest` (no-journal + restored) diagnostics.
 *   2. CRASH-WINDOW CHAOS: a fresh snapshot, then DELETE CLAUDE.md entirely
 *      (the atomic-write window where the target is gone). `recover <id>
 *      --from-manifest --force --apply` → code 0, CLAUDE.md RE-CREATED byte-identical
 *      to v1 from the snapshot's original bytes. --force is required (the missing
 *      file reads as drift).
 *   3. JOURNAL-AWARE --rollback CHAOS: a REAL apply-journal stranded at 'applying'
 *      (planned→snapshotted→applying, an apply that crashed mid-write) + a mutated
 *      live tree. `recover <id> --rollback --force --apply` → code 0, the live tree
 *      restored byte-identical to v1, and the on-disk journal advanced to
 *      'rolled-back' (stdout reports state rolled-back). This drives the journal-AWARE
 *      recover mode through the CLI (the --from-manifest legs are journal-AGNOSTIC).
 *   4. NO `.mgr-new` / `.mgr-old` residue in any leg.
 *
 * GRACEFUL-SKIP when the system tar is unavailable. tar exists here, so this MUST run.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSnapshot } from '../../src/ops/snapshot.mjs';
import { resolveTar } from '../../src/ops/snapshot-tar.mjs';
import { createJournal, transition, writeJournal, readJournal } from '../../src/ops/apply-journal-writer.mjs';
import { assertWritable } from '../../src/paths.mjs';
import { run } from '../../src/cli.mjs';

/** Write a file at a POSIX-relative path under base, creating parent dirs. */
function put(base, rel, bytes) {
  const abs = join(base, ...rel.split('/'));
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, bytes);
}

/** Recursively collect every absolute file path under dir (for the residue scan). */
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
  return createSnapshot({
    targetClaudeDir: tmp, mgrStateDir: stateDir, reason: 'chaos-test',
    includeAuth: false, assertWritable, now: () => new Date(), dryRun: false,
  });
}

test('chaos: recover --from-manifest restores a mutated tree despite a CORRUPT journal, via run()', async (t) => {
  const { tarPath, diagnostics } = resolveTar();
  if (!tarPath) {
    t.skip(`system tar not found (${diagnostics.map((d) => d.code).join(',')}) — skipping`);
    return;
  }

  const savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
  const savedEnableWrites = process.env.CLAUDE_MGR_ENABLE_WRITES;
  const tmp = mkdtempSync(join(tmpdir(), 'cmgr-chaos-cj-'));
  process.env.CLAUDE_CONFIG_DIR = tmp;
  process.env.CLAUDE_MGR_ENABLE_WRITES = '1'; // arm the write factor for the --apply legs
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
    const id = snap.snapshotId;

    // CORRUPT the journal: garbage where apply-journal.json lives. The manifest +
    // files.tar are intact, so --from-manifest must still recover.
    const snapDir = join(stateDir, 'snapshots', id);
    writeFileSync(join(snapDir, 'apply-journal.json'), Buffer.from('{ broken json ::::', 'utf8'));

    // MUTATE the live tree → drift (recovering this drift needs --force).
    const claudeV2 = Buffer.from('# CLAUDE v2 BROKEN\n', 'utf8');
    writeFileSync(join(tmp, 'CLAUDE.md'), claudeV2);
    writeFileSync(join(tmp, 'settings.json'), Buffer.from('{ "model": "haiku-WRONG" }\n', 'utf8'));

    // recover --from-manifest --force --apply via run() → restore from the manifest
    // despite the corrupt journal.
    const res = await run(['recover', id, '--from-manifest', '--force', '--apply', '--config-dir', tmp]);
    assert.equal(res.code, 0, `from-manifest recovery code 0 expected; stdout:\n${res.stdout}`);
    // The unreadable journal is reported (not fatal) + the restore is reported.
    assert.ok(/recover-from-manifest-no-journal/.test(res.stdout),
      `stdout should report the unreadable journal (recover-from-manifest-no-journal):\n${res.stdout}`);
    assert.ok(/recover-from-manifest-restored/.test(res.stdout),
      `stdout should report the restore (recover-from-manifest-restored):\n${res.stdout}`);

    // The live tree is restored byte-identical from the manifest's captured bytes.
    assert.ok(Buffer.compare(readFileSync(join(tmp, 'CLAUDE.md')), claudeV1) === 0,
      'CLAUDE.md restored to v1 from the manifest');
    assert.ok(Buffer.compare(readFileSync(join(tmp, 'settings.json')), settingsV1) === 0,
      'settings.json restored to v1 from the manifest');

    // No atomic-write sidecar residue from the restore.
    const residue = allFilePaths(tmp).filter((p) => /\.mgr-(new|old)$/.test(p));
    assert.deepEqual(residue, [], `no .mgr-new/.mgr-old residue, found: ${residue.join(', ')}`);
  } finally {
    if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
    if (savedEnableWrites === undefined) delete process.env.CLAUDE_MGR_ENABLE_WRITES;
    else process.env.CLAUDE_MGR_ENABLE_WRITES = savedEnableWrites;
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

test('chaos: recover --from-manifest RE-CREATES a DELETED target (the crash window), via run()', async (t) => {
  const { tarPath } = resolveTar();
  if (!tarPath) { t.skip('system tar not found — skipping'); return; }

  const savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
  const savedEnableWrites = process.env.CLAUDE_MGR_ENABLE_WRITES;
  const tmp = mkdtempSync(join(tmpdir(), 'cmgr-chaos-cw-'));
  process.env.CLAUDE_CONFIG_DIR = tmp;
  process.env.CLAUDE_MGR_ENABLE_WRITES = '1';
  const stateDir = join(tmp, '.mgr-state');
  mkdirSync(stateDir, { recursive: true });

  const claudeV1 = Buffer.from('# CLAUDE crash-window v1\nkeep me\n', 'utf8');

  try {
    const snap = await seedSnapshot(tmp, stateDir, [['CLAUDE.md', claudeV1]]);
    if (!snap.ok && snap.diagnostics.some((d) => /tar/.test(d.code))) {
      t.skip(`snapshot could not run (tar issue): ${snap.diagnostics.map((d) => d.code).join(',')}`);
      return;
    }
    assert.equal(snap.ok, true, `snapshot failed: ${JSON.stringify(snap.diagnostics)}`);
    const id = snap.snapshotId;

    // THE CRASH WINDOW: the target file is ABSENT (the atomic-write backup happened,
    // the commit did not). The snapshot holds the ORIGINAL bytes.
    rmSync(join(tmp, 'CLAUDE.md'));
    assert.ok(!existsSync(join(tmp, 'CLAUDE.md')), 'target is absent (crash window)');

    // recover --from-manifest --force --apply via run(): the missing file reads as
    // drift, so --force is required; restored from the snapshot's original bytes.
    const res = await run(['recover', id, '--from-manifest', '--force', '--apply', '--config-dir', tmp]);
    assert.equal(res.code, 0, `crash-window recovery code 0 expected; stdout:\n${res.stdout}`);
    assert.ok(existsSync(join(tmp, 'CLAUDE.md')), 'target RE-CREATED from the snapshot');
    assert.ok(Buffer.compare(readFileSync(join(tmp, 'CLAUDE.md')), claudeV1) === 0,
      'CLAUDE.md re-created byte-identical to its captured v1');

    const residue = allFilePaths(tmp).filter((p) => /\.mgr-(new|old)$/.test(p));
    assert.deepEqual(residue, [], `no .mgr-new/.mgr-old residue, found: ${residue.join(', ')}`);
  } finally {
    if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
    if (savedEnableWrites === undefined) delete process.env.CLAUDE_MGR_ENABLE_WRITES;
    else process.env.CLAUDE_MGR_ENABLE_WRITES = savedEnableWrites;
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

test('chaos: recover --rollback advances an "applying" journal + restores the tree, via run()', async (t) => {
  const { tarPath } = resolveTar();
  if (!tarPath) { t.skip('system tar not found — skipping'); return; }

  const savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
  const savedEnableWrites = process.env.CLAUDE_MGR_ENABLE_WRITES;
  const tmp = mkdtempSync(join(tmpdir(), 'cmgr-chaos-rb-'));
  process.env.CLAUDE_CONFIG_DIR = tmp;
  process.env.CLAUDE_MGR_ENABLE_WRITES = '1';
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
    const id = snap.snapshotId;

    // Seed a REAL apply-journal stranded at 'applying' (planned→snapshotted→applying),
    // simulating an apply that crashed mid-write. Written via the REAL gate.
    const plan = { planVersion: 1, command: 'config set', ops: [{ kind: 'overwrite', target: join(tmp, 'settings.json'), content: '{ "model": "haiku" }\n' }] };
    const created = createJournal({ snapshotId: id, targetClaudeDir: tmp, plan });
    assert.ok(created.journal, 'createJournal should produce a planned journal');
    let j = transition(created.journal, 'snapshotted', {});
    j = transition(j.journal, 'applying', {});
    assert.ok(j.ok, 'planned→snapshotted→applying must be legal');
    const seedWrite = writeJournal({ stateDir, snapshotId: id, journal: j.journal, assertWritable });
    assert.ok(seedWrite.written, `seed journal write failed: ${JSON.stringify(seedWrite.diagnostics)}`);

    // MUTATE the live tree → drift (the journal-aware rollback needs --force to override).
    writeFileSync(join(tmp, 'settings.json'), Buffer.from('{ "model": "haiku-WRONG" }\n', 'utf8'));

    // recover --rollback --force --apply via run(): wraps the U17 rollback (lock →
    // drift → verify → restore) AND advances the journal to 'rolled-back'.
    const res = await run(['recover', id, '--rollback', '--force', '--apply', '--config-dir', tmp]);
    assert.equal(res.code, 0, `journal-aware rollback code 0 expected; stdout:\n${res.stdout}`);
    assert.ok(/rolled-back/.test(res.stdout),
      `stdout should report the journal advanced to rolled-back:\n${res.stdout}`);

    // The live tree is restored byte-identical from the snapshot's captured bytes.
    assert.ok(Buffer.compare(readFileSync(join(tmp, 'settings.json')), settingsV1) === 0,
      'settings.json restored byte-identical to its captured v1');
    // The on-disk journal re-read is now rolled-back (journal-aware reconciliation).
    const post = readJournal({ stateDir, snapshotId: id });
    assert.equal(post.journal && post.journal.state, 'rolled-back', 'on-disk journal is rolled-back');

    const residue = allFilePaths(tmp).filter((p) => /\.mgr-(new|old)$/.test(p));
    assert.deepEqual(residue, [], `no .mgr-new/.mgr-old residue, found: ${residue.join(', ')}`);
  } finally {
    if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
    if (savedEnableWrites === undefined) delete process.env.CLAUDE_MGR_ENABLE_WRITES;
    else process.env.CLAUDE_MGR_ENABLE_WRITES = savedEnableWrites;
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});
