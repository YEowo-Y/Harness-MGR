/**
 * Shared never-throws TOML file reader (P6 TOML wave, unit 2).
 *
 * The TOML sibling of read-json.mjs's readJsonFile/readJsoncFile: the same
 * never-throw file I/O + ENOENT handling + symlink refusal, parsing via the
 * hand-rolled parseToml (toml-parser.mjs). Codex keeps its whole config in
 * `~/.codex/config.toml`, so the codex effective-config view + (later) the
 * mcp/plugins adapters read it through here.
 *
 * Result is a tagged record, not an exception:
 *   - missing:true   the file does not exist (ENOENT) — usually benign.
 *   - error:<string> exists but could not be read/parsed; the caller turns it into
 *                    a Diagnostic (it owns the `path`). On error `value` is null.
 *   - otherwise      value holds the parsed TOML (a proto-safe Object.create(null)).
 *
 * Zero npm dependencies. Node stdlib only. Never throws.
 */

import { readFileSync, lstatSync } from 'node:fs';
import { parseToml } from '../lib/toml-parser.mjs';

/**
 * Reason returned when a config path is a symbolic link. readFileSync dereferences,
 * so a planted `config.toml` -> a foreign file would read foreign content into the
 * record. Mirrors read-json.mjs's symlink-never-follow rule.
 */
const SYMLINK_REFUSED = 'refused symlink: not following a link out of the config dir';

/**
 * @typedef {Object} TomlReadResult
 * @property {*} value             parsed TOML, or null on miss/error
 * @property {string|null} error   reason when read/parse failed (no path — caller attaches it)
 * @property {boolean} missing     true when the file does not exist (ENOENT)
 */

/**
 * Read and parse a TOML file without ever throwing. A syntax error becomes a single
 * `error` string carrying 1-based line:column (only the first issue, matching the
 * readJsoncFile shape); `value` is normalized to null on any error/miss.
 * @param {string} file absolute path to a TOML file
 * @returns {TomlReadResult}
 */
export function readTomlFile(file) {
  if (isSymlinkPath(file)) return { value: null, error: SYMLINK_REFUSED, missing: false };
  let text;
  try {
    text = readFileSync(file, 'utf-8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { value: null, error: null, missing: true };
    return { value: null, error: `read failed: ${errMessage(err)}`, missing: false };
  }
  const { value, errors } = parseToml(text);
  if (errors.length > 0) {
    const e = errors[0];
    return { value: null, error: `invalid TOML: ${e.message} (line ${e.line}, column ${e.column})`, missing: false };
  }
  return { value, error: null, missing: false };
}

/**
 * True if `p` is a symbolic link. lstatSync does NOT follow the link, so a planted
 * link is detected whether or not its target exists. Never throws.
 * @param {string} p
 * @returns {boolean}
 */
function isSymlinkPath(p) {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/** @param {unknown} err @returns {string} */
function errMessage(err) {
  return err instanceof Error ? err.message : String(err ?? '');
}
