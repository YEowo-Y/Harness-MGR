/**
 * P4a.U5 — test/integration/remove-cli-roundtrip.test.mjs
 *
 * End-to-end CLI integration test for `remove` driven through run(argv) from
 * src/cli.mjs. Uses the REAL governed-write gate (src/paths.mjs::assertWritable,
 * resolved via CLAUDE_CONFIG_DIR) and the REAL system tar (graceful-skip if absent).
 *
 * The three-leg oracle:
 *   (1) DRY-RUN:   run(["remove","agent:foo","--config-dir",tmp])
 *                  → code 0; agents/foo.md STILL exists; NO .mgr-state/snapshots.
 *   (2) APPLY:     run(["remove","agent:foo","--apply","--config-dir",tmp])
 *                  (with HARNESS_MGR_ENABLE_WRITES=1 set in env)
 *                  → code 0; agents/foo.md GONE; commands/bar.md + CLAUDE.md
 *                  byte-identical to originals; no .mgr-new/.mgr-old residue.
 *   (3) REVERSIBILITY: read the snapshot id from tmp/.mgr-state/snapshots (newest
 *                  dir), run rollback <id> --apply --config-dir tmp
 *                  → agents/foo.md restored byte-identical to originals.
 *
 * All assertions are falsifiable fs reads + Buffer.compare (not just "code 0").
 *
 * GRACEFUL-SKIP when the system tar is unavailable (mirrors remove-roundtrip).
 * Sets process.env.CLAUDE_CONFIG_DIR + HARNESS_MGR_ENABLE_WRITES; saves + restores
 * both in a finally block.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { resolveTar } from '../../src/ops/snapshot-tar.mjs';
import { run } from '../../src/cli.mjs';

function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

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

/**
 * Find the newest snapshot id directory under mgrStateDir/snapshots. Returns null
 * when no snapshots exist. Newest = last when sorted lexicographically (the ids are
 * ISO timestamps so lexicographic order == chronological order).
 */
function newestSnapshotId(mgrStateDir) {
  const snapshotsDir = join(mgrStateDir, 'snapshots');
  if (!existsSync(snapshotsDir)) return null;
  const ids = readdirSync(snapshotsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  return ids.length > 0 ? ids[ids.length - 1] : null;
}

test('remove CLI roundtrip: dry-run → apply → rollback restores byte-identical', async (t) => {
  const { tarPath, diagnostics } = resolveTar();
  if (!tarPath) {
    t.skip(`system tar not found (${diagnostics.map((d) => d.code).join(',')}) — skipping remove CLI round-trip`);
    return;
  }

  const savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
  const savedEnableWrites = process.env.HARNESS_MGR_ENABLE_WRITES;
  const tmp = mkdtempSync(join(tmpdir(), 'cmgr-rm-cli-'));
  const stateDir = join(tmp, '.mgr-state');

  try {
    // ── BUILD the live tree ────────────────────────────────────────────────────
    const fooBytes = Buffer.from('---\nname: foo\n---\n# agent foo\nbody content\n', 'utf8');
    const barBytes = Buffer.from('---\nname: bar\n---\n# command bar\nbody content\n', 'utf8');
    const claudeBytes = Buffer.from('# project CLAUDE.md\noriginal content\n', 'utf8');

    put(tmp, 'agents/foo.md', fooBytes);
    put(tmp, 'commands/bar.md', barBytes);
    put(tmp, 'CLAUDE.md', claudeBytes);
    mkdirSync(stateDir, { recursive: true });

    const barShaOrig = sha256Hex(readFileSync(join(tmp, 'commands', 'bar.md')));
    const claudeShaOrig = sha256Hex(readFileSync(join(tmp, 'CLAUDE.md')));

    // Set CLAUDE_CONFIG_DIR so the REAL gate resolves to our temp dir.
    process.env.CLAUDE_CONFIG_DIR = tmp;

    // ── LEG 1: DRY-RUN — writes nothing ───────────────────────────────────────
    // Make sure HARNESS_MGR_ENABLE_WRITES is NOT set (dry-run needs no env factor).
    delete process.env.HARNESS_MGR_ENABLE_WRITES;

    const dryResult = await run(['remove', 'agent:foo', '--config-dir', tmp]);
    assert.equal(dryResult.code, 0,
      `dry-run expected code 0, got ${dryResult.code}; stdout: ${dryResult.stdout.slice(0, 400)}`);

    // agents/foo.md must still exist — dry-run wrote NOTHING.
    assert.ok(existsSync(join(tmp, 'agents', 'foo.md')),
      'dry-run must NOT delete agents/foo.md');

    // No snapshot dir should have been created.
    assert.ok(!existsSync(join(stateDir, 'snapshots')),
      'dry-run must NOT create any snapshot');

    // ── LEG 2: APPLY — actually deletes ───────────────────────────────────────
    // Arm the second factor.
    process.env.HARNESS_MGR_ENABLE_WRITES = '1';

    const applyResult = await run(['remove', 'agent:foo', '--apply', '--config-dir', tmp]);
    assert.equal(applyResult.code, 0,
      `apply expected code 0, got ${applyResult.code}; stdout: ${applyResult.stdout.slice(0, 400)}`);

    // agents/foo.md must be GONE.
    assert.ok(!existsSync(join(tmp, 'agents', 'foo.md')),
      'agents/foo.md must be deleted after --apply');

    // Unrelated governed files must be byte-identical.
    assert.equal(sha256Hex(readFileSync(join(tmp, 'commands', 'bar.md'))), barShaOrig,
      'commands/bar.md must be unchanged after remove');
    assert.equal(sha256Hex(readFileSync(join(tmp, 'CLAUDE.md'))), claudeShaOrig,
      'CLAUDE.md must be unchanged after remove');

    // No atomic-delete sidecar residue.
    const residueAfterApply = allFilePaths(tmp).filter((p) => /\.mgr-(new|old)$/.test(p));
    assert.deepEqual(residueAfterApply, [],
      `no .mgr-new/.mgr-old residue expected after apply, found: ${residueAfterApply.join(', ')}`);

    // ── LEG 3: REVERSIBILITY — rollback restores byte-identical ───────────────
    const snapId = newestSnapshotId(stateDir);
    assert.ok(snapId, 'a snapshot must have been created by the apply leg');

    const rollbackResult = await run([
      'rollback', snapId, '--apply', '--force', '--config-dir', tmp,
    ]);
    assert.equal(rollbackResult.code, 0,
      `rollback expected code 0, got ${rollbackResult.code}; stdout: ${rollbackResult.stdout.slice(0, 400)}`);

    // agents/foo.md must be restored byte-identical to the original.
    assert.ok(existsSync(join(tmp, 'agents', 'foo.md')),
      'agents/foo.md must be restored by rollback');
    assert.ok(
      Buffer.compare(readFileSync(join(tmp, 'agents', 'foo.md')), fooBytes) === 0,
      'rollback must restore agents/foo.md byte-identical to the original',
    );

    // No sidecar residue after rollback.
    const residueAfterRollback = allFilePaths(tmp).filter((p) => /\.mgr-(new|old)$/.test(p));
    assert.deepEqual(residueAfterRollback, [],
      `no .mgr-new/.mgr-old residue expected after rollback, found: ${residueAfterRollback.join(', ')}`);

  } finally {
    // Always restore env vars before cleanup.
    if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;

    if (savedEnableWrites === undefined) delete process.env.HARNESS_MGR_ENABLE_WRITES;
    else process.env.HARNESS_MGR_ENABLE_WRITES = savedEnableWrites;

    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});
