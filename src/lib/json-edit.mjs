/**
 * Surgical JSON in-place EDITOR — settings.json `enabledPlugins` (Claude plugin toggle).
 *
 * The mutation half of the locate↔mutate pair (locator = json-edit-locate.mjs), the JSON
 * sibling of toml-edit.mjs. Given a located `"name@marketplace": <bool>` token, FLIP it
 * true↔false by replacing ONLY that token's byte range — every other byte (formatting, key
 * order, JSONC comments) is copied verbatim by text.slice(). When the key is ABSENT from an
 * existing enabledPlugins object, ENABLE inserts `"name@marketplace": true` (DISABLE of an
 * absent key is a safe no-op: the settings-map model treats an absent key as not-enabled).
 *
 * --- Semantics (aligned with claude.mjs pluginEnableModel:'settings-map') ---
 *   key present, already desired      → noop-already (no write)
 *   key present, differs              → FLIP the boolean token
 *   key absent, enable                → INSERT "key": true into the existing map
 *   key absent, disable               → noop-absent-disable (already not-enabled)
 *   no enabledPlugins object          → error 'no-map'
 *   value not a bare boolean / dup    → error (the locator's refusal)
 *
 * --- Security: the splice window is a single token (or one inserted member) ---
 * The only bytes written are the `true`/`false` literal (flip) or the new member (insert,
 * structurally inside the enabledPlugins object). settings.json's other keys (env, etc.) are
 * physically outside the window and are never read, moved, or echoed.
 *
 * --- applyVerifiedJsonEdit: fail-closed verification (the only function a write path calls) ---
 * After the edit it proves four invariants and returns the ORIGINAL text on any failure:
 * (V1) the result still parses (parseJsonc); (V2) every byte OUTSIDE the changed span is
 * byte-identical (position-based primary); (V3) re-locating the SAME key yields `desired`;
 * (V4) the WHOLE reparsed document resolves enabledPlugins[key] === desired (semantic).
 *
 * Pure string-in/string-out; never throws; zero npm deps; no node:* imports.
 */

import { findEnabledPluginSpan } from './json-edit-locate.mjs';
import { parseJsonc } from './jsonc-parser.mjs';

/**
 * @typedef {Object} JsonEditResult
 * @property {boolean} changed
 * @property {string} text   the new text (=== input when unchanged)
 * @property {'flipped'|'inserted'|'noop-already'|'noop-absent-disable'|null} reason
 * @property {string|null} before  the old member line (diff display); '' for an insert
 * @property {string|null} after   the new member line (diff display)
 * @property {number} line   1-based line of the edited token (0 when not located)
 * @property {null|{code:string, message:string}} error
 */

/** 1-based line number of byte `offset` in `text`. @param {string} text @param {number} offset */
function lineNumberAt(text, offset) {
  let line = 1;
  const end = Math.min(offset, text.length);
  for (let k = 0; k < end; k += 1) if (text[k] === '\n') line += 1;
  return line;
}

/** Build the INSERT edit — add `"key": true` as a new member at the enabledPlugins body start
 *  (before the first member, replicating its leading whitespace), or compactly into an empty
 *  object. The key is JSON-escaped via JSON.stringify so any char is safe. @param {string} text
 *  @param {{insertAt:number, insertPrefix:string, memberCount:number}} span @param {string} key */
function insertEnabled(text, span, key) {
  const member = `${JSON.stringify(key)}: true`;
  const snippet = span.memberCount > 0 ? `${span.insertPrefix}${member},` : member;
  const newText = text.slice(0, span.insertAt) + snippet + text.slice(span.insertAt);
  const keyAt = span.insertAt + (span.memberCount > 0 ? span.insertPrefix.length : 0);
  return { changed: true, text: newText, reason: 'inserted', before: '', after: member, line: lineNumberAt(newText, keyAt), error: null };
}

/**
 * Flip / insert (or report a safe no-op for) enabledPlugins[`key`] in `text`. NEVER throws.
 * @param {string} text @param {string} key @param {boolean} desired @returns {JsonEditResult}
 */
export function setPluginEnabled(text, key, desired) {
  /** @type {(reason:JsonEditResult['reason'], extra?:object)=>JsonEditResult} */
  const noop = (reason, extra) => ({ changed: false, text, reason, before: null, after: null, line: 0, error: null, ...extra });
  if (typeof text !== 'string') {
    return { changed: false, text: '', reason: null, before: null, after: null, line: 0, error: { code: 'input-not-string', message: 'text must be a string' } };
  }
  if (typeof desired !== 'boolean') return noop(null, { error: { code: 'desired-not-boolean', message: 'desired must be a boolean' } });

  const span = findEnabledPluginSpan(text, key);
  if (span.error) return noop(null, { error: span.error }); // no-map / not-boolean / ambiguous / unparseable
  if (span.absent) {
    // Key not in the map. enable → INSERT; disable → safe no-op (already not-enabled per the model).
    return desired === true ? insertEnabled(text, span, key) : noop('noop-absent-disable', { insertAt: span.insertAt });
  }

  const want = desired ? 'true' : 'false';
  // Build the diff from the key + boolean — NEVER slice the physical line. A hand-minified
  // settings.json could co-locate an env secret on the same line as the plugin member, and the
  // diff is echoed to stdout; synthesizing `"key": <bool>` is leak-proof by construction (the
  // written bytes are still verified byte-identical-outside-the-token by applyVerifiedJsonEdit V2).
  const member = (val) => `${JSON.stringify(key)}: ${val}`;
  const line = lineNumberAt(text, span.tokenStart);
  if (span.literal === want) {
    return { changed: false, text, reason: 'noop-already', before: member(span.literal), after: member(want), line, error: null };
  }
  const newText = text.slice(0, span.tokenStart) + want + text.slice(span.tokenEnd);
  return { changed: true, text: newText, reason: 'flipped', before: member(span.literal), after: member(want), line, error: null };
}

/**
 * The ONLY function a write path may call. Runs setPluginEnabled, then fail-closed verifies the
 * edit (V1 reparse-valid, V2 bytes-outside-span identical, V3 re-locate yields desired, V4 the
 * whole reparsed doc resolves enabledPlugins[key] === desired). Returns the ORIGINAL text on any
 * failure. A safe no-op returns ok:true, text unchanged, diff null.
 * @param {string} text @param {string} key @param {boolean} desired
 * @returns {{ok:boolean, text:string, diff:null|{line:number,before:string,after:string}, reason?:string, error:null|{code:string,message:string}}}
 */
export function applyVerifiedJsonEdit(text, key, desired) {
  const r = setPluginEnabled(text, key, desired);
  if (r.error) return { ok: false, text: typeof text === 'string' ? text : '', diff: null, error: r.error };
  if (!r.changed) return { ok: true, text: r.text, diff: null, reason: r.reason, error: null };

  /** @param {string} code */
  const fail = (code) => ({ ok: false, text, diff: null, error: { code: `verify-${code}`, message: `plugin-toggle verification failed (${code}); no write performed` } });

  const span = findEnabledPluginSpan(text, key); // re-locate in the ORIGINAL for token/insert bounds
  const after = r.text;
  const diff = { line: r.line, before: /** @type {string} */ (r.before), after: /** @type {string} */ (r.after) };

  // V1 — the result is still valid JSON(C).
  if (parseJsonc(after).errors.length !== 0) return fail('reparse-failed');

  if (r.reason === 'flipped') {
    if (!span.found || span.mode !== 'flip') return fail('relocate-original');
    const want = desired ? 'true' : 'false';
    const delta = want.length - span.literal.length;
    // V2 — every byte OUTSIDE the spliced token is byte-identical (position-based primary).
    if (text.slice(0, span.tokenStart) !== after.slice(0, span.tokenStart)) return fail('byte-drift-before');
    if (text.slice(span.tokenEnd) !== after.slice(span.tokenEnd + delta)) return fail('byte-drift-after');
    // V3 — re-locate the SAME key in the result: a flip token resolving to desired.
    const re = findEnabledPluginSpan(after, key);
    if (!re.found || re.mode !== 'flip' || re.current !== desired) return fail('postlocate-mismatch');
  } else if (r.reason === 'inserted') {
    if (!span.absent) return fail('relocate-original');
    // V2-insert — the prefix [0,insertAt) and the original tail [insertAt,len) appear verbatim
    // at the head and tail of `after`, so every other key (env, etc.) is copied untouched.
    const insertAt = span.insertAt;
    if (after.length <= text.length) return fail('insert-no-growth');
    const tailLen = text.length - insertAt;
    if (after.slice(0, insertAt) !== text.slice(0, insertAt)) return fail('byte-drift-before');
    if (after.slice(after.length - tailLen) !== text.slice(insertAt)) return fail('byte-drift-after');
    // V3 — the inserted member now resolves to a flip token === true.
    const re = findEnabledPluginSpan(after, key);
    if (!re.found || re.mode !== 'flip' || re.current !== true) return fail('postlocate-mismatch');
  } else {
    return fail('relocate-original');
  }

  // V4 — SEMANTIC: a real parser must see enabledPlugins[key] resolve to desired (catches any
  // structural mis-edit the position checks can't). parseJsonc objects are null-proto, so the
  // key access is pollution-safe even for a __proto__-shaped plugin key.
  const val = parseJsonc(after).value;
  const ep = val && typeof val === 'object' ? val.enabledPlugins : undefined;
  const got = ep && typeof ep === 'object' ? ep[key] : undefined;
  if (got !== desired) return fail('semantic-mismatch');
  return { ok: true, text: after, diff, reason: r.reason, error: null };
}
