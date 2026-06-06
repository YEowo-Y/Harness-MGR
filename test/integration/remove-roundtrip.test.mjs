/**
 * P4a.U1d — integration/remove-roundtrip.test.mjs
 *
 * The §7 "remove-user-level" HEADLINE DoD oracle, driven through the COMMAND-LEVEL
 * builder removeComponent (not applyPlan directly): a full end-to-end run against a
 * REAL temp `~/.claude`-like tree, using the REAL governed-write gate (src/paths
 * .mjs::assertWritable, resolved via CLAUDE_CONFIG_DIR) and the REAL system tar (no
 * injected seams). It proves the user-facing remove feature works end-to-end:
 *
 *   - DRY-RUN (default, no enableWrites): removeComponent previews + writes NOTHING
 *     (agents/foo.md still exists);
 *   - --apply (enableWrites): the auto-snapshot runs BEFORE the delete, the governed
 *     component file (agents/foo.md) is ACTUALLY removed, unrelated governed files
 *     (commands/bar.md, CLAUDE.md) are untouched, the snapshot manifest records
 *     agents/foo.md with a preSha256 == the ORIGINAL bytes (→ reversible), and NO
 *     `.mgr-new`/`.mgr-old` atomic-delete sidecar residue is left behind;
 *   - REVERSIBILITY: rollbackSnapshot restores the deleted file byte-identical.
 *
 * Three gate contexts are exercised against the REAL gate in one flow: snapshot
 * capture → 'apply'; the delete → 'remove'; the rollback → 'rollback'.
 *
 * GRACEFUL-SKIP when the system tar is unavailable (mirrors apply-delete-roundtrip).
 * Uses the REAL gate (CLAUDE_CONFIG_DIR=temp, restored in a finally) because the
 * whole point is to prove the 'remove' context's delete decision against the actual
 * gate, end-to-end from the command builder.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { removeComponent } from '../../src/ops/remove.mjs';
import { rollbackSnapshot } from '../../src/ops/rollback.mjs';
import { resolveTar } from '../../src/ops/snapshot-tar.mjs';
import { assertWritable } from '../../src/paths.mjs';

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

test('remove-roundtrip: removeComponent dry-run writes nothing; --apply deletes + is reversible', async (t) => {
  const { tarPath, diagnostics } = resolveTar();
  if (!tarPath) {
    t.skip(`system tar not found (${diagnostics.map((d) => d.code).join(',')}) — skipping remove round-trip`);
    return;
  }

  const saved = process.env.CLAUDE_CONFIG_DIR;
  const tmp = mkdtempSync(join(tmpdir(), 'cmgr-remove-'));
  // The REAL gate resolves the governed dir from CLAUDE_CONFIG_DIR (read at call time).
  process.env.CLAUDE_CONFIG_DIR = tmp;
  const stateDir = join(tmp, '.mgr-state');
  mkdirSync(stateDir, { recursive: true });

  // The component to remove + unrelated governed files that must stay untouched.
  const fooBytes = Buffer.from('---\nname: foo\n---\n# agent foo\nbody\n', 'utf8');
  const barBytes = Buffer.from('---\nname: bar\n---\n# command bar\nbody\n', 'utf8');
  const claudeBytes = Buffer.from('# project CLAUDE.md\nunchanged\n', 'utf8');

  try {
    // 1. Build the live tree.
    put(tmp, 'agents/foo.md', fooBytes);
    put(tmp, 'commands/bar.md', barBytes);
    put(tmp, 'CLAUDE.md', claudeBytes);

    const fooSha = sha256Hex(fooBytes);
    const barShaBefore = sha256Hex(readFileSync(join(tmp, 'commands', 'bar.md')));
    const claudeShaBefore = sha256Hex(readFileSync(join(tmp, 'CLAUDE.md')));

    // 2. DRY-RUN FIRST: no enableWrites → preview only, write NOTHING.
    const dry = await removeComponent({
      spec: 'agent:foo', targetClaudeDir: tmp, mgrStateDir: stateDir,
    });
    assert.equal(dry.ok, true, `dry-run failed: ${JSON.stringify(dry.diagnostics)}`);
    assert.equal(dry.dryRun, true);
    assert.ok(existsSync(join(tmp, 'agents', 'foo.md')), 'dry-run must NOT delete agents/foo.md');
    // dry-run wrote nothing under .mgr-state either (no snapshots dir created).
    assert.ok(!existsSync(join(stateDir, 'snapshots')), 'dry-run must NOT create a snapshot');

    // 3. --apply: the REAL gate; the auto-snapshot runs then the delete.
    const res = await removeComponent({
      spec: 'agent:foo', targetClaudeDir: tmp, mgrStateDir: stateDir,
      assertWritable, enableWrites: true, pid: process.pid,
    });

    // The lifecycle reached committed and the op was applied.
    assert.equal(res.ok, true, `--apply failed: ${JSON.stringify(res.diagnostics)}`);
    assert.equal(res.dryRun, false);
    assert.ok(res.apply, 'apply result must be present');
    assert.equal(res.apply.state, 'committed');
    assert.equal(res.apply.applied, true);
    assert.equal(res.apply.opsWritten, 1);

    // THE DELETE HAPPENED: agents/foo.md no longer exists.
    assert.ok(!existsSync(join(tmp, 'agents', 'foo.md')), 'agents/foo.md must be deleted by --apply');

    // The unrelated governed files are untouched.
    assert.equal(sha256Hex(readFileSync(join(tmp, 'commands', 'bar.md'))), barShaBefore, 'commands/bar.md must be unchanged');
    assert.equal(sha256Hex(readFileSync(join(tmp, 'CLAUDE.md'))), claudeShaBefore, 'CLAUDE.md must be unchanged');

    // NO atomic-delete sidecar residue anywhere under tmp.
    const residue1 = allFilePaths(tmp).filter((p) => /\.mgr-(new|old)$/.test(p));
    assert.deepEqual(residue1, [], `no .mgr-new/.mgr-old residue expected, found: ${residue1.join(', ')}`);

    // REVERSIBILITY ORACLE: the snapshot captured the PRE-delete agents/foo.md, so
    // its manifest preSha256 == the ORIGINAL bytes.
    const snapId = res.apply.snapshotId;
    assert.ok(snapId, 'apply result must carry a snapshotId');
    const snapDir = join(stateDir, 'snapshots', snapId);
    assert.ok(existsSync(join(snapDir, 'files.tar')), 'files.tar must exist');
    assert.ok(existsSync(join(snapDir, 'manifest.json')), 'manifest.json must exist');
    const manifest = JSON.parse(readFileSync(join(snapDir, 'manifest.json'), 'utf8'));
    const fooEntry = manifest.files.find((f) => f.path === 'agents/foo.md');
    assert.ok(fooEntry, 'manifest must record agents/foo.md');
    assert.equal(fooEntry.preSha256, fooSha, 'snapshot must have captured the PRE-delete agents/foo.md bytes');

    // ── SECOND LEG: reversibility — rollback restores the deleted file ──
    const rb = await rollbackSnapshot({
      mgrStateDir: stateDir, targetClaudeDir: tmp, snapshotId: snapId,
      assertWritable, force: true, enableWrites: true, expectedTarget: tmp,
    });
    assert.equal(rb.ok, true, `rollback failed: ${JSON.stringify(rb.diagnostics)}`);
    assert.equal(rb.status, 'restored');

    // agents/foo.md is back, byte-identical to the original.
    assert.ok(existsSync(join(tmp, 'agents', 'foo.md')), 'agents/foo.md must be restored by rollback');
    assert.ok(Buffer.compare(readFileSync(join(tmp, 'agents', 'foo.md')), fooBytes) === 0,
      'rollback must restore agents/foo.md byte-identical to the original');

    // No sidecar residue after the rollback either.
    const residue2 = allFilePaths(tmp).filter((p) => /\.mgr-(new|old)$/.test(p));
    assert.deepEqual(residue2, [], `no sidecar residue after rollback, found: ${residue2.join(', ')}`);
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});
