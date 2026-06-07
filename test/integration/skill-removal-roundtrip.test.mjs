/**
 * P4b.S3 — integration/skill-removal-roundtrip.test.mjs
 *
 * The headline DoD oracle for `remove skill:NAME` — a full end-to-end run
 * against a REAL temp tree using the REAL governed-write gate (assertWritable via
 * CLAUDE_CONFIG_DIR) and the REAL system tar (no injected seams).
 *
 * Tree: skills/foo/ (multi-file: SKILL.md + sub/helper.md) + skills/bar/ + agents/a.md.
 *
 * Proves:
 *   - DRY-RUN (no enableWrites): preview only — skills/foo/ still on disk, no snapshot.
 *   - --apply (enableWrites:true): skills/foo/ entirely gone (both files deleted),
 *     skills/bar/ and agents/a.md untouched, manifest records preSha256 for every
 *     file in skills/foo/, NO .mgr-old sidecar residue.
 *   - REVERSIBILITY: rollbackSnapshot restores skills/foo/SKILL.md and
 *     skills/foo/sub/helper.md byte-identical to the originals.
 *
 * GRACEFUL-SKIP when the system tar is unavailable (mirrors remove-roundtrip).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync,
  existsSync, rmSync, readdirSync,
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

/** Write bytes at a POSIX-relative path under base, creating parent dirs. */
function put(base, rel, bytes) {
  const abs = join(base, ...rel.split('/'));
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, bytes);
}

/** Collect every absolute file path under dir (for residue scan). */
function allFilePaths(dir) {
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

test('skill-removal-roundtrip: dry-run writes nothing; --apply removes dir; rollback restores byte-identical', async (t) => {
  const { tarPath, diagnostics } = resolveTar();
  if (!tarPath) {
    t.skip(`system tar not found (${diagnostics.map((d) => d.code).join(',')}) — skipping skill removal round-trip`);
    return;
  }

  const saved = process.env.CLAUDE_CONFIG_DIR;
  const tmp = mkdtempSync(join(tmpdir(), 'cmgr-skill-rm-'));
  process.env.CLAUDE_CONFIG_DIR = tmp;
  const stateDir = join(tmp, '.mgr-state');
  mkdirSync(stateDir, { recursive: true });

  // Multi-file skill dir to remove, an unrelated skill, and an unrelated agent.
  const skillBytes = Buffer.from('---\nname: foo\n---\n# foo skill\nbody\n', 'utf8');
  const helperBytes = Buffer.from('# helper\ncontent\n', 'utf8');
  const barBytes = Buffer.from('---\nname: bar\n---\n# bar skill\n', 'utf8');
  const agentBytes = Buffer.from('---\nname: a\n---\n# agent a\n', 'utf8');

  try {
    // 1. Build the live tree.
    put(tmp, 'skills/foo/SKILL.md', skillBytes);
    put(tmp, 'skills/foo/sub/helper.md', helperBytes);
    put(tmp, 'skills/bar/SKILL.md', barBytes);
    put(tmp, 'agents/a.md', agentBytes);

    const barShaBefore = sha256Hex(readFileSync(join(tmp, 'skills', 'bar', 'SKILL.md')));
    const agentShaBefore = sha256Hex(readFileSync(join(tmp, 'agents', 'a.md')));

    // 2. DRY-RUN: no enableWrites → preview only, nothing written.
    const dry = await removeComponent({
      spec: 'skill:foo', targetClaudeDir: tmp, mgrStateDir: stateDir,
    });
    assert.equal(dry.ok, true, `dry-run failed: ${JSON.stringify(dry.diagnostics)}`);
    assert.equal(dry.dryRun, true);
    assert.equal(dry.kind, 'skill');
    assert.equal(dry.plan.ops[0].kind, 'delete-dir');
    assert.ok(existsSync(join(tmp, 'skills', 'foo')), 'dry-run must NOT delete skills/foo/');
    assert.ok(!existsSync(join(stateDir, 'snapshots')), 'dry-run must NOT create a snapshot');

    // 3. --apply: real gate, auto-snapshot then directory delete.
    const res = await removeComponent({
      spec: 'skill:foo', targetClaudeDir: tmp, mgrStateDir: stateDir,
      assertWritable, enableWrites: true, pid: process.pid,
    });

    assert.equal(res.ok, true, `--apply failed: ${JSON.stringify(res.diagnostics)}`);
    assert.equal(res.dryRun, false);
    assert.ok(res.apply, 'apply result must be present');
    assert.equal(res.apply.state, 'committed');
    assert.equal(res.apply.applied, true);
    assert.equal(res.apply.opsWritten, 1);

    // skills/foo/ is gone entirely — both files deleted.
    assert.ok(!existsSync(join(tmp, 'skills', 'foo')), 'skills/foo/ must be deleted by --apply');
    assert.ok(!existsSync(join(tmp, 'skills', 'foo', 'SKILL.md')), 'skills/foo/SKILL.md must be gone');
    assert.ok(!existsSync(join(tmp, 'skills', 'foo', 'sub', 'helper.md')), 'skills/foo/sub/helper.md must be gone');

    // Unrelated files are untouched.
    assert.equal(sha256Hex(readFileSync(join(tmp, 'skills', 'bar', 'SKILL.md'))), barShaBefore, 'skills/bar/ unchanged');
    assert.equal(sha256Hex(readFileSync(join(tmp, 'agents', 'a.md'))), agentShaBefore, 'agents/a.md unchanged');

    // No .mgr-old sidecar residue anywhere.
    const residue1 = allFilePaths(tmp).filter((p) => /\.mgr-(new|old)$/.test(p));
    assert.deepEqual(residue1, [], `no .mgr-old residue expected, found: ${residue1.join(', ')}`);

    // Snapshot manifest records preSha256 for files in skills/foo/ (snapshotted BEFORE the delete).
    const snapId = res.apply.snapshotId;
    assert.ok(snapId, 'apply result must carry a snapshotId');
    const snapDir = join(stateDir, 'snapshots', snapId);
    assert.ok(existsSync(join(snapDir, 'files.tar')), 'files.tar must exist');
    const manifest = JSON.parse(readFileSync(join(snapDir, 'manifest.json'), 'utf8'));
    const skillEntry = manifest.files.find((f) => f.path === 'skills/foo/SKILL.md');
    const helperEntry = manifest.files.find((f) => f.path === 'skills/foo/sub/helper.md');
    assert.ok(skillEntry, 'manifest must record skills/foo/SKILL.md');
    assert.ok(helperEntry, 'manifest must record skills/foo/sub/helper.md');
    assert.equal(skillEntry.preSha256, sha256Hex(skillBytes), 'preSha256 must match original SKILL.md bytes');
    assert.equal(helperEntry.preSha256, sha256Hex(helperBytes), 'preSha256 must match original helper.md bytes');

    // 4. REVERSIBILITY: rollback restores both files byte-identical.
    const rb = await rollbackSnapshot({
      mgrStateDir: stateDir, targetClaudeDir: tmp, snapshotId: snapId,
      assertWritable, force: true, enableWrites: true, expectedTarget: tmp,
    });
    assert.equal(rb.ok, true, `rollback failed: ${JSON.stringify(rb.diagnostics)}`);
    assert.equal(rb.status, 'restored');

    // Both files restored byte-identical.
    assert.ok(existsSync(join(tmp, 'skills', 'foo', 'SKILL.md')), 'skills/foo/SKILL.md must be restored');
    assert.ok(existsSync(join(tmp, 'skills', 'foo', 'sub', 'helper.md')), 'skills/foo/sub/helper.md must be restored');
    assert.ok(
      Buffer.compare(readFileSync(join(tmp, 'skills', 'foo', 'SKILL.md')), skillBytes) === 0,
      'SKILL.md must be byte-identical to original after rollback',
    );
    assert.ok(
      Buffer.compare(readFileSync(join(tmp, 'skills', 'foo', 'sub', 'helper.md')), helperBytes) === 0,
      'helper.md must be byte-identical to original after rollback',
    );

    // No residue after rollback either.
    const residue2 = allFilePaths(tmp).filter((p) => /\.mgr-(new|old)$/.test(p));
    assert.deepEqual(residue2, [], `no sidecar residue after rollback, found: ${residue2.join(', ')}`);
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});
