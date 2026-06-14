/**
 * TOML scanner + string primitives (P6 TOML wave, unit 1).
 *
 * The low-level shared core under toml-parser.mjs (document structure) and
 * toml-value.mjs (RHS values): a 1-based line/column cursor, trivia skipping, the
 * positioned TomlError, and the two single-line string forms. The string parsers
 * live HERE (not in toml-value) because BOTH the value parser AND the key parser
 * need them — a TOML key segment can be a basic-quoted or literal-quoted string
 * (`[projects."C:\\..."]`, `"gpt-5.5" = 4`).
 *
 * Pure string processing; zero npm deps; no node:* imports. Functions operate on a
 * mutable scanner `s = { text, i, line, column }`. Errors are thrown as TomlError
 * and caught at the top of parseToml — callers of parseToml never see a throw.
 */

/** @typedef {{ text: string, i: number, line: number, column: number }} Scanner */

/** Thrown internally to unwind the parse; always caught in parseToml. */
export class TomlError extends Error {
  /** @param {string} message @param {number} line @param {number} column */
  constructor(message, line, column) {
    super(message);
    this.line = line;
    this.column = column;
  }
}

/** Current char (or undefined at EOF). @param {Scanner} s */
export function peek(s) { return s.text[s.i]; }
/** Next char. @param {Scanner} s */
export function peek2(s) { return s.text[s.i + 1]; }

/** Consume one char, maintaining 1-based line/column. @param {Scanner} s @returns {string} */
export function advance(s) {
  const ch = s.text[s.i];
  s.i += 1;
  if (ch === '\n') { s.line += 1; s.column = 1; } else { s.column += 1; }
  return ch;
}

/** Throw a positioned TomlError. @param {Scanner} s @param {string} msg @returns {never} */
export function fail(s, msg) { throw new TomlError(msg, s.line, s.column); }

/** Skip inline whitespace only (space/tab — NOT newlines). @param {Scanner} s */
export function skipSpaces(s) { while (peek(s) === ' ' || peek(s) === '\t') advance(s); }

/** Consume a `#` comment up to (not including) the newline. @param {Scanner} s */
export function skipComment(s) { while (s.i < s.text.length && peek(s) !== '\n') advance(s); }

/** Skip whitespace, newlines, and `#` comment lines (between statements and inside arrays). @param {Scanner} s */
export function skipTrivia(s) {
  for (;;) {
    const ch = peek(s);
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') { advance(s); continue; }
    if (ch === '#') { skipComment(s); continue; }
    return;
  }
}

/** After a statement: tolerate trailing spaces + a `#` comment, then require end-of-line/EOF. @param {Scanner} s */
export function finishLine(s) {
  skipSpaces(s);
  if (peek(s) === '#') skipComment(s);
  const ch = peek(s);
  // the newline itself is consumed by the next skipTrivia.
  if (ch !== undefined && ch !== '\n' && ch !== '\r') fail(s, `unexpected trailing content '${ch}'`);
}

/** Parse a single-line basic string `"..."` with escapes (opening `"` assumed present). @param {Scanner} s @returns {string} */
export function parseBasicString(s) {
  advance(s); // consume opening "
  let out = '';
  for (;;) {
    if (s.i >= s.text.length) fail(s, 'unterminated string');
    const ch = advance(s);
    if (ch === '"') return out;
    if (ch === '\n') fail(s, 'unterminated string (newline in a basic string)');
    if (ch === '\\') { out += readEscape(s); continue; }
    out += ch;
  }
}

/** Parse a single-line literal string `'...'` (verbatim — no escapes). @param {Scanner} s @returns {string} */
export function parseLiteralString(s) {
  advance(s); // consume opening '
  let out = '';
  for (;;) {
    if (s.i >= s.text.length) fail(s, 'unterminated literal string');
    const ch = advance(s);
    if (ch === "'") return out;
    if (ch === '\n') fail(s, 'unterminated literal string (newline in a literal string)');
    out += ch;
  }
}

/** TOML basic-string single-char escapes → their literal character. */
const SIMPLE_ESCAPES = Object.assign(Object.create(null), {
  '"': '"', '\\': '\\', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t',
});

/** Decode the escape AFTER a backslash. Handles the TOML escapes + `\uXXXX`/`\UXXXXXXXX`. @param {Scanner} s @returns {string} */
function readEscape(s) {
  if (s.i >= s.text.length) fail(s, 'unterminated escape');
  const ch = advance(s);
  const simple = SIMPLE_ESCAPES[ch];
  if (simple !== undefined) return simple;
  if (ch === 'u') return readUnicode(s, 4);
  if (ch === 'U') return readUnicode(s, 8);
  fail(s, `invalid escape '\\${ch}'`);
}

/** Read `count` hex digits and return the code point. @param {Scanner} s @param {number} count @returns {string} */
function readUnicode(s, count) {
  let hex = '';
  for (let k = 0; k < count; k += 1) {
    const c = peek(s);
    if (c === undefined || !isHex(c)) fail(s, `invalid \\${count === 4 ? 'u' : 'U'} escape`);
    hex += advance(s);
  }
  return String.fromCodePoint(parseInt(hex, 16));
}

/** @param {string} c */
function isHex(c) { return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F'); }

/** @param {unknown} err @returns {string} */
export function errMessage(err) {
  return err instanceof Error ? err.message : String(err ?? '');
}
