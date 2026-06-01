/**
 * P3.U19 — integration/apply-multi-op-roundtrip.test.mjs
 *
 * The HEADLINE DoD for MULTI-OP apply + --paranoid: FULL end-to-end runs of
 * applyPlan with `enableWrites:true` against a REAL temp `~/.claude`-like tree using
 * the REAL system tar (via the real createSnapshot), the REAL atomic-write primitive,
 * and the REAL readFileSync/parseJsonc paranoid re-check:
 *
 *   Test 1 — multi-op writes BOTH governed files (settings.json + .mcp.json) in plan
 *            order, leaves NO sidecars, touches NO unrelated file, persists a
 *            `committed` journal, and (rollback-safety) captured the PRE-write bytes.
 *   Test 2 — --paranoid CATCHES a write of invalid JSON: the op's bytes ARE on disk
 *            (the write happened before the re-parse), the journal is `failed`, and
 *            the snapshot (files.tar + manifest.json) survives so recover --rollback
 *            can restore the pre-apply bytes.
 *
 * Falsifiable oracles (not "exit 0"): on-disk bytes compared byte-for-byte; the
 * manifest's preSha256 == the ORIGINAL bytes' hash; an unrelated file's hash
 * unchanged.
 *
 * GRACEFUL-SKIP when the system tar is unavailable (mirrors apply-commit-roundtrip).
 * assertWritable is injected as a passthrough so the test does not depend on real
 * ~/.claude path resolution (the real gate is exercised by selftest --boundary).
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

/** An overwrite op rewriting `rel` (a file relative to claudeDir) to `content`. */
function overwrite(claudeDir, rel, content) {
  return { kind: 'overwrite', target: join(claudeDir, ...rel.split('/')), summary: `overwrite ${rel}`, content };
}

test('apply-multi-op-roundtrip: enableWrites writes BOTH ops in order, no sidecars, snapshot captured pre-write', async (t) => {
  const { tarPath, diagnostics } = resolveTar();
  if (!tarPath) {
    t.skip(`system tar not found (${diagnostics.map((d) => d.code).join(',')}) — skipping multi-op round-trip`);
    return;
  }

  const root = mkdtempSync(join(tmpdir(), 'cmgr-apply-multi-'));
  const claudeDir = join(root, '.claude');
  const stateDir = join(claudeDir, '.mgr-state');
  mkdirSync(claudeDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });

  try {
    const SETTINGS_ORIG = '{\n  "model": "sonnet"\n}\n';
    const MCP_ORIG = '{"mcpServers":{}}\n';
    const SETTINGS_NEW = '{"model":"opus"}\n';
    const MCP_NEW = '{"mcpServers":{"x":{}}}\n';

    // Two governed files we will overwrite + an UNRELATED governed file.
    put(claudeDir, 'settings.json', Buffer.from(SETTINGS_ORIG, 'utf8'));
    put(claudeDir, '.mcp.json', Buffer.from(MCP_ORIG, 'utf8'));
    put(claudeDir, 'agents/a.md', Buffer.from('# agent a\nline2\n', 'utf8'));

    const settingsShaBefore = sha256Hex(Buffer.from(SETTINGS_ORIG, 'utf8'));
    const agentShaBefore = sha256Hex(readFileSync(join(claudeDir, 'agents', 'a.md')));

    const plan = {
      planVersion: 1, command: 'config set', apply: true,
      ops: [overwrite(claudeDir, 'settings.json', SETTINGS_NEW), overwrite(claudeDir, '.mcp.json', MCP_NEW)],
    };
    const res = await applyPlan({
      plan, targetClaudeDir: claudeDir, mgrStateDir: stateDir,
      assertWritable: PASS_GATE, reason: 'multi-op-integration', pid: process.pid, enableWrites: true,
    });

    // The lifecycle reached committed and BOTH ops applied.
    assert.equal(res.ok, true, `apply failed: ${JSON.stringify(res.diagnostics)}`);
    assert.equal(res.state, 'committed');
    assert.equal(res.applied, true);
    assert.equal(res.opsWritten, 2);

    // BOTH writes happened, byte-for-byte.
    assert.equal(readFileSync(join(claudeDir, 'settings.json'), 'utf8'), SETTINGS_NEW, 'settings.json holds the NEW content');
    assert.equal(readFileSync(join(claudeDir, '.mcp.json'), 'utf8'), MCP_NEW, '.mcp.json holds the NEW content');

    // No atomic-write sidecars remain for either file (clean commit + cleanup).
    for (const f of ['settings.json', '.mcp.json']) {
      assert.ok(!existsSync(join(claudeDir, `${f}.mgr-new`)), `no ${f}.mgr-new leftover`);
      assert.ok(!existsSync(join(claudeDir, `${f}.mgr-old`)), `no ${f}.mgr-old leftover`);
    }

    // The UNRELATED governed file is untouched.
    assert.equal(sha256Hex(readFileSync(join(claudeDir, 'agents', 'a.md'))), agentShaBefore, 'agents/a.md must be unchanged');

    // The journal exists and reads 'committed'.
    const snapDir = join(stateDir, 'snapshots', res.snapshotId);
    const jr = readJournal({ stateDir, snapshotId: res.snapshotId });
    assert.equal(jr.journal && jr.journal.state, 'committed', 'journal must be persisted at committed');

    // The lock was released.
    assert.ok(!existsSync(join(stateDir, 'locks', 'apply.lock')), 'apply lock must be released');

    // ROLLBACK-SAFETY ORACLE: the snapshot captured the PRE-write settings.json, so
    // its manifest preSha256 == the ORIGINAL ("sonnet") hash (snapshot ran BEFORE the writes).
    const manifest = JSON.parse(readFileSync(join(snapDir, 'manifest.json'), 'utf8'));
    const settingsEntry = manifest.files.find((f) => f.path === 'settings.json');
    assert.ok(settingsEntry, 'manifest must record settings.json');
    assert.equal(settingsEntry.preSha256, settingsShaBefore,
      'snapshot must have captured the PRE-write (sonnet) settings.json, not the new content');
  } finally {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

test('apply-multi-op-roundtrip: --paranoid catches a broken-JSON write (file written, journal failed, snapshot intact)', async (t) => {
  const { tarPath, diagnostics } = resolveTar();
  if (!tarPath) {
    t.skip(`system tar not found (${diagnostics.map((d) => d.code).join(',')}) — skipping paranoid round-trip`);
    return;
  }

  const root = mkdtempSync(join(tmpdir(), 'cmgr-apply-paranoid-'));
  const claudeDir = join(root, '.claude');
  const stateDir = join(claudeDir, '.mgr-state');
  mkdirSync(claudeDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });

  try {
    const SETTINGS_ORIG = '{\n  "model": "sonnet"\n}\n';
    const BROKEN = '{ this is : not valid json';

    put(claudeDir, 'settings.json', Buffer.from(SETTINGS_ORIG, 'utf8'));
    const settingsShaBefore = sha256Hex(Buffer.from(SETTINGS_ORIG, 'utf8'));

    const plan = {
      planVersion: 1, command: 'config set', apply: true,
      ops: [overwrite(claudeDir, 'settings.json', BROKEN)],
    };
    // Uses the REAL readFileSync + parseJsonc paranoid re-check (no seam).
    const res = await applyPlan({
      plan, targetClaudeDir: claudeDir, mgrStateDir: stateDir,
      assertWritable: PASS_GATE, reason: 'paranoid-integration', pid: process.pid,
      enableWrites: true, paranoid: true,
    });

    // The write LANDED, then the paranoid re-parse failed → journal failed.
    assert.equal(res.ok, false);
    assert.equal(res.state, 'failed');
    assert.equal(res.applied, true, 'the op WAS written before the paranoid check failed');
    assert.equal(res.opsWritten, 1);
    assert.ok(res.diagnostics.some((d) => d.code === 'apply-paranoid-failed'),
      'apply-paranoid-failed must be present: ' + JSON.stringify(res.diagnostics));

    // The broken content IS on disk (the write happened before the re-check).
    assert.equal(readFileSync(join(claudeDir, 'settings.json'), 'utf8'), BROKEN,
      'settings.json holds the broken content (it WAS written)');

    // The snapshot survives so recover --rollback is possible: files.tar + manifest.json
    // exist, and the manifest's preSha256 == the original VALID bytes' hash.
    const snapDir = join(stateDir, 'snapshots', res.snapshotId);
    assert.ok(existsSync(join(snapDir, 'files.tar')), 'files.tar must exist for recovery');
    assert.ok(existsSync(join(snapDir, 'manifest.json')), 'manifest.json must exist for recovery');
    const manifest = JSON.parse(readFileSync(join(snapDir, 'manifest.json'), 'utf8'));
    const settingsEntry = manifest.files.find((f) => f.path === 'settings.json');
    assert.ok(settingsEntry, 'manifest must record settings.json');
    assert.equal(settingsEntry.preSha256, settingsShaBefore,
      'snapshot captured the original VALID settings.json — a rollback can restore it');

    // The lock was released.
    assert.ok(!existsSync(join(stateDir, 'locks', 'apply.lock')), 'apply lock must be released');
  } finally {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});
