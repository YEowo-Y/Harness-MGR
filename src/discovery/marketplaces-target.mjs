/**
 * Target-aware marketplace discovery (P6 — codex marketplaces).
 *
 * Dispatches marketplace discovery by the descriptor's marketplaceSource:
 *   - 'json-file' (Claude / default) — the existing discoverMarketplaces:
 *     plugins/known_marketplaces.json.
 *   - 'toml-table-cache' (Codex) — the UNION of the config.toml `<pointer>` table
 *     (declared marketplaces + a machine-specific `source` path → installLocation) AND
 *     the `<cacheDir>/<name>/` on-disk cache dirs. The table is INCOMPLETE vs the cached
 *     marketplaces (observed live: 2 declared-local vs 4 cached — the remote
 *     openai-curated/-remote ship plugins but aren't in the table), so a cached-but-
 *     undeclared marketplace still surfaces. `onDisk` = the cache dir exists.
 *
 * Codex records REUSE the existing MarketplaceRecord shape: codex's `source` is a
 * machine-specific absolute path, semantically the same as Claude's `installLocation`
 * ("verbatim, may be machine-specific"), so it maps there — no shape change. M2-safe
 * (readTomlFile -> parseToml, both pure, no paths.mjs). Never throws.
 *
 * Zero npm dependencies. Node stdlib only.
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DiagnosticBag } from '../lib/diagnostic.mjs';
import { isJsonObject } from './read-json.mjs';
import { readTomlFile } from './read-toml.mjs';
import { discoverMarketplaces } from './marketplaces.mjs';

/**
 * @typedef {import('./marketplaces.mjs').MarketplaceRecord} MarketplaceRecord
 * @typedef {import('./marketplaces.mjs').MarketplaceDiscoveryResult} MarketplaceDiscoveryResult
 * @typedef {import('../targets/descriptor.mjs').TargetDescriptor} TargetDescriptor
 */

/** The default marketplace source when a descriptor is absent or lacks a usable marketplaceSource. */
const DEFAULT_SOURCE = Object.freeze({ kind: 'json-file' });

/**
 * Discover marketplaces for the requested target. Claude/default reads
 * known_marketplaces.json; Codex reads the config.toml `marketplaces` table unioned
 * with the plugins/cache dirs.
 * @param {{rootDir: string, descriptor?: TargetDescriptor}} opts
 * @returns {MarketplaceDiscoveryResult}
 */
export function discoverMarketplacesForTarget(opts) {
  const { rootDir, descriptor } = opts ?? {};
  const src = marketplaceSourceOf(descriptor);
  if (src.kind === 'toml-table-cache'
      && typeof src.file === 'string' && typeof src.pointer === 'string' && typeof src.cacheDir === 'string') {
    return discoverMarketplacesCodex({ rootDir, file: src.file, pointer: src.pointer, cacheDir: src.cacheDir });
  }
  return discoverMarketplaces(rootDir);
}

/**
 * The marketplaceSource of a descriptor, or the json-file default. Never throws.
 * @param {unknown} descriptor
 * @returns {{kind: string, file?: string, pointer?: string, cacheDir?: string}}
 */
function marketplaceSourceOf(descriptor) {
  const src = descriptor && /** @type {any} */ (descriptor).marketplaceSource;
  if (isJsonObject(src) && typeof src.kind === 'string') return src;
  return DEFAULT_SOURCE;
}

/**
 * Codex marketplaces = the config.toml `<pointer>` table (declared, with `source` ->
 * installLocation) UNIONED with the `<cacheDir>/<name>/` dirs (cached, even if
 * undeclared). `onDisk` = the cache dir exists. A missing file is benign; a parse
 * error -> one `marketplaces-toml-invalid` warn (the cache dirs still scan). A scalar
 * table setting (e.g. `max_depth`) is skipped SILENTLY (a setting, not a marketplace).
 * Never throws.
 * @param {{rootDir: string, file: string, pointer: string, cacheDir: string}} opts
 * @returns {MarketplaceDiscoveryResult}
 */
function discoverMarketplacesCodex(opts) {
  const bag = new DiagnosticBag();
  const { rootDir, file, pointer, cacheDir } = opts;
  if (typeof rootDir !== 'string' || rootDir.length === 0) {
    bag.add({ severity: 'error', code: 'discover-bad-root', message: 'rootDir must be a non-empty string', phase: 'marketplaces' });
    return { marketplaces: [], diagnostics: bag.all() };
  }

  // A Map keyed by marketplace name (Map keys are not subject to prototype pollution).
  /** @type {Map<string, MarketplaceRecord>} */
  const byName = new Map();
  const onDiskOf = (name) => existsSync(join(rootDir, cacheDir, name));

  // 1. Declared marketplaces from the config.toml table.
  const path = join(rootDir, file);
  const { value, error, missing } = readTomlFile(path);
  if (error) bag.add({ severity: 'warn', code: 'marketplaces-toml-invalid', message: `${file}: ${error}`, path, phase: 'marketplaces' });
  if (!missing && !error) {
    const config = isJsonObject(value) ? value : {};
    const table = isJsonObject(config[pointer]) ? config[pointer] : null;
    if (table) {
      for (const name of Object.keys(table)) {
        const entry = table[name];
        if (!isJsonObject(entry)) continue; // skip a scalar table setting (e.g. max_depth) — not a marketplace
        /** @type {MarketplaceRecord} */
        const rec = { name, onDisk: onDiskOf(name) };
        if (typeof entry.source === 'string') rec.installLocation = entry.source;
        byName.set(name, rec);
      }
    }
  }

  // 2. On-disk cache dirs — surface any cached-but-undeclared marketplace. NOTE: a
  //    name the table leg skipped as a SCALAR setting (e.g. `max_depth`) would re-appear
  //    here IF a real cache dir literally had that name — internally consistent (the
  //    cache dir's presence IS the authoritative on-disk signal) + contained (one
  //    spurious name at worst) + practically impossible (no marketplace is named `max_depth`).
  for (const name of cacheDirNames(join(rootDir, cacheDir))) {
    if (!byName.has(name)) byName.set(name, { name, onDisk: true });
  }

  const marketplaces = [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { marketplaces, diagnostics: bag.all() };
}

/**
 * Names of the REAL sub-directories of `dir` (symlinks excluded — a Dirent reports
 * isDirectory()===false for a symlink, so a symlinked cache dir is never followed). A
 * missing/unreadable dir yields []. Never throws.
 * @param {string} dir
 * @returns {string[]}
 */
function cacheDirNames(dir) {
  let ents;
  try {
    ents = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  /** @type {string[]} */
  const names = [];
  for (const ent of ents) if (ent.isDirectory()) names.push(ent.name);
  return names;
}
