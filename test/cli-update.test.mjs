/**
 * P4b.U5 — test/cli-update.test.mjs
 *
 * Unit tests for src/cli/update-command.mjs + the COMMANDS registry wiring in
 * src/cli/commands.mjs and src/cli.mjs (run(argv)).
 *
 * All tests use injected `deps` seams (a deps-recorder pattern) so no real fs,
 * gate, or engine is invoked. Tests drive either updateCommand() directly or
 * run(argv) from cli.mjs.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { updateCommand } from '../src/cli/update-command.mjs';
import { updateCommand as updateCommandViaCommands } from '../src/cli/commands.mjs';
import { run } from '../src/cli.mjs';

// ── helpers ────────────────────────────────────────────────────────────────────

function makeCtx(positionals = [], extra = {}) {
  return {
    configDir: '/fake/claude',
    mgrStateDir: '/fake/claude/.mgr-state',
    args: Object.assign(Object.create(null), { positionals, ...extra }),
  };
}

/** A full-shape fake UpdateResult with overridable fields. */
function fakeResult(over = {}) {
  return {
    ok: false, refused: false, dryRun: false,
    plugin: null, claudeExe: null, command: null,
    snapshotId: null, spawned: false, apply: null, diagnostics: [],
    ...over,
  };
}

// ── 1. no spec → code 3, update-no-spec, updateFn + loadPaths NEVER called ─────

test('updateCommand: no spec → code 3, update-no-spec, updateFn + loadPaths never called', async () => {
  let updateCalled = false;
  let loadPathsCalled = false;
  const deps = {
    updateFn: () => { updateCalled = true; return Promise.resolve(fakeResult()); },
    loadPaths: () => { loadPathsCalled = true; return Promise.resolve({ assertWritable: (p) => p }); },
  };
  const out = await updateCommand(makeCtx([]), deps);
  assert.equal(out.code, 3);
  assert.ok(out.diagnostics.some((d) => d.code === 'update-no-spec'), 'expected update-no-spec');
  assert.equal(updateCalled, false, 'updateFn must not be called when spec is missing');
  assert.equal(loadPathsCalled, false, 'loadPaths must not be called when spec is missing');
});

test('updateCommand: empty-string spec → code 3, update-no-spec', async () => {
  let updateCalled = false;
  const deps = { updateFn: () => { updateCalled = true; return Promise.resolve(fakeResult()); } };
  const out = await updateCommand(makeCtx(['']), deps);
  assert.equal(out.code, 3);
  assert.ok(out.diagnostics.some((d) => d.code === 'update-no-spec'));
  assert.equal(updateCalled, false);
});

// ── 2. dry-run: engine called once with enableWrites:false; loadPaths never ────

test('updateCommand: dry-run somePlugin → code 0, status dry-run, loadPaths never called, enableWrites:false', async () => {
  let loadPathsCalled = false;
  let updateCalls = 0;
  let capturedOpts;
  const deps = {
    loadPaths: () => { loadPathsCalled = true; return Promise.resolve({ assertWritable: (p) => p }); },
    updateFn: (opts) => {
      updateCalls += 1;
      capturedOpts = opts;
      return Promise.resolve(fakeResult({
        ok: true, dryRun: true, command: ['plugin', 'update', 'x'], plugin: { key: 'x' },
      }));
    },
    env: {}, // no env var; --apply not set either, so dry-run
  };
  const out = await updateCommand(makeCtx(['x']), deps);
  assert.equal(out.code, 0, `expected code 0, got ${out.code}; diags: ${JSON.stringify(out.diagnostics)}`);
  assert.equal(out.result.status, 'dry-run');
  assert.equal(updateCalls, 1, 'updateFn must be called exactly once');
  assert.equal(capturedOpts.enableWrites, false, 'enableWrites must be false on dry-run');
  assert.equal(loadPathsCalled, false, 'loadPaths must NOT be called on dry-run (M2-safety)');
});

// ── 3. gate-closed: --apply without env var → code 3, engine + loadPaths never ─

test('updateCommand: --apply without CLAUDE_MGR_ENABLE_WRITES → code 3, writes-disabled-env, engine never', async () => {
  let updateCalled = false;
  let loadPathsCalled = false;
  const deps = {
    updateFn: () => { updateCalled = true; return Promise.resolve(fakeResult()); },
    loadPaths: () => { loadPathsCalled = true; return Promise.resolve({ assertWritable: (p) => p }); },
    env: {}, // env var NOT set
  };
  const out = await updateCommand(makeCtx(['x'], { apply: true }), deps);
  assert.equal(out.code, 3, `expected code 3, got ${out.code}`);
  assert.ok(out.diagnostics.some((d) => d.code === 'writes-disabled-env'), 'expected writes-disabled-env');
  assert.equal(updateCalled, false, 'updateFn must not be called when gate is closed');
  assert.equal(loadPathsCalled, false, 'loadPaths must not be called when gate is closed');
});

// ── 4. gate-open: --apply + env set → loadPaths called, enableWrites:true ──────

test('updateCommand: --apply + env set → code 0, loadPaths called, updateFn gets enableWrites:true + the assertWritable fn', async () => {
  let loadPathsCalled = false;
  let capturedOpts;
  const fakeAssertWritable = (p) => p;
  const deps = {
    loadPaths: () => { loadPathsCalled = true; return Promise.resolve({ assertWritable: fakeAssertWritable }); },
    updateFn: (opts) => {
      capturedOpts = opts;
      return Promise.resolve(fakeResult({
        ok: true, dryRun: false, spawned: true,
        plugin: { key: 'x', version: '1.0.0', marketplace: 'm' },
        command: ['plugin', 'update', 'x'], snapshotId: 'snap-1',
      }));
    },
    env: { CLAUDE_MGR_ENABLE_WRITES: '1' },
  };
  const out = await updateCommand(makeCtx(['x'], { apply: true }), deps);
  assert.equal(out.code, 0, `expected code 0, got ${out.code}; diags: ${JSON.stringify(out.diagnostics)}`);
  assert.equal(out.result.status, 'updated');
  assert.equal(out.result.snapshotId, 'snap-1');
  assert.equal(out.result.spawned, true);
  assert.equal(loadPathsCalled, true, 'loadPaths MUST be called on the real --apply path');
  assert.equal(capturedOpts.enableWrites, true, 'enableWrites must be true on --apply');
  assert.equal(capturedOpts.assertWritable, fakeAssertWritable, 'assertWritable must be the injected gate fn');
});

// ── 5. exit-code mapping ──────────────────────────────────────────────────────

test('updateCommand exit-code: refused (plugin-not-found) → code 2', async () => {
  const deps = {
    updateFn: () => Promise.resolve(fakeResult({
      refused: true,
      diagnostics: [{ severity: 'error', code: 'update-plugin-not-found', phase: 'update', message: 'not installed' }],
    })),
    env: {},
  };
  const out = await updateCommand(makeCtx(['x']), deps);
  assert.equal(out.code, 2, `expected code 2, got ${out.code}`);
  assert.equal(out.result.status, 'refused');
});

test('updateCommand exit-code: snapshot failure → code 4', async () => {
  const deps = {
    updateFn: () => Promise.resolve(fakeResult({
      ok: false,
      diagnostics: [{ severity: 'error', code: 'update-snapshot-failed', phase: 'update', message: 'snapshot failed' }],
    })),
    env: {},
  };
  const out = await updateCommand(makeCtx(['x']), deps);
  assert.equal(out.code, 4, `expected code 4, got ${out.code}`);
});

test('updateCommand exit-code: spawn failure → code 1', async () => {
  const deps = {
    updateFn: () => Promise.resolve(fakeResult({
      ok: false,
      diagnostics: [{ severity: 'error', code: 'update-spawn-failed', phase: 'update', message: 'spawn failed' }],
    })),
    env: {},
  };
  const out = await updateCommand(makeCtx(['x']), deps);
  assert.equal(out.code, 1, `expected code 1, got ${out.code}`);
});

test('updateCommand exit-code: ok → code 0', async () => {
  const deps = {
    updateFn: () => Promise.resolve(fakeResult({ ok: true, dryRun: true, plugin: { key: 'x' }, command: ['plugin', 'update', 'x'] })),
    env: {},
  };
  const out = await updateCommand(makeCtx(['x']), deps);
  assert.equal(out.code, 0, `expected code 0, got ${out.code}`);
});

// ── 6. never-throws: an updateFn that throws → code 1, update-unexpected-error ─

test('updateCommand: updateFn that throws → code 1, update-unexpected-error, no throw', async () => {
  const deps = {
    updateFn: () => { throw new Error('boom'); },
    env: {},
  };
  const out = await updateCommand(makeCtx(['x']), deps);
  assert.equal(out.code, 1, `expected code 1, got ${out.code}`);
  assert.ok(out.diagnostics.some((d) => d.code === 'update-unexpected-error'), 'expected update-unexpected-error');
  assert.equal(out.result.status, 'error');
});

// ── 7. --lock-version is threaded to updateFn.lockVersion ──────────────────────

test('updateCommand: --lock-version 1.2.3 → threaded to updateFn.lockVersion', async () => {
  let capturedOpts;
  const deps = {
    updateFn: (opts) => {
      capturedOpts = opts;
      return Promise.resolve(fakeResult({ ok: true, dryRun: true, plugin: { key: 'x' }, command: ['plugin', 'update', 'x'] }));
    },
    env: {},
  };
  // cli.mjs's flagKey leaves `--lock-version` as the args key 'lock-version'.
  const out = await updateCommand(makeCtx(['x'], { 'lock-version': '1.2.3' }), deps);
  assert.equal(out.code, 0);
  assert.equal(capturedOpts.lockVersion, '1.2.3', 'lockVersion must be threaded from args[\'lock-version\']');
});

// ── 8. COMMANDS registry: 'update' is registered + re-exported ─────────────────

test('commands.mjs: updateCommand is exported', () => {
  assert.equal(typeof updateCommandViaCommands, 'function', 'updateCommand should be a function export');
});

test('run(argv): update with no spec → code 3, update-no-spec', async () => {
  // run() dispatches through the live COMMANDS registry; no real fs needed because
  // the refusal happens before updatePlugin is ever called.
  const r = await run(['update', '--config-dir', '/nonexistent-dir-cmgr-test']);
  assert.equal(r.code, 3, `expected code 3, got ${r.code}; stdout: ${r.stdout.slice(0, 300)}`);
  assert.ok(
    r.stdout.includes('update-no-spec') || r.stdout.includes('no-spec') || r.stdout.includes('update'),
    `expected update-related output, got: ${r.stdout.slice(0, 300)}`,
  );
});

test('run(argv): update is wired (not unknown-command)', async () => {
  const r = await run(['update', '--config-dir', '/nonexistent-dir-cmgr-test']);
  assert.ok(!r.stdout.includes('unknown command: update'), `got "unknown command: update" — not wired: ${r.stdout.slice(0, 300)}`);
});

test('run(argv): usage text includes update <plugin>', async () => {
  const r = await run([]);
  assert.ok(r.stdout.includes('update'), `usage text should mention update, got: ${r.stdout.slice(0, 600)}`);
});
