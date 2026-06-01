/**
 * Recover shared helpers (P3.U18) — the common result shape, path-traversal guard,
 * and target validation reused by the recover dispatcher (`recover.mjs`) and the
 * per-mode engines (`recover-resume.mjs`, `recover-rollback.mjs`).
 *
 * Extracted into its own module so each recover file stays well under the 200-SLOC
 * lint ceiling AND so there is NO import cycle: every recover module imports DOWN
 * into this shared file; `recover.mjs` imports the per-mode engines, which in turn
 * import only this shared file (a clean DAG, never `recover.mjs ↔ engine`).
 *
 * SECURITY / SAFETY (these helpers carry the headline DoD for every mode):
 *   • PATH-TRAVERSAL DEFENSE — `validateRecoverTarget` runs the strict SNAPSHOT_ID_RE
 *     (which admits no separators / dots / `..`) THEN a belt-and-suspenders
 *     resolve()-containment check, BEFORE any caller touches the filesystem. A
 *     non-conforming id can never reach a journal/manifest read or a write.
 *   • assertWritable is treated as REQUIRED + fail-safe by the caller: a missing gate
 *     is a validation failure, never a silent bypass.
 *
 * M2-SAFETY: imports only node:path + src/lib/diagnostic. NEVER src/paths.mjs (its
 * top-level await would poison the M2-safe ops graph). The gate + dirs are params.
 *
 * Ops-layer constraint: node:* stdlib + src/lib/** + sibling src/ops/* only. Pure;
 * never throws. Zero npm dependencies.
 */

import { join, resolve, sep } from 'node:path';
import { snapshotDir, SNAPSHOTS_DIRNAME, isValidSnapshotId, SNAPSHOT_ID_RE } from './snapshot-manifest.mjs';

/** @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic */

/** Stable diagnostic phase tag for every recover module's own findings. */
export const PHASE = 'recover';

/** CLI exit-code HINTS (mirror cli.mjs / rollback.mjs): 0 clean, 1 error,
 *  2 usage/bad-args, 3 refused-drift/lock, 4 archive-corrupt. */
export const CODE = Object.freeze({ ok: 0, error: 1, usage: 2, refused: 3, corrupt: 4 });

/**
 * @typedef {Object} RecoverResult
 * @property {boolean} ok           true only when the requested recovery completed.
 * @property {string}  mode         the recover mode that ran ('' before dispatch).
 * @property {number}  code         exit-code HINT for the CLI (see CODE).
 * @property {boolean} dryRun       true for a dry-run rollback/from-manifest preview
 *                                  (the governed-write modes are dry-run by default).
 * @property {string|null} snapshotId
 * @property {string|null} state    resulting journal state (or the original/last-known
 *                                  state on a refusal / dry-run; null when no journal).
 * @property {string|null} journalPath  written journal path (journal-writing modes).
 * @property {object|null} rollback the RollbackResult for rollback/from-manifest
 *                                  (null for the journal-only modes).
 * @property {Diagnostic[]} diagnostics  aggregated across every step.
 */

/** True for a non-empty string. */
export function isNonEmptyStr(v) {
  return typeof v === 'string' && v.length > 0;
}

/**
 * Build a RecoverResult, defaulting every field so callers always get the full,
 * uniform shape regardless of mode or how early the refusal happened. `fields`
 * spreads after the defaults, so an explicit value always wins.
 * @param {Partial<RecoverResult>} fields
 * @param {import('../lib/diagnostic.mjs').DiagnosticBag} bag
 * @returns {RecoverResult}
 */
export function buildResult(fields, bag) {
  return {
    ok: false, mode: '', code: CODE.error, dryRun: false,
    snapshotId: null, state: null, journalPath: null, rollback: null,
    ...fields,
    diagnostics: bag.all(),
  };
}

/**
 * Belt-and-suspenders path-traversal guard run AFTER the regex passes: confirm the
 * resolved snapshot dir is exactly `<snapshots>/<id>` and stays under the snapshots
 * root. The strict id regex already forbids separators/dots, so this can only fail
 * on a pathological input — but defense in depth is cheap and the DoD's headline.
 * @param {string} mgrStateDir @param {string} snapshotId @returns {boolean}
 */
export function isContainedSnapshotDir(mgrStateDir, snapshotId) {
  const base = resolve(join(mgrStateDir, SNAPSHOTS_DIRNAME));
  const target = resolve(snapshotDir(mgrStateDir, snapshotId));
  return target === join(base, snapshotId) && target.startsWith(base + sep);
}

/**
 * Validate the args EVERY recover mode needs, in fail-safe order: mgrStateDir →
 * assertWritable (REQUIRED) → snapshotId (strict RE) → resolve-containment. Returns
 * a discriminated result the caller turns into a fail RecoverResult. NOTHING here
 * touches the filesystem, so a refusal guarantees no read/write was attempted.
 * @param {object} opts  { mgrStateDir, assertWritable, snapshotId }
 * @returns {{ ok: true } | { ok: false, code: string, message: string, exitCode: number }}
 */
export function validateRecoverTarget(opts) {
  const { mgrStateDir, assertWritable, snapshotId } = opts ?? {};
  if (!isNonEmptyStr(mgrStateDir)) {
    return { ok: false, code: 'recover-bad-args', message: 'mgrStateDir must be a non-empty string', exitCode: CODE.usage };
  }
  if (typeof assertWritable !== 'function') {
    return { ok: false, code: 'recover-bad-args', message: 'assertWritable (the governed-write gate) must be injected', exitCode: CODE.usage };
  }
  if (!isValidSnapshotId(snapshotId)) {
    return { ok: false, code: 'recover-bad-id', message: `snapshotId must match the strict id format ${SNAPSHOT_ID_RE}`, exitCode: CODE.usage };
  }
  if (!isContainedSnapshotDir(mgrStateDir, snapshotId)) {
    return { ok: false, code: 'recover-path-escape', message: 'resolved snapshot dir escapes the snapshots root; refusing to touch the filesystem', exitCode: CODE.usage };
  }
  return { ok: true };
}
