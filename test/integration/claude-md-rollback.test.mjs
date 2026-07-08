/**
 * P3.U17 — integration/claude-md-rollback.test.mjs
 *
 * The HEADLINE DoD oracle for the rollback orchestrator: a FULL end-to-end
 * snapshot → mutate → rollback round-trip against a REAL temp `~/.claude`-like
 * tree, using the REAL governed-write gate (src/paths.mjs::assertWritable, resolved
 * via CLAUDE_CONFIG_DIR) and the REAL system tar (no injected seams). It proves the
 * unit's acceptance criterion: "CLAUDE.md is writable in the rollback context"
 * end-to-end — a snapshotted CLAUDE.md is restored byte-identical over a mutated
 * live tree, while files OUTSIDE the rollback-writable surface are gate-DENIED and
 * SKIPPED (never restored), with NO atomic-write sidecar residue left behind.
 *
 * Golden oracle (all must hold for the --apply round-trip):
 *   (a) rollbackSnapshot returns ok:true, status:'restored';
 *   (b) CLAUDE.md (mutated to v2) is RESTORED byte-identical to its v1 bytes — the
 *       headline: the rollback context is genuinely writable for CLAUDE.md;
 *   (c) agents/a.md (also mutated) is restored byte-identical;
 *   (d) hud/omc-hud.mjs AND plugins/installed_plugins.json — captured by the
 *       snapshot walk but NOT rollback-writable — are in restore.skipped with
 *       reason 'out-of-surface' (gate-denied → skipped, NOT restored, NOT fatal);
 *   (e) NO `.mgr-new` / `.mgr-old` atomic-write sidecar residue anywhere under tmp.
 *
 * The dry-run oracle (before --apply):
 *   • rollbackSnapshot({enableWrites:false, force:true}) → status:'dry-run', and the
 *     live CLAUDE.md STILL reads "v2 MODIFIED" (the dry-run wrote NOTHING), with the
 *     drift correctly detected (drift.clean === false).
 *
 * GRACEFUL-SKIP when the system tar is unavailable (mirrors snapshot-roundtrip).
 * Unlike the snapshot round-trip, this test uses the REAL gate (not a passthrough)
 * because the whole point is to prove the rollback context's writability decisions
 * against the actual paths.mjs gate — so it sets CLAUDE_CONFIG_DIR to the temp dir
 * and restores it in a finally.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { createSnapshot } from '../../src/ops/snapshot.mjs';
import { rollbackSnapshot } from '../../src/ops/rollback.mjs';
import { resolveTar } from '../../src/ops/snapshot-tar.mjs';
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

test('rollback round-trip: restores CLAUDE.md byte-identical, skips out-of-surface, no sidecar residue', async (t) => {
  const { tarPath, diagnostics } = resolveTar();
  if (!tarPath) {
    t.skip(`system tar not found (${diagnostics.map((d) => d.code).join(',')}) — skipping rollback round-trip`);
    return;
  }

  const saved = process.env.CLAUDE_CONFIG_DIR;
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'cmgr-rb-rt-')));
  // The REAL gate resolves the governed dir from CLAUDE_CONFIG_DIR (read at call time).
  process.env.CLAUDE_CONFIG_DIR = tmp;
  const stateDir = join(tmp, '.mgr-state');
  mkdirSync(stateDir, { recursive: true });

  // v1 bytes of the writable surface (these must round-trip byte-identical).
  const claudeV1 = Buffer.from('v1 content\n', 'utf8');
  const agentV1 = Buffer.from('# agent a v1\nline2\n', 'utf8');
  const skillV1 = Buffer.from('# 技能 v1 café\nx\n', 'utf8');
  // Captured-but-NOT-rollback-writable files (must be skipped on restore).
  const hudBytes = Buffer.from('// omc-hud v1\n', 'utf8');
  const pluginsBytes = Buffer.from('{"schemaVersion":2,"installed":[]}\n', 'utf8');

  try {
    // 1. Build the live tree: writable surface + out-of-surface captured files.
    put(tmp, 'CLAUDE.md', claudeV1);
    put(tmp, 'agents/a.md', agentV1);
    put(tmp, 'skills/s/SKILL.md', skillV1);
    put(tmp, 'hud/omc-hud.mjs', hudBytes);
    put(tmp, 'plugins/installed_plugins.json', pluginsBytes);

    // 2. Snapshot the tree (REAL tar, REAL gate). createSnapshot writes only into
    //    .mgr-state via the 'apply' context, which the real gate permits.
    const snap = await createSnapshot({
      targetClaudeDir: tmp, mgrStateDir: stateDir, reason: 'rollback-test',
      includeAuth: false, assertWritable, now: () => new Date(), dryRun: false,
    });
    if (!snap.ok && snap.diagnostics.some((d) => /tar/.test(d.code))) {
      t.skip(`snapshot could not run (tar issue): ${snap.diagnostics.map((d) => d.code).join(',')}`);
      return;
    }
    assert.equal(snap.ok, true, `snapshot failed: ${JSON.stringify(snap.diagnostics)}`);
    const snapshotId = snap.snapshotId;
    // Sanity: the out-of-surface files WERE captured by the walk (so the skip on
    // restore is a genuine gate decision, not just an absent file).
    assert.ok(snap.kept.includes('hud/omc-hud.mjs'), 'hud captured by the snapshot walk');
    assert.ok(snap.kept.includes('plugins/installed_plugins.json'), 'plugins file captured by the snapshot walk');

    // 3. MUTATE the live tree → drift.
    const claudeV2 = Buffer.from('v2 MODIFIED\n', 'utf8');
    writeFileSync(join(tmp, 'CLAUDE.md'), claudeV2);
    writeFileSync(join(tmp, 'agents', 'a.md'), Buffer.from('# agent a v2 CHANGED\n', 'utf8'));

    // 4. DRY-RUN (force, but enableWrites:false) → must write NOTHING + detect drift.
    const dry = await rollbackSnapshot({
      mgrStateDir: stateDir, targetClaudeDir: tmp, snapshotId,
      assertWritable, force: true, enableWrites: false, expectedTarget: tmp,
    });
    assert.equal(dry.status, 'dry-run', `dry-run status: ${JSON.stringify(dry.diagnostics)}`);
    assert.equal(dry.dryRun, true);
    assert.equal(dry.drift.clean, false, 'dry-run detected the drift');
    // The dry-run wrote NOTHING — CLAUDE.md still reads v2.
    assert.ok(Buffer.compare(readFileSync(join(tmp, 'CLAUDE.md')), claudeV2) === 0,
      'dry-run must NOT modify the live tree');

    // 5. --apply with force (drift present, but we choose to overwrite).
    const res = await rollbackSnapshot({
      mgrStateDir: stateDir, targetClaudeDir: tmp, snapshotId,
      assertWritable, force: true, enableWrites: true, expectedTarget: tmp,
    });

    // (a) the rollback completed.
    assert.equal(res.ok, true, `rollback failed: ${JSON.stringify(res.diagnostics)}`);
    assert.equal(res.status, 'restored');
    assert.equal(res.lock.acquired, true);

    // (b) CLAUDE.md restored byte-identical to v1 — THE HEADLINE.
    assert.ok(Buffer.compare(readFileSync(join(tmp, 'CLAUDE.md')), claudeV1) === 0,
      'CLAUDE.md must be restored byte-identical to v1');
    // (c) agents/a.md restored byte-identical to v1.
    assert.ok(Buffer.compare(readFileSync(join(tmp, 'agents', 'a.md')), agentV1) === 0,
      'agents/a.md must be restored byte-identical to v1');
    // skills/s/SKILL.md (unchanged but still written) matches v1.
    assert.ok(Buffer.compare(readFileSync(join(tmp, 'skills', 's', 'SKILL.md')), skillV1) === 0,
      'skills/s/SKILL.md must match v1');

    // (d) hud + plugins are SKIPPED (gate-denied → out-of-surface), NOT restored.
    const skippedPaths = res.restore.skipped.map((s) => s.path);
    assert.ok(skippedPaths.includes('hud/omc-hud.mjs'), 'hud must be skipped (out-of-surface)');
    assert.ok(skippedPaths.includes('plugins/installed_plugins.json'), 'plugins file must be skipped (out-of-surface)');
    for (const s of res.restore.skipped) {
      assert.equal(s.reason, 'out-of-surface', `skip reason for ${s.path} must be out-of-surface`);
    }

    // (e) NO atomic-write sidecar residue anywhere under tmp.
    const residue = allFilePaths(tmp).filter((p) => /\.mgr-(new|old)$/.test(p));
    assert.deepEqual(residue, [], `no .mgr-new/.mgr-old residue expected, found: ${residue.join(', ')}`);
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});
