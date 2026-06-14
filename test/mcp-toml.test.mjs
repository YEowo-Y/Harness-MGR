/**
 * P6 TOML wave, unit 3 — unit oracle for discoverMcpForTarget / discoverMcpToml.
 *
 * Falsifiable oracles over temp config.toml / .mcp.json fixtures:
 *   - codex toml-table discovery: count, sort, transport classification, scope,
 *     envKeys NAMES, and the HEADLINE secret oracle (a token-shaped env VALUE
 *     never enters the record — proves toRecord reuse, env -> envKeys names only).
 *   - benign-missing, malformed-entry, malformed-TOML, bad-root diagnostics.
 *   - the dispatcher: claude descriptor (and no-descriptor default) read the JSON
 *     path and NEVER read config.toml.
 *   - a scan() drift-guard: no-descriptor === claudeDescriptor (CC path unchanged).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { discoverMcpForTarget } from '../src/discovery/mcp-target.mjs';
import { scan } from '../src/discovery/scan.mjs';
import { codexDescriptor } from '../src/targets/codex.mjs';
import { claudeDescriptor } from '../src/targets/claude.mjs';

/** A 36-char token-shaped secret VALUE (must never enter a record). */
const GHP_TOKEN = 'ghp_0123456789abcdef0123456789abcdef01';

/** Make a temp dir, run fn(dir), always clean up. */
function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'mgr-mcp-toml-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const CODEX_CONFIG = `
[mcp_servers.alpha]
command = "node"
args = ["server.mjs", "--port", "3000"]

[mcp_servers.alpha.env]
API_KEY = "${GHP_TOKEN}"
MODE = "fast"

[mcp_servers.bare]
url = "https://example.com/bare"

[mcp_servers.typed]
type = "http"
url = "https://example.com/typed"
`;

// ---------------------------------------------------------------------------
// 1. codex toml-table discovery + headline secret oracle
// ---------------------------------------------------------------------------

test('codex config.toml mcp_servers -> secret-safe sorted records', () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, 'config.toml'), CODEX_CONFIG);
    const { mcpServers, diagnostics } = discoverMcpForTarget({ rootDir: dir, descriptor: codexDescriptor });

    assert.equal(diagnostics.length, 0);
    assert.equal(mcpServers.length, 3);

    // sorted by name
    assert.deepEqual(mcpServers.map((r) => r.name), ['alpha', 'bare', 'typed']);

    // transport classification per server
    const byName = Object.fromEntries(mcpServers.map((r) => [r.name, r]));
    assert.equal(byName.alpha.transport, 'stdio'); // command
    assert.equal(byName.bare.transport, 'http'); // bare url
    assert.equal(byName.typed.transport, 'http'); // explicit type=http

    // scope 'user' on every record (config.toml is the single user-level config)
    for (const r of mcpServers) assert.equal(r.scope, 'user');

    // envKeys is the sorted NAMES list — never values
    assert.deepEqual(byName.alpha.envKeys, ['API_KEY', 'MODE']);
    // command/args kept verbatim
    assert.equal(byName.alpha.command, 'node');
    assert.deepEqual(byName.alpha.args, ['server.mjs', '--port', '3000']);

    // HEADLINE: the env token VALUE never enters the record (toRecord reuse).
    assert.equal(JSON.stringify(mcpServers).includes(GHP_TOKEN), false);
    assert.equal(JSON.stringify(mcpServers).includes('ghp_'), false);
  });
});

// ---------------------------------------------------------------------------
// 2. missing config.toml — benign empty
// ---------------------------------------------------------------------------

test('missing config.toml -> empty servers, no diagnostics', () => {
  withTempDir((dir) => {
    const r = discoverMcpForTarget({ rootDir: dir, descriptor: codexDescriptor });
    assert.deepEqual(r.mcpServers, []);
    assert.deepEqual(r.diagnostics, []);
  });
});

// ---------------------------------------------------------------------------
// 3. malformed entry — a scalar where a table was expected
// ---------------------------------------------------------------------------

test('non-table mcp_servers entry -> mcp-entry-malformed warn, real sub-table kept', () => {
  withTempDir((dir) => {
    writeFileSync(
      join(dir, 'config.toml'),
      [
        '[mcp_servers]',
        'bad = "notatable"',
        '',
        '[mcp_servers.good]',
        'command = "node"',
        '',
      ].join('\n'),
    );
    const { mcpServers, diagnostics } = discoverMcpForTarget({ rootDir: dir, descriptor: codexDescriptor });

    assert.deepEqual(mcpServers.map((r) => r.name), ['good']);
    assert.equal(mcpServers[0].transport, 'stdio');

    const malformed = diagnostics.filter((d) => d.code === 'mcp-entry-malformed');
    assert.equal(malformed.length, 1);
    assert.equal(malformed[0].severity, 'warn');
    assert.match(malformed[0].message, /'bad'/);
  });
});

// ---------------------------------------------------------------------------
// 4. genuinely malformed TOML — one warn, zero servers, never throws
// ---------------------------------------------------------------------------

test('malformed TOML -> mcp-toml-invalid warn, zero servers, never throws', () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, 'config.toml'), 'b = @nope\n');
    let r;
    assert.doesNotThrow(() => {
      r = discoverMcpForTarget({ rootDir: dir, descriptor: codexDescriptor });
    });
    assert.deepEqual(r.mcpServers, []);
    const invalid = r.diagnostics.filter((d) => d.code === 'mcp-toml-invalid');
    assert.equal(invalid.length, 1);
    assert.equal(invalid[0].severity, 'warn');
  });
});

// ---------------------------------------------------------------------------
// 5. bad rootDir
// ---------------------------------------------------------------------------

test('empty rootDir -> discover-bad-root, zero servers', () => {
  const r = discoverMcpForTarget({ rootDir: '', descriptor: codexDescriptor });
  assert.deepEqual(r.mcpServers, []);
  const bad = r.diagnostics.filter((d) => d.code === 'discover-bad-root');
  assert.equal(bad.length, 1);
  assert.equal(bad[0].severity, 'error');
});

// ---------------------------------------------------------------------------
// 6. dispatcher — claude descriptor (and default) take the JSON path
// ---------------------------------------------------------------------------

test('claude descriptor reads .mcp.json and NEVER config.toml', () => {
  withTempDir((dir) => {
    // BOTH files present: a .mcp.json project server AND a config.toml mcp table.
    writeFileSync(
      join(dir, '.mcp.json'),
      JSON.stringify({ mcpServers: { jsonsrv: { command: 'node' } } }),
    );
    writeFileSync(join(dir, 'config.toml'), CODEX_CONFIG);

    const withClaude = discoverMcpForTarget({ rootDir: dir, descriptor: claudeDescriptor });
    assert.deepEqual(withClaude.mcpServers.map((r) => r.name), ['jsonsrv']);
    assert.equal(withClaude.mcpServers[0].scope, 'project');

    // No descriptor behaves the same (json-files default).
    const noDesc = discoverMcpForTarget({ rootDir: dir });
    assert.deepEqual(noDesc.mcpServers.map((r) => r.name), ['jsonsrv']);
    assert.equal(noDesc.mcpServers[0].scope, 'project');
  });
});

// ---------------------------------------------------------------------------
// 7. scan() drift-guard — no-descriptor === claudeDescriptor (CC path unchanged)
// ---------------------------------------------------------------------------

test('scan() mcp is byte-identical with no descriptor vs claudeDescriptor', () => {
  withTempDir((dir) => {
    // a CC dir with a .mcp.json project server (NO config.toml)
    writeFileSync(
      join(dir, '.mcp.json'),
      JSON.stringify({ mcpServers: { p: { command: 'node', args: ['a'] } } }),
    );
    mkdirSync(join(dir, 'skills'), { recursive: true });

    const noDesc = scan({ targetClaudeDir: dir }).mcpServers;
    const withClaude = scan({ targetClaudeDir: dir, descriptor: claudeDescriptor }).mcpServers;
    assert.deepEqual(noDesc, withClaude);
    assert.deepEqual(noDesc.map((r) => r.name), ['p']);
  });
});

// ---------------------------------------------------------------------------
// 8. fallback guard — a toml-table source missing file/pointer falls back
//    SAFELY to the JSON path (never join(rootDir, undefined) -> TypeError)
// ---------------------------------------------------------------------------

test('toml-table mcpSource missing file/pointer -> json fallback, never throws', () => {
  withTempDir((dir) => {
    // a .mcp.json IS present; a config.toml IS NOT — if the guard wrongly took the
    // toml path it would join(rootDir, undefined) and throw / find nothing.
    writeFileSync(
      join(dir, '.mcp.json'),
      JSON.stringify({ mcpServers: { jsonsrv: { command: 'node' } } }),
    );
    const broken = { ...codexDescriptor, mcpSource: { kind: 'toml-table' } }; // no file/pointer
    let r;
    assert.doesNotThrow(() => {
      r = discoverMcpForTarget({ rootDir: dir, descriptor: broken });
    });
    // fell back to the json-files path
    assert.deepEqual(r.mcpServers.map((x) => x.name), ['jsonsrv']);
    assert.equal(r.mcpServers[0].scope, 'project');
  });
});
