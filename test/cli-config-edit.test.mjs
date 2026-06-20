/**
 * Tests for the disable/enable CLI handlers (src/cli/config-edit-command.mjs) — P6.
 *
 * Hermetic: an injected setEnabledFn records what the handler forwards, and a fake
 * loadPaths supplies makeAssertWritable so the --apply gate-resolution is exercised
 * without paths.mjs. Proves: a target without config-edit support refuses (Claude);
 * missing --type / name refuse; dry-run forwards desired+enableWrites:false and resolves
 * NO gate; enable sets desired:true; --apply resolves the codex-bound gate + forwards the
 * snapshot scope; the CLAUDE_MGR_ENABLE_WRITES=0 lock refuses before the engine.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { disableCommand, enableCommand } from '../src/cli/config-edit-command.mjs';
import { codexDescriptor } from '../src/targets/codex.mjs';

const codexCtx = (args) => ({ configDir: 'C:\\codex', mgrStateDir: 'C:\\codex\\.mgr-state', args, descriptor: codexDescriptor });

function makeDeps(over = {}) {
  const calls = [];
  const setEnabledFn = async (o) => { calls.push(o); return { ok: true, refused: false, dryRun: !o.enableWrites, kind: o.kind, name: o.name, desired: o.desired, diagnostics: [] }; };
  setEnabledFn.calls = calls;
  return { env: {}, setEnabledFn, loadPaths: async () => ({ assertWritable: (p) => p, makeAssertWritable: () => ((p) => p) }), ...over };
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

test('--apply resolves the codex-bound gate and forwards enableWrites:true + the snapshot scope', async () => {
  const GATE = (p) => p;
  const deps = makeDeps({ loadPaths: async () => ({ assertWritable: (p) => p, makeAssertWritable: () => GATE }) });
  await disableCommand(codexCtx({ type: 'plugin', positionals: ['x@y'], apply: true }), deps);
  const c = deps.setEnabledFn.calls[0];
  assert.equal(c.enableWrites, true);
  assert.equal(c.assertWritable, GATE);
  assert.deepEqual(c.scope, codexDescriptor.snapshotScope);
});

test('--apply with CLAUDE_MGR_ENABLE_WRITES=0 → refused (env lock), engine never called', async () => {
  const deps = makeDeps({ env: { CLAUDE_MGR_ENABLE_WRITES: '0' } });
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
