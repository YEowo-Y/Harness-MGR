/**
 * Apply --paranoid re-verification (P4a.U1c) — the post-write re-read + re-parse of
 * a just-written governed *.json file, EXTRACTED VERBATIM from apply.mjs to keep
 * the apply orchestrator under the SLOC ceiling. Behavior is byte-identical to the
 * helpers that previously lived in apply.mjs.
 *
 * After apply writes a create/overwrite op whose target basename ends in `.json`,
 * the file is re-read from disk and re-parsed with the tolerant JSONC parser. A
 * parse failure (or an unreadable file) returns `{ok:false}` with an error
 * Diagnostic so apply can mark the journal `failed` (the snapshot is intact, so
 * `recover --rollback` restores the pre-apply bytes). A non-JSON target is never
 * read. A delete op writes no file, so apply never invokes this for a delete.
 *
 * PURE aside from the injected reader; NEVER THROWS (the read is try/caught). The
 * caller owns the read seam (defaulting to a real readFileSync), so this module is
 * hermetically unit-testable without touching disk.
 *
 * M2-SAFETY: imports ONLY src/lib/jsonc-parser.mjs (no node:fs, no src/paths.mjs).
 * Zero npm dependencies.
 */

import { parseJsonc } from '../lib/jsonc-parser.mjs';

/** @typedef {import('../lib/diagnostic.mjs').DiagnosticBag} DiagnosticBag */

/** Stable diagnostic phase tag for this module's findings (matches apply.mjs). */
const PHASE = 'apply';

/**
 * --paranoid re-verification of a single just-written op target: if the target is a
 * *.json file, re-read it from disk and re-parse it with the tolerant JSONC parser;
 * any parse error (or an unreadable file) returns `{ok:false}` with an error
 * Diagnostic. A non-JSON target is never read and returns `{ok:true}`. Pure aside
 * from the injected read; never throws.
 * @param {string} target          the op's absolute target path
 * @param {(p:string)=>string} readFileFn  injected disk reader
 * @param {DiagnosticBag} bag
 * @returns {{ok:boolean}}
 */
export function paranoidVerify(target, readFileFn, bag) {
  if (!isJsonTarget(target)) return { ok: true };
  let text;
  try {
    text = readFileFn(target);
  } catch (e) {
    bag.add({ severity: 'error', code: 'apply-paranoid-unreadable', phase: PHASE, path: target,
      message: `paranoid re-read failed: ${e instanceof Error ? e.message : String(e)}` });
    return { ok: false };
  }
  const { errors } = parseJsonc(text);
  if (errors && errors.length) {
    const e0 = errors[0];
    bag.add({ severity: 'error', code: 'apply-paranoid-parse-failed', phase: PHASE, path: target,
      message: `paranoid re-parse found invalid JSON: ${e0.message} (line ${e0.line}, column ${e0.column})` });
    return { ok: false };
  }
  return { ok: true };
}

/** True when `target`'s basename ends in `.json` (handles `\` and `/` separators). */
function isJsonTarget(target) {
  return String(target).split(/[\\/]/).pop().toLowerCase().endsWith('.json');
}
