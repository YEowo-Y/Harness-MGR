/**
 * Codex component CO-EXISTENCE analysis (P6 — codex multi-source scan).
 *
 * Codex's component-resolution model is DIFFERENT from Claude Code's: per the
 * official Codex docs, *"If two skills share the same name, Codex doesn't merge them;
 * both can appear in skill selectors"* — i.e. same-name components CO-EXIST, they do
 * NOT shadow (one wins). So once the multi-source scan surfaces cross-source same-name
 * components (a home skill + a plugin skill, or the same plugin name shipped from two
 * marketplaces), it would be DISHONEST to run Claude's shadowing model on them and
 * assert a "winner". This module is the honest codex view instead.
 *
 * `analyzeCoexistence(components)` groups components by `(kind, name)` and reports each
 * group with >= 2 members as a CO-EXISTENCE cluster — the same name provided by
 * multiple on-disk sources, all of which codex loads (no winner). It is the codex
 * analogue of conflicts.mjs, but reframed "co-exist" not "shadow".
 *
 * `targetModelsShadowing(descriptor)` is the SINGLE SOURCE for the policy "does this
 * target model Claude-style shadowing?" — true for Claude/default, FALSE for codex.
 * Both conflictsCommand and doctor-facts consume it so the "codex doesn't shadow"
 * decision can never drift between the two call sites.
 *
 * --- Pure module, by design ---
 * Takes the component list explicitly; depends only on the DiagnosticBag + typedefs.
 * Proto-safe grouping (Object-free Map). No filesystem, no async, never throws —
 * bad input degrades to an empty result. Deterministic output (sorted).
 *
 * Zero npm dependencies. Node stdlib only.
 */

import { DiagnosticBag } from '../lib/diagnostic.mjs';

/**
 * @typedef {import('../lib/source.mjs').Source} Source
 * @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic
 * @typedef {import('../discovery/components.mjs').ComponentRecord} ComponentRecord
 * @typedef {import('../discovery/components.mjs').ComponentKind} ComponentKind
 */

/**
 * One member of a co-existence cluster: where this copy lives + its provenance.
 * @typedef {Object} CoexistenceMember
 * @property {string} tier              'user' (home) / 'plugin' (a plugin cache) / …
 * @property {string} [plugin]          the plugin name (plugin-tier members)
 * @property {string} [marketplace]     the marketplace name (plugin-tier members)
 * @property {string} path              absolute path to the component file
 */

/**
 * A set of >= 2 components of the SAME kind+name provided by multiple sources. Codex
 * loads ALL of them (no winner) — purely informational, severity 'info'.
 * @typedef {Object} CoexistenceCluster
 * @property {ComponentKind} kind
 * @property {string} name
 * @property {number} count
 * @property {CoexistenceMember[]} sources   each on-disk copy, ranked deterministically
 */

/**
 * @typedef {Object} CoexistenceResult
 * @property {CoexistenceCluster[]} coexistence
 * @property {Diagnostic[]} diagnostics
 */

/**
 * Does this target model Claude-style shadowing (one copy wins)? True for
 * Claude/default; FALSE for codex (same-name components coexist per Codex docs).
 * The single source for that policy. Never throws.
 * @param {{id?: string}|null|undefined} descriptor
 * @returns {boolean}
 */
export function targetModelsShadowing(descriptor) {
  return !(descriptor && descriptor.id === 'codex');
}

/**
 * Group components by (kind, name) and report same-name multi-source groups as
 * co-existence clusters. Never throws; non-array input → empty result.
 *
 * @param {ComponentRecord[]} components
 * @returns {CoexistenceResult}
 */
export function analyzeCoexistence(components) {
  const bag = new DiagnosticBag();
  if (!Array.isArray(components)) {
    bag.add({ severity: 'error', code: 'coexistence-bad-input', message: 'components must be an array', phase: 'conflicts' });
    return { coexistence: [], diagnostics: bag.all() };
  }

  /** @type {Map<string, {kind: ComponentKind, name: string, members: CoexistenceMember[]}>} */
  const groups = new Map();
  for (const rec of components) {
    if (!rec || typeof rec !== 'object') continue;
    const { kind, name, path, source } = rec;
    if (typeof kind !== 'string' || kind.length === 0) continue;
    if (typeof name !== 'string' || name.length === 0) continue;
    const member = toMember(source, path);
    const groupKey = `${kind}\n${name}`; // \n is collision-proof: it cannot appear in a kind or a component name
    const existing = groups.get(groupKey);
    if (existing) existing.members.push(member);
    else groups.set(groupKey, { kind, name, members: [member] });
  }

  /** @type {CoexistenceCluster[]} */
  const coexistence = [];
  for (const [, g] of groups) {
    if (g.members.length < 2) continue; // a single source is not co-existence
    g.members.sort(byMember);
    coexistence.push({ kind: g.kind, name: g.name, count: g.members.length, sources: g.members });
  }
  coexistence.sort((a, b) => cmp(a.kind, b.kind) || cmp(a.name, b.name));
  return { coexistence, diagnostics: bag.all() };
}

/**
 * Build a co-existence member from a (possibly malformed) source + path. Only the
 * provenance fields that are present are set, so the serialized output stays minimal.
 * @param {unknown} source
 * @param {unknown} path
 * @returns {CoexistenceMember}
 */
function toMember(source, path) {
  const s = source && typeof source === 'object' ? /** @type {Record<string, unknown>} */ (source) : {};
  /** @type {CoexistenceMember} */
  const m = {
    tier: typeof s.tier === 'string' ? /** @type {string} */ (s.tier) : 'user',
    path: typeof path === 'string' ? path : '',
  };
  if (typeof s.plugin === 'string' && s.plugin.length > 0) m.plugin = s.plugin;
  if (typeof s.marketplace === 'string' && s.marketplace.length > 0) m.marketplace = s.marketplace;
  return m;
}

/**
 * Deterministic member order: tier, then marketplace, then plugin, then path.
 * @param {CoexistenceMember} a
 * @param {CoexistenceMember} b
 * @returns {number}
 */
function byMember(a, b) {
  return cmp(a.tier, b.tier) || cmp(a.marketplace, b.marketplace) || cmp(a.plugin, b.plugin) || cmp(a.path, b.path);
}

/**
 * Code-unit compare treating undefined as the empty string. Locale-independent.
 * @param {string|undefined} a
 * @param {string|undefined} b
 * @returns {number}
 */
function cmp(a, b) {
  const x = a ?? '';
  const y = b ?? '';
  return x < y ? -1 : x > y ? 1 : 0;
}
