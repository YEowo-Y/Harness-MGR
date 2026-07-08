/**
 * Component-conflict analysis (P1.U13) — skill + agent + command.
 *
 * Groups discovered SKILL/AGENT/COMMAND components by their Claude Code
 * resolution key and reports clusters where two or more resolve to the SAME key
 * — i.e. one shadows the other. Returns a deterministic `{conflicts,
 * diagnostics}`. NEVER throws (the scanner contract from diagnostic.mjs: any bad
 * input degrades to a Diagnostic, the analysis continues).
 *
 * --- The three kinds resolve DIFFERENTLY (verified, authoritative) ---
 *   - SKILLS & COMMANDS: FIRST-MATCH. Only PLUGIN components are namespaced as
 *     `pluginName:name`; user/project are FLAT. So a user skill `foo` and a
 *     plugin skill `foo` do NOT collide (keys differ: `foo` vs `plugin:foo`) —
 *     reporting that pair would be a false positive; we don't. The real skill/
 *     command collision is PLUGIN-vs-PLUGIN: the SAME plugin name installed from
 *     TWO marketplaces both contribute `pluginName:name` → identical key →
 *     collision; only the first-loaded copy wins.
 *   - AGENTS: FLAT namespace for ALL tiers (NOT namespaced), an ordered Map with
 *     LAST-WRITE-WINS, precedence built-in < plugin < user < project < flag <
 *     managed/policy. So a user agent `executor` and a plugin agent `executor`
 *     DO collide on the flat key `executor`, and the USER copy WINS. Plugin-vs-
 *     plugin agents also collide on the flat name.
 *
 * These rules are defined canonically in load-order.mjs (per-kind namespacing +
 * per-tier rank) and IMPORTED here. `namespacePlugins` decides the resolution key
 * shape; `ranks` give a "lower wins" precedence — for agents the built-in last-
 * write-wins order is INVERTED to lower=wins so user (3) beats plugin (4) uniformly
 * with the skill/command first-match ranks.
 *
 * --- Confidence rationale (Phase 1) ---
 * The exact inter-plugin load order is loader-internal and UNVERIFIED in Phase 1,
 * and the running Claude Code version is unknown here. So we never assert a
 * verified `winner`; we emit a `likelyWinner` with `confidence: 'likely'` for
 * EVERY cluster, ranked deterministically so the answer is stable across runs.
 * (The 2.1.x version-guard / loaderConfidence downgrade is the CLI's concern in
 * U15, not conflicts'; this module stays 'likely' in Phase 1.)
 *
 * --- Scope / known gaps ---
 * Records whose `kind` is not skill/agent/command are ignored (not errored).
 * The remaining gap is BUNDLED-shadows-user (a bundled agent shadowed by a user
 * agent of the same name) — that needs a not-yet-modeled `'bundled'` tier in
 * Source and is out of scope here.
 *
 * RESOLVED(P1.U14): the precedence model is now the SINGLE SOURCE OF TRUTH in
 * load-order.mjs (cross-phase invariant: "single-source-of-truth for load-order").
 * The local KIND_RULES / ranking table that was deliberate vertical-slice debt for
 * U12/U13 has been DELETED; this module now IMPORTS resolutionKey,
 * isLoadableComponent and rankComponents from load-order.mjs so two precedence
 * tables can never drift. NOTE: rankComponents breaks EQUAL-rank ties by ES6
 * INSERTION ORDER honoring each kind's `winsBy` ('first' for skill/command, 'last'
 * for agent), which replaces the old marketplace→version→path tiebreak.
 *
 * --- Pure module, by design ---
 * Takes the component list explicitly; depends only on the Source/Diagnostic
 * typedefs + DiagnosticBag. No filesystem, no async, trivially testable.
 *
 * Zero npm dependencies. Node stdlib only. Never throws.
 */

import { DiagnosticBag } from '../lib/diagnostic.mjs';
import { resolutionKey, isLoadableComponent, rankComponents } from './load-order.mjs';
import { identityKey } from '../lib/name-identity.mjs';

/**
 * @typedef {import('../lib/source.mjs').Source} Source
 * @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic
 * @typedef {import('../discovery/components.mjs').ComponentRecord} ComponentRecord
 * @typedef {import('../discovery/components.mjs').ComponentKind} ComponentKind
 */

/**
 * A single member of a conflict cluster: the load-relevant subset of a
 * ComponentRecord. `source` is passed through UNCHANGED so downstream callers
 * keep the full provenance (marketplace, version, …).
 *
 * @typedef {Object} ConflictMember
 * @property {string} name
 * @property {string} path
 * @property {Source} source
 */

/**
 * A set of >= 2 components of the SAME kind that resolve to the same loader key.
 * `likelyWinner` is the first member after deterministic ranking; `possibleWinners`
 * is the full ranked array (likelyWinner first). `confidence` is always 'likely'
 * in Phase 1 (the CC version + inter-plugin load order are unverified — header).
 *
 * @typedef {Object} ConflictCluster
 * @property {ComponentKind} kind
 * @property {string} key                       the shared resolution key
 * @property {'likely'} confidence
 * @property {'warn'} severity
 * @property {ConflictMember} likelyWinner
 * @property {ConflictMember[]} possibleWinners  ranked; likelyWinner first
 * @property {string} reason                     human-readable explanation
 * @property {string} fix                        human-readable remediation hint
 */

/**
 * @typedef {Object} ConflictResult
 * @property {ConflictCluster[]} conflicts
 * @property {Diagnostic[]} diagnostics
 */

/**
 * Analyze skill/agent/command components for shadowing conflicts.
 *
 * @param {ComponentRecord[]} components   discovered components (other kinds ignored)
 * @param {{ caseInsensitive?: boolean }} [opts]
 *   caseInsensitive: when true, two components whose resolution keys differ only in
 *   case are treated as the SAME loader identity (Windows NTFS / macOS APFS default),
 *   so a case-only cross-tier shadow is detected; on a case-sensitive volume they
 *   stay distinct. NFC folding is applied on every platform regardless. Absent →
 *   NFC-only (case-sensitive), preserving the prior behaviour for direct callers.
 * @returns {ConflictResult}
 */
export function analyzeConflicts(components, opts) {
  const caseInsensitive = !!(opts && opts.caseInsensitive);
  const bag = new DiagnosticBag();

  if (!Array.isArray(components)) {
    bag.add({ severity: 'error', code: 'conflicts-bad-input', message: 'components must be an array', phase: 'conflicts' });
    return { conflicts: [], diagnostics: bag.all() };
  }

  /** @type {ConflictCluster[]} */
  const conflicts = [];
  for (const [, group] of groupByKindKey(components, caseInsensitive)) {
    if (group.members.length < 2) continue; // a unique key is not a conflict
    conflicts.push(buildCluster(group.kind, group.key, group.members, bag));
  }

  // Stable output: sort clusters by (kind, key), code-unit compares, locale-independent.
  conflicts.sort((a, b) => cmp(a.kind, b.kind) || cmp(a.key, b.key));
  return { conflicts, diagnostics: bag.all() };
}

/**
 * Group loadable components by `(kind, resolutionKey)` so different kinds never
 * merge, preserving discovery (insertion) order within each group — rankComponents
 * later imposes the deterministic winner order, breaking equal-rank ties by that
 * insertion order. A component is loadable only if it is a LOADED
 * copy — tier 'user' or 'plugin'; catalog and marketplace-copy are not the copy
 * the loader resolves, so they cannot shadow. Loadability + the resolution key are
 * decided by the imported isLoadableComponent / resolutionKey (load-order.mjs, the
 * single source of truth).
 *
 * The GROUPING key is the resolution key run through identityKey (NFC always, plus
 * case folding when caseInsensitive), so a macOS-NFD name groups with its NFC twin
 * and a case-only variant groups on a case-insensitive volume. The DISPLAYED `key`
 * stays the first member's original resolutionKey — identity folding is a grouping
 * concern only, never surfaced to the user or used to build a path.
 * @param {ComponentRecord[]} components
 * @param {boolean} caseInsensitive  fold case in the grouping identity (Win/mac default)
 * @returns {Map<string, {kind: ComponentKind, key: string, members: ConflictMember[]}>}
 */
function groupByKindKey(components, caseInsensitive) {
  /** @type {Map<string, {kind: ComponentKind, key: string, members: ConflictMember[]}>} */
  const groups = new Map();
  for (const rec of components) {
    if (!isLoadableComponent(rec)) continue;
    const member = { name: rec.name, path: rec.path, source: rec.source };
    const key = resolutionKey(rec);                          // display key (original form)
    const identity = identityKey(key, caseInsensitive);      // grouping identity (NFC + optional fold)
    const groupKey = `${rec.kind}\n${identity}`; // collision-proof \n separator (newline cannot appear in a kind or resolution key)
    const existing = groups.get(groupKey);
    if (existing) existing.members.push(member);
    else groups.set(groupKey, { kind: rec.kind, key, members: [member] });
  }
  return groups;
}

/**
 * Code-unit compare treating undefined as the empty string, used ONLY to sort the
 * final `conflicts` array by `(kind, key)`. This is NOT precedence logic — the
 * ranking lives in load-order.mjs's rankComponents (single source of truth).
 * @param {string|undefined} a
 * @param {string|undefined} b
 * @returns {number}
 */
function cmp(a, b) {
  const x = a ?? '';
  const y = b ?? '';
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * Build one cluster from a kind, key and its (>=2) members, and record the
 * matching `${kind}-shadowing` warn Diagnostic in the bag. The reason/fix branch
 * by kind/shape (see reasonFor/fixFor).
 * @param {ComponentKind} kind
 * @param {string} key
 * @param {ConflictMember[]} members
 * @param {DiagnosticBag} bag
 * @returns {ConflictCluster}
 */
function buildCluster(kind, key, members, bag) {
  const ranked = rankComponents(kind, members);
  const reason = reasonFor(kind, ranked);
  const fix = fixFor(kind, ranked);
  bag.add({ severity: 'warn', code: `${kind}-shadowing`, message: reason, fix, phase: 'conflicts' });
  return {
    kind,
    key,
    confidence: 'likely',
    severity: 'warn',
    likelyWinner: ranked[0],
    possibleWinners: ranked,
    reason,
    fix,
  };
}

/**
 * True iff every ranked member is a plugin sharing one plugin name (the verified
 * plugin-vs-plugin marketplace fan-out case).
 * @param {ConflictMember[]} ranked
 * @returns {string|undefined} the shared plugin name, or undefined
 */
function sharedPlugin(ranked) {
  const plugin = ranked[0].source.plugin;
  const same = typeof plugin === 'string' && plugin.length > 0
    && ranked.every((m) => m.source.tier === 'plugin' && m.source.plugin === plugin);
  return same ? plugin : undefined;
}

/**
 * Compose the human-readable reason for a ranked cluster, branching by kind/shape.
 * Plugin-vs-plugin (skill/command): marketplace fan-out sentence. Agent: flat
 * last-write-wins sentence naming the winning tier. Otherwise a generic count.
 * @param {ComponentKind} kind
 * @param {ConflictMember[]} ranked
 * @returns {string}
 */
function reasonFor(kind, ranked) {
  const name = ranked[0].name;
  const plugin = sharedPlugin(ranked);
  if (plugin && (kind === 'skill' || kind === 'command')) {
    const list = ranked.map((m) => m.source.marketplace ?? '(unknown)').join(', ');
    return `plugin "${plugin}" is installed from ${ranked.length} marketplaces (${list}); `
      + `each provides ${kind} "${name}" — only the first-loaded wins`;
  }
  if (kind === 'agent') {
    const tiers = ranked.map((m) => m.source.tier).join(', ');
    return `agent "${name}" is defined at ${tiers}; the ${ranked[0].source.tier} copy wins `
      + `(agents are flat, last-write-wins)`;
  }
  return `${kind} "${name}" is provided by ${ranked.length} loaded copies — only the first-loaded wins`;
}

/**
 * Compose the remediation hint, branching by kind/shape.
 * @param {ComponentKind} kind
 * @param {ConflictMember[]} ranked
 * @returns {string}
 */
function fixFor(kind, ranked) {
  if (sharedPlugin(ranked)) {
    return 'disable one of the conflicting plugin installs, or they will shadow each other';
  }
  if (kind === 'agent') {
    return 'remove or rename the shadowed agent if the override is unintended';
  }
  return `remove or rename one of the conflicting ${kind}s if the override is unintended`;
}
