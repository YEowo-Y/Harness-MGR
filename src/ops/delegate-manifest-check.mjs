/**
 * Delegate-path manifest cross-check (Part-2 backstop for update + mcp-write).
 *
 * After the pre-delegate snapshot is created (with skipSecretFilter:true so every
 * governed file is captured), this module verifies that the specific file the
 * delegated command is expected to MUTATE appears in the snapshot manifest BEFORE
 * the spawn is attempted. If it is absent the delegation is refused with the supplied
 * error code, making a silently-irreversible mutation STRUCTURALLY IMPOSSIBLE.
 *
 * This is the delegate-path analogue of apply-manifest-check.mjs's
 * `checkOpTargetsInManifest` — it re-uses that function directly, synthesising a
 * one-op plan from the single target path so the full cross-check logic is shared
 * from a single source.
 *
 * Existence-conditioned: if `existsFn(target)` returns false the check is SKIPPED
 * (the file doesn't yet exist on disk, so the snapshot cannot contain it — that is
 * correct and expected; it mirrors apply-manifest-check's 'create' skip).
 *
 * A missing or unreadable manifest is treated as "nothing captured" so the check
 * FAILS CLOSED — it never silently approves an unknown snapshot.
 *
 * PURE aside from the injected manifestReadFileFn and existsFn; NEVER THROWS.
 * M2-SAFETY: imports ONLY node:path + node:fs + ./apply-manifest-check.mjs.
 * Zero npm dependencies.
 */

import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { checkOpTargetsInManifest } from './apply-manifest-check.mjs';

/** @typedef {import('../lib/diagnostic.mjs').DiagnosticBag} DiagnosticBag */

/**
 * Cross-check that a single delegate target is captured in the snapshot manifest.
 * Returns `{ok:true}` when the target is present (or absent on disk), or
 * `{ok:false, message}` naming the missing target along with a diagnostic added to
 * the supplied bag.
 *
 * @param {object} opts
 * @param {{manifestPath:string|null}} opts.snap  the snapshot result (needs manifestPath)
 * @param {string} opts.targetClaudeDir            absolute governed dir
 * @param {string} opts.targetRelPath              POSIX-relative path of the file to check
 *                                                 (e.g. 'plugins/installed_plugins.json')
 * @param {string} opts.errorCode                  the Diagnostic code to emit on failure
 * @param {string} opts.phase                      the Diagnostic phase tag
 * @param {DiagnosticBag} opts.bag                 bag to receive the failure diagnostic
 * @param {(p:string)=>string} [opts.manifestReadFileFn]  injectable for tests (default readFileSync)
 * @param {(p:string)=>boolean} [opts.existsFn]   injectable for tests (default existsSync)
 * @returns {{ok:boolean, message?:string}}
 */
export function checkDelegateTargetSnapshotted(opts) {
  try {
    const {
      snap, targetClaudeDir, targetRelPath, errorCode, phase, bag,
    } = opts ?? {};
    const manifestReadFileFn = typeof opts?.manifestReadFileFn === 'function'
      ? opts.manifestReadFileFn : readFileSync;
    const existsFn = typeof opts?.existsFn === 'function'
      ? opts.existsFn : existsSync;

    // If the target doesn't exist on disk, skip the check (mirrors 'create' skip).
    const absoluteTarget = join(targetClaudeDir, ...targetRelPath.split('/'));
    if (!existsFn(absoluteTarget)) return { ok: true };

    // Synthesise a one-op overwrite plan so checkOpTargetsInManifest can do its job.
    const plan = { ops: [{ kind: 'overwrite', target: absoluteTarget }] };
    const result = checkOpTargetsInManifest(plan, snap, targetClaudeDir, manifestReadFileFn, bag);

    if (!result.ok) {
      bag.add({
        severity: 'error', code: errorCode, phase,
        message: result.message ??
          `delegate target '${targetRelPath}' is not captured in the pre-delegate snapshot — ` +
          'refusing: the delegated mutation would be silently irreversible.',
      });
    }
    return result;
  } catch (e) {
    // Never throw — a bug here must not crash the caller's NEVER-THROWS guarantee.
    if (opts?.bag) {
      opts.bag.add({
        severity: 'error', code: opts?.errorCode ?? 'delegate-manifest-check-error',
        phase: opts?.phase ?? 'unknown',
        message: `manifest cross-check threw unexpectedly: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
    return { ok: false, message: String(e) };
  }
}
