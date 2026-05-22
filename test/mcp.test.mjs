/**
 * P1.U9 — mcp.test.mjs
 *
 * Golden assertions for discoverMcp against settings-mcp/: project scope
 * (.mcp.json: stdio + http + env-bearing) and user scope (claude.json top-level
 * mcpServers), with the per-project mcpServers correctly ignored. The headline
 * guard asserts NO env VALUE leaks into any record (secret safety).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverMcp } from '../src/discovery/mcp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fix = (rel) => join(here, 'fixtures', rel);
const bySeverity = (diags, sev) => diags.filter((d) => d.severity === sev);

/** Run `fn` against a throwaway config dir holding .mcp.json. */
function withTempMcp(content, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'mgr-u9-mcp-'));
  try {
    writeFileSync(join(dir, '.mcp.json'), content, 'utf-8');
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── settings-mcp/ (project + user) ──────────────────────────────────────────

test('settings-mcp: 3 project + 1 user server; per-project mcpServers ignored', () => {
  const { mcpServers, diagnostics } = discoverMcp({
    rootDir: fix('settings-mcp'),
    appFile: fix('settings-mcp/claude.json'),
  });
  assert.equal(bySeverity(diagnostics, 'error').length, 0);
  assert.equal(mcpServers.length, 4);

  const names = mcpServers.map((s) => s.name);
  assert.ok(names.includes('user-memory'), 'user-scope server present');
  assert.ok(!names.includes('project-scoped-should-be-ignored'), 'nested project mcpServers ignored');

  const project = mcpServers.filter((s) => s.scope === 'project').map((s) => s.name);
  assert.deepEqual(project, ['exa', 'github', 'secret-svc'], 'project servers sorted by name');
  assert.equal(mcpServers.filter((s) => s.scope === 'user')[0].name, 'user-memory');
});

test('settings-mcp: transports classified (stdio vs http)', () => {
  const { mcpServers } = discoverMcp({ rootDir: fix('settings-mcp'), appFile: fix('settings-mcp/claude.json') });
  const byName = Object.fromEntries(mcpServers.map((s) => [s.name, s]));

  assert.equal(byName.github.transport, 'stdio');
  assert.equal(byName.github.command, 'npx');
  assert.ok(byName.github.args.includes('@modelcontextprotocol/server-github'));

  assert.equal(byName.exa.transport, 'http');
  assert.equal(byName.exa.url, 'https://mcp.exa.ai/mcp');
  assert.equal(byName.exa.command, undefined);
});

test('SECRET SAFETY: env key NAMES captured, values never leak', () => {
  const { mcpServers } = discoverMcp({ rootDir: fix('settings-mcp'), appFile: fix('settings-mcp/claude.json') });
  const secret = mcpServers.find((s) => s.name === 'secret-svc');
  assert.deepEqual(secret.envKeys, ['SECRET_SVC_API_KEY', 'SECRET_SVC_REGION']);

  // Both fixture env VALUES carry the distinctive sentinel "MUSTNOTLEAK"; it
  // must appear nowhere in the serialized records (key NAMES are fine).
  assert.ok(!JSON.stringify(mcpServers).includes('MUSTNOTLEAK'), 'no env value in any record');
});

test('settings-mcp without appFile: only the 3 project servers', () => {
  const { mcpServers } = discoverMcp({ rootDir: fix('settings-mcp') });
  assert.equal(mcpServers.length, 3);
  assert.equal(mcpServers.every((s) => s.scope === 'project'), true);
});

// ── edge cases ──────────────────────────────────────────────────────────────

test('minimal: no .mcp.json → empty, no diagnostics', () => {
  const { mcpServers, diagnostics } = discoverMcp({ rootDir: fix('minimal') });
  assert.deepEqual(mcpServers, []);
  assert.deepEqual(diagnostics, []);
});

test('malformed .mcp.json → error diagnostic, no throw', () => {
  withTempMcp('{ "mcpServers": { bad json } }', (dir) => {
    let result;
    assert.doesNotThrow(() => {
      result = discoverMcp({ rootDir: dir });
    });
    assert.equal(result.mcpServers.length, 0);
    const err = result.diagnostics.find((d) => d.code === 'mcp-unreadable');
    assert.ok(err);
    assert.equal(err.severity, 'error');
  });
});

test('a non-object server entry is skipped with a warn', () => {
  withTempMcp(JSON.stringify({ mcpServers: { ok: { command: 'x' }, bad: 42 } }), (dir) => {
    const { mcpServers, diagnostics } = discoverMcp({ rootDir: dir });
    assert.equal(mcpServers.length, 1);
    assert.equal(mcpServers[0].name, 'ok');
    assert.ok(diagnostics.find((d) => d.code === 'mcp-entry-malformed'));
  });
});

test('transport priority: a server with both command AND url classifies as http', () => {
  withTempMcp(JSON.stringify({ mcpServers: { both: { command: 'node', url: 'https://x' } } }), (dir) => {
    const { mcpServers } = discoverMcp({ rootDir: dir });
    assert.equal(mcpServers[0].transport, 'http');
  });
});

test('missing rootDir → discover-bad-root, never throws', () => {
  let result;
  assert.doesNotThrow(() => {
    result = discoverMcp(/** @type {any} */ ({}));
  });
  assert.deepEqual(result.mcpServers, []);
  assert.equal(result.diagnostics[0].code, 'discover-bad-root');
});

test('null/undefined/non-object opts never throw (opts ?? {} guard)', () => {
  for (const junk of [null, undefined, 42, 'x']) {
    let result;
    assert.doesNotThrow(() => {
      result = discoverMcp(/** @type {any} */ (junk));
    }, `discoverMcp(${JSON.stringify(junk)}) must not throw`);
    assert.deepEqual(result.mcpServers, []);
    assert.equal(result.diagnostics[0].code, 'discover-bad-root');
  }
});
