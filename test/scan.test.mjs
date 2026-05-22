/**
 * P1.U10 — scan.test.mjs
 *
 * End-to-end assertions for the scan() orchestrator: shape, counts, performance
 * gate (<500 ms), kinds filter, and bad-input / never-throw contract.
 * Golden fixtures: minimal/ (3 components, clean) and settings-mcp/ (statusLine
 * + 3 project MCP servers, optional user-scope via appFile).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scan, ALL_KINDS } from '../src/discovery/scan.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fix = (rel) => join(here, 'fixtures', rel);
const bySeverity = (diags, sev) => diags.filter((d) => d.severity === sev);

// ── ALL_KINDS ─────────────────────────────────────────────────────────────────

test('ALL_KINDS has exactly the 4 discovery categories', () => {
  assert.equal(ALL_KINDS.length, 4);
  assert.ok(ALL_KINDS.includes('components'));
  assert.ok(ALL_KINDS.includes('plugins'));
  assert.ok(ALL_KINDS.includes('settings'));
  assert.ok(ALL_KINDS.includes('mcp'));
});

// ── minimal/ — full scan ──────────────────────────────────────────────────────

test('minimal: ScanResult has all required top-level fields', () => {
  const r = scan({ targetClaudeDir: fix('minimal') });
  assert.ok(Array.isArray(r.components), 'components is array');
  assert.ok(Array.isArray(r.plugins), 'plugins is array');
  assert.ok(Array.isArray(r.marketplaces), 'marketplaces is array');
  assert.ok(r.settings && typeof r.settings === 'object', 'settings is object');
  assert.ok(r.topDirs && typeof r.topDirs === 'object', 'topDirs is object');
  assert.ok(Array.isArray(r.mcpServers), 'mcpServers is array');
  assert.ok(Array.isArray(r.diagnostics), 'diagnostics is array');
  assert.ok(r.scanMeta && typeof r.scanMeta.durationMs === 'number', 'scanMeta.durationMs is number');
  assert.ok(typeof r.scanMeta.scannedAt === 'string', 'scanMeta.scannedAt is string');
});

test('minimal: completes in under 500 ms (P1.U10 acceptance gate)', () => {
  const r = scan({ targetClaudeDir: fix('minimal') });
  assert.ok(r.scanMeta.durationMs < 500, `durationMs ${r.scanMeta.durationMs} ≥ 500`);
});

test('minimal: 0 error diagnostics on a clean fixture', () => {
  const r = scan({ targetClaudeDir: fix('minimal') });
  assert.equal(bySeverity(r.diagnostics, 'error').length, 0);
});

test('minimal: 1 skill, 1 agent, 1 command', () => {
  const r = scan({ targetClaudeDir: fix('minimal') });
  const byKind = (k) => r.components.filter((c) => c.kind === k);
  assert.equal(byKind('skill').length, 1);
  assert.equal(byKind('agent').length, 1);
  assert.equal(byKind('command').length, 1);
});

test('minimal: settings present, statusLine null', () => {
  const r = scan({ targetClaudeDir: fix('minimal') });
  assert.equal(r.settings.present, true);
  assert.equal(r.settings.statusLine, null);
});

test('minimal: topDirs — 3 known present (agents, commands, skills), none unknown', () => {
  const r = scan({ targetClaudeDir: fix('minimal') });
  const present = r.topDirs.known.filter((d) => d.present).map((d) => d.name).sort();
  assert.deepEqual(present, ['agents', 'commands', 'skills']);
  assert.deepEqual(r.topDirs.unknown, []);
});

test('minimal: no plugins, marketplaces, or MCP servers', () => {
  const r = scan({ targetClaudeDir: fix('minimal') });
  assert.deepEqual(r.plugins, []);
  assert.deepEqual(r.marketplaces, []);
  assert.deepEqual(r.mcpServers, []);
});

test('minimal: scanMeta.scannedAt is a valid ISO 8601 date string', () => {
  const r = scan({ targetClaudeDir: fix('minimal') });
  assert.ok(!isNaN(Date.parse(r.scanMeta.scannedAt)), 'scannedAt must be a parseable date');
});

// ── settings-mcp/ ─────────────────────────────────────────────────────────────

test('settings-mcp: statusLine captured, 3 project MCP servers (no appFile)', () => {
  const r = scan({ targetClaudeDir: fix('settings-mcp') });
  assert.deepEqual(r.settings.statusLine, { type: 'command', command: 'node $HOME/.claude/hud/omc-hud.mjs' });
  assert.equal(r.mcpServers.filter((s) => s.scope === 'project').length, 3);
});

test('settings-mcp: with appFile → 4 MCP servers including user-memory', () => {
  const r = scan({
    targetClaudeDir: fix('settings-mcp'),
    appFile: fix('settings-mcp/claude.json'),
  });
  assert.equal(r.mcpServers.length, 4);
  assert.ok(r.mcpServers.find((s) => s.name === 'user-memory'), 'user-memory present');
});

// ── kinds filter ──────────────────────────────────────────────────────────────

test('kinds: components-only → 3 components; plugins and mcpServers empty', () => {
  const r = scan({ targetClaudeDir: fix('minimal'), kinds: ['components'] });
  assert.equal(r.components.length, 3);
  assert.deepEqual(r.plugins, []);
  assert.deepEqual(r.mcpServers, []);
});

test('kinds: mcp-only → components empty, 0 mcpServers (minimal has no .mcp.json)', () => {
  const r = scan({ targetClaudeDir: fix('minimal'), kinds: ['mcp'] });
  assert.deepEqual(r.components, []);
  assert.deepEqual(r.plugins, []);
  assert.deepEqual(r.mcpServers, []);
});

test('kinds: settings-only → components empty, settings present', () => {
  const r = scan({ targetClaudeDir: fix('minimal'), kinds: ['settings'] });
  assert.deepEqual(r.components, []);
  assert.equal(r.settings.present, true);
});

test('kinds: empty array → falls back to all kinds (same counts as default)', () => {
  const full = scan({ targetClaudeDir: fix('minimal') });
  const fallback = scan({ targetClaudeDir: fix('minimal'), kinds: [] });
  assert.equal(fallback.components.length, full.components.length);
  assert.equal(fallback.settings.present, full.settings.present);
  assert.equal(fallback.topDirs.known.length, full.topDirs.known.length);
});

test('kinds: unknown strings silently dropped → falls back to all kinds', () => {
  const full = scan({ targetClaudeDir: fix('minimal') });
  const r = scan({ targetClaudeDir: fix('minimal'), kinds: ['bogus', 'also-bogus'] });
  assert.equal(r.components.length, full.components.length);
});

// ── bad input / never-throw ───────────────────────────────────────────────────

test('empty targetClaudeDir → discover-bad-root, never throws', () => {
  let r;
  assert.doesNotThrow(() => {
    r = scan({ targetClaudeDir: '' });
  });
  assert.equal(r.diagnostics[0].code, 'discover-bad-root');
  assert.deepEqual(r.components, []);
  assert.deepEqual(r.mcpServers, []);
});

test('missing targetClaudeDir field → discover-bad-root', () => {
  let r;
  assert.doesNotThrow(() => {
    r = scan(/** @type {any} */ ({}));
  });
  assert.equal(r.diagnostics[0].code, 'discover-bad-root');
});

test('null/undefined/number/string opts → discover-bad-root, never throw', () => {
  for (const junk of [null, undefined, 42, 'x']) {
    let r;
    assert.doesNotThrow(() => {
      r = scan(/** @type {any} */ (junk));
    }, `scan(${JSON.stringify(junk)}) must not throw`);
    assert.equal(r.diagnostics[0].code, 'discover-bad-root');
    assert.deepEqual(r.components, []);
  }
});

test('empty-result scanMeta has numeric durationMs and valid scannedAt', () => {
  const r = scan({ targetClaudeDir: '' });
  assert.ok(typeof r.scanMeta.durationMs === 'number');
  assert.ok(!isNaN(Date.parse(r.scanMeta.scannedAt)));
});
