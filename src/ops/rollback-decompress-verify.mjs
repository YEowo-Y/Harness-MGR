/**
 * Rollback decompress + verify (P3.U16) — the LAST read-side unit of the rollback
 * safety net. Before a rollback RESTORES files from a snapshot back onto the live
 * `~/.claude` tree, we must prove the archive is INTACT: that `files.tar` extracts
 * to exactly the bytes captured at snapshot time (each extracted file's sha256 ==
 * the manifest's `preSha256`). A corrupt archive or a missing member means a
 * restore would write GARBAGE onto the governed tree — so this unit catches it
 * FIRST, against a THROWAWAY copy, never the live tree:
 *
 *   readManifest → verifyManifest → resolveTar → EXTRACT into a fresh temp dir
 *                → for each manifest file: hash extracted bytes vs preSha256
 *                                          *** report missing / hash-mismatch ***
 *
 * The rollback orchestrator (P3.U17, NOT built here) consumes the result and
 * ABORTS the rollback (plan: exit 4) on any mismatch before touching a single
 * governed file. This unit only proves the archive is restorable.
 *
 * SECURITY / SAFETY invariants (each mirrors the sibling ops modules):
 *   1. NO governed-config write, NO .mgr-state write. The ONLY write target is a
 *      FRESH `os.tmpdir()` mkdtemp dir THIS function creates (never caller-supplied,
 *      never the live tree). Because nothing under `~/.claude` or `.mgr-state` is
 *      ever written, this unit needs NO assertWritable gate at all — there is no
 *      governed write to gate. None is accepted or used.
 *   2. BOUNDED TEMP CLEANUP. The temp dir is removed in a `finally` (which runs on
 *      extract failure, on mismatch, AND on success); cleanup removes ONLY the one
 *      mkdtemp'd dir, and a cleanup error degrades to a `warn` — it never masks the
 *      result and never throws.
 *   3. VERIFY vs `preSha256` (the snapshot-captured baseline the tar payload must
 *      hash to), NOT `currentSha256` (the live-disk drift comparison — that is
 *      U15's job). This unit answers "is the archive sound?", not "did the live
 *      tree change?".
 *   4. PATH-TRAVERSAL DEFENSE on the snapshotId (run BEFORE any fs access) — first
 *      the strict SNAPSHOT_ID_RE (admits no '.', '/' or '\\', so a valid id can
 *      carry no traversal), then a belt-and-suspenders resolve() check that the
 *      snapshot dir stays under `<mgrStateDir>/snapshots/`. Mirrors recover.mjs.
 *   5. PER-FILE CONTAINMENT under the temp destDir. Every manifest `file.path` is
 *      resolved under destDir and verified to stay inside it BEFORE being read, so
 *      a hostile manifest entry (e.g. '../../etc/passwd') can never make the
 *      verifier read OUTSIDE the throwaway extraction dir. (extractSnapshotTar
 *      already rejects '..' archive members; this is defense in depth on the
 *      manifest-driven read.)
 *   6. verifyManifest refuses a FUTURE manifestVersion + a cross-target manifest
 *      (when expectedTarget is supplied), so a newer-tool / wrong-tree manifest
 *      never drives a verification.
 *
 * M2-SAFETY: this module never imports src/paths.mjs (which carries a top-level
 * await) — not statically, not via dynamic import(). It takes `mgrStateDir` as a
 * param; the CLI layer (a later unit) resolves it.
 *
 * Ops-layer constraint: imports only node:* stdlib + src/lib/** + sibling
 * src/ops/*. NEVER THROWS — every failure (including a thrown seam, garbage input)
 * becomes a Diagnostic + `{ ok:false }`; the temp cleanup still runs. Injectable
 * seams make every path hermetically unit-testable without a real tar / fs.
 *
 * Spec: plan claude-mgr-v5.md, the rollback decompress+verify step — the READ-ONLY
 * archive-integrity slice (P3.U17 owns the abort-on-mismatch orchestration).
 */

import { join, resolve, sep } from 'node:path';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { DiagnosticBag } from '../lib/diagnostic.mjs';
import { isValidSnapshotId, snapshotDir, verifyManifest, SNAPSHOTS_DIRNAME, SNAPSHOT_ID_RE } from './snapshot-manifest.mjs';
import { readManifest } from './snapshot-manifest-io.mjs';
import { resolveTar, extractSnapshotTar } from './snapshot-tar.mjs';

/** @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic */

/** Stable diagnostic phase tag for this module's own findings. */
const PHASE = 'rollback-verify';

/** The archive filename inside a snapshot dir (a LOCAL const — snapshot.mjs does not export it). */
const ARCHIVE_NAME = 'files.tar';

/** Prefix for the throwaway extraction dir under os.tmpdir(). */
const TEMP_PREFIX = 'cmgr-rollback-verify-';

/**
 * @typedef {Object} VerifyMismatch
 * @property {string} path                 POSIX-relative path within the snapshot
 * @property {'missing'|'hash-mismatch'} kind
 * @property {string} expected             the manifest's preSha256 baseline
 * @property {string|null} actual          the extracted hash ('hash-mismatch') or null (missing)
 */

/**
 * @typedef {Object} VerifyResult
 * @property {boolean} ok               true ONLY when the check RAN to completion
 *                                      (manifest read+verified, tar resolved, archive
 *                                      extracted). false = could not run.
 * @property {boolean} verified         true when ok AND every manifest file extracted
 *                                      AND matched its preSha256 (zero mismatches).
 * @property {string|null} snapshotId
 * @property {number} fileCount         number of manifest file records.
 * @property {number} verifiedCount     number that extracted AND matched their hash.
 * @property {VerifyMismatch[]} mismatches  missing/corrupt files (empty when verified).
 * @property {string|null} tempDir      the throwaway mkdtemp'd extraction dir THIS call
 *                                      created (null when none was made, e.g. a bad id or
 *                                      missing tar). Exposed ONLY so a caller/test can
 *                                      assert residue against the EXACT dir this call
 *                                      owned — NOT a tmpdir-wide glob over the shared
 *                                      prefix (concurrent callers share os.tmpdir()). The
 *                                      dir is ALWAYS removed in the finally before return;
 *                                      this is the path that WAS used, for verification.
 * @property {Diagnostic[]} diagnostics  aggregated across every step.
 */

/** True for a non-empty string. */
function isNonEmptyStr(v) {
  return typeof v === 'string' && v.length > 0;
}

/** Message from an unknown thrown value; never throws. */
function errMsg(e) {
  return e instanceof Error ? e.message : String(e);
}

/** sha256 hex over a Buffer. Mirrors snapshot.mjs / rollback-drift-check.mjs. */
function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Build a VerifyResult, defaulting every field so callers always get the full shape.
 * @param {Partial<VerifyResult>} fields
 * @param {DiagnosticBag} bag
 * @returns {VerifyResult}
 */
function buildResult(fields, bag) {
  return {
    ok: false, verified: false, snapshotId: null, fileCount: 0, verifiedCount: 0, mismatches: [],
    tempDir: null,
    ...fields,
    diagnostics: bag.all(),
  };
}

/**
 * Belt-and-suspenders path-traversal guard run AFTER the regex passes: confirm the
 * resolved snapshot dir is exactly `<snapshots>/<id>` and stays under the snapshots
 * root. The strict id regex already forbids separators/dots, so this can only fail
 * on a pathological input — but defense in depth is cheap and the DoD's headline.
 * Mirrors recover.mjs / rollback-drift-check.mjs.
 * @param {string} mgrStateDir @param {string} snapshotId @returns {boolean}
 */
function isContainedSnapshotDir(mgrStateDir, snapshotId) {
  const base = resolve(join(mgrStateDir, SNAPSHOTS_DIRNAME));
  const target = resolve(snapshotDir(mgrStateDir, snapshotId));
  return target === join(base, snapshotId) && target.startsWith(base + sep);
}

/**
 * Per-file containment guard: resolve a manifest-relative POSIX path under the temp
 * extraction dir and confirm it stays inside it. Returns the absolute path when
 * safe, or null when the entry escapes (a corrupted / hostile manifest). A path
 * exactly equal to destDir (empty rel) is also rejected — there is no file there.
 * @param {string} destDir  absolute temp extraction dir
 * @param {string} relPath  POSIX-relative path from the manifest
 * @returns {string|null} the contained absolute path, or null if it escapes
 */
function containedExtractedPath(destDir, relPath) {
  const base = resolve(destDir);
  const abs = resolve(join(destDir, ...relPath.split('/')));
  return abs.startsWith(base + sep) ? abs : null;
}

/**
 * Verify ONE manifest file record against its extracted copy, pushing a
 * VerifyMismatch into `mismatches` when it is missing or corrupt. ENOENT → missing;
 * a hash that differs from preSha256 → hash-mismatch; a manifest path that escapes
 * destDir is NEVER read — it is recorded as a hash-mismatch(actual:null) + warned.
 * Any OTHER read error is also a hash-mismatch(actual:null) (the byte could not be
 * verified, so the archive cannot be trusted). Extracted to keep the main function
 * under the SLOC limit.
 * @param {object} ctx { destDir, readFileFn, mismatches, bag }
 * @param {{path:string, preSha256:string}} file
 */
function verifyFile(ctx, file) {
  const { destDir, readFileFn, mismatches, bag } = ctx;
  const rel = file.path;
  const expected = file.preSha256;

  // SECURITY: never read a manifest entry that escapes the temp extraction dir.
  const abs = containedExtractedPath(destDir, rel);
  if (abs === null) {
    bag.add({ severity: 'warn', code: 'verify-extract-path-escape', phase: PHASE, path: rel,
      message: 'manifest file path escapes the extraction dir; treating as corrupt (not read)' });
    mismatches.push({ path: rel, kind: 'hash-mismatch', expected, actual: null });
    return;
  }

  let buf;
  try {
    buf = readFileFn(abs);
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      mismatches.push({ path: rel, kind: 'missing', expected, actual: null });
      return;
    }
    // Any other read error: the extracted byte cannot be verified → corrupt.
    bag.add({ severity: 'warn', code: 'verify-file-unreadable', phase: PHASE, path: rel,
      message: `could not read extracted file to verify; treating as corrupt: ${errMsg(e)}` });
    mismatches.push({ path: rel, kind: 'hash-mismatch', expected, actual: null });
    return;
  }

  const actual = sha256Hex(buf);
  if (actual !== expected) {
    mismatches.push({ path: rel, kind: 'hash-mismatch', expected, actual });
  }
}

/**
 * Extract the archive into `destDir` and verify each manifest file's bytes against
 * its preSha256. Returns the VerifyResult `fields` (sans diagnostics, which the bag
 * carries) — the caller wraps it. Extracted so the temp dir's `finally` cleanup in
 * verifyRollbackArchive stays a thin, obviously-bounded wrapper around this.
 * @param {object} ctx { tarPath, archivePath, destDir, snapshotId, manifest, extractFn, readFileFn, bag }
 * @returns {Promise<Partial<VerifyResult>>}
 */
async function extractAndVerify(ctx) {
  const { tarPath, archivePath, destDir, snapshotId, manifest, extractFn, readFileFn, bag } = ctx;

  const ex = await extractFn({ tarPath, archivePath, destDir });
  for (const d of ex?.diagnostics ?? []) bag.add(d);
  if (!ex?.ok) {
    bag.add({ severity: 'error', code: 'verify-extract-failed', phase: PHASE,
      message: 'could not extract the snapshot archive for verification' });
    return { ok: false, snapshotId };
  }

  /** @type {VerifyMismatch[]} */
  const mismatches = [];
  const fileCtx = { destDir, readFileFn, mismatches, bag };
  for (const file of manifest.files) verifyFile(fileCtx, file);

  const fileCount = manifest.files.length;
  const verified = mismatches.length === 0;
  const verifiedCount = fileCount - mismatches.length;
  if (!verified) {
    bag.add({ severity: 'warn', code: 'rollback-archive-corrupt', phase: PHASE,
      message: `snapshot ${snapshotId} archive failed verification: ${mismatches.length} of ${fileCount} file(s) missing or corrupt`,
      fix: 'the archive cannot be trusted to restore; a rollback would write incorrect bytes (do not proceed)' });
  }
  return { ok: true, verified, snapshotId, fileCount, verifiedCount, mismatches };
}

/**
 * Verify that snapshot `snapshotId` under `mgrStateDir` extracts to bytes matching
 * its manifest's preSha256 baseline — proving the archive is sound to restore from.
 * Reads + verifies the manifest, resolves the system tar, extracts `files.tar` into
 * a FRESH `os.tmpdir()` dir, hashes each extracted file, and removes the temp dir in
 * a finally. Performs NO governed-config / .mgr-state write — the only write target
 * is the throwaway temp dir — so no write gate is needed. NEVER throws: every
 * failure, including a thrown seam or garbage input, becomes a Diagnostic +
 * `{ ok:false }` and the temp cleanup still runs.
 *
 * @param {object} opts
 * @param {string}  opts.mgrStateDir          absolute path to the .mgr-state dir
 * @param {string}  opts.snapshotId           strict snapshot id (SNAPSHOT_ID_RE)
 * @param {string}  [opts.expectedTarget]     live dir this snapshot must belong to
 *                                            (forwarded to verifyManifest for cross-
 *                                            target refusal).
 * @param {object}  [opts.seams]              { resolveFn, extractFn, readManifestFn,
 *                                              mkdtempFn, readFileFn, rmFn }
 * @returns {Promise<VerifyResult>}
 */
export async function verifyRollbackArchive(opts) {
  const bag = new DiagnosticBag();
  const o = opts && typeof opts === 'object' ? opts : {};
  const { mgrStateDir, snapshotId, expectedTarget } = o;
  const seams = o.seams && typeof o.seams === 'object' ? o.seams : {};
  const resolveFn = seams.resolveFn ?? resolveTar;
  const extractFn = seams.extractFn ?? extractSnapshotTar;
  const readManifestFn = seams.readManifestFn ?? readManifest;
  const mkdtempFn = seams.mkdtempFn ?? ((prefix) => mkdtempSync(prefix));
  const readFileFn = seams.readFileFn ?? ((abs) => readFileSync(abs));
  const rmFn = seams.rmFn ?? ((dir) => rmSync(dir, { recursive: true, force: true }));

  const fail = (code, message, fields) => {
    bag.add({ severity: 'error', code, message, phase: PHASE });
    return buildResult({ ...fields }, bag);
  };

  let destDir = null;
  try {
    // 1. Validate — refuse BEFORE any fs access. A bad state dir or a non-conforming
    //    id (strict regex THEN resolve-containment) must never reach readManifest.
    if (!isNonEmptyStr(mgrStateDir)) {
      return fail('verify-bad-args', 'mgrStateDir must be a non-empty string');
    }
    if (!isValidSnapshotId(snapshotId)) {
      return fail('verify-bad-id', `snapshotId must match the strict id format ${SNAPSHOT_ID_RE}`);
    }
    if (!isContainedSnapshotDir(mgrStateDir, snapshotId)) {
      return fail('verify-path-escape',
        'resolved snapshot dir escapes the snapshots root; refusing to touch the filesystem');
    }

    // 2. Read the manifest (the first fs access, only on a safe id).
    const { manifest, diagnostics: readD } = readManifestFn({ stateDir: mgrStateDir, snapshotId });
    for (const d of readD ?? []) bag.add(d);
    if (!manifest) {
      // The manifest-not-found / manifest-unreadable diag is already aggregated.
      return buildResult({ snapshotId }, bag);
    }

    // 3. Verify schema / version / target (refuses future version + cross-target).
    const v = verifyManifest(manifest, { expectedTarget });
    for (const d of v.diagnostics ?? []) bag.add(d);
    if (!v.ok) return buildResult({ snapshotId }, bag);

    // 4. Resolve the system tar — without it we cannot extract, so we cannot verify.
    const r = resolveFn();
    for (const d of r?.diagnostics ?? []) bag.add(d);
    const tarPath = r?.tarPath ?? null;
    if (!isNonEmptyStr(tarPath)) {
      return fail('verify-tar-unavailable',
        'system tar is unavailable; cannot extract the archive to verify it', { snapshotId });
    }

    // 5. Create a FRESH throwaway extraction dir under os.tmpdir(). This is the ONLY
    //    write this unit ever causes — never the live tree, never .mgr-state.
    const archivePath = join(snapshotDir(mgrStateDir, snapshotId), ARCHIVE_NAME);
    destDir = mkdtempFn(join(tmpdir(), TEMP_PREFIX));

    // 6. Extract + verify against the temp copy (BOUNDED cleanup in the finally).
    const fields = await extractAndVerify({
      tarPath, archivePath, destDir, snapshotId, manifest, extractFn, readFileFn, bag,
    });
    // Expose the temp dir THIS call used so a caller/test can assert residue against
    // the EXACT dir (never a tmpdir-wide glob). It is still removed in the finally.
    return buildResult({ ...fields, tempDir: destDir }, bag);
  } catch (e) {
    // Absolute backstop: a thrown seam / unexpected error becomes a diagnostic.
    return fail('verify-unexpected-error',
      `unexpected error during rollback archive verification: ${errMsg(e)}`,
      { snapshotId: isValidSnapshotId(snapshotId) ? snapshotId : null });
  } finally {
    // BOUNDED cleanup: remove ONLY the temp dir THIS function created (if any). Runs
    // on extract failure, on mismatch, AND on success. A cleanup error degrades to a
    // warn — it never masks the result and never throws.
    if (destDir !== null) {
      try { rmFn(destDir); }
      catch (e) {
        bag.add({ severity: 'warn', code: 'verify-cleanup-failed', phase: PHASE, path: destDir,
          message: `could not remove the temp verification dir: ${errMsg(e)}` });
      }
    }
  }
}
