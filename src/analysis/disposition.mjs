/**
 * Conflict-disposition advice engine (P5.U10).
 *
 * For each shadowing conflict cluster the `conflicts` command already detects,
 * this overlays an ACTIONABLE, rule-backed, cited DISPOSITION: it names the
 * loader winner, the shadowed losers, and how to resolve the shadow — honestly
 * distinguishing losers `remove` CAN delete (user-tier) from plugin/catalog/
 * marketplace-copy losers it cannot.
 *
 * Pure analysis, gate-safe: ZERO runtime imports beyond the bundled
 * best-practice-rules JSON (imported `with { type: 'json' }`, the
 * secrets-allowlist / advice.mjs precedent — static data bundling, NOT I/O, so
 * the P5.U1 zero-network gate stays green). The actual disposition WRITE is the
 * user running the EXISTING gated `remove <kind>:<name>` (or disabling/
 * uninstalling a plugin) — U10 builds NO write machinery.
 *
 * --- Removability (honest) ---
 * A shadowed loser is removable by `remove` IFF `source.tier === 'user'` (a
 * user-tier single-file agent/command or a skill dir). Plugin/catalog/
 * marketplace-copy tiers are OUT of `remove`'s scope → `removable:false`,
 * `removeCommand:null`, and the suggestion says the loser is provided by a
 * plugin — disable/uninstall to resolve (never suggest a `remove` that refuses).
 *
 * --- Citation / bilingual join ---
 * Pick the rule by kind: `agent` → `advice-agent-shadowing` (docUrl …/sub-agents);
 * `skill`/`command` → `advice-component-shadowing` (docUrl …/skills). Emit the
 * rule's `id` as `ruleId` so a consumer (TUI/MCP) can join to the B1
 * `titleZh/adviceZh/fixZh` for Chinese rendering — U10 itself stays English
 * (engine-data convention). When the matching rule is absent from the pack,
 * `ruleId` is still set but `docUrl`/`docVersion` fall back to null.
 *
 * --- Junk tolerance / purity ---
 * Never throws: a non-array `conflicts`, a malformed cluster, or junk top-level
 * input degrades to `{dispositions:[], summary:{0,0,0}, diagnostics:[]}`; a
 * malformed cluster is skipped (clusters missing a winner contribute nothing).
 * Deterministic: dispositions sorted by `(kind, key)`; each `shadowed` sorted by
 * `path`. Inputs are never mutated. Proto-safe: the rule lookup uses a
 * null-prototype index keyed by id.
 *
 * @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic
 * @typedef {import('../lib/source.mjs').Source} Source
 * @typedef {import('./conflicts.mjs').ConflictCluster} ConflictCluster
 * @typedef {import('./conflicts.mjs').ConflictMember} ConflictMember
 */

import BUNDLED_RULE_PACK from '../config/best-practice-rules.json' with { type: 'json' };

/**
 * @typedef {Object} ShadowedRecord
 * @property {unknown} name
 * @property {unknown} path
 * @property {unknown} tier
 * @property {string|null} plugin
 * @property {boolean} removable      true iff source.tier === 'user'
 * @property {string|null} removeCommand  `remove <kind>:<name>` when removable, else null
 */

/**
 * @typedef {Object} DispositionRecord
 * @property {unknown} kind
 * @property {unknown} key
 * @property {unknown} severity
 * @property {{name: unknown, path: unknown, tier: unknown, plugin: string|null}} winner
 * @property {ShadowedRecord[]} shadowed
 * @property {string} suggestion
 * @property {string} ruleId
 * @property {string|null} docUrl
 * @property {string|null} docVersion
 */

/** Code-unit string compare (locale-independent; mirrors advice.mjs cmp). */
function cmp(a, b) {
  const x = a ?? '';
  const y = b ?? '';
  return x < y ? -1 : x > y ? 1 : 0;
}

/** @param {unknown} v @returns {unknown[]} v when it is an array, else [] */
function arr(v) {
  return Array.isArray(v) ? v : [];
}

/** @param {unknown} v @returns {boolean} non-empty string */
function nes(v) {
  return typeof v === 'string' && v.length > 0;
}

/**
 * The rule id cited for a given component kind (header citation contract).
 * @param {unknown} kind @returns {string}
 */
function ruleIdFor(kind) {
  return kind === 'agent' ? 'advice-agent-shadowing' : 'advice-component-shadowing';
}

/**
 * Build a proto-safe id → rule index from the rule list (so docUrl/docVersion can
 * be looked up by `ruleId` without prototype-pollution from a hostile id).
 * @param {unknown} rules @returns {Record<string, any>}
 */
function indexRules(rules) {
  /** @type {Record<string, any>} */
  const byId = Object.create(null);
  for (const r of arr(rules)) {
    if (r && typeof r === 'object' && nes(/** @type {any} */ (r).id)) byId[/** @type {any} */ (r).id] = r;
  }
  return byId;
}

/**
 * Map a ConflictMember to its winner-shape `{name, path, tier, plugin}` (plugin
 * coerced to a string or null). Total — a malformed member yields undefined fields.
 * @param {any} m @returns {{name: unknown, path: unknown, tier: unknown, plugin: string|null}}
 */
function winnerOf(m) {
  const src = m && typeof m === 'object' ? m.source : undefined;
  const s = src && typeof src === 'object' ? src : {};
  return { name: m && m.name, path: m && m.path, tier: s.tier, plugin: nes(s.plugin) ? s.plugin : null };
}

/**
 * Map a loser member to a ShadowedRecord: removable IFF tier === 'user'.
 * @param {any} m @param {unknown} kind @returns {ShadowedRecord}
 */
function shadowedOf(m, kind) {
  const w = winnerOf(m);
  const removable = w.tier === 'user';
  const removeCommand = removable && nes(w.name) ? `remove ${kind}:${w.name}` : null;
  return { name: w.name, path: w.path, tier: w.tier, plugin: w.plugin, removable, removeCommand };
}

/**
 * Compose the English suggestion sentence (header template). When ANY loser is
 * removable it shows the first removable loser's `remove` command; when ALL losers
 * are plugin/catalog/marketplace-copy it names the sorted unique plugin list and
 * advises disable/uninstall. `docUrl` is appended as a parenthetical when present.
 * @param {any} winner @param {ShadowedRecord[]} shadowed @param {string|null} docUrl
 * @returns {string}
 */
function suggestionFor(winner, shadowed, docUrl) {
  const n = shadowed.length;
  const copies = n === 1 ? 'copy' : 'copies';
  const head = `The loader keeps ${winner.path}; ${n} shadowed ${copies} not loaded.`;
  const see = nes(docUrl) ? ` (See ${docUrl}.)` : '';
  const firstRemovable = shadowed.find((s) => s.removable && nes(s.removeCommand));
  if (firstRemovable) {
    return `${head} Remove a shadowed user-tier copy: \`${firstRemovable.removeCommand}\`.${see}`;
  }
  const plugins = [...new Set(shadowed.map((s) => s.plugin).filter(nes))].sort(cmp);
  const list = plugins.length > 0 ? plugins.join(', ') : '(unknown)';
  return `${head} They are provided by plugin(s) ${list} — disable or uninstall to resolve.${see}`;
}

/**
 * Build one DispositionRecord from a cluster, or null when the cluster has no
 * usable winner (malformed → skipped per the header).
 * @param {any} cluster @param {Record<string, any>} byId @returns {DispositionRecord|null}
 */
function buildDisposition(cluster, byId) {
  if (!cluster || typeof cluster !== 'object') return null;
  const likely = cluster.likelyWinner;
  if (!likely || typeof likely !== 'object') return null;
  const kind = cluster.kind;
  const ruleId = ruleIdFor(kind);
  const rule = byId[ruleId];
  const docUrl = rule && nes(rule.docUrl) ? rule.docUrl : null;
  const docVersion = rule && nes(rule.docVersion) ? rule.docVersion : null;
  const shadowed = arr(cluster.possibleWinners).slice(1).map((m) => shadowedOf(m, kind)).sort((a, b) => cmp(a.path, b.path));
  const winner = winnerOf(likely);
  return {
    kind, key: cluster.key, severity: cluster.severity,
    winner, shadowed,
    suggestion: suggestionFor(winner, shadowed, docUrl),
    ruleId, docUrl, docVersion,
  };
}

/**
 * Overlay disposition advice on the already-detected conflict clusters. Pure;
 * never throws; inputs never mutated. `rules` is the injectable seam overriding
 * the bundled pack (defaults to the bundled best-practice-rules pack).
 *
 * @param {{ conflicts?: ConflictCluster[], rules?: any[] }} [input]
 * @returns {{ dispositions: DispositionRecord[],
 *             summary: { clusters: number, removableLosers: number, advisoryLosers: number },
 *             diagnostics: Diagnostic[] }}
 */
export function analyzeDisposition(input = {}) {
  try {
    const { conflicts, rules } = input ?? {};
    const ruleList = Array.isArray(rules) ? rules : arr(/** @type {any} */ (BUNDLED_RULE_PACK)?.rules);
    const byId = indexRules(ruleList);

    /** @type {DispositionRecord[]} */
    const dispositions = [];
    for (const cluster of arr(conflicts)) {
      const d = buildDisposition(cluster, byId);
      if (d) dispositions.push(d);
    }
    dispositions.sort((a, b) => cmp(a.kind, b.kind) || cmp(a.key, b.key));

    let removableLosers = 0;
    let advisoryLosers = 0;
    for (const d of dispositions) {
      for (const s of d.shadowed) (s.removable ? removableLosers += 1 : advisoryLosers += 1);
    }
    return { dispositions, summary: { clusters: dispositions.length, removableLosers, advisoryLosers }, diagnostics: [] };
  } catch {
    // Never-throws backstop (header): hostile input degrades to an empty result.
    return { dispositions: [], summary: { clusters: 0, removableLosers: 0, advisoryLosers: 0 }, diagnostics: [] };
  }
}
