/**
 * P1.U14 — load-order.test.mjs
 *
 * Golden + boundary tests for the AUTHORITATIVE precedence model:
 *   - the named `load-order-version-guard` cases (loaderConfidence),
 *   - resolutionKey namespacing (plugin skills/commands namespaced; agents flat),
 *   - rankComponents' ES6 insertion-order tiebreak (winsBy 'first' vs 'last', and
 *     rank beating the tiebreak),
 *   - isLoadableComponent eligibility,
 *   - never-throws / determinism boundaries.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VERIFIED_CC_MINOR,
  KIND_RULES,
  UNKNOWN_RANK,
  resolutionKey,
  isLoadableComponent,
  rankComponents,
  loaderConfidence,
} from '../src/analysis/load-order.mjs';

/** Build a synthetic component record with the given kind/name/source. */
const rec = (kind, name, src) => ({ kind, name, path: `/fake/${src.tier}/${name}`, source: src, frontmatter: {} });
const skill = (name, src) => rec('skill', name, src);
const agent = (name, src) => rec('agent', name, src);
const command = (name, src) => rec('command', name, src);

// ── A. CONSTANTS ─────────────────────────────────────────────────────────────────

test('constants: VERIFIED_CC_MINOR, UNKNOWN_RANK, and the per-kind rules carry winsBy', () => {
  assert.equal(VERIFIED_CC_MINOR, '2.1');
  assert.equal(UNKNOWN_RANK, 99);
  assert.equal(KIND_RULES.skill.winsBy, 'first');
  assert.equal(KIND_RULES.command.winsBy, 'first');
  assert.equal(KIND_RULES.agent.winsBy, 'last');
  // namespacing shape + the lower-wins ranks carried over from conflicts.mjs.
  assert.equal(KIND_RULES.skill.namespacePlugins, true);
  assert.equal(KIND_RULES.agent.namespacePlugins, false);
  assert.equal(KIND_RULES.agent.ranks.user, 3);
  assert.equal(KIND_RULES.agent.ranks.plugin, 4);
  // Frozen: the single source of truth must be immutable.
  assert.equal(Object.isFrozen(KIND_RULES), true);
  assert.equal(Object.isFrozen(KIND_RULES.skill), true);
  assert.equal(Object.isFrozen(KIND_RULES.skill.ranks), true);
});

// ── B. VERSION GUARD (load-order-version-guard) ───────────────────────────────────

test('load-order-version-guard: 2.1.146 → verified, zero diagnostics', () => {
  const { confidence, diagnostics } = loaderConfidence('2.1.146');
  assert.equal(confidence, 'verified');
  assert.deepEqual(diagnostics, []);
});

test('load-order-version-guard: 2.1.88 → verified, zero diagnostics', () => {
  const { confidence, diagnostics } = loaderConfidence('2.1.88');
  assert.equal(confidence, 'verified');
  assert.equal(diagnostics.length, 0);
});

test('load-order-version-guard: bare 2.1 → verified', () => {
  const { confidence, diagnostics } = loaderConfidence('2.1');
  assert.equal(confidence, 'verified');
  assert.equal(diagnostics.length, 0);
});

test('load-order-version-guard: 2.1.0 → verified (numeric patch)', () => {
  assert.equal(loaderConfidence('2.1.0').confidence, 'verified');
});

test('load-order-version-guard: literal 2.1.x and trailing-dot 2.1. → likely (not numeric patches)', () => {
  const x = loaderConfidence('2.1.x');
  assert.equal(x.confidence, 'likely');
  assert.equal(x.diagnostics[0].severity, 'warn');
  assert.equal(loaderConfidence('2.1.').confidence, 'likely');
});

test('load-order-version-guard: undefined → likely + exactly 1 info diagnostic', () => {
  const { confidence, diagnostics } = loaderConfidence(undefined);
  assert.equal(confidence, 'likely');
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].code, 'loader-rules-unverified-version');
  assert.equal(diagnostics[0].severity, 'info');
  assert.equal(diagnostics[0].phase, 'load-order');
});

test('load-order-version-guard: 2.2.0 → likely + 1 warn diagnostic', () => {
  const { confidence, diagnostics } = loaderConfidence('2.2.0');
  assert.equal(confidence, 'likely');
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].code, 'loader-rules-unverified-version');
  assert.equal(diagnostics[0].severity, 'warn');
  assert.equal(diagnostics[0].phase, 'load-order');
  assert.match(diagnostics[0].message, /2\.2\.0/);
});

test('load-order-version-guard: 3.0.0 → likely + warn', () => {
  const { confidence, diagnostics } = loaderConfidence('3.0.0');
  assert.equal(confidence, 'likely');
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].severity, 'warn');
});

test('load-order-version-guard: 2.10.0 is a DIFFERENT minor line → likely + warn', () => {
  // Guard rationale: 2.1.x must not accidentally swallow 2.10.x.
  const { confidence, diagnostics } = loaderConfidence('2.10.0');
  assert.equal(confidence, 'likely');
  assert.equal(diagnostics[0].severity, 'warn');
});

test('load-order-version-guard: non-string input (42) treated as absent → likely + info', () => {
  const { confidence, diagnostics } = loaderConfidence(/** @type {any} */ (42));
  assert.equal(confidence, 'likely');
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].severity, 'info');
});

test('load-order-version-guard: empty string treated as absent → likely + info', () => {
  const { confidence, diagnostics } = loaderConfidence('');
  assert.equal(confidence, 'likely');
  assert.equal(diagnostics[0].severity, 'info');
});

test('load-order-version-guard: null does not throw', () => {
  let out;
  assert.doesNotThrow(() => { out = loaderConfidence(/** @type {any} */ (null)); });
  assert.equal(out.confidence, 'likely');
  assert.equal(out.diagnostics[0].severity, 'info');
});

// ── C. resolutionKey ──────────────────────────────────────────────────────────────

test('resolutionKey: plugin skill → namespaced plugin:name', () => {
  assert.equal(resolutionKey(skill('deploy', { tier: 'plugin', plugin: 'superplug', marketplace: 'mp-a' })), 'superplug:deploy');
});

test('resolutionKey: user skill → flat name', () => {
  assert.equal(resolutionKey(skill('deploy', { tier: 'user' })), 'deploy');
});

test('resolutionKey: plugin agent → FLAT name (agents are not namespaced)', () => {
  assert.equal(resolutionKey(agent('executor', { tier: 'plugin', plugin: 'omc', marketplace: 'mp-a' })), 'executor');
});

test('resolutionKey: plugin command → namespaced plugin:name', () => {
  assert.equal(resolutionKey(command('release', { tier: 'plugin', plugin: 'shipper', marketplace: 'mp-a' })), 'shipper:release');
});

test('resolutionKey: plugin skill with missing/empty plugin → flat name (cannot namespace)', () => {
  assert.equal(resolutionKey(skill('deploy', { tier: 'plugin' })), 'deploy');
  assert.equal(resolutionKey(skill('deploy', { tier: 'plugin', plugin: '' })), 'deploy');
});

// ── D. rankComponents — insertion-order tiebreak ─────────────────────────────────

test('rankComponents skill (winsBy first): equal-rank plugins → FIRST-inserted wins', () => {
  const A = skill('deploy', { tier: 'plugin', plugin: 'p', marketplace: 'mp-a' });
  const B = skill('deploy', { tier: 'plugin', plugin: 'p', marketplace: 'mp-b' });
  // input [A, B] → A wins
  assert.equal(rankComponents('skill', [A, B])[0], A);
  // reverse input [B, A] → B wins (proves it's insertion order, not content)
  assert.equal(rankComponents('skill', [B, A])[0], B);
});

test('rankComponents agent (winsBy last): equal-rank plugins → LAST-inserted wins', () => {
  const A = agent('build', { tier: 'plugin', plugin: 'p', marketplace: 'mp-a' });
  const B = agent('build', { tier: 'plugin', plugin: 'p', marketplace: 'mp-b' });
  // input [A, B] → B wins (last-write-wins)
  assert.equal(rankComponents('agent', [A, B])[0], B);
  // reverse input [B, A] → A wins
  assert.equal(rankComponents('agent', [B, A])[0], A);
});

test('rankComponents agent: rank BEATS the tiebreak — user wins over plugin regardless of order', () => {
  const u = agent('executor', { tier: 'user' });
  const p = agent('executor', { tier: 'plugin', plugin: 'omc', marketplace: 'mp-a' });
  // user rank 3 < plugin rank 4 → user wins even when inserted last.
  assert.equal(rankComponents('agent', [p, u])[0], u);
  assert.equal(rankComponents('agent', [u, p])[0], u);
});

test('rankComponents skill: user (rank 3) wins over plugin (rank 7) regardless of order', () => {
  const u = skill('deploy', { tier: 'user' });
  const p = skill('deploy', { tier: 'plugin', plugin: 'p', marketplace: 'mp-a' });
  assert.equal(rankComponents('skill', [p, u])[0], u);
  assert.equal(rankComponents('skill', [u, p])[0], u);
});

test('rankComponents: returns a NEW array and does not mutate the input', () => {
  const A = agent('x', { tier: 'plugin', plugin: 'p', marketplace: 'mp-a' });
  const B = agent('x', { tier: 'plugin', plugin: 'p', marketplace: 'mp-b' });
  const input = [A, B];
  const out = rankComponents('agent', input);
  assert.notEqual(out, input);             // new array
  assert.deepEqual(input, [A, B]);          // input order unchanged
  assert.deepEqual(out, [B, A]);            // last-wins
});

test('rankComponents: ranks an unmodeled tier (catalog) as UNKNOWN_RANK, after known tiers', () => {
  const u = skill('deploy', { tier: 'user' });
  const c = skill('deploy', { tier: /** @type {any} */ ('catalog') });
  // user rank 3 < catalog UNKNOWN_RANK 99 → user first.
  assert.deepEqual(rankComponents('skill', [c, u]), [u, c]);
});

// ── E. isLoadableComponent ────────────────────────────────────────────────────────

test('isLoadableComponent: user skill ✓', () => {
  assert.equal(isLoadableComponent(skill('s', { tier: 'user' })), true);
});

test('isLoadableComponent: plugin skill WITH plugin ✓', () => {
  assert.equal(isLoadableComponent(skill('s', { tier: 'plugin', plugin: 'p', marketplace: 'm' })), true);
});

test('isLoadableComponent: plugin skill WITHOUT plugin ✗ (namespaced kind needs plugin name)', () => {
  assert.equal(isLoadableComponent(skill('s', { tier: 'plugin' })), false);
  assert.equal(isLoadableComponent(skill('s', { tier: 'plugin', plugin: '' })), false);
});

test('isLoadableComponent: plugin agent WITHOUT plugin ✓ (flat kind does not require plugin name)', () => {
  assert.equal(isLoadableComponent(agent('a', { tier: 'plugin' })), true);
});

test('isLoadableComponent: catalog / marketplace-copy tier ✗', () => {
  assert.equal(isLoadableComponent(skill('s', { tier: /** @type {any} */ ('catalog') })), false);
  assert.equal(isLoadableComponent(skill('s', { tier: /** @type {any} */ ('marketplace-copy') })), false);
});

test('isLoadableComponent: non-string name ✗', () => {
  assert.equal(isLoadableComponent({ kind: 'agent', name: 42, source: { tier: 'user' } }), false);
});

test('isLoadableComponent: unknown kind ✗', () => {
  assert.equal(isLoadableComponent({ kind: 'hook', name: 'x', source: { tier: 'user' } }), false);
});

test('isLoadableComponent: null / non-object / missing source ✗', () => {
  assert.equal(isLoadableComponent(null), false);
  assert.equal(isLoadableComponent(/** @type {any} */ (42)), false);
  assert.equal(isLoadableComponent({ kind: 'skill', name: 's' }), false);
  assert.equal(isLoadableComponent({ kind: 'skill', name: 's', source: {} }), false);
});

// ── F. BOUNDARY / NEVER-THROWS ────────────────────────────────────────────────────

test('boundary: rankComponents on an empty array → []', () => {
  assert.deepEqual(rankComponents('skill', []), []);
});

test('boundary: rankComponents on an unknown kind → single stable element, no throw', () => {
  const member = { name: 'x', source: { tier: 'user' } };
  let out;
  assert.doesNotThrow(() => { out = rankComponents('bogus', [member]); });
  assert.equal(out.length, 1);
  assert.equal(out[0], member);
});

test('boundary: rankComponents on a non-array → [], no throw', () => {
  let out;
  assert.doesNotThrow(() => { out = rankComponents('skill', /** @type {any} */ (null)); });
  assert.deepEqual(out, []);
});

test('boundary: rankComponents with malformed members (null / missing source) → no throw, ranked last', () => {
  const good = skill('deploy', { tier: 'user' });
  let out;
  assert.doesNotThrow(() => {
    out = rankComponents('skill', /** @type {any} */ ([good, null, { name: 'no-source' }]));
  });
  assert.equal(out.length, 3);
  // the well-formed member (rank 3) sorts ahead of the malformed ones (UNKNOWN_RANK 99)
  assert.equal(out[0], good);
});

// ── G. DETERMINISM ──────────────────────────────────────────────────────────────

test('determinism: two identical rankComponents calls produce identical orders', () => {
  const members = [
    agent('x', { tier: 'plugin', plugin: 'p', marketplace: 'mp-b' }),
    agent('x', { tier: 'user' }),
    agent('x', { tier: 'plugin', plugin: 'p', marketplace: 'mp-a' }),
  ];
  assert.deepEqual(rankComponents('agent', members), rankComponents('agent', members));
});

// ── H. PROTOTYPE-SAFETY: a kind that collides with an Object.prototype member ──────

test('prototype-safety: a kind matching an Object.prototype key degrades, never throws', () => {
  // Distinct from the 'bogus' unknown-kind case: on a PLAIN-object KIND_RULES,
  // KIND_RULES['toString'] returns an INHERITED function (truthy), defeating the
  // `if (!rule)` guard so rankOf dereferences undefined.ranks → TypeError. A null-proto
  // table makes the lookup undefined, so the kind ranks UNKNOWN_RANK and is not loadable.
  for (const kind of ['toString', 'constructor', 'hasOwnProperty', 'valueOf']) {
    const members = [
      { kind, name: 'x', path: 'p1', source: { tier: 'user' } },
      { kind, name: 'x', path: 'p2', source: { tier: 'plugin', plugin: 'p', marketplace: 'm' } },
    ];
    let out;
    assert.doesNotThrow(() => { out = rankComponents(kind, members); }, `rankComponents(${kind}) must not throw`);
    assert.equal(out.length, 2, `${kind}: all members returned`);
    assert.equal(isLoadableComponent({ kind, name: 'x', path: 'p', source: { tier: 'user' } }), false, `unknown kind ${kind} is not loadable`);
  }
});
