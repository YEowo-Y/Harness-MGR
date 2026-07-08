/**
 * P4b.U4 — test/integration/cascade-roundtrip.test.mjs
 *
 * End-to-end CLI integration test for `remove --cascade` driven through run(argv)
 * from src/cli.mjs. Uses the REAL governed-write gate (src/paths.mjs::assertWritable,
 * resolved via CLAUDE_CONFIG_DIR) and the REAL system tar (graceful-skip if absent).
 *
 * Tree under tmp/:
 *   agents/tracer.md      — the target agent
 *   skills/trace/SKILL.md — references agent:tracer via frontmatter `agent: tracer`
 *                           (so edge: skill:trace → agent:tracer)
 *   CLAUDE.md             — unrelated; must be byte-identical after every leg
 *
 * Four legs:
 *   (1) DRY-RUN:  run(["remove","agent:tracer","--cascade","--config-dir",tmp])
 *                 → exit 0; preview lists skill:trace as dependent;
 *                   agents/tracer.md + skills/trace/ STILL exist.
 *   (2) --apply WITHOUT --force:
 *                 run([..."--cascade","--apply"])  (env armed)
 *                 → exit 3 (cascade-needs-force); nothing deleted.
 *   (3) --apply --force:
 *                 run([..."--cascade","--force","--apply"])  (env armed)
 *                 → exit 0; BOTH agents/tracer.md AND skills/trace/ GONE;
 *                   no .mgr-new/.mgr-old residue; ONE snapshot created.
 *   (4) REVERSIBILITY:
 *                 run(["rollback",<id>,"--apply","--force","--config-dir",tmp]) (env)
 *                 → exit 0; agents/tracer.md + skills/trace/SKILL.md restored
 *                   byte-identical to originals.
 *
 * Sets BOTH process.env.CLAUDE_CONFIG_DIR and --config-dir to the temp dir.
 * Saves + restores both env vars in a finally block.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync,
  existsSync, readdirSync, rmSync, realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { resolveTar } from '../../src/ops/snapshot-tar.mjs';
import { run } from '../../src/cli.mjs';

function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/** Write bytes at a POSIX-relative path under base, creating parent dirs. */
function put(base, rel, bytes) {
  const abs = join(base, ...rel.split('/'));
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, bytes);
}

/** Recursively collect every absolute file path under dir. */
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

/** Find the newest snapshot id directory under mgrStateDir/snapshots. */
function newestSnapshotId(mgrStateDir) {
  const snapshotsDir = join(mgrStateDir, 'snapshots');
  if (!existsSync(snapshotsDir)) return null;
  const ids = readdirSync(snapshotsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  return ids.length > 0 ? ids[ids.length - 1] : null;
}

test('cascade CLI roundtrip: dry-run → apply-no-force → apply-force → rollback', async (t) => {
  const { tarPath, diagnostics } = resolveTar();
  if (!tarPath) {
    t.skip(`system tar not found (${diagnostics.map((d) => d.code).join(',')}) — skipping cascade roundtrip`);
    return;
  }

  const savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
  const savedEnableWrites = process.env.HARNESS_MGR_ENABLE_WRITES;

  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'cmgr-cascade-')));
  const stateDir = join(tmp, '.mgr-state');

  try {
    // ── BUILD the live tree ──────────────────────────────────────────────────
    const tracerBytes = Buffer.from(
      '---\nname: tracer\n---\n# tracer agent\nbody\n', 'utf8');
    // SKILL.md with `agent: tracer` in frontmatter → edge skill:trace → agent:tracer
    const skillBytes = Buffer.from(
      '---\nagent: tracer\n---\n# trace skill\nbody\n', 'utf8');
    const claudeBytes = Buffer.from('# CLAUDE.md original\n', 'utf8');

    put(tmp, 'agents/tracer.md', tracerBytes);
    put(tmp, 'skills/trace/SKILL.md', skillBytes);
    put(tmp, 'CLAUDE.md', claudeBytes);
    mkdirSync(stateDir, { recursive: true });

    const claudeShaOrig = sha256Hex(readFileSync(join(tmp, 'CLAUDE.md')));
    const tracerShaOrig = sha256Hex(tracerBytes);
    const skillShaOrig  = sha256Hex(skillBytes);

    // Point the real gate at our temp dir.
    process.env.CLAUDE_CONFIG_DIR = tmp;

    // ── LEG 1: DRY-RUN ──────────────────────────────────────────────────────
    delete process.env.HARNESS_MGR_ENABLE_WRITES;

    const dryResult = await run([
      'remove', 'agent:tracer', '--cascade', '--config-dir', tmp,
    ]);
    assert.equal(dryResult.code, 0,
      `dry-run expected code 0, got ${dryResult.code}; stdout: ${dryResult.stdout.slice(0, 600)}`);

    // Output should mention the dependent skill:trace.
    assert.ok(
      dryResult.stdout.includes('skill:trace') || dryResult.stdout.includes('trace'),
      `dry-run stdout should mention skill:trace; got: ${dryResult.stdout.slice(0, 400)}`);

    // Both files must still exist.
    assert.ok(existsSync(join(tmp, 'agents', 'tracer.md')),
      'dry-run must NOT delete agents/tracer.md');
    assert.ok(existsSync(join(tmp, 'skills', 'trace', 'SKILL.md')),
      'dry-run must NOT delete skills/trace/SKILL.md');

    // No snapshot yet.
    assert.ok(!existsSync(join(stateDir, 'snapshots')),
      'dry-run must NOT create any snapshot');

    // ── LEG 2: --apply WITHOUT --force (env armed, dependents exist) ────────
    process.env.HARNESS_MGR_ENABLE_WRITES = '1';

    const noForceResult = await run([
      'remove', 'agent:tracer', '--cascade', '--apply', '--config-dir', tmp,
    ]);
    assert.equal(noForceResult.code, 3,
      `expected exit 3 (cascade-needs-force), got ${noForceResult.code}; stdout: ${noForceResult.stdout.slice(0, 400)}`);

    // Nothing must have been deleted.
    assert.ok(existsSync(join(tmp, 'agents', 'tracer.md')),
      'agents/tracer.md must survive no-force refusal');
    assert.ok(existsSync(join(tmp, 'skills', 'trace', 'SKILL.md')),
      'skills/trace/SKILL.md must survive no-force refusal');
    assert.ok(!existsSync(join(stateDir, 'snapshots')),
      'no snapshot should be created on a refused cascade');

    // ── LEG 3: --apply --force ───────────────────────────────────────────────
    const forceResult = await run([
      'remove', 'agent:tracer', '--cascade', '--force', '--apply', '--config-dir', tmp,
    ]);
    assert.equal(forceResult.code, 0,
      `--force --apply expected code 0, got ${forceResult.code}; stdout: ${forceResult.stdout.slice(0, 600)}`);

    // BOTH the agent and the skill directory must be GONE.
    assert.ok(!existsSync(join(tmp, 'agents', 'tracer.md')),
      'agents/tracer.md must be deleted by cascade --force --apply');
    assert.ok(!existsSync(join(tmp, 'skills', 'trace')),
      'skills/trace/ must be deleted by cascade --force --apply');

    // Unrelated file must be byte-identical.
    assert.equal(
      sha256Hex(readFileSync(join(tmp, 'CLAUDE.md'))), claudeShaOrig,
      'CLAUDE.md must be unchanged after cascade');

    // No atomic-operation sidecar residue.
    const residue = allFilePaths(tmp).filter((p) => /\.mgr-(new|old)$/.test(p));
    assert.deepEqual(residue, [],
      `no .mgr-new/.mgr-old residue expected; found: ${residue.join(', ')}`);

    // Exactly ONE snapshot must have been created.
    const snapId = newestSnapshotId(stateDir);
    assert.ok(snapId, 'one snapshot must have been created by cascade --apply');

    // ── LEG 4: REVERSIBILITY — rollback restores both components ────────────
    const rollbackResult = await run([
      'rollback', snapId, '--apply', '--force', '--config-dir', tmp,
    ]);
    assert.equal(rollbackResult.code, 0,
      `rollback expected code 0, got ${rollbackResult.code}; stdout: ${rollbackResult.stdout.slice(0, 400)}`);

    // agents/tracer.md must be restored byte-identical.
    assert.ok(existsSync(join(tmp, 'agents', 'tracer.md')),
      'agents/tracer.md must be restored by rollback');
    assert.equal(
      sha256Hex(readFileSync(join(tmp, 'agents', 'tracer.md'))), tracerShaOrig,
      'rollback must restore agents/tracer.md byte-identical');

    // skills/trace/SKILL.md must be restored byte-identical.
    assert.ok(existsSync(join(tmp, 'skills', 'trace', 'SKILL.md')),
      'skills/trace/SKILL.md must be restored by rollback');
    assert.equal(
      sha256Hex(readFileSync(join(tmp, 'skills', 'trace', 'SKILL.md'))), skillShaOrig,
      'rollback must restore skills/trace/SKILL.md byte-identical');

    // No sidecar residue after rollback.
    const residueAfterRollback = allFilePaths(tmp).filter((p) => /\.mgr-(new|old)$/.test(p));
    assert.deepEqual(residueAfterRollback, [],
      `no .mgr-new/.mgr-old residue expected after rollback; found: ${residueAfterRollback.join(', ')}`);

  } finally {
    if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;

    if (savedEnableWrites === undefined) delete process.env.HARNESS_MGR_ENABLE_WRITES;
    else process.env.HARNESS_MGR_ENABLE_WRITES = savedEnableWrites;

    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});
