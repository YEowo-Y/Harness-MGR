/**
 * Tests for the skill visibility CLI handler (src/cli/skill-visibility-command.mjs).
 *
 * Hermetic: an injected setSkillVisibilityFn records what the handler forwards, and a fake
 * loadPaths supplies assertWritable so the --apply gate-resolution is exercised without paths.mjs.
 * Proves: a non-Claude target refuses (code 3); missing name/state refuse; dry-run forwards
 * name+state+enableWrites:false and resolves NO gate; --apply resolves the Claude gate + forwards
 * the snapshot scope; the CLAUDE_MGR_ENABLE_WRITES=0 lock refuses before the engine; an engine
 * refusal maps to exit 2.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { skillVisibilityCommand } from '../src/cli/skill-visibility-command.mjs';
import { claudeDescriptor } from '../src/targets/claude.mjs';
import { codexDescriptor } from '../src/targets/codex.mjs';

const claudeCtx = (args) => ({ configDir: 'C:\\claude', mgrStateDir: 'C:\\claude\\.mgr-state', args, descriptor: claudeDescriptor });
const codexCtx = (args) => ({ configDir: 'C:\\codex', mgrStateDir: 'C:\\codex\\.mgr-state', args, descriptor: codexDescriptor });

function makeDeps(over = {}) {
  const calls = [];
  const setSkillVisibilityFn = async (o) => { calls.push(o); return { ok: true, refused: false, dryRun: !o.enableWrites, kind: 'skill', name: o.name, state: o.state, diagnostics: [] }; };
  setSkillVisibilityFn.calls = calls;
  return { env: {}, setSkillVisibilityFn, loadPaths: async () => ({ assertWritable: (p) => p, makeAssertWritable: () => ((p) => p) }), ...over };
}

test('non-Claude target → refused (code 3), engine never called', async () => {
  const deps = makeDeps();
  const out = await skillVisibilityCommand(codexCtx({ positionals: ['deep-research', 'off'] }), deps);
  assert.equal(out.code, 3);
  assert.ok(out.diagnostics.some((d) => d.code === 'skill-visibility-unsupported-target'));
  assert.equal(deps.setSkillVisibilityFn.calls.length, 0);
});

test('null descriptor → refused (code 3)', async () => {
  const out = await skillVisibilityCommand({ configDir: 'C:\\c', mgrStateDir: 'C:\\c\\.mgr', args: { positionals: ['x', 'off'] }, descriptor: null }, makeDeps());
  assert.equal(out.code, 3);
  assert.ok(out.diagnostics.some((d) => d.code === 'skill-visibility-unsupported-target'));
});

test('Claude + no name → refused (code 3)', async () => {
  const out = await skillVisibilityCommand(claudeCtx({ positionals: [] }), makeDeps());
  assert.equal(out.code, 3);
  assert.ok(out.diagnostics.some((d) => d.code === 'skill-visibility-no-name'));
});

test('Claude + name but no state → refused (code 3)', async () => {
  const out = await skillVisibilityCommand(claudeCtx({ positionals: ['deep-research'] }), makeDeps());
  assert.equal(out.code, 3);
  assert.ok(out.diagnostics.some((d) => d.code === 'skill-visibility-no-state'));
});

test('dry-run: forwards name+state+enableWrites:false; resolves NO gate', async () => {
  const deps = makeDeps();
  const out = await skillVisibilityCommand(claudeCtx({ positionals: ['deep-research', 'off'] }), deps);
  assert.equal(out.code, 0);
  assert.equal(deps.setSkillVisibilityFn.calls.length, 1);
  const c = deps.setSkillVisibilityFn.calls[0];
  assert.equal(c.name, 'deep-research');
  assert.equal(c.state, 'off');
  assert.equal(c.enableWrites, false);
  assert.equal(c.assertWritable, undefined, 'dry-run must not resolve a write gate');
  assert.equal(c.targetClaudeDir, 'C:\\claude');
});

test('--apply: resolves the Claude gate, forwards enableWrites:true', async () => {
  const deps = makeDeps();
  await skillVisibilityCommand(claudeCtx({ positionals: ['deep-research', 'name-only'], apply: true }), deps);
  assert.equal(deps.setSkillVisibilityFn.calls.length, 1);
  const c = deps.setSkillVisibilityFn.calls[0];
  assert.equal(c.enableWrites, true);
  assert.equal(typeof c.assertWritable, 'function', '--apply must resolve a write gate');
  assert.equal(c.state, 'name-only');
});

test('CLAUDE_MGR_ENABLE_WRITES=0 lock → refused before the engine', async () => {
  const deps = makeDeps({ env: { CLAUDE_MGR_ENABLE_WRITES: '0' } });
  const out = await skillVisibilityCommand(claudeCtx({ positionals: ['deep-research', 'off'], apply: true }), deps);
  assert.equal(out.code, 3);
  assert.ok(out.diagnostics.some((d) => d.code === 'writes-disabled-env'));
  assert.equal(deps.setSkillVisibilityFn.calls.length, 0);
});

test('engine refusal maps to exit 2', async () => {
  const deps = makeDeps({ setSkillVisibilityFn: async () => ({ ok: false, refused: true, diagnostics: [{ severity: 'error', code: 'skill-visibility-bad-state', message: 'x' }] }) });
  const out = await skillVisibilityCommand(claudeCtx({ positionals: ['deep-research', 'nope'] }), deps);
  assert.equal(out.code, 2);
});

test('a write-gate load failure degrades to a graceful warn (code 1)', async () => {
  const deps = makeDeps({ loadPaths: async () => { throw new Error('boom'); } });
  const out = await skillVisibilityCommand(claudeCtx({ positionals: ['deep-research', 'off'], apply: true }), deps);
  assert.equal(out.code, 1);
  assert.ok(out.diagnostics.some((d) => d.code === 'skill-visibility-write-unavailable'));
});

test('an engine throw degrades to a clean error result (code 1)', async () => {
  const deps = makeDeps({ setSkillVisibilityFn: async () => { throw new Error('kaboom'); } });
  const out = await skillVisibilityCommand(claudeCtx({ positionals: ['deep-research', 'off'] }), deps);
  assert.equal(out.code, 1);
  assert.ok(out.diagnostics.some((d) => d.code === 'skill-visibility-unexpected-error'));
});
