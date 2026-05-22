/**
 * Hand-rolled JSONC parser (P2.U1) — the HAPPY-PATH tokenizer.
 *
 * --- Why hand-rolled ---
 * The project constitution is ZERO runtime dependencies, so we cannot pull in a
 * JSONC library. Claude Code config files (settings.json) are strict JSON today,
 * but Phase 2 tolerates JSONC: `//` line comments, `/* ... *​/` block comments,
 * and trailing commas before `}` or `]`. JSON.parse cannot do any of that, and —
 * crucially — cannot report the line:column of a DUPLICATE key, which the doctor
 * wants to surface. So we scan + recursive-descend ourselves, tracking position.
 * P2.U3 will retrofit read-json.mjs to call this, so `value` stays JSON-compatible.
 *
 * --- Never-throws contract ---
 * parseJsonc NEVER throws. A syntax error becomes `errors:[{message,line,column}]`
 * with `value:undefined`; a non-string input is the same with a fixed message.
 * Positions are 1-based and best-effort. Internally a single `SyntaxError`-style
 * throw unwinds the recursive descent and is caught at the top — callers never see
 * it. Inputs are never mutated (pure string processing).
 *
 * --- Duplicate keys ---
 * When one object literal repeats a key, every LATER occurrence is pushed into
 * `duplicateKeys` at the key string's 1-based position; `value` keeps LAST-wins,
 * matching JSON.parse. Parsed objects use `Object.create(null)` so a file-supplied
 * key like `__proto__` is ordinary data, never prototype pollution.
 *
 * --- Deliberately deferred to P2.U2 (happy-path simplifications) ---
 *   - A leading UTF-8 BOM is NOT stripped here (read-json.mjs strips it before the
 *     text reaches a parser); a BOM as the first char is treated as a syntax error.
 *   - NESTED block comments are not supported: the first `*​/` closes the comment.
 *   - `\uXXXX` escapes are decoded best-effort; surrogate-pair precision and
 *     exhaustive control-character validation are out of scope.
 *
 * Zero npm dependencies; pure string processing (no node:* imports).
 */

/** @typedef {{ message: string, line: number, column: number }} JsoncIssue */
/** @typedef {{ key: string, line: number, column: number }} JsoncDuplicate */
/** @typedef {{ value: *, errors: JsoncIssue[], duplicateKeys: JsoncDuplicate[] }} JsoncResult */

/** Thrown internally to unwind the descent; always caught in parseJsonc. */
class JsoncError extends Error {
  /** @param {string} message @param {number} line @param {number} column */
  constructor(message, line, column) {
    super(message);
    this.line = line;
    this.column = column;
  }
}

/**
 * Parse JSONC text into a JS value, tolerating comments + trailing commas and
 * reporting duplicate keys. Pure; NEVER throws.
 *
 * @param {string} text the JSONC source
 * @returns {JsoncResult}
 */
export function parseJsonc(text) {
  if (typeof text !== 'string') {
    return { value: undefined, errors: [{ message: 'input is not a string', line: 1, column: 1 }], duplicateKeys: [] };
  }
  const s = newScanner(text);
  try {
    skipTrivia(s);
    if (s.i >= s.text.length) throw new JsoncError('unexpected end of input', s.line, s.column);
    const value = parseValue(s);
    skipTrivia(s);
    if (s.i < s.text.length) throw new JsoncError(`unexpected trailing character '${s.text[s.i]}'`, s.line, s.column);
    return { value, errors: [], duplicateKeys: s.duplicateKeys };
  } catch (err) {
    if (err instanceof JsoncError) {
      return { value: undefined, errors: [{ message: err.message, line: err.line, column: err.column }], duplicateKeys: [] };
    }
    return { value: undefined, errors: [{ message: errMessage(err), line: s.line, column: s.column }], duplicateKeys: [] };
  }
}

// ── scanner ────────────────────────────────────────────────────────────────────

/**
 * A mutable cursor over the source: `i` is the char index, `line`/`column` are the
 * 1-based human position, and `duplicateKeys` accumulates across the whole parse.
 * @param {string} text @returns {{text: string, i: number, line: number, column: number, duplicateKeys: JsoncDuplicate[]}}
 */
function newScanner(text) {
  return { text, i: 0, line: 1, column: 1, duplicateKeys: [] };
}

/**
 * Advance the cursor by one char, maintaining 1-based line/column (a `\n`
 * increments line and resets column). Returns the consumed character.
 * @param {{text: string, i: number, line: number, column: number}} s @returns {string}
 */
function advance(s) {
  const ch = s.text[s.i];
  s.i += 1;
  if (ch === '\n') { s.line += 1; s.column = 1; } else { s.column += 1; }
  return ch;
}

/**
 * Skip whitespace AND comments (`//` to end-of-line; `/* *​/` block, single-level).
 * An unterminated block comment is a syntax error. Never returns a value.
 * @param {ReturnType<typeof newScanner>} s
 */
function skipTrivia(s) {
  for (;;) {
    const ch = s.text[s.i];
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') { advance(s); continue; }
    if (ch === '/' && s.text[s.i + 1] === '/') { skipLineComment(s); continue; }
    if (ch === '/' && s.text[s.i + 1] === '*') { skipBlockComment(s); continue; }
    return;
  }
}

/** Consume a `//` comment through (not including) the newline. @param {ReturnType<typeof newScanner>} s */
function skipLineComment(s) {
  while (s.i < s.text.length && s.text[s.i] !== '\n') advance(s);
}

/** Consume a `/* *​/` block comment (single-level); unterminated → error. @param {ReturnType<typeof newScanner>} s */
function skipBlockComment(s) {
  const startLine = s.line;
  const startCol = s.column;
  advance(s); advance(s); // consume the opening /*
  while (s.i < s.text.length) {
    if (s.text[s.i] === '*' && s.text[s.i + 1] === '/') { advance(s); advance(s); return; }
    advance(s);
  }
  throw new JsoncError('unterminated block comment', startLine, startCol);
}

// ── recursive descent ────────────────────────────────────────────────────────────

/**
 * Parse one value at the cursor (trivia already skipped). Dispatches on the first
 * char to object/array/string/number/keyword. Never returns; throws on malformation.
 * @param {ReturnType<typeof newScanner>} s @returns {*}
 */
function parseValue(s) {
  const ch = s.text[s.i];
  if (ch === '{') return parseObject(s);
  if (ch === '[') return parseArray(s);
  if (ch === '"') return parseString(s);
  if (ch === '-' || (ch >= '0' && ch <= '9')) return parseNumber(s);
  if (ch === 't' || ch === 'f' || ch === 'n') return parseKeyword(s);
  throw new JsoncError(`unexpected character '${ch ?? '<eof>'}'`, s.line, s.column);
}

/**
 * Parse an object literal. Tolerates a trailing comma before `}`; records each
 * repeated key in `s.duplicateKeys` (LAST value wins). Keys live on a null-proto
 * object so a file key like `__proto__` cannot pollute a prototype.
 * @param {ReturnType<typeof newScanner>} s @returns {Object}
 */
function parseObject(s) {
  advance(s); // consume {
  const obj = Object.create(null);
  skipTrivia(s);
  if (s.text[s.i] === '}') { advance(s); return obj; }
  for (;;) {
    skipTrivia(s);
    if (s.text[s.i] !== '"') throw new JsoncError('expected a string key', s.line, s.column);
    const keyLine = s.line;
    const keyCol = s.column;
    const key = parseString(s);
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      s.duplicateKeys.push({ key, line: keyLine, column: keyCol });
    }
    skipTrivia(s);
    const colonLine = s.line;
    const colonCol = s.column;
    if (advance(s) !== ':') throw new JsoncError('expected \':\' after object key', colonLine, colonCol);
    skipTrivia(s);
    obj[key] = parseValue(s);
    if (afterMember(s, '}')) return obj;
  }
}

/**
 * Parse an array literal. Tolerates a trailing comma before `]`.
 * @param {ReturnType<typeof newScanner>} s @returns {Array}
 */
function parseArray(s) {
  advance(s); // consume [
  const arr = [];
  skipTrivia(s);
  if (s.text[s.i] === ']') { advance(s); return arr; }
  for (;;) {
    skipTrivia(s);
    arr.push(parseValue(s));
    if (afterMember(s, ']')) return arr;
  }
}

/**
 * Consume the separator after an object/array member: a `,` continues (and a
 * following `close` is a tolerated trailing comma → done), a `close` ends the
 * container. Returns true when the container is closed. Throws otherwise.
 * @param {ReturnType<typeof newScanner>} s @param {string} close `}` or `]`
 * @returns {boolean}
 */
function afterMember(s, close) {
  skipTrivia(s);
  const ch = s.text[s.i];
  if (ch === close) { advance(s); return true; }
  if (ch === ',') {
    advance(s);
    skipTrivia(s);
    if (s.text[s.i] === close) { advance(s); return true; } // trailing comma
    return false;
  }
  throw new JsoncError(`expected ',' or '${close}'`, s.line, s.column);
}

// ── scalars ────────────────────────────────────────────────────────────────────

/**
 * Parse a double-quoted string at the cursor, decoding backslash escapes so a `\"`
 * or `\\` never mis-terminates and `//`, `/*`, `,}` inside quotes stay verbatim
 * data. The opening `"` is assumed present. Throws on an unterminated string.
 * @param {ReturnType<typeof newScanner>} s @returns {string}
 */
function parseString(s) {
  const startLine = s.line;
  const startCol = s.column;
  advance(s); // consume opening "
  let out = '';
  for (;;) {
    if (s.i >= s.text.length) throw new JsoncError('unterminated string', startLine, startCol);
    const ch = advance(s);
    if (ch === '"') return out;
    if (ch === '\\') { out += readEscape(s); continue; }
    out += ch;
  }
}

/**
 * Decode the escape sequence AFTER a backslash at the cursor. Handles the JSON
 * escapes (`"` `\\` `/` `b` `f` `n` `r` `t`) and `\uXXXX` (best-effort: four hex
 * digits → code unit). An unknown escape keeps the literal char (lenient by design).
 * @param {ReturnType<typeof newScanner>} s @returns {string}
 */
function readEscape(s) {
  if (s.i >= s.text.length) throw new JsoncError('unterminated escape', s.line, s.column);
  const ch = advance(s);
  const simple = SIMPLE_ESCAPES[ch];
  if (simple !== undefined) return simple;
  if (ch === 'u') return readUnicodeEscape(s);
  return ch;
}

/** JSON single-char escapes → their literal character. */
const SIMPLE_ESCAPES = Object.assign(Object.create(null), {
  '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t',
});

/**
 * Read the four hex digits of a `\uXXXX` escape (the `u` already consumed) and
 * return the corresponding code unit. Fewer than four hex digits is a syntax error.
 * @param {ReturnType<typeof newScanner>} s @returns {string}
 */
function readUnicodeEscape(s) {
  let hex = '';
  for (let k = 0; k < 4; k += 1) {
    const c = s.text[s.i];
    if (c === undefined || !/[0-9a-fA-F]/.test(c)) throw new JsoncError('invalid \\u escape', s.line, s.column);
    hex += advance(s);
  }
  return String.fromCharCode(parseInt(hex, 16));
}

/**
 * Parse a JSON number at the cursor (optional `-`, int part, optional fraction,
 * optional exponent). Consumes the maximal numeric run, then validates with the
 * JSON number grammar; an invalid shape (e.g. a lone `-`) is a syntax error.
 * @param {ReturnType<typeof newScanner>} s @returns {number}
 */
function parseNumber(s) {
  const startLine = s.line;
  const startCol = s.column;
  let raw = '';
  while (s.i < s.text.length && /[0-9eE+\-.]/.test(s.text[s.i])) raw += advance(s);
  if (!NUMBER_RE.test(raw)) throw new JsoncError(`invalid number '${raw}'`, startLine, startCol);
  return Number(raw);
}

/** The JSON number grammar (no leading zeros, optional fraction/exponent). */
const NUMBER_RE = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/;

/**
 * Parse a bare keyword (`true`/`false`/`null`) at the cursor. Any other word is a
 * syntax error reported at the keyword's start.
 * @param {ReturnType<typeof newScanner>} s @returns {boolean|null}
 */
function parseKeyword(s) {
  const startLine = s.line;
  const startCol = s.column;
  for (const [word, val] of KEYWORDS) {
    if (s.text.startsWith(word, s.i)) {
      for (let k = 0; k < word.length; k += 1) advance(s);
      return val;
    }
  }
  throw new JsoncError('invalid keyword', startLine, startCol);
}

/** Recognised bare keywords and their JS values. */
const KEYWORDS = [['true', true], ['false', false], ['null', null]];

// ── shared ─────────────────────────────────────────────────────────────────────

/** @param {unknown} err @returns {string} */
function errMessage(err) {
  return err instanceof Error ? err.message : String(err ?? '');
}
