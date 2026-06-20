/**
 * Surgical TOML locator GUARD — multi-line-string / inline-table span mask
 * (P6 write wave, config-edit mcp-insert unit).
 *
 * --- Why this exists (decoupling the locator from parseToml) ---
 * toml-edit-locate.mjs's collectHeaders / scanEnabledLines are LINE scanners: they
 * read a header (`[...]`) or an `enabled = <bool>` key at the START of a line. Today
 * their fail-closed safety is INCIDENTAL — it holds only because parseToml shares the
 * same blind spot (toml-value.mjs rejects `"""`/`'''`/inline tables, so any document
 * where a `[`-line or `enabled =`-line hides inside such a construct ALSO fails
 * parseToml → applyVerifiedEdit's V1 reparse guard returns the original text, no write).
 * That couples the locator's safety to a DIFFERENT module's limitation. If parseToml
 * ever gains multi-line-string support, an `enabled = …` token inside a string literal
 * could pass V1 and the line scanner could splice inside the string (or silently no-op
 * the real key) — possibly adjacent to a secret. The mcp INSERT path is more
 * region-boundary-sensitive than the flip path, so this is the wave that decouples them.
 *
 * --- What it does (detect-and-fail-closed, NOT a full parser) ---
 * spanMask(text) does ONE top-level pass and records the half-open byte ranges that a
 * line scanner must NOT interpret as structure:
 *   (a) multi-line basic strings   `""" … """`
 *   (b) multi-line literal strings  `''' … '''`
 *   (c) inline-table brace regions  `{ … }`   (nested braces tracked)
 * It STEPS OVER ordinary single-line quoted values (reusing the parser's own
 * escape-aware string grammar) and `#` comments, so a `{` / `"""` / `[` that lives
 * INSIDE a normal quoted value or a comment never opens a span. Multi-line ARRAYS
 * (`[ … ]`, e.g. `args = [ … ]`) are deliberately NOT masked — they are legitimate in
 * the live config and the line scanners are not fooled by them. It returns a
 * `skip(offset)` predicate plus `malformed:true` when any span is opened and never
 * closed before EOF (the document is structurally ambiguous to a line scanner →
 * findEnableSpan fails closed). It does NOT decode or validate the contents; that is
 * parseToml's job, and duplicating it would bloat the module + re-introduce a second
 * grammar to keep in sync.
 *
 * Pure string processing; never throws; zero npm deps; no node:* imports.
 */

import { parseBasicString, parseLiteralString } from './toml-scan.mjs';

/** @typedef {{ skip:(offset:number)=>boolean, malformed:boolean }} SpanMask */

/**
 * Step PAST a single-line quoted string that OPENS at text[i] (a `"` or `'`), reusing
 * the parser's escape-aware grammar. Returns the index just past the closing quote, or
 * -1 when the string is unterminated/invalid (the caller then advances one char — the
 * line scanners are line-bounded, so a broken single-line string cannot fabricate a
 * cross-line span). @param {string} text @param {number} i
 */
function pastSingleLineString(text, i) {
  const sc = { text, i, line: 1, column: 1 };
  try {
    if (text[i] === '"') parseBasicString(sc); else parseLiteralString(sc);
    return sc.i > i ? sc.i : -1;
  } catch { return -1; }
}

/**
 * Find the matching close of an inline table that OPENS at text[open] === '{'. Steps
 * over inner single-line strings (so a `}` inside a value is not a false close) and
 * tracks `{` nesting depth. TOML inline tables are single-line, so a newline — or a
 * `"""`/`'''` multi-line open — before the matching `}` means malformed → -1. Returns
 * the index just past the matching `}`. @param {string} text @param {number} open
 */
function pastInlineTable(text, open) {
  const n = text.length;
  let depth = 0;
  let j = open;
  while (j < n) {
    const c = text[j];
    if (c === '\n') return -1; // inline tables are single-line
    if (c === '"' || c === "'") {
      if (text[j + 1] === c && text[j + 2] === c) return -1; // a multi-line string cannot sit on one line
      const nxt = pastSingleLineString(text, j);
      if (nxt === -1) return -1;
      j = nxt; continue;
    }
    if (c === '{') { depth += 1; j += 1; continue; }
    if (c === '}') { depth -= 1; j += 1; if (depth === 0) return j; continue; }
    j += 1;
  }
  return -1;
}

/**
 * Pre-scan `text` and return the unsafe-byte-range mask (see module header). NEVER
 * throws; a non-string yields an empty, never-skipping, non-malformed mask.
 * @param {string} text @returns {SpanMask}
 */
export function spanMask(text) {
  /** @type {Array<[number, number]>} */
  const ranges = [];
  let malformed = false;
  if (typeof text === 'string') {
    const n = text.length;
    let i = 0;
    while (i < n) {
      const c = text[i];
      if (c === '#') { const nl = text.indexOf('\n', i); i = nl === -1 ? n : nl + 1; continue; } // comment → EOL
      if (c === '"' || c === "'") {
        if (text[i + 1] === c && text[i + 2] === c) { // multi-line string: span to the next triple-quote
          const close = text.indexOf(c + c + c, i + 3);
          if (close === -1) { malformed = true; ranges.push([i, n]); break; }
          ranges.push([i, close + 3]); i = close + 3; continue;
        }
        const nxt = pastSingleLineString(text, i); // ordinary single-line string: step over (NOT masked)
        i = nxt === -1 ? i + 1 : nxt; continue;
      }
      if (c === '{') { // inline-table brace region
        const end = pastInlineTable(text, i);
        if (end === -1) { malformed = true; ranges.push([i, n]); break; }
        ranges.push([i, end]); i = end; continue;
      }
      i += 1;
    }
  }
  /** @param {number} offset */
  const skip = (offset) => {
    for (let k = 0; k < ranges.length; k += 1) if (offset >= ranges[k][0] && offset < ranges[k][1]) return true;
    return false;
  };
  return { skip, malformed };
}
