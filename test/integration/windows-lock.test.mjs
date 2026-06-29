/**
 * P3.U22 (sub-unit D) — integration/windows-lock.test.mjs
 *
 * END-TO-END DoD acceptance oracle #3: the PID-based apply-lock contention that
 * protects every governed write, driven through the REAL CLI `run(argv)`, against a
 * REAL temp `~/.claude`-like tree, the REAL governed-write gate
 * (src/paths.mjs::assertWritable via CLAUDE_CONFIG_DIR), and the REAL system tar.
 *
 * SCOPE NOTE: the literal Windows exclusive-file-lock EBUSY/EPERM retry lives in
 * atomic-write.mjs's `withRetry` and is covered by its own unit tests. THIS file
 * proves the higher-level PID-based apply-lock lifecycle end-to-end: a live-held lock
 * BLOCKS a governed write, `lock` reports the holder, `lock --break-lock` removes a
 * live-held lock (with the live-holder warning), and the write then PROCEEDS.
 *
 * The same three-env-var wiring contract as the sibling U22 oracles:
 *   • CLAUDE_CONFIG_DIR = tmp · --config-dir tmp · HARNESS_MGR_ENABLE_WRITES = '1'
 * all saved + restored in the finally. The lock file lives at
 * `<mgrStateDir>/locks/apply.lock` and is JSON `{pid, startTime, hostname}`.
 *
 * Oracles (all the ACTIONS via `run()`):
 *   1. SETUP: snapshot a v1 tree, MUTATE CLAUDE.md → v2 (drift). Hand-write a lock
 *      file held by `process.pid` (GUARANTEED alive → deterministic, no flaky pid).
 *   2. LIVE-HELD BLOCKS: `rollback <id> --force --apply` → code 3 (lock-failed), and
 *      CLAUDE.md STILL v2 (the lock blocked the restore — nothing written). stdout
 *      mentions the lock being held.
 *   3. STATUS: `lock` → code 0, reports present + holder pid + holderAlive true.
 *   4. BREAK: `lock --break-lock --apply` → code 0, stdout includes `apply-lock-broken`
 *      AND `lock-broke-live-holder`; the lock file is GONE on disk.
 *   5. AFTER-BREAK PROCEEDS: `rollback <id> --force --apply` → code 0; CLAUDE.md
 *      restored byte-identical to v1 (the lock no longer blocks — the full lifecycle
 *      works through the CLI).
 *   6. NO `.mgr-new` / `.mgr-old` residue.
 *
 * GRACEFUL-SKIP when the system tar is unavailable. tar exists here, so this MUST run.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync,
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

test('apply-lock contention: live-held BLOCKS the write, break + recover proceeds, end-to-end via run()', async (t) => {
  const { tarPath, diagnostics } = resolveTar();
  if (!tarPath) {
    t.skip(`system tar not found (${diagnostics.map((d) => d.code).join(',')}) — skipping`);
    return;
  }

  const savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
  const savedEnableWrites = process.env.HARNESS_MGR_ENABLE_WRITES;
  const tmp = mkdtempSync(join(tmpdir(), 'cmgr-winlock-'));
  process.env.CLAUDE_CONFIG_DIR = tmp;
  process.env.HARNESS_MGR_ENABLE_WRITES = '1'; // arm the write factor for every --apply leg
  const stateDir = join(tmp, '.mgr-state');
  mkdirSync(stateDir, { recursive: true });
  const lockFile = join(stateDir, 'locks', 'apply.lock');

  const claudeV1 = Buffer.from('# CLAUDE v1\nkeep me\n', 'utf8');

  try {
    // 1. SETUP — snapshot the v1 tree, then MUTATE CLAUDE.md → v2 (drift).
    put(tmp, 'CLAUDE.md', claudeV1);
    const snap = await createSnapshot({
      targetClaudeDir: tmp, mgrStateDir: stateDir, reason: 'winlock-test',
      includeAuth: false, assertWritable, now: () => new Date(), dryRun: false,
    });
    if (!snap.ok && snap.diagnostics.some((d) => /tar/.test(d.code))) {
      t.skip(`snapshot could not run (tar issue): ${snap.diagnostics.map((d) => d.code).join(',')}`);
      return;
    }
    assert.equal(snap.ok, true, `snapshot failed: ${JSON.stringify(snap.diagnostics)}`);
    const id = snap.snapshotId;

    const claudeV2 = Buffer.from('# CLAUDE v2 MODIFIED\n', 'utf8');
    writeFileSync(join(tmp, 'CLAUDE.md'), claudeV2);

    // Hand-write a lock held by THIS process (process.pid is guaranteed alive →
    // deterministic liveness, no flaky external pid). createSnapshot took no lock,
    // so this is the only holder.
    mkdirSync(join(stateDir, 'locks'), { recursive: true });
    writeFileSync(lockFile, JSON.stringify({ pid: process.pid, startTime: new Date().toISOString(), hostname: 'test' }));

    // 2. LIVE-HELD BLOCKS THE WRITE — rollback --apply must refuse (lock-failed, code 3)
    //    and leave CLAUDE.md at v2 (nothing restored).
    const blocked = await run(['rollback', id, '--force', '--apply', '--config-dir', tmp]);
    assert.equal(blocked.code, 3, `live-held lock should block rollback with code 3; stdout:\n${blocked.stdout}`);
    assert.ok(/lock/.test(blocked.stdout),
      `blocked rollback stdout should mention the lock:\n${blocked.stdout}`);
    assert.ok(Buffer.compare(readFileSync(join(tmp, 'CLAUDE.md')), claudeV2) === 0,
      'the held lock must block the restore — CLAUDE.md still v2');
    // The lock file is untouched by the blocked attempt.
    assert.ok(existsSync(lockFile), 'the lock file must still be present after the blocked attempt');

    // 3. STATUS — `lock` reports the lock present + holder pid + alive. The status
    //    result {present, holder, holderAlive} renders as a kv table with distinct
    //    rows: `present true`, `holder {...pid:NNN...}`, `holderAlive true`.
    const status = await run(['lock', '--config-dir', tmp]);
    assert.equal(status.code, 0, `lock status code 0 expected; stdout:\n${status.stdout}`);
    assert.ok(new RegExp(`"pid":${process.pid}`).test(status.stdout),
      `lock status should report the holder pid ${process.pid}:\n${status.stdout}`);
    assert.ok(/present\s+true/.test(status.stdout),
      `lock status should report present true:\n${status.stdout}`);
    assert.ok(/holderAlive\s+true/.test(status.stdout),
      `lock status should report holderAlive true:\n${status.stdout}`);

    // 4. BREAK — `lock --break-lock --apply` removes the live-held lock; both the
    //    apply-lock-broken warn AND the live-holder warn surface; the file is gone.
    const broke = await run(['lock', '--break-lock', '--apply', '--config-dir', tmp]);
    assert.equal(broke.code, 0, `break code 0 expected; stdout:\n${broke.stdout}`);
    assert.ok(/apply-lock-broken/.test(broke.stdout),
      `break stdout should include apply-lock-broken:\n${broke.stdout}`);
    assert.ok(/lock-broke-live-holder/.test(broke.stdout),
      `break stdout should include lock-broke-live-holder (we broke a live-held lock):\n${broke.stdout}`);
    assert.ok(!existsSync(lockFile), 'the lock file must be gone after --break-lock');

    // 5. AFTER-BREAK THE WRITE PROCEEDS — rollback --apply now restores v1.
    const restored = await run(['rollback', id, '--force', '--apply', '--config-dir', tmp]);
    assert.equal(restored.code, 0, `post-break rollback code 0 expected; stdout:\n${restored.stdout}`);
    assert.ok(Buffer.compare(readFileSync(join(tmp, 'CLAUDE.md')), claudeV1) === 0,
      'after breaking the lock, rollback must restore CLAUDE.md byte-identical to v1');
    // The rollback acquired + released its own lock cleanly — no lock file left behind.
    assert.ok(!existsSync(lockFile), 'rollback must release its own apply lock (no residue lock file)');

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
