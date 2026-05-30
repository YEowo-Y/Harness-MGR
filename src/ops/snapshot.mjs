/**
 * Snapshot orchestrator (P3.U8) — the THIN wiring that turns the four already-
 * built snapshot pieces into ONE "create a snapshot" operation:
 *
 *   walk (U5)  →  secrets-filter (U6)  →  hash + tar (U7)  →  manifest (built)
 *
 * This is the FIRST integration unit of Phase 3; the risk lives in the WIRING,
 * not the pieces. It is SECURITY-CRITICAL on two axes:
 *   1. The assembled archive must EXCLUDE secrets (the U6 filter runs before tar,
 *      so a dropped credential never reaches the archive — not just the manifest).
 *   2. It writes ONLY into `<mgrStateDir>/snapshots/<id>/` (archive + manifest);
 *      the governed `~/.claude` config surface is never written — a snapshot is
 *      non-destructive. assertWritable is INJECTED + REQUIRED (fail-safe: refuse
 *      if absent, never silently bypass), exactly like writeManifest / lock.mjs.
 *
 * NO LOCK, NO JOURNAL: a standalone snapshot makes no destructive change to the
 * governed config, so the apply-lock + apply-journal belong to the apply path
 * (P3.U12), not here. This unit is walk + filter + hash + tar + manifest only.
 *
 * M2-SAFETY: this module never imports src/paths.mjs (which carries a top-level
 * await). It takes `targetClaudeDir`, `mgrStateDir`, and `assertWritable` as
 * params; the CLI layer (a later unit) dynamically imports paths.mjs and injects
 * them, keeping the static import graph paths.mjs-free.
 *
 * Ops-layer constraint: imports only node:* stdlib + src/lib/** + sibling
 * src/ops/*. NEVER THROWS — every failure becomes a Diagnostic + `{ ok:false }`.
 * Injectable resolveFn / spawnFn / readFileFn / mkdirFn / now seams make every
 * path hermetically unit-testable without a real tar or real fs. Zero npm deps.
 *
 * Spec: plan claude-mgr-v5.md, the `snapshotted` step (line 496) + Snapshot Scope
 * (lines 378-401).
 */

import { join, basename } from 'node:path';
import { readFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { DiagnosticBag } from '../lib/diagnostic.mjs';
import { walkSnapshotScope } from './snapshot-walk.mjs';
import { filterSnapshotSecrets } from './snapshot-secrets-filter.mjs';
import { resolveTar, createSnapshotTar } from './snapshot-tar.mjs';
import { makeSnapshotId, snapshotDir, buildManifest } from './snapshot-manifest.mjs';
import { writeManifest } from './snapshot-manifest-io.mjs';

/** @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic */
/** @typedef {import('./snapshot-secrets-filter.mjs').DropRecord} DropRecord */

/** The archive filename inside a snapshot dir. */
const ARCHIVE_NAME = 'files.tar';

/** Stable diagnostic phase tag for this module's own findings. */
const PHASE = 'snapshot';

/**
 * @typedef {Object} SnapshotResult
 * @property {boolean} ok
 * @property {string|null} snapshotId
 * @property {string|null} snapshotDir   absolute dir holding the archive + manifest
 * @property {string|null} archivePath   absolute path of files.tar
 * @property {string|null} manifestPath  absolute path of manifest.json
 * @property {string[]} kept             POSIX-relative paths captured into the archive
 * @property {DropRecord[]} dropped      files excluded by the secrets filter
 * @property {number} fileCount          number of kept files hashed into the manifest
 * @property {Diagnostic[]} diagnostics  aggregated across every step
 */

/** True for a non-empty string. */
function isNonEmptyStr(v) {
  return typeof v === 'string' && v.length > 0;
}

/** sha256 hex over a Buffer. Mirrors discovery/probe-state.mjs. */
function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Hash each KEPT file's bytes into a `{ path, sha256 }` manifest record. Reads
 * binary-safe (Buffer, no encoding) so BOM / unicode / binary content hash
 * stably. An UNREADABLE kept file is skipped + warned (don't abort — a snapshot
 * of the readable files is still useful; mirrors buildManifest's skip-malformed
 * tolerance). Hashing happens BEFORE tar so the hash is point-in-time.
 *
 * @param {string} baseDir   absolute root the rel-paths resolve under
 * @param {string[]} kept    POSIX-relative kept paths (from the filter)
 * @param {(p:string)=>Buffer} readFileFn
 * @param {DiagnosticBag} bag
 * @returns {Array<{path:string, sha256:string}>}
 */
function hashKeptFiles(baseDir, kept, readFileFn, bag) {
  /** @type {Array<{path:string, sha256:string}>} */
  const records = [];
  for (const rel of kept) {
    const abs = join(baseDir, ...rel.split('/'));
    let buf;
    try {
      buf = readFileFn(abs);
    } catch (e) {
      bag.add({
        severity: 'warn', code: 'snapshot-file-unreadable', phase: PHASE, path: rel,
        message: `skipped unreadable file during snapshot hashing: ${errMsg(e)}`,
      });
      continue;
    }
    records.push({ path: rel, sha256: sha256Hex(buf) });
  }
  return records;
}

/** Message from an unknown thrown value; never throws. */
function errMsg(e) {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Create a snapshot of `targetClaudeDir` into `<mgrStateDir>/snapshots/<id>/`.
 * Wires walk → secrets-filter → hash → tar → manifest. Pure orchestration over
 * injectable seams; NEVER throws — every failure yields a Diagnostic + ok:false
 * with the aggregated diagnostics from every step that ran.
 *
 * @param {object} opts
 * @param {string}  opts.targetClaudeDir        absolute path to the governed dir
 * @param {string}  opts.mgrStateDir            absolute path to the .mgr-state dir
 * @param {string}  [opts.reason='']            user-supplied snapshot reason
 * @param {boolean} [opts.includeAuth=false]    opt in to capturing the auth-cache file
 * @param {(path:string, ctx:string)=>string} opts.assertWritable  governed-write gate (REQUIRED)
 * @param {() => Date} [opts.now]               clock injection (defaults to Date)
 * @param {object} [opts.seams]                 { resolveFn, spawnFn, readFileFn, mkdirFn }
 * @returns {Promise<SnapshotResult>}
 */
export async function createSnapshot(opts) {
  const bag = new DiagnosticBag();
  const o = opts && typeof opts === 'object' ? opts : {};
  const { targetClaudeDir, mgrStateDir, reason = '', includeAuth = false, assertWritable } = o;
  const now = typeof o.now === 'function' ? o.now : () => new Date();
  const seams = o.seams && typeof o.seams === 'object' ? o.seams : {};
  const resolveFn = seams.resolveFn ?? resolveTar;
  const spawnFn = seams.spawnFn; // undefined → createSnapshotTar uses safeSpawn
  const readFileFn = seams.readFileFn ?? readFileSync;
  const mkdirFn = seams.mkdirFn ?? ((p) => mkdirSync(p, { recursive: true }));

  /** @type {SnapshotResult} */
  const empty = {
    ok: false, snapshotId: null, snapshotDir: null, archivePath: null, manifestPath: null,
    kept: [], dropped: [], fileCount: 0, diagnostics: [],
  };
  const fail = (code, message) => {
    bag.add({ severity: 'error', code, message, phase: PHASE });
    return { ...empty, diagnostics: bag.all() };
  };

  // 1. Validate inputs (fail-safe on a missing write gate — never bypass).
  if (!isNonEmptyStr(targetClaudeDir)) return fail('snapshot-bad-args', 'targetClaudeDir must be a non-empty string');
  if (!isNonEmptyStr(mgrStateDir)) return fail('snapshot-bad-args', 'mgrStateDir must be a non-empty string');
  if (typeof assertWritable !== 'function') {
    return fail('snapshot-bad-args', 'assertWritable (the governed-write gate) must be injected');
  }

  // 2. Resolve tar up front — no point walking if we cannot archive.
  let tarPath;
  try {
    const r = resolveFn();
    for (const d of r?.diagnostics ?? []) bag.add(d);
    tarPath = r?.tarPath ?? null;
  } catch (e) {
    return fail('snapshot-tar-resolve-failed', `resolveTar failed: ${errMsg(e)}`);
  }
  if (!isNonEmptyStr(tarPath)) return fail('snapshot-tar-unavailable', 'system tar is unavailable; cannot create a snapshot');

  // 3. Compute the snapshot id + destination paths.
  const id = makeSnapshotId(now());
  const dir = snapshotDir(mgrStateDir, id);
  const archivePath = join(dir, ARCHIVE_NAME);

  // 4. Walk the allowlist scope (self-exclude .mgr-state by its dir name).
  const walk = walkSnapshotScope({ targetClaudeDir, mgrStateDirname: basename(mgrStateDir) });
  for (const d of walk.diagnostics) bag.add(d);

  // 5. Drop secrets (name OR content) — runs BEFORE tar so no credential is archived.
  const filter = filterSnapshotSecrets({ baseDir: targetClaudeDir, files: walk.files, includeAuth });
  for (const d of filter.diagnostics) bag.add(d);

  // Partial-progress failure: id/dir/archivePath/filter are now known, so surface
  // them alongside the error instead of the bare `empty` shell. Closes over the
  // bag so every step's diagnostics are still included. ok stays false.
  const failProgress = (code, message) => {
    bag.add({ severity: 'error', code, message, phase: PHASE });
    return {
      ...empty, snapshotId: id, snapshotDir: dir, archivePath,
      kept: filter.kept, dropped: filter.dropped, diagnostics: bag.all(),
    };
  };

  // 6. Hash each KEPT file (point-in-time, before tar). Unreadable → skip + warn.
  const records = hashKeptFiles(targetClaudeDir, filter.kept, readFileFn, bag);

  // 7. Validate the .mgr-state destination through the gate, then mkdir it.
  try { assertWritable(archivePath, 'apply'); }
  catch (e) { return failProgress('snapshot-write-denied', `write gate denied: ${errMsg(e)}`); }
  try { mkdirFn(dir); }
  catch (e) { return failProgress('snapshot-mkdir-failed', `could not create snapshot dir: ${errMsg(e)}`); }

  // 8. Archive the kept files (relative POSIX paths, rooted at targetClaudeDir).
  const tar = await createSnapshotTar({ tarPath, archivePath, baseDir: targetClaudeDir, files: filter.kept, spawnFn });
  for (const d of tar.diagnostics) bag.add(d);
  if (!tar.ok) return failProgress('snapshot-archive-failed', 'tar archive creation failed');

  // 9. Build the manifest from the hashed records.
  const built = buildManifest({ snapshotId: id, targetClaudeDir, files: records, reason, now });
  for (const d of built.diagnostics) bag.add(d);
  if (!built.manifest) return failProgress('snapshot-manifest-failed', 'manifest build failed');

  // 10. Write + verify the manifest through the same gate.
  const wm = writeManifest({ stateDir: mgrStateDir, snapshotId: id, manifest: built.manifest, assertWritable });
  for (const d of wm.diagnostics) bag.add(d);
  if (!wm.written) return failProgress('snapshot-manifest-write-failed', 'manifest write failed');

  // 11. Success — every path + the kept/dropped partition + aggregated diagnostics.
  return {
    ok: true,
    snapshotId: id,
    snapshotDir: dir,
    archivePath,
    manifestPath: wm.path,
    kept: filter.kept,
    dropped: filter.dropped,
    fileCount: records.length,
    diagnostics: bag.all(),
  };
}
