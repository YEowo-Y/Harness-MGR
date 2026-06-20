/**
 * Surgical TOML in-place EDITOR — config.toml subset (P6 write wave, config-edit unit).
 *
 * The mutation half of the locate↔mutate pair (locator = toml-edit-locate.mjs). Given
 * a located `enabled = <bool>` token, FLIP it true↔false by replacing ONLY that token's
 * byte range — every other byte (comments, whitespace, key order, and the secret regions
 * config.toml holds) is copied verbatim by text.slice(). The MVP is FLIP only; inserting
 * an `enabled` key (the mcp case — no enabled key exists there today) is deferred to the
 * mcp unit, where it gets its own secret-adjacency tests. A key-absent table here is a
 * safe no-op ('noop-absent-key'), never a guessed insert.
 *
 * --- Security: the splice window is a single token ---
 * The only bytes written are the `true`/`false` literal. Secret bytes (mcp_servers.*.env
 * sub-tables, bearer_token_env_var lines) are physically outside the window and are never
 * read, moved, or echoed. The diff fields (before/after) are ONLY the `enabled` line.
 *
 * --- applyVerifiedEdit: fail-closed verification (the only function a write path calls) ---
 * After the flip it proves three independent invariants and returns the ORIGINAL text on
 * any failure: (V1) the result still parses; (V2) every byte OUTSIDE the spliced token is
 * byte-identical — the primary, position-based guarantee (immune to the array-of-tables
 * index problem for skills); (V3) re-locating the SAME selector in the result yields the
 * desired literal with EXACTLY one `enabled` line in the region (a TOML last-wins / duplicate
 * guard). This is the load-bearing safety net per the design's adversarial review.
 *
 * Pure string-in/string-out; never throws; zero npm deps; no node:* imports.
 */

import { findEnableSpan } from './toml-edit-locate.mjs';
import { parseToml } from './toml-parser.mjs';

/** @typedef {import('./toml-edit-locate.mjs').EnableSelector} EnableSelector */

/**
 * @typedef {Object} EditResult
 * @property {boolean} changed
 * @property {string} text   the new text (=== input when unchanged)
 * @property {'flipped'|'inserted'|'noop-already'|'noop-absent-table'|'noop-absent-key'|'noop-default-enabled'|null} reason
 * @property {string|null} before  the old `enabled` line (diff display); '' for an insert (no prior line)
 * @property {string|null} after   the new `enabled` line (diff display)
 * @property {number} line   1-based line of the `enabled` token (0 when not located)
 * @property {null|{code:string, message:string}} error
 */

/** The `enabled` boolean the selector resolves to in the WHOLE reparsed document — the
 *  semantic V4 guarantee that the byte edit actually achieved its goal. It defeats a region
 *  mis-split (e.g. a column-0 array-of-arrays row `[123]` that a line scanner mistakes for a
 *  header, hiding the real `enabled` so an INSERT silently adds a DUPLICATE key V1/V3 miss):
 *  parseToml is a real parser, so it sees the true (TOML last-wins) value. Returns undefined
 *  when absent / not a boolean, or for the not-yet-shipped skill kind (which never reaches a
 *  write path; undefined → V4 fails closed, forcing the skill unit to extend this).
 *  @param {any} value parseToml(after).value @param {import('./toml-edit-locate.mjs').EnableSelector} selector */
function resolveEnabledValue(value, selector) {
  if (!value || typeof value !== 'object' || !selector) return undefined;
  if (selector.kind === 'plugin') return value.plugins?.[selector.name]?.enabled;
  if (selector.kind === 'mcp') return value.mcp_servers?.[selector.name]?.enabled;
  return undefined; // skill: a name/path-indexed array — its semantic check lands with the skill unit
}

/** 1-based line number of byte `offset` in `text`. @param {string} text @param {number} offset */
function lineNumberAt(text, offset) {
  let line = 1;
  const end = Math.min(offset, text.length);
  for (let k = 0; k < end; k += 1) if (text[k] === '\n') line += 1;
  return line;
}

/** The newline style to emit at `insertAt`: match the line that terminates just before
 *  the insertion point (CRLF when that line ended `\r\n`); fall back to the document's
 *  first newline, defaulting LF. @param {string} text @param {number} insertAt */
function detectNewline(text, insertAt) {
  if (insertAt >= 1 && text[insertAt - 1] === '\n') return insertAt >= 2 && text[insertAt - 2] === '\r' ? '\r\n' : '\n';
  const j = text.indexOf('\n');
  return j >= 1 && text[j - 1] === '\r' ? '\r\n' : '\n';
}

/** Build the INSERT edit — add `enabled = false` as a NEW line at `insertAt` (the region
 *  bodyStart, structurally BEFORE any [..env] secret sub-table). The HIGH fix: when the
 *  byte before insertAt is not a newline (a header at EOF with no trailing newline), a
 *  leading newline is prepended so the inserted key never glues onto the header line.
 *  @param {string} text @param {number} insertAt @returns {import('./toml-edit.mjs').EditResult} */
function insertDisabled(text, insertAt) {
  const nl = detectNewline(text, insertAt);
  const before = text.slice(0, insertAt);
  const lead = before.length > 0 && !before.endsWith('\n') ? nl : '';
  const newText = `${before}${lead}enabled = false${nl}${text.slice(insertAt)}`;
  return {
    changed: true, text: newText, reason: 'inserted',
    before: '', after: 'enabled = false',
    line: lineNumberAt(newText, before.length + lead.length), error: null,
  };
}

/**
 * Flip (or report a safe no-op for) the `enabled` boolean named by `selector`. NEVER throws.
 * @param {string} text @param {EnableSelector} selector @param {boolean} desired @returns {EditResult}
 */
export function setEnabled(text, selector, desired) {
  /** @type {(reason:EditResult['reason'], extra?:object)=>EditResult} */
  const noop = (reason, extra) => ({ changed: false, text, reason, before: null, after: null, line: 0, error: null, ...extra });
  if (typeof text !== 'string') {
    return { changed: false, text: '', reason: null, before: null, after: null, line: 0, error: { code: 'input-not-string', message: 'text must be a string' } };
  }
  if (typeof desired !== 'boolean') return noop(null, { error: { code: 'desired-not-boolean', message: 'desired must be a boolean' } });

  const span = findEnableSpan(text, selector);
  if (span.error) return noop(null, { error: span.error });
  if (span.absent) return noop('noop-absent-table');
  if (span.mode === 'insert') {
    // No `enabled` key present. For mcp an absent key means default-ENABLED, so:
    //   disable → INSERT `enabled = false` as the first body line (before any [..env] secret);
    //   enable  → safe no-op (already enabled by default — do NOT add a redundant `enabled = true`).
    // Other kinds (plugin/skill always carry an explicit enabled) keep the deferred no-op.
    if (selector && selector.kind === 'mcp') {
      return desired === false ? insertDisabled(text, span.insertAt) : noop('noop-default-enabled', { insertAt: span.insertAt });
    }
    return noop('noop-absent-key', { insertAt: span.insertAt });
  }

  if (span.literal !== 'true' && span.literal !== 'false') {
    return noop(null, { error: { code: 'enabled-not-boolean', message: `enabled is '${span.literal}', not a boolean` } });
  }
  const want = desired ? 'true' : 'false';
  const oldLine = text.slice(span.lineStart, span.lineEnd);
  if (span.literal === want) {
    return { changed: false, text, reason: 'noop-already', before: oldLine, after: oldLine, line: lineNumberAt(text, span.tokenStart), error: null };
  }
  const newText = text.slice(0, span.tokenStart) + want + text.slice(span.tokenEnd);
  const delta = want.length - span.literal.length;
  return {
    changed: true, text: newText, reason: 'flipped',
    before: oldLine, after: newText.slice(span.lineStart, span.lineEnd + delta),
    line: lineNumberAt(text, span.tokenStart), error: null,
  };
}

/**
 * The ONLY function a write path may call. Runs setEnabled, then fail-closed verifies the
 * flip (V1 reparse-valid, V2 bytes-outside-token identical, V3 re-locate yields desired with
 * exactly one enabled line). On any failure returns ok:false with the ORIGINAL text.
 * A safe no-op (already in state / absent) returns ok:true with text unchanged and diff null.
 * @param {string} text @param {EnableSelector} selector @param {boolean} desired
 * @returns {{ok:boolean, text:string, diff:null|{line:number,before:string,after:string}, reason?:string, error:null|{code:string,message:string}}}
 */
export function applyVerifiedEdit(text, selector, desired) {
  const r = setEnabled(text, selector, desired);
  if (r.error) return { ok: false, text: typeof text === 'string' ? text : '', diff: null, error: r.error };
  if (!r.changed) return { ok: true, text: r.text, diff: null, reason: r.reason, error: null };

  /** @param {string} code */
  const fail = (code) => ({ ok: false, text, diff: null, error: { code: `verify-${code}`, message: `config-edit verification failed (${code}); no write performed` } });

  const span = findEnableSpan(text, selector); // re-locate in the ORIGINAL for the token/insert bounds
  const after = r.text;
  const diff = { line: r.line, before: /** @type {string} */ (r.before), after: /** @type {string} */ (r.after) };

  // V1 — the result is still valid TOML (shared by flip + insert).
  const parsed = parseToml(after);
  if (parsed.errors.length !== 0) return fail('reparse-failed');
  // V4 — SEMANTIC: the WHOLE reparsed document resolves the selector's enabled to `desired`.
  // A real parser (TOML last-wins) catches a region mis-split that wrote a duplicate `enabled`
  // the line scanner can't see (the array-of-arrays `[123]` header-confusion class) — neither
  // the position-based V2 nor the same-scanner V3 covers that. Shared by flip + insert.
  const v4 = () => resolveEnabledValue(parsed.value, selector) === desired;

  if (span.found && span.mode === 'flip') {
    const want = desired ? 'true' : 'false';
    const delta = want.length - span.literal.length;
    // V2 — every byte OUTSIDE the spliced token is byte-identical (primary, position-based).
    if (text.slice(0, span.tokenStart) !== after.slice(0, span.tokenStart)) return fail('byte-drift-before');
    if (text.slice(span.tokenEnd) !== after.slice(span.tokenEnd + delta)) return fail('byte-drift-after');
    // V3 — re-locate the SAME selector in the result: desired literal, exactly one enabled line.
    const re = findEnableSpan(after, selector);
    if (!re.found || re.mode !== 'flip' || re.literal !== want || re.enabledCount !== 1) return fail('postlocate-mismatch');
    if (!v4()) return fail('semantic-mismatch');
    return { ok: true, text: after, diff, reason: 'flipped', error: null };
  }

  if (span.found && span.mode === 'insert') {
    // Insert (mcp disable): EXACTLY one contiguous insertion at insertAt, every original byte
    // preserved. V2-insert is the position-based primary — the prefix [0,insertAt) and the
    // original tail [insertAt,len) must appear verbatim at the head and tail of `after`, so
    // every secret region (all physically after insertAt) is copied untouched.
    const insertAt = span.insertAt;
    if (after.length <= text.length) return fail('insert-no-growth');
    const tailLen = text.length - insertAt;
    if (after.slice(0, insertAt) !== text.slice(0, insertAt)) return fail('byte-drift-before');
    if (after.slice(after.length - tailLen) !== text.slice(insertAt)) return fail('byte-drift-after');
    // V3 — the result now resolves to a FLIP at a single `enabled = false` line.
    const re = findEnableSpan(after, selector);
    if (!re.found || re.mode !== 'flip' || re.literal !== 'false' || re.enabledCount !== 1) return fail('postlocate-mismatch');
    if (!v4()) return fail('semantic-mismatch');
    return { ok: true, text: after, diff, reason: 'inserted', error: null };
  }

  return fail('relocate-original');
}
