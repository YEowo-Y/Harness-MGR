/**
 * Atomic settings.json in-place plugin-toggle primitive (Claude plugin enable/disable).
 *
 * The JSON sibling of atomicConfigEdit (atomic-toml-edit.mjs). It RE-READS the live
 * settings.json at apply time (NOT a stale copy from the dry-run read — this closes the
 * TOCTOU/clobber window, exactly like the codex config-edit primitive), computes a verified
 * single-token boolean flip / member insert via json-edit's applyVerifiedJsonEdit (which
 * re-parses + proves only the target token changed and every OTHER byte — env, etc. — is
 * byte-identical), and writes the result through the SHARED atomic-write primitive.
 *
 * GATE CONTEXT: settings.json is a whole-file apply-writable governed file (it is in
 * CLAUDE_WRITE_SURFACE.applyWritableFiles), so this writes through the EXISTING 'apply'
 * context — NO new gate context, NO descriptor.writeSurface change. (config.toml needed the
 * surgical 'config-edit' context because it is deliberately NOT apply-writable; settings.json
 * is, so the normal apply gate already authorizes it.)
 *
 * Secret safety is inherited STRUCTURALLY: applyVerifiedJsonEdit only ever yields text that
 * differs from the input by the one boolean token / one inserted enabledPlugins member, so the
 * bytes handed to atomic-write can never carry a moved/altered/exposed secret (env, etc.).
 *
 * M2-SAFETY: imports ONLY node:fs + src/lib/** (json-edit, diagnostic) + the sibling
 * atomic-write.mjs. NEVER src/paths.mjs. NEVER THROWS — every failure becomes a Diagnostic +
 * { ok:false }. Injectable readFn seam for hermetic tests. Zero npm deps.
 */

import { readFileSync } from 'node:fs';
import { DiagnosticBag } from '../lib/diagnostic.mjs';
import { applyVerifiedJsonEdit } from '../lib/json-edit.mjs';
import { atomicApplyWrite } from './atomic-write.mjs';

/** @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic */

/** Stable diagnostic phase tag (matches apply.mjs / atomic-write.mjs). */
const PHASE = 'apply';

/** Extract a human message from an unknown thrown value. */
function msg(e) { return e instanceof Error ? e.message : String(e); }

/**
 * @typedef {Object} JsonEditOpResult
 * @property {boolean} ok       true when the edit succeeded OR was a safe no-op.
 * @property {boolean} wrote    true only when the file's bytes were changed on disk.
 * @property {boolean} changed  alias of wrote.
 * @property {null|{line:number, before:string, after:string}} diff  the one-line diff.
 * @property {string} [reason]
 * @property {{newPath:string|null, oldPath:string|null}} [leftovers]
 * @property {Diagnostic[]} diagnostics
 */

/**
 * Read → verified plugin-toggle edit → gated atomic write (context 'apply'). NEVER throws.
 * @param {object} opts
 * @param {string} opts.target                            absolute path to settings.json
 * @param {{key:string}} opts.selector                    the plugin key to toggle
 * @param {boolean} opts.desired                          target boolean value
 * @param {(path:string, ctx:string)=>string} opts.assertWritable  REQUIRED gate
 * @param {object} [opts.retry]                           forwarded to atomicApplyWrite
 * @param {(p:string)=>string} [opts.readFn]              read seam (default utf8 readFileSync)
 * @returns {Promise<JsonEditOpResult>}
 */
export async function atomicJsonEdit(opts) {
  const bag = new DiagnosticBag();
  const fail = (code, message) => {
    bag.add({ severity: 'error', code, message, phase: PHASE });
    return { ok: false, wrote: false, changed: false, diff: null, diagnostics: bag.all() };
  };
  try {
    const o = opts && typeof opts === 'object' ? opts : {};
    const { target, selector, desired, assertWritable, retry } = o;
    const readFn = typeof o.readFn === 'function' ? o.readFn : ((p) => readFileSync(p, 'utf8'));
    const key = selector && typeof selector === 'object' ? selector.key : undefined;

    if (typeof target !== 'string' || target.length === 0) return fail('apply-json-edit-bad-args', 'target must be a non-empty string');
    if (typeof key !== 'string' || key.length === 0) return fail('apply-json-edit-bad-args', 'selector.key must be a non-empty string');
    if (typeof desired !== 'boolean') return fail('apply-json-edit-bad-args', 'desired must be a boolean');
    if (typeof assertWritable !== 'function') return fail('apply-json-edit-bad-args', 'assertWritable (the governed-write gate) must be injected');

    // Read the LIVE file (the pre-apply snapshot already captured it whole; this is the edit source).
    let text;
    try { text = readFn(target); } catch (e) { return fail('apply-json-edit-read-failed', `could not read ${target}: ${msg(e)}`); }
    if (typeof text !== 'string') return fail('apply-json-edit-read-failed', `read of ${target} did not return text`);

    // Compute the verified, fail-closed plugin-toggle edit.
    const v = applyVerifiedJsonEdit(text, key, desired);
    if (!v.ok) return fail('apply-json-edit-verify-failed', `plugin-toggle refused: ${v.error ? `${v.error.code} — ${v.error.message}` : 'unknown'}`);

    // No-op (already in the desired state / absent-disable): write NOTHING.
    if (v.diff === null || v.text === text) {
      bag.add({ severity: 'info', code: 'apply-json-edit-noop', phase: PHASE, message: `plugin-toggle is a no-op (${v.reason ?? 'no change'}); nothing written` });
      return { ok: true, wrote: false, changed: false, diff: null, reason: v.reason ?? 'noop', diagnostics: bag.all() };
    }

    // Write the edited bytes via the shared atomic primitive, gated 'apply' (settings.json is
    // whole-file apply-writable — no new gate context needed).
    const w = await atomicApplyWrite({ target, content: v.text, assertWritable, context: 'apply', retry });
    for (const d of w.diagnostics ?? []) bag.add(d);
    return { ok: w.ok, wrote: w.wrote, changed: w.wrote, diff: v.diff, leftovers: w.leftovers, diagnostics: bag.all() };
  } catch (e) {
    return fail('apply-json-edit-unexpected-error', `unexpected error during plugin-toggle: ${msg(e)}`);
  }
}
