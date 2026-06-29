/**
 * Tests for the disable/enable CLI handlers (src/cli/config-edit-command.mjs) — P6.
 *
 * Hermetic: an injected setEnabledFn records what the handler forwards, and a fake
 * loadPaths supplies makeAssertWritable so the --apply gate-resolution is exercised
 * without paths.mjs. Proves: a target without config-edit support refuses (Claude);
 * missing --type / name refuse; dry-run forwards desired+enableWrites:false and resolves
 * NO gate; enable sets desired:true; --apply resolves the codex-bound gate + forwards the
 * snapshot scope; the HARNESS_MGR_ENABLE_WRITES=0 lock refuses before the engine.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { disableCommand, enableCommand } from '../src/cli/config-edit-command.mjs';
import { codexDescriptor } from '../src/targets/codex.mjs';
import { claudeDescriptor } from '../src/targets/claude.mjs';

const codexCtx = (args) => ({ configDir: 'C:\\codex', mgrStateDir: 'C:\\codex\\.mgr-state', args, descriptor: codexDescriptor });
const claudeCtx = (args) => ({ configDir: 'C:\\claude', mgrStateDir: 'C:\\claude\\.mgr-state', args, descriptor: claudeDescriptor });

function makeDeps(over = {}) {
  const calls = [];
  const setEnabledFn = async (o) => { calls.push(o); return { ok: true, refused: false, dryRun: !o.enableWrites, kind: o.kind, name: o.name, desired: o.desired, diagnostics: [] }; };
  setEnabledFn.calls = calls;
  const pcalls = [];
  const setPluginEnabledFn = async (o) => { pcalls.push(o); return { ok: true, refused: false, dryRun: !o.enableWrites, kind: 'plugin', name: o.key, desired: o.desired, diagnostics: [] }; };
  setPluginEnabledFn.calls = pcalls;
  const mcalls = [];
  const setMcpEnabledFn = async (o) => { mcalls.push(o); return { ok: true, refused: false, dryRun: !o.enableWrites, kind: 'mcp', name: o.name, desired: o.desired, diagnostics: [] }; };
  setMcpEnabledFn.calls = mcalls;
  return { env: {}, setEnabledFn, setPluginEnabledFn, setMcpEnabledFn, homedirFn: () => 'C:\\Users\\me', loadPaths: async () => ({ assertWritable: (p) => p, makeAssertWritable: () => ((p) => p) }), ...over };
}

test('unsupported target (no writeSurface) → refused, code 3, engine never called', async () => {
  const deps = makeDeps();
  const ctx = { configDir: 'C:\\claude', mgrStateDir: 'C:\\claude\\.mgr', args: { type: 'plugin', positionals: ['a@b'] }, descriptor: null };
  const out = await disableCommand(ctx, deps);
  assert.equal(out.code, 3);
  assert.ok(out.diagnostics.some((d) => d.code === 'disable-unsupported-target'));
  assert.equal(deps.setEnabledFn.calls.length, 0);
});

test('a surface with configEdit:false (Claude-like) is also unsupported', async () => {
  const deps = makeDeps();
  const ctx = { configDir: 'C:\\c', mgrStateDir: 'C:\\c\\.mgr', args: { type: 'plugin', positionals: ['a@b'] },
    descriptor: { writeSurface: { features: { configEdit: false }, configEditFiles: [] } } };
  const out = await disableCommand(ctx, deps);
  assert.equal(out.code, 3);
  assert.ok(out.diagnostics.some((d) => d.code === 'disable-unsupported-target'));
});

test('codex + no --type → refused (code 3)', async () => {
  const out = await disableCommand(codexCtx({ positionals: ['a@b'] }), makeDeps());
  assert.equal(out.code, 3);
  assert.ok(out.diagnostics.some((d) => d.code === 'disable-no-type'));
});

test('codex + --type plugin + no name → refused (code 3)', async () => {
  const out = await disableCommand(codexCtx({ type: 'plugin', positionals: [] }), makeDeps());
  assert.equal(out.code, 3);
  assert.ok(out.diagnostics.some((d) => d.code === 'disable-no-name'));
});

test('disable dry-run: forwards desired:false + enableWrites:false; resolves NO gate', async () => {
  const deps = makeDeps();
  const out = await disableCommand(codexCtx({ type: 'plugin', positionals: ['superpowers@openai-curated'] }), deps);
  assert.equal(out.code, 0);
  assert.equal(deps.setEnabledFn.calls.length, 1);
  const c = deps.setEnabledFn.calls[0];
  assert.equal(c.desired, false);
  assert.equal(c.enableWrites, false);
  assert.equal(c.assertWritable, undefined, 'dry-run must not resolve a write gate');
  assert.equal(c.configFile, 'config.toml');
  assert.equal(c.targetClaudeDir, 'C:\\codex');
});

test('enable sets desired:true', async () => {
  const deps = makeDeps();
  await enableCommand(codexCtx({ type: 'plugin', positionals: ['x@y'] }), deps);
  assert.equal(deps.setEnabledFn.calls[0].desired, true);
});

test('disable --type mcp forwards kind:mcp + the server name (the engine owns the insert policy)', async () => {
  const deps = makeDeps();
  const out = await disableCommand(codexCtx({ type: 'mcp', positionals: ['context7'] }), deps);
  assert.equal(out.code, 0);
  const c = deps.setEnabledFn.calls[0];
  assert.equal(c.kind, 'mcp');
  assert.equal(c.name, 'context7');
  assert.equal(c.desired, false);
});

// ── skill: name (positional) vs --path selector duality ──────────────────────────────

test('disable --type skill <name> → forwards selectorField:name + the positional value', async () => {
  const deps = makeDeps();
  const out = await disableCommand(codexCtx({ type: 'skill', positionals: ['ab-test-setup'] }), deps);
  assert.equal(out.code, 0);
  const c = deps.setEnabledFn.calls[0];
  assert.equal(c.kind, 'skill');
  assert.equal(c.name, 'ab-test-setup');
  assert.equal(c.selectorField, 'name');
});

test('disable --type skill --path <path> → forwards selectorField:path + the path value', async () => {
  const deps = makeDeps();
  const out = await disableCommand(codexCtx({ type: 'skill', path: 'C:/Users/alice/.codex/skills/x/SKILL.md' }), deps);
  assert.equal(out.code, 0);
  const c = deps.setEnabledFn.calls[0];
  assert.equal(c.name, 'C:/Users/alice/.codex/skills/x/SKILL.md');
  assert.equal(c.selectorField, 'path');
});

test('--type skill with BOTH a name and --path → selector-conflict refusal (code 3, engine never called)', async () => {
  const deps = makeDeps();
  const out = await disableCommand(codexCtx({ type: 'skill', positionals: ['ab-test-setup'], path: 'C:/x/SKILL.md' }), deps);
  assert.equal(out.code, 3);
  assert.ok(out.diagnostics.some((d) => d.code === 'disable-skill-selector-conflict'));
  assert.equal(deps.setEnabledFn.calls.length, 0);
});

test('--type skill with NEITHER name nor --path → no-name refusal (code 3)', async () => {
  const deps = makeDeps();
  const out = await disableCommand(codexCtx({ type: 'skill', positionals: [] }), deps);
  assert.equal(out.code, 3);
  assert.ok(out.diagnostics.some((d) => d.code === 'disable-no-name'));
  assert.equal(deps.setEnabledFn.calls.length, 0);
});

test('--path on a NON-skill kind (plugin) → path-not-allowed refusal (code 3)', async () => {
  const deps = makeDeps();
  const out = await disableCommand(codexCtx({ type: 'plugin', positionals: ['a@b'], path: 'C:/x' }), deps);
  assert.equal(out.code, 3);
  assert.ok(out.diagnostics.some((d) => d.code === 'disable-path-not-allowed'));
  assert.equal(deps.setEnabledFn.calls.length, 0);
});

test('--apply resolves the codex-bound gate and forwards enableWrites:true + the snapshot scope', async () => {
  const GATE = (p) => p;
  const deps = makeDeps({ loadPaths: async () => ({ assertWritable: (p) => p, makeAssertWritable: () => GATE }) });
  await disableCommand(codexCtx({ type: 'plugin', positionals: ['x@y'], apply: true }), deps);
  const c = deps.setEnabledFn.calls[0];
  assert.equal(c.enableWrites, true);
  assert.equal(c.assertWritable, GATE);
  assert.deepEqual(c.scope, codexDescriptor.snapshotScope);
});

test('--apply with HARNESS_MGR_ENABLE_WRITES=0 → refused (env lock), engine never called', async () => {
  const deps = makeDeps({ env: { HARNESS_MGR_ENABLE_WRITES: '0' } });
  const out = await disableCommand(codexCtx({ type: 'plugin', positionals: ['x@y'], apply: true }), deps);
  assert.equal(out.code, 3);
  assert.ok(out.diagnostics.some((d) => d.code === 'writes-disabled-env'));
  assert.equal(deps.setEnabledFn.calls.length, 0);
});

// ── exit-code + error-handling contract (defensive branches) ──

test('exit code maps lock-not-acquired → 6 and snapshot-failed → 4 and a bare failure → 1', async () => {
  const cases = [
    [{ ok: false, refused: false, apply: { lock: { acquired: false } }, diagnostics: [] }, 6],
    [{ ok: false, refused: false, apply: { diagnostics: [{ code: 'apply-snapshot-failed' }] }, diagnostics: [] }, 4],
    [{ ok: false, refused: false, apply: null, diagnostics: [] }, 1],
  ];
  for (const [result, code] of cases) {
    const deps = makeDeps({ setEnabledFn: async () => result });
    const out = await disableCommand(codexCtx({ type: 'plugin', positionals: ['x@y'] }), deps);
    assert.equal(out.code, code);
  }
});

test('--apply but the gate (loadPaths) is unloadable → write-unavailable, code 1, engine never called', async () => {
  const calls = [];
  const setEnabledFn = async (o) => { calls.push(o); return { ok: true, diagnostics: [] }; };
  const deps = { env: {}, setEnabledFn, loadPaths: async () => { throw new Error('boom'); } };
  const out = await disableCommand(codexCtx({ type: 'plugin', positionals: ['x@y'], apply: true }), deps);
  assert.equal(out.code, 1);
  assert.ok(out.diagnostics.some((d) => d.code === 'disable-write-unavailable'));
  assert.equal(calls.length, 0, 'the engine is not called when the gate cannot be resolved');
});

test('the engine throwing is caught → unexpected-error, code 1 (never propagates)', async () => {
  const deps = { env: {}, setEnabledFn: async () => { throw new Error('kaboom'); } };
  const out = await enableCommand(codexCtx({ type: 'mcp', positionals: ['context7'] }), deps);
  assert.equal(out.code, 1);
  assert.ok(out.diagnostics.some((d) => d.code === 'enable-unexpected-error'));
});

// ── CLAUDE plugin-toggle path (settings.json enabledPlugins; --type plugin only) ──────

test('claude + --type plugin dry-run → routes to setPluginEnabledFn (key+desired, NO gate), codex engine untouched', async () => {
  const deps = makeDeps();
  const out = await disableCommand(claudeCtx({ type: 'plugin', positionals: ['ecc@everything-claude-code'] }), deps);
  assert.equal(out.code, 0);
  assert.equal(deps.setEnabledFn.calls.length, 0, 'the codex (TOML) engine must NOT be called for claude');
  assert.equal(deps.setPluginEnabledFn.calls.length, 1);
  const c = deps.setPluginEnabledFn.calls[0];
  assert.equal(c.key, 'ecc@everything-claude-code');
  assert.equal(c.desired, false);
  assert.equal(c.enableWrites, false);
  assert.equal(c.assertWritable, undefined, 'dry-run must not resolve a write gate');
  assert.equal(c.targetClaudeDir, 'C:\\claude');
});

test('claude enable sets desired:true', async () => {
  const deps = makeDeps();
  await enableCommand(claudeCtx({ type: 'plugin', positionals: ['x@y'] }), deps);
  assert.equal(deps.setPluginEnabledFn.calls[0].desired, true);
});

test('claude + --type mcp → routes to the mcp-toggle engine (not the plugin/codex engine)', async () => {
  const deps = makeDeps();
  const out = await disableCommand(claudeCtx({ type: 'mcp', positionals: ['ctx7'] }), deps);
  assert.equal(out.code, 0);
  assert.equal(deps.setMcpEnabledFn.calls.length, 1, 'routed to the mcp toggle');
  assert.equal(deps.setMcpEnabledFn.calls[0].desired, false);
  assert.equal(deps.setPluginEnabledFn.calls.length, 0);
  assert.equal(deps.setEnabledFn.calls.length, 0);
});

test('claude + --type skill → claude-kind-unsupported (code 3)', async () => {
  const deps = makeDeps();
  const out = await disableCommand(claudeCtx({ type: 'skill', positionals: ['x'] }), deps);
  assert.equal(out.code, 3);
  assert.ok(out.diagnostics.some((d) => d.code === 'disable-claude-kind-unsupported'));
});

test('claude + --type plugin + no name → no-name (code 3)', async () => {
  const deps = makeDeps();
  const out = await enableCommand(claudeCtx({ type: 'plugin', positionals: [] }), deps);
  assert.equal(out.code, 3);
  assert.ok(out.diagnostics.some((d) => d.code === 'enable-no-name'));
  assert.equal(deps.setPluginEnabledFn.calls.length, 0);
});

test('claude + --type plugin + --path → path-not-allowed (code 3)', async () => {
  const deps = makeDeps();
  const out = await disableCommand(claudeCtx({ type: 'plugin', positionals: ['a@b'], path: 'C:/x' }), deps);
  assert.equal(out.code, 3);
  assert.ok(out.diagnostics.some((d) => d.code === 'disable-path-not-allowed'));
  assert.equal(deps.setPluginEnabledFn.calls.length, 0);
});

test('claude + no --type → no-type (code 3)', async () => {
  const deps = makeDeps();
  const out = await disableCommand(claudeCtx({ positionals: ['a@b'] }), deps);
  assert.equal(out.code, 3);
  assert.ok(out.diagnostics.some((d) => d.code === 'disable-no-type'));
});

test('claude --apply resolves the bare gate (byte-identical) + enableWrites:true + claude scope (undefined)', async () => {
  const BARE = (p) => p;
  const deps = makeDeps({ loadPaths: async () => ({ assertWritable: BARE, makeAssertWritable: () => ((p) => p) }) });
  await disableCommand(claudeCtx({ type: 'plugin', positionals: ['x@y'], apply: true }), deps);
  const c = deps.setPluginEnabledFn.calls[0];
  assert.equal(c.enableWrites, true);
  assert.equal(c.assertWritable, BARE, 'claude (no writeSurface) → the bare paths.assertWritable');
  assert.equal(c.scope, undefined, 'claude descriptor has no snapshotScope → default claude scope');
});

test('claude --apply with HARNESS_MGR_ENABLE_WRITES=0 → env lock refusal, engine never called', async () => {
  const deps = makeDeps({ env: { HARNESS_MGR_ENABLE_WRITES: '0' } });
  const out = await disableCommand(claudeCtx({ type: 'plugin', positionals: ['x@y'], apply: true }), deps);
  assert.equal(out.code, 3);
  assert.ok(out.diagnostics.some((d) => d.code === 'writes-disabled-env'));
  assert.equal(deps.setPluginEnabledFn.calls.length, 0);
});
