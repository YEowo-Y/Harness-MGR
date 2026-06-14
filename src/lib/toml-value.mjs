/**
 * TOML value (RHS) parser (P6 TOML wave, unit 1).
 *
 * Parses the value after a `key =`: basic / literal strings, booleans, integers
 * (decimal / hex / oct / bin, underscores tolerated), floats, and arrays (possibly
 * multi-line, trailing comma tolerated). Out-of-config.toml-subset forms — multi-
 * line strings (`"""`/`'''`), inline tables (`{...}`), dates/times — are reported
 * as a clean error (never a throw past parseToml; see toml-parser.mjs header).
 *
 * Pure; zero npm deps. Depends only on the shared scanner core (toml-scan.mjs).
 */

import { peek, peek2, advance, fail, skipTrivia, parseBasicString, parseLiteralString, TomlError } from './toml-scan.mjs';

/** @typedef {import('./toml-scan.mjs').Scanner} Scanner */

/** Parse one value (RHS). Dispatches on the first char. @param {Scanner} s @returns {*} */
export function parseValue(s) {
  const ch = peek(s);
  if (ch === '"') {
    if (peek2(s) === '"' && s.text[s.i + 2] === '"') fail(s, 'multi-line basic strings ("""...""") are out of the config.toml subset');
    return parseBasicString(s);
  }
  if (ch === "'") {
    if (peek2(s) === "'" && s.text[s.i + 2] === "'") fail(s, "multi-line literal strings ('''...''') are out of the config.toml subset");
    return parseLiteralString(s);
  }
  if (ch === '[') return parseArray(s);
  if (ch === '{') fail(s, 'inline tables ({...}) are out of the config.toml subset');
  if (ch === undefined) fail(s, 'unexpected end of input — expected a value');
  return parseBareValue(s);
}

/** True at a token boundary (whitespace / , / ] / # / newline / EOF). @param {string|undefined} ch */
function isValueDelimiter(ch) {
  return ch === undefined || ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n' || ch === ',' || ch === ']' || ch === '#';
}

/** Parse a bare value token: boolean or number. Anything else (dates, inf/nan) is a clean error. @param {Scanner} s @returns {boolean|number} */
function parseBareValue(s) {
  const startLine = s.line;
  const startCol = s.column;
  let raw = '';
  while (!isValueDelimiter(peek(s))) raw += advance(s);
  const v = scalarFromToken(raw);
  if (v === INVALID) throw new TomlError(`invalid value '${raw}'`, startLine, startCol);
  return v;
}

/** Sentinel for an unrecognised bare token. */
const INVALID = Symbol('invalid');
const DEC_INT_RE = /^[+-]?(?:0|[1-9][0-9_]*)$/;
const HEX_RE = /^0x[0-9a-fA-F][0-9a-fA-F_]*$/;
const OCT_RE = /^0o[0-7][0-7_]*$/;
const BIN_RE = /^0b[01][01_]*$/;
const FLOAT_RE = /^[+-]?(?:0|[1-9][0-9_]*)(?:\.[0-9][0-9_]*)?(?:[eE][+-]?[0-9][0-9_]*)?$/;

/** Classify a bare token into a boolean/number, or INVALID. @param {string} raw @returns {boolean|number|symbol} */
function scalarFromToken(raw) {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (DEC_INT_RE.test(raw)) return parseInt(raw.replace(/_/g, ''), 10);
  if (HEX_RE.test(raw)) return parseInt(raw.slice(2).replace(/_/g, ''), 16);
  if (OCT_RE.test(raw)) return parseInt(raw.slice(2).replace(/_/g, ''), 8);
  if (BIN_RE.test(raw)) return parseInt(raw.slice(2).replace(/_/g, ''), 2);
  if (/[.eE]/.test(raw) && FLOAT_RE.test(raw)) return Number(raw.replace(/_/g, ''));
  return INVALID;
}

/** Parse an array `[...]` (multi-line + trailing comma tolerated). @param {Scanner} s @returns {Array} */
function parseArray(s) {
  advance(s); // consume '['
  const arr = [];
  for (;;) {
    skipTrivia(s);
    const ch = peek(s);
    if (ch === undefined) fail(s, 'unterminated array');
    if (ch === ']') { advance(s); return arr; }
    arr.push(parseValue(s));
    skipTrivia(s);
    const sep = peek(s);
    if (sep === ',') { advance(s); continue; }
    if (sep === ']') { advance(s); return arr; }
    fail(s, "expected ',' or ']' in an array");
  }
}
