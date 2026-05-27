/**
 * Snapshot manifest model (P3.U8) — the PURE half of a snapshot's machine-
 * readable contract. The gated I/O half (write/read) lives in the sibling
 * `snapshot-manifest-io.mjs`; this file is split out so each stays well under
 * the 200-SLOC module ceiling and keeps a clean pure-vs-I/O boundary.
 *
 * A snapshot's `manifest.json` is the single source of truth a future rollback
 * reads to decide whether restoring is safe:
 *
 *   { manifestVersion, planVersion, snapshotId, targetClaudeDir, createdAt,
 *     reason, files: [{ path, preSha256, currentSha256 }, ...] }
 *
 * NAMING NOTE: the plan's "currentSha256[]" field is realised here as the
 * `files` array — each entry CARRIES a `currentSha256` (the plan's per-file
 * `{path, preSha256, currentSha256}` record). `files` keeps path + both hashes
 * together and is clearer than a bare hash array. At snapshot-creation time
 * preSha256 === currentSha256 (both = the file's hash when captured); the two
 * diverge in MEANING only at rollback — `currentSha256` is the baseline rollback
 * compares to the live on-disk hash (drift detection), while `preSha256` is what
 * the tar payload must hash to before any restore write.
 *
 * Determinism: the manifest is built with a FIXED key order and the file list is
 * path-sorted, so JSON.stringify produces byte-identical output across runs and
 * machines (a golden-file property). No dependency on output/json's
 * stableStringify — controlled construction is enough and keeps the import
 * boundary clean.
 *
 * SCOPE: the `snapshot.mjs` thin orchestrator that wires walk(U5)+secrets-
 * filter(U6)+tar(U7)+manifest is DEFERRED until those units land.
 *
 * Ops-layer constraint: imports only node:* stdlib and src/lib/**. Pure; never
 * throws. Zero npm dependencies.
 */

import { join } from 'node:path';
import { DiagnosticBag } from '../lib/diagnostic.mjs';

/** @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic */

/** Manifest schema version. Rollback refuses any manifest whose version is
 *  GREATER than this (a newer tool wrote it; we cannot safely interpret it). */
export const MANIFEST_VERSION = 1;

/** Subdir under mgrStateDir that holds per-snapshot dirs. */
export const SNAPSHOTS_DIRNAME = 'snapshots';

/** The manifest filename inside a snapshot dir. */
export const MANIFEST_NAME = 'manifest.json';

/** Snapshot IDs are timestamps of the form YYYY-MM-DDTHH-MM-SSZ (UTC). The
 *  strict shape doubles as a path-traversal guard: an id can hold no separators,
 *  dots, or `..`, so it can never escape the snapshots dir. (Plan line 502.) */
export const SNAPSHOT_ID_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/;

/**
 * @typedef {Object} FileRecord
 * @property {string} path          POSIX-relative path within the governed dir
 * @property {string} preSha256     hash of the captured (archived) content
 * @property {string} currentSha256 baseline hash rollback compares to live disk
 */

/**
 * @typedef {Object} Manifest
 * @property {number} manifestVersion
 * @property {number} planVersion
 * @property {string} snapshotId
 * @property {string} targetClaudeDir
 * @property {string} createdAt        ISO timestamp the manifest was built
 * @property {string} reason           user-supplied reason ('' if none)
 * @property {FileRecord[]} files
 */

// ── shared helpers (also imported by the io sibling) ──────────────────────────

/** True for a non-null, non-array object. */
export function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Message from an unknown thrown value; never throws. */
export function errMsg(e) {
  return e instanceof Error ? e.message : String(e);
}

/** Deterministic serialization of a built manifest (fixed key order + trailing \n). */
export function serialize(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

// ── id + path helpers (pure) ──────────────────────────────────────────────────

/**
 * Format a Date as a snapshot id: YYYY-MM-DDTHH-MM-SSZ (UTC, second precision).
 * Colons in the time become '-' so the id is a safe path segment on Windows. A
 * non-Date / invalid-Date input falls back to `new Date()`.
 * @param {Date} [date] @returns {string}
 */
export function makeSnapshotId(date = new Date()) {
  const d = (date instanceof Date && !Number.isNaN(date.getTime())) ? date : new Date();
  let iso;
  // toISOString() throws RangeError for an extreme (in-range Date) year; fall back.
  try { iso = d.toISOString(); } catch { iso = new Date().toISOString(); }
  return iso.replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-');
}

/** @param {unknown} id @returns {boolean} */
export function isValidSnapshotId(id) {
  return typeof id === 'string' && SNAPSHOT_ID_RE.test(id);
}

/** @param {string} stateDir @param {string} snapshotId @returns {string} */
export function snapshotDir(stateDir, snapshotId) {
  return join(stateDir, SNAPSHOTS_DIRNAME, snapshotId);
}

/** @param {string} stateDir @param {string} snapshotId @returns {string} */
export function manifestPath(stateDir, snapshotId) {
  return join(snapshotDir(stateDir, snapshotId), MANIFEST_NAME);
}

// ── buildManifest (pure) ──────────────────────────────────────────────────────

/**
 * Normalize one raw {path, sha256} capture record into a FileRecord, or null
 * when the entry is not a usable record (the caller diagnoses).
 * @param {unknown} raw @returns {FileRecord|null}
 */
function normalizeFile(raw) {
  if (!isObject(raw)) return null;
  const { path, sha256 } = raw;
  if (typeof path !== 'string' || path.length === 0) return null;
  if (typeof sha256 !== 'string' || sha256.length === 0) return null;
  // At creation pre === current; they carry distinct MEANING only at rollback.
  return { path, preSha256: sha256, currentSha256: sha256 };
}

/**
 * Assemble a Manifest from a snapshot's captured file list. Pure; never throws.
 * Malformed file entries are skipped with a warn (a snapshot of the readable
 * files is still useful) rather than aborting.
 *
 * @param {object} opts
 * @param {string}  opts.snapshotId
 * @param {string}  opts.targetClaudeDir
 * @param {Array<{path:string, sha256:string}>} opts.files  captured records
 * @param {number}  [opts.planVersion]   defaults to 1
 * @param {string}  [opts.reason]        defaults to ''
 * @param {() => Date} [opts.now]        clock injection (defaults to Date)
 * @returns {{ manifest: Manifest|null, diagnostics: Diagnostic[] }}
 */
export function buildManifest(opts) {
  const {
    snapshotId, targetClaudeDir, files,
    planVersion = 1, reason = '', now = () => new Date(),
  } = opts ?? {};
  const bag = new DiagnosticBag();
  const bail = (code, message) => {
    bag.add({ severity: 'error', code, message, phase: 'snapshot' });
    return { manifest: null, diagnostics: bag.all() };
  };

  if (!isValidSnapshotId(snapshotId)) {
    return bail('manifest-snapshot-id-invalid', `snapshotId must match ${SNAPSHOT_ID_RE}`);
  }
  if (typeof targetClaudeDir !== 'string' || targetClaudeDir.length === 0) {
    return bail('manifest-target-invalid', 'targetClaudeDir must be a non-empty string');
  }
  if (!Array.isArray(files)) {
    return bail('manifest-files-invalid', 'files must be an array of { path, sha256 } records');
  }

  /** @type {FileRecord[]} */
  const records = [];
  for (const raw of files) {
    const rec = normalizeFile(raw);
    if (rec) records.push(rec);
    else bag.add({ severity: 'warn', code: 'manifest-file-skipped', phase: 'snapshot',
      message: 'skipped malformed capture record (needs non-empty path + sha256)' });
  }
  // Total order (path, then preSha256) → byte-stable even if a path repeats;
  // a path-only comparator would leave dup paths in input order (sort is stable).
  records.sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1
      : a.preSha256 < b.preSha256 ? -1 : a.preSha256 > b.preSha256 ? 1 : 0);

  // FIXED key order → deterministic JSON.stringify output.
  /** @type {Manifest} */
  const manifest = {
    manifestVersion: MANIFEST_VERSION,
    planVersion: Number.isInteger(planVersion) && planVersion >= 1 ? planVersion : 1,
    snapshotId,
    targetClaudeDir,
    createdAt: clockIso(now),
    reason: typeof reason === 'string' ? reason : '',
    files: records,
  };
  return { manifest, diagnostics: bag.all() };
}

/** Best-effort ISO from an injected clock; never throws. */
function clockIso(now) {
  try {
    const d = now();
    if (d instanceof Date && !Number.isNaN(d.getTime())) return d.toISOString();
  } catch { /* fall through */ }
  return new Date(0).toISOString();
}

// ── verifyManifest (pure schema/version/target validation) ────────────────────

/**
 * Validate a parsed manifest's schema, refuse FUTURE manifest versions, and
 * (optionally) refuse a cross-target manifest. Pure; never throws. `ok` is true
 * only when no error diagnostics were produced.
 *
 * @param {unknown} manifest
 * @param {object} [opts]
 * @param {string} [opts.expectedTarget]  refuse if manifest.targetClaudeDir differs
 * @returns {{ ok: boolean, diagnostics: Diagnostic[] }}
 */
export function verifyManifest(manifest, opts = {}) {
  const { expectedTarget } = opts ?? {};
  const bag = new DiagnosticBag();
  const err = (code, message) => bag.add({ severity: 'error', code, message, phase: 'snapshot' });

  if (!isObject(manifest)) {
    err('manifest-invalid', 'manifest must be an object');
    return { ok: false, diagnostics: bag.all() };
  }

  // Versions are positive integers (a newer-than-supported version is refused
  // separately). Rejecting 0 / negatives / floats stops a malformed or partially
  // written manifest from being trusted by the rollback read path.
  const mv = manifest.manifestVersion;
  if (!Number.isInteger(mv) || mv < 1) {
    err('manifest-version-invalid', 'manifestVersion must be a positive integer');
  } else if (mv > MANIFEST_VERSION) {
    err('manifest-version-unsupported',
      `manifest version ${mv} is newer than supported ${MANIFEST_VERSION}; upgrade claude-mgr`);
  }
  if (!Number.isInteger(manifest.planVersion) || manifest.planVersion < 1) {
    err('manifest-plan-version-invalid', 'planVersion must be a positive integer');
  }
  if (!isValidSnapshotId(manifest.snapshotId)) {
    err('manifest-snapshot-id-invalid', `snapshotId must match ${SNAPSHOT_ID_RE}`);
  }
  if (typeof manifest.createdAt !== 'string' || manifest.createdAt.length === 0) {
    err('manifest-created-at-invalid', 'createdAt must be a non-empty string');
  }
  if (typeof manifest.reason !== 'string') {
    err('manifest-reason-invalid', "reason must be a string ('' if none)");
  }
  const target = manifest.targetClaudeDir;
  if (typeof target !== 'string' || target.length === 0) {
    err('manifest-target-invalid', 'targetClaudeDir must be a non-empty string');
  } else if (typeof expectedTarget === 'string' && expectedTarget.length > 0 && target !== expectedTarget) {
    err('manifest-target-mismatch',
      `manifest target ${JSON.stringify(target)} != expected ${JSON.stringify(expectedTarget)}; refusing cross-target use`);
  }
  verifyFiles(manifest.files, err);

  return { ok: !bag.hasErrors(), diagnostics: bag.all() };
}

/** Validate the files array + each FileRecord. Extracted to keep verify small. */
function verifyFiles(files, err) {
  if (!Array.isArray(files)) {
    err('manifest-files-invalid', 'files must be an array');
    return;
  }
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (!isObject(f)
      || typeof f.path !== 'string' || f.path.length === 0
      || typeof f.preSha256 !== 'string' || f.preSha256.length === 0
      || typeof f.currentSha256 !== 'string' || f.currentSha256.length === 0) {
      err('manifest-file-entry-invalid',
        `files[${i}] must be { path, preSha256, currentSha256 } non-empty strings`);
    }
  }
}
