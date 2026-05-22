/**
 * P1.U15 (sub-unit A) — cli-commands.test.mjs
 *
 * Smoke tests for the CLI command layer against the minimal/ fixture:
 *   - resolveConfigDir: explicit override / injected loader / M2 throw → fallback.
 *   - each of the six handlers: golden result shape + key diagnostics.
 *   - a never-throws sweep: every handler on a non-existent configDir.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolveConfigDir } from '../src/cli/resolve-config.mjs';
import {
  COMMANDS,
  inventoryCommand,
  conflictsCommand,
  orphansCommand,
  configShowEffectiveCommand,
  hooksCommand,
  selftestCommand,
} from '../src/cli/commands.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fix = (rel) => join(here, 'fixtures', rel);
const MIN = fix('minimal');

const bySeverity = (diags, sev) => diags.filter((d) => d.severity === sev);
const hasCode = (diags, code) => diags.some((d) => d.code === code);

// ── A. resolveConfigDir ─────────────────────────────────────────────────────────

test('resolveConfigDir: explicit override is used verbatim, 0 diagnostics', async () => {
  const r = await resolveConfigDir({ configDir: '/x' });
  assert.equal(r.configDir, '/x');
  assert.equal(r.diagnostics.length, 0);
});

test('resolveConfigDir: injected loadPaths returns targetClaudeDir, 0 diagnostics', async () => {
  const r = await resolveConfigDir({ loadPaths: async () => ({ targetClaudeDir: () => '/live' }) });
  assert.equal(r.configDir, '/live');
  assert.equal(r.diagnostics.length, 0);
});

test('resolveConfigDir: loadPaths that throws → 1 missing-hooks-lib warn + env fallback', async () => {
  const SENTINEL = join(MIN, '..', '__sentinel_config__');
  const saved = process.env.CLAUDE_CONFIG_DIR;
  try {
    process.env.CLAUDE_CONFIG_DIR = SENTINEL;
    const r = await resolveConfigDir({ loadPaths: async () => { throw new Error('boom: no hooks/lib'); } });
    const warns = bySeverity(r.diagnostics, 'warn');
    assert.equal(warns.length, 1);
    assert.equal(warns[0].code, 'missing-hooks-lib');
    assert.equal(r.configDir, SENTINEL);
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
  }
});

test('resolveConfigDir: loadPaths throws + no CLAUDE_CONFIG_DIR → ~/.claude fallback', async () => {
  const saved = process.env.CLAUDE_CONFIG_DIR;
  try {
    delete process.env.CLAUDE_CONFIG_DIR;
    const r = await resolveConfigDir({ loadPaths: async () => { throw new Error('boom: no hooks/lib'); } });
    assert.equal(r.configDir, join(homedir(), '.claude'));
    assert.equal(r.diagnostics.length, 1);
    assert.equal(r.diagnostics[0].code, 'missing-hooks-lib');
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
  }
});

// ── B. inventory ────────────────────────────────────────────────────────────────

test('inventoryCommand: minimal/ counts are 1/1/1 + zeros; no error diagnostics', () => {
  const { result, diagnostics } = inventoryCommand({ configDir: MIN, args: {} });
  assert.deepEqual(result.counts, {
    skills: 1, agents: 1, commands: 1, plugins: 0, marketplaces: 0, mcpServers: 0,
  });
  assert.equal(bySeverity(diagnostics, 'error').length, 0);
});

// ── C. conflicts ────────────────────────────────────────────────────────────────

test('conflictsCommand: minimal/ has no conflicts + emits the version-guard info', () => {
  const { result, diagnostics } = conflictsCommand({ configDir: MIN, args: {} });
  assert.deepEqual(result.conflicts, []);
  assert.ok(hasCode(diagnostics, 'loader-rules-unverified-version'));
});

// ── D. orphans ──────────────────────────────────────────────────────────────────

test('orphansCommand: minimal/ has zero orphans', () => {
  const { result } = orphansCommand({ configDir: MIN, args: {} });
  assert.deepEqual(result.summary, { hard: 0, soft: 0, total: 0 });
});

// ── E. config:show-effective ─────────────────────────────────────────────────────

test('configShowEffectiveCommand: minimal/ merges model + permissions, known confidence', () => {
  const { result } = configShowEffectiveCommand({ configDir: MIN, args: {} });
  assert.equal(result.effective.model, 'sonnet');
  assert.deepEqual(result.effective.permissions.allow, ['Read', 'Glob']);
  assert.equal(result.keys.model.mergeConfidence, 'known');
});

test('configShowEffectiveCommand: --key model narrows to value "sonnet"', () => {
  const { result } = configShowEffectiveCommand({ configDir: MIN, args: { key: 'model' } });
  assert.equal(result.key, 'model');
  assert.equal(result.value, 'sonnet');
});

// ── F. hooks ────────────────────────────────────────────────────────────────────

test('hooksCommand: minimal/ has no hooks → empty object', () => {
  const { result } = hooksCommand({ configDir: MIN, args: { order: true } });
  assert.deepEqual(result.hooks, {});
});

// ── G. selftest ─────────────────────────────────────────────────────────────────

test('selftestCommand: minimal/ smoke check is ok', () => {
  const { result } = selftestCommand({ configDir: MIN, args: {} });
  assert.equal(result.ok, true);
});

// ── H. never-throws sweep ─────────────────────────────────────────────────────────

test('every handler on a non-existent configDir does not throw + returns {result, diagnostics}', () => {
  const GONE = fix('does-not-exist');
  for (const [name, handler] of Object.entries(COMMANDS)) {
    assert.doesNotThrow(() => {
      const out = handler({ configDir: GONE, args: {} });
      assert.ok(out && typeof out === 'object', `${name} returned a non-object`);
      assert.ok('result' in out, `${name} missing result`);
      assert.ok(Array.isArray(out.diagnostics), `${name} diagnostics not an array`);
    }, `${name} threw on a missing configDir`);
  }
});
