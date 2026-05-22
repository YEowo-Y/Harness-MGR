/**
 * Settings-merge resolver (P1.U13 sub-unit B).
 *
 * Computes the EFFECTIVE settings object from an ordered stack of settings
 * layers (LOWEST→HIGHEST precedence), applying the verified per-key merge
 * strategies of Claude Code's `settingsMergeCustomizer` (CC 2.1.x). Returns a
 * deterministic `{effective, keys, diagnostics}`. NEVER throws (the scanner
 * contract from diagnostic.mjs: any bad input degrades to a Diagnostic).
 *
 * --- Verified per-key merge rules (authoritative for this unit) ---
 *   permissions.allow / .ask / .deny  — array UNION across layers (dedup,
 *                                        first-seen order preserved). Other
 *                                        permissions subkeys → highest-wins.
 *   hooks.<event>                      — per-event array CONCATENATION in layer
 *                                        order (no dedup in Phase 1).
 *   enabledPlugins                     — object merge, later layer wins per key.
 *   env                                — object merge, later layer wins per key.
 *   model / outputStyle /
 *     cleanupPeriodDays /
 *     includeCoAuthoredBy             — scalar; highest layer that defines it wins.
 *   ANY other top-level key            — mergeConfidence 'unknown': no effective
 *                                        value is fabricated; the raw per-layer
 *                                        values are recorded instead.
 *
 * Phase-1 note: the verified `settingsMergeCustomizer` additionally DEDUPS hooks
 * by a `hookDedupKey`. Phase 1 deliberately uses plain per-event concat; the
 * dedup is a documented Phase-2 refinement and is NOT implemented here.
 *
 * --- Pure module, by design ---
 * Takes the layer stack explicitly; depends only on the Diagnostic typedef +
 * DiagnosticBag. No filesystem, no async, trivially testable. The CLI boundary
 * (P1.U15) assembles the ordered layers from real settings files at runtime.
 *
 * Zero npm dependencies. Node stdlib only. Never throws.
 */

import { DiagnosticBag } from '../lib/diagnostic.mjs';

/**
 * @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic
 */

/**
 * One settings layer. `name` labels the layer for per-layer reporting (e.g.
 * 'user', 'project', 'local'); `settings` is the raw parsed object. A layer
 * whose `settings` is not an object is skipped (never throws).
 *
 * @typedef {Object} SettingsLayer
 * @property {string} name
 * @property {object} settings
 */

/**
 * The merge outcome for a single top-level key. KNOWN keys carry a computed
 * `value`; UNKNOWN keys instead carry `perLayer` — the raw value each layer
 * contributed, in layer order — and never fabricate an effective value.
 *
 * @typedef {Object} KeyMerge
 * @property {string} key
 * @property {'permissions-merge'|'hooks-concat'|'object-merge'|'scalar-highest'|'unknown'} strategy
 * @property {'known'|'unknown'} mergeConfidence
 * @property {unknown} [value]                       present for KNOWN keys
 * @property {{name:string,value:unknown}[]} [perLayer]  present for UNKNOWN keys
 */

/**
 * @typedef {Object} MergeResult
 * @property {Record<string, unknown>} effective   merged values for KNOWN keys only
 * @property {Record<string, KeyMerge>} keys
 * @property {Diagnostic[]} diagnostics
 */

/**
 * Top-level key → merge strategy. The KNOWN universe; anything absent here is
 * treated as 'unknown' (no effective value fabricated — see file header).
 */
const KNOWN_MERGE_RULES = Object.freeze({
  permissions: 'permissions-merge',
  hooks: 'hooks-concat',
  enabledPlugins: 'object-merge',
  env: 'object-merge',
  model: 'scalar-highest',
  outputStyle: 'scalar-highest',
  cleanupPeriodDays: 'scalar-highest',
  includeCoAuthoredBy: 'scalar-highest',
});

/** Permissions subkeys merged by array-union; every other subkey is highest-wins. */
const PERMISSION_UNION_KEYS = Object.freeze(['allow', 'ask', 'deny']);

/**
 * Resolve the effective settings from an ordered layer stack.
 *
 * @param {SettingsLayer[]} layers   ordered LOWEST→HIGHEST precedence
 * @returns {MergeResult}
 */
export function mergeSettings(layers) {
  const bag = new DiagnosticBag();

  if (!Array.isArray(layers)) {
    bag.add({ severity: 'error', code: 'settings-merge-bad-input', message: 'layers must be an array', phase: 'settings-merge' });
    return { effective: {}, keys: {}, diagnostics: bag.all() };
  }

  // Keep only layers whose `settings` is a real object; skip the rest silently.
  const valid = layers.filter((l) => l && typeof l === 'object' && isPlainObject(l.settings));

  /** @type {Record<string, unknown>} */
  const effective = {};
  /** @type {Record<string, KeyMerge>} */
  const keys = {};

  for (const key of unionTopKeys(valid)) {
    const km = mergeKey(key, valid);
    keys[key] = km;
    if (km.mergeConfidence === 'known') effective[key] = km.value;
  }

  return { effective, keys, diagnostics: bag.all() };
}

/**
 * Top-level keys across all valid layers, ordered by first appearance (lower
 * layers first) so output is deterministic for a given layer stack.
 * @param {SettingsLayer[]} valid
 * @returns {string[]}
 */
function unionTopKeys(valid) {
  /** @type {string[]} */
  const order = [];
  const seen = new Set();
  for (const layer of valid) {
    for (const key of Object.keys(layer.settings)) {
      if (!isSafeKey(key) || seen.has(key)) continue; // skip __proto__/constructor/prototype + dupes
      seen.add(key); order.push(key);
    }
  }
  return order;
}

/**
 * Compute the KeyMerge for one top-level key by dispatching on its strategy.
 * Unknown keys record raw per-layer values and fabricate no effective value.
 * @param {string} key
 * @param {SettingsLayer[]} valid
 * @returns {KeyMerge}
 */
function mergeKey(key, valid) {
  const strategy = KNOWN_MERGE_RULES[key] ?? 'unknown';
  const present = valid.filter((l) => Object.prototype.hasOwnProperty.call(l.settings, key));
  switch (strategy) {
    case 'permissions-merge': return { key, strategy, mergeConfidence: 'known', value: mergePermissions(present, key) };
    case 'hooks-concat': return { key, strategy, mergeConfidence: 'known', value: mergeHooks(present, key) };
    case 'object-merge': return { key, strategy, mergeConfidence: 'known', value: mergeObjects(present, key) };
    case 'scalar-highest': {
      const top = present[present.length - 1]; // highest layer that defines the key
      return { key, strategy, mergeConfidence: 'known', value: top ? top.settings[key] : undefined };
    }
    default: return { key, strategy: 'unknown', mergeConfidence: 'unknown', perLayer: present.map((l) => ({ name: layerName(l), value: l.settings[key] })) };
  }
}

/**
 * Merge `permissions`: allow/ask/deny are array-union (first-seen order); any
 * other subkey is highest-layer-wins. A non-object layer value contributes
 * nothing (Phase 1 tolerates malformed shapes rather than throwing).
 * @param {SettingsLayer[]} present
 * @param {string} key
 * @returns {Record<string, unknown>}
 */
function mergePermissions(present, key) {
  /** @type {Record<string, unknown>} */
  const out = {};
  /** @type {Record<string, unknown[]>} */
  const unions = {};
  for (const layer of present) {
    const perms = layer.settings[key];
    if (!isPlainObject(perms)) continue;
    for (const subKey of Object.keys(perms)) {
      if (!isSafeKey(subKey)) continue;
      if (PERMISSION_UNION_KEYS.includes(subKey)) {
        unions[subKey] = unionArrays(unions[subKey] ?? [], perms[subKey]);
      } else {
        out[subKey] = perms[subKey]; // highest-wins: later layer overwrites
      }
    }
  }
  for (const subKey of Object.keys(unions)) out[subKey] = unions[subKey];
  return out;
}

/**
 * Merge `hooks`: per-event array CONCATENATION in layer order (no dedup in
 * Phase 1 — see file header). Non-array event values are coerced to an empty
 * contribution so a malformed layer cannot throw.
 * @param {SettingsLayer[]} present
 * @param {string} key
 * @returns {Record<string, unknown[]>}
 */
function mergeHooks(present, key) {
  /** @type {Record<string, unknown[]>} */
  const out = {};
  for (const layer of present) {
    const hooks = layer.settings[key];
    if (!isPlainObject(hooks)) continue;
    for (const event of Object.keys(hooks)) {
      if (!isSafeKey(event)) continue;
      const arr = Array.isArray(hooks[event]) ? hooks[event] : [];
      out[event] = (out[event] ?? []).concat(arr);
    }
  }
  return out;
}

/**
 * Object-merge (`env`, `enabledPlugins`): shallow per-key assign in layer order
 * so the later (higher) layer wins each key. Non-object layer values skipped.
 * @param {SettingsLayer[]} present
 * @param {string} key
 * @returns {Record<string, unknown>}
 */
function mergeObjects(present, key) {
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const layer of present) {
    const obj = layer.settings[key];
    if (!isPlainObject(obj)) continue;
    for (const k of Object.keys(obj)) { if (isSafeKey(k)) out[k] = obj[k]; }
  }
  return out;
}

/**
 * Append `next`'s array items to `acc`, dropping values already present so the
 * union is dedup'd while the FIRST occurrence keeps its position. A non-array
 * `next` contributes nothing. Returns a new array (does not mutate `acc`).
 * @param {unknown[]} acc
 * @param {unknown} next
 * @returns {unknown[]}
 */
function unionArrays(acc, next) {
  const out = acc.slice();
  if (!Array.isArray(next)) return out;
  for (const item of next) {
    if (!out.includes(item)) out.push(item);
  }
  return out;
}

/**
 * True for a non-null, non-array plain object (the shape every merge helper
 * expects). Guards against null, arrays, and primitives without throwing.
 * @param {unknown} v
 * @returns {v is Record<string, unknown>}
 */
function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Reject keys that could poison a result object's prototype when assigned via
 * bracket notation (`__proto__`, `constructor`, `prototype`). Settings come from
 * user-controlled JSON (where `JSON.parse` makes `__proto__` an OWN key), so a
 * malformed/hostile key must never reach an output object. Mirrors the null-proto
 * hardening applied to frontmatter.mjs.
 * @param {string} key
 * @returns {boolean}
 */
function isSafeKey(key) {
  return key !== '__proto__' && key !== 'constructor' && key !== 'prototype';
}

/**
 * A layer's reporting name, coerced to a string so per-layer records are
 * well-formed even if a caller passes a non-string `name`.
 * @param {SettingsLayer} layer
 * @returns {string}
 */
function layerName(layer) {
  return typeof layer.name === 'string' ? layer.name : String(layer.name ?? '');
}
