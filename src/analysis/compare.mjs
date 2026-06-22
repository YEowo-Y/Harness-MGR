/**
 * Cross-target comparison analysis (mainline, post-v5 increment).
 *
 * Pure: takes per-target scanned data explicitly; no filesystem, no async, no
 * throws. Answers "which skills / agents / commands / MCP servers / plugins exist
 * on which target" by joining on a per-category key:
 *   - skill / agent / command : the component `name`
 *   - mcp                     : the server `name`
 *   - plugin                  : the `name@marketplace` `key` (name alone collides
 *                               across marketplaces)
 *
 * The match is by NAME ONLY: 'both' means the same name exists on each target, NOT
 * that the content is identical (the honesty caveat the command surfaces as
 * `compare-name-match-not-content`).
 *
 * `items` lists ONLY divergences (a key present on a strict SUBSET of the targets).
 * The shared bulk is summarised by the per-category counts, and the full per-target
 * inventory is available via `inventory --target <id>` — so the report answers
 * "what differs" without re-dumping everything that is the same.
 *
 * Zero npm dependencies. Node stdlib only. Never throws.
 */

import { DiagnosticBag } from '../lib/diagnostic.mjs';

/**
 * @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic
 */

/**
 * @typedef {Object} CompareSide
 * @property {string} id      target id ('claude'|'codex')
 * @property {string} label   human label
 * @property {import('../discovery/components.mjs').ComponentRecord[]} components
 * @property {import('../discovery/plugins.mjs').PluginRecord[]} plugins
 * @property {import('../discovery/mcp.mjs').McpServerRecord[]} mcpServers
 */

/**
 * The honesty caveat: a name match is NOT a content match. Always emitted so a
 * 'both' count is never read as "identical implementation".
 * @type {Readonly<Diagnostic>}
 */
const NAME_NOT_CONTENT_CAVEAT = Object.freeze({
  severity: 'info',
  code: 'compare-name-match-not-content',
  phase: 'compare',
  message: "Matches are by name only: 'both' means the same name exists on each target, not that the content is identical. Components match by (kind, name); plugins by name@marketplace. Note codex agents/commands are keyed by filename while claude agents may use their frontmatter name -- so an agent-category divergence can still be the same logical agent under a different name.",
});

/**
 * The compared categories, in display order. Each `pick(side)` returns a
 * `Map<key, displayName>` of that side's distinct keys for the category (a Map
 * dedupes a name that appears more than once on one side — e.g. a codex skill
 * present both at home and in a plugin cache).
 */
const CATEGORIES = Object.freeze([
  { category: 'skill', pick: (side) => componentNames(side, 'skill') },
  { category: 'agent', pick: (side) => componentNames(side, 'agent') },
  { category: 'command', pick: (side) => componentNames(side, 'command') },
  { category: 'mcp', pick: (side) => mcpNames(side) },
  { category: 'plugin', pick: (side) => pluginKeys(side) },
]);

/** @param {unknown} v @returns {any[]} */
function arr(v) { return Array.isArray(v) ? v : []; }

/** A locale-independent, deterministic string comparator. @param {string} a @param {string} b @returns {number} */
function cmp(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

/**
 * Distinct component names of one `kind` on a side → Map(name → name). Non-string
 * / empty names are skipped (never a key). @param {unknown} side @param {string} kind
 * @returns {Map<string, string>}
 */
function componentNames(side, kind) {
  const m = new Map();
  for (const c of arr(side && side.components)) {
    if (c && c.kind === kind && typeof c.name === 'string' && c.name.length > 0) m.set(c.name, c.name);
  }
  return m;
}

/** Distinct MCP server names on a side → Map(name → name). @param {unknown} side @returns {Map<string, string>} */
function mcpNames(side) {
  const m = new Map();
  for (const s of arr(side && side.mcpServers)) {
    if (s && typeof s.name === 'string' && s.name.length > 0) m.set(s.name, s.name);
  }
  return m;
}

/**
 * Distinct plugins on a side → Map(key → name). The compare key is `key`
 * (`name@marketplace`) so the same plugin name from two marketplaces stays
 * distinct; the display value is the bare `name` when present, else the key.
 * @param {unknown} side @returns {Map<string, string>}
 */
function pluginKeys(side) {
  const m = new Map();
  for (const p of arr(side && side.plugins)) {
    if (!p || typeof p.key !== 'string' || p.key.length === 0) continue;
    m.set(p.key, typeof p.name === 'string' && p.name.length > 0 ? p.name : p.key);
  }
  return m;
}

/**
 * Compare component/plugin/mcp presence across N target sides.
 *
 * @param {CompareSide[]} sides   the scanned data per target (active first)
 * @returns {{ summary: { targets: object[], categories: object[], items: object[] }, diagnostics: Diagnostic[] }}
 */
export function analyzeCompare(sides) {
  const bag = new DiagnosticBag();
  const list = arr(sides).filter((s) => s && typeof s === 'object');
  const targets = list.map((s) => ({
    id: typeof s.id === 'string' ? s.id : '?',
    label: typeof s.label === 'string' ? s.label : (typeof s.id === 'string' ? s.id : '?'),
    total: 0,
  }));

  const categories = [];
  const items = [];

  for (const cat of CATEGORIES) {
    const maps = list.map((s) => cat.pick(s)); // Map per side, aligned to `targets`
    const allKeys = new Set();
    for (const m of maps) for (const k of m.keys()) allKeys.add(k);

    const totals = {};
    const only = {};
    for (let i = 0; i < targets.length; i++) {
      totals[targets[i].id] = maps[i].size;
      only[targets[i].id] = 0;
      targets[i].total += maps[i].size;
    }

    let both = 0;
    for (const key of [...allKeys].sort(cmp)) {
      const inIdx = [];
      for (let i = 0; i < maps.length; i++) if (maps[i].has(key)) inIdx.push(i);
      // Present on EVERY target → shared, not a divergence (summarised by `both`).
      if (inIdx.length === maps.length && maps.length > 0) { both++; continue; }
      if (inIdx.length === 1) only[targets[inIdx[0]].id]++;
      const inIds = inIdx.map((i) => targets[i].id);
      const presence = inIdx.length === 1 ? `${inIds[0]}-only` : inIds.join('+');
      items.push({ category: cat.category, key, name: maps[inIdx[0]].get(key), presence, in: inIds });
    }

    categories.push({ category: cat.category, totals, both, only });
  }

  bag.add(NAME_NOT_CONTENT_CAVEAT);
  // `items` is already in (category-order, key-order): categories iterate in fixed
  // order and keys are sorted within each category.
  return { summary: { targets, categories, items }, diagnostics: bag.all() };
}
