/**
 * P3.U22 — cli-lock.test.mjs (lock CLI handler tests).
 *
 * HERMETIC: no real lock file — every path is driven through injected seams (a
 * recording `inspectFn` / `breakFn` spy and an injected `env`). Every assertion
 * checks actual call ARGS / result / diagnostics (falsifiable).
 *
 * Covers: bare `lock` status (read-only, breakFn never called), the two-factor gate
 * on --break-lock (needs-apply without --apply, writes-disabled-env on a closed env),
 * a real break, and the live-holder warn.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { lockCommand } from '../src/cli/lock-command.mjs';

const CTX = (args) => ({ configDir: '/cfg', mgrStateDir: '/cfg/.mgr-state', args });

/** A recording inspectLock spy returning a canned status. */
function makeInspectSpy(canned) {
  const calls = [];
  const fn = (o) => { calls.push(o); return canned; };
  fn.calls = calls;
  return fn;
}

/** A recording breakLock spy returning a canned break result. */
function makeBreakSpy(canned) {
  const calls = [];
  const fn = (o) => { calls.push(o); return canned; };
  fn.calls = calls;
  return fn;
}

// ── bare lock → read-only status ──────────────────────────────────────────────────

test('lockCommand: bare lock → status from inspectFn, code0, breakFn NOT called', () => {
  const holder = { pid: 4242, startTime: '2026-01-01T00:00:00.000Z', hostname: 'h' };
  const inspect = makeInspectSpy({ present: true, holder, alive: true, diagnostics: [] });
  const brk = makeBreakSpy({ broken: false, holder: null, holderAlive: null, diagnostics: [] });
  const out = lockCommand(CTX({}), { inspectFn: inspect, breakFn: brk, env: {} });
  assert.equal(out.code, 0);
  assert.equal(inspect.calls.length, 1, 'inspectLock called once');
  assert.equal(inspect.calls[0].stateDir, '/cfg/.mgr-state', 'status reads the mgrStateDir');
  assert.equal(out.result.present, true);
  assert.deepEqual(out.result.holder, holder);
  assert.equal(out.result.holderAlive, true);
  assert.equal(brk.calls.length, 0, 'breakLock must NOT be called for a status read');
});

test('lockCommand: bare lock with absent lock → present:false, no diagnostics, code0', () => {
  const inspect = makeInspectSpy({ present: false, holder: null, alive: null, diagnostics: [] });
  const out = lockCommand(CTX({}), { inspectFn: inspect, env: {} });
  assert.equal(out.code, 0);
  assert.equal(out.result.present, false);
  assert.equal(out.result.holder, null);
  assert.equal(out.result.holderAlive, null);
  assert.equal(out.diagnostics.length, 0);
});

test('lockCommand: bare lock surfaces inspect diagnostics (unreadable warn)', () => {
  const inspect = makeInspectSpy({ present: true, holder: null, alive: null,
    diagnostics: [{ severity: 'warn', code: 'apply-lock-unreadable', phase: 'lock', message: 'corrupt' }] });
  const out = lockCommand(CTX({}), { inspectFn: inspect, env: {} });
  assert.equal(out.code, 0);
  assert.equal(out.result.present, true);
  assert.ok(out.diagnostics.some((d) => d.code === 'apply-lock-unreadable' && d.severity === 'warn'));
});

// ── --break-lock without --apply → needs-apply ────────────────────────────────────

test('lockCommand: --break-lock without --apply → lock-break-needs-apply code3, breakFn NOT called', () => {
  const brk = makeBreakSpy({ broken: true, holder: null, holderAlive: null, diagnostics: [] });
  const out = lockCommand(CTX({ 'break-lock': true }), { breakFn: brk, env: {} });
  assert.equal(out.code, 3);
  assert.equal(out.result.status, 'needs-apply');
  assert.ok(out.diagnostics.some((d) => d.code === 'lock-break-needs-apply' && d.severity === 'error'));
  assert.equal(brk.calls.length, 0, 'breakLock must NOT run without --apply');
});

// ── --break-lock --apply env closed → writes-disabled-env ─────────────────────────

test('lockCommand: --break-lock --apply env closed → writes-disabled-env code3, breakFn NOT called', () => {
  const brk = makeBreakSpy({ broken: true, holder: null, holderAlive: null, diagnostics: [] });
  const out = lockCommand(CTX({ 'break-lock': true, apply: true }), { breakFn: brk, env: {} });
  assert.equal(out.code, 3);
  assert.equal(out.result.status, 'refused');
  assert.ok(out.diagnostics.some((d) => d.code === 'writes-disabled-env' && d.severity === 'error'));
  assert.equal(brk.calls.length, 0, 'breakLock must NOT run when the gate is closed');
});

// ── --break-lock --apply env=1 → real break ───────────────────────────────────────

test('lockCommand: --break-lock --apply env=1 → breakFn called, code from broken', () => {
  const holder = { pid: 4242, startTime: '2026-01-01T00:00:00.000Z', hostname: 'h' };
  const brk = makeBreakSpy({ broken: true, holder, holderAlive: false,
    diagnostics: [{ severity: 'warn', code: 'apply-lock-broken', phase: 'lock', message: 'force-removed' }] });
  const out = lockCommand(
    CTX({ 'break-lock': true, apply: true }),
    { breakFn: brk, env: { CLAUDE_MGR_ENABLE_WRITES: '1' } },
  );
  assert.equal(brk.calls.length, 1, 'breakLock called once');
  assert.equal(brk.calls[0].stateDir, '/cfg/.mgr-state');
  assert.equal(out.code, 0, 'broken:true → code 0');
  assert.equal(out.result.broken, true);
  assert.deepEqual(out.result.holder, holder);
  assert.equal(out.result.holderAlive, false);
  assert.ok(out.diagnostics.some((d) => d.code === 'apply-lock-broken'), 'break diagnostics passed through');
  // a dead holder does NOT raise the live-holder warn.
  assert.equal(out.diagnostics.some((d) => d.code === 'lock-broke-live-holder'), false);
});

test('lockCommand: --break-lock --apply env=1 but nothing broken → code1', () => {
  const brk = makeBreakSpy({ broken: false, holder: null, holderAlive: null,
    diagnostics: [{ severity: 'info', code: 'apply-lock-absent', phase: 'lock', message: 'not present' }] });
  const out = lockCommand(
    CTX({ 'break-lock': true, apply: true }),
    { breakFn: brk, env: { CLAUDE_MGR_ENABLE_WRITES: '1' } },
  );
  assert.equal(brk.calls.length, 1);
  assert.equal(out.code, 1, 'broken:false → code 1');
  assert.equal(out.result.broken, false);
});

// ── live-holder warn ──────────────────────────────────────────────────────────────

test('lockCommand: breaking a live-held lock raises lock-broke-live-holder warn', () => {
  const holder = { pid: 7777, startTime: '2026-01-01T00:00:00.000Z', hostname: 'h' };
  const brk = makeBreakSpy({ broken: true, holder, holderAlive: true,
    diagnostics: [{ severity: 'warn', code: 'apply-lock-broken', phase: 'lock', message: 'force-removed' }] });
  const out = lockCommand(
    CTX({ 'break-lock': true, apply: true }),
    { breakFn: brk, env: { CLAUDE_MGR_ENABLE_WRITES: '1' } },
  );
  assert.equal(out.code, 0);
  assert.equal(out.result.holderAlive, true);
  const warn = out.diagnostics.find((d) => d.code === 'lock-broke-live-holder');
  assert.ok(warn, 'a live-holder warn is raised');
  assert.equal(warn.severity, 'warn');
  assert.equal(warn.phase, 'cli');
  assert.ok(warn.message.includes('7777'), 'the warn names the live holder pid');
  // both the engine warn AND the cli warn are present.
  assert.ok(out.diagnostics.some((d) => d.code === 'apply-lock-broken'));
});

// ── null/garbage ctx never throws (review LOW regression) ─────────────────────────

test('lockCommand: a literally-null ctx never throws (defaults defensively)', () => {
  const inspect = makeInspectSpy({ present: false, holder: null, alive: null, diagnostics: [] });
  // Pre-fix this threw `Cannot read properties of null (reading 'mgrStateDir')`.
  const out = lockCommand(null, { inspectFn: inspect, env: {} });
  assert.equal(out.code, 0, 'null ctx degrades to a clean status read');
  assert.equal(inspect.calls.length, 1);
  assert.equal(inspect.calls[0].stateDir, undefined, 'no mgrStateDir on a null ctx → undefined, not a throw');
});

test('lockCommand: undefined ctx + no deps never throws (real inspectLock tolerates it)', () => {
  // No injected seams — exercises the real inspectLock with an undefined stateDir,
  // which returns an error diag + present:false rather than throwing.
  const out = lockCommand(undefined);
  assert.equal(out.code, 0);
  assert.equal(out.result.present, false);
});
