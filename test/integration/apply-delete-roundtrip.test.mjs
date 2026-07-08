/**
 * P4a.U1c — integration/apply-delete-roundtrip.test.mjs
 *
 * The HEADLINE DoD oracle for the apply DELETE path: a FULL end-to-end run of
 * applyPlan with `enableWrites:true` and a single `delete` op against a REAL temp
 * `~/.claude`-like tree, using the REAL governed-write gate (src/paths.mjs::
 * assertWritable, resolved via CLAUDE_CONFIG_DIR) and the REAL system tar (no
 * injected seams). It proves the remove feature's mechanism works end-to-end:
 *
 *   - the apply lifecycle drives snapshotted→applying→committed for a delete op;
 *   - the governed component file (agents/foo.md) is ACTUALLY removed from disk;
 *   - unrelated governed files (CLAUDE.md, settings.json) are untouched;
 *   - the auto-snapshot ran BEFORE the delete (its manifest records agents/foo.md
 *     with a preSha256 == the ORIGINAL bytes) — so the delete is REVERSIBLE;
 *   - NO `.mgr-new` / `.mgr-old` atomic-delete sidecar residue is left behind.
 *
 * Three gate contexts are exercised against the REAL paths.mjs gate in one flow:
 *   • snapshot capture → 'apply' (permits the .mgr-state writes);
 *   • the delete       → 'remove' (permits a single .md leaf in agents/);
 *   • the rollback     → 'rollback' (permits restoring agents/ files).
 *
 * SECOND LEG (reversibility — the §7 headline): rollbackSnapshot restores the very
 * file that was deleted, byte-identical to its original bytes, proving the snapshot
 * taken before the delete is a complete undo.
 *
 * GRACEFUL-SKIP when the system tar is unavailable (mirrors claude-md-rollback).
 * Unlike a passthrough-gate test, this uses the REAL gate (CLAUDE_CONFIG_DIR=temp,
 * restored in a finally) because the whole point is to prove the 'remove' context's
 * delete decision against the actual gate.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { applyPlan } from '../../src/ops/apply.mjs';
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

test('apply-delete-roundtrip: enableWrites deletes a governed component, snapshot makes it reversible', async (t) => {
  const { tarPath, diagnostics } = resolveTar();
  if (!tarPath) {
    t.skip(`system tar not found (${diagnostics.map((d) => d.code).join(',')}) — skipping apply delete round-trip`);
    return;
  }

  const saved = process.env.CLAUDE_CONFIG_DIR;
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'cmgr-apply-del-')));
  // The REAL gate resolves the governed dir from CLAUDE_CONFIG_DIR (read at call time).
  process.env.CLAUDE_CONFIG_DIR = tmp;
  const stateDir = join(tmp, '.mgr-state');
  mkdirSync(stateDir, { recursive: true });

  // The component to remove + unrelated governed files that must stay untouched.
  const fooBytes = Buffer.from('---\nname: foo\n---\n# agent foo\nbody\n', 'utf8');
  const claudeBytes = Buffer.from('# project CLAUDE.md\nunchanged\n', 'utf8');
  const settingsBytes = Buffer.from('{\n  "model": "sonnet"\n}\n', 'utf8');

  try {
    // 1. Build the live tree.
    put(tmp, 'agents/foo.md', fooBytes);
    put(tmp, 'CLAUDE.md', claudeBytes);
    put(tmp, 'settings.json', settingsBytes);

    const fooSha = sha256Hex(fooBytes);
    const claudeShaBefore = sha256Hex(readFileSync(join(tmp, 'CLAUDE.md')));
    const settingsShaBefore = sha256Hex(readFileSync(join(tmp, 'settings.json')));

    // 2. apply a single delete op with the REAL gate. The 'remove' gate context
    //    (used internally by atomicApplyDelete) permits a .md leaf in agents/.
    const res = await applyPlan({
      plan: {
        planVersion: 1, command: 'remove agent:foo',
        ops: [{ kind: 'delete', target: join(tmp, 'agents', 'foo.md'), summary: 'remove agent foo' }],
        apply: true,
      },
      targetClaudeDir: tmp, mgrStateDir: stateDir, assertWritable,
      reason: 'remove-test', pid: process.pid, enableWrites: true,
    });

    // The lifecycle reached committed and the op was applied.
    assert.equal(res.ok, true, `apply failed: ${JSON.stringify(res.diagnostics)}`);
    assert.equal(res.state, 'committed');
    assert.equal(res.applied, true);
    assert.equal(res.opsWritten, 1);

    // THE DELETE HAPPENED: agents/foo.md no longer exists.
    assert.ok(!existsSync(join(tmp, 'agents', 'foo.md')), 'agents/foo.md must be deleted');

    // The unrelated governed files are untouched.
    assert.equal(sha256Hex(readFileSync(join(tmp, 'CLAUDE.md'))), claudeShaBefore, 'CLAUDE.md must be unchanged');
    assert.equal(sha256Hex(readFileSync(join(tmp, 'settings.json'))), settingsShaBefore, 'settings.json must be unchanged');

    // NO atomic-delete sidecar residue anywhere under tmp.
    const residue1 = allFilePaths(tmp).filter((p) => /\.mgr-(new|old)$/.test(p));
    assert.deepEqual(residue1, [], `no .mgr-new/.mgr-old residue expected, found: ${residue1.join(', ')}`);

    // REVERSIBILITY ORACLE: the snapshot captured the PRE-delete agents/foo.md, so
    // its manifest preSha256 == the ORIGINAL bytes — proving the auto-snapshot ran
    // BEFORE the delete and a rollback could restore the removed file.
    const snapDir = join(stateDir, 'snapshots', res.snapshotId);
    assert.ok(existsSync(join(snapDir, 'files.tar')), 'files.tar must exist');
    assert.ok(existsSync(join(snapDir, 'manifest.json')), 'manifest.json must exist');
    const manifest = JSON.parse(readFileSync(join(snapDir, 'manifest.json'), 'utf8'));
    const fooEntry = manifest.files.find((f) => f.path === 'agents/foo.md');
    assert.ok(fooEntry, 'manifest must record agents/foo.md');
    assert.equal(fooEntry.preSha256, fooSha,
      'snapshot must have captured the PRE-delete agents/foo.md bytes');

    // ── SECOND LEG: reversibility — rollback restores the deleted file ──
    const rb = await rollbackSnapshot({
      mgrStateDir: stateDir, targetClaudeDir: tmp, snapshotId: res.snapshotId,
      assertWritable, force: true, enableWrites: true, expectedTarget: tmp,
    });
    assert.equal(rb.ok, true, `rollback failed: ${JSON.stringify(rb.diagnostics)}`);
    assert.equal(rb.status, 'restored');

    // agents/foo.md is back, byte-identical to the original.
    assert.ok(existsSync(join(tmp, 'agents', 'foo.md')), 'agents/foo.md must be restored by rollback');
    assert.ok(Buffer.compare(readFileSync(join(tmp, 'agents', 'foo.md')), fooBytes) === 0,
      'rollback must restore agents/foo.md byte-identical to the original');

    // No atomic-write/-delete sidecar residue after the rollback either.
    const residue2 = allFilePaths(tmp).filter((p) => /\.mgr-(new|old)$/.test(p));
    assert.deepEqual(residue2, [], `no sidecar residue after rollback, found: ${residue2.join(', ')}`);
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});
