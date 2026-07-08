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
 * Spec: plan harness-mgr-v5.md, the `snapshotted` step (line 496) + Snapshot Scope
 * (lines 378-401).
 */

import { join, basename, dirname } from 'node:path';
import { readFileSync, lstatSync, mkdirSync, unlinkSync, rmdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { DiagnosticBag } from '../lib/diagnostic.mjs';
import { snapshotDirHashes, checkSpawnWriteBoundary } from '../lib/spawn-write-boundary.mjs';
import { walkSnapshotScope } from './snapshot-walk.mjs';
import { filterSnapshotSecrets } from './snapshot-secrets-filter.mjs';
import { resolveTar, createSnapshotTar } from './snapshot-tar.mjs';
import {
  makeSnapshotId, snapshotDir, buildManifest, isValidSnapshotId, MANIFEST_NAME,
} from './snapshot-manifest.mjs';
import { writeManifest } from './snapshot-manifest-io.mjs';

/** @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic */
/** @typedef {import('./snapshot-secrets-filter.mjs').DropRecord} DropRecord */

/** The archive filename inside a snapshot dir. */
const ARCHIVE_NAME = 'files.tar';

/** Stable diagnostic phase tag for this module's own findings. */
const PHASE = 'snapshot';

/**
 * @typedef {Object} SnapshotResult
 * NOTE: when `ok` is false the path fields (snapshotDir / archivePath /
 * manifestPath) are DIAGNOSTIC-ONLY. They may be null, or — in the same-second
 * `snapshot-id-collision` case — reference a PRE-EXISTING snapshot this run did
 * NOT create. Callers must not act on them (or on `kept`/`fileCount`) unless
 * `ok` is true.
 * @property {boolean} ok
 * @property {boolean} [dryRun]          true when this was a preview (no write happened)
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
 * Also captures each file's POSIX permission bits (`mode`) via lstat so a POSIX
 * rollback can chmod the restored file back (buildManifest masks to 0o777). This
 * is BEST-EFFORT and orthogonal to content: an lstat failure omits `mode` (→
 * restore skips chmod) but the file is still hashed + captured. lstat (not stat)
 * keeps the walk's never-follow-symlink invariant; kept files are all regular
 * files, so lstat === stat here anyway.
 *
 * @param {string} baseDir   absolute root the rel-paths resolve under
 * @param {string[]} kept    POSIX-relative kept paths (from the filter)
 * @param {(p:string)=>Buffer} readFileFn
 * @param {(p:string)=>{mode:number}} lstatFn
 * @param {DiagnosticBag} bag
 * @returns {Array<{path:string, sha256:string, mode?:number}>}
 */
function hashKeptFiles(baseDir, kept, readFileFn, lstatFn, bag) {
  /** @type {Array<{path:string, sha256:string, mode?:number}>} */
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
    const rec = { path: rel, sha256: sha256Hex(buf) };
    try { rec.mode = lstatFn(abs).mode; } catch { /* mode unavailable — content-only record */ }
    records.push(rec);
  }
  return records;
}

/** Message from an unknown thrown value; never throws. */
function errMsg(e) {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Default snapshot-dir creator with an ATOMIC collision guard (follow-up #12).
 * Ensures the `snapshots/` PARENT exists (recursive, idempotent), then creates
 * the `<id>` LEAF NON-recursively so an already-existing id dir throws EEXIST
 * with NO check-then-create (TOCTOU) window. Snapshot ids are second-resolution
 * (SNAPSHOT_ID_RE), so two `snapshot --apply` runs in the same wall-clock second
 * resolve to the SAME id + dir; the EEXIST is caught by the orchestrator and
 * turned into a `snapshot-id-collision` refusal rather than silently overwriting
 * the first snapshot's files.tar + manifest.json. Mirrors the mkdirSync default
 * the seam previously inlined, minus the unconditional `recursive` on the leaf.
 * @param {string} dir  absolute `<mgrStateDir>/snapshots/<id>` dir
 */
function defaultMkdir(dir) {
  mkdirSync(dirname(dir), { recursive: true });
  mkdirSync(dir); // NON-recursive → throws EEXIST if the id dir already exists
}

/**
 * Create the snapshot dir, classifying any failure into a stable {code,message}
 * the orchestrator turns into a failProgress result (extracted to keep
 * createSnapshot under the function-SLOC limit). An EEXIST means the
 * second-resolution id already exists — a same-second collision (#12): REFUSE
 * with `snapshot-id-collision` rather than overwrite the first snapshot. Returns
 * null on success. Never throws.
 * @param {(p:string)=>void} mkdirFn @param {string} dir @param {string} id
 * @returns {{code:string, message:string}|null}
 */
function tryMakeSnapshotDir(mkdirFn, dir, id) {
  try {
    mkdirFn(dir);
    return null;
  } catch (e) {
    if (e && e.code === 'EEXIST') {
      return { code: 'snapshot-id-collision',
        message: `a snapshot already exists at id ${id} (ids are second-resolution); retry in a moment` };
    }
    return { code: 'snapshot-mkdir-failed', message: `could not create snapshot dir: ${errMsg(e)}` };
  }
}

/**
 * BOUNDED failure cleanup (P3.D2) — remove a half-written snapshot so a failed
 * `--apply` leaves NO residue. SECURITY-CRITICAL: this only ever touches the ONE
 * snapshot dir, and ONLY via targeted unlink of the two KNOWN file paths plus an
 * `rmdir` that removes an EMPTY dir only. It NEVER recurses and NEVER does `rm -rf`,
 * so it cannot delete anything the caller did not just create. The dir path is
 * RECONSTRUCTED from `snapshotDir(mgrStateDir, id)` and the `id` is re-validated
 * against SNAPSHOT_ID_RE here (defense-in-depth: a corrupted id refuses cleanup
 * rather than touching an unexpected path). Never throws — a cleanup failure becomes
 * a `warn` and does NOT mask the original error that triggered cleanup.
 *
 * @param {string} mgrStateDir @param {string} id  (must match SNAPSHOT_ID_RE)
 * @param {{unlinkFn:(p:string)=>void, rmdirFn:(p:string)=>void}} seams
 * @param {DiagnosticBag} bag
 */
function cleanupFailedSnapshot(mgrStateDir, id, seams, bag) {
  if (!isValidSnapshotId(id)) {
    bag.add({ severity: 'warn', code: 'snapshot-cleanup-skipped', phase: PHASE,
      message: 'cleanup skipped: snapshot id failed re-validation (refusing to remove an unexpected path)' });
    return;
  }
  const dir = snapshotDir(mgrStateDir, id);
  // Targeted unlink of only the two files this unit ever writes into the dir. An
  // ENOENT (the file never got created) is benign and silently ignored.
  for (const name of [ARCHIVE_NAME, MANIFEST_NAME]) {
    try { seams.unlinkFn(join(dir, name)); }
    catch (e) {
      if (!(e && e.code === 'ENOENT')) {
        bag.add({ severity: 'warn', code: 'snapshot-cleanup-failed', phase: PHASE, path: `${id}/${name}`,
          message: `could not remove partial snapshot file during cleanup: ${errMsg(e)}` });
      }
    }
  }
  // rmdir removes the dir ONLY if it is now empty (never recursive). A leftover
  // (non-empty / busy) or absent dir degrades to a warn, never a throw.
  try { seams.rmdirFn(dir); }
  catch (e) {
    if (!(e && e.code === 'ENOENT')) {
      bag.add({ severity: 'warn', code: 'snapshot-cleanup-failed', phase: PHASE, path: id,
        message: `could not remove empty snapshot dir during cleanup: ${errMsg(e)}` });
    }
  }
}

/**
 * Resolve the system tar for a snapshot, aggregating its diagnostics into `bag`.
 * For --apply a missing/unresolvable tar is a HARD failure (`{ hardFail }` set with
 * the code to return). For a dry-run it is advisory only — `hardFail` stays null and
 * a single `snapshot-tar-unavailable` WARN is added so the user learns --apply would
 * fail, but the preview still proceeds. Never throws.
 *
 * @param {() => {tarPath:string|null, diagnostics?:Diagnostic[]}} resolveFn
 * @param {boolean} dryRun
 * @param {DiagnosticBag} bag
 * @returns {{tarPath: string|null, hardFail: {code:string, message:string}|null}}
 */
function resolveTarOrFail(resolveFn, dryRun, bag) {
  let tarPath = null;
  try {
    const r = resolveFn();
    for (const d of r?.diagnostics ?? []) bag.add(d);
    tarPath = r?.tarPath ?? null;
  } catch (e) {
    if (!dryRun) return { tarPath: null, hardFail: { code: 'snapshot-tar-resolve-failed', message: `resolveTar failed: ${errMsg(e)}` } };
    bag.add({ severity: 'warn', code: 'snapshot-tar-unavailable', phase: PHASE, message: `system tar is unavailable; --apply would fail: ${errMsg(e)}` });
    return { tarPath: null, hardFail: null };
  }
  if (!isNonEmptyStr(tarPath)) {
    if (!dryRun) return { tarPath: null, hardFail: { code: 'snapshot-tar-unavailable', message: 'system tar is unavailable; cannot create a snapshot' } };
    if (!bag.all().some((d) => d.code === 'snapshot-tar-unavailable')) {
      bag.add({ severity: 'warn', code: 'snapshot-tar-unavailable', phase: PHASE, message: 'system tar is unavailable; --apply would fail' });
    }
  }
  return { tarPath, hardFail: null };
}

/**
 * Archive the kept files, then run the post-hoc spawn-write boundary check. The
 * syscall write-gate cannot see a SPAWNED process's writes, so after tar this
 * snapshots the dir and confirms tar wrote ONLY the declared archive (files.tar)
 * into the freshly-created snapshot dir — a DETECTIVE control (threat-model
 * §5.7/§6) that catches a misbehaving tar leaving undeclared content in a "good"
 * snapshot. Adds every step's diagnostics to `bag`; returns `{ok:true}` or
 * `{ok:false, code, message}` for the caller's failProgress. Extracted to keep
 * createSnapshot under the function-SLOC limit. Never rejects — the awaited
 * createSnapshotTar is contractually never-throws and the two pure helpers never throw.
 * @param {{tarPath:string, archivePath:string, baseDir:string, files:string[], spawnFn?:Function}} tarOpts
 * @param {string} dir   the snapshot dir (created empty just before this call)
 * @param {DiagnosticBag} bag
 * @returns {Promise<{ok:boolean, code?:string, message?:string}>}
 */
async function archiveWithBoundary(tarOpts, dir, bag) {
  const before = snapshotDirHashes(dir); // empty fresh dir → {} ; attributes new files to tar
  const tar = await createSnapshotTar(tarOpts);
  for (const d of tar.diagnostics) bag.add(d);
  if (!tar.ok) return { ok: false, code: 'snapshot-archive-failed', message: 'tar archive creation failed' };
  const boundary = checkSpawnWriteBoundary({ before, after: snapshotDirHashes(dir), declaredWrites: [ARCHIVE_NAME] });
  for (const d of boundary.diagnostics) bag.add(d);
  if (!boundary.ok) return { ok: false, code: 'snapshot-tar-wrote-undeclared', message: 'tar wrote undeclared file(s) into the snapshot dir' };
  return { ok: true };
}

/**
 * Resolve createSnapshot's injectable fs/tar seams to their defaults. Extracted so
 * createSnapshot stays under the function-SLOC ceiling; behaviour-identical to the
 * former inline block. `spawnFn` is intentionally left undefined by default (→
 * createSnapshotTar falls back to safeSpawn); the D2 cleanup seams (unlink/rmdir)
 * are the targeted, EMPTY-only removers the failure path uses.
 * @param {object} [seams]
 */
function resolveSnapshotSeams(seams) {
  const s = seams && typeof seams === 'object' ? seams : {};
  return {
    resolveFn: s.resolveFn ?? resolveTar,
    spawnFn: s.spawnFn,
    readFileFn: s.readFileFn ?? readFileSync,
    lstatFn: s.lstatFn ?? lstatSync,
    mkdirFn: s.mkdirFn ?? defaultMkdir,
    unlinkFn: s.unlinkFn ?? unlinkSync,
    rmdirFn: s.rmdirFn ?? rmdirSync,
  };
}

/**
 * Create a snapshot of `targetClaudeDir` into `<mgrStateDir>/snapshots/<id>/`.
 * Wires walk → secrets-filter → hash → tar → manifest. Pure orchestration over
 * injectable seams; NEVER throws — every failure yields a Diagnostic + ok:false
 * with the aggregated diagnostics from every step that ran.
 *
 * DRY-RUN (dryRun:true): the CLI default. Runs ONLY walk + secrets-filter (the same
 * code path --apply uses, so the kept/dropped partition is IDENTICAL to what an apply
 * would capture) and returns a preview — `dryRun:true`, a preview `snapshotId`, null
 * dir/archive/manifest paths, NO hashing, NO tar, NO manifest, and NO write at all.
 * `assertWritable` is NOT required in dry-run (nothing is written). tar is still
 * resolved so an absent tar surfaces a WARN (the user learns --apply would fail), but
 * the preview is still returned.
 *
 * @param {object} opts
 * @param {string}  opts.targetClaudeDir        absolute path to the governed dir
 * @param {string}  opts.mgrStateDir            absolute path to the .mgr-state dir
 * @param {string}  [opts.reason='']            user-supplied snapshot reason
 * @param {boolean} [opts.includeAuth=false]    opt in to capturing the auth-cache file
 * @param {boolean} [opts.dryRun=false]         preview only — walk+filter, write nothing
 * @param {boolean} [opts.skipSecretFilter=false]  reversibility mode: pass `keepAll:true`
 *   to the secrets filter so ALL governed files the walker returned are kept. Use when
 *   taking a pre-mutation snapshot (apply path) so a component named like a secret or
 *   whose content happens to sniff as a token is never silently dropped from the
 *   undo point. Safe because the walker is allowlist-driven and only returns governed
 *   surface files — no stray id_rsa/.env/etc. are walked in the first place.
 * @param {(path:string, ctx:string)=>string} [opts.assertWritable]  governed-write gate (REQUIRED unless dryRun)
 * @param {import('./snapshot-walk.mjs').SnapshotScope} [opts.scope]  per-target capture
 *   scope forwarded to walkSnapshotScope (default: Claude). Codex passes descriptor.snapshotScope.
 * @param {() => Date} [opts.now]               clock injection (defaults to Date)
 * @param {object} [opts.seams]                 { resolveFn, spawnFn, readFileFn, lstatFn, mkdirFn, unlinkFn, rmdirFn }
 * @returns {Promise<SnapshotResult>}
 */
export async function createSnapshot(opts) {
  const bag = new DiagnosticBag();
  const o = opts && typeof opts === 'object' ? opts : {};
  const { targetClaudeDir, mgrStateDir, reason = '', includeAuth = false, dryRun = false,
    skipSecretFilter = false, assertWritable, scope } = o;
  const now = typeof o.now === 'function' ? o.now : () => new Date();
  const { resolveFn, spawnFn, readFileFn, lstatFn, mkdirFn, unlinkFn, rmdirFn } = resolveSnapshotSeams(o.seams);

  /** @type {SnapshotResult} */
  const empty = {
    ok: false, snapshotId: null, snapshotDir: null, archivePath: null, manifestPath: null,
    kept: [], dropped: [], fileCount: 0, diagnostics: [],
  };
  const fail = (code, message) => {
    bag.add({ severity: 'error', code, message, phase: PHASE });
    return { ...empty, diagnostics: bag.all() };
  };

  // 1. Validate inputs (fail-safe on a missing write gate — never bypass). The
  //    write gate is REQUIRED only when a write will actually happen (not dry-run).
  if (!isNonEmptyStr(targetClaudeDir)) return fail('snapshot-bad-args', 'targetClaudeDir must be a non-empty string');
  if (!isNonEmptyStr(mgrStateDir)) return fail('snapshot-bad-args', 'mgrStateDir must be a non-empty string');
  if (!dryRun && typeof assertWritable !== 'function') {
    return fail('snapshot-bad-args', 'assertWritable (the governed-write gate) must be injected');
  }

  // 2. Resolve tar up front. For --apply this is a hard prerequisite (no point
  //    walking if we cannot archive); for a dry-run it is advisory (preview anyway).
  const tarRes = resolveTarOrFail(resolveFn, dryRun, bag);
  if (tarRes.hardFail) return fail(tarRes.hardFail.code, tarRes.hardFail.message);
  const tarPath = tarRes.tarPath;

  // 3. Compute the snapshot id + destination paths. Sample the clock ONCE so the
  //    (second-resolution) id and the manifest's (full-ISO) createdAt provably
  //    share one instant — they can never straddle a second boundary (#9a).
  const capturedAt = now();
  const id = makeSnapshotId(capturedAt);
  const dir = snapshotDir(mgrStateDir, id);
  const archivePath = join(dir, ARCHIVE_NAME);

  // 4. Walk the allowlist scope (self-exclude .mgr-state by its dir name). `scope`
  //    is the per-target capture table (default: Claude); the codex CLI passes
  //    descriptor.snapshotScope so the walk captures codex's governed surface.
  const walk = walkSnapshotScope({ targetClaudeDir, mgrStateDirname: basename(mgrStateDir), scope });
  for (const d of walk.diagnostics) bag.add(d);

  // 5. Drop secrets (name OR content) — runs BEFORE tar so no credential is archived.
  //    When skipSecretFilter is true (the apply/reversibility path) keepAll:true is
  //    passed so no governed component/config file is silently excluded from the
  //    pre-mutation capture (see filterSnapshotSecrets docs for the full rationale).
  const filter = filterSnapshotSecrets({ baseDir: targetClaudeDir, files: walk.files, includeAuth, keepAll: skipSecretFilter });
  for (const d of filter.diagnostics) bag.add(d);

  // 5d. DRY-RUN short-circuit: walk + filter are done, which is the entire preview.
  //     Return the kept/dropped partition with NO hashing, NO tar, NO manifest, NO
  //     write — identical kept/dropped to what --apply would capture (same code path).
  if (dryRun) {
    return {
      ok: true, dryRun: true,
      snapshotId: id, snapshotDir: null, archivePath: null, manifestPath: null,
      kept: filter.kept, dropped: filter.dropped, fileCount: filter.kept.length,
      diagnostics: bag.all(),
    };
  }

  // Partial-progress failure: id/dir/archivePath/filter are now known, so surface
  // them alongside the error instead of the bare `empty` shell. Closes over the
  // bag so every step's diagnostics are still included. ok stays false. When
  // `cleanup` is true (a failure AFTER the dir was created), run the BOUNDED D2
  // cleanup first so no half-written snapshot dir is left on disk — the cleanup's
  // own warns are appended but never mask this error.
  const failProgress = (code, message, cleanup = false) => {
    if (cleanup) cleanupFailedSnapshot(mgrStateDir, id, { unlinkFn, rmdirFn }, bag);
    bag.add({ severity: 'error', code, message, phase: PHASE });
    return {
      ...empty, snapshotId: id, snapshotDir: dir, archivePath,
      kept: filter.kept, dropped: filter.dropped, diagnostics: bag.all(),
    };
  };

  // 6. Hash each KEPT file (point-in-time, before tar) + capture its mode via
  //    lstat. Unreadable → skip + warn; un-stat'able → captured without mode.
  const records = hashKeptFiles(targetClaudeDir, filter.kept, readFileFn, lstatFn, bag);

  // 7. Validate the .mgr-state destination through the gate, then mkdir it.
  try { assertWritable(archivePath, 'apply'); }
  catch (e) { return failProgress('snapshot-write-denied', `write gate denied: ${errMsg(e)}`); }
  // mkdir via the (default ATOMIC) creator. An EEXIST = a same-second id
  // collision (#12) → snapshot-id-collision; cleanup stays OFF so the existing
  // first snapshot is left untouched. tryMakeSnapshotDir never throws.
  const mkErr = tryMakeSnapshotDir(mkdirFn, dir, id);
  if (mkErr) return failProgress(mkErr.code, mkErr.message);

  // 8. Archive the kept files + verify the tar spawn stayed within its declared
  //    writes (the detective boundary check, §5.7/§6). From here on the dir exists
  //    → a failure runs the bounded cleanup (cleanup:true).
  const arch = await archiveWithBoundary(
    { tarPath, archivePath, baseDir: targetClaudeDir, files: filter.kept, spawnFn }, dir, bag,
  );
  if (!arch.ok) return failProgress(arch.code, arch.message, true);

  // 9. Build the manifest from the hashed records.
  const built = buildManifest({ snapshotId: id, targetClaudeDir, files: records, reason, now: () => capturedAt });
  for (const d of built.diagnostics) bag.add(d);
  if (!built.manifest) return failProgress('snapshot-manifest-failed', 'manifest build failed', true);

  // 10. Write + verify the manifest through the same gate.
  const wm = writeManifest({ stateDir: mgrStateDir, snapshotId: id, manifest: built.manifest, assertWritable });
  for (const d of wm.diagnostics) bag.add(d);
  if (!wm.written) return failProgress('snapshot-manifest-write-failed', 'manifest write failed', true);

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
