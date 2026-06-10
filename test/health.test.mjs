/**
 * Tests for src/analysis/health.mjs (P5.U2 — the loadability view).
 *
 * GOLDEN: the real scan()+analyzeConflicts pipeline over the committed
 * doctor-clean fixture test/fixtures/real-snapshot → analyzeHealth, deepEqual
 * against a hand-written LITERAL golden (the I/O lives in the TEST; the module
 * under test stays pure).
 *
 * CONFLICT-leg caveat (verified empirically before writing these tests):
 * scan() walks ONLY the user tier (plugins/cache is never walked), so the
 * committed test/fixtures/conflict tree yields ZERO ConflictCluster via the
 * real pipeline — its agent collision lives in plugins/cache. That fact is
 * PINNED below (so a future scan() that starts walking plugin caches surfaces
 * here), and the not-loaded/degraded shadowing legs are driven by SYNTHETIC
 * ComponentRecords + a synthetic ConflictCluster, exactly like the doctor #11
 * tests do.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { analyzeHealth, HEALTH_STATUSES } from '../src/analysis/health.mjs';
import { scan } from '../src/discovery/scan.mjs';
import { analyzeConflicts } from '../src/analysis/conflicts.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fix = (rel) => join(here, 'fixtures', rel);

// ── helpers ───────────────────────────────────────────────────────────────────

const comp = (kind, name, path, tier = 'user') => ({ kind, name, path, source: { tier }, frontmatter: {} });

/** A synthetic plugin-vs-plugin skill cluster mirroring the analyzeConflicts output shape. */
function syntheticCluster() {
  const winner = {
    name: 'deploy',
    path: '/u/.claude/plugins/cache/m1/sup/1.0.0/skills/deploy/SKILL.md',
    source: { tier: 'plugin', plugin: 'sup', marketplace: 'm1' },
  };
  const loser = {
    name: 'deploy',
    path: '/u/.claude/plugins/cache/m2/sup/1.0.0/skills/deploy/SKILL.md',
    source: { tier: 'plugin', plugin: 'sup', marketplace: 'm2' },
  };
  return {
    winner,
    loser,
    cluster: {
      kind: 'skill',
      key: 'sup:deploy',
      confidence: 'likely',
      severity: 'warn',
      likelyWinner: winner,
      possibleWinners: [winner, loser],
      reason: 'plugin "sup" is installed from 2 marketplaces (m1, m2); each provides skill "deploy" — only the first-loaded wins',
      fix: 'disable one of the conflicting plugin installs, or they will shadow each other',
    },
  };
}

function deepFreeze(v) {
  if (v && typeof v === 'object') {
    for (const k of Object.keys(v)) deepFreeze(v[k]);
    Object.freeze(v);
  }
  return v;
}

// ── A. GOLDEN: real pipeline over the committed doctor-clean fixture ──────────

test('golden: real-snapshot via the REAL scan+conflicts pipeline → literal {summary, groups}', () => {
  const s = scan({ targetClaudeDir: fix('real-snapshot') });
  const c = analyzeConflicts(s.components);
  const r = analyzeHealth({ components: s.components, conflicts: c.conflicts, diagnostics: s.diagnostics });

  // Hand-written LITERAL golden — never computed.
  const golden = {
    summary: { total: 3, loadable: 3, degraded: 0, notLoaded: 0 },
    groups: [
      { scope: 'user', kind: 'agent', status: 'loadable', count: 1, names: ['synthetic-helper'] },
      { scope: 'user', kind: 'command', status: 'loadable', count: 1, names: ['synthetic-greet'] },
      { scope: 'user', kind: 'skill', status: 'loadable', count: 1, names: ['hello-skill'] },
    ],
  };
  assert.deepEqual({ summary: r.summary, groups: r.groups }, golden);
  assert.ok(r.components.every((rec) => rec.status === 'loadable'), 'fixture is doctor-clean: every record loadable');
  assert.deepEqual(r.diagnostics, []);
});

test('golden: real-snapshot records are (kind,name,path)-sorted with null worstSeverity and no reasons', () => {
  const s = scan({ targetClaudeDir: fix('real-snapshot') });
  const r = analyzeHealth({ components: s.components, conflicts: analyzeConflicts(s.components).conflicts, diagnostics: s.diagnostics });
  assert.deepEqual(r.components.map((rec) => [rec.kind, rec.name]),
    [['agent', 'synthetic-helper'], ['command', 'synthetic-greet'], ['skill', 'hello-skill']]);
  for (const rec of r.components) {
    assert.equal(rec.scope, 'user');
    assert.equal(rec.worstSeverity, null);
    assert.deepEqual(rec.reasons, []);
  }
});

// ── B. CONFLICT fixture: the real pipeline yields ZERO clusters (pinned caveat) ──

test('conflict fixture: real pipeline produces no clusters (scan walks only the user tier) → all loadable', () => {
  const s = scan({ targetClaudeDir: fix('conflict') });
  const c = analyzeConflicts(s.components);
  // PINNED: the fixture's collision lives in plugins/cache, which scan() never
  // walks. If this ever flips, the synthetic legs below should be revisited.
  assert.equal(c.conflicts.length, 0);
  const r = analyzeHealth({ components: s.components, conflicts: c.conflicts, diagnostics: s.diagnostics });
  assert.equal(r.summary.total, 2);
  assert.equal(r.summary.loadable, 2);
  assert.equal(r.summary.notLoaded, 0);
});

// ── C. Shadowing legs (synthetic, like the doctor #11 tests) ──────────────────

test('shadowed loser → not-loaded; reason names the winner, keeps warn severity (status asymmetry)', () => {
  const { winner, loser, cluster } = syntheticCluster();
  const components = [comp('skill', winner.name, winner.path, 'plugin'), comp('skill', loser.name, loser.path, 'plugin')];
  const r = analyzeHealth({ components, conflicts: [cluster] });

  const lost = r.components.find((rec) => rec.path === loser.path);
  assert.equal(lost.status, 'not-loaded');
  assert.equal(lost.reasons.length, 1);
  assert.equal(lost.reasons[0].code, 'skill-shadowing');
  assert.equal(lost.reasons[0].severity, 'warn'); // the cluster's own severity, NOT escalated
  assert.match(lost.reasons[0].message, /shadowed by 'deploy' \(\/u\/\.claude\/plugins\/cache\/m1\/sup\/1\.0\.0\/skills\/deploy\/SKILL\.md\)/);
  assert.match(lost.reasons[0].message, /confidence likely/);
  assert.equal(lost.worstSeverity, 'warn');
});

test('likelyWinner → degraded with <kind>-shadowing-winner naming the shadow count', () => {
  const { winner, loser, cluster } = syntheticCluster();
  const components = [comp('skill', winner.name, winner.path, 'plugin'), comp('skill', loser.name, loser.path, 'plugin')];
  const r = analyzeHealth({ components, conflicts: [cluster] });

  const won = r.components.find((rec) => rec.path === winner.path);
  assert.equal(won.status, 'degraded');
  assert.equal(won.reasons.length, 1);
  assert.equal(won.reasons[0].code, 'skill-shadowing-winner');
  assert.equal(won.reasons[0].severity, 'warn');
  assert.match(won.reasons[0].message, /loads but shadows 1 other\(s\); confidence likely/);
  assert.deepEqual(r.summary, { total: 2, loadable: 0, degraded: 1, notLoaded: 1 });
});

test('cluster of a DIFFERENT kind never attaches (same path, kind mismatch → loadable)', () => {
  const { loser, cluster } = syntheticCluster();
  // Same paths, but the components are agents — the skill cluster must not match.
  const components = [comp('agent', 'deploy', loser.path)];
  const r = analyzeHealth({ components, conflicts: [cluster] });
  assert.equal(r.components[0].status, 'loadable');
  assert.deepEqual(r.components[0].reasons, []);
});

test('degenerate single-member cluster is guarded out (doctor #11 mirror)', () => {
  const { winner, cluster } = syntheticCluster();
  const single = { ...cluster, possibleWinners: [winner] };
  const r = analyzeHealth({ components: [comp('skill', winner.name, winner.path, 'plugin')], conflicts: [single] });
  assert.equal(r.components[0].status, 'loadable');
  assert.deepEqual(r.components[0].reasons, []);
});

// ── D. Severity legs (path-attached diagnostics) ──────────────────────────────

test('warn diagnostic at the exact component path → degraded', () => {
  const r = analyzeHealth({
    components: [comp('agent', 'a', '/cfg/agents/a.md')],
    diagnostics: [{ severity: 'warn', code: 'frontmatter-odd', message: 'odd frontmatter', path: '/cfg/agents/a.md', phase: 'components' }],
  });
  assert.equal(r.components[0].status, 'degraded');
  assert.deepEqual(r.components[0].reasons, [{ code: 'frontmatter-odd', severity: 'warn', message: 'odd frontmatter' }]);
  assert.equal(r.components[0].worstSeverity, 'warn');
});

test('error diagnostic at the exact component path → not-loaded', () => {
  const r = analyzeHealth({
    components: [comp('agent', 'a', '/cfg/agents/a.md')],
    diagnostics: [{ severity: 'error', code: 'component-unreadable', message: 'cannot read', path: '/cfg/agents/a.md' }],
  });
  assert.equal(r.components[0].status, 'not-loaded');
  assert.equal(r.components[0].worstSeverity, 'error');
  assert.deepEqual(r.summary, { total: 1, loadable: 0, degraded: 0, notLoaded: 1 });
});

test('info diagnostic → still loadable, but the reason is recorded with worstSeverity info', () => {
  const r = analyzeHealth({
    components: [comp('agent', 'a', '/cfg/agents/a.md')],
    diagnostics: [{ severity: 'info', code: 'note', message: 'fyi', path: '/cfg/agents/a.md' }],
  });
  assert.equal(r.components[0].status, 'loadable');
  assert.deepEqual(r.components[0].reasons, [{ code: 'note', severity: 'info', message: 'fyi' }]);
  assert.equal(r.components[0].worstSeverity, 'info');
});

test('diagnostic at a NON-matching path is ignored entirely (exact string equality, no normalization)', () => {
  const r = analyzeHealth({
    components: [comp('agent', 'a', '/cfg/agents/a.md')],
    diagnostics: [
      { severity: 'error', code: 'x', message: 'foreign', path: '/cfg/agents/OTHER.md' },
      { severity: 'error', code: 'x', message: 'case-differs', path: '/CFG/agents/a.md' },
      { severity: 'error', code: 'x', message: 'no path at all' },
      // Overlapping paths pin the EXACT-equality contract: a substring/superstring
      // match regression must attach one of these and turn this test RED.
      { severity: 'error', code: 'x', message: 'superstring', path: '/cfg/agents/a.md.bak' },
      { severity: 'error', code: 'x', message: 'substring', path: '/cfg/agents/a.m' },
    ],
  });
  assert.equal(r.components[0].status, 'loadable');
  assert.deepEqual(r.components[0].reasons, []);
  assert.equal(r.components[0].worstSeverity, null);
});

// ── E. doctorDiagnostics channel ──────────────────────────────────────────────

test('a doctor-sourced error at the component path also drives not-loaded (both channels honored)', () => {
  const r = analyzeHealth({
    components: [comp('skill', 's', '/cfg/skills/s/SKILL.md')],
    doctorDiagnostics: [{ severity: 'error', code: 'doctor-finding', message: 'broken', path: '/cfg/skills/s/SKILL.md' }],
  });
  assert.equal(r.components[0].status, 'not-loaded');
  assert.deepEqual(r.components[0].reasons, [{ code: 'doctor-finding', severity: 'error', message: 'broken' }]);
});

test('identical reason arriving via BOTH channels is attached once (dedupe)', () => {
  const d = { severity: 'warn', code: 'dup', message: 'same', path: '/p/a.md' };
  const r = analyzeHealth({ components: [comp('agent', 'a', '/p/a.md')], diagnostics: [d], doctorDiagnostics: [{ ...d }] });
  assert.equal(r.components[0].reasons.length, 1);
});

// ── F. Reason ordering / combination ──────────────────────────────────────────

test('reasons sorted by severity rank (error first) then code; worstSeverity is the highest', () => {
  const p = '/p/a.md';
  const r = analyzeHealth({
    components: [comp('agent', 'a', p)],
    diagnostics: [
      { severity: 'info', code: 'c-info', message: 'i', path: p },
      { severity: 'warn', code: 'z-warn', message: 'w2', path: p },
      { severity: 'warn', code: 'a-warn', message: 'w1', path: p },
      { severity: 'error', code: 'b-err', message: 'e', path: p },
    ],
  });
  assert.deepEqual(r.components[0].reasons.map((x) => x.code), ['b-err', 'a-warn', 'z-warn', 'c-info']);
  assert.equal(r.components[0].worstSeverity, 'error');
  assert.equal(r.components[0].status, 'not-loaded');
});

test('shadowed loser + attached error → not-loaded with BOTH reasons, worstSeverity error', () => {
  const { winner, loser, cluster } = syntheticCluster();
  const r = analyzeHealth({
    components: [comp('skill', loser.name, loser.path, 'plugin'), comp('skill', winner.name, winner.path, 'plugin')],
    conflicts: [cluster],
    diagnostics: [{ severity: 'error', code: 'unreadable', message: 'nope', path: loser.path }],
  });
  const lost = r.components.find((rec) => rec.path === loser.path);
  assert.equal(lost.status, 'not-loaded');
  assert.deepEqual(lost.reasons.map((x) => x.code), ['unreadable', 'skill-shadowing']);
  assert.equal(lost.worstSeverity, 'error');
});

// ── G. scope (tier mirror) ────────────────────────────────────────────────────

test('scope falls back to user for a missing source or an invalid tier; valid tiers pass through', () => {
  const r = analyzeHealth({
    components: [
      { kind: 'agent', name: 'no-source', path: '/p/1' },
      { kind: 'agent', name: 'bad-tier', path: '/p/2', source: { tier: 'bogus' } },
      { kind: 'agent', name: 'mc', path: '/p/3', source: { tier: 'marketplace-copy' } },
      { kind: 'agent', name: 'plug', path: '/p/4', source: { tier: 'plugin', plugin: 'x' } },
    ],
  });
  assert.deepEqual(r.components.map((rec) => [rec.name, rec.scope]),
    [['bad-tier', 'user'], ['mc', 'marketplace-copy'], ['no-source', 'user'], ['plug', 'plugin']]);
});

// ── H. Grouping ───────────────────────────────────────────────────────────────

test('groups: mixed scopes×kinds×statuses → exact non-empty groups in pinned order', () => {
  const r = analyzeHealth({
    components: [
      comp('agent', 'a1', '/p/a1', 'plugin'),
      comp('agent', 'a0', '/p/a0', 'plugin'),
      comp('agent', 'a2', '/p/a2', 'plugin'), // not-loaded via error
      comp('skill', 's3', '/p/s3', 'plugin'),
      comp('agent', 'a3', '/p/a3', 'user'),
      comp('skill', 's1', '/p/s1', 'user'),
      comp('skill', 's2', '/p/s2', 'user'),  // degraded via warn
    ],
    diagnostics: [
      { severity: 'error', code: 'e', message: 'broken', path: '/p/a2' },
      { severity: 'warn', code: 'w', message: 'odd', path: '/p/s2' },
    ],
  });
  assert.deepEqual(r.groups, [
    { scope: 'plugin', kind: 'agent', status: 'loadable', count: 2, names: ['a0', 'a1'] },
    { scope: 'plugin', kind: 'agent', status: 'not-loaded', count: 1, names: ['a2'] },
    { scope: 'plugin', kind: 'skill', status: 'loadable', count: 1, names: ['s3'] },
    { scope: 'user', kind: 'agent', status: 'loadable', count: 1, names: ['a3'] },
    { scope: 'user', kind: 'skill', status: 'loadable', count: 1, names: ['s1'] },
    { scope: 'user', kind: 'skill', status: 'degraded', count: 1, names: ['s2'] },
  ]);
  assert.deepEqual(r.summary, { total: 7, loadable: 5, degraded: 1, notLoaded: 1 });
});

// ── I. Determinism + no input mutation ────────────────────────────────────────

test('determinism: same input twice → deepEqual; deep-frozen input does not throw (no mutation)', () => {
  const { winner, loser, cluster } = syntheticCluster();
  const mk = () => ({
    components: [comp('skill', loser.name, loser.path, 'plugin'), comp('skill', winner.name, winner.path, 'plugin')],
    conflicts: [cluster],
    diagnostics: [{ severity: 'info', code: 'i', message: 'fyi', path: winner.path }],
  });
  assert.deepEqual(analyzeHealth(mk()), analyzeHealth(mk()));

  // Deep-freeze: any in-place mutation (sort/push on inputs) would throw in strict mode.
  const frozen = deepFreeze(mk());
  const r = analyzeHealth(frozen);
  assert.equal(r.summary.total, 2);
});

// ── J. never-throws battery / junk tolerance ──────────────────────────────────

test('never-throws: undefined / {} / nulls / primitives / junk channels', () => {
  const empty = { components: [], summary: { total: 0, loadable: 0, degraded: 0, notLoaded: 0 }, groups: [], diagnostics: [] };
  assert.deepEqual(analyzeHealth(), empty);
  assert.deepEqual(analyzeHealth({}), empty);
  assert.deepEqual(analyzeHealth(null), empty);
  assert.deepEqual(analyzeHealth({ components: null, conflicts: null, diagnostics: null, doctorDiagnostics: null }), empty);
  assert.deepEqual(analyzeHealth({ components: 'junk', conflicts: 42, diagnostics: {}, doctorDiagnostics: 'x' }), empty);
});

test('malformed component records are skipped silently (missing string kind/name/path)', () => {
  const r = analyzeHealth({
    components: [
      null, 42, 'str', {},
      { kind: 'skill' },
      { kind: 'skill', name: 'x' },
      { kind: 5, name: 'x', path: '/p' },
      { kind: 'skill', name: '', path: '/p' },
      { kind: 'skill', name: 'ok', path: '/p/ok' }, // the one valid record
    ],
  });
  assert.equal(r.summary.total, 1);
  assert.equal(r.components[0].name, 'ok');
});

test('malformed clusters and malformed diagnostics are skipped; __proto__-keyed junk is harmless', () => {
  const protoComp = JSON.parse('{"kind":"skill","name":"x","path":"/p/x","__proto__":{"evil":true},"source":{"tier":"user","__proto__":{"tier":"plugin"}}}');
  const r = analyzeHealth({
    components: [protoComp],
    conflicts: [
      null, 'x', 7,
      { kind: 'skill' },                                  // no members
      { kind: 'skill', possibleWinners: 'no' },           // members not an array
      { possibleWinners: [{ path: '/p/x' }, { path: '/q' }] }, // no kind
      { kind: 'skill', possibleWinners: [{ path: '/p/x' }, { path: '/q' }] }, // no likelyWinner.path
      JSON.parse('{"kind":"skill","__proto__":{"likelyWinner":{"path":"/p/x"}},"possibleWinners":[{"path":"/p/x"},{"path":"/q"}]}'),
    ],
    diagnostics: [null, 'x', { severity: 'error' }, { severity: 'nope', path: '/p/x' }, { path: '/p/x' }],
    doctorDiagnostics: [[]],
  });
  assert.equal(r.summary.total, 1);
  assert.equal(r.components[0].status, 'loadable');
  assert.equal(r.components[0].scope, 'user');
  assert.deepEqual(r.components[0].reasons, []);
  assert.deepEqual(({}).evil, undefined); // no Object.prototype pollution
});

// ── K. Export shape ───────────────────────────────────────────────────────────

test('HEALTH_STATUSES is the frozen 3-status vocabulary in group sort order', () => {
  assert.deepEqual(HEALTH_STATUSES, ['loadable', 'degraded', 'not-loaded']);
  assert.ok(Object.isFrozen(HEALTH_STATUSES));
});
