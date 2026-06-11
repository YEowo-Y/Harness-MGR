/**
 * mcp-server-stdio.test.mjs (P5.U6) — ONE child-process smoke for the stdio
 * bootstrap (the only behavior the in-process suite cannot see: the main-guard
 * + StdioServerTransport wiring).
 *
 * Spawns `node src/mcp/server.mjs` (temp CLAUDE_CONFIG_DIR) and speaks RAW
 * newline-delimited JSON-RPC over its stdio: initialize → notifications/
 * initialized → tools/list, then asserts the 4 pinned tool names and kills
 * the child.
 *
 * GRACEFUL-SKIP ONLY if the spawn itself is impossible (the child 'error'
 * event, e.g. a missing node binary). A protocol failure — no response,
 * malformed JSON, wrong tools — is a RED, never a skip.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SERVER_PATH = resolve(import.meta.dirname, '..', '..', 'src', 'mcp', 'server.mjs');
const EXPECTED_NAMES = ['claude_mgr_inventory', 'claude_mgr_health', 'claude_mgr_conflicts', 'claude_mgr_doctor'];
const TIMEOUT_MS = 30_000;

test('mcp stdio smoke — spawn server.mjs, initialize, tools/list returns the 4 tools', async (t) => {
  const sandbox = mkdtempSync(join(tmpdir(), 'cmgr-mcp-stdio-'));
  writeFileSync(join(sandbox, 'settings.json'), '{}\n');

  const child = spawn(process.execPath, [SERVER_PATH], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: sandbox },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  /** Resolves true if spawn failed at the OS level (the ONLY skip condition). */
  const spawnFailed = new Promise((resolveSpawn) => {
    child.once('error', () => resolveSpawn(true));
    child.once('spawn', () => resolveSpawn(false));
  });

  let stderrText = '';
  child.stderr.on('data', (d) => { stderrText += String(d); });

  // Collect stdout and resolve per-id JSON-RPC responses as full lines arrive.
  let buffer = '';
  /** @type {Map<number, (msg: object) => void>} */
  const waiters = new Map();
  child.stdout.on('data', (d) => {
    buffer += String(d);
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const w = msg && typeof msg.id === 'number' ? waiters.get(msg.id) : undefined;
      if (w) { waiters.delete(msg.id); w(msg); }
    }
  });

  /** Send one JSON-RPC request and await its response (RED on timeout). */
  const request = (id, method, params) => new Promise((resolveMsg, reject) => {
    const timer = setTimeout(() => {
      waiters.delete(id);
      reject(new Error(`no response to ${method} within ${TIMEOUT_MS}ms; stderr: ${stderrText}`));
    }, TIMEOUT_MS);
    waiters.set(id, (msg) => { clearTimeout(timer); resolveMsg(msg); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });

  try {
    if (await spawnFailed) {
      t.skip('node child process could not be spawned on this host');
      return;
    }

    const init = await request(1, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'stdio-smoke', version: '0.0.0' },
    });
    assert.equal(init.error, undefined, `initialize must succeed: ${JSON.stringify(init.error)}`);
    assert.equal(init.result.serverInfo.name, 'claude-mgr');

    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

    const list = await request(2, 'tools/list', {});
    assert.equal(list.error, undefined, `tools/list must succeed: ${JSON.stringify(list.error)}`);
    assert.deepEqual(
      list.result.tools.map((tool) => tool.name),
      EXPECTED_NAMES,
      'the stdio server must expose exactly the 4 pinned tool names in order',
    );
  } finally {
    child.kill();
    rmSync(sandbox, { recursive: true, force: true });
  }
});
