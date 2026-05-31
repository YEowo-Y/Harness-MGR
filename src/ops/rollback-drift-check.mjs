/**
 * Rollback drift check (P3.U15) — the FIRST read-side unit of the rollback safety
 * net. A rollback restores files FROM a snapshot back onto the live `~/.claude`
 * tree. If the live tree DRIFTED since the snapshot was taken (a governed file was
 * edited or deleted afterwards), restoring would SILENTLY CLOBBER those newer user
 * changes. This unit DETECTS + REPORTS that drift; it never restores anything:
 *
 *   readManifest  →  verifyManifest  →  for each file: hash live bytes vs baseline
 *                                       *** report modified / deleted, that's all ***
 *
 * The rollback orchestrator (P3.U17, NOT built here) consumes the result and
 * REFUSES on drift unless `--force`. This unit only computes the drift.
 *
 * SECURITY / SAFETY invariants (each mirrors the sibling ops modules):
 *   1. READ-ONLY. This unit performs ZERO filesystem writes of any kind — no
 *      writeFileSync / mkdirSync / unlink / rmdir. It is pure read + sha256 compare,
 *      so (unlike apply.mjs / recover.mjs / snapshot.mjs) it needs NO assertWritable
 *      gate at all — there is no write to gate. None is accepted or used.
 *   2. PATH-TRAVERSAL DEFENSE on the snapshotId (the headline DoD), run BEFORE any
 *      fs access — first the strict SNAPSHOT_ID_RE (admits no '.', '/' or '\\', so a
 *      valid id can carry no traversal), then a belt-and-suspenders resolve() check
 *      that the snapshot dir stays under `<mgrStateDir>/snapshots/`. A non-conforming
 *      id NEVER reaches readManifest. Mirrors recover.mjs.
 *   3. PER-FILE CONTAINMENT. Every manifest `file.path` is resolved under
 *      targetClaudeDir and verified to stay inside it BEFORE being read. A corrupted
 *      or hostile manifest entry (e.g. '../../etc/passwd') is NEVER read off disk —
 *      it is skipped + warned. This stops a tampered manifest from making the checker
 *      read arbitrary files outside the governed tree.
 *   4. verifyManifest refuses a FUTURE manifestVersion + a cross-target manifest
 *      (when expectedTarget is supplied), so a newer-tool / wrong-tree manifest never
 *      drives a comparison.
 *
 * Drift semantics: a missing live file (ENOENT) is a 'deleted' change; a live file
 * whose bytes no longer hash to the manifest's `currentSha256` is a 'modified'
 * change; any OTHER read error (e.g. EACCES) is treated CONSERVATIVELY as 'modified'
 * (actual:null) — we cannot verify it, so we must assume it changed rather than let
 * a rollback clobber it unseen.
 *
 * M2-SAFETY: this module never imports src/paths.mjs (which carries a top-level
 * await) — not statically, not via dynamic import(). It takes `mgrStateDir` as a
 * param; the CLI layer (a later unit) resolves it.
 *
 * Ops-layer constraint: imports only node:* stdlib + src/lib/** + sibling
 * src/ops/*. NEVER THROWS — every failure (including a thrown seam, garbage input)
 * becomes a Diagnostic + `{ ok:false }`. Injectable seams make every path
 * hermetically unit-testable without a real manifest / fs. Zero npm deps.
 *
 * Spec: plan claude-mgr-v5.md, the rollback drift-detection step — the READ-ONLY
 * detect slice (P3.U17 owns the refuse-without-force orchestration).
 */

import { join, resolve, sep } from 'node:path';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { DiagnosticBag } from '../lib/diagnostic.mjs';
import { isValidSnapshotId, snapshotDir, verifyManifest, SNAPSHOTS_DIRNAME, SNAPSHOT_ID_RE } from './snapshot-manifest.mjs';
import { readManifest } from './snapshot-manifest-io.mjs';

/** @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic */

/** Stable diagnostic phase tag for this module's own findings. */
const PHASE = 'rollback-drift';

/**
 * @typedef {Object} DriftChange
 * @property {string} path            POSIX-relative path within the governed dir
 * @property {'modified'|'deleted'} kind
 * @property {string} expected        the manifest's currentSha256 baseline
 * @property {string|null} actual     the live hash ('modified') or null (deleted/unreadable)
 */

/**
 * @typedef {Object} DriftResult
 * @property {boolean} ok             true ONLY when the check RAN to completion
 *                                    (manifest read + verified). false = could not run.
 * @property {boolean} clean          true when ok AND zero drift was found.
 * @property {string|null} snapshotId
 * @property {string|null} targetClaudeDir
 * @property {DriftChange[]} changes  drifted files, sorted by path (empty when clean).
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

/** sha256 hex over a Buffer. Mirrors snapshot.mjs / discovery/probe-state.mjs. */
function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Build a DriftResult, defaulting every field so callers always get the full shape.
 * @param {Partial<DriftResult>} fields
 * @param {DiagnosticBag} bag
 * @returns {DriftResult}
 */
function buildResult(fields, bag) {
  return {
    ok: false, clean: false, snapshotId: null, targetClaudeDir: null, changes: [],
    ...fields,
    diagnostics: bag.all(),
  };
}

/**
 * Belt-and-suspenders path-traversal guard run AFTER the regex passes: confirm the
 * resolved snapshot dir is exactly `<snapshots>/<id>` and stays under the snapshots
 * root. The strict id regex already forbids separators/dots, so this can only fail
 * on a pathological input — but defense in depth is cheap and the DoD's headline.
 * Mirrors recover.mjs::isContainedSnapshotDir.
 * @param {string} mgrStateDir @param {string} snapshotId @returns {boolean}
 */
function isContainedSnapshotDir(mgrStateDir, snapshotId) {
  const base = resolve(join(mgrStateDir, SNAPSHOTS_DIRNAME));
  const target = resolve(snapshotDir(mgrStateDir, snapshotId));
  return target === join(base, snapshotId) && target.startsWith(base + sep);
}

/**
 * Per-file containment guard: resolve a manifest-relative POSIX path under the
 * governed root and confirm it stays inside it. Returns the absolute path when
 * safe, or null when the entry escapes (a corrupted / hostile manifest). A path
 * exactly equal to the root (empty rel) is also rejected — there is no file there.
 * @param {string} targetRoot  absolute governed dir
 * @param {string} relPath     POSIX-relative path from the manifest
 * @returns {string|null} the contained absolute path, or null if it escapes
 */
function containedFilePath(targetRoot, relPath) {
  const base = resolve(targetRoot);
  const abs = resolve(join(targetRoot, ...relPath.split('/')));
  return abs.startsWith(base + sep) ? abs : null;
}

/**
 * Compare ONE manifest file record against the live tree, pushing a DriftChange
 * into `changes` when it drifted. ENOENT → deleted; hash-mismatch → modified; any
 * other read error → conservative 'modified' (actual:null) + a warn. A manifest
 * path that escapes the governed root is NEVER read — it is skipped + warned.
 * Extracted to keep checkRollbackDrift under the function-SLOC limit.
 * @param {object} ctx { targetClaudeDir, readFileFn, changes, bag }
 * @param {{path:string, currentSha256:string}} file
 */
function compareFile(ctx, file) {
  const { targetClaudeDir, readFileFn, changes, bag } = ctx;
  const rel = file.path;
  const expected = file.currentSha256;

  // SECURITY: never read a manifest entry that escapes the governed root.
  const abs = containedFilePath(targetClaudeDir, rel);
  if (abs === null) {
    bag.add({ severity: 'warn', code: 'drift-manifest-path-escape', phase: PHASE, path: rel,
      message: 'manifest file path escapes the target dir; skipping (not read)' });
    return;
  }

  let buf;
  try {
    buf = readFileFn(abs);
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      changes.push({ path: rel, kind: 'deleted', expected, actual: null });
      return;
    }
    // Any other read error: we cannot verify the file → assume it changed.
    bag.add({ severity: 'warn', code: 'drift-file-unreadable', phase: PHASE, path: rel,
      message: `could not read live file to verify drift; treating as modified: ${errMsg(e)}` });
    changes.push({ path: rel, kind: 'modified', expected, actual: null });
    return;
  }

  const actual = sha256Hex(buf);
  if (actual !== expected) {
    changes.push({ path: rel, kind: 'modified', expected, actual });
  }
}

/**
 * Detect whether the live `~/.claude` tree drifted from the snapshot `snapshotId`
 * under `mgrStateDir`. Reads + verifies the snapshot manifest, then hashes each
 * recorded file's live bytes against its baseline. Performs NO writes — purely
 * read + compare, so no write gate is needed. NEVER throws: every failure,
 * including a thrown seam or garbage input, becomes a Diagnostic + `{ ok:false }`.
 *
 * @param {object} opts
 * @param {string}  opts.mgrStateDir          absolute path to the .mgr-state dir
 * @param {string}  opts.snapshotId           strict snapshot id (SNAPSHOT_ID_RE)
 * @param {string}  [opts.expectedTarget]     live dir this snapshot must belong to
 *                                            (cross-target refusal); defaults to the
 *                                            manifest's own targetClaudeDir as read root.
 * @param {() => Date} [opts.now]             reserved clock seam (unused here; accepted
 *                                            for signature parity with sibling ops).
 * @param {object}  [opts.seams]              { readManifestFn, readFileFn }
 * @returns {DriftResult}
 */
export function checkRollbackDrift(opts) {
  const bag = new DiagnosticBag();
  const o = opts && typeof opts === 'object' ? opts : {};
  const { mgrStateDir, snapshotId, expectedTarget } = o;
  const seams = o.seams && typeof o.seams === 'object' ? o.seams : {};
  const readManifestFn = seams.readManifestFn ?? readManifest;
  const readFileFn = seams.readFileFn ?? ((abs) => readFileSync(abs));

  const fail = (code, message, fields) => {
    bag.add({ severity: 'error', code, message, phase: PHASE });
    return buildResult({ ...fields }, bag);
  };

  try {
    // 1. Validate — refuse BEFORE any fs access. A bad state dir or a non-conforming
    //    id (strict regex THEN resolve-containment) must never reach readManifest.
    if (!isNonEmptyStr(mgrStateDir)) {
      return fail('drift-bad-args', 'mgrStateDir must be a non-empty string');
    }
    if (!isValidSnapshotId(snapshotId)) {
      return fail('drift-bad-id', `snapshotId must match the strict id format ${SNAPSHOT_ID_RE}`);
    }
    if (!isContainedSnapshotDir(mgrStateDir, snapshotId)) {
      return fail('drift-path-escape',
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
    if (!v.ok) {
      return buildResult({ snapshotId, targetClaudeDir: manifest.targetClaudeDir ?? null }, bag);
    }

    // 4. Compare each recorded file's live bytes against its baseline hash.
    const targetClaudeDir = manifest.targetClaudeDir;
    /** @type {DriftChange[]} */
    const changes = [];
    const ctx = { targetClaudeDir, readFileFn, changes, bag };
    for (const file of manifest.files) compareFile(ctx, file);

    // 5. Summarize. clean = no drift. On drift, add ONE summary warn the
    //    orchestrator (U17) turns into a refuse-without-force.
    changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const clean = changes.length === 0;
    if (!clean) {
      bag.add({ severity: 'warn', code: 'rollback-drift-detected', phase: PHASE,
        message: `live tree drifted from snapshot ${snapshotId}: ${changes.length} file(s) changed since capture`,
        fix: 'review the changes; a rollback would overwrite them (use --force to proceed)' });
    }
    return buildResult({ ok: true, clean, snapshotId, targetClaudeDir, changes }, bag);
  } catch (e) {
    // Absolute backstop: a thrown seam / unexpected error becomes a diagnostic.
    return fail('drift-unexpected-error',
      `unexpected error during rollback drift check: ${errMsg(e)}`,
      { snapshotId: isValidSnapshotId(snapshotId) ? snapshotId : null });
  }
}
