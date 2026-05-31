/**
 * P3.U13 sub-unit C — integration/apply-commit-roundtrip.test.mjs
 *
 * The HEADLINE DoD for the GOVERNED WRITE: a FULL end-to-end run of applyPlan with
 * `enableWrites:true` against a REAL temp `~/.claude`-like tree using the REAL
 * system tar (via the real createSnapshot) and the REAL atomic-write primitive,
 * proving the lifecycle drives snapshotted→applying→committed and that the single
 * op's content is ACTUALLY written to disk — safely and recoverably:
 *   - acquires + releases the apply lock,
 *   - captures a real snapshot (files.tar + manifest.json) of the PRE-write state,
 *   - WRITES the single overwrite op to the governed file (settings.json),
 *   - leaves NO `.mgr-new` / `.mgr-old` sidecars,
 *   - persists a journal in state 'committed',
 *   - touches NO unrelated governed file.
 *
 * Falsifiable oracles (not "exit 0"): settings.json bytes == the new content; the
 * manifest's preSha256 for settings.json == the ORIGINAL ("sonnet") bytes (so a
 * rollback could restore it); an unrelated file's hash is unchanged.
 *
 * GRACEFUL-SKIP when the system tar is unavailable (mirrors apply-roundtrip).
 * assertWritable is injected as a passthrough so the test does not depend on real
 * ~/.claude path resolution (the real gate is exercised by selftest --boundary).
 *
 * The U12 apply-roundtrip.test.mjs (no enableWrites → writes-nothing) is left
 * untouched as the companion gate-safe oracle.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { applyPlan } from '../../src/ops/apply.mjs';
import { resolveTar } from '../../src/ops/snapshot-tar.mjs';
import { readJournal } from '../../src/ops/apply-journal-writer.mjs';

const PASS_GATE = (p) => p; // passthrough write gate (the real gate is in selftest --boundary)

function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/** Write a file at a POSIX-relative path under base, creating parent dirs. */
function put(base, rel, bytes) {
  const abs = join(base, ...rel.split('/'));
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, bytes);
}

/** A plan with ONE overwrite op rewriting settings.json's content. */
function makeOverwritePlan(targetClaudeDir, newContent) {
  return {
    planVersion: 1,
    command: 'config set',
    ops: [{
      kind: 'overwrite', target: join(targetClaudeDir, 'settings.json'),
      summary: 'set model to opus', content: newContent,
    }],
    apply: true,
  };
}

test('apply-commit-roundtrip: enableWrites drives snapshotted→applying→committed and WRITES the op', async (t) => {
  const { tarPath, diagnostics } = resolveTar();
  if (!tarPath) {
    t.skip(`system tar not found (${diagnostics.map((d) => d.code).join(',')}) — skipping apply commit round-trip`);
    return;
  }

  const root = mkdtempSync(join(tmpdir(), 'cmgr-apply-commit-'));
  const claudeDir = join(root, '.claude');
  const stateDir = join(claudeDir, '.mgr-state');
  mkdirSync(claudeDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });

  try {
    const ORIGINAL = '{\n  "model": "sonnet"\n}\n';
    const NEW = '{"model":"opus"}\n';

    // The governed file we will overwrite + an UNRELATED governed file.
    put(claudeDir, 'settings.json', Buffer.from(ORIGINAL, 'utf8'));
    put(claudeDir, 'agents/a.md', Buffer.from('# agent a\nline2\n', 'utf8'));

    const originalSettingsSha = sha256Hex(Buffer.from(ORIGINAL, 'utf8'));
    const agentShaBefore = sha256Hex(readFileSync(join(claudeDir, 'agents', 'a.md')));

    const res = await applyPlan({
      plan: makeOverwritePlan(claudeDir, NEW), targetClaudeDir: claudeDir, mgrStateDir: stateDir,
      assertWritable: PASS_GATE, reason: 'commit-integration', pid: process.pid, enableWrites: true,
    });

    // The lifecycle reached committed and the op was applied.
    assert.equal(res.ok, true, `apply failed: ${JSON.stringify(res.diagnostics)}`);
    assert.equal(res.state, 'committed');
    assert.equal(res.applied, true);
    assert.equal(res.opsWritten, 1);
    assert.ok(!res.diagnostics.some((d) => d.code === 'apply-writes-disabled'), 'no writes-disabled info on the write path');

    // THE WRITE HAPPENED: settings.json now holds the new content, byte-for-byte.
    assert.equal(readFileSync(join(claudeDir, 'settings.json'), 'utf8'), NEW, 'settings.json must hold the NEW content');

    // No atomic-write sidecars remain (clean commit + cleanup).
    assert.ok(!existsSync(join(claudeDir, 'settings.json.mgr-new')), 'no .mgr-new leftover');
    assert.ok(!existsSync(join(claudeDir, 'settings.json.mgr-old')), 'no .mgr-old leftover');

    // The UNRELATED governed file is untouched.
    assert.equal(sha256Hex(readFileSync(join(claudeDir, 'agents', 'a.md'))), agentShaBefore, 'agents/a.md must be unchanged');

    // The snapshot artifacts exist in .mgr-state.
    const snapDir = join(stateDir, 'snapshots', res.snapshotId);
    assert.ok(existsSync(join(snapDir, 'files.tar')), 'files.tar must exist');
    assert.ok(existsSync(join(snapDir, 'manifest.json')), 'manifest.json must exist');

    // The journal exists and reads 'committed'.
    assert.ok(existsSync(join(snapDir, 'apply-journal.json')), 'apply-journal.json must exist');
    const jr = readJournal({ stateDir, snapshotId: res.snapshotId });
    assert.equal(jr.journal && jr.journal.state, 'committed', 'journal must be persisted at committed');

    // The lock was released (no leftover lock file).
    assert.ok(!existsSync(join(stateDir, 'locks', 'apply.lock')), 'apply lock must be released');

    // ROLLBACK-SAFETY ORACLE: the snapshot captured the PRE-write settings.json, so
    // its manifest preSha256 == the ORIGINAL ("sonnet") hash — a rollback could
    // restore "sonnet", proving the snapshot ran BEFORE the write.
    const manifest = JSON.parse(readFileSync(join(snapDir, 'manifest.json'), 'utf8'));
    const settingsEntry = manifest.files.find((f) => f.path === 'settings.json');
    assert.ok(settingsEntry, 'manifest must record settings.json');
    assert.equal(settingsEntry.preSha256, originalSettingsSha,
      'snapshot must have captured the PRE-write (sonnet) settings.json, not the new content');
  } finally {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});
