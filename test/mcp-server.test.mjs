/**
 * mcp-server.test.mjs (P5.U6) — the MCP server's IN-PROCESS oracles.
 *
 * Drives the REAL buildServer() through the SDK's own Client over an
 * InMemoryTransport linked pair (no child process — c8 sees the coverage):
 *
 *   - initialize handshake succeeds (server identity pinned),
 *   - tools/list returns EXACTLY the 4 read-only tools (names + descriptions
 *     pinned literally — a drift in either is a deliberate contract change),
 *   - tools/call harness_mgr_health → content[0].text parses as the
 *     {version:1, command:'health'} envelope with all three sections,
 *   - tools/call harness_mgr_doctor → PASSIVE (probeLevel 'passive', checks
 *     non-empty) — the server must never pass --active-probes,
 *   - unknown tool name → the SDK error path (client rejects, -32601),
 *   - deterministic tool ordering across calls,
 *   - the exit-code → isError mapping (0/1 → valid report, ≥2 → isError) via
 *     a runFn seam, plus seam-throw degrade (never-throws).
 *
 * Hermetic: every real-run() call goes through buildServer({configDir: sandbox})
 * so the live ~/.claude is never read.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer, TOOLS } from '../src/mcp/server.mjs';

/** The pinned tool contract — names AND descriptions (drift = contract change). */
const EXPECTED_TOOLS = [
  ['harness_mgr_inventory', 'Read-only inventory of the Claude Code harness: counts and lists skills, agents, commands, plugins, and MCP servers.'],
  ['harness_mgr_health', 'Read-only severity-layered health report: per-component loadability, offline best-practice advice, and hook explanations.'],
  ['harness_mgr_conflicts', 'Read-only load-order conflict report: duplicate component names and which copy Claude Code likely loads.'],
  ['harness_mgr_doctor', 'Read-only doctor report running the passive health checks only (active probes stay behind an explicit human opt-in).'],
];

/** Minimal sandbox ~/.claude (the full-command-smoke pattern). */
function buildSandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'cmgr-mcp-'));
  writeFileSync(join(dir, 'settings.json'), '{}\n');
  writeFileSync(join(dir, 'CLAUDE.md'), '# sandbox\n');
  mkdirSync(join(dir, 'agents'), { recursive: true });
  writeFileSync(join(dir, 'agents', 'a.md'), '---\nname: a\n---\n# a\n');
  mkdirSync(join(dir, 'commands'), { recursive: true });
  writeFileSync(join(dir, 'commands', 'c.md'), '---\nname: c\n---\n# c\n');
  return dir;
}

/** Connect a fresh Client to a fresh buildServer(opts) over linked transports. */
async function connectPair(opts) {
  const server = buildServer(opts);
  const client = new Client({ name: 'mcp-test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    server,
    close: async () => { await client.close(); await server.close(); },
  };
}

test('mcp — initialize handshake succeeds and pins the server identity', async () => {
  const pair = await connectPair({ runFn: async () => ({ code: 0, stdout: '{}' }) });
  try {
    const info = pair.client.getServerVersion();
    assert.equal(info.name, 'harness-mgr');
    assert.equal(typeof info.version, 'string');
  } finally {
    await pair.close();
  }
});

test('mcp — tools/list returns EXACTLY the 4 read-only tools, names+descriptions pinned, deterministic order', async () => {
  const pair = await connectPair({ runFn: async () => ({ code: 0, stdout: '{}' }) });
  try {
    const first = await pair.client.listTools();
    assert.deepEqual(
      first.tools.map((t) => [t.name, t.description]),
      EXPECTED_TOOLS,
      'tools/list must expose exactly the 4 pinned tools in declaration order',
    );
    // Every tool advertises the no-input schema (least surface).
    for (const t of first.tools) {
      assert.deepEqual(t.inputSchema, { type: 'object', properties: {}, additionalProperties: false });
    }
    // Deterministic: a second listing is byte-equal.
    const second = await pair.client.listTools();
    assert.deepEqual(second.tools, first.tools);
    // The exported TOOLS table is the same single source.
    assert.deepEqual(TOOLS.map((t) => t.name), EXPECTED_TOOLS.map(([n]) => n));
  } finally {
    await pair.close();
  }
});

test('mcp — harness_mgr_health returns the real version:1 health envelope with all three sections', async () => {
  const sandbox = buildSandbox();
  const pair = await connectPair({ configDir: sandbox });
  try {
    const res = await pair.client.callTool({ name: 'harness_mgr_health', arguments: {} });
    assert.equal(res.isError ?? false, false, 'a clean sandbox health report is not an error');
    assert.equal(res.content[0].type, 'text');
    const envelope = JSON.parse(res.content[0].text);
    assert.equal(envelope.version, 1);
    assert.equal(envelope.command, 'health');
    assert.ok(envelope.result.health && typeof envelope.result.health.summary === 'object', 'health section present');
    assert.ok(envelope.result.advice && Array.isArray(envelope.result.advice.advice), 'advice section present');
    assert.ok(envelope.result.hooks && typeof envelope.result.hooks.summary === 'object', 'hooks section present');
  } finally {
    await pair.close();
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test('mcp — harness_mgr_doctor is PASSIVE (probeLevel passive, checks non-empty)', async () => {
  const sandbox = buildSandbox();
  const pair = await connectPair({ configDir: sandbox });
  try {
    const res = await pair.client.callTool({ name: 'harness_mgr_doctor', arguments: {} });
    const envelope = JSON.parse(res.content[0].text);
    assert.equal(envelope.version, 1);
    assert.equal(envelope.command, 'doctor');
    assert.equal(envelope.result.probeLevel, 'passive', 'the MCP tool must never enable active probes');
    assert.ok(Array.isArray(envelope.result.checks) && envelope.result.checks.length > 0, 'doctor genuinely evaluated checks');
  } finally {
    await pair.close();
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test('mcp — inventory and conflicts tools return their matching envelopes', async () => {
  const sandbox = buildSandbox();
  const pair = await connectPair({ configDir: sandbox });
  try {
    for (const [toolName, command] of [['harness_mgr_inventory', 'inventory'], ['harness_mgr_conflicts', 'conflicts']]) {
      const res = await pair.client.callTool({ name: toolName, arguments: {} });
      const envelope = JSON.parse(res.content[0].text);
      assert.equal(envelope.version, 1, `${toolName}: version 1 envelope`);
      assert.equal(envelope.command, command, `${toolName}: delegates to '${command}'`);
    }
  } finally {
    await pair.close();
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test('mcp — unknown tool name rejects through the SDK error path (-32601)', async () => {
  const pair = await connectPair({ runFn: async () => ({ code: 0, stdout: '{}' }) });
  try {
    await assert.rejects(
      pair.client.callTool({ name: 'harness_mgr_nope', arguments: {} }),
      (err) => {
        assert.equal(err.code, -32601, 'MethodNotFound JSON-RPC code');
        assert.match(err.message, /unknown tool/);
        return true;
      },
    );
  } finally {
    await pair.close();
  }
});

test('mcp — exit-code → isError mapping: 0/1 are valid reports, ≥2 is an error', async () => {
  const byCode = async (code) => {
    const pair = await connectPair({ runFn: async () => ({ code, stdout: `{"code":${code}}` }) });
    try {
      return await pair.client.callTool({ name: 'harness_mgr_doctor', arguments: {} });
    } finally {
      await pair.close();
    }
  };
  const ok = await byCode(0);
  assert.equal(ok.isError ?? false, false, 'exit 0 → not an error');
  const findings = await byCode(1);
  assert.equal(findings.isError ?? false, false, 'exit 1 (error diagnostics present) is still a VALID report');
  assert.equal(findings.content[0].text, '{"code":1}', 'the envelope still flows through');
  const usage = await byCode(2);
  assert.equal(usage.isError, true, 'exit 2 (usage/internal) → isError');
});

test('mcp — a throwing runFn seam degrades to an isError result (never-throws)', async () => {
  const pair = await connectPair({ runFn: async () => { throw new Error('seam boom'); } });
  try {
    const res = await pair.client.callTool({ name: 'harness_mgr_inventory', arguments: {} });
    assert.equal(res.isError, true);
    const body = JSON.parse(res.content[0].text);
    assert.equal(body.error, 'mcp-tool-failed');
    assert.match(body.message, /seam boom/);
  } finally {
    await pair.close();
  }
});

test('mcp — the configDir seam reaches run() as --config-dir (hermetic plumbing pinned)', async () => {
  /** @type {string[][]} */
  const calls = [];
  const pair = await connectPair({
    runFn: async (argv) => { calls.push(argv); return { code: 0, stdout: '{}' }; },
    configDir: '/tmp/sandbox-x',
  });
  try {
    await pair.client.callTool({ name: 'harness_mgr_health', arguments: {} });
    assert.deepEqual(calls, [['health', '--format', 'json', '--config-dir', '/tmp/sandbox-x']]);
  } finally {
    await pair.close();
  }
});
