/**
 * P3.U2 — lock-orphan-reclaim.test.mjs
 *
 * Tests for src/ops/lock.mjs: acquireLock / releaseLock / breakLock /
 * isPidAlive. All filesystem access uses a real temp dir; all seams
 * (killFn, now, pid, hostname, assertWritable) are injected.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync, mkdirSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

import {
  isPidAlive,
  acquireLock,
  releaseLock,
  breakLock,
} from '../src/ops/lock.mjs';

// ── shared helpers ────────────────────────────────────────────────────────────

/** Create a fresh temp dir for one test; returned cleanup fn removes it. */
function makeTmpDir() {
  const dir = mkdtempSync(join(tmpdir(), 'cmgr-lock-'));
  return {
    dir,
    cleanup() {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}

const FIXED_NOW = () => new Date('2026-01-01T00:00:00.000Z');
const FIXED_ISO = '2026-01-01T00:00:00.000Z';
const FIXED_PID = 99999;
const FIXED_HOST = 'test-host';

/** Base opts with all seams injected (passthrough write gate, dead killFn). */
function baseOpts(stateDir, overrides = {}) {
  return {
    stateDir,
    pid: FIXED_PID,
    hostname: FIXED_HOST,
    now: FIXED_NOW,
    assertWritable: (p) => p,
    killFn: () => { throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' }); },
    ...overrides,
  };
}

/** killFn that makes a specific pid appear alive (signal 0 succeeds). */
function aliveFor(_pid) {
  return () => { /* no throw = alive */ };
}

/** Lock file path (mirrors lock.mjs internal). */
function lockPath(stateDir) {
  return join(stateDir, 'locks', 'apply.lock');
}

/** Pre-write a lock file with the given payload object. */
function setupLockFile(stateDir, payload) {
  const lp = lockPath(stateDir);
  mkdirSync(dirname(lp), { recursive: true });
  writeFileSync(lp, JSON.stringify(payload));
}

// ── isPidAlive ────────────────────────────────────────────────────────────────

test('isPidAlive: junk pid 0 → false', () => {
  assert.equal(isPidAlive(0), false);
});

test('isPidAlive: junk pid -1 → false', () => {
  assert.equal(isPidAlive(-1), false);
});

test('isPidAlive: junk pid NaN → false', () => {
  assert.equal(isPidAlive(NaN), false);
});

test('isPidAlive: non-integer 1.5 → false', () => {
  assert.equal(isPidAlive(1.5), false);
});

test('isPidAlive: ESRCH → false (dead process)', () => {
  const killFn = () => { throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' }); };
  assert.equal(isPidAlive(12345, killFn), false);
});

test('isPidAlive: EPERM → true (process exists, no permission)', () => {
  const killFn = () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); };
  assert.equal(isPidAlive(12345, killFn), true);
});

test('isPidAlive: success (no throw) → true', () => {
  const killFn = () => {};
  assert.equal(isPidAlive(12345, killFn), true);
});

test('isPidAlive: other error code → true (conservative)', () => {
  const killFn = () => { throw Object.assign(new Error('EIO'), { code: 'EIO' }); };
  assert.equal(isPidAlive(12345, killFn), true);
});

// ── acquireLock: fresh acquire ────────────────────────────────────────────────

test('acquireLock: fresh acquire → acquired:true, lock file written with correct payload', () => {
  const { dir, cleanup } = makeTmpDir();
  try {
    const result = acquireLock(baseOpts(dir));
    assert.equal(result.acquired, true);
    assert.equal(result.diagnostics.length, 0);

    const lp = lockPath(dir);
    assert.ok(existsSync(lp), 'lock file must exist on disk');
    const payload = JSON.parse(readFileSync(lp, 'utf8'));
    assert.equal(payload.pid, FIXED_PID);
    assert.equal(payload.startTime, FIXED_ISO);
    assert.equal(payload.hostname, FIXED_HOST);
  } finally { cleanup(); }
});

test('acquireLock: fresh acquire does not set reclaimed field', () => {
  const { dir, cleanup } = makeTmpDir();
  try {
    const result = acquireLock(baseOpts(dir));
    assert.equal(result.reclaimed, undefined);
  } finally { cleanup(); }
});

// ── acquireLock: reclaim stale ────────────────────────────────────────────────

test('acquireLock: reclaim stale (dead pid) → acquired:true, reclaimed:true, warn diag', () => {
  const { dir, cleanup } = makeTmpDir();
  try {
    const stalePid = 4242;
    setupLockFile(dir, { pid: stalePid, startTime: '2025-01-01T00:00:00.000Z', hostname: 'old-host' });

    // killFn always throws ESRCH → all pids dead
    const result = acquireLock(baseOpts(dir, {
      killFn: () => { throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' }); },
    }));

    assert.equal(result.acquired, true);
    assert.equal(result.reclaimed, true);

    const warns = result.diagnostics.filter((d) => d.code === 'apply-lock-reclaimed-stale');
    assert.equal(warns.length, 1);
    assert.equal(warns[0].severity, 'warn');
    assert.ok(warns[0].message.includes(String(stalePid)), 'message should name the dead pid');

    // Lock is now ours
    const payload = JSON.parse(readFileSync(lockPath(dir), 'utf8'));
    assert.equal(payload.pid, FIXED_PID);
    assert.equal(payload.startTime, FIXED_ISO);
  } finally { cleanup(); }
});

// ── acquireLock: refuse alive ─────────────────────────────────────────────────

test('acquireLock: refuse alive held lock → acquired:false, reason:held, error diag', () => {
  const { dir, cleanup } = makeTmpDir();
  try {
    const holderPid = 4242;
    const holderStart = '2025-06-01T12:00:00.000Z';
    setupLockFile(dir, { pid: holderPid, startTime: holderStart, hostname: 'other-host' });

    const result = acquireLock(baseOpts(dir, { killFn: aliveFor(holderPid) }));

    assert.equal(result.acquired, false);
    assert.equal(result.reason, 'held');
    assert.deepEqual(result.holder, {
      pid: holderPid, startTime: holderStart, hostname: 'other-host',
    });

    const errs = result.diagnostics.filter((d) => d.code === 'apply-lock-held');
    assert.equal(errs.length, 1);
    assert.equal(errs[0].severity, 'error');
    assert.ok(errs[0].message.includes(String(holderPid)), 'message names holder pid');
    assert.ok(errs[0].message.includes('--break-lock'), 'message mentions --break-lock');

    // Original lock file unchanged
    const payload = JSON.parse(readFileSync(lockPath(dir), 'utf8'));
    assert.equal(payload.pid, holderPid);
  } finally { cleanup(); }
});

// ── acquireLock: unreadable lock ──────────────────────────────────────────────

test('acquireLock: corrupt lock JSON → acquired:false, reason:unreadable, error diag', () => {
  const { dir, cleanup } = makeTmpDir();
  try {
    const lp = lockPath(dir);
    mkdirSync(dirname(lp), { recursive: true });
    writeFileSync(lp, '{ broken json');

    const result = acquireLock(baseOpts(dir));

    assert.equal(result.acquired, false);
    assert.equal(result.reason, 'unreadable');

    const errs = result.diagnostics.filter((d) => d.code === 'apply-lock-unreadable');
    assert.equal(errs.length, 1);
    assert.equal(errs[0].severity, 'error');

    // File unchanged
    assert.equal(readFileSync(lockPath(dir), 'utf8'), '{ broken json');
  } finally { cleanup(); }
});

test('acquireLock: lock with missing pid field → unreadable', () => {
  const { dir, cleanup } = makeTmpDir();
  try {
    setupLockFile(dir, { startTime: '2025-01-01T00:00:00.000Z', hostname: 'h' });
    const result = acquireLock(baseOpts(dir));
    assert.equal(result.acquired, false);
    assert.equal(result.reason, 'unreadable');
  } finally { cleanup(); }
});

test('acquireLock: lock with non-integer pid field → unreadable', () => {
  const { dir, cleanup } = makeTmpDir();
  try {
    setupLockFile(dir, { pid: 'not-a-number', startTime: FIXED_ISO, hostname: 'h' });
    const result = acquireLock(baseOpts(dir));
    assert.equal(result.acquired, false);
    assert.equal(result.reason, 'unreadable');
  } finally { cleanup(); }
});

// ── releaseLock ───────────────────────────────────────────────────────────────

test('releaseLock: removes the lock file → released:true, no diagnostics', () => {
  const { dir, cleanup } = makeTmpDir();
  try {
    setupLockFile(dir, { pid: FIXED_PID, startTime: FIXED_ISO, hostname: FIXED_HOST });
    const result = releaseLock({ stateDir: dir, pid: FIXED_PID });
    assert.equal(result.released, true);
    assert.equal(result.diagnostics.length, 0);
    assert.ok(!existsSync(lockPath(dir)), 'lock file must be gone');
  } finally { cleanup(); }
});

test('releaseLock: absent lock is benign → released:false, no diagnostics', () => {
  const { dir, cleanup } = makeTmpDir();
  try {
    const result = releaseLock({ stateDir: dir });
    assert.equal(result.released, false);
    assert.equal(result.diagnostics.length, 0);
  } finally { cleanup(); }
});

test('releaseLock: second release after first is idempotent', () => {
  const { dir, cleanup } = makeTmpDir();
  try {
    setupLockFile(dir, { pid: FIXED_PID, startTime: FIXED_ISO, hostname: FIXED_HOST });
    releaseLock({ stateDir: dir, pid: FIXED_PID });
    const result2 = releaseLock({ stateDir: dir, pid: FIXED_PID });
    assert.equal(result2.released, false);
    assert.equal(result2.diagnostics.length, 0);
  } finally { cleanup(); }
});

// ── breakLock ─────────────────────────────────────────────────────────────────

test('breakLock: force-removes alive-held lock → broken:true, holderAlive:true, warn diag', () => {
  const { dir, cleanup } = makeTmpDir();
  try {
    const holderPid = 4242;
    setupLockFile(dir, { pid: holderPid, startTime: FIXED_ISO, hostname: 'remote-host' });

    const result = breakLock({ stateDir: dir, killFn: aliveFor(holderPid) });

    assert.equal(result.broken, true);
    assert.equal(result.holderAlive, true);
    assert.ok(result.holder !== null, 'holder should be set');
    assert.equal(result.holder.pid, holderPid);

    const warns = result.diagnostics.filter((d) => d.code === 'apply-lock-broken');
    assert.equal(warns.length, 1);
    assert.equal(warns[0].severity, 'warn');
    assert.ok(warns[0].message.includes(String(holderPid)));

    assert.ok(!existsSync(lockPath(dir)), 'lock file must be gone after break');
  } finally { cleanup(); }
});

test('breakLock: force-removes dead-held lock → broken:true, holderAlive:false', () => {
  const { dir, cleanup } = makeTmpDir();
  try {
    const holderPid = 4242;
    setupLockFile(dir, { pid: holderPid, startTime: FIXED_ISO, hostname: 'old-host' });
    const deadKill = () => { throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' }); };

    const result = breakLock({ stateDir: dir, killFn: deadKill });

    assert.equal(result.broken, true);
    assert.equal(result.holderAlive, false);
    assert.equal(result.holder.pid, holderPid);
  } finally { cleanup(); }
});

test('breakLock: absent lock → broken:false, info diag apply-lock-absent, no throw', () => {
  const { dir, cleanup } = makeTmpDir();
  try {
    const result = breakLock({ stateDir: dir });
    assert.equal(result.broken, false);
    assert.equal(result.holder, null);
    assert.equal(result.holderAlive, null);

    const infos = result.diagnostics.filter((d) => d.code === 'apply-lock-absent');
    assert.equal(infos.length, 1);
    assert.equal(infos[0].severity, 'info');
  } finally { cleanup(); }
});

// ── never-throws robustness ───────────────────────────────────────────────────

test('acquireLock: empty stateDir string → acquired:false, never throws', () => {
  assert.doesNotThrow(() => {
    const r = acquireLock({ stateDir: '' });
    assert.equal(r.acquired, false);
  });
});

test('acquireLock: locks subpath is a file (mkdirSync fails) → acquired:false, reason:error, never throws', () => {
  const { dir, cleanup } = makeTmpDir();
  try {
    // Block the locks/ dir slot with a regular file
    writeFileSync(join(dir, 'locks'), 'not-a-dir');
    assert.doesNotThrow(() => {
      const r = acquireLock(baseOpts(dir));
      assert.equal(r.acquired, false);
      assert.equal(r.reason, 'error');
    });
  } finally { cleanup(); }
});

test('releaseLock: empty stateDir → released:false, never throws', () => {
  assert.doesNotThrow(() => {
    const r = releaseLock({ stateDir: '' });
    assert.equal(r.released, false);
  });
});

test('breakLock: empty stateDir → broken:false, never throws', () => {
  assert.doesNotThrow(() => {
    const r = breakLock({ stateDir: '' });
    assert.equal(r.broken, false);
  });
});

test('acquireLock: null opts → never throws', () => {
  assert.doesNotThrow(() => acquireLock(null));
});

test('releaseLock: undefined opts → never throws', () => {
  assert.doesNotThrow(() => releaseLock(undefined));
});

test('breakLock: undefined opts → never throws', () => {
  assert.doesNotThrow(() => breakLock(undefined));
});

// ── assertWritable gate ───────────────────────────────────────────────────────

test('acquireLock: assertWritable rejection → acquired:false, reason:error, error diag', () => {
  const { dir, cleanup } = makeTmpDir();
  try {
    const result = acquireLock(baseOpts(dir, {
      assertWritable: () => { throw new Error('write-outside-target'); },
    }));
    assert.equal(result.acquired, false);
    assert.equal(result.reason, 'error');
    const errs = result.diagnostics.filter((d) => d.code === 'apply-lock-error');
    assert.equal(errs.length, 1);
    assert.ok(errs[0].message.includes('write gate denied'));
  } finally { cleanup(); }
});

test('acquireLock: missing assertWritable → acquired:false, error diag, NOTHING written (fail-safe)', () => {
  const { dir, cleanup } = makeTmpDir();
  try {
    // Valid stateDir but NO write gate injected: must refuse, not silently bypass.
    const result = acquireLock({ stateDir: dir, pid: FIXED_PID, now: FIXED_NOW });
    assert.equal(result.acquired, false);
    assert.equal(result.reason, 'error');
    const errs = result.diagnostics.filter((d) => d.code === 'apply-lock-error');
    assert.equal(errs.length, 1);
    assert.ok(/assertWritable/.test(errs[0].message), 'error names the missing gate');
    assert.equal(existsSync(join(dir, 'locks', 'apply.lock')), false, 'no lock written without a gate');
  } finally { cleanup(); }
});

// ── releaseLock: ownership check ──────────────────────────────────────────────

test('releaseLock: different pid → released:false, apply-lock-not-owner error, file still exists', () => {
  const { dir, cleanup } = makeTmpDir();
  try {
    const holderPid = 4242;
    setupLockFile(dir, { pid: holderPid, startTime: FIXED_ISO, hostname: FIXED_HOST });
    const result = releaseLock({ stateDir: dir, pid: 99999 });
    assert.equal(result.released, false);
    assert.equal(result.diagnostics.length, 1);
    assert.equal(result.diagnostics[0].code, 'apply-lock-not-owner');
    assert.equal(result.diagnostics[0].severity, 'error');
    assert.ok(result.diagnostics[0].message.includes('4242'), 'message names holder pid');
    assert.ok(result.diagnostics[0].message.includes('99999'), 'message names our pid');
    assert.ok(existsSync(lockPath(dir)), 'lock file must still exist');
  } finally { cleanup(); }
});

test('releaseLock: owner pid releases successfully → released:true, no diagnostics, file gone', () => {
  const { dir, cleanup } = makeTmpDir();
  try {
    const ownerPid = 4242;
    setupLockFile(dir, { pid: ownerPid, startTime: FIXED_ISO, hostname: FIXED_HOST });
    const result = releaseLock({ stateDir: dir, pid: ownerPid });
    assert.equal(result.released, true);
    assert.equal(result.diagnostics.length, 0);
    assert.ok(!existsSync(lockPath(dir)), 'lock file must be gone');
  } finally { cleanup(); }
});

test('releaseLock: ENOENT with pid set is benign → released:false, no diagnostics, no throw', () => {
  const { dir, cleanup } = makeTmpDir();
  try {
    const result = releaseLock({ stateDir: dir, pid: 4242 });
    assert.equal(result.released, false);
    assert.equal(result.diagnostics.length, 0);
  } finally { cleanup(); }
});

test('releaseLock: corrupt lock (holder===null) is still removable by releaseLock', () => {
  const { dir, cleanup } = makeTmpDir();
  try {
    const lp = lockPath(dir);
    mkdirSync(dirname(lp), { recursive: true });
    writeFileSync(lp, '{ broken json');
    const result = releaseLock({ stateDir: dir, pid: 4242 });
    assert.equal(result.released, true);
    assert.equal(result.diagnostics.length, 0);
    assert.ok(!existsSync(lockPath(dir)), 'lock file must be gone');
  } finally { cleanup(); }
});

test('releaseLock: injected readFn returning different-pid holder triggers refusal', () => {
  const { dir, cleanup } = makeTmpDir();
  try {
    setupLockFile(dir, { pid: 4242, startTime: FIXED_ISO, hostname: FIXED_HOST });
    // readFn always returns a holder with pid 9999 regardless of file content
    const readFn = () => JSON.stringify({ pid: 9999, startTime: FIXED_ISO, hostname: FIXED_HOST });
    const result = releaseLock({ stateDir: dir, pid: 1111, readFn });
    assert.equal(result.released, false);
    assert.equal(result.diagnostics.length, 1);
    assert.equal(result.diagnostics[0].code, 'apply-lock-not-owner');
    assert.ok(result.diagnostics[0].message.includes('9999'), 'message names the injected holder pid');
    assert.ok(existsSync(lockPath(dir)), 'lock file must still exist');
  } finally { cleanup(); }
});

// ── diagnostic code coverage ──────────────────────────────────────────────────

test('all 8 diagnostic codes are distinct kebab strings starting with apply-lock-', () => {
  const KNOWN_CODES = [
    'apply-lock-held',
    'apply-lock-reclaimed-stale',
    'apply-lock-unreadable',
    'apply-lock-race',
    'apply-lock-error',
    'apply-lock-broken',
    'apply-lock-absent',
    'apply-lock-not-owner',
  ];
  assert.equal(new Set(KNOWN_CODES).size, KNOWN_CODES.length, 'codes must be distinct');
  for (const code of KNOWN_CODES) {
    assert.ok(code.startsWith('apply-lock-'), `${code} must start with apply-lock-`);
  }
});
