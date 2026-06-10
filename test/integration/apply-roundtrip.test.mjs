/**
 * P3.U12 — integration/apply-roundtrip.test.mjs
 *
 * The HEADLINE DoD for the apply orchestrator: a FULL end-to-end run of applyPlan
 * against a REAL temp `~/.claude`-like tree using the REAL system tar (via the real
 * createSnapshot), proving that the planned→snapshotted preamble:
 *   - acquires + releases the apply lock,
 *   - captures a real snapshot (files.tar + manifest.json) into .mgr-state,
 *   - persists a journal in state 'snapshotted',
 *   - and — the GATE-SAFE oracle — writes NOTHING to the governed config.
 *
 * Falsifiable oracle: a recursive {relpath -> sha256} map of the governed tree
 * (EXCLUDING the .mgr-state subtree) is captured BEFORE and AFTER applyPlan; the
 * two maps must be deepEqual. If U12 ever wrote a governed file (e.g. applied the
 * patch op), the AFTER map diverges and this test fails.
 *
 * GRACEFUL-SKIP when the system tar is unavailable (mirrors the snapshot
 * round-trip). assertWritable is injected as a passthrough so the test does not
 * depend on real ~/.claude path resolution (the real gate is exercised by
 * selftest --boundary).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
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

/**
 * Recursively map {posixRelPath -> sha256} for every file under dir, SKIPPING any
 * path whose first segment is `skipTop` (the .mgr-state subtree). This is the
 * fingerprint of the governed config surface the apply must not touch.
 */
function hashTree(dir, skipTop) {
  /** @type {Record<string,string>} */
  const out = {};
  const walk = (d) => {
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      const abs = join(d, ent.name);
      const rel = relative(dir, abs).split(sep).join('/');
      if (rel.split('/')[0] === skipTop) continue; // exclude .mgr-state
      if (ent.isDirectory()) walk(abs);
      else if (ent.isFile()) out[rel] = sha256Hex(readFileSync(abs));
    }
  };
  walk(dir);
  return out;
}

/** A plan with one patch op that would (in a later unit) modify settings.json. */
function makePlan(targetClaudeDir) {
  return {
    planVersion: 1,
    command: 'config set',
    ops: [{
      kind: 'patch', target: join(targetClaudeDir, 'settings.json'), summary: 'set model to opus',
      pointer: '/model', before: 'sonnet', after: 'opus',
    }],
    apply: true,
  };
}

test('apply-roundtrip: planned→snapshotted writes a snapshot+journal but NOTHING to governed config', async (t) => {
  const { tarPath, diagnostics } = resolveTar();
  if (!tarPath) {
    t.skip(`system tar not found (${diagnostics.map((d) => d.code).join(',')}) — skipping apply round-trip`);
    return;
  }

  const root = mkdtempSync(join(tmpdir(), 'cmgr-apply-rt-'));
  const claudeDir = join(root, '.claude');
  const stateDir = join(claudeDir, '.mgr-state');
  mkdirSync(claudeDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });

  try {
    // Governed files (kept) + a planted secret (must be dropped, never archived).
    put(claudeDir, 'agents/a.md', Buffer.from('# agent a\nline2\n', 'utf8'));
    put(claudeDir, 'skills/s/SKILL.md', Buffer.from('# 技能 café\nx\n', 'utf8'));
    put(claudeDir, 'settings.json', Buffer.from('{\n  "model": "sonnet"\n}\n', 'utf8'));
    put(claudeDir, 'hooks/leaked.pem', Buffer.from('-----BEGIN OPENSSH PRIVATE KEY-----\nQUJD\n-----END OPENSSH PRIVATE KEY-----\n', 'utf8'));

    // FINGERPRINT the governed surface BEFORE (excluding .mgr-state).
    const before = hashTree(claudeDir, '.mgr-state');

    const res = await applyPlan({
      plan: makePlan(claudeDir), targetClaudeDir: claudeDir, mgrStateDir: stateDir,
      assertWritable: PASS_GATE, reason: 'integration', pid: process.pid,
    });

    // apply reached snapshotted and stopped — nothing was applied.
    assert.equal(res.ok, true, `apply failed: ${JSON.stringify(res.diagnostics)}`);
    assert.equal(res.state, 'snapshotted');
    assert.equal(res.applied, false);
    assert.ok(res.diagnostics.some((d) => d.code === 'apply-writes-disabled'), 'writes-disabled info present');

    // THE GATE-SAFE ORACLE: the governed surface is byte-for-byte unchanged.
    const after = hashTree(claudeDir, '.mgr-state');
    assert.deepEqual(after, before, 'apply must NOT modify any governed config file');
    // In particular, the patch op did NOT run: settings.json still says sonnet.
    assert.match(readFileSync(join(claudeDir, 'settings.json'), 'utf8'), /"model":\s*"sonnet"/);

    // The snapshot artifacts exist in .mgr-state.
    const snapDir = join(stateDir, 'snapshots', res.snapshotId);
    assert.ok(existsSync(join(snapDir, 'files.tar')), 'files.tar must exist');
    assert.ok(existsSync(join(snapDir, 'manifest.json')), 'manifest.json must exist');
    assert.equal(res.manifestPath, join(snapDir, 'manifest.json'));
    assert.equal(res.archivePath, join(snapDir, 'files.tar'));

    // The journal exists and is in state 'snapshotted'.
    assert.ok(existsSync(join(snapDir, 'apply-journal.json')), 'apply-journal.json must exist');
    assert.equal(res.journalPath, join(snapDir, 'apply-journal.json'));
    const jr = readJournal({ stateDir, snapshotId: res.snapshotId });
    assert.equal(jr.journal && jr.journal.state, 'snapshotted', 'journal must be persisted at snapshotted');

    // The lock was released (no leftover lock file).
    assert.ok(!existsSync(join(stateDir, 'locks', 'apply.lock')), 'apply lock must be released');

    // MIGRATED (reversibility fix): applyPlan passes skipSecretFilter:true so the
    // pre-mutation snapshot captures the FULL governed surface including files whose
    // name or content would normally trigger the secrets filter. hooks/leaked.pem is
    // now PRESENT in the manifest (a governed file must be in the undo-point).
    // The OUTPUT/sharing redaction surfaces are separate and unaffected by this change.
    const manifest = JSON.parse(readFileSync(res.manifestPath, 'utf8'));
    assert.ok(manifest.files.some((f) => f.path === 'hooks/leaked.pem'),
      'governed file present in manifest even if PEM-named (reversibility snapshot captures full surface)');
    // The secret still resides on disk in the governed tree (not deleted by the snapshot).
    assert.ok(before['hooks/leaked.pem'], 'the secret remains in the governed tree (not deleted)');
  } finally {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

test('apply-roundtrip: a pre-existing live lock blocks apply (no snapshot, lock left intact)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cmgr-apply-rt-held-'));
  const claudeDir = join(root, '.claude');
  const stateDir = join(claudeDir, '.mgr-state');
  mkdirSync(claudeDir, { recursive: true });
  mkdirSync(join(stateDir, 'locks'), { recursive: true });

  // Pre-write a lock owned by THIS (live) process so the liveness check sees it held.
  const lockFile = join(stateDir, 'locks', 'apply.lock');
  const lockPayload = { pid: process.pid, startTime: new Date().toISOString(), hostname: 'test-host' };
  writeFileSync(lockFile, JSON.stringify(lockPayload));

  try {
    put(claudeDir, 'agents/a.md', Buffer.from('x\n', 'utf8'));

    const res = await applyPlan({
      plan: makePlan(claudeDir), targetClaudeDir: claudeDir, mgrStateDir: stateDir,
      assertWritable: PASS_GATE, reason: 'held', pid: 1, // OUR pid differs from the holder
    });

    assert.equal(res.ok, false);
    assert.equal(res.lock.acquired, false);
    assert.equal(res.lock.reason, 'held', JSON.stringify(res.diagnostics));
    assert.ok(res.diagnostics.some((d) => d.code === 'apply-lock-held'));

    // NO snapshot dir was created (we bailed before snapshotting).
    assert.ok(!existsSync(join(stateDir, 'snapshots')), 'no snapshots dir on a held lock');

    // CRITICAL: the pre-existing lock is untouched — we did not release a lock we
    // never acquired. Its bytes are exactly what we wrote.
    assert.ok(existsSync(lockFile), 'the held lock file must still exist');
    const stillThere = JSON.parse(readFileSync(lockFile, 'utf8'));
    assert.equal(stillThere.pid, lockPayload.pid);
    assert.equal(stillThere.startTime, lockPayload.startTime);
    // (sanity: it is a regular file, not clobbered into a dir)
    assert.ok(statSync(lockFile).isFile());
  } finally {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});
