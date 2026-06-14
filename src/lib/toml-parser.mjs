/**
 * Hand-rolled TOML parser — config.toml subset (P6 TOML wave, unit 1).
 *
 * --- Why hand-rolled ---
 * The project constitution is ZERO runtime dependencies. Codex keeps its whole
 * config (settings + mcp registry + plugin registry + per-skill enable list +
 * project trust) in `~/.codex/config.toml`. To govern it read-only we need a TOML
 * reader, so we scan + parse ourselves rather than pull in a TOML library —
 * mirroring the JSONC precedent (jsonc-parser.mjs, P2.U1-U3). Split across
 * toml-scan.mjs (scanner + strings) + toml-value.mjs (RHS values) + this module
 * (document structure) to stay under the 200-SLOC lint ceiling along clean seams.
 *
 * --- Scoped to the SUBSET config.toml actually uses (live scan 2026-06-14) ---
 * A 2144-line / 49 KB real config.toml uses ONLY: `#` comments; top-level
 * key=value before any table; table headers `[a.b."quoted"]` with dotted keys
 * whose segments are bare / basic-quoted / literal-quoted; arrays-of-tables
 * `[[skills.config]]` (441 of them); basic strings `"..."` (with `\\`/`\"`/`\uXXXX`
 * escapes — Windows paths) and literal strings `'...'` (verbatim); booleans;
 * decimal/hex/oct/bin integers; floats; and arrays `[...]` (possibly multi-line,
 * trailing comma tolerated) of those values. It contains ZERO multi-line strings
 * (`"""`/`'''`), ZERO inline tables (`{...}`), and ZERO dates/times — so those are
 * DELIBERATELY out of scope and reported as a clean error (a future agent-`.toml`
 * wave, which DOES use `"""`, would extend this — see docs/phase-6-codex-design.md §6).
 *
 * --- Never-throws contract ---
 * parseToml NEVER throws. A syntax error → `errors:[{message,line,column}]` (1-based,
 * best-effort) with `value:undefined`; a non-string input is the same with a fixed
 * message. Internally a single TomlError unwinds the descent and is caught at the
 * top. Inputs are never mutated (pure string processing).
 *
 * --- Proto-safety ---
 * Every table is `Object.create(null)`, so a file key like `__proto__` is ordinary
 * data, never prototype pollution (same stance as jsonc-parser.mjs). A later table
 * header into an existing array-of-tables descends into its LAST element (TOML rule).
 *
 * Zero npm dependencies; pure string processing.
 */

import {
  peek, peek2, advance, fail, skipSpaces, skipTrivia, finishLine,
  parseBasicString, parseLiteralString, TomlError, errMessage,
} from './toml-scan.mjs';
import { parseValue } from './toml-value.mjs';

/** @typedef {{ message: string, line: number, column: number }} TomlIssue */
/** @typedef {{ value: *, errors: TomlIssue[] }} TomlResult */
/** @typedef {import('./toml-scan.mjs').Scanner} Scanner */

/**
 * Parse TOML text (the config.toml subset) into a JS value. Pure; NEVER throws.
 * @param {string} text the TOML source
 * @returns {TomlResult}
 */
export function parseToml(text) {
  if (typeof text !== 'string') {
    return { value: undefined, errors: [{ message: 'input is not a string', line: 1, column: 1 }] };
  }
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const s = { text, i: 0, line: 1, column: 1 };
  try {
    const root = Object.create(null);
    let current = root;
    for (;;) {
      skipTrivia(s);
      if (s.i >= s.text.length) break;
      if (peek(s) === '[') {
        current = peek2(s) === '[' ? parseArrayTableHeader(s, root) : parseTableHeader(s, root);
      } else {
        parseKeyValue(s, current);
      }
      finishLine(s);
    }
    return { value: root, errors: [] };
  } catch (err) {
    if (err instanceof TomlError) return { value: undefined, errors: [{ message: err.message, line: err.line, column: err.column }] };
    return { value: undefined, errors: [{ message: errMessage(err), line: s.line, column: s.column }] };
  }
}

// ── keys ───────────────────────────────────────────────────────────────────────

/** A bare-key character: A-Za-z0-9 _ -. @param {string|undefined} ch */
function isBareKeyChar(ch) {
  return ch !== undefined && (
    (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') ||
    (ch >= '0' && ch <= '9') || ch === '_' || ch === '-'
  );
}

/** Parse ONE key segment: a basic-quoted, literal-quoted, or bare key. @param {Scanner} s @returns {string} */
function parseKeySegment(s) {
  skipSpaces(s);
  const ch = peek(s);
  if (ch === '"') return parseBasicString(s);
  if (ch === "'") return parseLiteralString(s);
  let raw = '';
  while (isBareKeyChar(peek(s))) raw += advance(s);
  if (raw === '') fail(s, 'expected a key');
  return raw;
}

/** Parse a dotted key into its segments (`a.b."c"` → ['a','b','c']). @param {Scanner} s @returns {string[]} */
function parseDottedKey(s) {
  const segments = [parseKeySegment(s)];
  for (;;) {
    skipSpaces(s);
    if (peek(s) !== '.') return segments;
    advance(s); // consume '.'
    segments.push(parseKeySegment(s));
  }
}

// ── tables ───────────────────────────────────────────────────────────────────────

/**
 * Navigate/create the table at `segments` under `root`. Creates missing tables;
 * descends into the LAST element of an array-of-tables; a segment that already
 * holds a non-table scalar is a redefinition error.
 * @param {object} root @param {string[]} segments @param {Scanner} s @returns {object}
 */
function navigateTable(root, segments, s) {
  let t = root;
  for (const seg of segments) {
    let next = t[seg];
    if (next === undefined) { next = Object.create(null); t[seg] = next; }
    else if (Array.isArray(next)) next = next[next.length - 1];
    else if (next === null || typeof next !== 'object') fail(s, `key '${seg}' is already a value, not a table`);
    t = next;
  }
  return t;
}

/** Parse a `[a.b.c]` header and return the (created) table it names. @param {Scanner} s @param {object} root @returns {object} */
function parseTableHeader(s, root) {
  advance(s); // consume '['
  const segments = parseDottedKey(s);
  skipSpaces(s);
  if (advance(s) !== ']') fail(s, "expected ']' to close a table header");
  return navigateTable(root, segments, s);
}

/** Parse a `[[a.b]]` array-of-tables header; append + return a fresh table. @param {Scanner} s @param {object} root @returns {object} */
function parseArrayTableHeader(s, root) {
  advance(s); advance(s); // consume '[['
  const segments = parseDottedKey(s);
  skipSpaces(s);
  if (advance(s) !== ']' || advance(s) !== ']') fail(s, "expected ']]' to close an array-of-tables header");
  const parent = navigateTable(root, segments.slice(0, -1), s);
  const key = segments[segments.length - 1];
  let arr = parent[key];
  if (arr === undefined) { arr = []; parent[key] = arr; }
  else if (!Array.isArray(arr)) fail(s, `key '${key}' is not an array of tables`);
  const t = Object.create(null);
  arr.push(t);
  return t;
}

/** Parse a `key = value` assignment into `table` (dotted keys create sub-tables). @param {Scanner} s @param {object} table */
function parseKeyValue(s, table) {
  const segments = parseDottedKey(s);
  skipSpaces(s);
  if (advance(s) !== '=') fail(s, "expected '=' after a key");
  skipSpaces(s);
  const value = parseValue(s);
  const target = navigateTable(table, segments.slice(0, -1), s);
  target[segments[segments.length - 1]] = value;
}
