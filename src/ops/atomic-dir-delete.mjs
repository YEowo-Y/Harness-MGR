/**
 * Atomic single-DIRECTORY DELETE primitive (P4b.S2) — the crash-recoverable
 * delete of ONE governed skill directory (skills/<name>/). The directory analogue
 * of atomic-delete.mjs (which deletes a single FILE).
 *
 * A directory delete is more involved than a file delete in two ways:
 *
 *   A. TYPE ENFORCEMENT (mandated by the S1 security-reviewer): the write gate
 *      validates PATH SHAPE only (is `target` a legal direct-child of skills/), so
 *      the primitive must verify the FILESYSTEM TYPE before any destructive action.
 *      After the gate passes, an lstatSync inspects the target — it MUST exist, be
 *      a directory, and NOT be a symlink. Non-existent, symlink, and non-directory
 *      targets are each refused with their own code and NOTHING is touched.
 *
 *   B. STALE-SIDECAR PRE-CLEAR: rename(dir → dir.mgr-old) CANNOT overwrite an
 *      existing DIRECTORY on Windows (MOVEFILE_REPLACE_EXISTING is files-only).
 *      So BEFORE the move-aside we best-effort remove any pre-existing
 *      `<target>.mgr-old` (a crash sidecar from a prior interrupted delete).
 *      The pre-clear uses rmDirFn (rmSync recursive) which is swallowed; a
 *      leftover stale sidecar that blocks the rename will surface as
 *      apply-dir-delete-failed.
 *
 * The dance after validation + gating:
 *
 *   1. validate  — bad args / missing gate → refuse, touch NOTHING.
 *   2. gate FIRST — assertWritable(target, context='remove-skill') → a denied gate
 *                   touches NOTHING.
 *   3. type ENFORCE — lstatSync(target): must exist + be a dir + not a symlink;
 *                     otherwise refuse with a per-case code, touch NOTHING.
 *   4. stale pre-clear — best-effort rmDirFn(<target>.mgr-old); swallow errors.
 *   5. rename(target → <target>.mgr-old) via withRetry — on failure
 *                         apply-dir-delete-failed; target untouched.
 *   6. best-effort rm — rmDirFn(<target>.mgr-old); swallow errors.
 *   7. success: { ok:true, deleted:true, leftovers:{oldPath:null} }.
 *
 * CRASH WINDOW: if the process dies AFTER step 5 (rename) but BEFORE step 6
 * (cleanup rm), the skill dir is absent at its path while its tree is preserved
 * in the `.mgr-old` sidecar. The auto-snapshot taken by the apply lifecycle is
 * the primary undo; the `.mgr-old` is the crash-window secondary; doctor #21
 * detects the stranded sidecar; gc reaps it.
 *
 * RECURSIVE CLEANUP NOTE: rmDirFn uses rmSync(p, {recursive:true, force:true}).
 * Node's rmSync recursive removes a symlink ENTRY as the link itself (it does NOT
 * follow the symlink out to the target) — so cleanup cannot escape the sidecar
 * subtree. This is a Node runtime guarantee, not an assumption: see Node.js docs
 * on fs.rmSync recursive which mirrors the POSIX 'rm -r' never-dereference
 * behaviour. The same applies to the `.mgr-old` sidecar tree.
 *
 * SIDECAR NOT RE-GATED: the `.mgr-old` sidecar is a trusted sibling in the
 * gate-approved parent directory. Routing it through assertWritable would wrongly
 * throw `write-remove-skill-only` (the gate only allows the bare skill dir name,
 * not `<name>.mgr-old`). Do NOT "fix" this — it mirrors atomic-delete.mjs.
 *
 * SECURITY / SAFETY invariants (mirrors atomic-delete.mjs / atomic-write.mjs):
 *   - assertWritable INJECTED + REQUIRED (fail-closed: refuse if absent or not a
 *     function). Called FIRST, before any filesystem touch.
 *   - Type check (lstatSync) happens AFTER the gate but BEFORE any rename/delete.
 *   - M2-SAFE: imports ONLY node:fs + src/lib/retry.mjs + src/lib/diagnostic.mjs.
 *     NEVER src/paths.mjs or src/lib/reexport.mjs (top-level await).
 *   - NEVER THROWS — top-level try/catch backstop; every failure becomes a
 *     Diagnostic + { ok:false }.
 *   - SINGLE-WRITER assumption: caller MUST hold the apply lock (lock.mjs).
 *
 * Ops-layer constraint: node:fs + src/lib/** only. Zero npm dependencies.
 */

import { renameSync, rmSync, lstatSync } from 'node:fs';
import { withRetry } from '../lib/retry.mjs';
import { DiagnosticBag } from '../lib/diagnostic.mjs';

/** @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic */
/** @typedef {import('../lib/retry.mjs').RetryOptions} RetryOptions */

/** Stable diagnostic phase tag for every finding this module emits. */
const PHASE = 'apply';

/** Empty leftovers — nothing stranded on disk. */
const NO_LEFTOVERS = Object.freeze({ oldPath: null });

/**
 * @typedef {Object} AtomicDirDeleteResult
 * @property {boolean} ok        true ONLY when the dir was renamed away (deleted).
 * @property {boolean} deleted   true once the dir no longer exists at its path.
 * @property {{ oldPath: string|null }} leftovers  null on normal paths; a stranded
 *           sidecar is doctor #21 / gc's job.
 * @property {Diagnostic[]} diagnostics
 */

/**
 * Production default seams. Overridable via `opts.seams` for hermetic tests.
 *   renameFn — rename a→b (the move-aside that IS the deletion).
 *   rmDirFn  — best-effort recursive remove (force:true so an absent path is ok).
 *   lstatFn  — stat without following symlinks (type enforcement).
 */
const DEFAULT_SEAMS = Object.freeze({
  renameFn: (a, b) => renameSync(a, b),
  rmDirFn: (p) => rmSync(p, { recursive: true, force: true }),
  lstatFn: (p) => lstatSync(p),
});

/**
 * Atomically delete a skill directory `target`, with a crash-recoverable
 * `.mgr-old` sidecar. NEVER throws — every failure becomes a Diagnostic plus
 * `{ ok:false }`. Touches NOTHING when validation fails or the gate denies.
 * Type enforcement (lstat) runs AFTER the gate but BEFORE any rename/delete.
 *
 * @param {object} opts
 * @param {string} opts.target                              absolute path to dir to delete
 * @param {(path: string, ctx: string) => string} opts.assertWritable  REQUIRED gate
 * @param {'remove-skill'|string} [opts.context]            gate context (default 'remove-skill')
 * @param {RetryOptions} [opts.retry]                       forwarded to withRetry
 * @param {{renameFn?:Function, rmDirFn?:Function, lstatFn?:Function}} [opts.seams]
 * @returns {Promise<AtomicDirDeleteResult>}
 */
export async function atomicApplyDirDelete(opts) {
  const bag = new DiagnosticBag();
  const fail = makeFailer(bag);
  try {
    const o = opts && typeof opts === 'object' ? opts : {};
    const { target, assertWritable, retry } = o;
    const context = o.context === undefined ? 'remove-skill' : o.context;

    // 1. Validate — touch NOTHING on bad input.
    if (typeof target !== 'string' || target.length === 0) {
      return fail('apply-dir-delete-bad-args', 'target must be a non-empty string');
    }
    if (typeof assertWritable !== 'function') {
      return fail('apply-dir-delete-bad-args', 'assertWritable (the governed-write gate) must be injected');
    }

    // 2. Gate FIRST — a denied gate touches NOTHING.
    try {
      assertWritable(target, context);
    } catch (e) {
      return fail('apply-dir-delete-gate-denied', `delete gate denied: ${msg(e)}`, target);
    }

    const seams = resolveSeams(o.seams);

    // 3. Type enforcement — lstatSync AFTER the gate, BEFORE any rename/delete.
    //    The gate validated the PATH SHAPE; we now confirm the fs TYPE.
    let stat;
    try {
      stat = seams.lstatFn(target);
    } catch (e) {
      // lstat threw — most likely ENOENT (target does not exist).
      if (e && e.code === 'ENOENT') {
        return fail('apply-dir-delete-not-found', `skill directory not found: ${target}`, target);
      }
      return fail('apply-dir-delete-not-found', `cannot stat target: ${msg(e)}`, target);
    }

    if (stat.isSymbolicLink()) {
      return fail('apply-dir-delete-is-symlink', `refusing to delete a symlink: ${target}`, target);
    }
    if (!stat.isDirectory()) {
      return fail('apply-dir-delete-not-a-dir', `target is not a directory: ${target}`, target);
    }

    return await runAtomicDirDelete({ target, retry, seams, bag, fail });
  } catch (e) {
    // Absolute backstop — even an unexpected error becomes a Diagnostic, never a throw.
    return fail('apply-dir-delete-unexpected-error', `unexpected error during atomic dir-delete: ${msg(e)}`);
  }
}

/**
 * Pre-clear any stale sidecar, move the target aside (the deletion), then
 * best-effort drop the `.mgr-old` sidecar. Assumes inputs are validated and the
 * gate + type check have passed. Never throws. Extracted to keep
 * atomicApplyDirDelete under the SLOC limit.
 * @param {object} a
 * @param {string} a.target  @param {RetryOptions|undefined} a.retry
 * @param {{renameFn:Function, rmDirFn:Function, lstatFn:Function}} a.seams
 * @param {DiagnosticBag} a.bag
 * @param {(code:string,message:string,path?:string)=>AtomicDirDeleteResult} a.fail
 * @returns {Promise<AtomicDirDeleteResult>}
 */
async function runAtomicDirDelete(a) {
  const { target, retry, seams, fail } = a;
  const { renameFn, rmDirFn } = seams;
  const oldPath = target + '.mgr-old';

  // best-effort recursive remove; errors swallowed — a leftover is gc's job.
  const bestEffortRmDir = (p) => { try { rmDirFn(p); } catch { /* swallow */ } };

  // 4. Stale-sidecar pre-clear: Windows rename cannot overwrite an existing dir.
  //    Remove any pre-existing <target>.mgr-old so the move-aside can succeed.
  bestEffortRmDir(oldPath);

  // 5. Delete: move the target aside. This rename IS the deletion. On failure
  //    (persistent EBUSY / EPERM after retries, or a stale sidecar that couldn't
  //    be pre-cleared) the target is untouched and nothing is stranded.
  try {
    await withRetry(() => renameFn(target, oldPath), retry);
  } catch (e) {
    return fail('apply-dir-delete-failed', `could not delete the directory: ${msg(e)}`, target);
  }

  // 6. Cleanup: drop the `.mgr-old` sidecar (best-effort recursive).
  //    Node rmSync recursive removes a symlink entry as the link itself — it does
  //    NOT follow the symlink out, so cleanup cannot escape the sidecar subtree.
  bestEffortRmDir(oldPath);

  return { ok: true, deleted: true, leftovers: { oldPath: null }, diagnostics: a.bag.all() };
}

// ── small shared helpers ─────────────────────────────────────────────────────────

/**
 * Build the standard failure closure.
 * @param {DiagnosticBag} bag
 * @returns {(code: string, message: string, path?: string) => AtomicDirDeleteResult}
 */
function makeFailer(bag) {
  return (code, message, path) => {
    bag.add({ severity: 'error', code, message, phase: PHASE, ...(path ? { path } : {}) });
    return { ok: false, deleted: false, leftovers: NO_LEFTOVERS, diagnostics: bag.all() };
  };
}

/**
 * Merge caller seams over the production defaults.
 * @param {object|undefined} seams
 * @returns {{renameFn:Function, rmDirFn:Function, lstatFn:Function}}
 */
function resolveSeams(seams) {
  const s = seams && typeof seams === 'object' ? seams : {};
  return {
    renameFn: typeof s.renameFn === 'function' ? s.renameFn : DEFAULT_SEAMS.renameFn,
    rmDirFn: typeof s.rmDirFn === 'function' ? s.rmDirFn : DEFAULT_SEAMS.rmDirFn,
    lstatFn: typeof s.lstatFn === 'function' ? s.lstatFn : DEFAULT_SEAMS.lstatFn,
  };
}

/** Extract a human message from an unknown thrown value. */
function msg(e) {
  return e instanceof Error ? e.message : String(e);
}
