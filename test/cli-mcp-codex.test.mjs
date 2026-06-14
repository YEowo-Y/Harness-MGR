/**
 * P6 TOML wave, unit 3 — end-to-end codex MCP inventory through run().
 *
 * `inventory --type mcp --target codex` reads the config.toml `mcp_servers` table;
 * the HEADLINE oracle is that NONE of three planted secrets (an env token, an args
 * token, a url token) appears anywhere in stdout (env -> envKeys dropped by the
 * inventory trim; args token -> redacted by redactMcpArgs; url token -> the whole
 * url is dropped by the inventory trim). Plus a CC-unchanged leg.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { run } from '../src/cli.mjs';

const ENV_TOKEN = 'ghp_envAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const ARGS_TOKEN = 'sk-argsBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const URL_TOKEN = 'ghp_urlCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';

const CODEX_CONFIG = `
[mcp_servers.alpha]
command = "node"
args = ["server.mjs", "--token=${ARGS_TOKEN}"]

[mcp_servers.alpha.env]
API_KEY = "${ENV_TOKEN}"

[mcp_servers.web]
url = "https://example.com/mcp?token=${URL_TOKEN}"
`;

async function withCodexDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'mgr-cli-codex-'));
  try {
    writeFileSync(join(dir, 'config.toml'), CODEX_CONFIG);
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 1. inventory --type mcp --target codex --format json
// ---------------------------------------------------------------------------

test('inventory --type mcp --target codex lists the config.toml servers', async () => {
  await withCodexDir(async (dir) => {
    const out = await run(['inventory', '--type', 'mcp', '--target', 'codex', '--config-dir', dir, '--format', 'json']);
    assert.equal(out.code, 0);
    const env = JSON.parse(out.stdout);
    assert.equal(env.command, 'inventory');
    assert.equal(env.result.type, 'mcp');
    assert.equal(env.result.items.length, 2);
    const names = env.result.items.map((i) => i.name);
    assert.ok(names.includes('alpha'), 'expected the alpha server present');
    assert.ok(names.includes('web'), 'expected the web server present');
  });
});

// ---------------------------------------------------------------------------
// 2. HEADLINE secret oracle — none of the three planted tokens leak
// ---------------------------------------------------------------------------

test('no planted secret (env / args / url token) appears in stdout', async () => {
  await withCodexDir(async (dir) => {
    const out = await run(['inventory', '--type', 'mcp', '--target', 'codex', '--config-dir', dir, '--format', 'json']);
    assert.equal(out.code, 0);
    assert.equal(out.stdout.includes(ENV_TOKEN), false, 'env token leaked');
    assert.equal(out.stdout.includes(ARGS_TOKEN), false, 'args token leaked');
    assert.equal(out.stdout.includes(URL_TOKEN), false, 'url token leaked');
  });
});

// ---------------------------------------------------------------------------
// 3. --by-category sets mcpCategories
// ---------------------------------------------------------------------------

test('inventory --by-category --target codex exposes mcpCategories', async () => {
  await withCodexDir(async (dir) => {
    const out = await run(['inventory', '--by-category', '--target', 'codex', '--config-dir', dir, '--format', 'json']);
    assert.equal(out.code, 0);
    const env = JSON.parse(out.stdout);
    assert.ok(env.result.mcpCategories, 'expected an mcpCategories block');
    assert.ok(env.result.mcpCategories.summary, 'expected a summary');
    assert.ok(env.result.mcpCategories.byCategory, 'expected a byCategory map');
  });
});

// ---------------------------------------------------------------------------
// 4. CC-UNCHANGED leg — a .mcp.json dir with NO config.toml auto-detects claude
// ---------------------------------------------------------------------------

test('CC inventory (no --target, no config.toml) lists the .mcp.json project server', async () => {
  const ccDir = mkdtempSync(join(tmpdir(), 'mgr-cli-cc-'));
  try {
    writeFileSync(
      join(ccDir, '.mcp.json'),
      JSON.stringify({ mcpServers: { ccserver: { command: 'node', args: ['x'] } } }),
    );
    const out = await run(['inventory', '--type', 'mcp', '--config-dir', ccDir, '--format', 'json']);
    assert.equal(out.code, 0);
    const env = JSON.parse(out.stdout);
    assert.equal(env.result.type, 'mcp');
    assert.equal(env.result.items.length, 1);
    assert.equal(env.result.items[0].name, 'ccserver');
    assert.equal(env.result.items[0].scope, 'project');
  } finally {
    rmSync(ccDir, { recursive: true, force: true });
  }
});
