/**
 * Shared never-throws JSON file reader for discovery scanners (P1.U8).
 *
 * Discovery reads several Claude Code config files. The tool-generated ones
 * (installed_plugins.json, known_marketplaces.json, .mcp.json) are strict JSON
 * and stay on `readJsonFile`. The user-authored settings.json may carry comments
 * and trailing commas, so settings discovery (P2.U3) reads it via `readJsoncFile`,
 * which parses with the hand-rolled JSONC tokenizer and additionally reports the
 * duplicate keys JSON.parse silently collapses. Both readers share the same
 * never-throw file I/O + ENOENT handling here, so that contract lives in one place.
 *
 * The result is a tagged record, not an exception:
 *   - missing:true   the file does not exist (ENOENT) — usually benign; the
 *                    caller decides whether "absent" warrants a diagnostic.
 *   - error:<string> the file exists but could not be read or parsed; the
 *                    caller turns this into a Diagnostic (it owns the `path`).
 *   - otherwise      value holds the parsed JSON (readJsoncFile also returns the
 *                    `duplicateKeys` it found, an empty array when there are none).
 *
 * Zero npm dependencies. Node stdlib only.
 */

import { readFileSync, lstatSync } from 'node:fs';
import { parseJsonc } from '../lib/jsonc-parser.mjs';

/**
 * Reason returned when a config path is a symbolic link. The discovery layer
 * refuses to FOLLOW a link out of the config dir: readFileSync dereferences, so
 * a planted `settings.json` -> a foreign file would read foreign content (e.g. a
 * statusLine.command or MCP url carrying a token) into the field-scoped record.
 * Mirrors the symlink-never-follow rule in src/ops/snapshot-walk.mjs.
 */
const SYMLINK_REFUSED = 'refused symlink: not following a link out of the config dir';

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
  if (isSymlinkPath(file)) return { value: null, error: SYMLINK_REFUSED, missing: false };
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
    return { value: null, error: `invalid JSON: ${safeJsonParseError(err)}`, missing: false };
  }
}

/**
 * A content-free rendering of a JSON.parse failure. V8's "Unexpected token 'X',
 * ...<excerpt>... is not valid JSON" messages embed a verbatim ~10-char slice of
 * the file around the fault — a secret when the file holds one (.mcp.json /
 * settings.json env values). CLI diagnostics are NOT secret-redacted, so we must
 * never forward that slice. Keep ONLY a numeric position (digits carry no content),
 * mirroring readJsoncFile's `(line X, column Y)`; otherwise emit a fixed phrase.
 * @param {unknown} err
 * @returns {string}
 */
function safeJsonParseError(err) {
  const raw = errMessage(err);
  const pos = raw.match(/at position \d+(?: \(line \d+ column \d+\))?/);
  if (pos) return `syntax error ${pos[0]}`;
  if (/Unexpected end of JSON input/.test(raw)) return 'unexpected end of input';
  return 'unparseable (syntax error)';
}

/**
 * @typedef {Object} JsoncReadResult
 * @property {*} value             parsed value, or null on miss/error
 * @property {string|null} error   reason when read/parse failed (no path — caller attaches it)
 * @property {boolean} missing     true when the file does not exist (ENOENT)
 * @property {{key: string, line: number, column: number}[]} duplicateKeys
 *           keys repeated within one object (last value wins); empty on miss/error
 */

/**
 * Read and JSONC-parse a file without ever throwing — the tolerant sibling of
 * readJsonFile for user-authored config (comments, trailing commas) that also
 * surfaces duplicate keys. The tokenizer strips its own leading BOM and never
 * throws; a syntax error becomes a single `error` string carrying 1-based
 * line:column (only the first issue, to match the one-line `error` shape). On
 * any error/miss `value` is normalized to `null` (matching readJsonFile) — note
 * parseJsonc itself reports failure as `value:undefined`, so check `error`/`missing`,
 * not the value, to detect failure here.
 * @param {string} file absolute path to a JSONC file
 * @returns {JsoncReadResult}
 */
export function readJsoncFile(file) {
  if (isSymlinkPath(file)) return { value: null, error: SYMLINK_REFUSED, missing: false, duplicateKeys: [] };
  let text;
  try {
    text = readFileSync(file, 'utf-8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { value: null, error: null, missing: true, duplicateKeys: [] };
    return { value: null, error: `read failed: ${errMessage(err)}`, missing: false, duplicateKeys: [] };
  }
  const { value, errors, duplicateKeys } = parseJsonc(text);
  if (errors.length > 0) {
    const e = errors[0];
    return { value: null, error: `invalid JSONC: ${e.message} (line ${e.line}, column ${e.column})`, missing: false, duplicateKeys: [] };
  }
  return { value, error: null, missing: false, duplicateKeys };
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

/**
 * True if `p` is a symbolic link. lstatSync does NOT follow the link, so a
 * planted link is detected whether or not its target exists. Never throws: a
 * missing path returns false, leaving the existing ENOENT handling to run.
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
