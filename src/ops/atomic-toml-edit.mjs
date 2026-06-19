/**
 * Atomic config-file in-place edit primitive (P6 write wave · config-edit unit).
 *
 * Reads the live config file, computes a SINGLE-TOKEN `enabled` flip via toml-edit's
 * fail-closed applyVerifiedEdit (which re-parses + proves only the target token
 * changed and every OTHER byte — including secret regions — is byte-identical), then
 * writes the result through the SHARED atomic-write primitive with the 'config-edit'
 * gate context. No new atomic machinery: atomicApplyWrite already accepts a gate
 * context and provides the crash-recoverable .mgr-new/.mgr-old dance; the gate
 * (write-gate.mjs) authorizes ONLY a configEditFiles basename under the config dir in
 * the 'config-edit' context. A no-op edit (already in the desired state / table or key
 * absent) writes NOTHING.
 *
 * Secret safety is inherited STRUCTURALLY: applyVerifiedEdit only ever yields text
 * that differs from the input by the one boolean token, so the bytes handed to
 * atomic-write can never carry a moved/altered/exposed secret region.
 *
 * M2-SAFETY: imports ONLY node:fs + src/lib/** (toml-edit, diagnostic) + the sibling
 * atomic-write.mjs. NEVER src/paths.mjs. NEVER THROWS — every failure becomes a
 * Diagnostic + { ok:false }. Injectable readFn seam for hermetic tests. Zero npm deps.
 */

import { readFileSync } from 'node:fs';
import { DiagnosticBag } from '../lib/diagnostic.mjs';
import { applyVerifiedEdit } from '../lib/toml-edit.mjs';
import { atomicApplyWrite } from './atomic-write.mjs';

/** @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic */
/** @typedef {import('../lib/toml-edit-locate.mjs').EnableSelector} EnableSelector */

/** Stable diagnostic phase tag (matches apply.mjs / atomic-write.mjs). */
const PHASE = 'apply';

/**
 * @typedef {Object} ConfigEditResult
 * @property {boolean} ok       true when the edit succeeded OR was a safe no-op.
 * @property {boolean} wrote    true only when the file's bytes were changed on disk.
 * @property {boolean} changed  alias of wrote (the edit produced a different file).
 * @property {null|{line:number, before:string, after:string}} diff  the one-line diff.
 * @property {string} [reason]
 * @property {{newPath:string|null, oldPath:string|null}} [leftovers]
 * @property {Diagnostic[]} diagnostics
 */

/** Extract a human message from an unknown thrown value. */
function msg(e) { return e instanceof Error ? e.message : String(e); }

/**
 * Read → verified single-token edit → gated atomic write. NEVER throws.
 * @param {object} opts
 * @param {string} opts.target                            absolute path to config.toml
 * @param {EnableSelector} opts.selector                  which `enabled` to flip
 * @param {boolean} opts.desired                          target boolean value
 * @param {(path:string, ctx:string)=>string} opts.assertWritable  REQUIRED gate
 * @param {object} [opts.retry]                           forwarded to atomicApplyWrite
 * @param {(p:string)=>string} [opts.readFn]              read seam (default utf8 readFileSync)
 * @returns {Promise<ConfigEditResult>}
 */
export async function atomicConfigEdit(opts) {
  const bag = new DiagnosticBag();
  const fail = (code, message) => {
    bag.add({ severity: 'error', code, message, phase: PHASE });
    return { ok: false, wrote: false, changed: false, diff: null, diagnostics: bag.all() };
  };
  try {
    const o = opts && typeof opts === 'object' ? opts : {};
    const { target, selector, desired, assertWritable, retry } = o;
    const readFn = typeof o.readFn === 'function' ? o.readFn : ((p) => readFileSync(p, 'utf8'));

    if (typeof target !== 'string' || target.length === 0) return fail('apply-config-edit-bad-args', 'target must be a non-empty string');
    if (typeof desired !== 'boolean') return fail('apply-config-edit-bad-args', 'desired must be a boolean');
    if (typeof assertWritable !== 'function') return fail('apply-config-edit-bad-args', 'assertWritable (the governed-write gate) must be injected');

    // Read the live file (the pre-apply snapshot already captured it whole; this is the edit source).
    let text;
    try { text = readFn(target); } catch (e) { return fail('apply-config-edit-read-failed', `could not read ${target}: ${msg(e)}`); }
    if (typeof text !== 'string') return fail('apply-config-edit-read-failed', `read of ${target} did not return text`);

    // Compute the verified, fail-closed single-token edit.
    const v = applyVerifiedEdit(text, selector, desired);
    if (!v.ok) return fail('apply-config-edit-verify-failed', `config-edit refused: ${v.error ? `${v.error.code} — ${v.error.message}` : 'unknown'}`);

    // No-op (already in the desired state, or the table/key is absent): write NOTHING.
    if (v.diff === null || v.text === text) {
      bag.add({ severity: 'info', code: 'apply-config-edit-noop', phase: PHASE, message: `config-edit is a no-op (${v.reason ?? 'no change'}); nothing written` });
      return { ok: true, wrote: false, changed: false, diff: null, reason: v.reason ?? 'noop', diagnostics: bag.all() };
    }

    // Write the spliced bytes via the shared atomic primitive, gated 'config-edit'.
    const w = await atomicApplyWrite({ target, content: v.text, assertWritable, context: 'config-edit', retry });
    for (const d of w.diagnostics ?? []) bag.add(d);
    return { ok: w.ok, wrote: w.wrote, changed: w.wrote, diff: v.diff, leftovers: w.leftovers, diagnostics: bag.all() };
  } catch (e) {
    return fail('apply-config-edit-unexpected-error', `unexpected error during config-edit: ${msg(e)}`);
  }
}
