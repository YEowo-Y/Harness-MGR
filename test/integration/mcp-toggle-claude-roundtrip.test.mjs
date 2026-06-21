/**
 * Claude MCP toggle — integration/mcp-toggle-claude-roundtrip.test.mjs
 *
 * The end-to-end DoD oracle for the delegate+stash MCP toggle, against a REAL temp .mgr-state +
 * the REAL stash module + the REAL Claude gate, with MOCKED delegated spawns (mcpRemoveFn /
 * mcpAddJsonFn) that mutate an in-memory "live ~/.claude.json" state — so the full
 * disable→enable cycle is exercised WITHOUT ever running a real `claude mcp remove`/`add-json`
 * (which would mutate the user's real servers). Proves: disable stashes the config + delegates
 * remove (live state → absent); enable reads the stash + delegates add-json with the EXACT
 * stashed config (live state → present again) + clears the stash; the config round-trips
 * byte-faithfully; env-bearing servers refuse with no stash + no spawn.
 *
 * NEVER touches the real ~/.claude / ~/.claude.json. withTree is async + awaits fn (no cleanup race).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { setMcpEnabledClaude } from '../../src/ops/mcp-toggle.mjs';
import { stashExists, readStash } from '../../src/ops/mcp-stash.mjs';
import { makeAssertWritable, MGR_STATE_DIRNAME } from '../../src/paths.mjs';

const CFG = { command: 'npx', args: ['-y', '@upstash/context7-mcp'], type: 'stdio', timeout: 30000 };

async function withTree(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'cmgr-mcptoggle-rt-'));
  const stateDir = join(dir, MGR_STATE_DIRNAME);
  mkdirSync(stateDir, { recursive: true });
  const gate = makeAssertWritable({ configDir: dir, mgrStateDir: stateDir });
  try { return await fn({ dir, stateDir, appFile: join(dir, '.claude.json'), gate }); } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** A mutable in-memory model of the live ~/.claude.json server, mutated by the mock spawns. */
function liveModel(initial) {
  const state = { entry: initial };
  return {
    readRawEntryFn: () => state.entry,
    // `claude mcp remove` removes the server from ~/.claude.json:
    mcpRemoveFn: (o) => { state.entry = null; return Promise.resolve({ ok: true, command: ['mcp', 'remove', o.name, '--scope', 'user'], diagnostics: [] }); },
    // `claude mcp add-json` re-adds it; capture what config JSON it was handed:
    mcpAddJsonFn: (o) => { state.addedJson = o.json; state.entry = JSON.parse(o.json); return Promise.resolve({ ok: true, command: ['mcp', 'add-json', o.name, o.json], diagnostics: [] }); },
    state,
  };
}

test('disable→enable round-trip: stash captures config, add-json restores it byte-faithfully, stash cleared', async () => {
  await withTree(async ({ stateDir, appFile, gate }) => {
    const m = liveModel(CFG);
    const seams = { readRawEntryFn: m.readRawEntryFn, mcpRemoveFn: m.mcpRemoveFn, mcpAddJsonFn: m.mcpAddJsonFn };
    const opts = { name: 'context7', targetClaudeDir: 'x', mgrStateDir: stateDir, appFile, assertWritable: gate, enableWrites: true, seams };

    // DISABLE: stashes the live config, delegates remove → live state becomes absent.
    const d = await setMcpEnabledClaude({ ...opts, desired: false });
    assert.equal(d.ok, true, JSON.stringify(d.diagnostics));
    assert.equal(d.stashWritten, true);
    assert.equal(m.state.entry, null, 'the (mock) live server was removed');
    assert.deepEqual(readStash(stateDir, 'context7').config, CFG, 'the exact config is stashed');

    // ENABLE: reads the stash, delegates add-json with the EXACT config, clears the stash.
    const e = await setMcpEnabledClaude({ ...opts, desired: true });
    assert.equal(e.ok, true, JSON.stringify(e.diagnostics));
    assert.equal(e.stashDeleted, true);
    assert.equal(m.state.addedJson, JSON.stringify(CFG), 'add-json received the stashed config verbatim');
    assert.deepEqual(m.state.entry, CFG, 'the live server is restored byte-faithfully');
    assert.equal(stashExists(stateDir, 'context7'), false, 'the stash is cleared after a successful restore');
  });
});

test('credential-bearing server: disable refuses (no stash, no remove spawn) — env AND headers', async () => {
  for (const evil of [
    { command: 'node', args: ['s.js'], env: { API_KEY: 'sk-secret' }, type: 'stdio' },
    { type: 'http', url: 'https://x/mcp', headers: { Authorization: 'Bearer sk-ant-api03-AbCdEf0123456789AbCdEf0123456789' } }, // DoD HIGH
  ]) {
    await withTree(async ({ stateDir, appFile, gate }) => {
      const m = liveModel(evil);
      let removeCalls = 0;
      const seams = { readRawEntryFn: m.readRawEntryFn, mcpRemoveFn: (o) => { removeCalls += 1; return m.mcpRemoveFn(o); }, mcpAddJsonFn: m.mcpAddJsonFn };
      const r = await setMcpEnabledClaude({ name: 'svc', desired: false, targetClaudeDir: 'x', mgrStateDir: stateDir, appFile, assertWritable: gate, enableWrites: true, seams });
      assert.equal(r.refused, true);
      assert.ok(r.diagnostics.some((dg) => dg.code === 'mcp-toggle-has-secret'));
      assert.equal(removeCalls, 0, 'never delegated the removal');
      assert.equal(stashExists(stateDir, 'svc'), false, 'never stashed a secret');
    });
  }
});

test('dry-run disable: stashes nothing + delegates nothing', async () => {
  await withTree(async ({ stateDir, appFile, gate }) => {
    const m = liveModel(CFG);
    let removeCalls = 0;
    const seams = { readRawEntryFn: m.readRawEntryFn, mcpRemoveFn: (o) => { removeCalls += 1; return m.mcpRemoveFn(o); } };
    const r = await setMcpEnabledClaude({ name: 'context7', desired: false, targetClaudeDir: 'x', mgrStateDir: stateDir, appFile, assertWritable: gate, /* no enableWrites */ seams });
    assert.equal(r.dryRun, true);
    assert.equal(removeCalls, 0);
    assert.equal(stashExists(stateDir, 'context7'), false);
    assert.deepEqual(m.state.entry, CFG, 'the live server is untouched by a dry-run');
  });
});
