/**
 * Advisory apply-lock (P3.U2) — PID-tracked lock for the future apply operation.
 *
 * The lock file lives at `<mgrStateDir>/locks/apply.lock` and records
 * { pid, startTime, hostname }. This module writes ONLY into the tool's own
 * `.mgr-state` dir, never into the governed `~/.claude` config.
 *
 * Liveness check: `process.kill(pid, 0)` — cross-platform, never spawns.
 *   ESRCH  → dead (the only code that means "no such process").
 *   EPERM  → alive (process exists, no permission to signal).
 *   success → alive.
 *   junk pid (non-positive-integer) → false (not a live holder).
 *
 * assertWritable is INJECTED (not statically imported) so this module stays
 * sync + hermetically testable without pulling in paths.mjs's top-level-await.
 * It is REQUIRED (no passthrough default): acquireLock refuses when it is absent
 * rather than silently bypassing the gate (fail-safe). The apply path (P3.U12+)
 * MUST inject paths.mjs::assertWritable.
 *
 * Ops-layer constraint: imports only node:* stdlib and src/lib/diagnostic.mjs.
 * Never throws. Zero npm dependencies.
 */

import { mkdirSync, openSync, writeSync, closeSync, readFileSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { hostname as osHostname } from 'node:os';
import { DiagnosticBag } from '../lib/diagnostic.mjs';

/** @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic */

const LOCK_REL = join('locks', 'apply.lock');

/**
 * @typedef {Object} LockHolder
 * @property {number} pid
 * @property {string} startTime   ISO timestamp when the lock was acquired
 * @property {string} hostname
 */

// ── Liveness ──────────────────────────────────────────────────────────────────

/**
 * Conservative liveness check via signal 0.
 * Only ESRCH (no such process) means dead; everything else means assume alive.
 * @param {number} pid
 * @param {(pid: number, sig: number) => void} [killFn]
 * @returns {boolean}
 */
export function isPidAlive(pid, killFn = process.kill) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { killFn(pid, 0); return true; }
  catch (err) { return !(err && err.code === 'ESRCH'); }
}

// ── Internal helpers ───────────────────────────────────────────────────────────

/** @param {string} sd @returns {string} */
function lp(sd) { return join(sd, LOCK_REL); }

/**
 * Read + parse the lock file. Returns { holder, err }.
 * @param {string} path
 * @returns {{ holder: LockHolder|null, err: string|null }}
 */
function readHolder(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return { holder: null, err: 'not an object' };
    if (!Number.isInteger(parsed.pid) || parsed.pid <= 0) {
      return { holder: null, err: 'missing or invalid pid' };
    }
    return {
      holder: {
        pid: parsed.pid,
        startTime: typeof parsed.startTime === 'string' ? parsed.startTime : '',
        hostname: typeof parsed.hostname === 'string' ? parsed.hostname : '',
      },
      err: null,
    };
  } catch (e) { return { holder: null, err: e instanceof Error ? e.message : String(e) }; }
}

/**
 * Exclusive-create the lock file and write the payload.
 * Returns null on success, or { code, message } on failure.
 * @param {string} path @param {LockHolder} payload
 * @returns {null | { code: string, message: string }}
 */
function openAndWrite(path, payload) {
  let fd;
  try { fd = openSync(path, 'wx'); }
  catch (e) { return { code: (e && e.code) || 'UNKNOWN', message: e instanceof Error ? e.message : String(e) }; }
  try { writeSync(fd, JSON.stringify(payload)); closeSync(fd); return null; }
  catch (e) { return { code: (e && e.code) || 'UNKNOWN', message: e instanceof Error ? e.message : String(e) }; }
}

/** Convenience: add an error diag and return a failure result. */
function fail(bag, code, message, path, extra = {}) {
  bag.add({ severity: 'error', code, message, phase: 'lock', ...(path ? { path } : {}), ...extra });
  return { ...extra, diagnostics: bag.all() };
}

// ── acquireLock ────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} AcquireResult
 * @property {boolean}       acquired
 * @property {boolean}       [reclaimed]
 * @property {string}        [reason]    'held'|'unreadable'|'raced'|'error'
 * @property {LockHolder}    [holder]
 * @property {Diagnostic[]}  diagnostics
 */

/**
 * Attempt to acquire the advisory apply lock.
 * @param {object} opts
 * @param {string}  opts.stateDir
 * @param {number}  [opts.pid]
 * @param {string}  [opts.hostname]
 * @param {() => Date} [opts.now]
 * @param {Function} [opts.killFn]
 * @param {(path: string, ctx: string) => string} opts.assertWritable  REQUIRED governed-write gate (no default — fail-safe; inject paths.mjs::assertWritable in production, a passthrough in tests)
 * @returns {AcquireResult}
 */
export function acquireLock(opts) {
  const {
    stateDir, pid = process.pid, hostname = osHostname(),
    now = () => new Date(), killFn = process.kill, assertWritable,
  } = opts ?? {};
  const bag = new DiagnosticBag();

  if (typeof stateDir !== 'string' || !stateDir) {
    return fail(bag, 'apply-lock-error', 'stateDir must be a non-empty string', null,
      { acquired: false, reason: 'error' });
  }
  // Fail-safe: the governed-write gate is REQUIRED (no default). A missing
  // injection refuses rather than silently bypassing the gate — production
  // callers (the apply path) inject paths.mjs::assertWritable; tests inject a
  // passthrough.
  if (typeof assertWritable !== 'function') {
    return fail(bag, 'apply-lock-error',
      'assertWritable (the governed-write gate) must be injected', null,
      { acquired: false, reason: 'error' });
  }

  const lockFile = lp(stateDir);
  try { assertWritable(lockFile, 'apply'); }
  catch (e) {
    return fail(bag, 'apply-lock-error', `write gate denied: ${e instanceof Error ? e.message : e}`,
      lockFile, { acquired: false, reason: 'error' });
  }

  try { mkdirSync(dirname(lockFile), { recursive: true }); }
  catch (e) {
    return fail(bag, 'apply-lock-error',
      `could not create locks dir: ${e instanceof Error ? e.message : e}`,
      lockFile, { acquired: false, reason: 'error' });
  }

  const payload = () => ({ pid, startTime: now().toISOString(), hostname });
  const writeErr = openAndWrite(lockFile, payload());
  if (writeErr === null) return { acquired: true, diagnostics: bag.all() };

  // EEXIST means the lock file exists; anything else is an unexpected error.
  if (writeErr.code !== 'EEXIST') {
    return fail(bag, 'apply-lock-error', `unexpected open error: ${writeErr.message}`,
      lockFile, { acquired: false, reason: 'error' });
  }

  // Lock file exists — inspect the current holder.
  const { holder, err: readErr } = readHolder(lockFile);
  if (readErr || !holder) {
    return fail(bag, 'apply-lock-unreadable',
      `lock file is unreadable or corrupt: ${readErr ?? 'unknown'}`, lockFile,
      { acquired: false, reason: 'unreadable',
        fix: 'investigate the lock file manually and use --break-lock to remove it' });
  }

  if (isPidAlive(holder.pid, killFn)) {
    return fail(bag, 'apply-lock-held',
      `apply lock is held by pid ${holder.pid} (started ${holder.startTime}, ` +
      `host ${holder.hostname}); another apply may be running; ` +
      'use --break-lock after confirming the process is gone',
      lockFile, { acquired: false, reason: 'held', holder });
  }

  // Dead holder — reclaim.
  bag.add({ severity: 'warn', code: 'apply-lock-reclaimed-stale', phase: 'lock', path: lockFile,
    message: `reclaimed stale lock held by dead pid ${holder.pid} ` +
      `(started ${holder.startTime}, host ${holder.hostname})` });
  try { unlinkSync(lockFile); }
  catch (e) {
    return fail(bag, 'apply-lock-error',
      `could not remove stale lock: ${e instanceof Error ? e.message : e}`,
      lockFile, { acquired: false, reason: 'error' });
  }

  // Retry once (race guard).
  const retryErr = openAndWrite(lockFile, payload());
  if (retryErr === null) return { acquired: true, reclaimed: true, diagnostics: bag.all() };

  if (retryErr.code === 'EEXIST') {
    bag.add({ severity: 'warn', code: 'apply-lock-race', phase: 'lock', path: lockFile,
      message: 'another process acquired the lock between reclaim and retry' });
    return { acquired: false, reason: 'raced', diagnostics: bag.all() };
  }
  return fail(bag, 'apply-lock-error', `retry open failed: ${retryErr.message}`,
    lockFile, { acquired: false, reason: 'error' });
}

// ── releaseLock ────────────────────────────────────────────────────────────────

/**
 * Remove the apply lock file. ENOENT is benign (released:false).
 * NOTE: unconditional — does not verify ownership; sufficient for U2.
 * @param {{ stateDir?: string }} [opts]
 * @returns {{ released: boolean, diagnostics: Diagnostic[] }}
 */
export function releaseLock(opts) {
  const { stateDir } = opts ?? {};
  const bag = new DiagnosticBag();
  if (typeof stateDir !== 'string' || !stateDir) {
    bag.add({ severity: 'error', code: 'apply-lock-error', phase: 'lock',
      message: 'stateDir must be a non-empty string' });
    return { released: false, diagnostics: bag.all() };
  }
  const lockFile = lp(stateDir);
  try { unlinkSync(lockFile); return { released: true, diagnostics: bag.all() }; }
  catch (e) {
    if (e && e.code === 'ENOENT') return { released: false, diagnostics: bag.all() };
    bag.add({ severity: 'error', code: 'apply-lock-error', phase: 'lock', path: lockFile,
      message: `could not release lock: ${e instanceof Error ? e.message : e}` });
    return { released: false, diagnostics: bag.all() };
  }
}

// ── breakLock ─────────────────────────────────────────────────────────────────

/**
 * Force-remove the apply lock (--break-lock escape). Reports holder + liveness.
 * @param {{ stateDir?: string, killFn?: Function }} [opts]
 * @returns {{ broken: boolean, holder: LockHolder|null, holderAlive: boolean|null, diagnostics: Diagnostic[] }}
 */
export function breakLock(opts) {
  const { stateDir, killFn = process.kill } = opts ?? {};
  const bag = new DiagnosticBag();
  const absent = { broken: false, holder: null, holderAlive: null };
  if (typeof stateDir !== 'string' || !stateDir) {
    bag.add({ severity: 'error', code: 'apply-lock-error', phase: 'lock',
      message: 'stateDir must be a non-empty string' });
    return { ...absent, diagnostics: bag.all() };
  }
  const lockFile = lp(stateDir);
  const { holder, err: readErr } = readHolder(lockFile);
  if (readErr && readErr.includes('ENOENT')) {
    bag.add({ severity: 'info', code: 'apply-lock-absent', phase: 'lock', path: lockFile,
      message: 'apply lock was not present' });
    return { ...absent, diagnostics: bag.all() };
  }
  const holderAlive = holder ? isPidAlive(holder.pid, killFn) : null;
  try { unlinkSync(lockFile); }
  catch (e) {
    if (e && e.code === 'ENOENT') {
      bag.add({ severity: 'info', code: 'apply-lock-absent', phase: 'lock', path: lockFile,
        message: 'apply lock was not present' });
      return { ...absent, diagnostics: bag.all() };
    }
    bag.add({ severity: 'error', code: 'apply-lock-error', phase: 'lock', path: lockFile,
      message: `could not break lock: ${e instanceof Error ? e.message : e}` });
    return { broken: false, holder, holderAlive, diagnostics: bag.all() };
  }
  const desc = holder
    ? `pid ${holder.pid} (started ${holder.startTime}, host ${holder.hostname})`
    : 'unknown holder (unreadable lock file)';
  bag.add({ severity: 'warn', code: 'apply-lock-broken', phase: 'lock', path: lockFile,
    message: `force-removed apply lock held by ${desc}` });
  return { broken: true, holder, holderAlive, diagnostics: bag.all() };
}
