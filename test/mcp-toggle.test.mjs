/**
 * U3 oracle for src/ops/mcp-toggle.mjs — the delegate+stash MCP toggle engine.
 *
 * Injected mcpRemoveFn / mcpAddJsonFn / readRawEntryFn seams (NEVER a real claude spawn) + the
 * REAL stash module against a temp .mgr-state. Pins the §6 truth table: disable stashes then
 * delegates remove; env / non-ASCII configs refuse (never strand a server); enable restores from
 * the stash then clears it; already-enabled/disabled no-ops; not-found; dry-run touches nothing.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { setMcpEnabledClaude } from '../src/ops/mcp-toggle.mjs';
import { writeStash, readStash, stashExists } from '../src/ops/mcp-stash.mjs';
import { makeAssertWritable, MGR_STATE_DIRNAME } from '../src/paths.mjs';

const CFG = { command: 'npx', args: ['-y', '@upstash/context7-mcp'], type: 'stdio', timeout: 30000 };
const CFG_ENV = { command: 'node', args: ['s.js'], env: { API_KEY: 'sk-x' }, type: 'stdio' };
const CFG_HEADERS = { type: 'http', url: 'https://x/mcp', headers: { Authorization: 'Bearer sk-ant-api03-AbCdEf0123456789AbCdEf0123456789' } };

// ASYNC + `await fn` so the finally cleanup waits for the async test body — a plain
// `try { return fn() } finally { rmSync }` would delete the temp dir MID-RUN (the cleanup
// race the config-edit-codex-roundtrip helper documents).
async function withTree(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'cmgr-mcptoggle-'));
  const stateDir = join(dir, MGR_STATE_DIRNAME);
  mkdirSync(stateDir, { recursive: true });
  const gate = makeAssertWritable({ configDir: dir, mgrStateDir: stateDir });
  try { return await fn({ dir, stateDir, appFile: join(dir, '.claude.json'), gate }); } finally { rmSync(dir, { recursive: true, force: true }); }
}
function recRemove() { const calls = []; const fn = (o) => { calls.push(o); return Promise.resolve({ ok: true, command: ['mcp', 'remove', o.name, '--scope', 'user'], diagnostics: [] }); }; fn.calls = calls; return fn; }
function recAdd() { const calls = []; const fn = (o) => { calls.push(o); return Promise.resolve({ ok: true, command: ['mcp', 'add-json', o.name, o.json, '--scope', o.scope], diagnostics: [] }); }; fn.calls = calls; return fn; }
const present = () => CFG;
const absent = () => null;

test('disable dry-run: previews, does NOT stash or call remove', async () => {
  await withTree(async ({ stateDir, appFile, gate }) => {
    const mcpRemoveFn = recRemove();
    const r = await setMcpEnabledClaude({ name: 'context7', desired: false, targetClaudeDir: 'x', mgrStateDir: stateDir, appFile, assertWritable: gate, seams: { readRawEntryFn: present, mcpRemoveFn } });
    assert.equal(r.ok, true);
    assert.equal(r.dryRun, true);
    assert.equal(r.action, 'disable');
    assert.equal(mcpRemoveFn.calls.length, 0);
    assert.equal(stashExists(stateDir, 'context7'), false);
  });
});

test('disable apply: stashes the config THEN delegates remove', async () => {
  await withTree(async ({ stateDir, appFile, gate }) => {
    const mcpRemoveFn = recRemove();
    const r = await setMcpEnabledClaude({ name: 'context7', desired: false, targetClaudeDir: 'x', mgrStateDir: stateDir, appFile, assertWritable: gate, enableWrites: true, seams: { readRawEntryFn: present, mcpRemoveFn } });
    assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
    assert.equal(r.stashWritten, true);
    assert.equal(mcpRemoveFn.calls.length, 1);
    assert.equal(mcpRemoveFn.calls[0].scope, 'user');
    assert.equal(mcpRemoveFn.calls[0].enableWrites, true);
    // the stash holds the exact config (so enable can restore it)
    assert.deepEqual(readStash(stateDir, 'context7').config, CFG);
  });
});

test('disable refuses an env-bearing server (never stash a secret), no remove', async () => {
  await withTree(async ({ stateDir, appFile, gate }) => {
    const mcpRemoveFn = recRemove();
    const r = await setMcpEnabledClaude({ name: 'svc', desired: false, targetClaudeDir: 'x', mgrStateDir: stateDir, appFile, assertWritable: gate, enableWrites: true, seams: { readRawEntryFn: () => CFG_ENV, mcpRemoveFn } });
    assert.equal(r.refused, true);
    assert.ok(r.diagnostics.some((d) => d.code === 'mcp-toggle-has-secret'));
    assert.equal(mcpRemoveFn.calls.length, 0);
    assert.equal(stashExists(stateDir, 'svc'), false);
  });
});

test('disable refuses a HEADERS-bearing http server (DoD HIGH: never stash a Bearer token), no remove', async () => {
  await withTree(async ({ stateDir, appFile, gate }) => {
    const mcpRemoveFn = recRemove();
    const r = await setMcpEnabledClaude({ name: 'remote', desired: false, targetClaudeDir: 'x', mgrStateDir: stateDir, appFile, assertWritable: gate, enableWrites: true, seams: { readRawEntryFn: () => CFG_HEADERS, mcpRemoveFn } });
    assert.equal(r.refused, true);
    assert.ok(r.diagnostics.some((d) => d.code === 'mcp-toggle-has-secret'));
    assert.equal(mcpRemoveFn.calls.length, 0, 'never delegate the removal');
    assert.equal(stashExists(stateDir, 'remote'), false, 'the Bearer token never reaches .mgr-state');
  });
});

test('disable refuses a non-ASCII config (can\'t round-trip via add-json)', async () => {
  await withTree(async ({ stateDir, appFile, gate }) => {
    const mcpRemoveFn = recRemove();
    const r = await setMcpEnabledClaude({ name: 'uni', desired: false, targetClaudeDir: 'x', mgrStateDir: stateDir, appFile, assertWritable: gate, enableWrites: true, seams: { readRawEntryFn: () => ({ command: 'café' }), mcpRemoveFn } });
    assert.equal(r.refused, true);
    assert.ok(r.diagnostics.some((d) => d.code === 'mcp-toggle-unsupported-config'));
    assert.equal(mcpRemoveFn.calls.length, 0);
  });
});

test('disable an absent server: stash present → already-disabled no-op; no stash → not-found', async () => {
  await withTree(async ({ stateDir, appFile, gate }) => {
    // no stash → not-found
    const r1 = await setMcpEnabledClaude({ name: 'context7', desired: false, targetClaudeDir: 'x', mgrStateDir: stateDir, appFile, assertWritable: gate, enableWrites: true, seams: { readRawEntryFn: absent } });
    assert.ok(r1.diagnostics.some((d) => d.code === 'mcp-toggle-not-found'));
    // stash present → already disabled
    writeStash({ mgrStateDir: stateDir, name: 'context7', entry: CFG, assertWritable: gate });
    const r2 = await setMcpEnabledClaude({ name: 'context7', desired: false, targetClaudeDir: 'x', mgrStateDir: stateDir, appFile, assertWritable: gate, enableWrites: true, seams: { readRawEntryFn: absent } });
    assert.equal(r2.ok, true);
    assert.equal(r2.alreadyInState, true);
  });
});

test('disable apply aborts the remove if the stash write fails (no undo → no destroy)', async () => {
  await withTree(async ({ stateDir, appFile }) => {
    const mcpRemoveFn = recRemove();
    // a denying gate makes writeStash fail-closed
    const denyGate = () => { throw new Error('denied'); };
    const r = await setMcpEnabledClaude({ name: 'context7', desired: false, targetClaudeDir: 'x', mgrStateDir: stateDir, appFile, assertWritable: denyGate, enableWrites: true, seams: { readRawEntryFn: present, mcpRemoveFn } });
    assert.equal(r.ok, false);
    assert.equal(mcpRemoveFn.calls.length, 0, 'never delegate the removal without a stash undo point');
  });
});

test('enable apply: restores from the stash via add-json THEN clears the stash', async () => {
  await withTree(async ({ stateDir, appFile, gate }) => {
    writeStash({ mgrStateDir: stateDir, name: 'context7', entry: CFG, scope: 'user', assertWritable: gate });
    const mcpAddJsonFn = recAdd();
    const r = await setMcpEnabledClaude({ name: 'context7', desired: true, targetClaudeDir: 'x', mgrStateDir: stateDir, appFile, assertWritable: gate, enableWrites: true, seams: { readRawEntryFn: absent, mcpAddJsonFn } });
    assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
    assert.equal(r.action, 'enable');
    assert.equal(mcpAddJsonFn.calls.length, 1);
    assert.equal(mcpAddJsonFn.calls[0].json, JSON.stringify(CFG)); // the stashed config round-trips
    assert.equal(r.stashDeleted, true);
    assert.equal(stashExists(stateDir, 'context7'), false); // stash cleared after restore
  });
});

test('enable dry-run: previews from the stash, does NOT add or clear', async () => {
  await withTree(async ({ stateDir, appFile, gate }) => {
    writeStash({ mgrStateDir: stateDir, name: 'context7', entry: CFG, assertWritable: gate });
    const mcpAddJsonFn = recAdd();
    const r = await setMcpEnabledClaude({ name: 'context7', desired: true, targetClaudeDir: 'x', mgrStateDir: stateDir, appFile, assertWritable: gate, seams: { readRawEntryFn: absent, mcpAddJsonFn } });
    assert.equal(r.dryRun, true);
    assert.equal(mcpAddJsonFn.calls.length, 0);
    assert.equal(stashExists(stateDir, 'context7'), true);
  });
});

test('enable when already present: no-op (clears a stale stash); no add', async () => {
  await withTree(async ({ stateDir, appFile, gate }) => {
    writeStash({ mgrStateDir: stateDir, name: 'context7', entry: CFG, assertWritable: gate }); // stale
    const mcpAddJsonFn = recAdd();
    const r = await setMcpEnabledClaude({ name: 'context7', desired: true, targetClaudeDir: 'x', mgrStateDir: stateDir, appFile, assertWritable: gate, enableWrites: true, seams: { readRawEntryFn: present, mcpAddJsonFn } });
    assert.equal(r.ok, true);
    assert.equal(r.alreadyInState, true);
    assert.equal(mcpAddJsonFn.calls.length, 0);
    assert.equal(stashExists(stateDir, 'context7'), false, 'stale stash cleared');
  });
});

test('enable with no stash and not present → not-found', async () => {
  await withTree(async ({ stateDir, appFile, gate }) => {
    const r = await setMcpEnabledClaude({ name: 'context7', desired: true, targetClaudeDir: 'x', mgrStateDir: stateDir, appFile, assertWritable: gate, enableWrites: true, seams: { readRawEntryFn: absent } });
    assert.ok(r.diagnostics.some((d) => d.code === 'mcp-toggle-not-found'));
  });
});

test('validation + never-throws: bad desired / bad name / garbage', async () => {
  await withTree(async ({ stateDir, appFile, gate }) => {
    assert.equal((await setMcpEnabledClaude({ name: 'x', desired: 'no', mgrStateDir: stateDir, appFile, targetClaudeDir: 't', assertWritable: gate })).refused, true);
    assert.equal((await setMcpEnabledClaude({ name: 'bad name!', desired: false, mgrStateDir: stateDir, appFile, targetClaudeDir: 't', assertWritable: gate })).refused, true);
  });
  await assert.doesNotReject(() => setMcpEnabledClaude(null));
  await assert.doesNotReject(() => setMcpEnabledClaude({}));
});
