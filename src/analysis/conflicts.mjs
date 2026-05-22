/**
 * Skill-conflict analysis (P1.U12).
 *
 * Groups discovered SKILL components by their Claude Code resolution key and
 * reports clusters where two or more skills resolve to the SAME key — i.e. one
 * shadows the other and only the first-loaded copy wins. Returns a deterministic
 * `{conflicts, diagnostics}`. NEVER throws (the scanner contract from
 * diagnostic.mjs: any bad input degrades to a Diagnostic, the analysis continues).
 *
 * --- Verified loader rule for SKILLS (authoritative) ---
 * Skill resolution is FIRST-MATCH in this order:
 *   bundled → builtinPluginSkills → skillDir(managed→user→project)
 *           → workflow → pluginCommands → pluginSkills
 * Two facts drive this module:
 *   1. Only PLUGIN components are namespaced as `pluginName:skillName`. User and
 *      project skills are FLAT (just `name`). So a user skill `foo` and a plugin
 *      skill `foo` do NOT collide — their resolution keys differ (`foo` vs
 *      `plugin:foo`). Reporting that pair would be a false positive; we don't.
 *   2. The real skill collision handled here is PLUGIN-vs-PLUGIN: the SAME plugin
 *      name installed from TWO marketplaces both contribute `pluginName:skillName`
 *      → identical key → collision; only the first-loaded copy wins.
 *
 * --- Confidence rationale (Phase 1) ---
 * The exact inter-plugin load order is loader-internal and UNVERIFIED in Phase 1,
 * and the running Claude Code version is unknown here. So we never assert a
 * verified `winner`; we emit a `likelyWinner` with `confidence: 'likely'` for
 * EVERY cluster, ranked deterministically so the answer is stable across runs.
 *
 * --- Scope (P1.U12, deliberately minimal) ---
 * SKILLS ONLY. Records whose `kind !== 'skill'` are ignored (not errored).
 * TODO(P1.U13): agent and command conflict analysis lands in a later unit; agents
 * are a flat last-write-wins Map (different model from skills) and need their own
 * pass. Do not bolt them onto this skill-shaped analyzer.
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
 * A set of >= 2 skills that resolve to the same loader key. `likelyWinner` is the
 * first member after deterministic ranking; `possibleWinners` is the full ranked
 * array (likelyWinner first). `confidence` is always 'likely' in Phase 1 (the
 * inter-plugin load order is unverified — see file header).
 *
 * @typedef {Object} ConflictCluster
 * @property {'skill'} kind
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
 * skillRank positions, mirroring the verified first-match order with the tiers we
 * can observe in Phase 1 (lower wins). user comes before plugin in the resolution
 * chain (skillDir is checked before pluginSkills).
 *
 * TODO(P1.U14): load-order.mjs becomes the SINGLE SOURCE OF TRUTH for precedence
 * (cross-phase invariant: "single-source-of-truth for load-order"). This local
 * table is deliberate vertical-slice debt for U12 and MUST be replaced by
 * importing the ranking from load-order.mjs at U14 — do not let two precedence
 * tables drift apart.
 */
const SKILL_RANK = Object.freeze({ user: 3, plugin: 7 });

/**
 * Rank used for any tier not in SKILL_RANK; sorts after every known tier. See the
 * TODO(P1.U14) on SKILL_RANK — any tier later admitted by isEligibleSkill must also
 * be ranked here, or it will silently sort last.
 */
const UNKNOWN_RANK = 99;

/**
 * Analyze skill components for shadowing conflicts.
 *
 * @param {ComponentRecord[]} components   discovered components (any kind; non-skills ignored)
 * @param {Object} [opts]                   reserved for future options (none in Phase 1)
 * @returns {ConflictResult}
 */
export function analyzeConflicts(components, opts) {
  void opts; // reserved; keeps the signature stable for U13/U14
  const bag = new DiagnosticBag();

  if (!Array.isArray(components)) {
    bag.add({ severity: 'error', code: 'conflicts-bad-input', message: 'components must be an array', phase: 'conflicts' });
    return { conflicts: [], diagnostics: bag.all() };
  }

  /** @type {ConflictCluster[]} */
  const conflicts = [];
  for (const [key, members] of groupByKey(components)) {
    if (members.length < 2) continue; // a unique key is not a conflict
    conflicts.push(buildCluster(key, members, bag));
  }

  // Stable output: sort clusters by key (code-unit compare), locale-independent.
  conflicts.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { conflicts, diagnostics: bag.all() };
}

/**
 * Group eligible skills by resolution key, preserving discovery order within each
 * group (rankMembers later imposes the deterministic winner order). A skill is
 * eligible only if it is a LOADED copy — tier 'user' or 'plugin'; catalog and
 * marketplace-copy are not the copy the loader resolves, so they cannot shadow.
 * @param {ComponentRecord[]} components
 * @returns {Map<string, ConflictMember[]>}
 */
function groupByKey(components) {
  /** @type {Map<string, ConflictMember[]>} */
  const groups = new Map();
  for (const rec of components) {
    if (!isEligibleSkill(rec)) continue;
    const member = { name: rec.name, path: rec.path, source: rec.source };
    const key = resolutionKey(rec);
    const existing = groups.get(key);
    if (existing) existing.push(member);
    else groups.set(key, [member]);
  }
  return groups;
}

/**
 * A record is an eligible skill iff it is a `kind:'skill'` record in a LOADED tier:
 * 'user', or 'plugin' WITH a non-empty `source.plugin`. A plugin skill missing its
 * plugin name cannot be namespaced — resolutionKey would fall back to the FLAT name
 * and collide with a user skill, the exact false positive the verified namespacing
 * rule forbids — so such malformed plugin records are excluded. Non-skills are
 * ignored here (deferred to U13 — see header).
 * @param {unknown} rec
 * @returns {rec is ComponentRecord}
 */
function isEligibleSkill(rec) {
  if (!rec || typeof rec !== 'object') return false;
  const r = /** @type {Record<string, unknown>} */ (rec);
  if (r.kind !== 'skill') return false;
  const src = r.source;
  if (!src || typeof src !== 'object') return false;
  const s = /** @type {Record<string, unknown>} */ (src);
  if (s.tier === 'user') return true;
  if (s.tier === 'plugin') return typeof s.plugin === 'string' && s.plugin.length > 0;
  return false;
}

/**
 * Compute a skill's Claude Code resolution key. Plugin skills are namespaced as
 * `pluginName:skillName`; everything else is FLAT (`name`). This is the rule that
 * prevents the user-vs-plugin false positive (their keys differ by construction).
 * @param {ComponentRecord} rec
 * @returns {string}
 */
function resolutionKey(rec) {
  const { source, name } = rec;
  if (source.tier === 'plugin' && typeof source.plugin === 'string' && source.plugin.length > 0) {
    return `${source.plugin}:${name}`;
  }
  return name;
}

/**
 * Local precedence rank for a member (lower wins). See SKILL_RANK's TODO: this is
 * vertical-slice debt to be replaced by load-order.mjs at U14.
 * @param {Source} source
 * @returns {number}
 */
function skillRank(source) {
  return SKILL_RANK[source.tier] ?? UNKNOWN_RANK;
}

/**
 * Rank cluster members deterministically (winner first). Primary key is the
 * precedence rank; ties (e.g. plugin-vs-plugin, both rank 7) break by marketplace,
 * then version, then path — all code-unit string compares — so `likelyWinner` is
 * stable across runs regardless of discovery order. Does not mutate the input.
 * @param {ConflictMember[]} members
 * @returns {ConflictMember[]}
 */
function rankMembers(members) {
  return members.slice().sort((a, b) => {
    const ra = skillRank(a.source);
    const rb = skillRank(b.source);
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
 * Build one cluster from a key and its (>=2) members, and record the matching
 * flat `skill-shadowing` warn Diagnostic in the bag. The reason names the plugin,
 * the marketplace count, and the marketplace list for plugin-vs-plugin clusters
 * (the common case); other shadowing shapes get a generic-but-accurate sentence.
 * @param {string} key
 * @param {ConflictMember[]} members
 * @param {DiagnosticBag} bag
 * @returns {ConflictCluster}
 */
function buildCluster(key, members, bag) {
  const ranked = rankMembers(members);
  const reason = clusterReason(ranked);
  const fix = 'disable one of the conflicting plugin installs, or they will shadow each other';
  bag.add({ severity: 'warn', code: 'skill-shadowing', message: reason, fix, phase: 'conflicts' });
  return {
    kind: 'skill',
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
 * Compose the human-readable reason for a ranked cluster. When every member is a
 * plugin sharing one plugin name (the verified plugin-vs-plugin case), it reports
 * the marketplace fan-out; otherwise it falls back to a count of copies.
 * @param {ConflictMember[]} ranked
 * @returns {string}
 */
function clusterReason(ranked) {
  const skill = ranked[0].name;
  const plugin = ranked[0].source.plugin;
  const allSamePlugin = typeof plugin === 'string' && plugin.length > 0
    && ranked.every((m) => m.source.tier === 'plugin' && m.source.plugin === plugin);
  if (allSamePlugin) {
    const list = ranked.map((m) => m.source.marketplace ?? '(unknown)').join(', ');
    return `plugin "${plugin}" is installed from ${ranked.length} marketplaces (${list}); `
      + `each provides skill "${skill}" — only the first-loaded wins`;
  }
  return `skill "${skill}" is provided by ${ranked.length} loaded copies — only the first-loaded wins`;
}
