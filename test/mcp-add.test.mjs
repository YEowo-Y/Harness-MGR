/**
 * U1 oracle for src/ops/mcp-add.mjs — the `claude mcp add-json` delegator (mcp toggle ENABLE).
 *
 * Mocked spawn seam ONLY — NEVER runs a real `claude mcp add-json` (it would mutate the user's
 * real MCP servers). Pins: dry-run spawns nothing; apply builds the exact argv + uses
 * MCP_ADD_JSON_SCHEMA; validation (name/scope/json) fails closed; not-spawnable refuses; and
 * the schema accepts a JSON positional via validateSpawnSpec but rejects control chars.
 *
 * Control-char inputs are built with String.fromCharCode(9) (a real TAB) — NEVER a raw control
 * byte typed into this source (the [[windows-json-unicode-escape-control-bytes]] gotcha).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mcpAddJson, MCP_ADD_JSON_SCHEMA } from '../src/ops/mcp-add.mjs';
import { validateSpawnSpec } from '../src/lib/safe-spawn.mjs';

const DIR = 'C:\\claude';
const JSON_CFG = '{"command":"npx","args":["-y","@upstash/context7-mcp"],"type":"stdio"}';
const TAB = String.fromCharCode(9);
/** A json string carrying a raw TAB control char inside a value (built explicitly). */
const CTRL_JSON = '{"a":"b' + TAB + 'c"}';

/** A recording spawn seam (resolves OK by default). */
function recSpawn(result = {}) {
  const calls = [];
  const fn = (spec) => { calls.push(spec); return result.throw ? Promise.reject(result.throw) : Promise.resolve({ stdout: '', stderr: '' }); };
  fn.calls = calls;
  return fn;
}
const okExe = () => ({ exe: 'C:\\claude\\bin\\claude.exe', diagnostics: [] });
const noExe = () => ({ exe: null, diagnostics: [] });

const base = { name: 'context7', json: JSON_CFG, targetClaudeDir: DIR };

test('dry-run: previews the would-run command, spawns NOTHING', async () => {
  const spawnFn = recSpawn();
  const r = await mcpAddJson({ ...base, seams: { resolveClaudeFn: okExe, spawnFn } });
  assert.equal(r.ok, true);
  assert.equal(r.dryRun, true);
  assert.equal(spawnFn.calls.length, 0);
  assert.deepEqual(r.command, ['mcp', 'add-json', 'context7', JSON_CFG, '--scope', 'user']);
  assert.ok(r.diagnostics.some((d) => d.code === 'mcp-add-dry-run'));
});

test('apply: delegates the exact argv via safeSpawn with MCP_ADD_JSON_SCHEMA', async () => {
  const spawnFn = recSpawn();
  const r = await mcpAddJson({ ...base, scope: 'user', enableWrites: true, seams: { resolveClaudeFn: okExe, spawnFn } });
  assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
  assert.equal(r.spawned, true);
  assert.equal(spawnFn.calls.length, 1);
  const spec = spawnFn.calls[0];
  assert.deepEqual(spec.args, ['mcp', 'add-json', 'context7', JSON_CFG, '--scope', 'user']);
  assert.equal(spec.schema, MCP_ADD_JSON_SCHEMA);
  assert.equal(spec.exe, 'C:\\claude\\bin\\claude.exe');
});

test('apply: a spawn failure is caught → ok:false, no throw', async () => {
  const spawnFn = recSpawn({ throw: new Error('claude exited 1') });
  const r = await mcpAddJson({ ...base, enableWrites: true, seams: { resolveClaudeFn: okExe, spawnFn } });
  assert.equal(r.ok, false);
  assert.equal(r.spawned, true);
  assert.ok(r.diagnostics.some((d) => d.code === 'mcp-add-spawn-failed'));
});

test('not spawnable: no native claude → refuse, never spawns', async () => {
  const spawnFn = recSpawn();
  const r = await mcpAddJson({ ...base, enableWrites: true, seams: { resolveClaudeFn: noExe, spawnFn } });
  assert.equal(r.refused, true);
  assert.equal(spawnFn.calls.length, 0);
  assert.ok(r.diagnostics.some((d) => d.code === 'mcp-add-claude-not-spawnable'));
});

test('validation fails closed: bad name / bad scope / bad json / control-char json / missing dir', async () => {
  const spawnFn = recSpawn();
  const seams = { resolveClaudeFn: okExe, spawnFn };
  assert.ok((await mcpAddJson({ ...base, name: 'bad name!', enableWrites: true, seams })).diagnostics.some((d) => d.code === 'mcp-add-bad-spec'));
  assert.ok((await mcpAddJson({ ...base, scope: 'global', enableWrites: true, seams })).diagnostics.some((d) => d.code === 'mcp-add-bad-scope'));
  assert.ok((await mcpAddJson({ ...base, json: 'not json', enableWrites: true, seams })).diagnostics.some((d) => d.code === 'mcp-add-bad-json'));
  assert.ok((await mcpAddJson({ ...base, json: '["array"]', enableWrites: true, seams })).diagnostics.some((d) => d.code === 'mcp-add-bad-json'));
  assert.ok((await mcpAddJson({ ...base, json: CTRL_JSON, enableWrites: true, seams })).diagnostics.some((d) => d.code === 'mcp-add-bad-json')); // raw control char
  assert.ok((await mcpAddJson({ ...base, targetClaudeDir: '', enableWrites: true, seams })).diagnostics.some((d) => d.code === 'mcp-add-bad-args'));
  assert.equal(spawnFn.calls.length, 0, 'no validation failure ever spawns');
});

test('never throws on garbage opts', async () => {
  await assert.doesNotReject(() => mcpAddJson(null));
  await assert.doesNotReject(() => mcpAddJson({}));
});

// ── the security-critical schema assertion ──────────────────────────────────────

test('MCP_ADD_JSON_SCHEMA accepts a JSON positional via validateSpawnSpec', () => {
  const cwd = 'C:\\tmp';
  const spec = { exe: 'C:\\claude\\bin\\claude.exe', args: ['mcp', 'add-json', 'context7', JSON_CFG, '--scope', 'user'], cwd, allowedCwds: [cwd], schema: MCP_ADD_JSON_SCHEMA };
  assert.doesNotThrow(() => validateSpawnSpec(spec)); // the JSON braces/quotes pass (printable ASCII)
});

test('MCP_ADD_JSON_SCHEMA rejects a control char in the JSON positional (belt holds)', () => {
  const cwd = 'C:\\tmp';
  const evil = { exe: 'C:\\claude\\bin\\claude.exe', args: ['mcp', 'add-json', 'x', CTRL_JSON, '--scope', 'user'], cwd, allowedCwds: [cwd], schema: MCP_ADD_JSON_SCHEMA };
  assert.throws(() => validateSpawnSpec(evil), /positional rejected by pattern/);
});

test('MCP_ADD_JSON_SCHEMA still denies an unlisted flag', () => {
  const cwd = 'C:\\tmp';
  const evil = { exe: 'C:\\claude\\bin\\claude.exe', args: ['mcp', 'add-json', 'x', '{}', '--evil'], cwd, allowedCwds: [cwd], schema: MCP_ADD_JSON_SCHEMA };
  assert.throws(() => validateSpawnSpec(evil), /flag not allowed/);
});
