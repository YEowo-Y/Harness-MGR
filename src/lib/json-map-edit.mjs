/**
 * Surgical JSON in-place EDITOR for a STRING-valued member of a top-level MAP —
 * settings.json `skillOverrides` (Claude per-skill visibility).
 *
 * --- Why this is a SEPARATE editor from json-edit.mjs ---
 * json-edit.mjs flips a BOOLEAN token inside an EXISTING `enabledPlugins` map. A
 * skill-visibility override needs two things that path deliberately does not do:
 *   1. a STRING value ("off" / "name-only" / …), not a bare true/false; and
 *   2. CREATING the top-level map when `skillOverrides` is ABSENT (the plugin path
 *      refuses `no-map`; here absence is the COMMON first case — the map starts
 *      empty on every machine that has never set an override).
 * To avoid re-risking the DoD-approved plugin path, this module REUSES only the
 * string/comment-aware SCANNER (skipTrivia/skipValue/walkObject/decodeString,
 * exported from json-edit-locate.mjs) and isolates the new string+create logic here.
 *
 * --- Semantics ---
 *   member present, value === desired   → noop-already (no write)
 *   member present, value differs       → FLIP the string token
 *   member absent, map present          → INSERT "memberKey": "value" into the map
 *   map absent                          → CREATE "mapKey": { "memberKey": "value" }
 *                                         as a new top-level member of the root object
 *   member value is not a string / dup / dup map / map-not-object → refusal
 *
 * --- Security: the splice window is a single token (or one inserted member) ---
 * The only bytes written are the located string literal (flip) or the new member
 * (insert/create, structurally a new member of the map / the root). Every OTHER key
 * (env, etc.) is physically outside the window — never read, moved, or echoed. A
 * non-string value is refused by TYPE, never by echoing its bytes. `skillOverrides`
 * is an enum-domain map (skill-name → state), so the diff's before/after carry only
 * the member key + the enum value (synthesized, never the physical line).
 *
 * --- applyVerifiedMapEdit: fail-closed verification (the only function a write path calls) ---
 * After the edit it proves four invariants and returns the ORIGINAL text on any
 * failure: (V1) the result still parses (parseJsonc); (V2) every byte OUTSIDE the
 * changed span is byte-identical (position-based primary); (V3) re-locating the SAME
 * member yields `value`; (V4) the WHOLE reparsed document resolves
 * mapKey[memberKey] === value (semantic).
 *
 * Pure string-in/string-out; never throws; zero npm deps; no node:* imports.
 */

import { skipTrivia, walkObject, decodeString } from './json-edit-locate.mjs';
import { parseJsonc } from './jsonc-parser.mjs';

/** @typedef {{found:false, error:{code:string,message:string}}
 *   | {found:false, ambiguous:true, error:{code:string,message:string}}
 *   | {found:false, absent:true, insertAt:number, insertPrefix:string, memberCount:number}
 *   | {found:false, create:true, insertAt:number, insertPrefix:string, memberCount:number}
 *   | {found:true, mode:'flip', tokenStart:number, tokenEnd:number, current:string}} StringMemberSpan */

/**
 * @typedef {Object} MapEditResult
 * @property {boolean} changed
 * @property {string} text   the new text (=== input when unchanged)
 * @property {'flipped'|'inserted'|'created'|'noop-already'|null} reason
 * @property {string|null} before  the old member line (diff display); '' for insert/create
 * @property {string|null} after   the new member line (diff display)
 * @property {number} line   1-based line of the edited member (0 when not located)
 * @property {null|{code:string, message:string}} error
 */

/** Build the insert-prefix that replicates the FIRST member's leading whitespace of the
 *  object body at [bodyStart, firstKeyStart). A non-whitespace prefix (a leading comment)
 *  falls back to a 2-space default; an empty object → '' (compact). Mirrors json-edit-locate. */
function insertPrefixFor(text, bodyStart, firstKeyStart) {
  if (firstKeyStart === null) return '';
  const raw = text.slice(bodyStart, firstKeyStart);
  return /^[ \t\r\n]*$/.test(raw) ? raw : '\n  ';
}

/** 1-based line number of byte `offset` in `text`. @param {string} text @param {number} offset */
function lineNumberAt(text, offset) {
  let line = 1;
  const end = Math.min(offset, text.length);
  for (let k = 0; k < end; k += 1) if (text[k] === '\n') line += 1;
  return line;
}

/** Report a non-string value's TYPE (never its bytes — leak-proof for a hand-edited file). */
function typeOf(literal) {
  const c = literal[0];
  if (c === '{') return 'an object';
  if (c === '[') return 'an array';
  if (c === 't' || c === 'f') return 'a boolean';
  if (c === '-' || (c >= '0' && c <= '9')) return 'a number';
  if (c === 'n') return 'null';
  return 'a non-string value';
}

/**
 * Locate `<mapKey>.<memberKey>`'s STRING value token in `text`, retaining byte offsets.
 * NEVER throws. Discriminated result (mirrors findEnabledPluginSpan, plus a `create`
 * branch for an absent map):
 *   { found:false, error }                                   — bad input / malformed / map-not-object / not-string
 *   { found:false, ambiguous, error }                        — duplicate map or duplicate member key
 *   { found:false, create, insertAt, insertPrefix, memberCount } — map absent (insert a new top-level map)
 *   { found:false, absent, insertAt, insertPrefix, memberCount } — map present, member absent (insert a member)
 *   { found:true, mode:'flip', tokenStart, tokenEnd, current } — the string value token to replace
 * @param {string} text @param {string} mapKey @param {string} memberKey @returns {StringMemberSpan}
 */
export function findStringMemberSpan(text, mapKey, memberKey) {
  if (typeof text !== 'string') return { found: false, error: { code: 'input-not-string', message: 'text must be a string' } };
  if (typeof mapKey !== 'string' || mapKey.length === 0) return { found: false, error: { code: 'invalid-key', message: 'map key must be a non-empty string' } };
  if (typeof memberKey !== 'string' || memberKey.length === 0) return { found: false, error: { code: 'invalid-key', message: 'member key must be a non-empty string' } };
  const rootStart = skipTrivia(text, text.charCodeAt(0) === 0xFEFF ? 1 : 0);
  if (rootStart < 0 || text[rootStart] !== '{') return { found: false, error: { code: 'unparseable', message: 'settings.json root is not a JSON object' } };

  const top = walkObject(text, rootStart, mapKey);
  if (top.error) return { found: false, error: { code: 'unparseable', message: `settings.json is not parseable around ${mapKey}` } };
  if (top.matches.length > 1) return { found: false, ambiguous: true, error: { code: 'ambiguous-map', message: `settings.json has more than one ${mapKey} key` } };
  if (top.matches.length === 0) {
    // Map ABSENT → create a new top-level member at the root body (the common first case).
    return { found: false, create: true, insertAt: top.bodyStart, insertPrefix: insertPrefixFor(text, top.bodyStart, top.firstKeyStart), memberCount: top.memberCount };
  }

  const mapVal = top.matches[0];
  if (text[mapVal.valueStart] !== '{') return { found: false, error: { code: 'map-not-object', message: `${mapKey} is not a JSON object` } };

  const map = walkObject(text, mapVal.valueStart, memberKey);
  if (map.error) return { found: false, error: { code: 'unparseable', message: `the ${mapKey} object is not parseable` } };
  if (map.matches.length > 1) return { found: false, ambiguous: true, error: { code: 'ambiguous-key', message: `${mapKey} has more than one '${memberKey}' entry` } };
  if (map.matches.length === 0) {
    return { found: false, absent: true, insertAt: map.bodyStart, insertPrefix: insertPrefixFor(text, map.bodyStart, map.firstKeyStart), memberCount: map.memberCount };
  }

  const { valueStart, valueEnd } = map.matches[0];
  if (text[valueStart] !== '"') {
    return { found: false, error: { code: 'not-string', message: `${mapKey}['${memberKey}'] is not a string (found ${typeOf(text.slice(valueStart, valueEnd))})` } };
  }
  const dec = decodeString(text, valueStart);
  if (!dec) return { found: false, error: { code: 'unparseable', message: `${mapKey}['${memberKey}'] is not a decodable string` } };
  return { found: true, mode: 'flip', tokenStart: valueStart, tokenEnd: valueEnd, current: dec.value };
}

/** Splice a pre-built `member` into `span`'s host object body (the CREATE map member or the
 *  INSERT map member, built by the caller). Replicates sibling indentation and adds a trailing
 *  comma when the host already has members. @param {string} text @param {object} span
 *  @param {string} member @param {'created'|'inserted'} reason */
function insertMember(text, span, member, reason) {
  const snippet = span.memberCount > 0 ? `${span.insertPrefix}${member},` : member;
  const newText = text.slice(0, span.insertAt) + snippet + text.slice(span.insertAt);
  const at = span.insertAt + (span.memberCount > 0 ? span.insertPrefix.length : 0);
  return { changed: true, text: newText, reason, before: '', after: member, line: lineNumberAt(newText, at), error: null };
}

/**
 * Flip / insert / create (or report a safe no-op for) `<mapKey>.<memberKey> = value` in
 * `text`. NEVER throws. @param {string} text @param {string} mapKey @param {string} memberKey
 * @param {string} value @returns {MapEditResult}
 */
export function setStringMember(text, mapKey, memberKey, value) {
  const noop = (reason, extra) => ({ changed: false, text, reason, before: null, after: null, line: 0, error: null, ...extra });
  if (typeof text !== 'string') {
    return { changed: false, text: '', reason: null, before: null, after: null, line: 0, error: { code: 'input-not-string', message: 'text must be a string' } };
  }
  if (typeof value !== 'string') return noop(null, { error: { code: 'value-not-string', message: 'value must be a string' } });

  const span = findStringMemberSpan(text, mapKey, memberKey);
  if (span.error) return noop(null, { error: span.error });
  const inner = `${JSON.stringify(memberKey)}: ${JSON.stringify(value)}`;
  if (span.create) return insertMember(text, span, `${JSON.stringify(mapKey)}: { ${inner} }`, 'created');
  if (span.absent) return insertMember(text, span, inner, 'inserted');

  // Member present: flip the string token, or no-op when it already equals `value`.
  // The diff is synthesized from the key + value (enum domain) — never the physical line.
  const member = (v) => `${JSON.stringify(memberKey)}: ${JSON.stringify(v)}`;
  const line = lineNumberAt(text, span.tokenStart);
  if (span.current === value) {
    return { changed: false, text, reason: 'noop-already', before: member(span.current), after: member(value), line, error: null };
  }
  const newText = text.slice(0, span.tokenStart) + JSON.stringify(value) + text.slice(span.tokenEnd);
  return { changed: true, text: newText, reason: 'flipped', before: member(span.current), after: member(value), line, error: null };
}

/**
 * The ONLY function a write path may call. Runs setStringMember, then fail-closed verifies the
 * edit (V1 reparse-valid, V2 bytes-outside-span identical, V3 re-locate yields value, V4 the
 * whole reparsed doc resolves mapKey[memberKey] === value). Returns the ORIGINAL text on any
 * failure. A safe no-op returns ok:true, text unchanged, diff null.
 * @param {string} text @param {string} mapKey @param {string} memberKey @param {string} value
 * @returns {{ok:boolean, text:string, diff:null|{line:number,before:string,after:string}, reason?:string, error:null|{code:string,message:string}}}
 */
export function applyVerifiedMapEdit(text, mapKey, memberKey, value) {
  const r = setStringMember(text, mapKey, memberKey, value);
  if (r.error) return { ok: false, text: typeof text === 'string' ? text : '', diff: null, error: r.error };
  if (!r.changed) return { ok: true, text: r.text, diff: null, reason: r.reason, error: null };

  const fail = (code) => ({ ok: false, text, diff: null, error: { code: `verify-${code}`, message: `skill-visibility verification failed (${code}); no write performed` } });

  const span = findStringMemberSpan(text, mapKey, memberKey); // re-locate in the ORIGINAL for bounds
  const after = r.text;
  const diff = { line: r.line, before: /** @type {string} */ (r.before), after: /** @type {string} */ (r.after) };

  // V1 — still valid JSON(C).
  if (parseJsonc(after).errors.length !== 0) return fail('reparse-failed');

  if (r.reason === 'flipped') {
    if (!span.found || span.mode !== 'flip') return fail('relocate-original');
    const newTok = JSON.stringify(value);
    const delta = newTok.length - (span.tokenEnd - span.tokenStart);
    // V2 — every byte OUTSIDE the spliced token is byte-identical (position-based primary).
    if (text.slice(0, span.tokenStart) !== after.slice(0, span.tokenStart)) return fail('byte-drift-before');
    if (text.slice(span.tokenEnd) !== after.slice(span.tokenEnd + delta)) return fail('byte-drift-after');
  } else if (r.reason === 'inserted' || r.reason === 'created') {
    if (r.reason === 'inserted' ? !span.absent : !span.create) return fail('relocate-original');
    // V2-insert — the prefix [0,insertAt) and the original tail [insertAt,len) appear verbatim
    // at the head and tail of `after`, so every other key (env, etc.) is copied untouched.
    const insertAt = span.insertAt;
    if (after.length <= text.length) return fail('insert-no-growth');
    const tailLen = text.length - insertAt;
    if (after.slice(0, insertAt) !== text.slice(0, insertAt)) return fail('byte-drift-before');
    if (after.slice(after.length - tailLen) !== text.slice(insertAt)) return fail('byte-drift-after');
  } else {
    return fail('relocate-original');
  }

  // V3 — re-locate the SAME member in the result: a flip token whose decoded value === value.
  const re = findStringMemberSpan(after, mapKey, memberKey);
  if (!re.found || re.mode !== 'flip' || re.current !== value) return fail('postlocate-mismatch');

  // V4 — SEMANTIC: a real parser must see mapKey[memberKey] resolve to value. parseJsonc objects
  // are null-proto, so the key access is pollution-safe even for a __proto__-shaped key.
  const val = parseJsonc(after).value;
  const map = val && typeof val === 'object' ? val[mapKey] : undefined;
  const got = map && typeof map === 'object' ? map[memberKey] : undefined;
  if (got !== value) return fail('semantic-mismatch');
  return { ok: true, text: after, diff, reason: r.reason, error: null };
}
