/**
 * Shared never-throws JSON file reader for discovery scanners (P1.U8).
 *
 * Discovery reads several Claude Code config files that are tool-generated
 * strict JSON (installed_plugins.json, known_marketplaces.json, .mcp.json,
 * settings.json). They share one read+parse path here so the never-throw
 * contract and BOM handling live in a single place, and so the Phase-2 JSONC
 * retrofit (settings.json gains comments/trailing-commas) is a one-module swap.
 *
 * The result is a tagged record, not an exception:
 *   - missing:true   the file does not exist (ENOENT) — usually benign; the
 *                    caller decides whether "absent" warrants a diagnostic.
 *   - error:<string> the file exists but could not be read or parsed; the
 *                    caller turns this into a Diagnostic (it owns the `path`).
 *   - otherwise      value holds the parsed JSON.
 *
 * Zero npm dependencies. Node stdlib only.
 */

import { readFileSync } from 'node:fs';

/**
 * @typedef {Object} JsonReadResult
 * @property {*} value             parsed JSON, or null on miss/error
 * @property {string|null} error   reason when read/parse failed (no path — caller attaches it)
 * @property {boolean} missing     true when the file does not exist (ENOENT)
 */

/**
 * Read and JSON.parse a file without ever throwing.
 * @param {string} file absolute path to a JSON file
 * @returns {JsonReadResult}
 */
export function readJsonFile(file) {
  let text;
  try {
    text = readFileSync(file, 'utf-8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { value: null, error: null, missing: true };
    return { value: null, error: `read failed: ${errMessage(err)}`, missing: false };
  }
  try {
    // Strip a leading UTF-8 BOM (Windows-authored configs carry one).
    const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    return { value: JSON.parse(s), error: null, missing: false };
  } catch (err) {
    return { value: null, error: `invalid JSON: ${errMessage(err)}`, missing: false };
  }
}

/**
 * True for a non-null, non-array object — the shape config maps must have before
 * we iterate their keys. Guards every scanner against malformed JSON (a bare
 * array, string, or number where an object was expected).
 * @param {*} v
 * @returns {boolean}
 */
export function isJsonObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** @param {unknown} err @returns {string} */
function errMessage(err) {
  return err instanceof Error ? err.message : String(err ?? '');
}
