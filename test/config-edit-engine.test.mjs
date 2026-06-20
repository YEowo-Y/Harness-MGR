/**
 * Tests for the config-edit engine (src/ops/config-edit.mjs::setComponentEnabled) — P6.
 *
 * Hermetic: an injected readFn supplies the config fixture (no real fs) and an injected
 * applyFn stands in for the apply lifecycle. Proves: dry-run previews the flip + builds a
 * one-op config-edit plan; an already-in-state request is a safe no-op that NEVER calls
 * applyFn (no snapshot for a no-op); a real --apply forwards the plan+scope to applyFn and
 * surfaces the restart note; unsupported kinds (mcp/skill), bad names, not-found, an
 * unreadable config, and a gateless --apply are all clean refusals (never a throw).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { setComponentEnabled } from '../src/ops/config-edit.mjs';

const FIXTURE = [
  '[plugins."superpowers@openai-curated"]',
  'enabled = true',
  '',
  '[plugins."off@openai-curated"]',
  'enabled = false',
  '',
  '[mcp_servers.context7]',
  'command = "npx"',
  '',
  '[mcp_servers.n8n]',
  'url = "http://localhost:5678/mcp"',
  'bearer_token_env_var = "N8N_MCP_TOKEN"',
  '',
  '[mcp_servers.n8n.env]',
  'SECRET = "sk-do-not-touch"',
].join('\n');

const base = { targetClaudeDir: 'C:\\codex', mgrStateDir: 'C:\\codex\\.mgr-state', configFile: 'config.toml', readFn: () => FIXTURE };
const PASS = (p) => p;

test('dry-run disable: previews the flip, writes nothing, builds a one-op config-edit plan', async () => {
  const r = await setComponentEnabled({ ...base, kind: 'plugin', name: 'superpowers@openai-curated', desired: false });
  assert.equal(r.ok, true);
  assert.equal(r.dryRun, true);
  assert.equal(r.alreadyInState, false);
  assert.deepEqual(r.diff, { line: 2, before: 'enabled = true', after: 'enabled = false' });
  assert.equal(r.plan.ops.length, 1);
  assert.equal(r.plan.ops[0].kind, 'config-edit');
  assert.deepEqual(r.plan.ops[0].selector, { kind: 'plugin', name: 'superpowers@openai-curated' });
  assert.equal(r.plan.ops[0].desired, false);
  assert.equal(r.plan.ops[0].target, 'C:\\codex\\config.toml');
});

test('dry-run enable of an already-enabled plugin → alreadyInState (safe no-op), diff null', async () => {
  const r = await setComponentEnabled({ ...base, kind: 'plugin', name: 'superpowers@openai-curated', desired: true });
  assert.equal(r.ok, true);
  assert.equal(r.alreadyInState, true);
  assert.equal(r.diff, null);
});

test('apply an already-in-state request → ok and NO applyFn call (no snapshot for a no-op)', async () => {
  let called = 0;
  const r = await setComponentEnabled({
    ...base, kind: 'plugin', name: 'off@openai-curated', desired: false, enableWrites: true,
    assertWritable: PASS, seams: { applyFn: async () => { called += 1; return { ok: true }; } },
  });
  assert.equal(r.ok, true);
  assert.equal(r.alreadyInState, true);
  assert.equal(called, 0, 'an already-in-state apply must not snapshot or write');
});

test('apply a real change → forwards the config-edit plan + scope to applyFn, surfaces restart note', async () => {
  let seen = null;
  const r = await setComponentEnabled({
    ...base, kind: 'plugin', name: 'superpowers@openai-curated', desired: false, enableWrites: true,
    assertWritable: PASS, scope: { walkDirs: ['skills'] },
    seams: { applyFn: async (o) => { seen = o; return { ok: true, applied: true, snapshotId: 'S1', diagnostics: [] }; } },
  });
  assert.equal(r.ok, true);
  assert.equal(r.dryRun, false);
  assert.equal(seen.enableWrites, true);
  assert.equal(seen.plan.ops[0].kind, 'config-edit');
  assert.deepEqual(seen.scope, { walkDirs: ['skills'] });
  assert.equal(seen.assertWritable, PASS);
  assert.ok(r.diagnostics.some((d) => d.code === 'config-edit-restart-needed'));
});

test('unsupported kind (skill / bogus) → clean refusal', async () => {
  for (const kind of ['skill', 'widget']) {
    const r = await setComponentEnabled({ ...base, kind, name: 'x@y', desired: false });
    assert.equal(r.refused, true);
    assert.ok(r.diagnostics.some((d) => d.code === 'config-edit-unsupported-kind'));
  }
});

// ── mcp: disable INSERTS enabled=false; enable on a key-absent server is a default-enabled no-op ──

test('dry-run disable mcp (no enabled key) → INSERT preview + loader-unverified caveat', async () => {
  const r = await setComponentEnabled({ ...base, kind: 'mcp', name: 'context7', desired: false });
  assert.equal(r.ok, true);
  assert.equal(r.dryRun, true);
  assert.equal(r.alreadyInState, false);
  assert.equal(r.diff.before, '');           // nothing was there — it's an insert
  assert.equal(r.diff.after, 'enabled = false');
  assert.equal(r.plan.ops[0].kind, 'config-edit');
  assert.deepEqual(r.plan.ops[0].selector, { kind: 'mcp', name: 'context7' });
  assert.ok(r.diagnostics.some((d) => d.code === 'config-edit-mcp-loader-unverified'), 'honest caveat present');
});

test('dry-run enable mcp on a key-absent (default-enabled) server → alreadyInState no-op, no caveat', async () => {
  const r = await setComponentEnabled({ ...base, kind: 'mcp', name: 'context7', desired: true });
  assert.equal(r.ok, true);
  assert.equal(r.alreadyInState, true);
  assert.equal(r.diff, null);
  assert.ok(!r.diagnostics.some((d) => d.code === 'config-edit-mcp-loader-unverified'));
  assert.ok(r.diagnostics.some((d) => /defaults to enabled/.test(d.message)));
});

test('apply disable mcp → forwards a config-edit op for the mcp selector', async () => {
  let seen = null;
  const r = await setComponentEnabled({
    ...base, kind: 'mcp', name: 'n8n', desired: false, enableWrites: true,
    assertWritable: PASS, scope: { walkDirs: ['skills'] },
    seams: { applyFn: async (o) => { seen = o; return { ok: true, applied: true, snapshotId: 'S1', diagnostics: [] }; } },
  });
  assert.equal(r.ok, true);
  assert.deepEqual(seen.plan.ops[0].selector, { kind: 'mcp', name: 'n8n' });
  assert.equal(seen.plan.ops[0].desired, false);
  assert.ok(r.diagnostics.some((d) => d.code === 'config-edit-mcp-loader-unverified'));
});

test('bad mcp name (has @ / separators) → refused', async () => {
  for (const name of ['n8n@x', 'a/b', '../etc']) {
    const r = await setComponentEnabled({ ...base, kind: 'mcp', name, desired: false });
    assert.equal(r.refused, true);
    assert.ok(r.diagnostics.some((d) => d.code === 'config-edit-bad-name'));
  }
});

test('bad plugin name (whitespace) → refused', async () => {
  const r = await setComponentEnabled({ ...base, kind: 'plugin', name: 'has space', desired: false });
  assert.equal(r.refused, true);
  assert.ok(r.diagnostics.some((d) => d.code === 'config-edit-bad-name'));
});

test('plugin absent from the config → target-not-found refusal (no edit)', async () => {
  const r = await setComponentEnabled({ ...base, kind: 'plugin', name: 'ghost@x', desired: false });
  assert.equal(r.refused, true);
  assert.ok(r.diagnostics.some((d) => d.code === 'config-edit-target-not-found'));
});

test('unreadable config file → refused, never throws', async () => {
  const r = await setComponentEnabled({ ...base, kind: 'plugin', name: 'a@b', desired: false, readFn: () => { throw new Error('nope'); } });
  assert.equal(r.refused, true);
  assert.ok(r.diagnostics.some((d) => d.code === 'config-edit-config-not-found'));
});

test('--apply without an injected gate → refused before any apply', async () => {
  const r = await setComponentEnabled({ ...base, kind: 'plugin', name: 'superpowers@openai-curated', desired: false, enableWrites: true });
  assert.equal(r.refused, true);
  assert.ok(r.diagnostics.some((d) => d.code === 'config-edit-bad-args'));
});
