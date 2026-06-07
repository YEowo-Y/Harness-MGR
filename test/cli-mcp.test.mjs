/**
 * P4b.U6b — test/cli-mcp.test.mjs
 *
 * Unit tests for src/cli/mcp-command.mjs + the COMMANDS registry wiring in
 * src/cli/commands.mjs and src/cli.mjs (run(argv)) — including the two-word
 * `mcp remove` canonicalize branch.
 *
 * All tests use injected `deps` seams (a deps-recorder pattern) so no real fs,
 * gate, or engine is invoked. Tests drive either mcpCommand() directly or
 * run(argv) from cli.mjs.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mcpCommand } from '../src/cli/mcp-command.mjs';
import { mcpCommand as mcpCommandViaCommands } from '../src/cli/commands.mjs';
import { run } from '../src/cli.mjs';

// ── helpers ────────────────────────────────────────────────────────────────────

function makeCtx(positionals = [], extra = {}) {
  return {
    configDir: '/fake/claude',
    mgrStateDir: '/fake/claude/.mgr-state',
    args: Object.assign(Object.create(null), { positionals, ...extra }),
  };
}

/** A full-shape fake McpRemoveResult with overridable fields. */
function fakeResult(over = {}) {
  return {
    ok: false, refused: false, dryRun: false,
    name: null, scope: null, server: null, claudeExe: null,
    command: null, snapshotId: null, spawned: false, apply: null, diagnostics: [],
    ...over,
  };
}

// ── 1. no name → code 3, mcp-no-spec, mcpFn + loadPaths NEVER called ───────────

test('mcpCommand: no name → code 3, mcp-no-spec, mcpFn + loadPaths never called', async () => {
  let mcpCalled = false;
  let loadPathsCalled = false;
  const deps = {
    mcpFn: () => { mcpCalled = true; return Promise.resolve(fakeResult()); },
    loadPaths: () => { loadPathsCalled = true; return Promise.resolve({ assertWritable: (p) => p }); },
  };
  const out = await mcpCommand(makeCtx([]), deps);
  assert.equal(out.code, 3);
  assert.ok(out.diagnostics.some((d) => d.code === 'mcp-no-spec'), 'expected mcp-no-spec');
  assert.equal(mcpCalled, false, 'mcpFn must not be called when name is missing');
  assert.equal(loadPathsCalled, false, 'loadPaths must not be called when name is missing');
});

test('mcpCommand: empty-string name → code 3, mcp-no-spec', async () => {
  let mcpCalled = false;
  const deps = { mcpFn: () => { mcpCalled = true; return Promise.resolve(fakeResult()); } };
  const out = await mcpCommand(makeCtx(['']), deps);
  assert.equal(out.code, 3);
  assert.ok(out.diagnostics.some((d) => d.code === 'mcp-no-spec'));
  assert.equal(mcpCalled, false);
});

// ── 2. dry-run: engine called once with enableWrites:false; loadPaths never ─────

test('mcpCommand: dry-run someServer → code 0, status dry-run, loadPaths never called, enableWrites:false, appFile + scope threaded', async () => {
  let loadPathsCalled = false;
  let mcpCalls = 0;
  let capturedOpts;
  const deps = {
    loadPaths: () => { loadPathsCalled = true; return Promise.resolve({ assertWritable: (p) => p }); },
    mcpFn: (opts) => {
      mcpCalls += 1;
      capturedOpts = opts;
      return Promise.resolve(fakeResult({
        ok: true, dryRun: true, refused: false, command: ['mcp', 'remove', 'x'], name: 'x',
      }));
    },
    env: {}, // no env var; --apply not set either, so dry-run
    homedirFn: () => '/home/tester',
  };
  const out = await mcpCommand(makeCtx(['x'], { scope: 'project' }), deps);
  assert.equal(out.code, 0, `expected code 0, got ${out.code}; diags: ${JSON.stringify(out.diagnostics)}`);
  assert.equal(out.result.status, 'dry-run');
  assert.equal(mcpCalls, 1, 'mcpFn must be called exactly once');
  assert.equal(capturedOpts.enableWrites, false, 'enableWrites must be false on dry-run');
  assert.equal(capturedOpts.scope, 'project', 'scope must be threaded');
  assert.equal(capturedOpts.appFile, join('/home/tester', '.claude.json'), 'appFile must be derived from homedir (join semantics, platform-aware)');
  assert.equal(capturedOpts.name, 'x', 'name must be threaded from positionals[0]');
  assert.equal(loadPathsCalled, false, 'loadPaths must NOT be called on dry-run (M2-safety)');
});

// ── 3. gate-closed: --apply without env var → code 3, engine + loadPaths never ──

test('mcpCommand: --apply without CLAUDE_MGR_ENABLE_WRITES → code 3, writes-disabled-env, engine never', async () => {
  let mcpCalled = false;
  let loadPathsCalled = false;
  const deps = {
    mcpFn: () => { mcpCalled = true; return Promise.resolve(fakeResult()); },
    loadPaths: () => { loadPathsCalled = true; return Promise.resolve({ assertWritable: (p) => p }); },
    env: {}, // env var NOT set
  };
  const out = await mcpCommand(makeCtx(['x'], { apply: true }), deps);
  assert.equal(out.code, 3, `expected code 3, got ${out.code}`);
  assert.ok(out.diagnostics.some((d) => d.code === 'writes-disabled-env'), 'expected writes-disabled-env');
  assert.equal(mcpCalled, false, 'mcpFn must not be called when gate is closed');
  assert.equal(loadPathsCalled, false, 'loadPaths must not be called when gate is closed');
});

// ── 4. gate-open: --apply + env set → loadPaths called, enableWrites:true ───────

test('mcpCommand: --apply + env set → code 0, loadPaths called, mcpFn gets enableWrites:true + the assertWritable fn', async () => {
  let loadPathsCalled = false;
  let capturedOpts;
  const fakeAssertWritable = (p) => p;
  const deps = {
    loadPaths: () => { loadPathsCalled = true; return Promise.resolve({ assertWritable: fakeAssertWritable }); },
    mcpFn: (opts) => {
      capturedOpts = opts;
      return Promise.resolve(fakeResult({
        ok: true, dryRun: false, spawned: true,
        name: 'x', scope: 'project',
        server: { name: 'x', scope: 'project', transport: 'stdio' },
        command: ['mcp', 'remove', 'x', '--scope', 'project'], snapshotId: 'snap-1',
      }));
    },
    env: { CLAUDE_MGR_ENABLE_WRITES: '1' },
  };
  const out = await mcpCommand(makeCtx(['x'], { apply: true, scope: 'project' }), deps);
  assert.equal(out.code, 0, `expected code 0, got ${out.code}; diags: ${JSON.stringify(out.diagnostics)}`);
  assert.equal(out.result.status, 'removed');
  assert.equal(out.result.snapshotId, 'snap-1');
  assert.equal(out.result.spawned, true);
  assert.deepEqual(out.result.server, { name: 'x', scope: 'project', transport: 'stdio' });
  assert.equal(loadPathsCalled, true, 'loadPaths MUST be called on the real --apply path');
  assert.equal(capturedOpts.enableWrites, true, 'enableWrites must be true on --apply');
  assert.equal(capturedOpts.assertWritable, fakeAssertWritable, 'assertWritable must be the injected gate fn');
});

// ── 5. --scope threading on the dry-run path ───────────────────────────────────

test('mcpCommand: --scope project → threaded to mcpFn.scope', async () => {
  let capturedOpts;
  const deps = {
    mcpFn: (opts) => {
      capturedOpts = opts;
      return Promise.resolve(fakeResult({ ok: true, dryRun: true, name: 'x', scope: 'project', command: ['mcp', 'remove', 'x', '--scope', 'project'] }));
    },
    env: {},
  };
  const out = await mcpCommand(makeCtx(['x'], { scope: 'project' }), deps);
  assert.equal(out.code, 0);
  assert.equal(capturedOpts.scope, 'project', 'scope must be threaded from args.scope');
});

// ── 6. exit-code mapping ───────────────────────────────────────────────────────

test('mcpCommand exit-code: refused → code 2', async () => {
  const deps = {
    mcpFn: () => Promise.resolve(fakeResult({
      refused: true,
      diagnostics: [{ severity: 'error', code: 'mcp-bad-spec', phase: 'mcp', message: 'bad name' }],
    })),
    env: {},
  };
  const out = await mcpCommand(makeCtx(['x']), deps);
  assert.equal(out.code, 2, `expected code 2, got ${out.code}`);
  assert.equal(out.result.status, 'refused');
});

test('mcpCommand exit-code: snapshot failure → code 4', async () => {
  const deps = {
    mcpFn: () => Promise.resolve(fakeResult({
      ok: false,
      diagnostics: [{ severity: 'error', code: 'mcp-snapshot-failed', phase: 'mcp', message: 'snapshot failed' }],
    })),
    env: {},
  };
  const out = await mcpCommand(makeCtx(['x']), deps);
  assert.equal(out.code, 4, `expected code 4, got ${out.code}`);
});

test('mcpCommand exit-code: spawn failure → code 1', async () => {
  const deps = {
    mcpFn: () => Promise.resolve(fakeResult({
      ok: false,
      diagnostics: [{ severity: 'error', code: 'mcp-spawn-failed', phase: 'mcp', message: 'spawn failed' }],
    })),
    env: {},
  };
  const out = await mcpCommand(makeCtx(['x']), deps);
  assert.equal(out.code, 1, `expected code 1, got ${out.code}`);
});

test('mcpCommand exit-code: ok → code 0', async () => {
  const deps = {
    mcpFn: () => Promise.resolve(fakeResult({ ok: true, dryRun: true, name: 'x', command: ['mcp', 'remove', 'x'] })),
    env: {},
  };
  const out = await mcpCommand(makeCtx(['x']), deps);
  assert.equal(out.code, 0, `expected code 0, got ${out.code}`);
});

// ── 7. never-throws: an mcpFn that throws → code 1, mcp-unexpected-error ────────

test('mcpCommand: mcpFn that throws → code 1, mcp-unexpected-error, no throw', async () => {
  const deps = {
    mcpFn: () => { throw new Error('boom'); },
    env: {},
  };
  const out = await mcpCommand(makeCtx(['x']), deps);
  assert.equal(out.code, 1, `expected code 1, got ${out.code}`);
  assert.ok(out.diagnostics.some((d) => d.code === 'mcp-unexpected-error'), 'expected mcp-unexpected-error');
  assert.equal(out.result.status, 'error');
});

// ── 8. COMMANDS registry: 'mcp:remove' is registered + re-exported ─────────────

test('commands.mjs: mcpCommand is exported', () => {
  assert.equal(typeof mcpCommandViaCommands, 'function', 'mcpCommand should be a function export');
});

// ── 9. canonicalize: `mcp remove foo --scope project` routes to mcp:remove ──────

test('run(argv): mcp remove with no name → code 3, mcp-no-spec', async () => {
  // run() dispatches through the live COMMANDS registry; no real fs needed because
  // the refusal happens before mcpRemove is ever called.
  const r = await run(['mcp', 'remove', '--config-dir', '/nonexistent-dir-cmgr-test']);
  assert.equal(r.code, 3, `expected code 3, got ${r.code}; stdout: ${r.stdout.slice(0, 300)}`);
  assert.ok(
    r.stdout.includes('mcp-no-spec') || r.stdout.includes('no-spec'),
    `expected mcp-no-spec output, got: ${r.stdout.slice(0, 300)}`,
  );
});

test('run(argv): mcp remove is wired (not unknown-command)', async () => {
  const r = await run(['mcp', 'remove', '--config-dir', '/nonexistent-dir-cmgr-test']);
  assert.ok(!r.stdout.includes('unknown command: mcp'), `got "unknown command: mcp" — not wired: ${r.stdout.slice(0, 300)}`);
});

test('run(argv): `mcp remove foo --scope project` routes to mcp:remove with name foo + scope project (dry-run)', async () => {
  // Drive run() with a fake engine injected via deps on the COMMANDS registry is not
  // possible (registry passes only ctx), so route through run() with a non-existent
  // config dir + a real (dry-run) engine. The dry-run path never spawns/writes; it
  // resolves the name + scope and previews. We assert it routed (code 0) and the
  // name/scope reached the result summary.
  const r = await run(['mcp', 'remove', 'foo', '--scope', 'project', '--config-dir', '/nonexistent-dir-cmgr-test', '--format', 'json']);
  assert.equal(r.code, 0, `expected code 0 (dry-run preview), got ${r.code}; stdout: ${r.stdout.slice(0, 400)}`);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.command, 'mcp:remove', `expected command mcp:remove, got ${parsed.command}`);
  assert.equal(parsed.result.name, 'foo', `expected name foo, got ${parsed.result.name}`);
  assert.equal(parsed.result.scope, 'project', `expected scope project, got ${parsed.result.scope}`);
  assert.equal(parsed.result.status, 'dry-run', `expected dry-run, got ${parsed.result.status}`);
});

test('run(argv): usage text includes mcp remove <name>', async () => {
  const r = await run([]);
  assert.ok(r.stdout.includes('mcp remove'), `usage text should mention mcp remove, got: ${r.stdout.slice(0, 700)}`);
});
