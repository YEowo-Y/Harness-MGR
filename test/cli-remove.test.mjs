/**
 * P4a.U5 — test/cli-remove.test.mjs
 *
 * Unit tests for src/cli/remove-command.mjs + the COMMANDS registry wiring in
 * src/cli/commands.mjs and src/cli.mjs (run(argv)).
 *
 * All tests use injected `deps` seams so no real fs, gate, or engine is invoked.
 * Tests drive either removeCommand() directly or run(argv) from cli.mjs.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { removeCommand } from '../src/cli/remove-command.mjs';
import { removeCommand as removeCommandViaCommands } from '../src/cli/commands.mjs';
import { run } from '../src/cli.mjs';
import {
  mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ── helpers ────────────────────────────────────────────────────────────────────

function makeCtx(positionals = [], extra = {}) {
  return {
    configDir: '/fake/claude',
    mgrStateDir: '/fake/claude/.mgr-state',
    args: Object.assign(Object.create(null), { positionals, ...extra }),
  };
}

// ── 1. no spec → code 3, remove-no-spec, removeFn NEVER called ────────────────

test('removeCommand: no spec → code 3, remove-no-spec, removeFn never called', async () => {
  let called = false;
  const deps = { removeFn: () => { called = true; return {}; } };
  const ctx = makeCtx([]);
  const out = await removeCommand(ctx, deps);
  assert.equal(out.code, 3);
  assert.ok(out.diagnostics.some((d) => d.code === 'remove-no-spec'), 'expected remove-no-spec');
  assert.equal(called, false, 'removeFn must not be called when spec is missing');
});

test('removeCommand: empty-string spec → code 3, remove-no-spec', async () => {
  let called = false;
  const deps = { removeFn: () => { called = true; return {}; } };
  const ctx = makeCtx(['']);
  const out = await removeCommand(ctx, deps);
  assert.equal(out.code, 3);
  assert.ok(out.diagnostics.some((d) => d.code === 'remove-no-spec'));
  assert.equal(called, false);
});

// ── 2. dry-run: engine called once with enableWrites:false; loadPaths never ───

test('removeCommand: dry-run agent:foo → code 0, status dry-run, loadPaths never called', async () => {
  let loadPathsCalled = false;
  let removeCalls = 0;
  let capturedOpts;
  const deps = {
    loadPaths: () => { loadPathsCalled = true; return Promise.resolve({ assertWritable: (p) => p }); },
    removeFn: (opts) => {
      removeCalls += 1;
      capturedOpts = opts;
      return Promise.resolve({ ok: true, refused: false, dryRun: true, kind: 'agent', name: 'foo', target: '/fake/claude/agents/foo.md', plan: {}, apply: null, diagnostics: [] });
    },
    env: {},  // no HARNESS_MGR_ENABLE_WRITES → but --apply not set either, so dry-run
  };
  const ctx = makeCtx(['agent:foo']);
  const out = await removeCommand(ctx, deps);
  assert.equal(out.code, 0, `expected code 0, got ${out.code}; diags: ${JSON.stringify(out.diagnostics)}`);
  assert.equal(out.result.status, 'dry-run');
  assert.equal(removeCalls, 1, 'removeFn must be called exactly once');
  assert.equal(capturedOpts.enableWrites, false, 'enableWrites must be false on dry-run');
  assert.equal(loadPathsCalled, false, 'loadPaths must NOT be called on dry-run (M2-safety)');
});

// ── 3. refused kind (skill:x) → code 2, refused ───────────────────────────────

test('removeCommand: skill:x → code 2, refused (unsupported kind)', async () => {
  const deps = {
    removeFn: (_opts) => Promise.resolve({
      ok: false, refused: true, dryRun: false,
      kind: null, name: null, target: null, plan: null, apply: null,
      diagnostics: [{ severity: 'error', code: 'remove-kind-unsupported', phase: 'remove', message: 'skills unsupported' }],
    }),
    env: {},
  };
  const ctx = makeCtx(['skill:x']);
  const out = await removeCommand(ctx, deps);
  assert.equal(out.code, 2, `expected code 2, got ${out.code}`);
  assert.equal(out.result.status, 'refused');
});

// ── 4. --apply with env=0 (explicit opt-out) → code 3, writes-disabled-env, engine never ───

test('removeCommand: --apply with HARNESS_MGR_ENABLE_WRITES=0 → code 3, writes-disabled-env', async () => {
  let removeCalled = false;
  let loadPathsCalled = false;
  const deps = {
    removeFn: () => { removeCalled = true; return Promise.resolve({}); },
    loadPaths: () => { loadPathsCalled = true; return Promise.resolve({ assertWritable: (p) => p }); },
    env: { HARNESS_MGR_ENABLE_WRITES: '0' }, // explicit opt-out lock
  };
  const ctx = makeCtx(['agent:foo'], { apply: true });
  const out = await removeCommand(ctx, deps);
  assert.equal(out.code, 3, `expected code 3, got ${out.code}`);
  assert.ok(out.diagnostics.some((d) => d.code === 'writes-disabled-env'), 'expected writes-disabled-env');
  assert.equal(removeCalled, false, 'removeFn must not be called when gate is closed');
  assert.equal(loadPathsCalled, false, 'loadPaths must not be called when gate is closed');
});

// ── 4b. --apply with env UNSET → ENABLED (relaxation positive assertion) ─────

test('removeCommand: --apply + env unset → gate OPEN, loadPaths called, removeFn gets enableWrites:true', async () => {
  let capturedEnableWrites;
  let loadPathsCalled = false;
  const deps = {
    removeFn: (opts) => {
      capturedEnableWrites = opts.enableWrites;
      return Promise.resolve({
        ok: true, refused: false, dryRun: false,
        kind: 'agent', name: 'foo', target: '/fake/claude/agents/foo.md',
        plan: {}, apply: { ok: true, applied: true, snapshotId: 'x', lock: { acquired: true }, diagnostics: [] },
        diagnostics: [],
      });
    },
    loadPaths: () => { loadPathsCalled = true; return Promise.resolve({ assertWritable: (p) => p }); },
    env: {}, // env var NOT set → relaxed gate allows writes
  };
  const ctx = makeCtx(['agent:foo'], { apply: true });
  const out = await removeCommand(ctx, deps);
  assert.equal(out.code, 0, `expected code 0 (gate open), got ${out.code}; diags: ${JSON.stringify(out.diagnostics)}`);
  assert.equal(capturedEnableWrites, true, 'enableWrites must be true when env is unset (relaxed gate)');
  assert.equal(loadPathsCalled, true, 'loadPaths must be called when gate is open');
});

// ── 5. --apply with env set + loadPaths + recorder → code 0, enableWrites:true ─

test('removeCommand: --apply + env set → code 0, removeFn called with enableWrites:true + assertWritable fn', async () => {
  let capturedOpts;
  const fakeAssertWritable = (p) => p;
  const deps = {
    loadPaths: () => Promise.resolve({ assertWritable: fakeAssertWritable }),
    removeFn: (opts) => {
      capturedOpts = opts;
      return Promise.resolve({
        ok: true, refused: false, dryRun: false,
        kind: 'agent', name: 'foo', target: '/fake/claude/agents/foo.md',
        plan: {}, apply: { ok: true, applied: true, snapshotId: 'x', lock: { acquired: true }, diagnostics: [] },
        diagnostics: [],
      });
    },
    env: { HARNESS_MGR_ENABLE_WRITES: '1' },
  };
  const ctx = makeCtx(['agent:foo'], { apply: true });
  const out = await removeCommand(ctx, deps);
  assert.equal(out.code, 0, `expected code 0, got ${out.code}; diags: ${JSON.stringify(out.diagnostics)}`);
  assert.equal(out.result.status, 'removed');
  assert.equal(out.result.applied, true);
  assert.equal(out.result.snapshotId, 'x');
  assert.equal(capturedOpts.enableWrites, true, 'enableWrites must be true on --apply');
  assert.equal(capturedOpts.assertWritable, fakeAssertWritable, 'assertWritable must be the injected gate fn');
});

// ── 6. exit-code mapping ──────────────────────────────────────────────────────

test('removeCommand exit-code: lock not acquired → code 6', async () => {
  const deps = {
    removeFn: () => Promise.resolve({
      ok: false, refused: false, dryRun: false,
      kind: 'agent', name: 'foo', target: '/fake/claude/agents/foo.md',
      plan: {}, apply: { ok: false, applied: false, lock: { acquired: false }, diagnostics: [] },
      diagnostics: [],
    }),
    env: {},
  };
  const ctx = makeCtx(['agent:foo']);
  const out = await removeCommand(ctx, deps);
  assert.equal(out.code, 6, `expected code 6, got ${out.code}`);
});

test('removeCommand exit-code: apply-snapshot-failed → code 4', async () => {
  const deps = {
    removeFn: () => Promise.resolve({
      ok: false, refused: false, dryRun: false,
      kind: 'agent', name: 'foo', target: '/fake/claude/agents/foo.md',
      plan: {}, apply: {
        ok: false, applied: false,
        lock: { acquired: true },
        diagnostics: [{ severity: 'error', code: 'apply-snapshot-failed', phase: 'apply', message: 'snapshot failed' }],
      },
      diagnostics: [],
    }),
    env: {},
  };
  const ctx = makeCtx(['agent:foo']);
  const out = await removeCommand(ctx, deps);
  assert.equal(out.code, 4, `expected code 4, got ${out.code}`);
});

// ── 7. COMMANDS registry: 'remove' is registered + re-exported ────────────────

test('commands.mjs: removeCommand is exported', () => {
  assert.equal(typeof removeCommandViaCommands, 'function', 'removeCommand should be a function export');
});

test('run(argv): remove with no spec → code 3', async () => {
  // run() dispatches through the live COMMANDS registry; no real fs needed because
  // the refusal happens before removeComponent is ever called.
  const r = await run(['remove', '--config-dir', '/nonexistent-dir-cmgr-test']);
  assert.equal(r.code, 3, `expected code 3, got ${r.code}`);
  assert.ok(r.stdout.includes('remove-no-spec') || r.stdout.includes('no-spec') || r.stdout.includes('remove'), `expected remove-related output, got: ${r.stdout.slice(0, 300)}`);
});

test('run(argv): remove unknown command dispatches to remove (not unknown-command)', async () => {
  // Confirm "remove" lands in the COMMANDS dispatch and doesn't hit the
  // "unknown command" branch (which means the registry entry is wired).
  const r = await run(['remove', '--config-dir', '/nonexistent-dir-cmgr-test']);
  // Should NOT see "unknown command: remove"
  assert.ok(!r.stdout.includes('unknown command: remove'), `got "unknown command: remove" — not wired: ${r.stdout.slice(0, 300)}`);
});

test('run(argv): usage text includes remove <kind>:<name>', async () => {
  const r = await run([]);
  assert.ok(r.stdout.includes('remove'), `usage text should mention remove, got: ${r.stdout.slice(0, 500)}`);
});

// ── 8. run(argv) dry-run with a real temp dir ─────────────────────────────────

test('run(argv): dry-run remove agent:foo → code 0, foo.md still exists', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'cmgr-cli-rm-'));
  try {
    mkdirSync(join(tmp, 'agents'), { recursive: true });
    writeFileSync(join(tmp, 'agents', 'foo.md'), '---\nname: foo\n---\n');

    const savedEnv = process.env.HARNESS_MGR_ENABLE_WRITES;
    delete process.env.HARNESS_MGR_ENABLE_WRITES;
    try {
      const r = await run(['remove', 'agent:foo', '--config-dir', tmp]);
      assert.equal(r.code, 0, `expected code 0, got ${r.code}; stdout: ${r.stdout.slice(0, 400)}`);
      assert.ok(existsSync(join(tmp, 'agents', 'foo.md')), 'dry-run must NOT delete agents/foo.md');
    } finally {
      if (savedEnv !== undefined) process.env.HARNESS_MGR_ENABLE_WRITES = savedEnv;
    }
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

test('run(argv): remove agent:nonexistent → code 2 (not found → refused)', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'cmgr-cli-rm-nf-'));
  try {
    mkdirSync(join(tmp, 'agents'), { recursive: true });
    // Do NOT create agents/nonexistent.md — the refusal should trigger.
    const r = await run(['remove', 'agent:nonexistent', '--config-dir', tmp]);
    assert.equal(r.code, 2, `expected code 2 (refused/not-found), got ${r.code}; stdout: ${r.stdout.slice(0, 400)}`);
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});
