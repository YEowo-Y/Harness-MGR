/**
 * Atomic single-file DELETE primitive (P4a.U1b) — the crash-recoverable delete
 * of ONE governed config file. The delete analogue of atomic-write.mjs.
 *
 * SIMPLER than the write primitive: there is no staging, no new content, and no
 * restore branch. `rename` is atomic, so on failure the target is untouched — the
 * delete either happens (the move-aside succeeds) or it does not (the target stays
 * exactly where it was). The dance is just:
 *
 *   1. validate : write NOTHING on bad input.
 *   2. gate     : assertWritable(target, context) FIRST — a denied gate touches
 *                 NOTHING.
 *   3. delete   : rename `<target>` → `<target>.mgr-old`. This move-aside IS the
 *                 deletion — `target` disappears at its path while its bytes are
 *                 preserved in the `.mgr-old` sidecar (recoverable in the crash
 *                 window). rename-replace clobbers any stale `.mgr-old` from a
 *                 prior crash (mirrors atomic-write's backup step — never trust
 *                 stale sidecar bytes).
 *   4. cleanup  : best-effort `rm <target>.mgr-old`. Errors are swallowed — a
 *                 leftover `.mgr-old` is doctor #21 / gc's job, NEVER a throw.
 *
 * CRASH WINDOW (process death, NOT a thrown step): if the process dies AFTER the
 * rename (target → `.mgr-old`) but BEFORE the cleanup rm, `target` is absent on
 * disk while the ORIGINAL bytes sit safely in `.mgr-old`. The auto-snapshot taken
 * by the apply lifecycle (U1c) is the PRIMARY undo for a remove; this primitive's
 * `.mgr-old` only matters in that narrow crash window, and doctor #21 detects the
 * stranded sidecar.
 *
 * The rename that can hit a transient Windows EBUSY / EPERM (AV scanners, the
 * indexer, another handle) is wrapped in withRetry; the caller's `retry` schedule
 * is forwarded so tests can disable backoff. "best-effort rm" swallows cleanup
 * errors — a stranded sidecar is a leftover, never a thrown error.
 *
 * SECURITY / SAFETY invariants (mirroring atomic-write.mjs / lock.mjs / apply.mjs):
 *   - assertWritable is INJECTED + REQUIRED (fail-closed: refuse if absent or not a
 *     function — never silently bypass the governed-write gate). It is checked
 *     FIRST, before any filesystem touch, so a denied gate touches NOTHING. The
 *     gate is called with `opts.context` (default 'remove'; deleting a component is
 *     the remove feature's job). The gate, not this primitive, decides what each
 *     context may delete. The gate approves `target`; the `.mgr-old` sidecar is its
 *     trusted sibling in the SAME gate-approved directory and is intentionally NOT
 *     re-gated — its basename is not a `.md` leaf, so gating it would wrongly throw
 *     `write-remove-only` and break the delete. Do NOT "fix" this by routing the
 *     sidecar through the gate.
 *   - M2-SAFETY: imports ONLY node:fs + src/lib/retry.mjs + src/lib/diagnostic.mjs.
 *     NEVER src/paths.mjs — the assertWritable gate + dirs are injected params,
 *     keeping this ops module's static graph paths.mjs-free (the M2-safe property
 *     the boundary self-check enforces).
 *   - NEVER THROWS — the whole body is wrapped; even an unexpected error becomes a
 *     Diagnostic + `{ ok:false }`. Injectable seams make every branch hermetic.
 *   - SINGLE-WRITER assumption: the caller MUST hold the apply lock (lock.mjs) so
 *     no concurrent writer can recreate `target` between the gate check and the
 *     rename. The apply path holds that lock; do NOT reuse this primitive lock-free.
 *
 * Ops-layer constraint: node:fs + src/lib/** only. Zero npm dependencies.
 */

import { renameSync, rmSync } from 'node:fs';
import { withRetry } from '../lib/retry.mjs';
import { DiagnosticBag } from '../lib/diagnostic.mjs';

/** @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic */
/** @typedef {import('../lib/retry.mjs').RetryOptions} RetryOptions */

/** Stable diagnostic phase tag for every finding this module emits. */
const PHASE = 'apply';

/** Empty leftovers — nothing stranded on disk. */
const NO_LEFTOVERS = Object.freeze({ oldPath: null });

/**
 * @typedef {Object} AtomicDeleteResult
 * @property {boolean} ok        true ONLY when the target was renamed away (deleted).
 * @property {boolean} deleted   true once the target no longer exists at its path.
 * @property {{ oldPath: string|null }} leftovers  a sidecar deliberately left on
 *           disk after a CATASTROPHIC failure (so doctor #21 / recover can find it);
 *           null on the normal paths.
 * @property {Diagnostic[]} diagnostics
 */

/**
 * Production default seams. Overridable via `opts.seams` for hermetic tests.
 *   renameFn — rename a→b (the move-aside that IS the deletion).
 *   rmFn     — best-effort remove (force:true so an absent path is a no-op).
 */
const DEFAULT_SEAMS = Object.freeze({
  renameFn: (a, b) => renameSync(a, b),
  rmFn: (p) => rmSync(p, { force: true }),
});

/**
 * Atomically delete `target`, with a crash-recoverable `.mgr-old` sidecar. NEVER
 * throws — every failure becomes a Diagnostic plus `{ ok:false }`. Touches NOTHING
 * when validation fails or the gate denies.
 *
 * @param {object} opts
 * @param {string} opts.target                              absolute path to delete
 * @param {(path: string, ctx: string) => string} opts.assertWritable  REQUIRED gate
 * @param {'remove'|'apply'|'rollback'|'probe'} [opts.context]  gate context (default
 *           'remove'); deleting a component is the remove feature's job. Passed
 *           straight to assertWritable — the gate coerces an unknown context to
 *           'apply'.
 * @param {RetryOptions} [opts.retry]                        forwarded to withRetry
 * @param {{renameFn?:Function, rmFn?:Function}} [opts.seams]
 * @returns {Promise<AtomicDeleteResult>}
 */
export async function atomicApplyDelete(opts) {
  const bag = new DiagnosticBag();
  const fail = makeFailer(bag);
  try {
    const o = opts && typeof opts === 'object' ? opts : {};
    const { target, assertWritable, retry } = o;
    // Default the gate context to 'remove' when absent; pass it through verbatim
    // otherwise (the gate itself coerces an unknown context to 'apply').
    const context = o.context === undefined ? 'remove' : o.context;

    // 1. Validate — touch NOTHING on bad input.
    if (typeof target !== 'string' || target.length === 0) {
      return fail('apply-delete-bad-args', 'target must be a non-empty string');
    }
    if (typeof assertWritable !== 'function') {
      return fail('apply-delete-bad-args', 'assertWritable (the governed-write gate) must be injected');
    }

    // 2. Gate FIRST — a denied gate touches NOTHING.
    try {
      assertWritable(target, context);
    } catch (e) {
      return fail('apply-delete-gate-denied', `delete gate denied: ${msg(e)}`, target);
    }

    return await runAtomicDelete({ target, retry, seams: resolveSeams(o.seams), bag, fail });
  } catch (e) {
    // Absolute backstop: an unexpected error becomes a diagnostic, never a throw.
    return fail('apply-delete-unexpected-error', `unexpected error during atomic delete: ${msg(e)}`);
  }
}

/**
 * Move the target aside (the deletion), then best-effort drop the `.mgr-old`
 * sidecar. Assumes inputs are validated and the gate has passed. Never throws
 * (the rename is try/caught; cleanup is swallowed). Extracted to keep
 * atomicApplyDelete under the SLOC limit.
 * @param {object} a
 * @param {string} a.target @param {RetryOptions|undefined} a.retry
 * @param {{renameFn:Function, rmFn:Function}} a.seams
 * @param {DiagnosticBag} a.bag
 * @param {(code:string,message:string,path?:string)=>AtomicDeleteResult} a.fail
 * @returns {Promise<AtomicDeleteResult>}
 */
async function runAtomicDelete(a) {
  const { target, retry, seams, bag, fail } = a;
  const { renameFn, rmFn } = seams;
  const oldPath = target + '.mgr-old';
  const bestEffortRm = (p) => { try { rmFn(p); } catch { /* swallow — leftover, not a throw */ } };

  // 3. Delete: move the target aside. This rename IS the deletion. On failure
  //    (ENOENT absent target, or a persistent EBUSY after retries) the target is
  //    untouched and nothing is stranded.
  try {
    await withRetry(() => renameFn(target, oldPath), retry);
  } catch (e) {
    return fail('apply-delete-failed', `could not delete the file: ${msg(e)}`, target);
  }

  // 4. Cleanup: drop the `.mgr-old` sidecar (best-effort). The target is gone; a
  //    failed rm leaves a leftover for doctor #21 / gc, never surfaced as an error.
  bestEffortRm(oldPath);
  return { ok: true, deleted: true, leftovers: { oldPath: null }, diagnostics: bag.all() };
}

// ── small shared helpers ─────────────────────────────────────────────────────────

/**
 * Build the standard failure closure: add an error diagnostic and return an
 * `ok:false` result with empty leftovers (the normal failure paths strand nothing
 * — the move-aside is atomic, so a failed delete leaves the target in place).
 * @param {DiagnosticBag} bag
 * @returns {(code: string, message: string, path?: string) => AtomicDeleteResult}
 */
function makeFailer(bag) {
  return (code, message, path) => {
    bag.add({ severity: 'error', code, message, phase: PHASE, ...(path ? { path } : {}) });
    return { ok: false, deleted: false, leftovers: NO_LEFTOVERS, diagnostics: bag.all() };
  };
}

/**
 * Merge caller seams over the production defaults, so a partial `seams` override
 * (e.g. only `renameFn`) keeps the real implementation for the rest.
 * @param {object|undefined} seams
 * @returns {{renameFn:Function, rmFn:Function}}
 */
function resolveSeams(seams) {
  const s = seams && typeof seams === 'object' ? seams : {};
  return {
    renameFn: typeof s.renameFn === 'function' ? s.renameFn : DEFAULT_SEAMS.renameFn,
    rmFn: typeof s.rmFn === 'function' ? s.rmFn : DEFAULT_SEAMS.rmFn,
  };
}

/** Extract a human message from an unknown thrown value. */
function msg(e) {
  return e instanceof Error ? e.message : String(e);
}
