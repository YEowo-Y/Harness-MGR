/**
 * codex-coexistence.test.mjs (P6 — codex multi-source scan).
 *
 * Falsifiable oracles for analysis/codex-coexistence.mjs:
 *   - targetModelsShadowing: the single source for "does this target shadow?" — true
 *     for Claude/default/unknown, FALSE for codex (same-name components coexist).
 *   - analyzeCoexistence: groups by (kind, name); >= 2 sources → a co-existence cluster
 *     (no winner) with provenance, deterministically ordered; never throws.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeCoexistence, targetModelsShadowing } from '../src/analysis/codex-coexistence.mjs';

const skill = (name, src, path) => ({ kind: 'skill', name, path: path ?? `/p/${name}`, source: src, frontmatter: {} });
const user = { tier: 'user' };
const plugin = (p, m) => ({ tier: 'plugin', plugin: p, marketplace: m });

// ── targetModelsShadowing ─────────────────────────────────────────────────────

test('targetModelsShadowing: claude/default/unknown → true; codex → false', () => {
  assert.equal(targetModelsShadowing({ id: 'claude' }), true);
  assert.equal(targetModelsShadowing(undefined), true);
  assert.equal(targetModelsShadowing(null), true);
  assert.equal(targetModelsShadowing({ id: 'something-else' }), true);
  assert.equal(targetModelsShadowing({ id: 'codex' }), false);
});

// ── analyzeCoexistence ────────────────────────────────────────────────────────

test('non-array input → empty + bad-input diagnostic, never throws', () => {
  const r = analyzeCoexistence(/** @type {any} */ (null));
  assert.deepEqual(r.coexistence, []);
  assert.equal(r.diagnostics.some((d) => d.code === 'coexistence-bad-input'), true);
});

test('a single source per name is NOT co-existence', () => {
  const r = analyzeCoexistence([skill('alpha', user), skill('beta', plugin('gh', 'mkt'), '/x/beta')]);
  assert.deepEqual(r.coexistence, []);
});

test('headline golden: home + two plugin marketplaces of the same name → one cluster (no winner)', () => {
  const comps = [
    skill('gh-fix-ci', user, '/home/skills/gh-fix-ci/SKILL.md'),
    skill('gh-fix-ci', plugin('github', 'openai-curated'), '/c/oc/gh-fix-ci/SKILL.md'),
    skill('gh-fix-ci', plugin('github', 'openai-curated-remote'), '/c/ocr/gh-fix-ci/SKILL.md'),
    skill('solo', user, '/home/skills/solo/SKILL.md'), // unique — excluded
  ];
  const r = analyzeCoexistence(comps);
  assert.deepEqual(r.coexistence, [
    {
      kind: 'skill',
      name: 'gh-fix-ci',
      count: 3,
      sources: [
        // sorted by (tier, marketplace, plugin, path): plugin entries first (tier 'plugin' < 'user'),
        // then by marketplace, then the user (home) copy last.
        { tier: 'plugin', plugin: 'github', marketplace: 'openai-curated', path: '/c/oc/gh-fix-ci/SKILL.md' },
        { tier: 'plugin', plugin: 'github', marketplace: 'openai-curated-remote', path: '/c/ocr/gh-fix-ci/SKILL.md' },
        { tier: 'user', path: '/home/skills/gh-fix-ci/SKILL.md' },
      ],
    },
  ]);
});

test('different kinds with the same name are NOT grouped together', () => {
  const comps = [
    skill('dup', user, '/a'),
    { kind: 'command', name: 'dup', path: '/b', source: user, frontmatter: {} },
  ];
  // Each (kind, name) has a single member → no co-existence.
  assert.deepEqual(analyzeCoexistence(comps).coexistence, []);
});

test('deterministic order: clusters sorted by (kind, name)', () => {
  const comps = [
    skill('zeta', plugin('p', 'a'), '/1'), skill('zeta', plugin('p', 'b'), '/2'),
    { kind: 'agent', name: 'alpha', path: '/3', source: plugin('p', 'a'), frontmatter: {} },
    { kind: 'agent', name: 'alpha', path: '/4', source: plugin('p', 'b'), frontmatter: {} },
  ];
  const r = analyzeCoexistence(comps);
  assert.deepEqual(r.coexistence.map((c) => `${c.kind}:${c.name}`), ['agent:alpha', 'skill:zeta']);
});

test('never throws on malformed members; bad members skipped, good ones grouped', () => {
  const comps = [
    null,
    { kind: 'skill' }, // missing name
    { name: 'x' }, // missing kind
    skill('ok', plugin('p', 'a'), '/1'),
    skill('ok', plugin('p', 'b'), '/2'),
    skill('ok', { /* malformed source */ }, '/3'),
  ];
  const r = analyzeCoexistence(/** @type {any} */ (comps));
  const cl = r.coexistence.find((c) => c.name === 'ok');
  assert.ok(cl);
  assert.equal(cl.count, 3);
  // the malformed-source member defaults to tier 'user'
  assert.equal(cl.sources.some((s) => s.tier === 'user'), true);
});

test('proto-safe: a component named __proto__ does not pollute Object.prototype', () => {
  const comps = [skill('__proto__', plugin('p', 'a'), '/1'), skill('__proto__', plugin('p', 'b'), '/2')];
  const r = analyzeCoexistence(comps);
  assert.equal(({}).polluted, undefined);
  assert.equal(r.coexistence.length, 1);
  assert.equal(r.coexistence[0].name, '__proto__');
});
