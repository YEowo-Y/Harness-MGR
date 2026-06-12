/**
 * Tests for src/analysis/disposition.mjs (P5.U10) — conflict-disposition advice.
 *
 * GOLDEN (the DoD headline): synthetic conflict clusters → deepEqual of the
 * ENTIRE { dispositions, summary } (or the single record) against a hand-written
 * LITERAL — pinning winner/shadowed mapping, removability, the exact
 * removeCommand, the ruleId/docUrl citation by kind, the templated suggestion
 * sentence, and the deterministic (kind,key)/path sorts. The literals copy the
 * bundled pack's docUrls, so an unreviewed citation edit also goes RED.
 *
 * Mirrors test/advice.test.mjs (pure, hermetic, falsifiable goldens, never bare
 * "exit 0"). The rules seam is exercised via the bundled pack (real citations)
 * and an injected pack (hermetic isolation + the docUrl-fallback leg).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { analyzeDisposition } from '../src/analysis/disposition.mjs';
import pack from '../src/config/best-practice-rules.json' with { type: 'json' };

// ── tiny synthetic-member builders (mirror conflicts.test.mjs) ────────────────
/** A conflict member with an explicit path + source. */
const member = (name, path, source) => ({ name, path, source });
/** A user-tier member. */
const userM = (name, path) => member(name, path, { tier: 'user' });
/** A plugin-tier member (tier 'plugin' + plugin name). */
const pluginM = (name, path, plugin) => member(name, path, { tier: 'plugin', plugin });

/** Build a cluster from kind/key + a ranked members array (likelyWinner = ranked[0]). */
function cluster(kind, key, ranked) {
  return { kind, key, confidence: 'likely', severity: 'warn', likelyWinner: ranked[0], possibleWinners: ranked };
}

// docUrls pulled from the LIVE pack so a citation edit is caught (golden lock-in).
const AGENT_DOC = pack.rules.find((r) => r.id === 'advice-agent-shadowing').docUrl;
const AGENT_VER = pack.rules.find((r) => r.id === 'advice-agent-shadowing').docVersion;
const COMP_DOC = pack.rules.find((r) => r.id === 'advice-component-shadowing').docUrl;
const COMP_VER = pack.rules.find((r) => r.id === 'advice-component-shadowing').docVersion;

// ── GOLDEN 1: 3-member user-tier agent cluster ────────────────────────────────

test('GOLDEN: user-tier agent cluster → both losers removable with exact remove command + agent citation', () => {
  const ranked = [
    userM('executor', '/cfg/agents/executor.md'),
    userM('executor', '/cfg/agents/dupA.md'),
    userM('executor', '/cfg/agents/dupB.md'),
  ];
  const r = analyzeDisposition({ conflicts: [cluster('agent', 'executor', ranked)] });
  assert.deepEqual(r, {
    dispositions: [{
      kind: 'agent', key: 'executor', severity: 'warn',
      winner: { name: 'executor', path: '/cfg/agents/executor.md', tier: 'user', plugin: null },
      shadowed: [
        { name: 'executor', path: '/cfg/agents/dupA.md', tier: 'user', plugin: null, removable: true, removeCommand: 'remove agent:executor' },
        { name: 'executor', path: '/cfg/agents/dupB.md', tier: 'user', plugin: null, removable: true, removeCommand: 'remove agent:executor' },
      ],
      suggestion: 'The loader keeps /cfg/agents/executor.md; 2 shadowed copies not loaded. Remove a shadowed user-tier copy: `remove agent:executor`. (See ' + AGENT_DOC + '.)',
      ruleId: 'advice-agent-shadowing',
      docUrl: AGENT_DOC, docVersion: AGENT_VER,
    }],
    summary: { clusters: 1, removableLosers: 2, advisoryLosers: 0 },
    diagnostics: [],
  });
  // Citation joins to the sub-agents page (NOT the skills page).
  assert.match(r.dispositions[0].docUrl, /\/sub-agents$/);
});

// ── GOLDEN 2: plugin-tier loser → advisory, no remove command ─────────────────

test('GOLDEN: plugin-tier shadowed loser → removable:false, removeCommand:null, suggestion names the plugin (no remove token)', () => {
  const ranked = [
    pluginM('deploy', '/cache/foo/skills/deploy', 'foo'),
    pluginM('deploy', '/cache/foo2/skills/deploy', 'foo'),
  ];
  const r = analyzeDisposition({ conflicts: [cluster('skill', 'foo:deploy', ranked)] });
  const d = r.dispositions[0];
  assert.equal(d.shadowed.length, 1);
  assert.equal(d.shadowed[0].removable, false);
  assert.equal(d.shadowed[0].removeCommand, null);
  // names the plugin and contains NO `remove ` command token
  assert.match(d.suggestion, /plugin\(s\) foo/);
  assert.doesNotMatch(d.suggestion, /remove /);
  assert.equal(r.summary.removableLosers, 0);
  assert.equal(r.summary.advisoryLosers, 1);
});

// ── GOLDEN 3: mixed cluster (user + plugin losers) ────────────────────────────

test('mixed cluster: only the user-tier loser is removable; summary tallies both kinds', () => {
  const ranked = [
    userM('helper', '/cfg/agents/helper.md'),         // winner
    userM('helper', '/cfg/agents/helper-dup.md'),     // user loser → removable
    pluginM('helper', '/cache/p/agents/helper.md', 'p'), // plugin loser → advisory
  ];
  const r = analyzeDisposition({ conflicts: [cluster('agent', 'helper', ranked)] });
  const d = r.dispositions[0];
  // shadowed sorted by path: helper-dup.md before /cache/...? compare code-units:
  // '/cache/p/agents/helper.md' < '/cfg/agents/helper-dup.md' → plugin first.
  assert.deepEqual(d.shadowed.map((s) => s.path), ['/cache/p/agents/helper.md', '/cfg/agents/helper-dup.md']);
  const removable = d.shadowed.filter((s) => s.removable);
  assert.equal(removable.length, 1);
  assert.equal(removable[0].removeCommand, 'remove agent:helper');
  // at least one removable loser → the suggestion offers the remove command
  assert.match(d.suggestion, /`remove agent:helper`/);
  assert.deepEqual(r.summary, { clusters: 1, removableLosers: 1, advisoryLosers: 1 });
});

// ── GOLDEN 4: skill cluster → component-shadowing citation (skills page) ───────

test('skill cluster → ruleId advice-component-shadowing, docUrl .../skills', () => {
  const ranked = [userM('build', '/cfg/skills/build/SKILL.md'), userM('build', '/cfg/skills/build2/SKILL.md')];
  const r = analyzeDisposition({ conflicts: [cluster('skill', 'build', ranked)] });
  assert.equal(r.dispositions[0].ruleId, 'advice-component-shadowing');
  assert.equal(r.dispositions[0].docUrl, COMP_DOC);
  assert.equal(r.dispositions[0].docVersion, COMP_VER);
  assert.match(r.dispositions[0].docUrl, /\/skills$/);
});

test('command cluster also cites advice-component-shadowing (not the agent rule)', () => {
  const ranked = [userM('lint', '/cfg/commands/lint.md'), userM('lint', '/cfg/commands/lint2.md')];
  const r = analyzeDisposition({ conflicts: [cluster('command', 'lint', ranked)] });
  assert.equal(r.dispositions[0].ruleId, 'advice-component-shadowing');
  assert.match(r.dispositions[0].docUrl, /\/skills$/);
});

// ── citation fallback (injected pack missing the rule) ────────────────────────

test('rules seam: a pack WITHOUT the matching rule → ruleId still set, docUrl/docVersion null', () => {
  const r = analyzeDisposition({
    conflicts: [cluster('agent', 'x', [userM('x', '/a.md'), userM('x', '/b.md')])],
    rules: [], // injected empty pack: no advice-agent-shadowing
  });
  const d = r.dispositions[0];
  assert.equal(d.ruleId, 'advice-agent-shadowing');
  assert.equal(d.docUrl, null);
  assert.equal(d.docVersion, null);
  // suggestion still produced, WITHOUT the "(See ...)" parenthetical
  assert.match(d.suggestion, /Remove a shadowed user-tier copy/);
  assert.doesNotMatch(d.suggestion, /\(See /);
});

// ── singular pluralization ─────────────────────────────────────────────────────

test('pluralization: one shadowed copy uses "copy", not "copies"', () => {
  const r = analyzeDisposition({ conflicts: [cluster('agent', 'solo', [userM('solo', '/w.md'), userM('solo', '/l.md')])] });
  assert.match(r.dispositions[0].suggestion, /1 shadowed copy not loaded/);
});

// ── empty + determinism ─────────────────────────────────────────────────────────

test('empty conflicts → empty dispositions + zeroed summary', () => {
  assert.deepEqual(analyzeDisposition({ conflicts: [] }), {
    dispositions: [], summary: { clusters: 0, removableLosers: 0, advisoryLosers: 0 }, diagnostics: [],
  });
});

test('determinism: clusters fed out of order → output sorted by (kind, key); shadowed sorted by path', () => {
  const skl = cluster('skill', 'zeta', [userM('zeta', '/cfg/skills/zeta/SKILL.md'), userM('zeta', '/cfg/skills/zeta2/SKILL.md')]);
  const agtB = cluster('agent', 'beta', [userM('beta', '/cfg/agents/beta.md'), userM('beta', '/z.md'), userM('beta', '/a.md')]);
  const agtA = cluster('agent', 'alpha', [userM('alpha', '/cfg/agents/alpha.md'), userM('alpha', '/m.md')]);
  const r = analyzeDisposition({ conflicts: [skl, agtB, agtA] });
  // (kind,key): agent<skill; alpha<beta → agent:alpha, agent:beta, skill:zeta
  assert.deepEqual(r.dispositions.map((d) => `${d.kind}:${d.key}`), ['agent:alpha', 'agent:beta', 'skill:zeta']);
  // beta's shadowed sorted by path: '/a.md' < '/z.md'
  const beta = r.dispositions.find((d) => d.key === 'beta');
  assert.deepEqual(beta.shadowed.map((s) => s.path), ['/a.md', '/z.md']);
});

test('determinism: twice → deepEqual; frozen input not mutated', () => {
  const input = Object.freeze({ conflicts: Object.freeze([cluster('agent', 'x', [Object.freeze(userM('x', '/w.md')), Object.freeze(userM('x', '/l.md'))])]) });
  const snap = structuredClone(input);
  assert.deepEqual(analyzeDisposition(input), analyzeDisposition(input));
  assert.deepEqual(input, snap);
});

// ── never-throws battery ─────────────────────────────────────────────────────────

test('never-throws: junk top-level + malformed clusters degrade to a safe result', () => {
  const empty = { dispositions: [], summary: { clusters: 0, removableLosers: 0, advisoryLosers: 0 }, diagnostics: [] };
  assert.deepEqual(analyzeDisposition(), empty);
  assert.deepEqual(analyzeDisposition(null), empty);
  assert.deepEqual(analyzeDisposition({}), empty);
  assert.deepEqual(analyzeDisposition({ conflicts: 'nope' }), empty);
  assert.deepEqual(analyzeDisposition({ conflicts: 42 }), empty);
  // a cluster MISSING possibleWinners still has a likelyWinner → 0 shadowed, no throw
  const noLosers = analyzeDisposition({ conflicts: [{ kind: 'agent', key: 'k', severity: 'warn', likelyWinner: userM('k', '/w.md') }] });
  assert.equal(noLosers.dispositions.length, 1);
  assert.deepEqual(noLosers.dispositions[0].shadowed, []);
  // a cluster with NO likelyWinner is skipped (malformed)
  assert.deepEqual(analyzeDisposition({ conflicts: [{ kind: 'agent', key: 'k', possibleWinners: [userM('k', '/a.md')] }] }).dispositions, []);
  // junk cluster entries skipped; valid one survives
  const mixed = analyzeDisposition({ conflicts: [null, 7, 'x', {}, cluster('agent', 'ok', [userM('ok', '/w.md'), userM('ok', '/l.md')])] });
  assert.deepEqual(mixed.dispositions.map((d) => d.key), ['ok']);
  // hostile throwing getter → backstopped empty result, not a throw
  const hostile = {};
  Object.defineProperty(hostile, 'conflicts', { get() { throw new Error('boom'); } });
  assert.deepEqual(analyzeDisposition(hostile), empty);
});

test('member with no source / no name → undefined fields, not removable, no throw', () => {
  const ranked = [{ name: 'w', path: '/w.md', source: { tier: 'user' } }, { path: '/l.md' }, { name: 'x' }];
  const r = analyzeDisposition({ conflicts: [cluster('agent', 'w', ranked)] });
  const shadowed = r.dispositions[0].shadowed;
  // neither loser is user-tier → neither removable
  assert.equal(shadowed.every((s) => s.removable === false), true);
  assert.equal(shadowed.every((s) => s.removeCommand === null), true);
});
