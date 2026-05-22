/**
 * Source "code projection" for the size linter (P1.U16) — the comment- and
 * literal-stripping pass that lint.mjs counts SLOC and matches function spans on.
 *
 * Splitting this out of lint.mjs keeps each module under its own SLOC ceiling and
 * isolates the one genuinely fiddly concern — turning raw text into a per-line
 * "code only" view — behind a tiny pure surface (projectLines / regexStarts).
 *
 * --- What a projected line is ---
 * For each physical line we drop block comments and `//` line comments, and blank
 * the CONTENTS of string, template, and regex literals, while PRESERVING every
 * structural delimiter { } ( ) that sits OUTSIDE a literal. Block-comment state is
 * carried ACROSS lines. The result is parallel to the input lines: a line is SLOC
 * iff its projection trims to non-empty, and brace-matching over the projection is
 * immune to a brace inside a string (`"}"`) or inside a comment (`// }`).
 *
 * --- Documented limitations ---
 *   - Template-literal contents are opaque/blanked; an interpolation `${...}` is
 *     NOT re-scanned (safe: the line still counts as code, blanked braces simply do
 *     not participate in span matching).
 *   - Multi-line template literals (a backtick string spanning lines) are NOT
 *     tracked across lines — continuation lines are projected as code. Safe as long
 *     as the codebase avoids multi-line templates containing structural braces.
 *   - The regex-vs-division slash is heuristic (see regexStarts): a `/` opens a
 *     regex only in expression position. Idiomatic regex literals are handled; an
 *     exotic division chain would blank a little extra and never miscounts a brace
 *     it should keep (regex bodies cannot contribute structural braces).
 *
 * Pure, never-throws, inputs never mutated. Zero npm dependencies; stdlib only.
 */

/** Operator/opener chars after which a `/` begins a regex (not division). */
const REGEX_PRECEDERS = '(,=:[!&|?{};';

/**
 * Keywords that can directly precede a regex literal (e.g. `return /foo/`).
 * After any of these a `/` opens a regex, not division, even though the previous
 * significant character is a word character (which REGEX_PRECEDERS does not cover).
 */
const REGEX_KEYWORDS = new Set([
  'return', 'typeof', 'void', 'delete', 'throw', 'case',
  'in', 'instanceof', 'new', 'yield', 'await',
]);

/**
 * Project every physical line to its "code only" form, carrying block-comment
 * state across lines. Returns a NEW array parallel to `lines`. Never throws.
 * @param {string[]} lines
 * @returns {string[]}
 */
export function projectLines(lines) {
  const state = { inBlock: false };
  return lines.map((line) => projectLine(line, state));
}

/**
 * Heuristic: does a slash at the current position open a regex (vs division)? True
 * when the previous significant content is an operator/opener char (REGEX_PRECEDERS),
 * there is no prior code on the line, OR the previous token is a keyword that can
 * precede a regex (return, typeof, void, delete, throw, case, in, instanceof, new,
 * yield, await). Without the keyword check a `return /\}/` inside a function body
 * would leave the regex body un-blanked, letting its `}` close the span early and
 * silently undercount the function's SLOC (false negative in the gate).
 * @param {string} out the projection of the line BEFORE the slash
 * @returns {boolean}
 */
export function regexStarts(out) {
  const trimmed = out.replace(/\s+$/, '');
  const prev = trimmed.slice(-1);
  if (prev === '' || REGEX_PRECEDERS.includes(prev)) return true;
  const wordMatch = trimmed.match(/([A-Za-z_$][\w$]*)$/);
  return wordMatch !== null && REGEX_KEYWORDS.has(wordMatch[1]);
}

/**
 * Project ONE line: drop block/line comments and blank the CONTENTS of string,
 * template, and regex literals, preserving structural delimiters outside them.
 * Mutates `state.inBlock` so multi-line block comments persist. Never throws.
 * @param {string} line
 * @param {{inBlock: boolean}} state
 * @returns {string}
 */
function projectLine(line, state) {
  // Strip a trailing \r so CRLF-authored files don't carry it into the projection.
  if (line.length > 0 && line[line.length - 1] === '\r') line = line.slice(0, -1);
  let out = '';
  let i = 0;
  const n = line.length;
  while (i < n) {
    if (state.inBlock) { i = skipBlock(line, i, state); continue; }
    const two = line.slice(i, i + 2);
    if (two === '/*') { state.inBlock = true; i += 2; continue; }
    if (two === '//') break;
    const c = line[i];
    if (c === '"' || c === "'" || c === '`') { i = skipString(line, i, c); out += c; continue; }
    if (c === '/' && regexStarts(out)) { i = skipRegex(line, i); out += '/'; continue; }
    out += c;
    i += 1;
  }
  return out;
}

/**
 * Advance past block-comment text on this line. Clears `state.inBlock` and returns
 * the index just after a closing delimiter; otherwise returns the line length (the
 * block continues on the next line).
 * @param {string} line @param {number} i @param {{inBlock: boolean}} state @returns {number}
 */
function skipBlock(line, i, state) {
  const end = line.indexOf('*/', i);
  if (end === -1) return line.length;
  state.inBlock = false;
  return end + 2;
}

/**
 * Advance past a quoted string starting at the opening quote `i`. Honors backslash
 * escapes; a string left unterminated on the line ends at the line end (its
 * contents are blanked either way). Returns the index after the close quote.
 * @param {string} line @param {number} i @param {string} quote @returns {number}
 */
function skipString(line, i, quote) {
  let j = i + 1;
  const n = line.length;
  while (j < n) {
    const c = line[j];
    if (c === '\\') { j += 2; continue; }
    if (c === quote) return j + 1;
    j += 1;
  }
  return n;
}

/**
 * Advance past a regex literal starting at the opening slash at `i`. Honors
 * backslash escapes and skips a `[...]` character class (where slash is literal).
 * An unterminated regex ends at the line end. Returns the index after the close.
 * @param {string} line @param {number} i @returns {number}
 */
function skipRegex(line, i) {
  let j = i + 1;
  const n = line.length;
  let inClass = false;
  while (j < n) {
    const c = line[j];
    if (c === '\\') { j += 2; continue; }
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) return j + 1;
    j += 1;
  }
  return n;
}
