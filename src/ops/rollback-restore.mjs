/**
 * Rollback restore (P3.U17) — the FIRST rollback unit that WRITES the governed
 * `~/.claude` config surface. It is the THREAT MODEL'S HIGHEST-RISK ACTION: it
 * takes the bytes captured in a snapshot and writes them back over the live tree.
 * Every read-side safety unit (drift-check U15, decompress-verify U16) exists so
 * the orchestrator can REFUSE before reaching this primitive; this unit is the
 * actual write-back, and it re-proves its own safety end-to-end:
 *
 *   readManifest → verifyManifest → resolveTar → EXTRACT into a fresh temp dir
 *                → per file: per-file containment → GATE(rollback) → read bytes
 *                           → RE-VERIFY preSha256 → mkdir parent → atomicApplyWrite
 *
 * SECURITY / SAFETY invariants (each load-bearing; mirrors the sibling ops):
 *   1. GOVERNED WRITE — assertWritable is INJECTED + REQUIRED (fail-safe: refuse the
 *      whole operation BEFORE any fs touch if it is absent or not a function, never
 *      silently bypass). EVERY governed write goes through atomicApplyWrite with
 *      `context:'rollback'`, so paths.mjs decides per-file what the rollback surface
 *      permits (CLAUDE.md + settings/.mcp + agents/skills/commands/hooks). This unit
 *      NEVER writes a path the gate denies.
 *   2. GATE-DENIED → SKIP, NOT FATAL. A captured file that the rollback gate refuses
 *      (e.g. hud/**, plugins/installed_plugins.json — captured by older snapshots but
 *      NOT rollback-writable) is recorded as an `out-of-surface` skip + warned, and
 *      the restore CONTINUES. Skips do NOT flip `restored` to false — they are an
 *      expected, safe partial restore. A preSha256 mismatch or a hard write failure
 *      DOES flip `restored` to false (those are real failures).
 *   3. PER-FILE preSha256 RE-VERIFY before EVERY write (defense in depth). U16 already
 *      verified the whole archive, but we re-hash each extracted file here so the
 *      restore is robust standalone: a byte that does not match its captured hash is
 *      NEVER written — it is a `verify-mismatch` skip + an ERROR.
 *   4. BOUNDED TEMP CLEANUP. The ONLY non-governed write is a FRESH `os.tmpdir()`
 *      mkdtemp dir THIS function creates (never caller-supplied, never the live tree);
 *      it is removed in a `finally` (runs on every exit path) and cleanup removes ONLY
 *      that one dir; a cleanup error degrades to a warn and never masks the result.
 *   5. PATH-TRAVERSAL DEFENSE — the snapshotId is validated (strict SNAPSHOT_ID_RE
 *      THEN a belt-and-suspenders resolve()-containment check) BEFORE any fs access,
 *      and EVERY manifest `file.path` is resolved+contained under BOTH the temp
 *      extraction dir (the read) AND targetClaudeDir (the write) — a hostile/corrupt
 *      manifest entry can neither read outside the temp dir nor write outside the
 *      governed tree. Mirrors recover.mjs / rollback-drift-check.mjs.
 *   6. BINARY-SAFE — extracted bytes are read as a Buffer and written raw via the
 *      now-binary-safe atomicApplyWrite, so a binary governed file (or invalid-utf8
 *      content) restores byte-identical, not utf8-mangled.
 *   7. SINGLE-WRITER — the orchestrator (P3.U18 / the rollback command) MUST hold the
 *      apply lock (lock.mjs) around this call so no concurrent writer races the
 *      restore. Do NOT reuse this primitive lock-free.
 *   8. HARD WRITE FAILURE STOPS THE LOOP. An atomicApplyWrite that fails (after we
 *      pre-gated, this is an fs failure, not a deny) STOPS the restore — we do not
 *      keep clobbering — and surfaces the recoverable `.mgr-new`/`.mgr-old` sidecars
 *      via `leftovers` for doctor #21 / recover to reconcile.
 *
 * DOUBLE-EXTRACT vs U16: U16 (verify) and this unit (restore) each extract the
 * archive into their own throwaway temp dir, so a full "verify then restore" does
 * two extractions. That is an accepted trade-off: the archive (`files.tar`) is
 * immutable under the apply lock, so the second extraction yields identical bytes,
 * and keeping the restore self-contained (it re-verifies + extracts itself) means a
 * caller can run it standalone without trusting a prior verify's temp dir.
 *
 * M2-SAFETY: this module never imports src/paths.mjs (which carries a top-level
 * await) — not statically, not via dynamic import(). assertWritable is INJECTED;
 * mgrStateDir / targetClaudeDir are params; the CLI layer resolves them.
 *
 * Ops-layer constraint: imports only node:* stdlib + src/lib/** + sibling
 * src/ops/*. NEVER THROWS — every failure (including a thrown seam, garbage input)
 * becomes a Diagnostic + a full-shape result; the temp cleanup still runs.
 *
 * Spec: plan claude-mgr-v5.md, the rollback `restore` write-back step (P3.U17).
 */

import { join, resolve, sep, dirname } from 'node:path';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { DiagnosticBag } from '../lib/diagnostic.mjs';
import { isValidSnapshotId, snapshotDir, verifyManifest, SNAPSHOTS_DIRNAME, SNAPSHOT_ID_RE } from './snapshot-manifest.mjs';
import { readManifest } from './snapshot-manifest-io.mjs';
import { resolveTar, extractSnapshotTar } from './snapshot-tar.mjs';
import { atomicApplyWrite } from './atomic-write.mjs';

/** @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic */

/** Stable diagnostic phase tag for this module's own findings. */
const PHASE = 'rollback-restore';

/** The archive filename inside a snapshot dir (a LOCAL const — snapshot.mjs does not export it). */
const ARCHIVE_NAME = 'files.tar';

/** Prefix for the throwaway extraction dir under os.tmpdir(). */
const TEMP_PREFIX = 'cmgr-rollback-restore-';

/**
 * @typedef {Object} RestoreSkip
 * @property {string} path                                  POSIX-relative path within the snapshot
 * @property {'out-of-surface'|'verify-mismatch'} reason    why the file was not written
 */

/**
 * @typedef {Object} RestoreResult
 * @property {boolean} ok                true ONLY when the restore RAN to completion
 *                                       (manifest read+verified, tar resolved, archive
 *                                       extracted, write-loop finished). Per-file skips
 *                                       do NOT flip this; a hard failure that stops the
 *                                       loop leaves it false only if it pre-empts the run.
 * @property {boolean} restored          true when ok AND no hard failure occurred
 *                                       (gate-denied skips do NOT flip it; a preSha256
 *                                       mismatch or an atomic-write failure DOES).
 * @property {string|null} snapshotId
 * @property {string|null} targetClaudeDir
 * @property {number} fileCount          number of manifest file records considered.
 * @property {number} restoredCount      number of files actually written.
 * @property {RestoreSkip[]} skipped     files not written (out-of-surface / verify-mismatch).
 * @property {{newPath:string|null, oldPath:string|null}|null} leftovers  sidecars from the
 *           catastrophic atomic-write failure that stopped the loop (null otherwise).
 * @property {Diagnostic[]} diagnostics  aggregated across every step.
 */

/** True for a non-empty string. */
function isNonEmptyStr(v) {
  return typeof v === 'string' && v.length > 0;
}

/**
 * True when an assertWritable error is a GENUINE surface denial — a known
 * WriteForbiddenError code that means "not rollback-writable by design" (e.g.
 * hud/**, plugins/**). ANY OTHER throw (including write-canonicalize-failed,
 * write-target-invalid, or a non-WriteForbiddenError) is a real gate error that
 * must NOT be silently masked as a benign skip. Uses duck-typing only (no import
 * of paths.mjs — M2-safety).
 * @param {unknown} e @returns {boolean}
 */
const SURFACE_DENY_CODES = new Set(['write-not-allowed', 'write-forbidden', 'write-rollback-only', 'write-outside-target']);
function isSurfaceDeny(e) { return e != null && e.name === 'WriteForbiddenError' && SURFACE_DENY_CODES.has(e.code); }

/** Message from an unknown thrown value; never throws. */
function errMsg(e) {
  return e instanceof Error ? e.message : String(e);
}

/** sha256 hex over a Buffer. Mirrors rollback-decompress-verify.mjs / snapshot.mjs. */
function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Build a RestoreResult, defaulting every field so callers always get the full shape.
 * @param {Partial<RestoreResult>} fields
 * @param {DiagnosticBag} bag
 * @returns {RestoreResult}
 */
function buildResult(fields, bag) {
  return {
    ok: false, restored: false, snapshotId: null, targetClaudeDir: null,
    fileCount: 0, restoredCount: 0, skipped: [], leftovers: null,
    ...fields,
    diagnostics: bag.all(),
  };
}

/**
 * Belt-and-suspenders path-traversal guard run AFTER the regex passes: confirm the
 * resolved snapshot dir is exactly `<snapshots>/<id>` and stays under the snapshots
 * root. The strict id regex already forbids separators/dots, so this can only fail
 * on a pathological input. Copied verbatim from rollback-decompress-verify.mjs.
 * @param {string} mgrStateDir @param {string} snapshotId @returns {boolean}
 */
function isContainedSnapshotDir(mgrStateDir, snapshotId) {
  const base = resolve(join(mgrStateDir, SNAPSHOTS_DIRNAME));
  const target = resolve(snapshotDir(mgrStateDir, snapshotId));
  return target === join(base, snapshotId) && target.startsWith(base + sep);
}

/**
 * Per-file containment guard: resolve a manifest-relative POSIX path under `root`
 * and confirm it stays inside it. Returns the absolute path when safe, or null when
 * the entry escapes (a corrupted / hostile manifest). A path exactly equal to the
 * root (empty rel) is also rejected. Copied from the sibling rollback units; used
 * for BOTH the temp-extraction read root AND the governed write root.
 * @param {string} root     absolute base dir
 * @param {string} relPath  POSIX-relative path from the manifest
 * @returns {string|null} the contained absolute path, or null if it escapes
 */
function containedPath(root, relPath) {
  const abs = resolve(join(root, ...relPath.split('/')));
  return abs.startsWith(resolve(root) + sep) ? abs : null;
}

/**
 * Restore ONE manifest file record onto the live tree. Pushes a skip (and the right
 * diagnostic) for any non-write outcome, mutates `ctx.counters` for written files,
 * and returns `{ stop, leftovers }` when a HARD failure must halt the loop. Never
 * throws. Extracted to keep restoreSnapshot under the function-SLOC limit.
 * @param {object} ctx { targetClaudeDir, destDir, assertWritable, retry, readFileFn,
 *                        mkdirFn, atomicWriteFn, skipped, counters, bag }
 * @param {{path:string, preSha256:string}} file
 * @returns {Promise<{stop:boolean, leftovers?:object}>}
 */
async function restoreFile(ctx, file) {
  const { targetClaudeDir, destDir, assertWritable, retry, readFileFn, mkdirFn, atomicWriteFn, skipped, counters, bag } = ctx;
  const rel = file.path;

  // a. Resolve + contain the LIVE write target. A manifest path escaping the
  //    governed root is NEVER written.
  const targetAbs = containedPath(targetClaudeDir, rel);
  if (targetAbs === null) {
    bag.add({ severity: 'warn', code: 'rollback-restore-path-escape-file', phase: PHASE, path: rel,
      message: 'manifest file path escapes the target dir; skipping (not written)' });
    skipped.push({ path: rel, reason: 'out-of-surface' });
    return { stop: false };
  }

  // b. GATE — a genuine surface denial (hud/plugins) is a NON-FATAL skip;
  //    any OTHER gate error (canonicalize failure, unexpected throw) is a real
  //    failure that sets hadFailure (so restored becomes false).
  try {
    assertWritable(targetAbs, 'rollback');
  } catch (e) {
    if (isSurfaceDeny(e)) {
      bag.add({ severity: 'warn', code: 'rollback-restore-skipped-out-of-surface', phase: PHASE, path: rel,
        message: `${rel} is not in the rollback-writable surface; skipped (e.g. hud/ or plugins/ — these are not restored)` });
      skipped.push({ path: rel, reason: 'out-of-surface' });
      return { stop: false };
    }
    bag.add({ severity: 'error', code: 'rollback-restore-gate-error', phase: PHASE, path: rel,
      message: `the rollback write gate errored on ${rel} (not a surface denial): ${errMsg(e)}` });
    skipped.push({ path: rel, reason: 'verify-mismatch' });
    counters.hadFailure = true;
    return { stop: false };
  }

  // c. Read the extracted bytes (per-file containment under the temp dir too).
  const srcAbs = containedPath(destDir, rel);
  if (srcAbs === null) {
    bag.add({ severity: 'warn', code: 'rollback-restore-extract-path-escape', phase: PHASE, path: rel,
      message: 'manifest file path escapes the extraction dir; treating as corrupt (not read)' });
    skipped.push({ path: rel, reason: 'verify-mismatch' });
    counters.hadFailure = true;
    return { stop: false };
  }
  let buf;
  try {
    buf = readFileFn(srcAbs);
  } catch (e) {
    bag.add({ severity: 'warn', code: 'rollback-restore-extract-read-failed', phase: PHASE, path: rel,
      message: `could not read extracted file to restore; treating as corrupt: ${errMsg(e)}` });
    skipped.push({ path: rel, reason: 'verify-mismatch' });
    counters.hadFailure = true;
    return { stop: false };
  }

  // d. RE-VERIFY preSha256 — never write unverified bytes.
  if (sha256Hex(buf) !== file.preSha256) {
    bag.add({ severity: 'error', code: 'rollback-restore-verify-mismatch', phase: PHASE, path: rel,
      message: `extracted bytes for ${rel} do not match the captured hash; refusing to write garbage`,
      fix: 'the archive is corrupt or tampered; do not trust this snapshot to restore' });
    skipped.push({ path: rel, reason: 'verify-mismatch' });
    counters.hadFailure = true;
    return { stop: false };
  }

  // e. mkdir parent (trusted sibling of the gate-approved file; not separately gated).
  try {
    mkdirFn(dirname(targetAbs));
  } catch (e) {
    bag.add({ severity: 'error', code: 'rollback-restore-mkdir-failed', phase: PHASE, path: rel,
      message: `could not create the parent dir to restore ${rel}: ${errMsg(e)}` });
    counters.hadFailure = true;
    return { stop: true };
  }

  // f. ATOMIC WRITE (binary-safe Buffer, rollback context).
  const res = await atomicWriteFn({ target: targetAbs, content: buf, assertWritable, context: 'rollback', retry });
  for (const d of res?.diagnostics ?? []) bag.add(d);
  if (!res?.ok) {
    bag.add({ severity: 'error', code: 'rollback-restore-write-failed', phase: PHASE, path: rel,
      message: `atomic write of ${rel} failed during restore; stopping to preserve recoverable sidecars` });
    counters.hadFailure = true;
    return { stop: true, leftovers: res?.leftovers ?? null };
  }
  counters.restoredCount++;
  return { stop: false };
}

/**
 * Extract the archive into `destDir`, then run the per-file restore loop. Returns the
 * RestoreResult `fields` (sans diagnostics, which the bag carries). Extracted so the
 * temp dir's `finally` cleanup in restoreSnapshot stays a thin, obviously-bounded
 * wrapper around this. Never throws.
 * @param {object} ctx { tarPath, archivePath, destDir, snapshotId, targetClaudeDir,
 *                        manifest, assertWritable, retry, extractFn, readFileFn,
 *                        mkdirFn, atomicWriteFn, bag }
 * @returns {Promise<Partial<RestoreResult>>}
 */
async function extractAndRestore(ctx) {
  const ex = await ctx.extractFn({ tarPath: ctx.tarPath, archivePath: ctx.archivePath, destDir: ctx.destDir });
  for (const d of ex?.diagnostics ?? []) ctx.bag.add(d);
  if (!ex?.ok) {
    ctx.bag.add({ severity: 'error', code: 'rollback-restore-extract-failed', phase: PHASE,
      message: 'could not extract the snapshot archive to restore from' });
    return { ok: false, snapshotId: ctx.snapshotId, targetClaudeDir: ctx.targetClaudeDir };
  }

  /** @type {RestoreSkip[]} */
  const skipped = [];
  const counters = { restoredCount: 0, hadFailure: false };
  const fileCtx = { ...ctx, skipped, counters };
  let leftovers = null;
  for (const file of ctx.manifest.files) {
    const { stop, leftovers: lo } = await restoreFile(fileCtx, file);
    if (lo) leftovers = lo;
    if (stop) break;
  }

  const os = skipped.filter((s) => s.reason === 'out-of-surface').length;
  if (os > 0) {
    ctx.bag.add({ severity: 'info', code: 'rollback-restore-partial-surface', phase: PHASE,
      message: `${os} captured file(s) outside the rollback-writable surface were not restored` });
  }
  return {
    ok: true, restored: !counters.hadFailure, snapshotId: ctx.snapshotId,
    targetClaudeDir: ctx.targetClaudeDir, fileCount: ctx.manifest.files.length,
    restoredCount: counters.restoredCount, skipped, leftovers,
  };
}

/**
 * Restore snapshot `snapshotId` (under `mgrStateDir`) back onto the live governed
 * tree `targetClaudeDir`. Reads + verifies the manifest, resolves the system tar,
 * extracts `files.tar` into a FRESH `os.tmpdir()` dir, then per file: contains the
 * write path, gates it ('rollback'; a deny is a NON-FATAL skip), reads + re-verifies
 * the extracted bytes against preSha256, and atomically writes them. NEVER throws:
 * every failure (including a thrown seam, garbage input) becomes a Diagnostic + a
 * full-shape result; the temp dir is always cleaned up.
 *
 * @param {object} opts
 * @param {string}  opts.mgrStateDir          absolute path to the .mgr-state dir
 * @param {string}  opts.snapshotId           strict snapshot id (SNAPSHOT_ID_RE)
 * @param {string}  opts.targetClaudeDir      absolute governed dir to restore INTO
 * @param {(path:string, ctx:string)=>string} opts.assertWritable  REQUIRED gate
 * @param {string}  [opts.expectedTarget]     forwarded to verifyManifest (cross-target
 *                                             refusal); the CLI passes targetClaudeDir.
 * @param {object}  [opts.retry]              forwarded to atomicApplyWrite (withRetry)
 * @param {object}  [opts.seams]              { resolveFn, extractFn, readManifestFn,
 *                                              mkdtempFn, readFileFn, rmFn, mkdirFn,
 *                                              atomicWriteFn }
 * @returns {Promise<RestoreResult>}
 */
export async function restoreSnapshot(opts) {
  const bag = new DiagnosticBag();
  const o = opts && typeof opts === 'object' ? opts : {};
  const { mgrStateDir, snapshotId, targetClaudeDir, assertWritable, expectedTarget, retry } = o;
  const seams = o.seams && typeof o.seams === 'object' ? o.seams : {};
  const resolveFn = seams.resolveFn ?? resolveTar;
  const extractFn = seams.extractFn ?? extractSnapshotTar;
  const readManifestFn = seams.readManifestFn ?? readManifest;
  const mkdtempFn = seams.mkdtempFn ?? ((prefix) => mkdtempSync(prefix));
  const readFileFn = seams.readFileFn ?? ((abs) => readFileSync(abs));
  const rmFn = seams.rmFn ?? ((dir) => rmSync(dir, { recursive: true, force: true }));
  const mkdirFn = seams.mkdirFn ?? ((d) => mkdirSync(d, { recursive: true }));
  const atomicWriteFn = seams.atomicWriteFn ?? atomicApplyWrite;

  const fail = (code, message, fields) => { bag.add({ severity: 'error', code, message, phase: PHASE }); return buildResult(fields ?? {}, bag); };

  let destDir = null;
  try {
    // 1. Validate — refuse BEFORE any fs/write. assertWritable is fail-safe REQUIRED.
    if (!isNonEmptyStr(mgrStateDir)) return fail('rollback-restore-bad-args', 'mgrStateDir must be a non-empty string');
    if (!isNonEmptyStr(targetClaudeDir)) return fail('rollback-restore-bad-args', 'targetClaudeDir must be a non-empty string');
    if (typeof assertWritable !== 'function') return fail('rollback-restore-bad-args', 'assertWritable (the governed-write gate) must be injected');
    if (!isValidSnapshotId(snapshotId)) {
      return fail('rollback-restore-bad-id', `snapshotId must match the strict id format ${SNAPSHOT_ID_RE}`);
    }
    if (!isContainedSnapshotDir(mgrStateDir, snapshotId)) {
      return fail('rollback-restore-path-escape',
        'resolved snapshot dir escapes the snapshots root; refusing to touch the filesystem');
    }

    // 2. Read the manifest (first fs access, only on a safe id).
    const { manifest, diagnostics: readD } = readManifestFn({ stateDir: mgrStateDir, snapshotId });
    for (const d of readD ?? []) bag.add(d);
    if (!manifest) return buildResult({ snapshotId, targetClaudeDir }, bag);

    // 3. Verify schema / version / target (refuses future version + cross-target).
    const v = verifyManifest(manifest, { expectedTarget });
    for (const d of v.diagnostics ?? []) bag.add(d);
    if (!v.ok) return buildResult({ snapshotId, targetClaudeDir }, bag);

    // 4. Resolve the system tar — without it we cannot extract, so we cannot restore.
    const r = resolveFn();
    for (const d of r?.diagnostics ?? []) bag.add(d);
    const tarPath = r?.tarPath ?? null;
    if (!isNonEmptyStr(tarPath)) {
      return fail('rollback-restore-tar-unavailable',
        'system tar is unavailable; cannot extract the archive to restore', { snapshotId, targetClaudeDir });
    }

    // 5. Fresh throwaway extraction dir — the ONLY non-governed write this unit makes.
    const archivePath = join(snapshotDir(mgrStateDir, snapshotId), ARCHIVE_NAME);
    destDir = mkdtempFn(join(tmpdir(), TEMP_PREFIX));

    // 6. Extract + restore (BOUNDED cleanup in the finally).
    const fields = await extractAndRestore({
      tarPath, archivePath, destDir, snapshotId, targetClaudeDir, manifest,
      assertWritable, retry, extractFn, readFileFn, mkdirFn, atomicWriteFn, bag,
    });
    return buildResult(fields, bag);
  } catch (e) {
    return fail('rollback-restore-unexpected-error',
      `unexpected error during rollback restore: ${errMsg(e)}`,
      { snapshotId: isValidSnapshotId(snapshotId) ? snapshotId : null, targetClaudeDir: isNonEmptyStr(targetClaudeDir) ? targetClaudeDir : null });
  } finally {
    // BOUNDED cleanup: remove ONLY the temp dir THIS function created (if any). Runs
    // on every exit path; a cleanup error degrades to a warn, never masks the result.
    if (destDir !== null) {
      try { rmFn(destDir); }
      catch (e) {
        bag.add({ severity: 'warn', code: 'rollback-restore-cleanup-failed', phase: PHASE, path: destDir,
          message: `could not remove the temp extraction dir: ${errMsg(e)}` });
      }
    }
  }
}
