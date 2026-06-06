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

test('lockCommand: bare lock → status from inspectFn, code0, breakFn NOT called', async () => {
  const holder = { pid: 4242, startTime: '2026-01-01T00:00:00.000Z', hostname: 'h' };
  const inspect = makeInspectSpy({ present: true, holder, alive: true, diagnostics: [] });
  const brk = makeBreakSpy({ broken: false, holder: null, holderAlive: null, diagnostics: [] });
  const out = await lockCommand(CTX({}), { inspectFn: inspect, breakFn: brk, env: {} });
  assert.equal(out.code, 0);
  assert.equal(inspect.calls.length, 1, 'inspectLock called once');
  assert.equal(inspect.calls[0].stateDir, '/cfg/.mgr-state', 'status reads the mgrStateDir');
  assert.equal(out.result.present, true);
  assert.deepEqual(out.result.holder, holder);
  assert.equal(out.result.holderAlive, true);
  assert.equal(brk.calls.length, 0, 'breakLock must NOT be called for a status read');
});

test('lockCommand: bare lock with absent lock → present:false, no diagnostics, code0', async () => {
  const inspect = makeInspectSpy({ present: false, holder: null, alive: null, diagnostics: [] });
  const out = await lockCommand(CTX({}), { inspectFn: inspect, env: {} });
  assert.equal(out.code, 0);
  assert.equal(out.result.present, false);
  assert.equal(out.result.holder, null);
  assert.equal(out.result.holderAlive, null);
  assert.equal(out.diagnostics.length, 0);
});

test('lockCommand: bare lock surfaces inspect diagnostics (unreadable warn)', async () => {
  const inspect = makeInspectSpy({ present: true, holder: null, alive: null,
    diagnostics: [{ severity: 'warn', code: 'apply-lock-unreadable', phase: 'lock', message: 'corrupt' }] });
  const out = await lockCommand(CTX({}), { inspectFn: inspect, env: {} });
  assert.equal(out.code, 0);
  assert.equal(out.result.present, true);
  assert.ok(out.diagnostics.some((d) => d.code === 'apply-lock-unreadable' && d.severity === 'warn'));
});

// ── --break-lock without --apply → needs-apply ────────────────────────────────────

test('lockCommand: --break-lock without --apply → lock-break-needs-apply code3, breakFn NOT called', async () => {
  const brk = makeBreakSpy({ broken: true, holder: null, holderAlive: null, diagnostics: [] });
  const inspect = makeInspectSpy({ present: false, holder: null, alive: null, diagnostics: [] });
  const out = await lockCommand(CTX({ 'break-lock': true }), { inspectFn: inspect, breakFn: brk, env: {} });
  assert.equal(out.code, 3);
  assert.equal(out.result.status, 'needs-apply');
  assert.ok(out.diagnostics.some((d) => d.code === 'lock-break-needs-apply' && d.severity === 'error'));
  assert.equal(brk.calls.length, 0, 'breakLock must NOT run without --apply');
});

// ── --break-lock --apply env closed → writes-disabled-env ─────────────────────────

test('lockCommand: --break-lock --apply env closed → writes-disabled-env code3, breakFn NOT called', async () => {
  const brk = makeBreakSpy({ broken: true, holder: null, holderAlive: null, diagnostics: [] });
  const out = await lockCommand(CTX({ 'break-lock': true, apply: true }), { breakFn: brk, env: {} });
  assert.equal(out.code, 3);
  assert.equal(out.result.status, 'refused');
  assert.ok(out.diagnostics.some((d) => d.code === 'writes-disabled-env' && d.severity === 'error'));
  assert.equal(brk.calls.length, 0, 'breakLock must NOT run when the gate is closed');
});

// ── --break-lock --apply env=1 → real break ───────────────────────────────────────

test('lockCommand: --break-lock --apply env=1 → breakFn called, code from broken', async () => {
  const holder = { pid: 4242, startTime: '2026-01-01T00:00:00.000Z', hostname: 'h' };
  const brk = makeBreakSpy({ broken: true, holder, holderAlive: false,
    diagnostics: [{ severity: 'warn', code: 'apply-lock-broken', phase: 'lock', message: 'force-removed' }] });
  const out = await lockCommand(
    CTX({ 'break-lock': true, apply: true }),
    { breakFn: brk, env: { CLAUDE_MGR_ENABLE_WRITES: '1' },
      loadPaths: async () => ({ assertWritable: (p) => p }),
      auditFn: () => ({ written: true, large: false, ref: null, path: null, diagnostics: [] }) },
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
  // a successful audit does NOT raise lock-break-audit-unavailable.
  assert.equal(out.diagnostics.some((d) => d.code === 'lock-break-audit-unavailable'), false);
});

test('lockCommand: --break-lock --apply env=1 but nothing broken → code1', async () => {
  const brk = makeBreakSpy({ broken: false, holder: null, holderAlive: null,
    diagnostics: [{ severity: 'info', code: 'apply-lock-absent', phase: 'lock', message: 'not present' }] });
  const out = await lockCommand(
    CTX({ 'break-lock': true, apply: true }),
    { breakFn: brk, env: { CLAUDE_MGR_ENABLE_WRITES: '1' },
      loadPaths: async () => ({ assertWritable: (p) => p }), auditFn: () => {} },
  );
  assert.equal(brk.calls.length, 1);
  assert.equal(out.code, 1, 'broken:false → code 1');
  assert.equal(out.result.broken, false);
});

// ── live-holder warn ──────────────────────────────────────────────────────────────

test('lockCommand: breaking a live-held lock raises lock-broke-live-holder warn', async () => {
  const holder = { pid: 7777, startTime: '2026-01-01T00:00:00.000Z', hostname: 'h' };
  const brk = makeBreakSpy({ broken: true, holder, holderAlive: true,
    diagnostics: [{ severity: 'warn', code: 'apply-lock-broken', phase: 'lock', message: 'force-removed' }] });
  const out = await lockCommand(
    CTX({ 'break-lock': true, apply: true }),
    { breakFn: brk, env: { CLAUDE_MGR_ENABLE_WRITES: '1' },
      loadPaths: async () => ({ assertWritable: (p) => p }),
      auditFn: () => ({ written: true, large: false, ref: null, path: null, diagnostics: [] }) },
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

test('lockCommand: a literally-null ctx never throws (defaults defensively)', async () => {
  const inspect = makeInspectSpy({ present: false, holder: null, alive: null, diagnostics: [] });
  // Pre-fix this threw `Cannot read properties of null (reading 'mgrStateDir')`.
  const out = await lockCommand(null, { inspectFn: inspect, env: {} });
  assert.equal(out.code, 0, 'null ctx degrades to a clean status read');
  assert.equal(inspect.calls.length, 1);
  assert.equal(inspect.calls[0].stateDir, undefined, 'no mgrStateDir on a null ctx → undefined, not a throw');
});

test('lockCommand: undefined ctx + no deps never throws (real inspectLock tolerates it)', async () => {
  // No injected seams — exercises the real inspectLock with an undefined stateDir,
  // which returns an error diag + present:false rather than throwing.
  const out = await lockCommand(undefined);
  assert.equal(out.code, 0);
  assert.equal(out.result.present, false);
});

// ── P4a.U2: age-prompt dry-run (--break-lock without --apply) ────────────────────

test('P4a.U2: dry-run --break-lock with LIVE holder → WARN caution + ageSeconds, breakFn NOT called', async () => {
  const startTime = '2026-01-01T00:00:00.000Z';
  const holder = { pid: 1234, startTime, hostname: 'box' };
  const inspect = makeInspectSpy({ present: true, holder, alive: true, diagnostics: [] });
  const brk = makeBreakSpy({ broken: false, holder: null, holderAlive: null, diagnostics: [] });
  // Pin the clock: 120 seconds after startTime
  const nowMs = Date.parse(startTime) + 120_000;
  const out = await lockCommand(
    CTX({ 'break-lock': true }),
    { inspectFn: inspect, breakFn: brk, env: {}, now: () => nowMs },
  );
  assert.equal(out.code, 3, 'dry-run exits 3');
  assert.equal(out.result.status, 'needs-apply');
  assert.equal(out.result.present, true);
  assert.equal(out.result.holderAlive, true);
  assert.equal(out.result.ageSeconds, 120, 'ageSeconds computed from injected clock');
  // Must have a live-holder caution WARN
  const caution = out.diagnostics.find((d) => d.code === 'lock-break-live-holder-caution');
  assert.ok(caution, 'live-holder caution diagnostic present');
  assert.equal(caution.severity, 'warn');
  assert.ok(caution.message.includes('1234'), 'caution names the pid');
  assert.ok(caution.message.includes('120s'), 'caution includes the age');
  // Must still have the needs-apply error
  assert.ok(out.diagnostics.some((d) => d.code === 'lock-break-needs-apply' && d.severity === 'error'));
  // breakFn must NOT have been called
  assert.equal(brk.calls.length, 0, 'breakFn must NOT be called in dry-run');
  // inspectFn was called
  assert.equal(inspect.calls.length, 1, 'inspectFn called once for the age-prompt');
});

test('P4a.U2: dry-run --break-lock with DEAD holder → INFO safe-to-break', async () => {
  const startTime = '2025-12-01T10:00:00.000Z';
  const holder = { pid: 5678, startTime, hostname: 'box' };
  const inspect = makeInspectSpy({ present: true, holder, alive: false, diagnostics: [] });
  const nowMs = Date.parse(startTime) + 60_000;
  const out = await lockCommand(
    CTX({ 'break-lock': true }),
    { inspectFn: inspect, breakFn: makeBreakSpy({}), env: {}, now: () => nowMs },
  );
  assert.equal(out.code, 3);
  assert.equal(out.result.holderAlive, false);
  const info = out.diagnostics.find((d) => d.code === 'lock-break-dead-holder');
  assert.ok(info, 'dead-holder INFO diagnostic present');
  assert.equal(info.severity, 'info');
  assert.ok(info.message.includes('5678'));
  assert.ok(info.message.includes('60s'));
  assert.ok(out.diagnostics.some((d) => d.code === 'lock-break-needs-apply'));
});

test('P4a.U2: dry-run --break-lock with no lock present → INFO nothing-to-break', async () => {
  const inspect = makeInspectSpy({ present: false, holder: null, alive: null, diagnostics: [] });
  const out = await lockCommand(
    CTX({ 'break-lock': true }),
    { inspectFn: inspect, breakFn: makeBreakSpy({}), env: {}, now: () => 0 },
  );
  assert.equal(out.code, 3);
  assert.equal(out.result.present, false);
  const info = out.diagnostics.find((d) => d.code === 'lock-break-absent');
  assert.ok(info, 'absent INFO diagnostic present');
  assert.equal(info.severity, 'info');
  assert.ok(out.diagnostics.some((d) => d.code === 'lock-break-needs-apply'));
});

// ── P4a.U2: audit-on-break (--break-lock --apply env=1) ─────────────────────────

test('P4a.U2: --apply break success → code0, broken:true, auditFn called with correct command', async () => {
  const holder = { pid: 9999, startTime: '2026-01-01T00:00:00.000Z', hostname: 'h' };
  const brk = makeBreakSpy({ broken: true, holder, holderAlive: false,
    diagnostics: [{ severity: 'warn', code: 'apply-lock-broken', phase: 'lock', message: 'force-removed' }] });
  const auditCalls = [];
  const auditFn = (o) => { auditCalls.push(o); return { written: true, large: false, ref: null, path: null, diagnostics: [] }; };
  const loadPaths = async () => ({ assertWritable: (p) => p });
  const nowMs = Date.parse('2026-06-06T00:00:00.000Z');
  const out = await lockCommand(
    CTX({ 'break-lock': true, apply: true }),
    { breakFn: brk, env: { CLAUDE_MGR_ENABLE_WRITES: '1' },
      loadPaths, auditFn, now: () => nowMs },
  );
  assert.equal(out.code, 0, 'broken:true → code 0');
  assert.equal(out.result.broken, true);
  assert.equal(brk.calls.length, 1, 'breakFn called once');
  assert.equal(auditCalls.length, 1, 'auditFn called once on success');
  const ao = auditCalls[0];
  assert.equal(ao.entry.command, 'lock --break-lock', 'audit entry command correct');
  assert.equal(ao.entry.exitCode, 0, 'audit entry exitCode = 0');
  assert.equal(typeof ao.assertWritable, 'function', 'assertWritable threaded to auditFn');
  // No audit-unavailable warn on success
  assert.equal(out.diagnostics.some((d) => d.code === 'lock-break-audit-unavailable'), false);
});

test('P4a.U2: --apply break + auditFn returns written:false → code0/broken:true + audit-unavailable warn (returned-failure path)', async () => {
  const holder = { pid: 2, startTime: '2026-01-01T00:00:00.000Z', hostname: 'h' };
  const brk = makeBreakSpy({ broken: true, holder, holderAlive: false, diagnostics: [] });
  // auditFn returns a failure result (gate denial / I/O error) rather than throwing.
  const auditFn = () => ({
    written: false, large: false, ref: null, path: null,
    diagnostics: [{ severity: 'error', code: 'audit-write-error', phase: 'audit', message: 'write gate denied: write-forbidden' }],
  });
  const loadPaths = async () => ({ assertWritable: (p) => p });
  const out = await lockCommand(
    CTX({ 'break-lock': true, apply: true }),
    { breakFn: brk, env: { CLAUDE_MGR_ENABLE_WRITES: '1' }, loadPaths, auditFn },
  );
  assert.equal(out.code, 0, 'break still succeeds when audit fails via return value');
  assert.equal(out.result.broken, true);
  const warn = out.diagnostics.find((d) => d.code === 'lock-break-audit-unavailable');
  assert.ok(warn, 'audit-unavailable warn added on returned written:false');
  assert.equal(warn.severity, 'warn');
  assert.ok(warn.message.includes('write gate denied'), 'underlying error message surfaced in warn');
});

test('P4a.U2: --apply break + loadPaths throws → still code0/broken:true + audit-unavailable warn', async () => {
  const holder = { pid: 1, startTime: '2026-01-01T00:00:00.000Z', hostname: 'h' };
  const brk = makeBreakSpy({ broken: true, holder, holderAlive: false, diagnostics: [] });
  const loadPaths = async () => { throw new Error('hooks/lib missing'); };
  const out = await lockCommand(
    CTX({ 'break-lock': true, apply: true }),
    { breakFn: brk, env: { CLAUDE_MGR_ENABLE_WRITES: '1' }, loadPaths },
  );
  assert.equal(out.code, 0, 'break still succeeds even when audit fails');
  assert.equal(out.result.broken, true);
  const warn = out.diagnostics.find((d) => d.code === 'lock-break-audit-unavailable');
  assert.ok(warn, 'audit-unavailable warn added');
  assert.equal(warn.severity, 'warn');
  assert.ok(warn.message.includes('hooks/lib missing'), 'reason surfaced in warn message');
});
