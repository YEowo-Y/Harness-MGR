/**
 * Atomic settings.json in-place skill-visibility primitive (Claude per-skill override).
 *
 * The string-map sibling of atomicJsonEdit (atomic-json-edit.mjs). It RE-READS the live
 * settings.json at apply time (NOT a stale copy from the dry-run read — this closes the
 * TOCTOU/clobber window), computes a verified single-token string flip / member insert /
 * map creation via json-map-edit's applyVerifiedMapEdit (which re-parses + proves only the
 * target span changed and every OTHER byte — env, etc. — is byte-identical), and writes the
 * result through the SHARED atomic-write primitive.
 *
 * GATE CONTEXT: settings.json is a whole-file apply-writable governed file (it is in
 * CLAUDE_WRITE_SURFACE.applyWritableFiles), so this writes through the EXISTING 'apply'
 * context — NO new gate context, NO descriptor.writeSurface change (exactly like
 * atomic-json-edit for the plugin toggle).
 *
 * Secret safety is inherited STRUCTURALLY: applyVerifiedMapEdit only ever yields text that
 * differs from the input by the one string token / one inserted skillOverrides member / one
 * created skillOverrides map, so the bytes handed to atomic-write can never carry a
 * moved/altered/exposed secret (env, etc.).
 *
 * M2-SAFETY: imports ONLY node:fs + src/lib/** (json-map-edit, diagnostic) + the sibling
 * atomic-write.mjs. NEVER src/paths.mjs. NEVER THROWS — every failure becomes a Diagnostic +
 * { ok:false }. Injectable readFn seam for hermetic tests. Zero npm deps.
 */

import { readFileSync } from 'node:fs';
import { DiagnosticBag } from '../lib/diagnostic.mjs';
import { applyVerifiedMapEdit } from '../lib/json-map-edit.mjs';
import { atomicApplyWrite } from './atomic-write.mjs';

/** @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic */

/** Stable diagnostic phase tag (matches apply.mjs / atomic-write.mjs). */
const PHASE = 'apply';

/** Extract a human message from an unknown thrown value. */
function msg(e) { return e instanceof Error ? e.message : String(e); }

/**
 * @typedef {Object} JsonMapEditOpResult
 * @property {boolean} ok       true when the edit succeeded OR was a safe no-op.
 * @property {boolean} wrote    true only when the file's bytes were changed on disk.
 * @property {boolean} changed  alias of wrote.
 * @property {null|{line:number, before:string, after:string}} diff  the one-line diff.
 * @property {string} [reason]
 * @property {{newPath:string|null, oldPath:string|null}} [leftovers]
 * @property {Diagnostic[]} diagnostics
 */

/**
 * Read → verified skill-visibility edit → gated atomic write (context 'apply'). NEVER throws.
 * @param {object} opts
 * @param {string} opts.target                            absolute path to settings.json
 * @param {{mapKey:string, memberKey:string}} opts.selector  the map + member to set
 * @param {string} opts.value                             target string value (the enum state)
 * @param {(path:string, ctx:string)=>string} opts.assertWritable  REQUIRED gate
 * @param {object} [opts.retry]                           forwarded to atomicApplyWrite
 * @param {(p:string)=>string} [opts.readFn]              read seam (default utf8 readFileSync)
 * @returns {Promise<JsonMapEditOpResult>}
 */
export async function atomicJsonMapEdit(opts) {
  const bag = new DiagnosticBag();
  const fail = (code, message) => {
    bag.add({ severity: 'error', code, message, phase: PHASE });
    return { ok: false, wrote: false, changed: false, diff: null, diagnostics: bag.all() };
  };
  try {
    const o = opts && typeof opts === 'object' ? opts : {};
    const { target, selector, value, assertWritable, retry } = o;
    const readFn = typeof o.readFn === 'function' ? o.readFn : ((p) => readFileSync(p, 'utf8'));
    const mapKey = selector && typeof selector === 'object' ? selector.mapKey : undefined;
    const memberKey = selector && typeof selector === 'object' ? selector.memberKey : undefined;

    if (typeof target !== 'string' || target.length === 0) return fail('apply-json-map-edit-bad-args', 'target must be a non-empty string');
    if (typeof mapKey !== 'string' || mapKey.length === 0) return fail('apply-json-map-edit-bad-args', 'selector.mapKey must be a non-empty string');
    if (typeof memberKey !== 'string' || memberKey.length === 0) return fail('apply-json-map-edit-bad-args', 'selector.memberKey must be a non-empty string');
    if (typeof value !== 'string') return fail('apply-json-map-edit-bad-args', 'value must be a string');
    if (typeof assertWritable !== 'function') return fail('apply-json-map-edit-bad-args', 'assertWritable (the governed-write gate) must be injected');

    // Read the LIVE file (the pre-apply snapshot already captured it whole; this is the edit source).
    let text;
    try { text = readFn(target); } catch (e) { return fail('apply-json-map-edit-read-failed', `could not read ${target}: ${msg(e)}`); }
    if (typeof text !== 'string') return fail('apply-json-map-edit-read-failed', `read of ${target} did not return text`);

    // Compute the verified, fail-closed skill-visibility edit.
    const v = applyVerifiedMapEdit(text, mapKey, memberKey, value);
    if (!v.ok) return fail('apply-json-map-edit-verify-failed', `skill-visibility refused: ${v.error ? `${v.error.code} — ${v.error.message}` : 'unknown'}`);

    // No-op (already in the desired state): write NOTHING.
    if (v.diff === null || v.text === text) {
      bag.add({ severity: 'info', code: 'apply-json-map-edit-noop', phase: PHASE, message: `skill-visibility is a no-op (${v.reason ?? 'no change'}); nothing written` });
      return { ok: true, wrote: false, changed: false, diff: null, reason: v.reason ?? 'noop', diagnostics: bag.all() };
    }

    // Write the edited bytes via the shared atomic primitive, gated 'apply' (settings.json is
    // whole-file apply-writable — no new gate context needed).
    const w = await atomicApplyWrite({ target, content: v.text, assertWritable, context: 'apply', retry });
    for (const d of w.diagnostics ?? []) bag.add(d);
    return { ok: w.ok, wrote: w.wrote, changed: w.wrote, diff: v.diff, leftovers: w.leftovers, diagnostics: bag.all() };
  } catch (e) {
    return fail('apply-json-map-edit-unexpected-error', `unexpected error during skill-visibility: ${msg(e)}`);
  }
}
