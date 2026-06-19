/**
 * Surgical TOML LOCATOR — config.toml subset (P6 write wave, config-edit unit).
 *
 * --- Why this exists ---
 * parseToml (toml-parser.mjs) is a VALUE parser: it builds a JS value tree and
 * DISCARDS byte positions and comments, so it cannot edit a file in place. To
 * disable/enable a codex plugin (and later mcp/skill) we must flip a single
 * `enabled = <bool>` boolean while preserving EVERY other byte. This module is the
 * missing byte-offset-retaining locator: it re-walks the document with the SAME
 * grammar the parser trusts (reusing toml-scan's quote/escape-aware string readers
 * for header segments) but RETAINS the offsets the parser throws away — the value
 * token's byte range that the mutation step (toml-edit.mjs) splices.
 *
 * Split from toml-edit.mjs along the locate↔mutate seam to stay under the 200-SLOC
 * lint ceiling (the same split philosophy as toml-scan/value/parser).
 *
 * --- Secret safety is structural ---
 * A region ENDS at the next table header, so an [mcp_servers.<x>] region stops
 * BEFORE its [mcp_servers.<x>.env] secret sub-table — the locator never even looks
 * inside a secret sub-table. The `enabled` line scan requires the bare key === 'enabled'
 * so it can never return a `bearer_token_env_var`/`url`/`command`/`env` line.
 *
 * Pure string processing; never throws (a malformed header → null, skipped); zero
 * npm deps; no node:* imports.
 */

import { parseBasicString, parseLiteralString } from './toml-scan.mjs';

/**
 * @typedef {{kind:'plugin', name:string}
 *   | {kind:'mcp', name:string}
 *   | {kind:'skill', match:{field:'name'|'path', value:string}}} EnableSelector
 */

/** A bare-key char: A-Za-z0-9 _ - (same rule the parser uses). @param {string|undefined} ch */
function isBareKeyChar(ch) {
  return ch !== undefined && (
    (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') ||
    (ch >= '0' && ch <= '9') || ch === '_' || ch === '-'
  );
}

/** A value/key token boundary: whitespace, '#', CR/LF, EOF. @param {string|undefined} ch */
function isDelim(ch) {
  return ch === undefined || ch === ' ' || ch === '\t' || ch === '#' || ch === '\r' || ch === '\n';
}

/** Skip spaces/tabs in `s` from index i; return the new index. @param {string} s @param {number} i */
function skipSp(s, i) { while (s[i] === ' ' || s[i] === '\t') i += 1; return i; }

/** End offset (exclusive) of the line at lineStart, NOT counting '\n' (a CRLF '\r'
 *  stays inside the line). @param {string} text @param {number} lineStart */
function lineEndOf(text, lineStart) {
  const nl = text.indexOf('\n', lineStart);
  return nl === -1 ? text.length : nl;
}

/** Decode a quoted string at content[i] ('"'/"'"), reusing the parser grammar.
 *  Returns {value,next} (next = index past the closing quote) or null on malformed
 *  (never throws). @param {string} content @param {number} i */
function decodeString(content, i) {
  const sc = { text: content, i, line: 1, column: 1 };
  try {
    const value = content[i] === '"' ? parseBasicString(sc) : parseLiteralString(sc);
    return { value, next: sc.i };
  } catch { return null; }
}

/** Parse a table / array-of-tables HEADER line into its DECODED dotted-key segments.
 *  Returns {segments,isArray} or null when the line is not a well-formed header.
 *  @param {string} content one line (no newline) */
function parseHeader(content) {
  let i = skipSp(content, 0);
  if (content[i] !== '[') return null;
  i += 1;
  let isArray = false;
  if (content[i] === '[') { isArray = true; i += 1; }
  const segments = [];
  for (;;) {
    i = skipSp(content, i);
    const ch = content[i];
    if (ch === undefined) return null;
    if (ch === '"' || ch === "'") {
      const r = decodeString(content, i);
      if (!r) return null;
      segments.push(r.value); i = r.next;
    } else {
      let raw = '';
      while (isBareKeyChar(content[i])) { raw += content[i]; i += 1; }
      if (raw === '') return null;
      segments.push(raw);
    }
    i = skipSp(content, i);
    if (content[i] === '.') { i += 1; continue; }
    break;
  }
  if (content[i] !== ']') return null;
  i += 1;
  if (isArray) { if (content[i] !== ']') return null; }
  return { segments, isArray };
}

/** @param {string[]} a @param {string[]} b */
function eqSegments(a, b) {
  return a.length === b.length && a.every((x, k) => x === b[k]);
}

/** Collect every header in `text` with its body span [bodyStart, regionEnd). A region
 *  ends at the NEXT header line or EOF, so a sub-table header closes its parent region.
 *  @param {string} text
 *  @returns {Array<{segments:string[], isArray:boolean, bodyStart:number, regionEnd:number}>} */
function collectHeaders(text) {
  const heads = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const lineEnd = lineEndOf(text, i);
    const content = text.slice(i, lineEnd);
    if (content[skipSp(content, 0)] === '[') {
      const hdr = parseHeader(content);
      if (hdr) {
        if (heads.length) heads[heads.length - 1].regionEnd = i;
        heads.push({ segments: hdr.segments, isArray: hdr.isArray, bodyStart: lineEnd < n ? lineEnd + 1 : n, regionEnd: n });
      }
    }
    i = lineEnd + 1;
  }
  return heads;
}

/** Read a `<wantKey> = "<string>"` line; return the DECODED string value or null.
 *  @param {string} text @param {number} lineStart @param {number} lineEnd @param {string} wantKey */
function readStringKey(text, lineStart, lineEnd, wantKey) {
  let j = skipSp(text, lineStart);
  let key = '';
  while (j < lineEnd && isBareKeyChar(text[j])) { key += text[j]; j += 1; }
  if (key !== wantKey) return null;
  j = skipSp(text, j);
  if (text[j] !== '=') return null;
  j = skipSp(text, j + 1);
  if (text[j] !== '"' && text[j] !== "'") return null;
  const r = decodeString(text.slice(0, lineEnd), j);
  return r ? r.value : null;
}

/** True when the region body has a `<field> = "<value>"` line. @param {string} text
 *  @param {{bodyStart:number, regionEnd:number}} region @param {string} field @param {string} value */
function regionMatchesField(text, region, field, value) {
  let i = region.bodyStart;
  while (i < region.regionEnd) {
    const lineEnd = Math.min(lineEndOf(text, i), region.regionEnd);
    if (readStringKey(text, i, lineEnd, field) === value) return true;
    i = lineEnd + 1;
  }
  return false;
}

/** The `enabled = <token>` line(s) in a region — value-token byte range + literal +
 *  full-line range. Requires the bare key === 'enabled' (defends `enabled_tools`/quoted).
 *  @param {string} text @param {number} bodyStart @param {number} regionEnd */
function scanEnabledLines(text, bodyStart, regionEnd) {
  const out = [];
  let i = bodyStart;
  while (i < regionEnd) {
    const lineEnd = Math.min(lineEndOf(text, i), regionEnd);
    let j = skipSp(text, i);
    let key = '';
    while (j < lineEnd && isBareKeyChar(text[j])) { key += text[j]; j += 1; }
    if (key === 'enabled') {
      let k = skipSp(text, j);
      if (text[k] === '=') {
        k = skipSp(text, k + 1);
        const valStart = k;
        while (k < lineEnd && !isDelim(text[k])) k += 1;
        out.push({ valStart, valEnd: k, literal: text.slice(valStart, k), lineStart: i, lineEnd });
      }
    }
    i = lineEnd + 1;
  }
  return out;
}

/** Resolve the selector to its single matching table region. @param {string} text @param {EnableSelector} selector
 *  @returns {{region?:object, absent?:boolean, ambiguous?:boolean, error?:{code:string,message:string}}} */
function locateRegion(text, selector) {
  const heads = collectHeaders(text);
  const s = selector;
  let matches;
  if (s && s.kind === 'plugin' && typeof s.name === 'string') {
    matches = heads.filter((h) => !h.isArray && eqSegments(h.segments, ['plugins', s.name]));
  } else if (s && s.kind === 'mcp' && typeof s.name === 'string') {
    matches = heads.filter((h) => !h.isArray && eqSegments(h.segments, ['mcp_servers', s.name]));
  } else if (s && s.kind === 'skill' && s.match && (s.match.field === 'name' || s.match.field === 'path') && typeof s.match.value === 'string') {
    matches = heads.filter((h) => h.isArray && eqSegments(h.segments, ['skills', 'config'])
      && regionMatchesField(text, h, s.match.field, s.match.value));
  } else {
    return { error: { code: 'invalid-selector', message: 'unrecognized enable selector' } };
  }
  if (matches.length === 0) return { absent: true };
  if (matches.length > 1) return { ambiguous: true };
  return { region: matches[0] };
}

/**
 * Locate the `enabled` boolean for `selector` in `text`, retaining byte offsets.
 * NEVER throws. Returns a discriminated result:
 *   { found:false, absent:true }                          — no such table/element
 *   { found:false, ambiguous:true, error }                — selector matched >1 region
 *   { found:false, error:{code,message} }                 — bad input/selector
 *   { found:true, mode:'flip', tokenStart, tokenEnd, literal, lineStart, lineEnd, enabledCount }
 *   { found:true, mode:'insert', insertAt, enabledCount:0 } — table exists but has no `enabled` key
 * @param {string} text @param {EnableSelector} selector
 */
export function findEnableSpan(text, selector) {
  if (typeof text !== 'string') return { found: false, error: { code: 'input-not-string', message: 'text must be a string' } };
  const loc = locateRegion(text, selector);
  if (loc.error) return { found: false, error: loc.error };
  if (loc.ambiguous) return { found: false, ambiguous: true, error: { code: 'ambiguous-selector', message: 'selector matched more than one table' } };
  if (loc.absent) return { found: false, absent: true };
  const lines = scanEnabledLines(text, loc.region.bodyStart, loc.region.regionEnd);
  if (lines.length === 0) return { found: true, mode: 'insert', insertAt: loc.region.bodyStart, enabledCount: 0 };
  const first = lines[0];
  return {
    found: true, mode: 'flip',
    tokenStart: first.valStart, tokenEnd: first.valEnd, literal: first.literal,
    lineStart: first.lineStart, lineEnd: first.lineEnd, enabledCount: lines.length,
  };
}
