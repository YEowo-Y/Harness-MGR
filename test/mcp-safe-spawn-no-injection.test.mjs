/**
 * P4b.U6 — DoD HEADLINE oracle (docs/phase-4b-mcp-design.md §4).
 *
 * Proves the security-critical property: a hostile MCP server <name> can NEVER
 * survive to become a delegated argv token. Two complementary layers:
 *   (a) the safeSpawn gate — the REAL validateSpawnSpec against the REAL frozen
 *       MCP_REMOVE_SCHEMA rejects every shell/path metacharacter (positional-
 *       rejected) and every NON-allowed flag-shaped token (flag-not-allowed); and
 *   (b) the engine's NAME_RE — a flag-shaped NAME (`-rf`, `--scope`) is refused at
 *       `mcp-bad-spec` BEFORE a command is even built (the gate would otherwise
 *       wave `--scope` through as its one allowed FLAG, so layer (a) alone is not
 *       sufficient for a flag-shaped name — layer (b) is what closes that gap).
 * Plus an over-budget argv overflow check and a clean-argv acceptance check.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSpawnSpec } from '../src/lib/safe-spawn.mjs';
import { mcpRemove, MCP_REMOVE_SCHEMA } from '../src/ops/mcp-write.mjs';

/** Build a spec around a delegated argv (mcp remove <token>). */
function spec(args) {
  return { exe: '/abs/claude', args, cwd: '/tmp', allowedCwds: ['/tmp'], schema: MCP_REMOVE_SCHEMA };
}

// Every one of these fails CLOSED at the safeSpawn gate as a <name> positional:
// shell/path metacharacters → spawn-positional-rejected; flag-shaped tokens
// (-rf, /grant) → spawn-flag-not-allowed. (`--scope` is deliberately NOT here: it
// is the ONE allowed flag, so it passes the *gate* — a flag-shaped NAME is instead
// stopped one layer earlier by the engine's NAME_RE; see the end-to-end test.)
const HOSTILE = [
  'foo;rm', 'foo$(id)', 'foo|x', '`id`', 'foo&calc', 'foo>o', '../x',
  'a/b', 'a\\b', 'foo bar', 'foo\nbar', 'foo bar', '-rf', '/grant',
];

test('every hostile <name> token is rejected by the safeSpawn gate (MCP_REMOVE_SCHEMA)', () => {
  for (const t of HOSTILE) {
    assert.throws(
      () => validateSpawnSpec(spec(['mcp', 'remove', t])),
      (err) => err && err.name === 'SafeSpawnError',
      `hostile token ${JSON.stringify(t)} must be rejected`,
    );
  }
});

test('a 6th argv overflows maxArgs:5 → rejected (spawn-argv-too-long)', () => {
  assert.throws(
    () => validateSpawnSpec(spec(['mcp', 'remove', 'foo', '--scope', 'project', 'extra'])),
    /maxArgs/,
    'a 6th positional must overflow the schema',
  );
});

test('the CLEAN argv is ACCEPTED (no throw)', () => {
  assert.doesNotThrow(
    () => validateSpawnSpec(spec(['mcp', 'remove', 'ok-name', '--scope', 'project'])),
    'a clean name + scope must pass the gate',
  );
  // And without a scope (3-arg form).
  assert.doesNotThrow(
    () => validateSpawnSpec(spec(['mcp', 'remove', 'ok.name_1'])),
    'a clean name with no scope must pass',
  );
});

test('schema invariants: frozen, only --scope allowed, maxArgs 5', () => {
  assert.equal(Object.isFrozen(MCP_REMOVE_SCHEMA), true);
  assert.deepEqual(MCP_REMOVE_SCHEMA.allowedFlags, ['--scope']);
  assert.equal(MCP_REMOVE_SCHEMA.maxArgs, 5);
});

test('end-to-end: a metachar name refuses mcp-bad-spec, spawn NEVER called', async () => {
  let spawnCalled = false;
  const r = await mcpRemove({
    name: 'foo;rm', targetClaudeDir: '/abs/.claude', mgrStateDir: '/abs/.mgr-state',
    assertWritable: (p) => p, enableWrites: true,
    seams: {
      discoverMcpFn: () => ({ mcpServers: [], diagnostics: [] }),
      resolveClaudeFn: () => ({ exe: '/abs/claude', kind: 'native', diagnostics: [] }),
      createSnapshotFn: async () => ({ ok: true, snapshotId: 's', diagnostics: [] }),
      spawnFn: async () => { spawnCalled = true; },
    },
  });
  assert.equal(r.refused, true);
  assert.ok(r.diagnostics.some((d) => d.code === 'mcp-bad-spec'));
  assert.equal(spawnCalled, false, 'a metachar name must never reach the spawn');
});

test('end-to-end: a non-enum --scope VALUE refuses mcp-bad-scope at the engine, never spawns', async () => {
  // The scope value slot can ONLY be a VALID_SCOPES member — a flag-shaped or
  // metachar scope can never reach argv. Pin that with a spawn spy.
  for (const scope of ['--header', '-e', 'foo;rm', 'project --header', 'PROJECT']) {
    let spawnCalled = false;
    const r = await mcpRemove({
      name: 'ok-name', scope, targetClaudeDir: '/abs/.claude', mgrStateDir: '/abs/.mgr-state',
      assertWritable: (p) => p, enableWrites: true,
      seams: {
        discoverMcpFn: () => ({ mcpServers: [], diagnostics: [] }),
        resolveClaudeFn: () => ({ exe: '/abs/claude', kind: 'native', diagnostics: [] }),
        createSnapshotFn: async () => ({ ok: true, snapshotId: 's', diagnostics: [] }),
        spawnFn: async () => { spawnCalled = true; },
      },
    });
    assert.equal(r.refused, true, `scope=${scope} must refuse`);
    assert.ok(r.diagnostics.some((d) => d.code === 'mcp-bad-scope'), `scope=${scope} expected mcp-bad-scope`);
    assert.equal(spawnCalled, false, `scope=${scope} must never reach the spawn`);
  }
});

test('end-to-end: a flag-shaped NAME (--scope / -rf) refuses mcp-bad-spec at the engine, never spawns', async () => {
  for (const name of ['--scope', '-rf', '-e', '--header', '--transport', '-anything']) {
    let spawnCalled = false;
    const r = await mcpRemove({
      name, targetClaudeDir: '/abs/.claude', mgrStateDir: '/abs/.mgr-state',
      assertWritable: (p) => p, enableWrites: true,
      seams: {
        discoverMcpFn: () => ({ mcpServers: [], diagnostics: [] }),
        resolveClaudeFn: () => ({ exe: '/abs/claude', kind: 'native', diagnostics: [] }),
        createSnapshotFn: async () => ({ ok: true, snapshotId: 's', diagnostics: [] }),
        spawnFn: async () => { spawnCalled = true; },
      },
    });
    assert.equal(r.refused, true, `name=${name} must refuse`);
    assert.ok(r.diagnostics.some((d) => d.code === 'mcp-bad-spec'), `name=${name} expected mcp-bad-spec`);
    assert.equal(spawnCalled, false, `name=${name} must never reach the spawn`);
  }
});
