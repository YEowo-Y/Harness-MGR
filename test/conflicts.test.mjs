/**
 * P1.U12/U13 — conflicts.test.mjs
 *
 * Golden + boundary tests for analyzeConflicts(): the skill/agent/command
 * shadowing analyzer. Covers the verified namespacing rule (no user-vs-plugin
 * false positives for skills/commands), the plugin-vs-plugin collision goldens,
 * the FLAT agent model (user-vs-plugin agents DO collide, user wins), cross-kind
 * sorting, determinism, and boundary safety.
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
/** Build a synthetic agent record with the given name + source. */
const agent = (name, src) => ({ kind: 'agent', name, path: `/fake/${src.tier}/${name}.md`, source: src, frontmatter: {} });
/** Build a synthetic command record with the given name + source. */
const command = (name, src) => ({ kind: 'command', name, path: `/fake/${src.tier}/${name}`, source: src, frontmatter: {} });

// ── A. SKILL GOLDEN: plugin-vs-plugin collision ─────────────────────────────────

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
  // Deterministic tiebreak: equal rank (7); skill winsBy:'first' → the FIRST-inserted
  // member (mp-a, index 0) wins.
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

test('regression guard: user skill `deploy` + plugin skill `deploy` (plugin p1) → still ZERO clusters', () => {
  // Namespacing must stay intact for skills after the all-kinds extension.
  const components = [
    skill('deploy', { tier: 'user' }),
    skill('deploy', { tier: 'plugin', plugin: 'p1', marketplace: 'mp-x', version: '1.0.0' }),
  ];
  const { conflicts, diagnostics } = analyzeConflicts(components);
  assert.equal(conflicts.length, 0);
  assert.equal(bySeverity(diagnostics, 'warn').length, 0);
});

// ── C. SINGLETON ────────────────────────────────────────────────────────────────

test('singleton: one user skill → zero clusters, zero diagnostics', () => {
  const { conflicts, diagnostics } = analyzeConflicts([skill('solo', { tier: 'user' })]);
  assert.equal(conflicts.length, 0);
  assert.equal(diagnostics.length, 0);
});

// ── D. AGENT GOLDEN: flat namespace, user beats plugin ──────────────────────────

test('agent golden: user `executor` + plugin `executor` → one FLAT cluster, USER wins', () => {
  const components = [
    agent('executor', { tier: 'user' }),
    agent('executor', { tier: 'plugin', plugin: 'oh-my-claudecode', marketplace: 'claude-plugins-official', version: '1.0.0' }),
  ];
  const { conflicts, diagnostics } = analyzeConflicts(components);

  assert.equal(conflicts.length, 1);
  const c = conflicts[0];
  assert.equal(c.kind, 'agent');
  assert.equal(c.key, 'executor'); // FLAT, not namespaced
  assert.equal(c.possibleWinners.length, 2);
  assert.equal(c.likelyWinner.source.tier, 'user'); // user (rank 3) beats plugin (rank 4)
  assert.equal(c.confidence, 'likely');
  assert.equal(c.severity, 'warn');
  const shadow = diagnostics.filter((d) => d.code === 'agent-shadowing');
  assert.equal(shadow.length, 1);
  assert.equal(shadow[0].severity, 'warn');
  assert.equal(shadow[0].message, c.reason);
  assert.equal(shadow[0].phase, 'conflicts');
});

test('agent plugin-vs-plugin: same flat name from two marketplaces → one FLAT cluster, deterministic', () => {
  const components = [
    agent('build', { tier: 'plugin', plugin: 'p2', marketplace: 'mp-b', version: '2.0.0' }),
    agent('build', { tier: 'plugin', plugin: 'p2', marketplace: 'mp-a', version: '1.0.0' }),
  ];
  const { conflicts } = analyzeConflicts(components);
  assert.equal(conflicts.length, 1);
  const c = conflicts[0];
  assert.equal(c.kind, 'agent');
  assert.equal(c.key, 'build'); // FLAT
  assert.equal(c.possibleWinners.length, 2);
  // Equal rank (4); agent winsBy:'last' → the LAST-inserted member (mp-a, index 1) wins.
  assert.equal(c.likelyWinner.source.marketplace, 'mp-a');
  assert.deepEqual(c.likelyWinner, c.possibleWinners[0]);
});

// ── D2. AGENT CASE FOLDING (P1-2): flat keys differing only in case ──────────────

test('agent case-fold: user `Executor` + plugin `executor` collide on a case-insensitive volume', () => {
  // Agents are FLAT for every tier, so on Windows/macOS the loader treats the two
  // case variants as ONE identity and one shadows the other. Without folding this
  // real conflict is missed.
  const components = [
    agent('Executor', { tier: 'user' }),
    agent('executor', { tier: 'plugin', plugin: 'omc', marketplace: 'mp-a', version: '1.0.0' }),
  ];
  const { conflicts } = analyzeConflicts(components, { caseInsensitive: true });
  assert.equal(conflicts.length, 1, 'case-only variants collide when the volume folds case');
  assert.equal(conflicts[0].kind, 'agent');
  assert.equal(conflicts[0].possibleWinners.length, 2);
});

test('agent case-fold: same records stay DISTINCT on a case-sensitive volume (Linux)', () => {
  const components = [
    agent('Executor', { tier: 'user' }),
    agent('executor', { tier: 'plugin', plugin: 'omc', marketplace: 'mp-a', version: '1.0.0' }),
  ];
  const { conflicts } = analyzeConflicts(components, { caseInsensitive: false });
  assert.equal(conflicts.length, 0, 'Executor and executor are genuinely distinct on a case-sensitive FS');
});

test('agent case-fold: default (no opts) does NOT fold — preserves prior behaviour for direct callers', () => {
  const components = [
    agent('Executor', { tier: 'user' }),
    agent('executor', { tier: 'plugin', plugin: 'omc', marketplace: 'mp-a', version: '1.0.0' }),
  ];
  const { conflicts } = analyzeConflicts(components);
  assert.equal(conflicts.length, 0, 'no opts → NFC-only, case-sensitive grouping (unchanged)');
});

// ── E. COMMAND GOLDEN: namespaced plugin-vs-plugin ──────────────────────────────

test('command golden: same plugin from two marketplaces → one NAMESPACED cluster', () => {
  const components = [
    command('release', { tier: 'plugin', plugin: 'shipper', marketplace: 'mp-a', version: '1.0.0' }),
    command('release', { tier: 'plugin', plugin: 'shipper', marketplace: 'mp-b', version: '2.0.0' }),
  ];
  const { conflicts, diagnostics } = analyzeConflicts(components);
  assert.equal(conflicts.length, 1);
  const c = conflicts[0];
  assert.equal(c.kind, 'command');
  assert.equal(c.key, 'shipper:release'); // namespaced like skills
  assert.equal(c.possibleWinners.length, 2);
  // Equal rank (6); command winsBy:'first' → the FIRST-inserted member (mp-a, index 0) wins.
  assert.equal(c.likelyWinner.source.marketplace, 'mp-a');
  const shadow = diagnostics.filter((d) => d.code === 'command-shadowing');
  assert.equal(shadow.length, 1);
  assert.equal(shadow[0].message, c.reason);
});

// ── F. CROSS-KIND SORT ──────────────────────────────────────────────────────────

test('cross-kind sort: skill + agent + command clusters → 3 clusters sorted by (kind, key)', () => {
  const components = [
    // skill cluster: key 'zeta:deploy'
    skill('deploy', { tier: 'plugin', plugin: 'zeta', marketplace: 'mp-a', version: '1.0.0' }),
    skill('deploy', { tier: 'plugin', plugin: 'zeta', marketplace: 'mp-b', version: '1.0.0' }),
    // agent cluster: flat key 'executor'
    agent('executor', { tier: 'user' }),
    agent('executor', { tier: 'plugin', plugin: 'omc', marketplace: 'mp-a', version: '1.0.0' }),
    // command cluster: namespaced key 'shipper:release'
    command('release', { tier: 'plugin', plugin: 'shipper', marketplace: 'mp-a', version: '1.0.0' }),
    command('release', { tier: 'plugin', plugin: 'shipper', marketplace: 'mp-b', version: '1.0.0' }),
  ];
  const { conflicts } = analyzeConflicts(components);
  assert.equal(conflicts.length, 3);
  // code-unit on kind: 'agent' < 'command' < 'skill'.
  assert.deepEqual(
    conflicts.map((c) => [c.kind, c.key]),
    [['agent', 'executor'], ['command', 'shipper:release'], ['skill', 'zeta:deploy']],
  );
});

test('boundary: records with a non-string name are excluded (type contract)', () => {
  const components = [
    agent('valid', { tier: 'user' }),
    // two numeric-named agents that WOULD share key 42 if not excluded by the name guard
    { kind: 'agent', name: 42, path: '/fake/x', source: { tier: 'user' }, frontmatter: {} },
    { kind: 'agent', name: 42, path: '/fake/y', source: { tier: 'plugin', plugin: 'p', marketplace: 'm', version: '1' }, frontmatter: {} },
  ];
  let result;
  assert.doesNotThrow(() => { result = analyzeConflicts(/** @type {any} */ (components)); });
  assert.equal(result.conflicts.length, 0);
});

// ── G. FIXTURE SMOKE ─────────────────────────────────────────────────────────────

test('fixture smoke: conflict/ fixture yields zero clusters (plugin dirs are not user-walked)', () => {
  const result = scan({ targetClaudeDir: fix('conflict') });
  // User-tier discovery does NOT walk plugin component dirs (plugins/cache/...), so
  // the fixture's plugin `executor` agent is never discovered — only the single user
  // `executor` agent + single user `token-vault` skill, both singletons → 0 clusters.
  const skillNames = result.components.filter((c) => c.kind === 'skill').map((c) => c.name);
  assert.deepEqual(skillNames, ['token-vault']);
  const agentNames = result.components.filter((c) => c.kind === 'agent').map((c) => c.name);
  assert.deepEqual(agentNames, ['executor']);

  const { conflicts, diagnostics } = analyzeConflicts(result.components);
  assert.equal(bySeverity(diagnostics, 'error').length, 0);
  assert.equal(conflicts.length, 0);
});

// ── H. BOUNDARY ──────────────────────────────────────────────────────────────────

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

// ── I. DETERMINISM ───────────────────────────────────────────────────────────────

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

// ── J. SORT ──────────────────────────────────────────────────────────────────────

test('sort: multiple skill clusters returned sorted by key (code-unit)', () => {
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
