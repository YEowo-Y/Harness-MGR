/**
 * Apply manifest cross-check (Part 2 of the reversibility-secret-name fix) —
 * EXTRACTED from apply.mjs to keep the apply orchestrator under the SLOC ceiling.
 *
 * After the pre-apply snapshot is created (with skipSecretFilter:true so every
 * governed file is captured), this module verifies that EVERY op target in the Plan
 * appears in the snapshot manifest BEFORE any mutation is attempted. If any target is
 * absent the apply is refused with `apply-target-not-snapshotted`, making a
 * silently-irreversible delete/write structurally impossible.
 *
 * Op kinds skipped: 'create' (the file does not yet exist on disk, so the snapshot
 * cannot contain it — that is correct and expected).
 *
 * For 'delete-dir' ops the manifest captures FILES inside the directory (not the
 * directory entry itself). The check verifies that at least one captured file path
 * starts with the directory prefix, confirming the directory was walked and its
 * contents are restorable.
 *
 * A missing or unreadable manifest is treated as "nothing captured" so the check
 * FAILS CLOSED — it never silently approves an unknown snapshot.
 *
 * PURE aside from the injected manifestReadFileFn; NEVER THROWS (all read errors are
 * caught). The caller owns the read seam (defaulting to a real readFileSync), so this
 * module is hermetically unit-testable without touching disk.
 *
 * M2-SAFETY: imports ONLY node:path + src/lib/diagnostic.mjs (no node:fs, no
 * src/paths.mjs). Zero npm dependencies.
 */

import { relative, sep } from 'node:path';

/** @typedef {import('../lib/diagnostic.mjs').DiagnosticBag} DiagnosticBag */
/** @typedef {import('../lib/plan.mjs').Plan} Plan */

/** Stable diagnostic phase tag (matches apply.mjs). */
const PHASE = 'apply';

/** The op kinds that delete a directory (the manifest captures their CONTENTS, not the dir entry). */
const DIR_DELETABLE_KINDS = Object.freeze(['delete-dir']);

/**
 * Cross-check that EVERY op target in `plan` is captured in the snapshot manifest.
 * Returns `{ok:true}` when all targets are present, or `{ok:false, message}` naming
 * the first missing target.
 *
 * Normalisation: op targets are ABSOLUTE paths; manifest entries carry POSIX-relative
 * paths (no leading `/`). We normalise each op target via
 * `relative(targetClaudeDir, target)` then replace the platform separator with `/`.
 *
 * @param {Plan}   plan
 * @param {{manifestPath:string|null}} snap
 * @param {string} targetClaudeDir
 * @param {(p:string)=>string} manifestReadFileFn  injectable for tests
 * @param {DiagnosticBag} bag
 * @returns {{ok:boolean, message?:string}}
 */
export function checkOpTargetsInManifest(plan, snap, targetClaudeDir, manifestReadFileFn, bag) {
  // Build the set of POSIX-relative paths from the manifest.
  /** @type {Set<string>} */
  const captured = new Set();
  if (typeof snap.manifestPath === 'string' && snap.manifestPath.length > 0) {
    try {
      const raw = manifestReadFileFn(snap.manifestPath);
      const parsed = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
      if (parsed && Array.isArray(parsed.files)) {
        for (const entry of parsed.files) {
          if (entry && typeof entry.path === 'string') captured.add(entry.path);
        }
      }
    } catch {
      // manifest unreadable / malformed → treat as empty (fail-closed below)
      bag.add({
        severity: 'warn', code: 'apply-manifest-unreadable', phase: PHASE,
        message: 'could not read the snapshot manifest for the op-target cross-check; refusing apply',
      });
    }
  }

  const ops = Array.isArray(plan.ops) ? plan.ops : [];
  for (const op of ops) {
    if (!op || typeof op.target !== 'string') continue;
    // 'create' ops target NEW files that don't yet exist on disk — they cannot be in
    // the pre-mutation snapshot, and that is correct: if the apply fails mid-sequence
    // the snapshot simply won't have the new file (nothing to restore). Only
    // 'overwrite', 'delete', and 'delete-dir' ops require the target to be captured.
    if (op.kind === 'create') continue;
    // Normalise absolute target → POSIX-relative path for Set lookup.
    const posixRel = relative(targetClaudeDir, op.target).split(sep).join('/');
    // For delete-dir, the manifest captures FILES inside the dir; check that at
    // least one captured file path starts with the dir prefix so we know the dir
    // was walked and its contents are restorable.
    if (DIR_DELETABLE_KINDS.includes(op.kind)) {
      const dirPrefix = posixRel.endsWith('/') ? posixRel : `${posixRel}/`;
      const hasAny = [...captured].some((p) => p.startsWith(dirPrefix));
      if (!hasAny) {
        return {
          ok: false,
          message: `directory op target '${posixRel}' has no files captured in the pre-apply snapshot — ` +
            'refusing apply: the delete-dir would be silently irreversible. ' +
            'This should never happen with the current apply path; please file a bug.',
        };
      }
    } else if (!captured.has(posixRel)) {
      return {
        ok: false,
        message: `op target '${posixRel}' is not captured in the pre-apply snapshot — ` +
          'refusing apply: a delete/write without a snapshot undo-point would be silently irreversible. ' +
          'This should never happen with the current apply path; please file a bug.',
      };
    }
  }
  return { ok: true };
}
