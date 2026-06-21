/**
 * Surgical JSON LOCATOR — settings.json `enabledPlugins` map (Claude plugin toggle).
 *
 * --- Why this exists ---
 * parseJsonc (jsonc-parser.mjs) is a VALUE parser: it builds a JS value tree and
 * DISCARDS byte positions, so it cannot edit a file in place. To disable/enable a
 * Claude plugin we must flip a single `"name@marketplace": <bool>` boolean inside the
 * top-level `enabledPlugins` object while preserving EVERY other byte (formatting,
 * key order, JSONC comments). This module is the missing byte-offset-retaining locator:
 * it walks the document with a string/comment-aware scanner and RETAINS the offsets the
 * value parser throws away — the boolean value token's byte range that the mutation step
 * (json-edit.mjs) splices, or the insertion point when the key is absent.
 *
 * It is the JSON sibling of toml-edit-locate.mjs and returns the SAME discriminated
 * shape (found/absent/ambiguous/error · mode 'flip'|'insert') so the engine + verify
 * code stay uniform.
 *
 * --- Secret safety is structural ---
 * The scanner only ever descends into the TOP-LEVEL `enabledPlugins` object and only
 * matches a member whose decoded key === the requested plugin key, returning ONLY a bare
 * `true`/`false` value token. It never reads `env` or any other top-level key, so a
 * secret can never enter a result. A non-boolean value is a refusal, never a token.
 *
 * Pure string processing; NEVER throws (a malformed structure → an error result, not a
 * throw); zero npm deps; no node:* imports.
 */

/** @typedef {{found:false, error:{code:string,message:string}}
 *   | {found:false, absent:true, insertAt:number, insertPrefix:string, memberCount:number}
 *   | {found:false, ambiguous:true, error:{code:string,message:string}}
 *   | {found:true, mode:'flip', tokenStart:number, tokenEnd:number, literal:string, current:boolean}} EnabledPluginSpan */

/** Whitespace char (JSON insignificant whitespace). @param {string|undefined} ch */
function isWs(ch) { return ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n'; }

/** Skip whitespace + `//` line and `/* *​/` block comments (JSONC) from `i`.
 *  Returns the new index, or -1 on an UNTERMINATED block comment (→ malformed).
 *  @param {string} text @param {number} i */
function skipTrivia(text, i) {
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (isWs(ch)) { i += 1; continue; }
    if (ch === '/' && text[i + 1] === '/') { i += 2; while (i < n && text[i] !== '\n') i += 1; continue; }
    if (ch === '/' && text[i + 1] === '*') {
      i += 2;
      let closed = false;
      while (i < n) { if (text[i] === '*' && text[i + 1] === '/') { i += 2; closed = true; break; } i += 1; }
      if (!closed) return -1;
      continue;
    }
    break;
  }
  return i;
}

/** Skip a JSON string starting at the opening quote (text[i] === '"'). Returns the index
 *  PAST the closing quote, or -1 if unterminated. Backslash escapes never mis-terminate.
 *  @param {string} text @param {number} i */
function skipString(text, i) {
  const n = text.length;
  i += 1; // consume opening "
  while (i < n) {
    const ch = text[i];
    if (ch === '\\') { i += 2; continue; }
    if (ch === '"') return i + 1;
    i += 1;
  }
  return -1;
}

/** Decode a JSON string literal at text[i] (opening quote). Returns {value, next} (next =
 *  index past the closing quote) or null on malformed. Handles standard escapes + \uXXXX.
 *  @param {string} text @param {number} i */
function decodeString(text, i) {
  const n = text.length;
  i += 1;
  let out = '';
  while (i < n) {
    const ch = text[i];
    if (ch === '"') return { value: out, next: i + 1 };
    if (ch === '\\') {
      const e = text[i + 1];
      if (e === undefined) return null;
      if (e === 'u') {
        const hex = text.slice(i + 2, i + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) return null;
        out += String.fromCharCode(parseInt(hex, 16)); i += 6; continue;
      }
      const SIMPLE = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
      out += Object.prototype.hasOwnProperty.call(SIMPLE, e) ? SIMPLE[e] : e;
      i += 2; continue;
    }
    out += ch; i += 1;
  }
  return null;
}

/** Skip one COMPLETE JSON value whose first char is at `i` (trivia already skipped):
 *  a string, an object/array (balanced, string+comment aware), or a primitive
 *  (number/true/false/null — consumed up to the next structural delimiter). Returns the
 *  index past the value, or -1 on malformed. @param {string} text @param {number} i */
function skipValue(text, i) {
  const n = text.length;
  const ch = text[i];
  if (ch === '"') return skipString(text, i);
  if (ch === '{' || ch === '[') {
    const close = ch === '{' ? '}' : ']';
    i += 1;
    for (;;) {
      i = skipTrivia(text, i);
      if (i < 0 || i >= n) return -1;
      const c = text[i];
      if (c === close) return i + 1;
      if (c === '"') { i = skipString(text, i); if (i < 0) return -1; continue; }
      if (c === '{' || c === '[') { i = skipValue(text, i); if (i < 0) return -1; continue; }
      i += 1; // structural ',' ':' or primitive char — harmless to step over
    }
  }
  // primitive: consume to the next delimiter
  let j = i;
  while (j < n) {
    const c = text[j];
    if (isWs(c) || c === ',' || c === '}' || c === ']' || c === '/') break;
    j += 1;
  }
  return j === i ? -1 : j;
}

/**
 * Walk the members of the object literal at `objStart` (text[objStart] === '{'),
 * collecting those whose decoded key === `wantKey`. Returns positions for the flip/insert
 * step. Never throws. @param {string} text @param {number} objStart @param {string} wantKey
 * @returns {{error:string} | {ok:true, matches:Array<{valueStart:number, valueEnd:number}>, bodyStart:number, firstKeyStart:number|null, memberCount:number}}
 */
function walkObject(text, objStart, wantKey) {
  const n = text.length;
  const bodyStart = objStart + 1;
  let i = bodyStart;
  const matches = [];
  let memberCount = 0;
  let firstKeyStart = null;
  for (;;) {
    i = skipTrivia(text, i);
    if (i < 0 || i >= n) return { error: 'malformed' };
    if (text[i] === '}') return { ok: true, matches, bodyStart, firstKeyStart, memberCount };
    if (text[i] !== '"') return { error: 'malformed' };
    const keyStart = i;
    if (firstKeyStart === null) firstKeyStart = keyStart;
    const dec = decodeString(text, i);
    if (!dec) return { error: 'malformed' };
    i = skipTrivia(text, dec.next);
    if (i < 0 || text[i] !== ':') return { error: 'malformed' };
    i = skipTrivia(text, i + 1);
    if (i < 0 || i >= n) return { error: 'malformed' };
    const valueStart = i;
    const valueEnd = skipValue(text, valueStart);
    if (valueEnd < 0) return { error: 'malformed' };
    memberCount += 1;
    if (dec.value === wantKey) matches.push({ valueStart, valueEnd });
    i = skipTrivia(text, valueEnd);
    if (i < 0 || i >= n) return { error: 'malformed' };
    if (text[i] === ',') { i += 1; continue; }
    if (text[i] === '}') return { ok: true, matches, bodyStart, firstKeyStart, memberCount };
    return { error: 'malformed' };
  }
}

/**
 * Locate the `enabledPlugins["<key>"]` boolean in `text`, retaining byte offsets.
 * NEVER throws. Discriminated result (mirrors toml-edit-locate.findEnableSpan):
 *   { found:false, error:{code,message} }                         — bad input / malformed / no-map / not-boolean
 *   { found:false, ambiguous:true, error }                        — duplicate enabledPlugins or duplicate member key
 *   { found:false, absent:true, insertAt, insertPrefix, memberCount } — map exists, key not present (enable→insert)
 *   { found:true, mode:'flip', tokenStart, tokenEnd, literal, current } — the boolean value token to flip
 * @param {string} text @param {string} key @returns {EnabledPluginSpan}
 */
export function findEnabledPluginSpan(text, key) {
  if (typeof text !== 'string') return { found: false, error: { code: 'input-not-string', message: 'text must be a string' } };
  if (typeof key !== 'string' || key.length === 0) return { found: false, error: { code: 'invalid-key', message: 'plugin key must be a non-empty string' } };
  const rootStart = skipTrivia(text, text.charCodeAt(0) === 0xFEFF ? 1 : 0);
  if (rootStart < 0 || text[rootStart] !== '{') return { found: false, error: { code: 'unparseable', message: 'settings.json root is not a JSON object' } };

  const top = walkObject(text, rootStart, 'enabledPlugins');
  if (top.error) return { found: false, error: { code: 'unparseable', message: 'settings.json is not parseable around enabledPlugins' } };
  if (top.matches.length > 1) return { found: false, ambiguous: true, error: { code: 'ambiguous-map', message: 'settings.json has more than one enabledPlugins key' } };
  if (top.matches.length === 0) return { found: false, error: { code: 'no-map', message: 'settings.json has no enabledPlugins object' } };

  const mapVal = top.matches[0];
  if (text[mapVal.valueStart] !== '{') return { found: false, error: { code: 'no-map', message: 'enabledPlugins is not a JSON object' } };

  const map = walkObject(text, mapVal.valueStart, key);
  if (map.error) return { found: false, error: { code: 'unparseable', message: 'the enabledPlugins object is not parseable' } };
  if (map.matches.length > 1) return { found: false, ambiguous: true, error: { code: 'ambiguous-key', message: `enabledPlugins has more than one '${key}' entry` } };
  if (map.matches.length === 0) {
    // Map exists but the key is absent → an insertion point at the object body start.
    // insertPrefix replicates the first member's leading whitespace (newline+indent); a
    // non-whitespace prefix (a leading comment) or an empty object falls back to a default.
    let insertPrefix = '\n  ';
    if (map.firstKeyStart !== null) {
      const raw = text.slice(map.bodyStart, map.firstKeyStart);
      if (/^[ \t\r\n]*$/.test(raw)) insertPrefix = raw;
    } else {
      insertPrefix = ''; // empty object {} → compact insert
    }
    return { found: false, absent: true, insertAt: map.bodyStart, insertPrefix, memberCount: map.memberCount };
  }

  const { valueStart, valueEnd } = map.matches[0];
  const literal = text.slice(valueStart, valueEnd);
  if (literal !== 'true' && literal !== 'false') {
    return { found: false, error: { code: 'not-boolean', message: `enabledPlugins['${key}'] is not a bare true/false (found ${literal.slice(0, 20)})` } };
  }
  return { found: true, mode: 'flip', tokenStart: valueStart, tokenEnd: valueEnd, literal, current: literal === 'true' };
}
