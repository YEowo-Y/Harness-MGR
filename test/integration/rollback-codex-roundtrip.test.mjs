/**
 * P6 write wave · unit 3 — integration/rollback-codex-roundtrip.test.mjs
 *
 * The end-to-end DoD oracle for codex rollback: a FULL snapshot → mutate → rollback
 * round-trip against a REAL temp `~/.codex`-like tree, using the REAL codex-bound
 * write gate (makeAssertWritable + codexDescriptor.writeSurface), the REAL codex
 * snapshot scope, and the REAL system tar (no injected gate/tar seams). The rollback
 * engine is already target-agnostic (manifest-driven); this proves it restores the
 * codex governed surface byte-identical through the codex rollback gate.
 *
 * Golden oracle (the --apply round-trip):
 *   (a) rollbackSnapshot returns ok:true, status:'restored';
 *   (b) config.toml (mutated) is RESTORED byte-identical — the headline: config.toml is
 *       rollback-writable for codex (apply could not edit it, but rollback restores it);
 *   (c) skills/s/SKILL.md (also mutated) restored byte-identical;
 *   (d) ZERO out-of-surface skips — the capture↔rollback parity invariant means every
 *       captured codex file is exactly rollback-writable;
 *   (e) NO .mgr-new/.mgr-old atomic-write sidecar residue.
 *
 * Dry-run oracle: rollback({enableWrites:false, force:true}) → status:'dry-run', the
 * live config.toml STILL reads the mutated bytes (wrote nothing), drift detected.
 *
 * GRACEFUL-SKIP when the system tar is unavailable (mirrors claude-md-rollback).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSnapshot } from '../../src/ops/snapshot.mjs';
import { rollbackSnapshot } from '../../src/ops/rollback.mjs';
import { resolveTar } from '../../src/ops/snapshot-tar.mjs';
import { makeAssertWritable, MGR_STATE_DIRNAME } from '../../src/paths.mjs';
import { codexDescriptor } from '../../src/targets/codex.mjs';

function put(base, rel, bytes) {
  const abs = join(base, ...rel.split('/'));
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, bytes);
}

function allFilePaths(dir) {
  const out = [];
  const walk = (d) => {
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      const abs = join(d, ent.name);
      if (ent.isDirectory()) walk(abs); else out.push(abs);
    }
  };
  walk(dir);
  return out;
}

test('codex rollback round-trip: restores config.toml + skills byte-identical, zero out-of-surface skips, no residue', async (t) => {
  const { tarPath, diagnostics } = resolveTar();
  if (!tarPath) {
    t.skip(`system tar not found (${diagnostics.map((d) => d.code).join(',')}) — skipping codex rollback round-trip`);
    return;
  }

  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'cmgr-codex-rb-')));
  const stateDir = join(tmp, MGR_STATE_DIRNAME);
  mkdirSync(stateDir, { recursive: true });
  // The REAL codex-bound gate: bound to the temp ~/.codex + the codex rollback surface.
  const gate = makeAssertWritable({ configDir: tmp, mgrStateDir: stateDir, surface: codexDescriptor.writeSurface });

  // v1 bytes of the codex governed surface (must round-trip byte-identical).
  const configV1 = Buffer.from('model = "gpt-5.5"\nmodel_context_window = 250000\n', 'utf8');
  const agentsMdV1 = Buffer.from('# AGENTS\nrole = architect\n', 'utf8');
  const skillV1 = Buffer.from('# 技能 v1 café\nstep one\n', 'utf8');
  const promptV1 = Buffer.from('# greet\nhello\n', 'utf8');
  const tomlAgentV1 = Buffer.from('name = "architect"\n', 'utf8');

  try {
    put(tmp, 'config.toml', configV1);
    put(tmp, 'AGENTS.md', agentsMdV1);
    put(tmp, 'hooks.json', Buffer.from('{"hooks":{}}', 'utf8'));
    put(tmp, 'skills/s/SKILL.md', skillV1);
    put(tmp, 'prompts/g.md', promptV1);
    put(tmp, 'agents/architect.toml', tomlAgentV1);
    // A secret that must never be captured (so it can never round-trip).
    put(tmp, 'auth.json', Buffer.from('{"token":"sk-SECRET"}', 'utf8'));

    // 1. Snapshot the codex tree (REAL tar, REAL codex gate, REAL codex scope).
    const snap = await createSnapshot({
      targetClaudeDir: tmp, mgrStateDir: stateDir, reason: 'codex-rollback-test',
      assertWritable: gate, scope: codexDescriptor.snapshotScope, dryRun: false,
    });
    if (!snap.ok && snap.diagnostics.some((d) => /tar/.test(d.code))) {
      t.skip(`snapshot could not run (tar issue): ${snap.diagnostics.map((d) => d.code).join(',')}`);
      return;
    }
    assert.equal(snap.ok, true, `snapshot failed: ${JSON.stringify(snap.diagnostics)}`);
    const snapshotId = snap.snapshotId;
    assert.ok(snap.kept.includes('config.toml'), 'config.toml captured');
    assert.ok(!snap.kept.some((f) => f.includes('auth.json')), 'auth.json NEVER captured');

    // 2. MUTATE the live tree → drift.
    const configV2 = Buffer.from('model = "gpt-4-MUTATED"\n', 'utf8');
    writeFileSync(join(tmp, 'config.toml'), configV2);
    writeFileSync(join(tmp, 'skills', 's', 'SKILL.md'), Buffer.from('# 技能 v2 CHANGED\n', 'utf8'));

    // 3. DRY-RUN (force, enableWrites:false) → writes NOTHING + detects drift.
    const dry = await rollbackSnapshot({
      mgrStateDir: stateDir, targetClaudeDir: tmp, snapshotId,
      assertWritable: gate, force: true, enableWrites: false, expectedTarget: tmp,
    });
    assert.equal(dry.status, 'dry-run', `dry-run: ${JSON.stringify(dry.diagnostics)}`);
    assert.equal(dry.drift.clean, false, 'dry-run detected the drift');
    assert.ok(Buffer.compare(readFileSync(join(tmp, 'config.toml')), configV2) === 0,
      'dry-run must NOT modify the live tree');

    // 4. --apply with force → restore byte-identical through the codex rollback gate.
    const res = await rollbackSnapshot({
      mgrStateDir: stateDir, targetClaudeDir: tmp, snapshotId,
      assertWritable: gate, force: true, enableWrites: true, expectedTarget: tmp,
    });

    // (a) completed.
    assert.equal(res.ok, true, `rollback failed: ${JSON.stringify(res.diagnostics)}`);
    assert.equal(res.status, 'restored');
    // (b) config.toml restored byte-identical to v1 — THE HEADLINE.
    assert.ok(Buffer.compare(readFileSync(join(tmp, 'config.toml')), configV1) === 0,
      'config.toml must be restored byte-identical to v1');
    // (c) skills/s/SKILL.md restored byte-identical.
    assert.ok(Buffer.compare(readFileSync(join(tmp, 'skills', 's', 'SKILL.md')), skillV1) === 0,
      'skills/s/SKILL.md must be restored byte-identical to v1');
    // (d) ZERO out-of-surface skips — capture↔rollback parity for codex.
    assert.deepEqual(res.restore.skipped, [], 'codex captures only rollback-writable files → no skips');
    assert.equal(res.restore.restoredCount, snap.kept.length, 'every captured file was restored');
    // (e) no atomic-write sidecar residue.
    const residue = allFilePaths(tmp).filter((p) => /\.mgr-(new|old)$/.test(p));
    assert.deepEqual(residue, [], `no .mgr-new/.mgr-old residue, found: ${residue.join(', ')}`);
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});
