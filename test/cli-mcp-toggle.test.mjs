/**
 * U4 oracle for the mcp-toggle CLI: src/cli/mcp-toggle-command.mjs + the --type mcp routing
 * through config-edit-command.mjs's claude branch.
 *
 * Hermetic: an injected setMcpEnabledFn records what the handler forwards; a fake loadPaths
 * supplies resolveAssertWritable; homedirFn fakes ~/.claude.json. NEVER spawns a real claude.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mcpToggleCommand } from '../src/cli/mcp-toggle-command.mjs';
import { disableCommand, enableCommand } from '../src/cli/config-edit-command.mjs';
import { claudeDescriptor } from '../src/targets/claude.mjs';

// Hermetic, never-touches-disk fixtures: just need OS-absolute paths so the handler's
// path.join() output is predictable on both Windows and Linux. Keep configDir / mgrStateDir
// siblings (mgr-state nested under the claude dir, as in production).
const HOME = join(tmpdir(), 'cmgr-mcp-home');
const CONFIG_DIR = join(tmpdir(), 'cmgr-mcp-claude');
const MGR_STATE_DIR = join(CONFIG_DIR, '.mgr-state');
// Expected ~/.claude.json — derive it exactly as the handler does so the assertion holds
// regardless of the platform's path separator.
const EXPECTED_APP_FILE = join(HOME, '.claude.json');

const claudeCtx = (args) => ({ configDir: CONFIG_DIR, mgrStateDir: MGR_STATE_DIR, args, descriptor: claudeDescriptor });

function makeDeps(over = {}) {
  const calls = [];
  const setMcpEnabledFn = async (o) => { calls.push(o); return { ok: true, refused: false, dryRun: !o.enableWrites, kind: 'mcp', name: o.name, desired: o.desired, action: o.desired ? 'enable' : 'disable', diagnostics: [] }; };
  setMcpEnabledFn.calls = calls;
  return { env: {}, setMcpEnabledFn, homedirFn: () => HOME, loadPaths: async () => ({ assertWritable: (p) => p, makeAssertWritable: () => ((p) => p) }), ...over };
}

test('disable --type mcp <name> dry-run: forwards desired:false + enableWrites:false + appFile, NO gate', async () => {
  const deps = makeDeps();
  const out = await mcpToggleCommand(claudeCtx({ type: 'mcp', positionals: ['context7'] }), deps, false, 'disable');
  assert.equal(out.code, 0);
  assert.equal(deps.setMcpEnabledFn.calls.length, 1);
  const c = deps.setMcpEnabledFn.calls[0];
  assert.equal(c.name, 'context7');
  assert.equal(c.desired, false);
  assert.equal(c.enableWrites, false);
  assert.equal(c.assertWritable, undefined, 'dry-run resolves NO gate');
  assert.equal(c.appFile, EXPECTED_APP_FILE);
  assert.equal(c.targetClaudeDir, CONFIG_DIR);
});

test('enable --type mcp sets desired:true', async () => {
  const deps = makeDeps();
  await mcpToggleCommand(claudeCtx({ type: 'mcp', positionals: ['ctx7'] }), deps, true, 'enable');
  assert.equal(deps.setMcpEnabledFn.calls[0].desired, true);
});

test('no name → no-name refusal (code 3), engine never called', async () => {
  const deps = makeDeps();
  const out = await mcpToggleCommand(claudeCtx({ type: 'mcp', positionals: [] }), deps, false, 'disable');
  assert.equal(out.code, 3);
  assert.ok(out.diagnostics.some((d) => d.code === 'disable-no-name'));
  assert.equal(deps.setMcpEnabledFn.calls.length, 0);
});

test('--path is not allowed for --type mcp (code 3)', async () => {
  const deps = makeDeps();
  const out = await mcpToggleCommand(claudeCtx({ type: 'mcp', positionals: ['x'], path: join(tmpdir(), 'x') }), deps, false, 'disable');
  assert.equal(out.code, 3);
  assert.ok(out.diagnostics.some((d) => d.code === 'disable-path-not-allowed'));
  assert.equal(deps.setMcpEnabledFn.calls.length, 0);
});

test('--apply resolves the bare gate + forwards enableWrites:true', async () => {
  const BARE = (p) => p;
  const deps = makeDeps({ loadPaths: async () => ({ assertWritable: BARE, makeAssertWritable: () => ((p) => p) }) });
  await mcpToggleCommand(claudeCtx({ type: 'mcp', positionals: ['ctx7'], apply: true }), deps, false, 'disable');
  const c = deps.setMcpEnabledFn.calls[0];
  assert.equal(c.enableWrites, true);
  assert.equal(c.assertWritable, BARE, 'claude → the bare paths.assertWritable');
});

test('--apply with CLAUDE_MGR_ENABLE_WRITES=0 → env lock refusal, engine never called', async () => {
  const deps = makeDeps({ env: { CLAUDE_MGR_ENABLE_WRITES: '0' } });
  const out = await mcpToggleCommand(claudeCtx({ type: 'mcp', positionals: ['ctx7'], apply: true }), deps, false, 'disable');
  assert.equal(out.code, 3);
  assert.ok(out.diagnostics.some((d) => d.code === 'writes-disabled-env'));
  assert.equal(deps.setMcpEnabledFn.calls.length, 0);
});

test('exit codes: refused → 2; ok → 0; a plain failure (not refused, not ok) → 1', async () => {
  const refusedDeps = makeDeps({ setMcpEnabledFn: async () => ({ refused: true, ok: false, diagnostics: [] }) });
  assert.equal((await mcpToggleCommand(claudeCtx({ type: 'mcp', positionals: ['x'] }), refusedDeps, false, 'disable')).code, 2);
  const okDeps = makeDeps({ setMcpEnabledFn: async () => ({ ok: true, diagnostics: [] }) });
  assert.equal((await mcpToggleCommand(claudeCtx({ type: 'mcp', positionals: ['x'] }), okDeps, false, 'disable')).code, 0);
  const failDeps = makeDeps({ setMcpEnabledFn: async () => ({ ok: false, refused: false, diagnostics: [] }) });
  assert.equal((await mcpToggleCommand(claudeCtx({ type: 'mcp', positionals: ['x'] }), failDeps, false, 'disable')).code, 1);
});

test('--apply but the gate (loadPaths) is unloadable → write-unavailable, code 1, engine never called', async () => {
  const deps = makeDeps({ loadPaths: async () => { throw new Error('boom'); } });
  const out = await mcpToggleCommand(claudeCtx({ type: 'mcp', positionals: ['x'], apply: true }), deps, false, 'disable');
  assert.equal(out.code, 1);
  assert.ok(out.diagnostics.some((d) => d.code === 'disable-write-unavailable'));
  assert.equal(deps.setMcpEnabledFn.calls.length, 0);
});


test('the engine throwing is caught → unexpected-error, code 1', async () => {
  const deps = makeDeps({ setMcpEnabledFn: async () => { throw new Error('boom'); } });
  const out = await mcpToggleCommand(claudeCtx({ type: 'mcp', positionals: ['x'] }), deps, false, 'disable');
  assert.equal(out.code, 1);
  assert.ok(out.diagnostics.some((d) => d.code === 'disable-unexpected-error'));
});

// ── routing through config-edit-command's claude branch ──────────────────────────

test('disableCommand routes --type mcp (claude) to the mcp-toggle engine', async () => {
  const deps = makeDeps();
  const out = await disableCommand(claudeCtx({ type: 'mcp', positionals: ['context7'] }), deps);
  assert.equal(out.code, 0);
  assert.equal(deps.setMcpEnabledFn.calls.length, 1, 'routed to setMcpEnabledFn');
  assert.equal(deps.setMcpEnabledFn.calls[0].desired, false);
});

test('enableCommand routes --type mcp (claude) with desired:true', async () => {
  const deps = makeDeps();
  await enableCommand(claudeCtx({ type: 'mcp', positionals: ['context7'] }), deps);
  assert.equal(deps.setMcpEnabledFn.calls[0].desired, true);
});

test('--type skill (claude) is still declined (points to remove skill:), engine never called', async () => {
  const deps = makeDeps();
  const out = await disableCommand(claudeCtx({ type: 'skill', positionals: ['x'] }), deps);
  assert.equal(out.code, 3);
  assert.ok(out.diagnostics.some((d) => d.code === 'disable-claude-kind-unsupported'));
  assert.ok(out.diagnostics.some((d) => /remove skill/.test(d.message)));
  assert.equal(deps.setMcpEnabledFn.calls.length, 0);
});
