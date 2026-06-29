/**
 * Source / provenance typedef for harness-mgr.
 *
 * Every discovered component (skill, agent, command, hook, plugin, setting)
 * carries a Source describing WHERE it came from, so analysis can compute
 * precedence and shadowing per the verified loader rules.
 *
 * Tiers (per plan, line 225):
 *   - 'user'             — lives directly under the governed ~/.claude (or its
 *                          CLAUDE_CONFIG_DIR override).
 *   - 'plugin'           — contributed by an enabled plugin; `plugin` names it
 *                          and `marketplace` names the marketplace it came from.
 *   - 'catalog'          — known to a marketplace catalog but not necessarily
 *                          installed/enabled.
 *   - 'marketplace-copy' — a cached/vendored copy under plugins/marketplaces/**.
 *
 * Zero dependencies. Typedef + tiny pure helpers only; never throws.
 */

/**
 * @typedef {'user'|'plugin'|'catalog'|'marketplace-copy'} SourceTier
 */

/**
 * @typedef {Object} Source
 * @property {SourceTier} tier        provenance tier
 * @property {string} [marketplace]   marketplace name (plugin/catalog/marketplace-copy)
 * @property {string} [plugin]        plugin name (when tier === 'plugin')
 * @property {string} [version]       plugin/marketplace version, when known
 */

/** The valid tiers, in declaration order. */
export const SOURCE_TIERS = Object.freeze(['user', 'plugin', 'catalog', 'marketplace-copy']);

/**
 * @param {unknown} t
 * @returns {t is SourceTier}
 */
export function isSourceTier(t) {
  return typeof t === 'string' && SOURCE_TIERS.includes(/** @type {SourceTier} */ (t));
}

/**
 * Build a Source, defaulting an unknown/missing tier to 'user' (the common case
 * for the read-mostly governance CLI). Pure; never throws. Optional fields are
 * only set when present so serialized output stays minimal.
 *
 * @param {Partial<Source>} [input]
 * @returns {Source}
 */
export function makeSource(input) {
  const tier = input && isSourceTier(input.tier) ? input.tier : 'user';
  /** @type {Source} */
  const s = { tier };
  if (input && typeof input.marketplace === 'string') s.marketplace = input.marketplace;
  if (input && typeof input.plugin === 'string') s.plugin = input.plugin;
  if (input && typeof input.version === 'string') s.version = input.version;
  return s;
}
