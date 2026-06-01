/**
 * P3.U22 — cli-recover.test.mjs (recover CLI handler tests).
 *
 * HERMETIC: no real filesystem, no real paths.mjs, no real recover engine — every
 * path is driven through injected seams (a recording `recoverFn` spy, a fake
 * `loadPaths` returning a passthrough gate, and an injected `env`). Every assertion
 * checks actual call ARGS / diagnostics (falsifiable), not merely "didn't throw".
 *
 * Covers the flag → mode mapping, the two-factor gate, and the KEY ASYMMETRY vs
 * rollbackCommand: recover loads the write gate even for a dry-run rollback (it is
 * required for every mode), while mark-failed/resume refuse up front without --apply.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { recoverCommand } from '../src/cli/recover-command.mjs';

// ── harness ───────────────────────────────────────────────────────────────────────

/** A recording recoverFn spy returning a canned RecoverResult. */
function makeRecoverSpy(canned) {
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

/** A minimal canned RecoverResult (a mark-failed-ish success). */
const CANNED = {
  ok: true, mode: 'mark-failed', code: 0, dryRun: false, snapshotId: 'snap-1',
  state: 'failed', journalPath: '/cfg/.mgr-state/snapshots/snap-1/apply-journal.json',
  rollback: null, diagnostics: [],
};

const CTX = (args) => ({ configDir: '/cfg', mgrStateDir: '/cfg/.mgr-state', args });

// ── no id ───────────────────────────────────────────────────────────────────────

test('recoverCommand: no id (empty positionals) → code:3, recover-no-id, spy NOT called', async () => {
  const spy = makeRecoverSpy(CANNED);
  const out = await recoverCommand(CTX({ positionals: [] }), { recoverFn: spy, env: {} });
  assert.equal(out.code, 3);
  assert.equal(out.result.status, 'no-id');
  assert.ok(out.diagnostics.some((d) => d.code === 'recover-no-id' && d.severity === 'error'));
  assert.equal(spy.calls.length, 0, 'the engine must not be called without an id');
});

test('recoverCommand: missing positionals array → code:3 recover-no-id (never throws)', async () => {
  const spy = makeRecoverSpy(CANNED);
  const out = await recoverCommand(CTX({}), { recoverFn: spy, env: {} });
  assert.equal(out.code, 3);
  assert.equal(out.result.status, 'no-id');
  assert.equal(spy.calls.length, 0);
});

// ── ambiguous mode ────────────────────────────────────────────────────────────────

test('recoverCommand: two mode flags → code:3 recover-ambiguous-mode, spy NOT called', async () => {
  const spy = makeRecoverSpy(CANNED);
  const out = await recoverCommand(
    CTX({ positionals: ['snap-1'], resume: true, rollback: true }),
    { recoverFn: spy, env: {} },
  );
  assert.equal(out.code, 3);
  assert.equal(out.result.status, 'ambiguous-mode');
  assert.ok(out.diagnostics.some((d) => d.code === 'recover-ambiguous-mode' && d.severity === 'error'));
  assert.equal(spy.calls.length, 0);
});

// ── default mode = mark-failed (always-write → needs --apply) ──────────────────────

test('recoverCommand: no mode flag defaults to mark-failed (refused without --apply)', async () => {
  const spy = makeRecoverSpy(CANNED);
  const out = await recoverCommand(CTX({ positionals: ['snap-1'] }), { recoverFn: spy, env: {} });
  // mark-failed is an always-write mode → without --apply it needs-apply, and the
  // refusal result names the resolved default mode.
  assert.equal(out.code, 3);
  assert.equal(out.result.status, 'needs-apply');
  assert.equal(out.result.mode, 'mark-failed', 'the default mode is mark-failed');
  assert.equal(spy.calls.length, 0);
});

// ── always-write modes without --apply → recover-needs-apply ──────────────────────

test('recoverCommand: --mark-failed without --apply → recover-needs-apply code3, recoverFn + loadPaths NOT called', async () => {
  const spy = makeRecoverSpy(CANNED);
  const loadPaths = makeLoadPaths();
  const out = await recoverCommand(
    CTX({ positionals: ['snap-1'], 'mark-failed': true }),
    { recoverFn: spy, loadPaths, env: {} },
  );
  assert.equal(out.code, 3);
  assert.equal(out.result.status, 'needs-apply');
  assert.equal(out.result.mode, 'mark-failed');
  assert.ok(out.diagnostics.some((d) => d.code === 'recover-needs-apply' && d.severity === 'error'));
  assert.equal(spy.calls.length, 0, 'engine must not run for an unarmed always-write mode');
  assert.equal(loadPaths.calls.length, 0, 'paths.mjs must not be loaded for an unarmed always-write mode');
});

test('recoverCommand: --resume without --apply → recover-needs-apply code3, recoverFn + loadPaths NOT called', async () => {
  const spy = makeRecoverSpy(CANNED);
  const loadPaths = makeLoadPaths();
  const out = await recoverCommand(
    CTX({ positionals: ['snap-1'], resume: true }),
    { recoverFn: spy, loadPaths, env: {} },
  );
  assert.equal(out.code, 3);
  assert.equal(out.result.status, 'needs-apply');
  assert.equal(out.result.mode, 'resume');
  assert.ok(out.diagnostics.some((d) => d.code === 'recover-needs-apply'));
  assert.equal(spy.calls.length, 0);
  assert.equal(loadPaths.calls.length, 0);
});

// ── ASYMMETRY: --rollback dry-run STILL loads the gate ────────────────────────────

test('recoverCommand: --rollback without --apply → engine called with enableWrites:false AND loadPaths WAS called', async () => {
  const canned = { ok: true, mode: 'rollback', code: 0, dryRun: true, snapshotId: 'snap-1',
    state: 'applying', journalPath: null, rollback: { ok: true, status: 'dry-run', restore: null }, diagnostics: [] };
  const spy = makeRecoverSpy(canned);
  const loadPaths = makeLoadPaths();
  const out = await recoverCommand(
    CTX({ positionals: ['snap-1'], rollback: true }),
    { recoverFn: spy, loadPaths, env: {} },
  );
  // The asymmetry vs rollbackCommand: recover loads the gate even for a dry-run,
  // because validateRecoverTarget requires assertWritable for EVERY mode.
  assert.equal(loadPaths.calls.length, 1, 'recover loads paths.mjs even on a dry-run rollback');
  assert.equal(spy.calls.length, 1, 'engine called once');
  assert.equal(spy.calls[0].mode, 'rollback');
  assert.equal(spy.calls[0].enableWrites, false, 'dry-run → enableWrites:false');
  assert.equal(spy.calls[0].assertWritable, loadPaths.gate, 'the gate is threaded in even for dry-run');
  assert.equal(spy.calls[0].snapshotId, 'snap-1');
  assert.equal(spy.calls[0].targetClaudeDir, '/cfg');
  assert.equal(spy.calls[0].mgrStateDir, '/cfg/.mgr-state');
  assert.equal(spy.calls[0].expectedTarget, '/cfg', 'expectedTarget = configDir (cross-target guard)');
  assert.equal(out.code, 0);
  assert.equal(out.result.mode, 'rollback');
  assert.equal(out.result.dryRun, true);
});

// ── --apply + env closed → two-factor refusal ─────────────────────────────────────

test('recoverCommand: --apply + env closed → code:3 writes-disabled-env, recoverFn + loadPaths NEVER called', async () => {
  const spy = makeRecoverSpy(CANNED);
  const loadPaths = makeLoadPaths();
  const out = await recoverCommand(
    CTX({ positionals: ['snap-1'], rollback: true, apply: true }),
    { recoverFn: spy, loadPaths, env: {} },
  );
  assert.equal(out.code, 3);
  assert.equal(out.result.status, 'refused');
  assert.equal(out.result.mode, 'rollback');
  assert.ok(out.diagnostics.some((d) => d.code === 'writes-disabled-env' && d.severity === 'error'));
  assert.equal(spy.calls.length, 0, 'the engine must NOT run when the gate is closed');
  assert.equal(loadPaths.calls.length, 0, 'paths.mjs must NOT be loaded when the gate is closed');
});

// ── --apply + env "1" → real apply path ───────────────────────────────────────────

test('recoverCommand: --apply + env=1 + --rollback → enableWrites:true, mode rollback, gate from loadPaths', async () => {
  const canned = { ok: true, mode: 'rollback', code: 0, dryRun: false, snapshotId: 'snap-1',
    state: 'rolled-back', journalPath: '/j', rollback: { ok: true, status: 'restored', restore: { restored: true, skipped: [] } }, diagnostics: [] };
  const spy = makeRecoverSpy(canned);
  const loadPaths = makeLoadPaths();
  const out = await recoverCommand(
    CTX({ positionals: ['snap-1'], rollback: true, apply: true }),
    { recoverFn: spy, loadPaths, env: { CLAUDE_MGR_ENABLE_WRITES: '1' } },
  );
  assert.equal(loadPaths.calls.length, 1, 'paths.mjs loaded exactly once on the real apply path');
  assert.equal(spy.calls.length, 1);
  assert.equal(spy.calls[0].mode, 'rollback');
  assert.equal(spy.calls[0].enableWrites, true, '--apply + env=1 → enableWrites:true');
  assert.equal(spy.calls[0].assertWritable, loadPaths.gate, 'the gate threaded into the engine is the one loadPaths returned');
  assert.equal(out.code, 0);
  assert.equal(out.result.ok, true);
  assert.equal(out.result.restored, true, 'summary reflects the nested rollback restore flag');
});

test('recoverCommand: --apply + env=1 + --mark-failed → engine called with enableWrites:true, mode mark-failed', async () => {
  const spy = makeRecoverSpy(CANNED);
  const loadPaths = makeLoadPaths();
  const out = await recoverCommand(
    CTX({ positionals: ['snap-1'], 'mark-failed': true, apply: true }),
    { recoverFn: spy, loadPaths, env: { CLAUDE_MGR_ENABLE_WRITES: '1' } },
  );
  assert.equal(loadPaths.calls.length, 1);
  assert.equal(spy.calls.length, 1);
  assert.equal(spy.calls[0].mode, 'mark-failed');
  assert.equal(spy.calls[0].enableWrites, true);
  assert.equal(out.code, 0);
  assert.equal(out.result.state, 'failed');
});

// ── M2 degrade (loadPaths throws) ─────────────────────────────────────────────────

test('recoverCommand: --rollback --apply env=1 but loadPaths throws → recover-unavailable warn, code:1, spy NEVER called', async () => {
  const spy = makeRecoverSpy(CANNED);
  const loadPaths = () => Promise.reject(new Error('no hooks lib'));
  const out = await recoverCommand(
    CTX({ positionals: ['snap-1'], rollback: true, apply: true }),
    { recoverFn: spy, loadPaths, env: { CLAUDE_MGR_ENABLE_WRITES: '1' } },
  );
  assert.equal(out.result.status, 'write-unavailable');
  assert.equal(out.result.mode, 'rollback');
  assert.equal(out.code, 1);
  assert.ok(out.diagnostics.some((d) => d.code === 'recover-unavailable' && d.severity === 'warn'),
    JSON.stringify(out.diagnostics));
  assert.equal(spy.calls.length, 0, 'the engine must NOT run when the gate is unavailable');
});

// ── --force threading ─────────────────────────────────────────────────────────────

test('recoverCommand: --force is threaded to the engine as force:true (dry-run rollback)', async () => {
  const spy = makeRecoverSpy({ ok: true, mode: 'rollback', code: 0, dryRun: true, snapshotId: 'snap-1', rollback: null, diagnostics: [] });
  const loadPaths = makeLoadPaths();
  const out = await recoverCommand(
    CTX({ positionals: ['snap-1'], rollback: true, force: true }),
    { recoverFn: spy, loadPaths, env: {} },
  );
  assert.equal(spy.calls.length, 1);
  assert.equal(spy.calls[0].force, true, '--force reaches the engine');
  assert.equal(spy.calls[0].enableWrites, false, 'force on a dry-run does not enable writes');
  assert.equal(out.code, 0);
});

test('recoverCommand: absent --force defaults to force:false', async () => {
  const spy = makeRecoverSpy({ ok: true, mode: 'rollback', code: 0, dryRun: true, snapshotId: 'snap-1', rollback: null, diagnostics: [] });
  const loadPaths = makeLoadPaths();
  await recoverCommand(
    CTX({ positionals: ['snap-1'], rollback: true }),
    { recoverFn: spy, loadPaths, env: {} },
  );
  assert.equal(spy.calls[0].force, false);
});

// ── engine code passthrough + defensive summary ───────────────────────────────────

test('recoverCommand: the engine code is passed through as the CLI exit code', async () => {
  // a refused-drift rollback carries code:3 from the engine — the CLI must surface it.
  const refused = { ok: false, mode: 'rollback', code: 3, dryRun: true, snapshotId: 'snap-1',
    state: 'applying', rollback: { ok: false, status: 'refused-drift', restore: null }, diagnostics: [] };
  const spy = makeRecoverSpy(refused);
  const loadPaths = makeLoadPaths();
  const out = await recoverCommand(
    CTX({ positionals: ['snap-1'], rollback: true }),
    { recoverFn: spy, loadPaths, env: {} },
  );
  assert.equal(out.code, 3, 'engine code:3 surfaced as the exit code');
  assert.equal(out.result.restored, null, 'no restore object → null');
});

test('recoverCommand: tolerates a partial engine result (missing fields → null/false, no throw)', async () => {
  const partial = { ok: false, mode: 'mark-failed', diagnostics: [] };
  const spy = makeRecoverSpy(partial);
  const loadPaths = makeLoadPaths();
  const out = await recoverCommand(
    CTX({ positionals: ['snap-1'], 'mark-failed': true, apply: true }),
    { recoverFn: spy, loadPaths, env: { CLAUDE_MGR_ENABLE_WRITES: '1' } },
  );
  assert.equal(out.result.mode, 'mark-failed');
  assert.equal(out.result.state, null, 'no state → null');
  assert.equal(out.result.journalPath, null, 'no journalPath → null');
  assert.equal(out.result.restored, null, 'no rollback → null');
  // engine returned no numeric code + ok:false → CLI falls back to 1.
  assert.equal(out.code, 1);
});

// ── never-throws on the engine seam ───────────────────────────────────────────────

test('recoverCommand: a throwing engine seam degrades to recover-unexpected-error code:1', async () => {
  const throwing = () => { throw new Error('boom'); };
  const loadPaths = makeLoadPaths();
  const out = await recoverCommand(
    CTX({ positionals: ['snap-1'], 'mark-failed': true, apply: true }),
    { recoverFn: throwing, loadPaths, env: { CLAUDE_MGR_ENABLE_WRITES: '1' } },
  );
  assert.equal(out.code, 1);
  assert.equal(out.result.status, 'error');
  assert.equal(out.result.mode, 'mark-failed');
  assert.ok(out.diagnostics.some((d) => d.code === 'recover-unexpected-error' && d.severity === 'error'));
});
