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
 * These rules are encoded ONCE in KIND_RULES below (per-kind namespacing + per-
 * tier rank). `namespacePlugins` decides the resolution key shape; `ranks` give
 * a "lower wins" precedence — for agents the built-in last-write-wins order is
 * INVERTED to lower=wins so user (3) beats plugin (4) uniformly with the skill/
 * command first-match ranks.
 *
 * --- Confidence rationale (Phase 1) ---
 * The exact inter-plugin load order is loader-internal and UNVERIFIED in Phase 1,
 * and the running Claude Code version is unknown here. So we never assert a
 * verified `winner`; we emit a `likelyWinner` with `confidence: 'likely'` for
 * EVERY cluster, ranked deterministically so the answer is stable across runs.
 *
 * --- Scope / known gaps ---
 * Records whose `kind` is not skill/agent/command are ignored (not errored).
 * The remaining gap is BUNDLED-shadows-user (a bundled agent shadowed by a user
 * agent of the same name) — that needs a not-yet-modeled `'bundled'` tier in
 * Source and is out of scope here. See TODO(P1.U14) below.
 *
 * TODO(P1.U14): load-order.mjs becomes the SINGLE SOURCE OF TRUTH for precedence
 * (cross-phase invariant: "single-source-of-truth for load-order"). KIND_RULES is
 * deliberate vertical-slice debt for U12/U13 and MUST be replaced by importing the
 * ranking from load-order.mjs at U14 — do not let two precedence tables drift.
 *
 * --- Pure module, by design ---
 * Takes the component list explicitly; depends only on the Source/Diagnostic
 * typedefs + DiagnosticBag. No filesystem, no async, trivially testable.
 *
 * Zero npm dependencies. Node stdlib only. Never throws.
 */

import { DiagnosticBag } from '../lib/diagnostic.mjs';

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
 * Per-kind resolution rules. `namespacePlugins`: do plugin components get the
 * `plugin:name` namespace (skills/commands yes, agents no)? `ranks`: lower number
 * WINS (the resolved/effective copy). Skill/command ranks mirror the first-match
 * order (user's skillDir checked before pluginSkills). Agent ranks INVERT the
 * built-in last-write-wins precedence into lower=wins so user (3) beats plugin (4).
 *
 * See the TODO(P1.U14) in the header: this is the single local precedence table,
 * vertical-slice debt to be replaced by load-order.mjs.
 */
const KIND_RULES = Object.freeze({
  skill: Object.freeze({ namespacePlugins: true, ranks: Object.freeze({ user: 3, plugin: 7 }) }), // first-match; user before pluginSkills
  command: Object.freeze({ namespacePlugins: true, ranks: Object.freeze({ user: 3, plugin: 6 }) }), // first-match; user before pluginCommands
  agent: Object.freeze({ namespacePlugins: false, ranks: Object.freeze({ user: 3, plugin: 4 }) }), // flat last-write-wins, INVERTED to lower=wins: user beats plugin
});

/**
 * Rank used for any tier not modeled in a kind's `ranks`; sorts after every known
 * tier. See the TODO(P1.U14): any tier later admitted by isEligibleComponent must
 * also be ranked in KIND_RULES, or it will silently sort last.
 */
const UNKNOWN_RANK = 99;

/**
 * Analyze skill/agent/command components for shadowing conflicts.
 *
 * @param {ComponentRecord[]} components   discovered components (other kinds ignored)
 * @param {Object} [opts]                   reserved for future options (none in Phase 1)
 * @returns {ConflictResult}
 */
export function analyzeConflicts(components, opts) {
  void opts; // reserved; keeps the signature stable for U14
  const bag = new DiagnosticBag();

  if (!Array.isArray(components)) {
    bag.add({ severity: 'error', code: 'conflicts-bad-input', message: 'components must be an array', phase: 'conflicts' });
    return { conflicts: [], diagnostics: bag.all() };
  }

  /** @type {ConflictCluster[]} */
  const conflicts = [];
  for (const [, group] of groupByKindKey(components)) {
    if (group.members.length < 2) continue; // a unique key is not a conflict
    conflicts.push(buildCluster(group.kind, group.key, group.members, bag));
  }

  // Stable output: sort clusters by (kind, key), code-unit compares, locale-independent.
  conflicts.sort((a, b) => cmp(a.kind, b.kind) || cmp(a.key, b.key));
  return { conflicts, diagnostics: bag.all() };
}

/**
 * Group eligible components by `(kind, resolutionKey)` so different kinds never
 * merge, preserving discovery order within each group (rankMembers later imposes
 * the deterministic winner order). A component is eligible only if it is a LOADED
 * copy — tier 'user' or 'plugin'; catalog and marketplace-copy are not the copy
 * the loader resolves, so they cannot shadow.
 * @param {ComponentRecord[]} components
 * @returns {Map<string, {kind: ComponentKind, key: string, members: ConflictMember[]}>}
 */
function groupByKindKey(components) {
  /** @type {Map<string, {kind: ComponentKind, key: string, members: ConflictMember[]}>} */
  const groups = new Map();
  for (const rec of components) {
    if (!isEligibleComponent(rec)) continue;
    const member = { name: rec.name, path: rec.path, source: rec.source };
    const key = resolutionKey(rec);
    const groupKey = `${rec.kind} ${key}`; // kind-prefixed so distinct kinds never merge
    const existing = groups.get(groupKey);
    if (existing) existing.members.push(member);
    else groups.set(groupKey, { kind: rec.kind, key, members: [member] });
  }
  return groups;
}

/**
 * A record is eligible iff its `kind` is skill/agent/command and it sits in a
 * LOADED tier: 'user', or 'plugin'. For a NAMESPACED kind (skill/command) a plugin
 * record additionally needs a non-empty `source.plugin`: without it resolutionKey
 * would fall back to the FLAT name and collide with a user component — the exact
 * false positive the verified namespacing rule forbids (the generalized HIGH-1
 * guard). For a FLAT kind (agent) a plugin record without `source.plugin` is still
 * eligible: its key is the flat name anyway, so it can legitimately collide.
 * @param {unknown} rec
 * @returns {rec is ComponentRecord}
 */
function isEligibleComponent(rec) {
  if (!rec || typeof rec !== 'object') return false;
  const r = /** @type {Record<string, unknown>} */ (rec);
  const rule = typeof r.kind === 'string' ? KIND_RULES[r.kind] : undefined;
  if (!rule) return false;
  if (typeof r.name !== 'string') return false; // name is the loader identity / resolution key — must be a string
  const src = r.source;
  if (!src || typeof src !== 'object') return false;
  const s = /** @type {Record<string, unknown>} */ (src);
  if (s.tier === 'user') return true;
  if (s.tier !== 'plugin') return false;
  if (!rule.namespacePlugins) return true; // flat kind: plugin name not required
  return typeof s.plugin === 'string' && s.plugin.length > 0;
}

/**
 * Compute a component's Claude Code resolution key. For a namespaced kind
 * (skill/command) a plugin component is `pluginName:name`; everything else is FLAT
 * (`name`). This is the rule that prevents the user-vs-plugin false positive for
 * skills/commands (their keys differ by construction), while agents stay flat so
 * user-vs-plugin agents legitimately share a key.
 * @param {ComponentRecord} rec
 * @returns {string}
 */
function resolutionKey(rec) {
  const { source, name, kind } = rec;
  const rule = KIND_RULES[kind];
  if (rule && rule.namespacePlugins && source.tier === 'plugin'
      && typeof source.plugin === 'string' && source.plugin.length > 0) {
    return `${source.plugin}:${name}`;
  }
  return name;
}

/**
 * Local precedence rank for a member of the given kind (lower wins). See the
 * KIND_RULES / TODO(P1.U14): vertical-slice debt to be replaced by load-order.mjs.
 * @param {ComponentKind} kind
 * @param {Source} source
 * @returns {number}
 */
function rank(kind, source) {
  const rule = KIND_RULES[kind];
  return (rule && rule.ranks[source.tier]) ?? UNKNOWN_RANK;
}

/**
 * Rank cluster members deterministically (winner first). Primary key is the
 * per-kind precedence rank; ties (e.g. plugin-vs-plugin, or user-vs-plugin agents
 * never tie but plugin-vs-plugin do) break by marketplace, then version, then path
 * — all code-unit string compares — so `likelyWinner` is stable across runs
 * regardless of discovery order. Does not mutate the input.
 * @param {ComponentKind} kind
 * @param {ConflictMember[]} members
 * @returns {ConflictMember[]}
 */
function rankMembers(kind, members) {
  return members.slice().sort((a, b) => {
    const ra = rank(kind, a.source);
    const rb = rank(kind, b.source);
    if (ra !== rb) return ra - rb;
    return cmp(a.source.marketplace, b.source.marketplace)
      || cmp(a.source.version, b.source.version)
      || cmp(a.path, b.path);
  });
}

/**
 * Code-unit compare treating undefined as the empty string, so optional Source
 * fields tiebreak deterministically.
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
  const ranked = rankMembers(kind, members);
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
