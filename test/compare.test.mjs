/**
 * Unit tests for the pure cross-target compare analysis (analyzeCompare).
 *
 * The module is pure (synthetic sides in, summary out) so it is the place the
 * comparison LOGIC is pinned: bucketing (both / X-only), dedupe, the plugin
 * name@marketplace key, determinism, and the never-throws contract. The command
 * wiring + sibling-dir resolution is exercised separately in cli-compare.test.mjs.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeCompare } from '../src/analysis/compare.mjs';

/** Build a component record. */
const comp = (kind, name) => ({ kind, name, path: `/x/${name}`, source: { tier: 'user' }, frontmatter: {} });
/** Build an mcp record. */
const mcp = (name) => ({ name, scope: 'user', transport: 'stdio' });
/** Build a plugin record. */
const plugin = (name, marketplace) => ({ key: `${name}@${marketplace}`, name, marketplace, version: '', enabled: true, cachePresent: true });

/** A side with the given components/plugins/mcp. */
const side = (id, label, { components = [], plugins = [], mcpServers = [] } = {}) => ({ id, label, components, plugins, mcpServers });

/** Find a category summary by name. */
const catOf = (summary, category) => summary.categories.find((c) => c.category === category);

// ── A. GOLDEN — overlapping + unique across every category ────────────────────

test('golden: skill buckets — shared=both, unique=X-only', () => {
  const claude = side('claude', 'Claude Code', { components: [comp('skill', 'shared'), comp('skill', 'only-cc')] });
  const codex = side('codex', 'OpenAI Codex', { components: [comp('skill', 'shared'), comp('skill', 'only-cx')] });
  const { summary } = analyzeCompare([claude, codex]);

  const skill = catOf(summary, 'skill');
  assert.equal(skill.both, 1, 'shared is the one in both');
  assert.equal(skill.totals.claude, 2);
  assert.equal(skill.totals.codex, 2);
  assert.equal(skill.only.claude, 1);
  assert.equal(skill.only.codex, 1);

  const skillItems = summary.items.filter((i) => i.category === 'skill');
  assert.deepEqual(
    skillItems.map((i) => ({ name: i.name, presence: i.presence })),
    [{ name: 'only-cc', presence: 'claude-only' }, { name: 'only-cx', presence: 'codex-only' }],
    'only the divergent skills appear in items, sorted by key; shared is NOT listed',
  );
});

test('golden: plugin keyed by name@marketplace — same name, different marketplace = distinct', () => {
  const claude = side('claude', 'Claude Code', { plugins: [plugin('foo', 'mktA')] });
  const codex = side('codex', 'OpenAI Codex', { plugins: [plugin('foo', 'mktB')] });
  const { summary } = analyzeCompare([claude, codex]);

  const pl = catOf(summary, 'plugin');
  assert.equal(pl.both, 0, 'foo@mktA and foo@mktB are NOT the same plugin');
  assert.equal(pl.only.claude, 1);
  assert.equal(pl.only.codex, 1);
  const keys = summary.items.filter((i) => i.category === 'plugin').map((i) => i.key).sort();
  assert.deepEqual(keys, ['foo@mktA', 'foo@mktB']);
});

test('golden: mcp + agent + command categories each present in the summary', () => {
  const claude = side('claude', 'Claude Code', {
    components: [comp('agent', 'a1'), comp('command', 'c1')],
    mcpServers: [mcp('m1')],
  });
  const codex = side('codex', 'OpenAI Codex', {
    components: [comp('agent', 'a1'), comp('command', 'c2')],
    mcpServers: [mcp('m2')],
  });
  const { summary } = analyzeCompare([claude, codex]);
  assert.deepEqual(summary.categories.map((c) => c.category), ['skill', 'agent', 'command', 'mcp', 'plugin']);
  assert.equal(catOf(summary, 'agent').both, 1, 'a1 in both');
  assert.equal(catOf(summary, 'command').both, 0, 'c1 vs c2 diverge');
  assert.equal(catOf(summary, 'mcp').only.codex, 1, 'm2 codex-only');
});

test('golden: per-target total = distinct keys summed across categories', () => {
  const claude = side('claude', 'Claude Code', {
    components: [comp('skill', 's1'), comp('agent', 'a1')],
    mcpServers: [mcp('m1')],
    plugins: [plugin('p1', 'mkt')],
  });
  const codex = side('codex', 'OpenAI Codex', {});
  const { summary } = analyzeCompare([claude, codex]);
  const cc = summary.targets.find((t) => t.id === 'claude');
  assert.equal(cc.total, 4, '1 skill + 1 agent + 1 mcp + 1 plugin');
  assert.equal(summary.targets.find((t) => t.id === 'codex').total, 0);
});

// ── B. BENIGN — identical sides → all shared, zero divergence ─────────────────

test('benign: identical sides → every category both, items empty', () => {
  const mk = (id) => side(id, id, { components: [comp('skill', 's')], mcpServers: [mcp('m')] });
  const { summary } = analyzeCompare([mk('claude'), mk('codex')]);
  assert.equal(catOf(summary, 'skill').both, 1);
  assert.equal(catOf(summary, 'mcp').both, 1);
  assert.equal(summary.items.length, 0, 'nothing diverges → no items');
});

// ── C. DEDUPE — a name twice on one side counts once ──────────────────────────

test('dedupe: same skill name twice on one side is counted once', () => {
  const claude = side('claude', 'Claude Code', { components: [comp('skill', 'dup'), comp('skill', 'dup')] });
  const codex = side('codex', 'OpenAI Codex', {});
  const { summary } = analyzeCompare([claude, codex]);
  assert.equal(catOf(summary, 'skill').totals.claude, 1, 'distinct names only');
  assert.equal(catOf(summary, 'skill').only.claude, 1);
});

// ── D. DETERMINISM ────────────────────────────────────────────────────────────

test('determinism: two runs of the same input are deepEqual', () => {
  const claude = side('claude', 'Claude Code', { components: [comp('skill', 'z'), comp('skill', 'a'), comp('skill', 'm')] });
  const codex = side('codex', 'OpenAI Codex', { components: [comp('skill', 'b')] });
  const a = analyzeCompare([claude, codex]);
  const b = analyzeCompare([claude, codex]);
  assert.deepEqual(a, b);
  // items sorted by key within the skill category
  const names = a.summary.items.filter((i) => i.category === 'skill').map((i) => i.name);
  assert.deepEqual(names, ['a', 'b', 'm', 'z']);
});

// ── E. CAVEAT — name match is not a content match ─────────────────────────────

test('caveat: emits compare-name-match-not-content (info)', () => {
  const { diagnostics } = analyzeCompare([side('claude', 'c'), side('codex', 'x')]);
  const c = diagnostics.find((d) => d.code === 'compare-name-match-not-content');
  assert.ok(c, 'the honesty caveat is always present');
  assert.equal(c.severity, 'info');
});

// ── F. BOUNDARY — never throws on junk input ──────────────────────────────────

test('never-throws: junk inputs return a sane empty-ish summary', () => {
  for (const junk of [undefined, null, 42, 'x', {}, [], [null, 1, 'y'], [{}], [{ id: 5, components: 'no' }]]) {
    assert.doesNotThrow(() => {
      const { summary, diagnostics } = analyzeCompare(junk);
      assert.ok(Array.isArray(summary.targets));
      assert.ok(Array.isArray(summary.categories));
      assert.ok(Array.isArray(summary.items));
      assert.ok(Array.isArray(diagnostics));
    }, `threw on input: ${JSON.stringify(junk)}`);
  }
});

test('boundary: non-string / empty component names are skipped (never a key)', () => {
  const claude = side('claude', 'Claude Code', {
    components: [comp('skill', ''), { kind: 'skill', name: 123 }, comp('skill', 'real')],
  });
  const { summary } = analyzeCompare([claude, side('codex', 'codex')]);
  assert.equal(catOf(summary, 'skill').totals.claude, 1, 'only "real" counts');
});

test('boundary: a single side → everything is "both" (degenerate, no divergence)', () => {
  const { summary } = analyzeCompare([side('claude', 'Claude Code', { components: [comp('skill', 's')] })]);
  assert.equal(catOf(summary, 'skill').both, 1);
  assert.equal(summary.items.length, 0);
});
