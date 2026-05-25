/**
 * Shared settings-layer reader for CLI command handlers (P2.U8 extraction).
 *
 * Extracted from commands.mjs to keep that module under the 200-SLOC lint
 * ceiling. The three CLI handlers (config:show-effective, hooks, permissions)
 * all call this once per invocation to load the ordered settings layers.
 *
 * Never throws. Zero npm dependencies. Node stdlib only.
 */

import { join } from 'node:path';
import { readJsonFile, isJsonObject } from '../discovery/read-json.mjs';

/**
 * @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic
 * @typedef {import('../analysis/settings-merge.mjs').SettingsLayer} SettingsLayer
 */

/**
 * Read the ordered settings layers for a config dir: `<dir>/settings.json` (name
 * 'user', LOWER precedence) then `<dir>/settings.local.json` (name 'local', HIGHER).
 * A file is included as a layer only when present AND a JSON object; a present-but-
 * malformed/unreadable file contributes NO layer and a diagnostic instead. Read
 * once here so callers (config:show-effective, hooks, permissions) never re-read.
 *
 * NOTE: this merge path still uses the strict `readJsonFile` (JSON.parse), so a
 * commented / trailing-comma settings.json is rejected here even though
 * `discoverSettings` (the inventory path) now tolerates it via JSONC (P2.U3).
 * TODO(P2): retrofit to `readJsoncFile` so the two paths converge.
 * @param {string} configDir
 * @returns {{layers: SettingsLayer[], diagnostics: Diagnostic[]}}
 */
export function readSettingsLayers(configDir) {
  /** @type {SettingsLayer[]} */
  const layers = [];
  /** @type {Diagnostic[]} */
  const diagnostics = [];
  for (const { name, file } of [
    { name: 'user', file: 'settings.json' },
    { name: 'local', file: 'settings.local.json' },
  ]) {
    const abs = join(configDir, file);
    const { value, error, missing } = readJsonFile(abs);
    if (missing) continue; // absent file is benign — no layer, no diagnostic
    if (error) {
      diagnostics.push({ severity: 'error', code: 'settings-unreadable', message: error, path: abs, phase: 'cli' });
      continue;
    }
    if (!isJsonObject(value)) {
      diagnostics.push({ severity: 'warn', code: 'settings-malformed', message: `${file} is not a JSON object`, path: abs, phase: 'cli' });
      continue;
    }
    layers.push({ name, settings: value });
  }
  return { layers, diagnostics };
}
