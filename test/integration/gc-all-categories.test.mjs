/**
 * P3.U21 — integration/gc-all-categories.test.mjs
 *
 * THE acceptance oracle for P3.U21's gc wiring: "`snapshot gc` exercises all FOUR
 * cleanup categories". Driven entirely through the REAL CLI `run(argv)` (not the ops
 * layer directly), against a REAL temp `.mgr-state`, the REAL governed-write gate
 * (src/paths.mjs::assertWritable resolved via CLAUDE_CONFIG_DIR), with NO injected
 * seams on the action-under-test path.
 *
 * The four categories:
 *   1. SNAPSHOTS   — `--keep 1` prunes all but the newest, EXCEPT a pinned one (the
 *                    pin force-retains regardless of --keep). Proves pin-retention +
 *                    snapshot gc.
 *   2. AUDIT-LARGE — an UNREFERENCED `audit-large/orphan.json` is deleted; a
 *                    REFERENCED `audit-large/referenced.json` (named by an audit.log
 *                    pointer line) is kept. Both aged past the 60s race guard.
 *   3. LOCK        — an orphan `locks/apply.lock` held by a DEAD pid + older than 24h
 *                    is reaped.
 *   4. LEFTOVERS   — a stale top-level `.mgr-old` (8 days old) is deleted; a fresh
 *                    `.mgr-new` (now) is kept.
 *
 * The same three-env-var wiring contract as the sibling U22 oracles:
 *   • CLAUDE_CONFIG_DIR = tmp · --config-dir tmp · CLAUDE_MGR_ENABLE_WRITES = '1'
 * all saved + restored in the finally.
 *
 * DEAD-PID DETERMINISM: rather than gamble on a literal pid like 999999 being absent,
 * we spawn a child, let it EXIT, and use its now-dead pid — `process.kill(pid, 0)`
 * then yields ESRCH, so `isPidAlive` reports dead deterministically. (999999 is also
 * dead on this machine, but a freshly-exited child pid is collision-proof.)
 *
 * Two legs: a DRY-RUN leg (no env factor → the gate refuses --apply, OR a bare
 * dry-run) asserts NOTHING is deleted and the would-delete counts name the
 * candidates; the APPLY leg asserts every category acted.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { run } from '../../src/cli.mjs';

// ── helpers ───────────────────────────────────────────────────────────────────

/** Set a path's mtime to N days ago (utimes wants seconds-resolution Dates). */
function ageDays(path, days) {
  const when = new Date(Date.now() - days * 86400 * 1000);
  utimesSync(path, when, when);
}

/** A minimal but schema-valid manifest.json for a snapshot id (0 file records). */
function manifestFor(id) {
  return {
    manifestVersion: 1, planVersion: 1, snapshotId: id,
    targetClaudeDir: '/c/Users/test/.claude',
    createdAt: `${id.slice(0, 10)}T00:00:00.000Z`,
    reason: 'gc-all-categories-test', files: [],
  };
}

/** Plant a real snapshot dir with a manifest.json (so listSnapshots sees it complete). */
function plantSnapshot(stateDir, id) {
  const dir = join(stateDir, 'snapshots', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'files.tar'), Buffer.from('TAR', 'utf8'));
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifestFor(id), null, 2)}\n`, 'utf8');
  return dir;
}

/** Spawn a throwaway child, wait for it to exit, and resolve its (now-dead) pid. */
function deadChildPid() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', 'process.exit(0)']);
    const pid = child.pid;
    child.on('exit', () => setTimeout(() => resolve(pid), 150));
  });
}

const ID_OLD = '2026-05-20T10-00-00Z'; // oldest → will be PINNED
const ID_MID = '2026-05-22T10-00-00Z'; // middle → un-pinned, pruned by --keep 1
const ID_NEW = '2026-05-25T10-00-00Z'; // newest → kept by --keep 1

/**
 * Populate the temp `.mgr-state` with one of each category's fixtures. `deadPid` is
 * an exited child's pid so the lock is deterministically dead. Returns the key paths.
 */
function populateState(stateDir, deadPid) {
  // 1. SNAPSHOTS: three valid dirs; pin the OLDEST (a `.pin` marker).
  plantSnapshot(stateDir, ID_OLD);
  plantSnapshot(stateDir, ID_MID);
  plantSnapshot(stateDir, ID_NEW);
  const pinMarker = join(stateDir, 'snapshots', ID_OLD, '.pin');
  writeFileSync(pinMarker, `${JSON.stringify({ pinnedAt: new Date().toISOString() })}\n`, 'utf8');

  // 2. AUDIT-LARGE: referenced.json (kept) + orphan.json (deleted); aged past 60s.
  const largeDir = join(stateDir, 'audit-large');
  mkdirSync(largeDir, { recursive: true });
  const referenced = join(largeDir, 'referenced.json');
  const orphan = join(largeDir, 'orphan.json');
  writeFileSync(referenced, '{}', 'utf8');
  writeFileSync(orphan, '{}', 'utf8');
  ageDays(referenced, 1);
  ageDays(orphan, 1);
  // audit.log pointer line names referenced.json.
  writeFileSync(join(stateDir, 'audit.log'),
    `${JSON.stringify({ timestamp: '2026-01-01T00:00:00.000Z', large: true, ref: 'referenced.json', sha256: 'x' })}\n`,
    'utf8');

  // 3. LOCK: a dead-holder lock older than 24h (startTime 25h ago).
  const lockFile = join(stateDir, 'locks', 'apply.lock');
  mkdirSync(join(stateDir, 'locks'), { recursive: true });
  const startTime = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
  writeFileSync(lockFile, JSON.stringify({ pid: deadPid, startTime, hostname: 'test' }), 'utf8');

  // 4. LEFTOVERS: a stale .mgr-old (8d) deleted; a fresh .mgr-new kept.
  const staleOld = join(stateDir, 'stale.mgr-old');
  const freshNew = join(stateDir, 'fresh.mgr-new');
  writeFileSync(staleOld, 'old', 'utf8');
  writeFileSync(freshNew, 'new', 'utf8');
  ageDays(staleOld, 8);
  // freshNew left at current mtime.

  return {
    referenced, orphan, lockFile, staleOld, freshNew,
    dirMid: join(stateDir, 'snapshots', ID_MID),
    dirOld: join(stateDir, 'snapshots', ID_OLD),
    dirNew: join(stateDir, 'snapshots', ID_NEW),
  };
}

// ── the oracle ───────────────────────────────────────────────────────────────────

test('snapshot gc exercises all four cleanup categories, end-to-end via run()', async () => {
  const savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
  const savedEnableWrites = process.env.CLAUDE_MGR_ENABLE_WRITES;
  const tmp = mkdtempSync(join(tmpdir(), 'cmgr-gcall-'));
  process.env.CLAUDE_CONFIG_DIR = tmp; // the real gate resolves the governed dir from this
  const stateDir = join(tmp, '.mgr-state');
  mkdirSync(stateDir, { recursive: true });

  try {
    const deadPid = await deadChildPid();

    // ── DRY-RUN LEG: a bare `snapshot gc --keep 1` (no --apply) must delete NOTHING
    //    and preview the candidates in every category. ─────────────────────────────
    const p = populateState(stateDir, deadPid);
    delete process.env.CLAUDE_MGR_ENABLE_WRITES; // prove dry-run never needs the env factor
    const dry = await run(['snapshot', 'gc', '--keep', '1', '--config-dir', tmp, '--format', 'json']);
    assert.equal(dry.code, 0, `dry-run code 0 expected; stdout:\n${dry.stdout}`);
    const dryResult = JSON.parse(dry.stdout).result;
    // Nothing on disk removed.
    assert.ok(existsSync(p.dirMid), 'dry-run must NOT delete the middle snapshot');
    assert.ok(existsSync(p.dirOld), 'dry-run must NOT delete the pinned snapshot');
    assert.ok(existsSync(p.orphan), 'dry-run must NOT delete the audit-large orphan');
    assert.ok(existsSync(p.lockFile), 'dry-run must NOT reap the lock');
    assert.ok(existsSync(p.staleOld), 'dry-run must NOT delete the stale sidecar');
    // The would-delete lists/counts name the candidates.
    assert.deepEqual(dryResult.wouldDelete, [ID_MID],
      `dry-run wouldDelete should name only the un-pinned middle id; got ${JSON.stringify(dryResult.wouldDelete)}`);
    assert.equal(dryResult.auditLarge.wouldDelete, 1, 'one audit-large orphan would be deleted');
    assert.equal(dryResult.lock.wouldReap, 1, 'the dead+old lock would be reaped');
    assert.equal(dryResult.leftovers.wouldDelete, 1, 'one stale sidecar would be deleted');

    // ── GATE-CLOSED --APPLY LEG: `--apply` WITHOUT the env factor must REFUSE before
    //    gcExtras runs. This pins the load-bearing "refuse before any delete" guarantee
    //    — removing the refusal early-return would turn this leg RED (the bare dry-run
    //    leg above never exercises the refusal branch, so without this a mutated-out
    //    refusal stayed green). Env stays UNSET here (still deleted above). ───────────
    assert.equal(process.env.CLAUDE_MGR_ENABLE_WRITES, undefined, 'env factor must be unset for the gate-closed leg');
    const refused = await run(['snapshot', 'gc', '--keep', '1', '--apply', '--config-dir', tmp, '--format', 'json']);
    assert.equal(refused.code, 3, `gate-closed --apply must exit 3; stdout:\n${refused.stdout}`);
    const refusedDiags = JSON.parse(refused.stdout).diagnostics || [];
    assert.ok(refusedDiags.some((d) => d.code === 'writes-disabled-env' && d.severity === 'error'),
      `gate-closed --apply must emit writes-disabled-env; diagnostics:\n${JSON.stringify(refusedDiags)}`);
    // EVERY category's on-disk fixture must SURVIVE — nothing deleted before the refusal.
    assert.ok(existsSync(p.dirMid), 'gate-closed --apply must NOT delete the un-pinned middle snapshot');
    assert.ok(existsSync(p.dirOld), 'gate-closed --apply must NOT delete the pinned snapshot');
    assert.ok(existsSync(p.dirNew), 'gate-closed --apply must NOT delete the newest snapshot');
    assert.ok(existsSync(p.orphan), 'gate-closed --apply must NOT delete the audit-large orphan');
    assert.ok(existsSync(p.referenced), 'gate-closed --apply must NOT delete the referenced audit-large file');
    assert.ok(existsSync(p.lockFile), 'gate-closed --apply must NOT reap locks/apply.lock');
    assert.ok(existsSync(p.staleOld), 'gate-closed --apply must NOT delete the stale .mgr-old sidecar');
    assert.ok(existsSync(p.freshNew), 'gate-closed --apply must NOT delete the fresh .mgr-new sidecar');

    // ── APPLY LEG: arm the env factor, run `snapshot gc --keep 1 --apply`. Every
    //    category must act. ─────────────────────────────────────────────────────────
    process.env.CLAUDE_MGR_ENABLE_WRITES = '1';
    const applied = await run(['snapshot', 'gc', '--keep', '1', '--apply', '--config-dir', tmp, '--format', 'json']);
    assert.equal(applied.code, 0, `apply code 0 expected; stdout:\n${applied.stdout}`);
    const res = JSON.parse(applied.stdout).result;

    // 1. SNAPSHOTS: pinned oldest SURVIVES, newest SURVIVES, un-pinned middle DELETED.
    assert.ok(existsSync(p.dirOld), 'the PINNED oldest snapshot must survive --keep 1');
    assert.ok(existsSync(p.dirNew), 'the newest snapshot must survive --keep 1');
    assert.equal(existsSync(p.dirMid), false, 'the un-pinned middle snapshot must be deleted');
    assert.deepEqual(res.deleted, [ID_MID], `only the middle id should be deleted; got ${JSON.stringify(res.deleted)}`);

    // 2. AUDIT-LARGE: orphan GONE, referenced REMAINS.
    assert.equal(existsSync(p.orphan), false, 'the unreferenced audit-large orphan must be deleted');
    assert.ok(existsSync(p.referenced), 'the referenced audit-large file must remain');
    assert.equal(res.auditLarge.deleted, 1, 'result must report one audit-large delete');

    // 3. LOCK: the dead+old apply.lock is GONE.
    assert.equal(existsSync(p.lockFile), false, 'the dead+old apply lock must be reaped');
    assert.equal(res.lock.reaped, 1, 'result must report the lock reaped');

    // 4. LEFTOVERS: stale .mgr-old GONE, fresh .mgr-new REMAINS.
    assert.equal(existsSync(p.staleOld), false, 'the stale .mgr-old sidecar must be deleted');
    assert.ok(existsSync(p.freshNew), 'the fresh .mgr-new sidecar must remain');
    assert.equal(res.leftovers.deleted, 1, 'result must report one leftover delete');

    // Combined extras tally: audit-large(1) + leftovers(1) + lock-reap(1) = 3.
    assert.equal(res.extrasDeletedCount, 3, `extrasDeletedCount should be 3; got ${res.extrasDeletedCount}`);
  } finally {
    if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
    if (savedEnableWrites === undefined) delete process.env.CLAUDE_MGR_ENABLE_WRITES;
    else process.env.CLAUDE_MGR_ENABLE_WRITES = savedEnableWrites;
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});
