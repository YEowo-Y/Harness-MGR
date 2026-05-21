/**
 * Plugin discovery (P1.U8).
 *
 * Reads `<rootDir>/plugins/installed_plugins.json` (schema version 2) and emits
 * a deterministic `PluginRecord[]` plus a `Diagnostic[]`. NEVER throws.
 *
 * --- Schema-version-first ---
 * The file carries a numeric `version`. Version 2 is the verified shape:
 *   { "version": 2, "plugins": { "<name>@<marketplace>": [ {name, marketplace,
 *     version, enabled}, ... ] } }
 * An UNKNOWN version still parses best-effort (the shape may be compatible) but
 * raises a `warn` so the user knows the read may be partial — this is the
 * "degrade gracefully, never crash on schema drift" rule from the plan. Deeper
 * version policy is the doctor's job (P2.U6 #22 `claude-config-schema-version`).
 *
 * --- enabled vs cachePresent ---
 * `enabled` comes straight from the installed_plugins.json entry. `cachePresent`
 * is whether `<rootDir>/plugins/cache/<marketplace>/<name>/<version>/` exists —
 * enabled plugins routinely lack a cache dir (it is rebuildable), so a missing
 * cache is a FACT recorded here, not a fault. The fault judgment
 * (`plugin-cache-missing`) is a doctor check (P2.U5 #10).
 *
 * --- Pure module ---
 * Takes `rootDir` explicitly; depends only on node:fs / node:path + the shared
 * JSON reader and DiagnosticBag. No reexport, no live-config resolution.
 *
 * Zero npm dependencies. Node stdlib only.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DiagnosticBag } from '../lib/diagnostic.mjs';
import { readJsonFile, isJsonObject } from './read-json.mjs';

/**
 * @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic
 */

/**
 * @typedef {Object} PluginRecord
 * @property {string} key            "<name>@<marketplace>" (the installed_plugins.json key)
 * @property {string} name
 * @property {string} marketplace
 * @property {string} version
 * @property {boolean} enabled
 * @property {boolean} cachePresent  whether plugins/cache/<marketplace>/<name>/<version>/ exists
 */

/**
 * @typedef {Object} PluginDiscoveryResult
 * @property {PluginRecord[]} plugins
 * @property {Diagnostic[]} diagnostics
 */

/** Schema versions of installed_plugins.json this build understands. */
const KNOWN_SCHEMA_VERSIONS = new Set([2]);

/**
 * Discover installed plugins under `rootDir`. A missing installed_plugins.json
 * means "no plugins installed" (silent). Unreadable/malformed JSON, an unknown
 * schema version, and malformed entries all become diagnostics; the scan still
 * returns whatever it could parse.
 *
 * @param {string} rootDir
 * @returns {PluginDiscoveryResult}
 */
export function discoverPlugins(rootDir) {
  const bag = new DiagnosticBag();
  if (typeof rootDir !== 'string' || rootDir.length === 0) {
    bag.add({ severity: 'error', code: 'discover-bad-root', message: 'rootDir must be a non-empty string', phase: 'plugins' });
    return { plugins: [], diagnostics: bag.all() };
  }

  const file = join(rootDir, 'plugins', 'installed_plugins.json');
  const { value, error, missing } = readJsonFile(file);
  if (missing) return { plugins: [], diagnostics: bag.all() };
  if (error) {
    bag.add({ severity: 'error', code: 'installed-plugins-unreadable', message: error, path: file, phase: 'plugins' });
    return { plugins: [], diagnostics: bag.all() };
  }
  if (!isJsonObject(value)) {
    bag.add({ severity: 'warn', code: 'installed-plugins-malformed', message: 'installed_plugins.json is not a JSON object', path: file, phase: 'plugins' });
    return { plugins: [], diagnostics: bag.all() };
  }

  if (!KNOWN_SCHEMA_VERSIONS.has(value.version)) {
    bag.add({
      severity: 'warn',
      code: 'plugin-schema-version-unknown',
      message: `unknown installed_plugins.json schema version: ${value.version === undefined ? '(missing)' : value.version} (known: 2); parsing best-effort`,
      path: file,
      phase: 'plugins',
      fix: 'upgrade claude-mgr if Claude Code changed the plugins schema',
    });
  }

  const plugins = collectPlugins(value.plugins, rootDir, file, bag);
  plugins.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { plugins, diagnostics: bag.all() };
}

/**
 * Walk the `plugins` map into records. Each key maps to an array of entries
 * (best-effort: a lone object is tolerated as a single entry).
 * @param {*} map
 * @param {string} rootDir
 * @param {string} file
 * @param {DiagnosticBag} bag
 * @returns {PluginRecord[]}
 */
function collectPlugins(map, rootDir, file, bag) {
  /** @type {PluginRecord[]} */
  const out = [];
  if (!isJsonObject(map)) return out;

  for (const key of Object.keys(map)) {
    const raw = map[key];
    const entries = Array.isArray(raw) ? raw : [raw];
    for (const entry of entries) {
      if (!isJsonObject(entry)) {
        bag.add({ severity: 'warn', code: 'plugin-entry-malformed', message: `plugin entry for '${key}' is not an object`, path: file, phase: 'plugins' });
        continue;
      }
      const fallback = splitKey(key);
      const name = typeof entry.name === 'string' ? entry.name : fallback.name;
      const marketplace = typeof entry.marketplace === 'string' ? entry.marketplace : fallback.marketplace;
      const version = typeof entry.version === 'string' ? entry.version : '';
      const cachePresent = version.length > 0 && existsSync(join(rootDir, 'plugins', 'cache', marketplace, name, version));
      out.push({ key, name, marketplace, version, enabled: entry.enabled === true, cachePresent });
    }
  }
  return out;
}

/**
 * Split a `name@marketplace` key. Uses the LAST `@` so a name is never split
 * mid-token. Only a fallback — entries normally carry name/marketplace fields.
 * @param {string} key
 * @returns {{name: string, marketplace: string}}
 */
function splitKey(key) {
  const at = key.lastIndexOf('@');
  if (at <= 0) return { name: key, marketplace: '' };
  return { name: key.slice(0, at), marketplace: key.slice(at + 1) };
}
