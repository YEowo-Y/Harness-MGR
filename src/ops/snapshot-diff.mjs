/**
 * Snapshot-to-snapshot diff (ops engine for `config diff <idA> <idB> [relpath]`).
 *
 * The READ-ONLY engine for comparing two snapshots taken of the governed
 * `~/.claude` surface. Two modes, dispatched on whether a `relpath` is supplied:
 *
 *   MODE A — MANIFEST diff (no relpath): compare the two snapshots' manifests by
 *     path + preSha256. Reports which files were added / removed / modified between
 *     snapshot A and snapshot B, plus a count of unchanged files. No tar is touched.
 *
 *   MODE B — CONTENT diff (relpath given): extract ONE file from each snapshot's
 *     `files.tar` into a throwaway temp dir, read both versions as UTF-8, and run
 *     the pure Myers line-diff engine (src/output/diff.mjs) to produce a unified +
 *     structured diff. A file absent from one snapshot reads as '' so the diff
 *     shows a pure add/delete.
 *
 * SECURITY / SAFETY invariants (mirror the sibling rollback read-side modules):
 *   1. READ-ONLY + gate-safe. NO governed-config write, NO .mgr-state write, NO
 *      assertWritable, NO paths.mjs (neither static nor dynamic import). The ONLY
 *      write target is the FRESH `os.tmpdir()` mkdtemp dir(s) THIS function creates
 *      (mode B only); reading a manifest is not gated.
 *   2. BOUNDED TEMP CLEANUP. Each temp dir is removed in a `finally` (runs on
 *      success, error, or throw); a cleanup error degrades to a `warn`, never throws.
 *   3. PATH-TRAVERSAL DEFENSE on the snapshot ids (strict SNAPSHOT_ID_RE via
 *      isValidSnapshotId, run BEFORE any fs) AND on a mode-B `relpath` (reject
 *      absolute paths and any `..` segment BEFORE extracting anything). NOTE: mode B
 *      extracts the WHOLE files.tar (extractSnapshotTar runs `tar -x`), so a member
 *      whose own name traverses (`../foo`, absolute) is contained by THREE layers, in
 *      this order: (a) the system tar refuses such members on extract (verified for
 *      Windows bsdtar — nonzero exit → extractOk:false → result ok:false); (b) the
 *      destination is ALWAYS a fresh os.tmpdir() mkdtemp dir, so even a hypothetical
 *      escape lands in throwaway temp, never the governed config; (c) containedPath
 *      re-checks the read-back path. The archive is harness-mgr's OWN output and, under
 *      the threat model's single-trusted-local-user assumption (docs/threat-model.md),
 *      an attacker who could rewrite files.tar already has the user's write access — so
 *      (a) is a defense-in-depth reliance on tar's behavior, not the security boundary
 *      (this mirrors how rollback-decompress-verify is reasoned about).
 *   4. PROTO-SAFETY: the manifest path→hash maps use Object.create(null) and skip
 *      `__proto__`/`constructor`/`prototype` keys (a hard project rule).
 *
 * M2-SAFETY: never imports src/paths.mjs. Takes `mgrStateDir` as a param; the CLI
 * layer (a later unit) resolves it. Injectable seams (readManifestFn, extractFn,
 * tmpRootFn) keep every path hermetically unit-testable AND let a future integration
 * test drive it with the REAL system tar.
 *
 * Ops-layer constraint: imports only node:* stdlib + src/lib/** + src/output/diff +
 * sibling src/ops/snapshot-manifest*.mjs / snapshot-tar.mjs. NEVER THROWS — every
 * failure (including a thrown seam or garbage input) becomes a Diagnostic in the
 * returned object; the temp cleanup still runs.
 */

import { join, resolve, sep } from 'node:path';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DiagnosticBag } from '../lib/diagnostic.mjs';
import { computeLineDiff, diffToJson, formatUnified } from '../output/diff.mjs';
import { isValidSnapshotId, snapshotDir, SNAPSHOT_ID_RE } from './snapshot-manifest.mjs';
import { readManifest } from './snapshot-manifest-io.mjs';
import { resolveTar, extractSnapshotTar } from './snapshot-tar.mjs';

/** @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic */

/** Stable diagnostic phase tag. */
const PHASE = 'snapshot-diff';

/** The archive filename inside a snapshot dir (a LOCAL const — snapshot.mjs does not export it). */
const ARCHIVE_NAME = 'files.tar';

/** Prefix for the throwaway extraction dirs under os.tmpdir(). */
const TEMP_PREFIX = 'cmgr-snapshot-diff-';

/** Reject prototype-poisoning keys. */
function isSafeKey(key) {
  return key !== '__proto__' && key !== 'constructor' && key !== 'prototype';
}

/** Message from an unknown thrown value; never throws. */
function errMsg(e) {
  return e instanceof Error ? e.message : String(e);
}

/** True for a non-empty string. */
function isNonEmptyStr(v) {
  return typeof v === 'string' && v.length > 0;
}

/**
 * Build a path→preSha256 map from a manifest's files. Proto-safe: a hostile
 * `__proto__` (or constructor/prototype) path is skipped, not stored. A non-array
 * `files` or a malformed entry is tolerated (skipped). Returns a null-proto object.
 * @param {any} manifest @returns {Record<string,string>}
 */
function shaMap(manifest) {
  const map = Object.create(null);
  const files = manifest && Array.isArray(manifest.files) ? manifest.files : [];
  for (const f of files) {
    if (!f || typeof f !== 'object') continue;
    const p = f.path;
    const sha = f.preSha256;
    if (typeof p !== 'string' || p.length === 0 || !isSafeKey(p)) continue;
    if (typeof sha !== 'string') continue;
    map[p] = sha;
  }
  return map;
}

// ── MODE A — manifest diff ──────────────────────────────────────────────────────

/**
 * Compare two manifests by path + preSha256. Pure over the two parsed manifests.
 * @param {any} mA @param {any} mB
 * @returns {{ added:string[], removed:string[], modified:string[], unchanged:number }}
 */
function manifestDelta(mA, mB) {
  const a = shaMap(mA);
  const b = shaMap(mB);
  const added = [];
  const removed = [];
  const modified = [];
  let unchanged = 0;
  for (const p of Object.keys(b)) {
    if (!(p in a)) added.push(p);
    else if (a[p] !== b[p]) modified.push(p);
    else unchanged += 1;
  }
  for (const p of Object.keys(a)) {
    if (!(p in b)) removed.push(p);
  }
  added.sort();
  removed.sort();
  modified.sort();
  return { added, removed, modified, unchanged };
}

/**
 * MODE A entry: validate ids, read both manifests, compute the delta. Never throws.
 * @param {object} ctx { mgrStateDir, idA, idB, readManifestFn, bag }
 * @returns {object} the manifest-mode result
 */
function diffManifests(ctx) {
  const { mgrStateDir, idA, idB, readManifestFn, bag } = ctx;
  const base = { mode: 'manifest', ok: false, idA: null, idB: null };
  if (!isValidSnapshotId(idA) || !isValidSnapshotId(idB)) {
    bag.add({ severity: 'error', code: 'snapshot-diff-bad-id', phase: PHASE,
      message: `both snapshot ids must match ${SNAPSHOT_ID_RE}` });
    return { ...base, diagnostics: bag.all() };
  }
  const mA = readOneManifest(mgrStateDir, idA, readManifestFn, bag);
  const mB = readOneManifest(mgrStateDir, idB, readManifestFn, bag);
  if (!mA || !mB) return { ...base, idA, idB, diagnostics: bag.all() };

  const { added, removed, modified, unchanged } = manifestDelta(mA, mB);
  return { mode: 'manifest', ok: true, idA, idB, added, removed, modified, unchanged, diagnostics: bag.all() };
}

/**
 * Read one snapshot's manifest, aggregating its diagnostics and adding a
 * `snapshot-diff-not-found` error (naming the id) when it is missing/unreadable.
 * @returns {any|null} the manifest, or null
 */
function readOneManifest(mgrStateDir, id, readManifestFn, bag) {
  const { manifest, diagnostics } = readManifestFn({ stateDir: mgrStateDir, snapshotId: id });
  for (const d of diagnostics ?? []) bag.add(d);
  if (!manifest) {
    bag.add({ severity: 'error', code: 'snapshot-diff-not-found', phase: PHASE,
      message: `snapshot ${id} manifest could not be read` });
    return null;
  }
  return manifest;
}

// ── MODE B — content diff ───────────────────────────────────────────────────────

/** True when a relpath is non-relative or contains a `..` segment (traversal). */
function isUnsafeRelpath(rel) {
  if (rel.startsWith('/') || rel.startsWith('\\') || /^[A-Za-z]:/.test(rel)) return true;
  return /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(rel);
}

/** Resolve a relpath under destDir, returning the contained abs path or null (escape). */
function containedPath(destDir, rel) {
  const baseAbs = resolve(destDir);
  const abs = resolve(join(destDir, ...rel.split('/')));
  return abs.startsWith(baseAbs + sep) ? abs : null;
}

/**
 * Extract `relpath` from one snapshot's files.tar into a fresh temp dir and read it
 * as UTF-8. A member absent in the archive reads as '' (pure add/delete). The temp
 * dir is recorded on `ctx.tmpDirs` for the caller's bounded cleanup. Never throws.
 * @param {object} ctx { mgrStateDir, tarPath, relpath, extractFn, tmpRootFn, readFileFn, tmpDirs, bag }
 * @param {string} id
 * @returns {Promise<{text:string, extractOk:boolean}>} the file text ('' if absent/
 *   unreadable) plus whether the archive EXTRACT itself succeeded (false = a tar
 *   failure, so the '' is not a real absence).
 */
function readMember(ctx, id) {
  const { mgrStateDir, tarPath, relpath, extractFn, tmpRootFn, readFileFn, tmpDirs, bag } = ctx;
  const archivePath = join(snapshotDir(mgrStateDir, id), ARCHIVE_NAME);
  const destDir = tmpRootFn(join(tmpdir(), TEMP_PREFIX));
  tmpDirs.push(destDir);
  return extractAndRead({ id, archivePath, destDir, tarPath, relpath, extractFn, readFileFn, bag });
}

/** Extract the archive then read the one member; the temp dir is cleaned by the caller. */
async function extractAndRead(o) {
  const { id, archivePath, destDir, tarPath, relpath, extractFn, readFileFn, bag } = o;
  const ex = await extractFn({ tarPath, archivePath, destDir });
  for (const d of ex?.diagnostics ?? []) bag.add(d);
  if (!ex?.ok) {
    bag.add({ severity: 'warn', code: 'snapshot-diff-extract-failed', phase: PHASE,
      message: `could not extract snapshot ${id} archive; treating ${relpath} as absent` });
    return { text: '', extractOk: false }; // a tar FAILURE — NOT a legit absence
  }
  const abs = containedPath(destDir, relpath);
  if (abs === null) return { text: '', extractOk: true };
  // ENOENT (member legitimately not in this snapshot) or unreadable → '', but the
  // extract SUCCEEDED so extractOk stays true (a genuine add/delete in the diff).
  try { return { text: readFileFn(abs), extractOk: true }; }
  catch { return { text: '', extractOk: true }; }
}

/**
 * MODE B entry: validate ids + relpath, resolve tar, extract+read both members,
 * line-diff them. Bounded cleanup of every temp dir in a finally. Never throws.
 * @param {object} ctx @returns {Promise<object>}
 */
async function diffContent(ctx) {
  const { mgrStateDir, idA, idB, relpath, context, seams, bag } = ctx;
  const base = { mode: 'content', ok: false, idA: null, idB: null, relpath };
  if (!isValidSnapshotId(idA) || !isValidSnapshotId(idB)) {
    bag.add({ severity: 'error', code: 'snapshot-diff-bad-id', phase: PHASE,
      message: `both snapshot ids must match ${SNAPSHOT_ID_RE}` });
    return { ...base, diagnostics: bag.all() };
  }
  if (isUnsafeRelpath(relpath)) {
    bag.add({ severity: 'error', code: 'snapshot-diff-bad-path', phase: PHASE,
      message: `relpath must be relative with no '..' segment: ${relpath}` });
    return { ...base, idA, idB, diagnostics: bag.all() };
  }
  const r = seams.resolveFn();
  for (const d of r?.diagnostics ?? []) bag.add(d);
  const tarPath = r?.tarPath ?? null;
  if (!isNonEmptyStr(tarPath)) {
    bag.add({ severity: 'error', code: 'snapshot-diff-tar-unavailable', phase: PHASE,
      message: 'system tar is unavailable; cannot extract snapshot files to diff' });
    return { ...base, idA, idB, diagnostics: bag.all() };
  }

  const tmpDirs = [];
  try {
    const rdCtx = {
      mgrStateDir, tarPath, relpath, tmpDirs, bag,
      extractFn: seams.extractFn, tmpRootFn: seams.tmpRootFn, readFileFn: seams.readFileFn,
    };
    const a = await readMember(rdCtx, idA);
    const b = await readMember(rdCtx, idB);
    return buildContentResult({
      idA, idB, relpath, context, textA: a.text, textB: b.text,
      extractOk: a.extractOk && b.extractOk, bag,
    });
  } finally {
    for (const dir of tmpDirs) {
      try { seams.rmFn(dir); }
      catch (e) {
        bag.add({ severity: 'warn', code: 'snapshot-diff-cleanup-failed', phase: PHASE, path: dir,
          message: `could not remove the temp extraction dir: ${errMsg(e)}` });
      }
    }
  }
}

/** Run the Myers diff and assemble the content-mode result. Pure. */
function buildContentResult(o) {
  const { idA, idB, relpath, context, textA, textB, extractOk, bag } = o;
  const aLabel = `${idA}:${relpath}`;
  const bLabel = `${idB}:${relpath}`;
  const diff = computeLineDiff(textA, textB);
  const json = diffToJson(diff, { aLabel, bLabel, context });
  const unified = formatUnified(diff, { aLabel, bLabel, context });
  const changed = json.stats.added > 0 || json.stats.deleted > 0;
  // ok:false when EITHER archive failed to extract — the diff is over '' and is not
  // trustworthy, surfaced beyond the warn so a consumer reading only `ok` sees it.
  return { mode: 'content', ok: extractOk !== false, idA, idB, relpath, ...json, unified, changed, diagnostics: bag.all() };
}

// ── public entry ────────────────────────────────────────────────────────────────

/**
 * Diff two snapshots. MODE A (manifest, no relpath) compares the two manifests by
 * path+preSha256; MODE B (content, relpath given) line-diffs ONE file's two versions
 * via the Myers engine. READ-ONLY + gate-safe; never throws.
 *
 * @param {object} opts
 * @param {string}  opts.mgrStateDir                absolute path to the .mgr-state dir
 * @param {string}  opts.idA                        snapshot id A (SNAPSHOT_ID_RE)
 * @param {string}  opts.idB                        snapshot id B (SNAPSHOT_ID_RE)
 * @param {string}  [opts.relpath]                  a POSIX-relative file path → MODE B
 * @param {number}  [opts.context]                  unified-diff context lines (coerced like the engine)
 * @param {Function} [opts.readManifestFn]          readManifest seam (mode A + B)
 * @param {Function} [opts.extractFn]               extractSnapshotTar seam (mode B)
 * @param {Function} [opts.tmpRootFn]               mkdtemp seam (mode B)
 * @returns {Promise<object>} result + diagnostics
 */
export async function diffSnapshots(opts) {
  const bag = new DiagnosticBag();
  const o = opts && typeof opts === 'object' ? opts : {};
  const { mgrStateDir, idA, idB, relpath, context } = o;
  const readManifestFn = o.readManifestFn ?? readManifest;

  try {
    if (!isNonEmptyStr(mgrStateDir)) {
      bag.add({ severity: 'error', code: 'snapshot-diff-bad-args', phase: PHASE,
        message: 'mgrStateDir must be a non-empty string' });
      const mode = isNonEmptyStr(relpath) ? 'content' : 'manifest';
      return { mode, ok: false, idA: null, idB: null, diagnostics: bag.all() };
    }
    if (isNonEmptyStr(relpath)) {
      const seams = {
        resolveFn: o.resolveFn ?? resolveTar,
        extractFn: o.extractFn ?? extractSnapshotTar,
        tmpRootFn: o.tmpRootFn ?? ((prefix) => mkdtempSync(prefix)),
        readFileFn: o.readFileFn ?? ((abs) => readFileSync(abs, 'utf8')),
        rmFn: o.rmFn ?? ((dir) => rmSync(dir, { recursive: true, force: true })),
      };
      return await diffContent({ mgrStateDir, idA, idB, relpath, context, seams, bag });
    }
    return diffManifests({ mgrStateDir, idA, idB, readManifestFn, bag });
  } catch (e) {
    bag.add({ severity: 'error', code: 'snapshot-diff-unexpected-error', phase: PHASE,
      message: `unexpected error during snapshot diff: ${errMsg(e)}` });
    return { mode: isNonEmptyStr(relpath) ? 'content' : 'manifest', ok: false, idA: null, idB: null, diagnostics: bag.all() };
  }
}
