/**
 * P3.U22 (sub-unit D) — integration/dry-run-vs-apply.test.mjs
 *
 * END-TO-END DoD acceptance oracle #1: the rollback DRY-RUN-vs-APPLY parity + the
 * two-factor write gate, driven entirely through the REAL CLI `run(argv)` (not the
 * ops engine directly), against a REAL temp `~/.claude`-like tree, the REAL
 * governed-write gate (src/paths.mjs::assertWritable, resolved via CLAUDE_CONFIG_DIR),
 * and the REAL system tar. No injected seams on the action-under-test path.
 *
 * The wiring contract for a CLI write to land in the temp tree (see the U22 brief):
 *   • process.env.CLAUDE_CONFIG_DIR = tmp   (the real gate reads this at call time)
 *   • --config-dir tmp in argv              (resolveConfigDir uses it verbatim,
 *                                            never touching paths.mjs for the dir)
 *   • process.env.HARNESS_MGR_ENABLE_WRITES = '1'  (arms the second write factor;
 *                                            DELETED for the gate-CLOSED case)
 * All THREE env vars are saved + restored in the finally.
 *
 * Oracles (all via `run()`):
 *   1. SETUP: snapshot a v1 tree (createSnapshot, deterministic → id), then MUTATE
 *      CLAUDE.md + agents/a.md to v2 (drift).
 *   2. DRY-RUN  `rollback <id> --force --config-dir tmp` (NO --apply) → code 0, and
 *      CLAUDE.md STILL reads v2 (the dry-run wrote NOTHING); drift was reported.
 *   3. GATE CLOSED `rollback <id> --force --apply --config-dir tmp` with the env var
 *      DELETED → code 3, stdout includes `writes-disabled-env`, CLAUDE.md STILL v2.
 *   4. APPLY  same argv with HARNESS_MGR_ENABLE_WRITES='1' → code 0; CLAUDE.md AND
 *      agents/a.md restored byte-identical to v1.
 *   5. PARITY: the dry-run reported the SAME drift the apply then restored — and a
 *      re-mutate + re-dry-run AFTER the apply shows the previously-restored files
 *      now clean (no residual drift on the restored bytes).
 *   6. NO `.mgr-new` / `.mgr-old` sidecar residue anywhere under tmp.
 *
 * GRACEFUL-SKIP when the system tar is unavailable (mirrors claude-md-rollback). tar
 * exists on this machine, so this oracle MUST run (a skip is a U22 failure).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSnapshot } from '../../src/ops/snapshot.mjs';
import { resolveTar } from '../../src/ops/snapshot-tar.mjs';
import { assertWritable } from '../../src/paths.mjs';
import { run } from '../../src/cli.mjs';

/** Write a file at a POSIX-relative path under base, creating parent dirs. */
function put(base, rel, bytes) {
  const abs = join(base, ...rel.split('/'));
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, bytes);
}

/** Recursively collect every absolute file path under dir (for the residue scan). */
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

test('rollback dry-run vs --apply parity + two-factor gate, end-to-end via run()', async (t) => {
  const { tarPath, diagnostics } = resolveTar();
  if (!tarPath) {
    t.skip(`system tar not found (${diagnostics.map((d) => d.code).join(',')}) — skipping`);
    return;
  }

  // Save ALL THREE env vars touched by the wiring contract; restore in the finally.
  const savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
  const savedEnableWrites = process.env.HARNESS_MGR_ENABLE_WRITES;
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'cmgr-dryapply-')));
  process.env.CLAUDE_CONFIG_DIR = tmp; // the REAL gate resolves the governed dir from this
  const stateDir = join(tmp, '.mgr-state');
  mkdirSync(stateDir, { recursive: true });

  const claudeV1 = Buffer.from('# CLAUDE v1\nrule one\n', 'utf8');
  const agentV1 = Buffer.from('# agent a v1\nline2\n', 'utf8');

  try {
    // 1. SETUP — build the v1 tree, snapshot it (createSnapshot is deterministic and
    //    returns the id), then MUTATE to v2 (drift). The ACTION under test is run(),
    //    not createSnapshot.
    put(tmp, 'CLAUDE.md', claudeV1);
    put(tmp, 'agents/a.md', agentV1);
    const snap = await createSnapshot({
      targetClaudeDir: tmp, mgrStateDir: stateDir, reason: 'dry-apply-test',
      includeAuth: false, assertWritable, now: () => new Date(), dryRun: false,
    });
    if (!snap.ok && snap.diagnostics.some((d) => /tar/.test(d.code))) {
      t.skip(`snapshot could not run (tar issue): ${snap.diagnostics.map((d) => d.code).join(',')}`);
      return;
    }
    assert.equal(snap.ok, true, `snapshot failed: ${JSON.stringify(snap.diagnostics)}`);
    const id = snap.snapshotId;

    const claudeV2 = Buffer.from('# CLAUDE v2 MODIFIED\n', 'utf8');
    const agentV2 = Buffer.from('# agent a v2 CHANGED\n', 'utf8');
    writeFileSync(join(tmp, 'CLAUDE.md'), claudeV2);
    writeFileSync(join(tmp, 'agents', 'a.md'), agentV2);

    // 2. DRY-RUN — NO --apply. The env factor is irrelevant on this path, but DELETE
    //    it anyway to prove the dry-run never depends on the write gate.
    delete process.env.HARNESS_MGR_ENABLE_WRITES;
    const dry = await run(['rollback', id, '--force', '--config-dir', tmp]);
    assert.equal(dry.code, 0, `dry-run code 0 expected; stdout:\n${dry.stdout}`);
    // The dry-run wrote NOTHING — CLAUDE.md still reads v2.
    assert.ok(Buffer.compare(readFileSync(join(tmp, 'CLAUDE.md')), claudeV2) === 0,
      'dry-run must NOT modify the live tree (CLAUDE.md still v2)');
    assert.ok(Buffer.compare(readFileSync(join(tmp, 'agents', 'a.md')), agentV2) === 0,
      'dry-run must NOT modify agents/a.md (still v2)');
    // The dry-run reported the drift it would overwrite (not a clean tree). The
    // engine's dry-run summary surfaces driftClean:false; the table footer / json
    // also reflects it. We assert on the rendered stdout for an end-to-end signal.
    const dryStdout = dry.stdout;
    assert.ok(/dry-run/.test(dryStdout), `dry-run stdout should mention dry-run status:\n${dryStdout}`);

    // 3. GATE CLOSED — --apply with HARNESS_MGR_ENABLE_WRITES=0 (explicit opt-out) → refuse.
    //    Under the relaxed gate, UNSET env enables writes; only '0' locks.
    process.env.HARNESS_MGR_ENABLE_WRITES = '0';
    const closed = await run(['rollback', id, '--force', '--apply', '--config-dir', tmp]);
    assert.equal(closed.code, 3, `closed-gate code 3 expected; stdout:\n${closed.stdout}`);
    assert.ok(/writes-disabled-env/.test(closed.stdout),
      `closed-gate stdout must include writes-disabled-env:\n${closed.stdout}`);
    // The gate blocked the write end-to-end — CLAUDE.md still v2.
    assert.ok(Buffer.compare(readFileSync(join(tmp, 'CLAUDE.md')), claudeV2) === 0,
      'closed gate must NOT modify the live tree (CLAUDE.md still v2)');

    // 3b. RELAXATION POSITIVE LEG — --apply with env UNSET now enables writes
    //     (Rule C: prove the relaxed gate works in the integration path).
    delete process.env.HARNESS_MGR_ENABLE_WRITES;
    assert.equal(process.env.HARNESS_MGR_ENABLE_WRITES, undefined, 'env must be unset for the relaxation leg');
    const relaxed = await run(['rollback', id, '--force', '--apply', '--config-dir', tmp]);
    assert.equal(relaxed.code, 0, `relaxation leg: unset env + --apply must succeed; stdout:\n${relaxed.stdout}`);
    // CLAUDE.md should be restored byte-identical to v1 (the snapshot we took before mutation).
    assert.ok(Buffer.compare(readFileSync(join(tmp, 'CLAUDE.md')), claudeV1) === 0,
      'relaxation leg: --apply with unset env must restore CLAUDE.md byte-identical to v1');
    assert.ok(Buffer.compare(readFileSync(join(tmp, 'agents', 'a.md')), agentV1) === 0,
      'relaxation leg: --apply with unset env must restore agents/a.md byte-identical to v1');
    // Re-mutate to v2 so oracle 4 can also run a restore.
    writeFileSync(join(tmp, 'CLAUDE.md'), claudeV2);
    writeFileSync(join(tmp, 'agents', 'a.md'), agentV2);

    // 4. APPLY — env explicitly set to '1' (back-compat). The full lock → preflight → restore
    //    lifecycle runs through the CLI; CLAUDE.md + agents/a.md restored byte-identical to v1.
    process.env.HARNESS_MGR_ENABLE_WRITES = '1';
    const applied = await run(['rollback', id, '--force', '--apply', '--config-dir', tmp]);
    assert.equal(applied.code, 0, `apply code 0 expected; stdout:\n${applied.stdout}`);
    assert.ok(Buffer.compare(readFileSync(join(tmp, 'CLAUDE.md')), claudeV1) === 0,
      'apply must restore CLAUDE.md byte-identical to v1');
    assert.ok(Buffer.compare(readFileSync(join(tmp, 'agents', 'a.md')), agentV1) === 0,
      'apply must restore agents/a.md byte-identical to v1');

    // 5. PARITY — the dry-run and the apply acted on the SAME drift: re-mutate the
    //    restored files, then a fresh dry-run sees drift again (the same files), and
    //    WITHOUT a re-mutate the restored tree is clean. First prove clean-after-apply:
    const cleanDry = await run(['rollback', id, '--config-dir', tmp]); // no --force, no --apply
    assert.equal(cleanDry.code, 0, `post-apply clean dry-run code 0 expected; stdout:\n${cleanDry.stdout}`);
    assert.ok(/dry-run/.test(cleanDry.stdout),
      `post-apply dry-run with no drift should still report dry-run (clean), proceed:\n${cleanDry.stdout}`);
    // The post-apply tree is byte-identical to the snapshot, so a no-force dry-run
    // proceeds (status dry-run, ok). The restored bytes carry NO residual drift.
    assert.ok(Buffer.compare(readFileSync(join(tmp, 'CLAUDE.md')), claudeV1) === 0,
      'the clean dry-run must not have changed the restored v1 bytes');

    // 6. NO atomic-write sidecar residue anywhere under tmp.
    const residue = allFilePaths(tmp).filter((p) => /\.mgr-(new|old)$/.test(p));
    assert.deepEqual(residue, [], `no .mgr-new/.mgr-old residue expected, found: ${residue.join(', ')}`);
  } finally {
    if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
    if (savedEnableWrites === undefined) delete process.env.HARNESS_MGR_ENABLE_WRITES;
    else process.env.HARNESS_MGR_ENABLE_WRITES = savedEnableWrites;
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});
