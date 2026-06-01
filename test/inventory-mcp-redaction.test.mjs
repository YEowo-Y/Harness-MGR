/**
 * Falsifiable oracle for the `inventory --type mcp` url/envKeys-leak fix (UNIT #2).
 *
 * This test FAILS against the pre-fix code (which had `narrowInventory` return the
 * RAW `s.mcpServers` for `--type mcp`, so a server's `url` — including a query
 * token — and its env KEY NAMES reached `--format json/ndjson` verbatim, bypassing
 * the `trimMcpServer` redaction the `--detail` path already applied) and PASSES
 * after `narrowInventory` maps the mcp list through `trimMcpServer`, dropping
 * `url` + `envKeys` so `--type mcp` is NO LEAKIER than `--detail`. command + args
 * are intentionally KEPT (package-name pattern; arg-value redaction is deferred).
 *
 * The env VALUES were never recorded by mcp.mjs (only `envKeys` names are), so the
 * pre-fix leak surface is the raw `url` (+ its query token) and the env key NAMES.
 * The oracle plants a MUSTNOTLEAK sentinel in the url query string AND an env value
 * + key name, then asserts none of them survive either serialization.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { inventoryCommand } from '../src/cli/commands.mjs';
import { formatJson, formatNdjson } from '../src/output/json.mjs';

const URL_TOKEN = 'TOKEN_MUSTNOTLEAK';
const URL_WITH_TOKEN = `https://mcp.example.ai/mcp?token=${URL_TOKEN}`;
const ENV_KEY = 'SECRET_SVC_API_KEY_MUSTNOTLEAK';
const ENV_VALUE = 'APIVALUE_MUSTNOTLEAK';
const KEPT_COMMAND = 'npx';
const KEPT_ARG = '@modelcontextprotocol/server-github';

/**
 * Write a `.mcp.json` whose project-scope servers carry leak sentinels: an http
 * server with a url query token, and a stdio server with a secret env (key name +
 * value) plus the command/args that MUST survive. Run `inventory --type mcp` and
 * clean up.
 * @returns {{result: unknown, diagnostics: unknown[]}}
 */
function runInventoryMcp() {
  const dir = mkdtempSync(join(tmpdir(), 'mgr-mcp-leak-'));
  try {
    const mcp = {
      mcpServers: {
        'http-svc': { type: 'http', url: URL_WITH_TOKEN },
        'stdio-svc': {
          command: KEPT_COMMAND,
          args: ['-y', KEPT_ARG],
          env: { [ENV_KEY]: ENV_VALUE },
        },
      },
    };
    writeFileSync(join(dir, '.mcp.json'), JSON.stringify(mcp), 'utf8');
    return inventoryCommand({ configDir: dir, args: { type: 'mcp' } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('inventory --type mcp — zero url/envKeys leak across formatJson + formatNdjson (falsifiable oracle)', () => {
  const { result, diagnostics } = runInventoryMcp();

  // Sanity: the narrowed shape is the mcp list with both servers present.
  assert.equal(result.type, 'mcp');
  assert.ok(Array.isArray(result.items), 'items must be an array');
  assert.equal(result.items.length, 2, 'both planted servers are discovered');

  for (const wire of [
    formatJson({ command: 'inventory', result, diagnostics }),
    formatNdjson({ command: 'inventory', result, diagnostics }),
  ]) {
    // Zero-leak: no sentinel appears anywhere in either serialization.
    assert.ok(!wire.includes(URL_TOKEN), 'url query token leaked into --type mcp output');
    assert.ok(!wire.includes(URL_WITH_TOKEN), 'raw url leaked into --type mcp output');
    assert.ok(!wire.includes(ENV_KEY), 'env key NAME leaked into --type mcp output');
    assert.ok(!wire.includes(ENV_VALUE), 'env value leaked into --type mcp output');
    assert.ok(!wire.includes('envKeys'), 'envKeys field leaked into --type mcp output');

    // command + args are intentionally still shown (package-name pattern).
    assert.ok(wire.includes(KEPT_COMMAND), 'command must still be present');
    assert.ok(wire.includes(KEPT_ARG), 'args must still be present');
  }
});

test('inventory --type mcp — each item carries exactly the five secret-safe UI fields', () => {
  const { result } = runInventoryMcp();
  for (const m of result.items) {
    assert.deepEqual(
      Object.keys(m).sort(),
      ['args', 'command', 'name', 'scope', 'transport'],
      'mcp item keys must be exactly the five trimMcpServer UI fields',
    );
    assert.ok(!('url' in m), 'url must never appear in --type mcp items');
    assert.ok(!('envKeys' in m), 'envKeys must never appear in --type mcp items');
  }
});
