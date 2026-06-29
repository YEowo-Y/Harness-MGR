/**
 * Atomic single-file write primitive (P3.U13 sub-unit B) — the Windows-hardened
 * write-back used to replace ONE governed config file safely.
 *
 * SHARED BY apply AND rollback (P3.U17): the apply path passes `context:'apply'`
 * (the default) and string content; the rollback restore path (rollback-restore.mjs)
 * passes `context:'rollback'` and Buffer content (binary-safe). The `apply-write-*`
 * diagnostic codes name the PRIMITIVE, not the calling command — a rollback that
 * hits a staging failure still surfaces `apply-write-staging-failed` (the code is a
 * stable identifier for "the atomic-write primitive failed at stage X").
 *
 * The classic atomic-replace dance, with `.mgr-new` / `.mgr-old` sidecar files so
 * a crash at any step leaves a recoverable state:
 *
 *   1. stage   : write the new content to `<target>.mgr-new`
 *   2. backup  : if target exists, rename it to `<target>.mgr-old`
 *   3. commit  : rename `<target>.mgr-new` → `<target>`
 *   4. cleanup : on success, remove the `.mgr-old` backup
 *
 * Failure semantics (per plan apply flow, line 497):
 *   - staging fails  → remove `.mgr-new`, target untouched.
 *   - backup fails   → remove `.mgr-new`, target untouched.
 *   - commit fails + target existed → restore from `.mgr-old`:
 *       restore OK    → remove `.mgr-new` (target restored, no leftovers).
 *       restore FAILS → LEAVE both `.mgr-new` and `.mgr-old` on disk for doctor
 *                       #21 / recover to find (`leftovers` carries both paths).
 *   - commit fails + no prior target → remove `.mgr-new`.
 *
 * CRASH WINDOW (process death, NOT a thrown step): if the process dies AFTER the
 * backup rename (target → `.mgr-old`) but BEFORE the commit rename, `target` is
 * absent on disk while the ORIGINAL bytes sit safely in `.mgr-old` and the new
 * content in `.mgr-new`. This is an inherent property of a rename-based two-phase
 * replace, not a bug — doctor #21 detects both stranded sidecars and the absent
 * `target` is reconcilable from `.mgr-old`. Automated restore is NOT yet built:
 * `recover --mark-failed` (P3.U14) only marks the journal; the actual restore is
 * `recover --rollback` (P3.U18), which MUST treat "target absent + `.mgr-old`
 * present + journal at `applying`" as a first-class restore case.
 *
 * The fs ops that can hit a transient Windows EBUSY / EPERM (AV scanners, the
 * indexer, another handle) are wrapped in withRetry; the caller's `retry` schedule
 * is forwarded so tests can disable backoff. "best-effort rm" swallows cleanup
 * errors — a stranded sidecar is a leftover, never a thrown error.
 *
 * SECURITY / SAFETY invariants (mirroring lock.mjs / apply.mjs):
 *   - assertWritable is INJECTED + REQUIRED (fail-closed: refuse if absent or not a
 *     function — never silently bypass the governed-write gate). It is checked
 *     FIRST, before any filesystem touch, so a denied gate writes NOTHING. The gate
 *     is called with `opts.context` (default 'apply'; rollback passes 'rollback'),
 *     so a rollback restore is gated by paths.mjs's rollback-writable surface (which
 *     ADDS CLAUDE.md + agents/skills/commands/hooks on top of the apply files) while
 *     apply stays restricted to the apply-writable files — the gate, not this
 *     primitive, decides what each context may write. The gate approves `target`;
 *     the two sidecars (`.mgr-new`/`.mgr-old`) are its trusted siblings in the SAME
 *     gate-approved directory and are intentionally NOT re-gated (their basenames
 *     are not in APPLY_WRITABLE_FILES, so gating them would wrongly throw
 *     `write-not-allowed` and break the write). Do NOT "fix" this by routing the
 *     sidecars through the gate.
 *   - M2-SAFETY: imports ONLY node:fs + src/lib/retry.mjs + src/lib/diagnostic.mjs.
 *     NEVER src/paths.mjs — the assertWritable gate is an injected param, keeping
 *     this ops module's static graph paths.mjs-free (the M2-safe property the
 *     boundary self-check enforces).
 *   - NEVER THROWS — the whole body is wrapped; even an unexpected error becomes a
 *     Diagnostic + `{ ok:false }`. Injectable seams make every branch hermetic.
 *   - SINGLE-WRITER assumption: the caller MUST hold the apply lock (lock.mjs) so
 *     no concurrent writer can create/replace `target` between the existence check
 *     and the commit rename. The apply path (P3.U12+ applyPlan) holds that lock;
 *     do NOT reuse this primitive lock-free.
 *
 * Ops-layer constraint: node:fs + src/lib/** only. Zero npm dependencies.
 */

import { writeFileSync, renameSync, existsSync, rmSync } from 'node:fs';
import { withRetry } from '../lib/retry.mjs';
import { DiagnosticBag } from '../lib/diagnostic.mjs';

/** @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic */
/** @typedef {import('../lib/retry.mjs').RetryOptions} RetryOptions */

/** Stable diagnostic phase tag for every finding this module emits. */
const PHASE = 'apply';

/** Empty leftovers — nothing stranded on disk. */
const NO_LEFTOVERS = Object.freeze({ newPath: null, oldPath: null });

/**
 * @typedef {Object} AtomicWriteResult
 * @property {boolean} ok        true only when the commit (and any backup) succeeded.
 * @property {boolean} wrote     true only when `target` now holds the new content.
 * @property {{ newPath: string|null, oldPath: string|null }} leftovers  sidecar
 *           files deliberately left on disk after a CATASTROPHIC failure (so
 *           doctor #21 / recover can find them); both null otherwise.
 * @property {Diagnostic[]} diagnostics
 */

/**
 * Production default seams. Overridable via `opts.seams` for hermetic tests.
 *   writeFn  — stage content to a path. No encoding arg: writeFileSync defaults to
 *              utf8 for a string (byte-identical to the old explicit 'utf8') and
 *              writes the RAW bytes for a Buffer (encoding is ignored for Buffers),
 *              so the same primitive is binary-safe for the rollback restore path.
 *   renameFn — rename a→b (used for both backup and commit).
 *   existsFn — does a path exist?
 *   rmFn     — best-effort remove (force:true so an absent path is a no-op).
 */
const DEFAULT_SEAMS = Object.freeze({
  writeFn: (p, c) => writeFileSync(p, c),
  renameFn: (a, b) => renameSync(a, b),
  existsFn: (p) => existsSync(p),
  rmFn: (p) => rmSync(p, { force: true }),
});

/**
 * Atomically write `content` to `target`, with crash-recoverable `.mgr-new` /
 * `.mgr-old` failure semantics. NEVER throws — every failure becomes a Diagnostic
 * plus `{ ok:false }`. Writes NOTHING when validation fails or the gate denies.
 *
 * @param {object} opts
 * @param {string} opts.target                              absolute path to write
 * @param {string|Buffer} opts.content                      the new file content
 *           (a string is written utf8; a Buffer is written raw — binary-safe).
 * @param {(path: string, ctx: string) => string} opts.assertWritable  REQUIRED gate
 * @param {'apply'|'rollback'|'probe'} [opts.context]        gate context (default
 *           'apply'); the rollback restore path passes 'rollback'. Passed straight
 *           to assertWritable — the gate coerces an unknown context to 'apply'.
 * @param {RetryOptions} [opts.retry]                        forwarded to withRetry
 * @param {{writeFn?:Function, renameFn?:Function, existsFn?:Function, rmFn?:Function}} [opts.seams]
 * @returns {Promise<AtomicWriteResult>}
 */
export async function atomicApplyWrite(opts) {
  const bag = new DiagnosticBag();
  const fail = makeFailer(bag);
  try {
    const o = opts && typeof opts === 'object' ? opts : {};
    const { target, content, assertWritable, retry } = o;
    // Default the gate context to 'apply' when absent; pass it through verbatim
    // otherwise (the gate itself coerces an unknown context to 'apply').
    const context = o.context === undefined ? 'apply' : o.context;

    // 1. Validate — write NOTHING on bad input.
    if (typeof target !== 'string' || target.length === 0) {
      return fail('apply-write-bad-args', 'target must be a non-empty string');
    }
    if (typeof content !== 'string' && !Buffer.isBuffer(content)) {
      return fail('apply-write-bad-args', 'content must be a string or Buffer');
    }
    if (typeof assertWritable !== 'function') {
      return fail('apply-write-bad-args', 'assertWritable (the governed-write gate) must be injected');
    }

    // 2. Gate FIRST — a denied gate writes NOTHING.
    try {
      assertWritable(target, context);
    } catch (e) {
      return fail('apply-write-gate-denied', `write gate denied: ${msg(e)}`, target);
    }

    return await runAtomicWrite({ target, content, retry, seams: resolveSeams(o.seams), bag, fail });
  } catch (e) {
    // Absolute backstop: an unexpected error becomes a diagnostic, never a throw.
    return fail('apply-write-unexpected-error', `unexpected error during atomic write: ${msg(e)}`);
  }
}

/**
 * Stage → backup → commit → cleanup the write. Assumes inputs are validated and
 * the gate has passed. Never throws (each fs step is try/caught). Extracted to
 * keep atomicApplyWrite under the SLOC limit.
 * @param {object} a
 * @param {string} a.target @param {string|Buffer} a.content @param {RetryOptions|undefined} a.retry
 * @param {{writeFn:Function, renameFn:Function, existsFn:Function, rmFn:Function}} a.seams
 * @param {DiagnosticBag} a.bag @param {(code:string,message:string,path?:string,extra?:object)=>AtomicWriteResult} a.fail
 * @returns {Promise<AtomicWriteResult>}
 */
async function runAtomicWrite(a) {
  const { target, content, retry, seams, bag, fail } = a;
  const { writeFn, renameFn, existsFn, rmFn } = seams;
  const newPath = target + '.mgr-new';
  const oldPath = target + '.mgr-old';
  const bestEffortRm = (p) => { try { rmFn(p); } catch { /* swallow — leftover, not a throw */ } };

  // 3. Stage: write the new content to the sidecar. On failure, target untouched.
  try {
    await withRetry(() => writeFn(newPath, content), retry);
  } catch (e) {
    bestEffortRm(newPath);
    return fail('apply-write-staging-failed', `could not stage new content: ${msg(e)}`, target);
  }

  // 4. Backup: if target exists, move it aside. On failure, target untouched.
  const targetExisted = existsFn(target);
  if (targetExisted) {
    try {
      await withRetry(() => renameFn(target, oldPath), retry);
    } catch (e) {
      bestEffortRm(newPath);
      return fail('apply-write-backup-failed', `could not back up the existing file: ${msg(e)}`, target);
    }
  }

  // 5. Commit: promote the sidecar into place.
  try {
    await withRetry(() => renameFn(newPath, target), retry);
  } catch (e) {
    return await commitFailed({ targetExisted, target, newPath, oldPath, renameFn, retry, bestEffortRm, bag, fail, err: e });
  }

  // 6. Success: drop the backup (best-effort). Target now holds the new content.
  if (targetExisted) bestEffortRm(oldPath);
  return { ok: true, wrote: true, leftovers: { newPath: null, oldPath: null }, diagnostics: bag.all() };
}

/**
 * Handle a failed commit rename. If the target previously existed, try to restore
 * it from the `.mgr-old` backup: a successful restore cleans up `.mgr-new` and
 * reports a recoverable failure; a failed restore LEAVES both sidecars on disk and
 * reports an UNRECOVERABLE failure carrying both leftover paths. If there was no
 * prior target, just clean up `.mgr-new`. Never throws.
 * @param {object} a
 * @returns {Promise<AtomicWriteResult>}
 */
async function commitFailed(a) {
  const { targetExisted, target, newPath, oldPath, renameFn, retry, bestEffortRm, bag, fail, err } = a;
  if (!targetExisted) {
    bestEffortRm(newPath);
    return fail('apply-write-commit-failed', `could not commit the new file: ${msg(err)}`, target);
  }
  // Restore the backup over the (now-missing) target. Retry the transient
  // EBUSY/EPERM that motivates the whole retry machinery (e.g. an AV scanner
  // grabbing the just-renamed .mgr-old): the original bytes are safe in .mgr-old,
  // so a retried restore turns many false "unrecoverable" reports into clean
  // recoveries instead of stranding the user with manual cleanup.
  try {
    await withRetry(() => renameFn(oldPath, target), retry);
  } catch (re) {
    // UNRECOVERABLE: target is gone and the backup could not be restored. Leave
    // BOTH sidecars on disk for doctor #21 / recover; do NOT remove anything.
    bag.add({
      severity: 'error', code: 'apply-write-commit-unrecoverable', phase: PHASE, path: target,
      message: `commit failed (${msg(err)}) AND restore failed (${msg(re)}); ` +
        `the original is preserved at ${oldPath} and the staged content at ${newPath}`,
      fix: `manually restore ${target} from ${oldPath}, then remove ${newPath}`,
    });
    return { ok: false, wrote: false, leftovers: { newPath, oldPath }, diagnostics: bag.all() };
  }
  // Restore OK — target holds its ORIGINAL content; clean up the stage.
  bestEffortRm(newPath);
  return fail('apply-write-commit-failed',
    `could not commit the new file: ${msg(err)} (original content restored)`, target);
}

// ── small shared helpers ─────────────────────────────────────────────────────────

/**
 * Build the standard failure closure: add an error diagnostic and return an
 * `ok:false` result with empty leftovers (the default — only the unrecoverable
 * path carries non-null leftovers, and it builds its result directly).
 * @param {DiagnosticBag} bag
 * @returns {(code: string, message: string, path?: string) => AtomicWriteResult}
 */
function makeFailer(bag) {
  return (code, message, path) => {
    bag.add({ severity: 'error', code, message, phase: PHASE, ...(path ? { path } : {}) });
    return { ok: false, wrote: false, leftovers: NO_LEFTOVERS, diagnostics: bag.all() };
  };
}

/**
 * Merge caller seams over the production defaults, so a partial `seams` override
 * (e.g. only `writeFn`) keeps the real implementation for the rest.
 * @param {object|undefined} seams
 * @returns {{writeFn:Function, renameFn:Function, existsFn:Function, rmFn:Function}}
 */
function resolveSeams(seams) {
  const s = seams && typeof seams === 'object' ? seams : {};
  return {
    writeFn: typeof s.writeFn === 'function' ? s.writeFn : DEFAULT_SEAMS.writeFn,
    renameFn: typeof s.renameFn === 'function' ? s.renameFn : DEFAULT_SEAMS.renameFn,
    existsFn: typeof s.existsFn === 'function' ? s.existsFn : DEFAULT_SEAMS.existsFn,
    rmFn: typeof s.rmFn === 'function' ? s.rmFn : DEFAULT_SEAMS.rmFn,
  };
}

/** Extract a human message from an unknown thrown value. */
function msg(e) {
  return e instanceof Error ? e.message : String(e);
}
