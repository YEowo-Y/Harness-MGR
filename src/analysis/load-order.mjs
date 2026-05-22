/**
 * Component load-order / precedence model (P1.U14) — the SINGLE SOURCE OF TRUTH.
 *
 * This module encodes, ONCE, the verified Claude Code rules that decide which copy
 * of a same-named component the loader actually resolves. It is a cross-phase
 * invariant: conflicts.mjs (shadow analysis) and the CLI both CONSUME the ranking
 * defined here so two precedence tables can never drift out of sync. Earlier units
 * carried a LOCAL copy of these rules in conflicts.mjs as deliberate vertical-slice
 * debt; that copy is to be deleted in favour of importing from here.
 *
 * --- The three kinds resolve DIFFERENTLY (verified, authoritative) ---
 *   - SKILLS & COMMANDS: FIRST-MATCH. Only PLUGIN components are namespaced as
 *     `pluginName:name`; user/project are FLAT. So a user skill `foo` and a plugin
 *     skill `foo` do NOT collide (keys differ: `foo` vs `plugin:foo`). Among
 *     EQUAL-precedence candidates (e.g. the same plugin from two marketplaces, both
 *     `plugin:foo`) the FIRST one loaded wins — hence `winsBy: 'first'`.
 *   - AGENTS: FLAT namespace for ALL tiers, an ordered Map with LAST-WRITE-WINS,
 *     precedence built-in < plugin < user < project < flag < managed. A user agent
 *     beats a plugin agent. Among EQUAL-precedence candidates (e.g. two plugin
 *     agents) the LAST one written wins — hence `winsBy: 'last'`.
 *
 * `ranks` give a "lower number = wins" precedence; the agent built-in last-write-
 * wins order is INVERTED to lower=wins so user (3) beats plugin (4) uniformly with
 * the skill/command first-match ranks. `winsBy` then decides which END of an
 * EQUAL-rank group is the winner (see rankComponents): the rank settles ACROSS
 * tiers, `winsBy` settles WITHIN one tier where the loader's own ordering applies.
 *
 * --- Confidence rationale (the 2.1.x version guard) ---
 * These rules are verified against the Claude Code 2.1.x minor line. The exact
 * inter-plugin load order is loader-internal, so even on a verified version we
 * report a `likelyWinner` rather than asserting a guaranteed `winner`. When the
 * running version is unknown, or is OUTSIDE 2.1.x, the precedence MAY differ; the
 * guard downgrades confidence to 'likely' and emits a Diagnostic so callers (and
 * the user) know the answer is best-effort, not verified. See loaderConfidence.
 *
 * --- Pure module, by design ---
 * No filesystem, no async; depends only on the Source/Diagnostic typedefs. Inputs
 * are never mutated. Every export is total and NEVER throws — bad input degrades to
 * a stable, safe result (an empty/unranked order, or 'likely' confidence).
 *
 * Zero npm dependencies. Node stdlib only.
 */

/**
 * @typedef {import('../lib/source.mjs').Source} Source
 * @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic
 * @typedef {import('../discovery/components.mjs').ComponentRecord} ComponentRecord
 * @typedef {import('../discovery/components.mjs').ComponentKind} ComponentKind
 */

/**
 * The Claude Code MINOR line these loader rules were VERIFIED against. The version
 * guard (loaderConfidence) treats any `2.1.x` patch as verified and everything else
 * as merely 'likely'.
 */
export const VERIFIED_CC_MINOR = '2.1';

/**
 * Per-kind precedence model — the authoritative table.
 *
 * - `namespacePlugins`: do plugin components get the `plugin:name` namespace?
 *   (skills/commands yes, agents no). Decides the resolution-key SHAPE.
 * - `ranks`: lower number WINS (the resolved/effective copy). Skill/command ranks
 *   mirror the first-match order (user's dir checked before plugin dirs). Agent
 *   ranks INVERT the built-in last-write-wins precedence into lower=wins so user (3)
 *   beats plugin (4).
 * - `winsBy`: which end of an EQUAL-rank group wins. 'first' = first-inserted
 *   (first-match kinds: skills/commands); 'last' = last-inserted (last-write-wins
 *   agents). This is the WITHIN-tier tiebreak the loader itself applies; it only
 *   matters when two members share a rank (e.g. plugin-vs-plugin).
 */
export const KIND_RULES = Object.freeze({
  skill: Object.freeze({ namespacePlugins: true, ranks: Object.freeze({ user: 3, plugin: 7 }), winsBy: 'first' }),
  command: Object.freeze({ namespacePlugins: true, ranks: Object.freeze({ user: 3, plugin: 6 }), winsBy: 'first' }),
  agent: Object.freeze({ namespacePlugins: false, ranks: Object.freeze({ user: 3, plugin: 4 }), winsBy: 'last' }),
});

/**
 * Rank used for any tier not modeled in a kind's `ranks` (e.g. catalog), or for an
 * unknown kind; sorts AFTER every known tier so unmodeled members never spuriously
 * win. A total fallback that keeps rankComponents from ever throwing.
 */
export const UNKNOWN_RANK = 99;

/**
 * Regex matching the verified `2.1.x` minor line: `2.1` or `2.1.<digits>`. Requires
 * a NUMERIC patch so `2.1.x` (literal placeholder) and a trailing-dot `2.1.` are
 * rejected; `2.10` is a different minor line and also does NOT match.
 */
const VERIFIED_MINOR_RE = /^2\.1(?:\.\d+)?$/;

/**
 * Compute a component's Claude Code resolution key. For a NAMESPACED kind
 * (skill/command) a plugin component with a non-empty `source.plugin` is
 * `pluginName:name`; everything else is FLAT (`name`). This is the rule that keeps
 * user-vs-plugin skills/commands from colliding (their keys differ by construction)
 * while agents stay flat so user-vs-plugin agents legitimately share a key.
 *
 * @param {ComponentRecord} rec
 * @returns {string}
 */
export function resolutionKey(rec) {
  if (!rec || typeof rec !== 'object') return '';
  const { source, name, kind } = rec;
  if (!source || typeof source !== 'object') return typeof name === 'string' ? name : '';
  const rule = KIND_RULES[kind];
  if (rule && rule.namespacePlugins && source.tier === 'plugin'
      && typeof source.plugin === 'string' && source.plugin.length > 0) {
    return `${source.plugin}:${name}`;
  }
  return typeof name === 'string' ? name : '';
}

/**
 * A record is loadable iff its `kind` is skill/agent/command and it sits in a
 * LOADED tier ('user' or 'plugin'); catalog and marketplace-copy are not the copy
 * the loader resolves. For a NAMESPACED kind (skill/command) a plugin record
 * additionally needs a non-empty `source.plugin`: without it resolutionKey would
 * fall back to the FLAT name and collide with a user component — the false positive
 * the verified namespacing rule forbids. For a FLAT kind (agent) a plugin record
 * without `source.plugin` is still loadable: its key is the flat name anyway.
 *
 * @param {unknown} rec
 * @returns {rec is ComponentRecord}
 */
export function isLoadableComponent(rec) {
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
 * Look up the precedence rank for a tier under the given kind (lower wins). Any tier
 * absent from the kind's `ranks`, and any unknown kind, fall back to UNKNOWN_RANK.
 *
 * @param {string} kind
 * @param {Source} source
 * @returns {number}
 */
function rankOf(kind, source) {
  const rule = KIND_RULES[kind];
  if (!rule) return UNKNOWN_RANK;
  return rule.ranks[source.tier] ?? UNKNOWN_RANK;
}

/**
 * Rank any members of one kind into a NEW array, winner-first.
 *
 * The tiebreaker is ES6 INSERTION ORDER — the member's position in the input array,
 * which mirrors the order the loader itself encountered them. The rank settles
 * precedence ACROSS tiers; for EQUAL ranks the within-tier order is decided by the
 * kind's `winsBy`: 'first' keeps the earliest-inserted at the head (first-match
 * skills/commands), 'last' puts the latest-inserted at the head (last-write-wins
 * agents). The result is a stable, total, deterministic order; the winner is
 * `result[0]`. The input is never mutated; an unknown kind ranks every member as
 * UNKNOWN_RANK (still a stable order — by insertion). Never throws.
 *
 * @template {{source: Source}} T
 * @param {ComponentKind|string} kind
 * @param {T[]} members
 * @returns {T[]} a new array, winner first
 */
export function rankComponents(kind, members) {
  if (!Array.isArray(members)) return [];
  const rule = KIND_RULES[kind];
  // 'last' only for a known last-write-wins kind; an unknown kind defaults to
  // first-inserted so its order is still deterministic.
  const lastWins = rule ? rule.winsBy === 'last' : false;

  // Tag with insertion index so the sort can break ties by original position. A
  // malformed member (null, or missing .source) ranks last (UNKNOWN_RANK) rather
  // than throwing — the module's never-throws contract holds for any input.
  const tagged = members.map((member, index) => ({
    member,
    index,
    rank: member && typeof member === 'object' && member.source ? rankOf(kind, member.source) : UNKNOWN_RANK,
  }));
  tagged.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;            // lower rank wins, across tiers
    return lastWins ? b.index - a.index : a.index - b.index;  // within a tier: last- vs first-inserted
  });
  return tagged.map((t) => t.member);
}

/**
 * The 2.1.x version guard. Reports how much to trust the precedence model for the
 * running Claude Code version, and emits a Diagnostic explaining any downgrade:
 *   - `2.1.x` (the verified minor line) → confidence 'verified', no diagnostics.
 *   - absent (null/undefined/empty, or any non-string) → 'likely' + an INFO
 *     diagnostic (version unknown; we still report a likelyWinner).
 *   - present but NOT 2.1.x (e.g. '2.2.0', '3.0.1') → 'likely' + a WARN diagnostic
 *     (the loader rules may differ on that line).
 * Pure; never throws.
 *
 * @param {string|null|undefined} ccVersion
 * @returns {{confidence: 'verified'|'likely', diagnostics: Diagnostic[]}}
 */
export function loaderConfidence(ccVersion) {
  if (typeof ccVersion !== 'string' || ccVersion.length === 0) {
    return {
      confidence: 'likely',
      diagnostics: [{
        severity: 'info',
        code: 'loader-rules-unverified-version',
        message: 'Claude Code version unknown; reporting likelyWinner (loader rules verified for 2.1.x)',
        phase: 'load-order',
      }],
    };
  }
  if (VERIFIED_MINOR_RE.test(ccVersion)) {
    return { confidence: 'verified', diagnostics: [] };
  }
  return {
    confidence: 'likely',
    diagnostics: [{
      severity: 'warn',
      code: 'loader-rules-unverified-version',
      message: `Claude Code ${ccVersion} is outside the verified 2.1.x line; precedence may differ`,
      phase: 'load-order',
    }],
  };
}
