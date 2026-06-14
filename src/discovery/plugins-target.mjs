/**
 * Target-aware plugin discovery (P6 TOML wave, unit 4).
 *
 * Dispatches plugin discovery by the descriptor's pluginSource:
 *   - 'json-file' (Claude / default) — the existing discoverPlugins:
 *     plugins/installed_plugins.json (schema v2).
 *   - 'toml-table' (Codex) — the `plugins` table of a single config.toml. Each
 *     entry `[plugins."<name>@<marketplace>"]` carries `enabled = <bool>` and NO
 *     version. Codex caches under plugins/cache/<marketplace>/<name>/<hash>/, so
 *     cachePresent is the VERSIONLESS check that `<marketplace>/<name>/` exists
 *     (Claude's check includes `/<version>/`; codex config.toml has no version).
 *
 * M2-safe (readTomlFile -> parseToml, both pure, no paths.mjs). Never throws.
 *
 * Zero npm dependencies. Node stdlib only.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DiagnosticBag } from '../lib/diagnostic.mjs';
import { isJsonObject } from './read-json.mjs';
import { readTomlFile } from './read-toml.mjs';
import { discoverPlugins, splitKey } from './plugins.mjs';

/**
 * @typedef {import('./plugins.mjs').PluginRecord} PluginRecord
 * @typedef {import('./plugins.mjs').PluginDiscoveryResult} PluginDiscoveryResult
 * @typedef {import('../targets/descriptor.mjs').TargetDescriptor} TargetDescriptor
 */

/** The default plugin source when a descriptor is absent or lacks a usable pluginSource. */
const DEFAULT_SOURCE = Object.freeze({ kind: 'json-file' });

/**
 * Discover plugins for the requested target. Claude/default reads
 * installed_plugins.json; Codex reads the config.toml `plugins` table.
 * @param {{rootDir: string, descriptor?: TargetDescriptor}} opts
 * @returns {PluginDiscoveryResult}
 */
export function discoverPluginsForTarget(opts) {
  const { rootDir, descriptor } = opts ?? {};
  const src = pluginSourceOf(descriptor);
  if (src.kind === 'toml-table' && typeof src.file === 'string' && typeof src.pointer === 'string') {
    return discoverPluginsToml({ rootDir, file: src.file, pointer: src.pointer });
  }
  return discoverPlugins(rootDir);
}

/**
 * The pluginSource of a descriptor, or the json-file default. Never throws.
 * @param {unknown} descriptor
 * @returns {{kind: string, file?: string, pointer?: string}}
 */
function pluginSourceOf(descriptor) {
  const src = descriptor && /** @type {any} */ (descriptor).pluginSource;
  if (isJsonObject(src) && typeof src.kind === 'string') return src;
  return DEFAULT_SOURCE;
}

/**
 * Read a config.toml's `<pointer>` table (e.g. plugins) into PluginRecords. A
 * missing file is benign; a parse error -> one `plugins-toml-invalid` warn; a
 * non-table entry -> one `plugin-entry-malformed` warn. Never throws.
 * @param {{rootDir: string, file: string, pointer: string}} opts
 * @returns {PluginDiscoveryResult}
 */
function discoverPluginsToml(opts) {
  const bag = new DiagnosticBag();
  /** @type {PluginRecord[]} */
  const plugins = [];
  const { rootDir, file, pointer } = opts;

  if (typeof rootDir !== 'string' || rootDir.length === 0) {
    bag.add({ severity: 'error', code: 'discover-bad-root', message: 'rootDir must be a non-empty string', phase: 'plugins' });
    return { plugins, diagnostics: bag.all() };
  }

  const path = join(rootDir, file);
  const { value, error, missing } = readTomlFile(path);
  if (missing) return { plugins, diagnostics: bag.all() }; // benign — no config.toml
  if (error) {
    bag.add({ severity: 'warn', code: 'plugins-toml-invalid', message: `${file}: ${error}`, path, phase: 'plugins' });
    return { plugins, diagnostics: bag.all() };
  }

  const config = isJsonObject(value) ? value : {};
  const map = isJsonObject(config[pointer]) ? config[pointer] : null;
  if (map) {
    for (const key of Object.keys(map)) {
      const entry = map[key];
      if (!isJsonObject(entry)) {
        bag.add({ severity: 'warn', code: 'plugin-entry-malformed', message: `plugin entry for '${key}' is not a table`, path, phase: 'plugins' });
        continue;
      }
      plugins.push(tomlPluginRecord(rootDir, key, entry));
    }
    plugins.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }
  return { plugins, diagnostics: bag.all() };
}

/**
 * Build a PluginRecord from a codex config.toml `[plugins."<name>@<marketplace>"]`
 * entry. Codex carries no version (version:''); cachePresent is the versionless
 * check that plugins/cache/<marketplace>/<name>/ exists (codex caches under
 * <marketplace>/<name>/<hash>/).
 * @param {string} rootDir
 * @param {string} key   the "<name>@<marketplace>" table key
 * @param {Record<string, *>} entry
 * @returns {PluginRecord}
 */
function tomlPluginRecord(rootDir, key, entry) {
  const { name, marketplace } = splitKey(key);
  const cachePresent =
    name.length > 0 && marketplace.length > 0 &&
    existsSync(join(rootDir, 'plugins', 'cache', marketplace, name));
  return { key, name, marketplace, version: '', enabled: entry.enabled === true, cachePresent };
}
