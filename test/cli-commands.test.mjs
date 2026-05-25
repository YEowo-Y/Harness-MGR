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
import { MGR_STATE_DIRNAME } from '../src/paths.mjs';
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

test('resolveConfigDir: injected loadPaths returns targetClaudeDir + mgrStateDir, 0 diagnostics', async () => {
  const r = await resolveConfigDir({ loadPaths: async () => ({ targetClaudeDir: () => '/live', mgrStateDir: (cd) => `${cd}/.mgr-state` }) });
  assert.equal(r.configDir, '/live');
  assert.equal(r.mgrStateDir, '/live/.mgr-state');
  assert.equal(r.diagnostics.length, 0);
});

test('resolveConfigDir: mgrStateDir literal matches MGR_STATE_DIRNAME (drift guard)', async () => {
  // resolve-config.mjs keeps a LOCAL `.mgr-state` literal so it never statically
  // imports paths.mjs (the M2 top-level-await reject hazard). This test is where
  // that literal is reconciled against the single source of truth in paths.mjs —
  // mirroring the orphan-detector DEFAULT_OWN_TOP_DIRS drift guard.
  const r = await resolveConfigDir({ configDir: '/x' });
  assert.equal(r.mgrStateDir, join('/x', MGR_STATE_DIRNAME));
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

test('inventoryCommand: without --detail there is NONE of the four detail arrays (unchanged shape)', () => {
  const { result } = inventoryCommand({ configDir: MIN, args: {} });
  for (const k of ['components', 'plugins', 'marketplaces', 'mcpServers']) {
    assert.ok(!(k in result), `counts-only result must not carry a ${k} array`);
  }
});

test('inventoryCommand: --detail adds a components array sized to the total count, each {name,kind,source,description}', () => {
  const plain = inventoryCommand({ configDir: MIN, args: {} });
  const { result } = inventoryCommand({ configDir: MIN, args: { detail: true } });

  // counts are identical whether or not --detail is set
  assert.deepEqual(result.counts, plain.result.counts);

  const total = result.counts.skills + result.counts.agents + result.counts.commands;
  assert.ok(Array.isArray(result.components), 'components must be an array');
  assert.equal(result.components.length, total, 'one record per discovered skill/agent/command');

  for (const c of result.components) {
    assert.equal(typeof c.name, 'string');
    assert.ok(['skill', 'agent', 'command'].includes(c.kind), `unexpected kind: ${c.kind}`);
    assert.ok(c.source && typeof c.source === 'object', 'each record carries a source object');
    assert.equal(typeof c.source.tier, 'string', 'source.tier is present');
    assert.equal(typeof c.description, 'string', 'description is always a string (empty when absent)');
  }
});

test('inventoryCommand: --detail plugins/marketplaces arrays match the counts (plugins-groundtruth fixture)', () => {
  const { result } = inventoryCommand({ configDir: fix('plugins-groundtruth'), args: { detail: true } });

  assert.ok(Array.isArray(result.plugins), 'plugins must be an array');
  assert.equal(result.plugins.length, result.counts.plugins, 'one plugin record per counted plugin');
  for (const p of result.plugins) {
    assert.deepEqual(
      Object.keys(p).sort(),
      ['cachePresent', 'enabled', 'key', 'marketplace', 'name', 'version'],
      'plugin element carries exactly the six UI fields',
    );
    assert.equal(typeof p.name, 'string');
    assert.equal(typeof p.enabled, 'boolean');
    assert.equal(typeof p.cachePresent, 'boolean');
  }

  assert.ok(Array.isArray(result.marketplaces), 'marketplaces must be an array');
  assert.equal(result.marketplaces.length, result.counts.marketplaces, 'one marketplace record per counted marketplace');
  for (const m of result.marketplaces) {
    assert.deepEqual(
      Object.keys(m).sort(),
      ['installLocation', 'name', 'onDisk', 'sourceRepo'],
      'marketplace element carries exactly the four UI fields',
    );
    assert.equal(typeof m.name, 'string');
    assert.equal(typeof m.onDisk, 'boolean');
  }
});

test('inventoryCommand: --detail mcpServers match the count and leak NO secret/extra fields (settings-mcp fixture)', () => {
  const { result } = inventoryCommand({ configDir: fix('settings-mcp'), args: { detail: true } });

  assert.ok(Array.isArray(result.mcpServers), 'mcpServers must be an array');
  assert.equal(result.mcpServers.length, result.counts.mcpServers, 'one mcp record per counted server');
  assert.ok(result.mcpServers.length > 0, 'settings-mcp fixture is expected to expose mcp servers');

  for (const m of result.mcpServers) {
    // Exactly the five named fields — no envKeys, no env values, nothing extra.
    assert.deepEqual(
      Object.keys(m).sort(),
      ['args', 'command', 'name', 'scope', 'transport'],
      'mcp element keys must be exactly the five secret-safe UI fields',
    );
    assert.equal(typeof m.name, 'string');
    assert.ok(['stdio', 'http', 'unknown'].includes(m.transport), `unexpected transport: ${m.transport}`);
    assert.ok(!('envKeys' in m), 'envKeys must never leak into --detail output');
    assert.ok(!('url' in m), 'url is not part of the trimmed UI shape');
  }
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

test('selftestCommand: minimal/ smoke check is ok (now async)', async () => {
  const { result } = await selftestCommand({ configDir: MIN, args: {} });
  assert.equal(result.ok, true);
  assert.deepEqual(result.checks.map((c) => c.name), ['scan', 'orphans']);
});

test('selftestCommand: --lint over the mgr src is clean (no lint- errors)', async () => {
  const { result, diagnostics } = await selftestCommand({ configDir: MIN, args: { lint: true } });
  assert.ok(result.checks.some((c) => c.name === 'lint' && c.ok === true), 'expected a passing lint check');
  const lintErrors = diagnostics.filter((d) => d.severity === 'error' && d.code.startsWith('lint-'));
  assert.deepEqual(lintErrors, [], 'mgr src must currently be lint-clean');
});

test('selftestCommand: --invariants over the mgr src holds', async () => {
  const { result } = await selftestCommand({ configDir: MIN, args: { invariants: true } });
  assert.ok(result.checks.some((c) => c.name === 'invariants' && c.ok === true), 'expected a passing invariants check');
});

test('selftestCommand: --all runs smoke + lint + invariants + boundary, all ok', async () => {
  const { result } = await selftestCommand({ configDir: MIN, args: { all: true } });
  const names = result.checks.map((c) => c.name);
  for (const n of ['scan', 'orphans', 'lint', 'invariants', 'boundary']) {
    assert.ok(names.includes(n), `--all should include the ${n} check`);
  }
  assert.equal(result.ok, true, 'all checks pass over a clean tree (boundary probe is read-only)');
});

// ── H. never-throws sweep ─────────────────────────────────────────────────────────

test('every handler on a non-existent configDir does not throw + returns {result, diagnostics}', async () => {
  const GONE = fix('does-not-exist');
  for (const [name, handler] of Object.entries(COMMANDS)) {
    // Handlers are sync OR async (selftest is async); await normalizes both and
    // doesNotReject proves neither throws synchronously nor rejects.
    await assert.doesNotReject(async () => {
      const out = await handler({ configDir: GONE, args: {} });
      assert.ok(out && typeof out === 'object', `${name} returned a non-object`);
      assert.ok('result' in out, `${name} missing result`);
      assert.ok(Array.isArray(out.diagnostics), `${name} diagnostics not an array`);
    }, `${name} threw on a missing configDir`);
  }
});
