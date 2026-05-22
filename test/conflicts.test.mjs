/**
 * P1.U12 — conflicts.test.mjs
 *
 * Golden + boundary tests for analyzeConflicts(): the skill-shadowing analyzer.
 * Covers the verified namespacing rule (no user-vs-plugin false positives), the
 * plugin-vs-plugin collision golden, skills-only scope, determinism, and sorting.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeConflicts } from '../src/analysis/conflicts.mjs';
import { scan } from '../src/discovery/scan.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fix = (rel) => join(here, 'fixtures', rel);

const bySeverity = (diags, sev) => diags.filter((d) => d.severity === sev);

/** Build a synthetic skill record with the given name + source. */
const skill = (name, src) => ({ kind: 'skill', name, path: `/fake/${src.tier}/${name}`, source: src, frontmatter: {} });
/** Build a synthetic agent record (used to prove skills-only scope). */
const agent = (name, src) => ({ kind: 'agent', name, path: `/fake/${src.tier}/${name}.md`, source: src, frontmatter: {} });

// ── A. GOLDEN: plugin-vs-plugin collision ──────────────────────────────────────

test('golden: same plugin from two marketplaces → exactly one cluster, likely winner is mp-a', () => {
  const components = [
    skill('deploy', { tier: 'plugin', plugin: 'superplug', marketplace: 'mp-a', version: '1.0.0' }),
    skill('deploy', { tier: 'plugin', plugin: 'superplug', marketplace: 'mp-b', version: '2.0.0' }),
  ];
  const { conflicts, diagnostics } = analyzeConflicts(components);

  assert.equal(conflicts.length, 1);
  const c = conflicts[0];
  assert.equal(c.kind, 'skill');
  assert.equal(c.key, 'superplug:deploy');
  assert.equal(c.confidence, 'likely');
  assert.equal(c.severity, 'warn');
  assert.equal(c.possibleWinners.length, 2);
  // Deterministic tiebreak (equal rank 7) → marketplace string compare → 'mp-a' wins.
  assert.equal(c.likelyWinner.source.marketplace, 'mp-a');
  // likelyWinner is the head of the ranked array.
  assert.deepEqual(c.likelyWinner, c.possibleWinners[0]);
  // Source is passed through unchanged.
  assert.deepEqual(c.likelyWinner.source, { tier: 'plugin', plugin: 'superplug', marketplace: 'mp-a', version: '1.0.0' });
  // A matching flat skill-shadowing warn diagnostic is emitted.
  const shadow = diagnostics.filter((d) => d.code === 'skill-shadowing');
  assert.equal(shadow.length, 1);
  assert.equal(shadow[0].severity, 'warn');
  assert.equal(shadow[0].message, c.reason);
  assert.equal(typeof shadow[0].fix, 'string');
  assert.equal(shadow[0].phase, 'conflicts');
});

// ── B. BENIGN: verified namespacing rule (no false positive) ────────────────────

test('benign: user skill `deploy` + plugin skill `deploy` → ZERO clusters (keys differ)', () => {
  const components = [
    skill('deploy', { tier: 'user' }),
    skill('deploy', { tier: 'plugin', plugin: 'p1', marketplace: 'mp-x', version: '1.0.0' }),
  ];
  const { conflicts, diagnostics } = analyzeConflicts(components);
  // user key = 'deploy'; plugin key = 'p1:deploy' → no shared key → no conflict.
  assert.equal(conflicts.length, 0);
  assert.equal(diagnostics.filter((d) => d.code === 'skill-shadowing').length, 0);
});

test('benign: plugin skill with missing source.plugin does not false-positive against a user skill', () => {
  const components = [
    skill('deploy', { tier: 'user' }),
    skill('deploy', { tier: 'plugin' }), // malformed: plugin tier, no plugin name → excluded, not namespaceable
  ];
  const { conflicts, diagnostics } = analyzeConflicts(components);
  assert.equal(conflicts.length, 0);
  assert.equal(diagnostics.filter((d) => d.code === 'skill-shadowing').length, 0);
});

// ── C. SINGLETON ────────────────────────────────────────────────────────────────

test('singleton: one user skill → zero clusters, zero diagnostics', () => {
  const { conflicts, diagnostics } = analyzeConflicts([skill('solo', { tier: 'user' })]);
  assert.equal(conflicts.length, 0);
  assert.equal(diagnostics.length, 0);
});

// ── D. SKILLS-ONLY SCOPE ─────────────────────────────────────────────────────────

test('skills-only scope: two colliding-name agents are ignored → zero skill clusters', () => {
  const components = [
    agent('deploy', { tier: 'user' }),
    agent('deploy', { tier: 'plugin', plugin: 'p1', marketplace: 'mp-x', version: '1.0.0' }),
    // even two plugin agents that WOULD collide as skills must be ignored here
    agent('build', { tier: 'plugin', plugin: 'p2', marketplace: 'mp-a', version: '1.0.0' }),
    agent('build', { tier: 'plugin', plugin: 'p2', marketplace: 'mp-b', version: '2.0.0' }),
  ];
  const { conflicts, diagnostics } = analyzeConflicts(components);
  assert.equal(conflicts.length, 0);
  assert.equal(diagnostics.length, 0);
});

// ── E. FIXTURE SMOKE ─────────────────────────────────────────────────────────────

test('fixture smoke: conflict/ fixture skill `token-vault` is a singleton → zero clusters', () => {
  const result = scan({ targetClaudeDir: fix('conflict') });
  // sanity: the fixture's sole skill is token-vault (the real collision is an AGENT)
  const skillNames = result.components.filter((c) => c.kind === 'skill').map((c) => c.name);
  assert.deepEqual(skillNames, ['token-vault']);

  const { conflicts, diagnostics } = analyzeConflicts(result.components);
  assert.equal(bySeverity(diagnostics, 'error').length, 0);
  assert.equal(conflicts.length, 0);
});

// ── F. BOUNDARY ──────────────────────────────────────────────────────────────────

test('boundary: null input → bad-input error, never throws', () => {
  let result;
  assert.doesNotThrow(() => { result = analyzeConflicts(/** @type {any} */ (null)); });
  assert.deepEqual(result.conflicts, []);
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0].code, 'conflicts-bad-input');
  assert.equal(result.diagnostics[0].severity, 'error');
  assert.equal(result.diagnostics[0].phase, 'conflicts');
});

test('boundary: numeric input → bad-input error, never throws', () => {
  let result;
  assert.doesNotThrow(() => { result = analyzeConflicts(/** @type {any} */ (42)); });
  assert.deepEqual(result.conflicts, []);
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0].code, 'conflicts-bad-input');
  assert.equal(result.diagnostics[0].severity, 'error');
});

test('boundary: malformed records inside a valid array are skipped, never throw', () => {
  const components = [
    skill('x', { tier: 'user' }),
    null,
    42,
    { kind: 'skill' },                          // missing source
    { kind: 'skill', name: 'y', source: {} },   // source without a tier
    skill('y', { tier: 'plugin', plugin: 'p', marketplace: 'm', version: '1.0.0' }),
  ];
  let result;
  assert.doesNotThrow(() => { result = analyzeConflicts(/** @type {any} */ (components)); });
  assert.equal(result.conflicts.length, 0);                       // no two valid records share a key
  assert.equal(bySeverity(result.diagnostics, 'error').length, 0); // junk is skipped, not errored
});

// ── G. DETERMINISM ───────────────────────────────────────────────────────────────

test('determinism: two identical calls produce identical results', () => {
  const components = [
    skill('deploy', { tier: 'plugin', plugin: 'superplug', marketplace: 'mp-b', version: '2.0.0' }),
    skill('deploy', { tier: 'plugin', plugin: 'superplug', marketplace: 'mp-a', version: '1.0.0' }),
    skill('lint', { tier: 'user' }),
  ];
  const r1 = analyzeConflicts(components);
  const r2 = analyzeConflicts(components);
  assert.deepEqual(r1, r2);
});

// ── H. SORT ──────────────────────────────────────────────────────────────────────

test('sort: multiple clusters returned sorted by key (code-unit)', () => {
  const components = [
    // cluster key 'zeta:deploy'
    skill('deploy', { tier: 'plugin', plugin: 'zeta', marketplace: 'mp-a', version: '1.0.0' }),
    skill('deploy', { tier: 'plugin', plugin: 'zeta', marketplace: 'mp-b', version: '1.0.0' }),
    // cluster key 'alpha:build'
    skill('build', { tier: 'plugin', plugin: 'alpha', marketplace: 'mp-a', version: '1.0.0' }),
    skill('build', { tier: 'plugin', plugin: 'alpha', marketplace: 'mp-b', version: '1.0.0' }),
  ];
  const { conflicts } = analyzeConflicts(components);
  assert.equal(conflicts.length, 2);
  assert.deepEqual(conflicts.map((c) => c.key), ['alpha:build', 'zeta:deploy']);
});
