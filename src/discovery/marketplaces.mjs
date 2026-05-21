/**
 * Marketplace discovery (P1.U8).
 *
 * Reads `<rootDir>/plugins/known_marketplaces.json` and emits a deterministic
 * `MarketplaceRecord[]` plus a `Diagnostic[]`. NEVER throws.
 *
 * The file is an object keyed by marketplace name:
 *   { "<name>": { source: { source: "github", repo: "owner/repo" },
 *                 installLocation: "<abs path>", lastUpdated: "<iso>" }, ... }
 *
 * --- onDisk uses a root-relative path, NOT installLocation ---
 * `installLocation` is an absolute, machine-specific path written by Claude
 * Code. Trusting it would break the moment the tool runs against a different
 * CLAUDE_CONFIG_DIR (or a fixture). So "is the catalog clone on disk?" is
 * answered by `<rootDir>/plugins/marketplaces/<name>/`, which travels with the
 * config dir under inspection. installLocation is still recorded verbatim so a
 * later doctor check can flag a divergence between the two.
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
 * @typedef {Object} MarketplaceRecord
 * @property {string} name
 * @property {string} [sourceRepo]        e.g. "anthropics/claude-plugins-official"
 * @property {string} [installLocation]   verbatim from the file (may be machine-specific)
 * @property {boolean} onDisk             whether plugins/marketplaces/<name>/ exists under rootDir
 */

/**
 * @typedef {Object} MarketplaceDiscoveryResult
 * @property {MarketplaceRecord[]} marketplaces
 * @property {Diagnostic[]} diagnostics
 */

/**
 * Discover known marketplaces under `rootDir`. A missing known_marketplaces.json
 * means "none declared" (silent). Unreadable/malformed JSON and malformed
 * entries become diagnostics; whatever parsed is still returned.
 *
 * @param {string} rootDir
 * @returns {MarketplaceDiscoveryResult}
 */
export function discoverMarketplaces(rootDir) {
  const bag = new DiagnosticBag();
  if (typeof rootDir !== 'string' || rootDir.length === 0) {
    bag.add({ severity: 'error', code: 'discover-bad-root', message: 'rootDir must be a non-empty string', phase: 'marketplaces' });
    return { marketplaces: [], diagnostics: bag.all() };
  }

  const file = join(rootDir, 'plugins', 'known_marketplaces.json');
  const { value, error, missing } = readJsonFile(file);
  if (missing) return { marketplaces: [], diagnostics: bag.all() };
  if (error) {
    bag.add({ severity: 'error', code: 'known-marketplaces-unreadable', message: error, path: file, phase: 'marketplaces' });
    return { marketplaces: [], diagnostics: bag.all() };
  }
  if (!isJsonObject(value)) {
    bag.add({ severity: 'warn', code: 'known-marketplaces-malformed', message: 'known_marketplaces.json is not a JSON object', path: file, phase: 'marketplaces' });
    return { marketplaces: [], diagnostics: bag.all() };
  }

  /** @type {MarketplaceRecord[]} */
  const marketplaces = [];
  for (const name of Object.keys(value)) {
    const entry = value[name];
    if (!isJsonObject(entry)) {
      bag.add({ severity: 'warn', code: 'marketplace-entry-malformed', message: `marketplace entry '${name}' is not an object`, path: file, phase: 'marketplaces' });
      continue;
    }
    /** @type {MarketplaceRecord} */
    const rec = { name, onDisk: existsSync(join(rootDir, 'plugins', 'marketplaces', name)) };
    const repo = isJsonObject(entry.source) ? entry.source.repo : undefined;
    if (typeof repo === 'string') rec.sourceRepo = repo;
    if (typeof entry.installLocation === 'string') rec.installLocation = entry.installLocation;
    marketplaces.push(rec);
  }

  marketplaces.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { marketplaces, diagnostics: bag.all() };
}
