/**
 * P3.U22 — cli-rollback.test.mjs (write-gate + rollback CLI handler tests).
 *
 * HERMETIC: no real filesystem, no real paths.mjs, no real rollback engine — every
 * path is driven through injected seams (a recording `rollbackFn` spy, a fake
 * `loadPaths` returning a passthrough gate, and an injected `env`). Every assertion
 * checks actual call ARGS / diagnostics (falsifiable), not merely "didn't throw".
 *
 * Covers:
 *   resolveWriteIntent — the pure two-factor gate decision table.
 *   rollbackCommand    — no-id refusal, dry-run, the two-factor refusal, the real
 *                        --apply path, the M2 degrade, and --force threading.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveWriteIntent } from '../src/cli/write-gate.mjs';
import { rollbackCommand } from '../src/cli/rollback-command.mjs';

// ── resolveWriteIntent (pure) ─────────────────────────────────────────────────────

test('resolveWriteIntent: no --apply → dry-run, enableWrites:false, no refusal', () => {
  const r = resolveWriteIntent({ apply: false });
  assert.equal(r.enableWrites, false);
  assert.equal(r.refusal, null);
  assert.equal(r.code, null);
});

test('resolveWriteIntent: --apply + env=1 → enableWrites:true, no refusal', () => {
  const r = resolveWriteIntent({ apply: true, env: { CLAUDE_MGR_ENABLE_WRITES: '1' } });
  assert.equal(r.enableWrites, true);
  assert.equal(r.refusal, null);
  assert.equal(r.code, null);
});

test('resolveWriteIntent: --apply + env unset → refused with writes-disabled-env, code:3', () => {
  const r = resolveWriteIntent({ apply: true, env: {} });
  assert.equal(r.enableWrites, false);
  assert.equal(r.code, 3);
  assert.ok(r.refusal, 'a refusal Diagnostic is present');
  assert.equal(r.refusal.code, 'writes-disabled-env');
  assert.equal(r.refusal.severity, 'error');
  assert.equal(r.refusal.phase, 'cli');
  assert.match(r.refusal.message, /CLAUDE_MGR_ENABLE_WRITES=1/);
});

test('resolveWriteIntent: --apply + env=0 → refused (only exactly "1" enables)', () => {
  const r = resolveWriteIntent({ apply: true, env: { CLAUDE_MGR_ENABLE_WRITES: '0' } });
  assert.equal(r.enableWrites, false);
  assert.equal(r.code, 3);
  assert.equal(r.refusal.code, 'writes-disabled-env');
});

test('resolveWriteIntent: --apply + env="true" → still refused (not the literal "1")', () => {
  const r = resolveWriteIntent({ apply: true, env: { CLAUDE_MGR_ENABLE_WRITES: 'true' } });
  assert.equal(r.enableWrites, false);
  assert.equal(r.code, 3);
});

test('resolveWriteIntent: --apply + null env → refused, never throws on a null env', () => {
  assert.doesNotThrow(() => resolveWriteIntent({ apply: true, env: null }));
  const r = resolveWriteIntent({ apply: true, env: null });
  assert.equal(r.enableWrites, false);
  assert.equal(r.code, 3);
  assert.equal(r.refusal.code, 'writes-disabled-env');
});

test('resolveWriteIntent: no-apply + null env → dry-run (env irrelevant, no throw)', () => {
  const r = resolveWriteIntent({ apply: false, env: null });
  assert.equal(r.enableWrites, false);
  assert.equal(r.refusal, null);
});

test('resolveWriteIntent: tolerates a missing opts object', () => {
  assert.doesNotThrow(() => resolveWriteIntent());
  const r = resolveWriteIntent();
  assert.equal(r.enableWrites, false);
  assert.equal(r.refusal, null);
});

// ── rollbackCommand test harness ──────────────────────────────────────────────────

/** A recording rollbackFn spy returning a canned RollbackResult. */
function makeRollbackSpy(canned) {
  const calls = [];
  const fn = (o) => { calls.push(o); return Promise.resolve(canned); };
  fn.calls = calls;
  return fn;
}

/** A recording loadPaths seam returning a passthrough write gate. */
function makeLoadPaths() {
  const calls = [];
  const gate = (p) => p;
  const fn = () => { calls.push(true); return Promise.resolve({ assertWritable: gate }); };
  fn.calls = calls;
  fn.gate = gate;
  return fn;
}

/** A minimal canned dry-run-ish RollbackResult. */
const CANNED = {
  ok: true, status: 'dry-run', code: 0, dryRun: true, snapshotId: 'snap-1',
  drift: { clean: true }, verify: null, restore: null, lock: { acquired: false }, diagnostics: [],
};

// ── rollbackCommand: no id ────────────────────────────────────────────────────────

test('rollbackCommand: no id (empty positionals) → code:3, rollback-no-id, spy NOT called', async () => {
  const spy = makeRollbackSpy(CANNED);
  const out = await rollbackCommand(
    { configDir: '/cfg', mgrStateDir: '/cfg/.mgr-state', args: { positionals: [] } },
    { rollbackFn: spy, env: {} },
  );
  assert.equal(out.code, 3);
  assert.equal(out.result.status, 'no-id');
  assert.ok(out.diagnostics.some((d) => d.code === 'rollback-no-id' && d.severity === 'error'));
  assert.equal(spy.calls.length, 0, 'the engine must not be called without an id');
});

test('rollbackCommand: missing positionals array → code:3 rollback-no-id (never throws)', async () => {
  const spy = makeRollbackSpy(CANNED);
  const out = await rollbackCommand(
    { configDir: '/cfg', mgrStateDir: '/cfg/.mgr-state', args: {} },
    { rollbackFn: spy, env: {} },
  );
  assert.equal(out.code, 3);
  assert.equal(out.result.status, 'no-id');
  assert.equal(spy.calls.length, 0);
});

// ── rollbackCommand: dry-run (default) ────────────────────────────────────────────

test('rollbackCommand: dry-run → spy called once with enableWrites:false + assertWritable undefined; loadPaths NOT called', async () => {
  const spy = makeRollbackSpy(CANNED);
  const loadPaths = makeLoadPaths();
  const out = await rollbackCommand(
    { configDir: '/cfg', mgrStateDir: '/cfg/.mgr-state', args: { positionals: ['snap-1'] } },
    { rollbackFn: spy, loadPaths, env: {} },
  );
  assert.equal(spy.calls.length, 1, 'engine called exactly once');
  assert.equal(spy.calls[0].enableWrites, false, 'dry-run → enableWrites:false');
  assert.equal(spy.calls[0].assertWritable, undefined, 'dry-run → no gate injected');
  assert.equal(spy.calls[0].snapshotId, 'snap-1');
  assert.equal(spy.calls[0].targetClaudeDir, '/cfg');
  assert.equal(spy.calls[0].mgrStateDir, '/cfg/.mgr-state');
  assert.equal(spy.calls[0].expectedTarget, '/cfg', 'expectedTarget = configDir (cross-target guard)');
  assert.equal(loadPaths.calls.length, 0, 'dry-run must not load paths.mjs');
  // returned code mirrors the canned result code.
  assert.equal(out.code, 0);
  assert.equal(out.result.status, 'dry-run');
  assert.equal(out.result.dryRun, true);
});

// ── rollbackCommand: --apply + env closed → two-factor refusal ────────────────────

test('rollbackCommand: --apply + env closed → code:3 writes-disabled-env, spy + loadPaths NEVER called', async () => {
  const spy = makeRollbackSpy(CANNED);
  const loadPaths = makeLoadPaths();
  const out = await rollbackCommand(
    { configDir: '/cfg', mgrStateDir: '/cfg/.mgr-state', args: { positionals: ['snap-1'], apply: true } },
    { rollbackFn: spy, loadPaths, env: {} },
  );
  assert.equal(out.code, 3);
  assert.equal(out.result.status, 'refused');
  assert.equal(out.result.mode, 'apply-requested');
  assert.ok(out.diagnostics.some((d) => d.code === 'writes-disabled-env' && d.severity === 'error'));
  assert.equal(spy.calls.length, 0, 'the engine must NOT run when the gate is closed');
  assert.equal(loadPaths.calls.length, 0, 'paths.mjs must NOT be loaded when the gate is closed');
});

// ── rollbackCommand: --apply + env "1" → real apply path ──────────────────────────

test('rollbackCommand: --apply + env=1 → loadPaths once, spy gets enableWrites:true + the gate from loadPaths', async () => {
  const applied = { ok: true, status: 'restored', code: 0, dryRun: false, snapshotId: 'snap-1',
    drift: { clean: true }, verify: { verified: true }, restore: { restored: true, skipped: [] },
    lock: { acquired: true }, diagnostics: [] };
  const spy = makeRollbackSpy(applied);
  const loadPaths = makeLoadPaths();
  const out = await rollbackCommand(
    { configDir: '/cfg', mgrStateDir: '/cfg/.mgr-state', args: { positionals: ['snap-1'], apply: true } },
    { rollbackFn: spy, loadPaths, env: { CLAUDE_MGR_ENABLE_WRITES: '1' } },
  );
  assert.equal(loadPaths.calls.length, 1, 'paths.mjs loaded exactly once on the real apply path');
  assert.equal(spy.calls.length, 1);
  assert.equal(spy.calls[0].enableWrites, true, '--apply + env=1 → enableWrites:true');
  assert.equal(spy.calls[0].assertWritable, loadPaths.gate, 'the gate threaded into the engine is the one loadPaths returned');
  // the canned code is passed straight through.
  assert.equal(out.code, 0);
  assert.equal(out.result.status, 'restored');
  assert.equal(out.result.ok, true);
  assert.equal(out.result.lockAcquired, true, 'summary reflects lock acquired');
  assert.equal(out.result.skippedCount, 0, 'summary counts the (empty) skipped array');
});

test('rollbackCommand: the engine code is passed through as the CLI exit code', async () => {
  // a refused-drift result carries code:3 from the engine — the CLI must surface it.
  const refused = { ok: false, status: 'refused-drift', code: 3, dryRun: true, snapshotId: 'snap-1',
    drift: { clean: false }, verify: null, restore: null, lock: { acquired: false }, diagnostics: [] };
  const spy = makeRollbackSpy(refused);
  const out = await rollbackCommand(
    { configDir: '/cfg', mgrStateDir: '/cfg/.mgr-state', args: { positionals: ['snap-1'] } },
    { rollbackFn: spy, env: {} },
  );
  assert.equal(out.code, 3, 'engine code:3 surfaced as the exit code');
  assert.equal(out.result.driftClean, false, 'summary echoes drift.clean=false');
});

// ── rollbackCommand: M2 degrade (loadPaths throws) ────────────────────────────────

test('rollbackCommand: --apply + env=1 but loadPaths throws → write-unavailable warn, code:1, spy NEVER called', async () => {
  const spy = makeRollbackSpy(CANNED);
  const loadPaths = () => Promise.reject(new Error('no hooks lib'));
  const out = await rollbackCommand(
    { configDir: '/cfg', mgrStateDir: '/cfg/.mgr-state', args: { positionals: ['snap-1'], apply: true } },
    { rollbackFn: spy, loadPaths, env: { CLAUDE_MGR_ENABLE_WRITES: '1' } },
  );
  assert.equal(out.result.status, 'write-unavailable');
  assert.equal(out.code, 1);
  assert.ok(out.diagnostics.some((d) => d.code === 'rollback-write-unavailable' && d.severity === 'warn'),
    JSON.stringify(out.diagnostics));
  assert.equal(spy.calls.length, 0, 'the engine must NOT run when the gate is unavailable');
});

// ── rollbackCommand: --force threading ────────────────────────────────────────────

test('rollbackCommand: --force is threaded to the engine as force:true', async () => {
  const spy = makeRollbackSpy(CANNED);
  const out = await rollbackCommand(
    { configDir: '/cfg', mgrStateDir: '/cfg/.mgr-state', args: { positionals: ['snap-1'], force: true } },
    { rollbackFn: spy, env: {} },
  );
  assert.equal(spy.calls.length, 1);
  assert.equal(spy.calls[0].force, true, '--force reaches the engine');
  assert.equal(spy.calls[0].enableWrites, false, 'force on a dry-run does not enable writes');
  assert.equal(out.code, 0);
});

test('rollbackCommand: absent --force defaults to force:false', async () => {
  const spy = makeRollbackSpy(CANNED);
  await rollbackCommand(
    { configDir: '/cfg', mgrStateDir: '/cfg/.mgr-state', args: { positionals: ['snap-1'] } },
    { rollbackFn: spy, env: {} },
  );
  assert.equal(spy.calls[0].force, false);
});

// ── rollbackCommand: defensive summary on a junk engine result ────────────────────

test('rollbackCommand: tolerates a partial engine result (missing restore/lock → null/false, no throw)', async () => {
  const partial = { ok: false, status: 'drift-error', dryRun: true, snapshotId: 'snap-1', diagnostics: [] };
  const spy = makeRollbackSpy(partial);
  const out = await rollbackCommand(
    { configDir: '/cfg', mgrStateDir: '/cfg/.mgr-state', args: { positionals: ['snap-1'] } },
    { rollbackFn: spy, env: {} },
  );
  assert.equal(out.result.status, 'drift-error');
  assert.equal(out.result.restoredCount, null, 'no restore → null');
  assert.equal(out.result.skippedCount, null, 'no restore → null');
  assert.equal(out.result.driftClean, null, 'no drift → null');
  assert.equal(out.result.lockAcquired, false, 'no lock → false');
  // engine returned no numeric code + ok:false → CLI falls back to 1.
  assert.equal(out.code, 1);
});
