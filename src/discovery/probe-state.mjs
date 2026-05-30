/**
 * State probe gatherer (P2.U9) — hash-based drift detection I/O.
 *
 * Gathers a TrackedState fingerprint of the governed config surface (selected
 * top-level files + TRACKED_DIRS walked recursively) and persists it to
 * <mgrStateDir>/lockfile.json. On a later run, readLockfile() retrieves the
 * prior state; analyzeDrift() (pure, in src/analysis/drift.mjs) then compares.
 *
 * Per the pure/IO split ([[feedback-pure-analysis-split]]):
 *   - ALL file I/O lives here in the discovery layer.
 *   - src/analysis/drift.mjs is PURE — no fs/crypto/paths imports.
 *
 * NOTE: .mgr-state is a top-level sibling of the tracked dirs, and LOCKFILE_NAME
 * lives there. Since TRACKED_DIRS does not include .mgr-state, the walk never
 * hashes our own lockfile (no infinite recursion).
 *
 * Never throws. Degrades to diagnostics on bad configDir or I/O errors.
 * Zero npm dependencies. Node stdlib only.
 */

import { join, relative, sep } from 'node:path';
import { readdirSync, readFileSync, mkdirSync, writeFileSync, lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { DiagnosticBag } from '../lib/diagnostic.mjs';
import { assertWritable } from '../paths.mjs';
import { readJsonFile, isJsonObject } from './read-json.mjs';
import { stableStringify } from '../output/json.mjs';

/** @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic */

/** Schema version persisted to lockfile.json. Bump on a breaking shape change. */
const STATE_VERSION = 1;

/** Lockfile filename within mgrStateDir. */
const LOCKFILE_NAME = 'lockfile.json';

/** Top-level files in configDir to hash (only when present). */
const TRACKED_FILES = ['CLAUDE.md', 'settings.json', 'settings.local.json'];

/** Top-level dirs to walk recursively for hashing. */
const TRACKED_DIRS = ['skills', 'agents', 'commands', 'hooks'];

/** Maximum recursion depth for directory walks. */
const WALK_MAX_DEPTH = 64;

/**
 * @typedef {Object} TrackedState
 * @property {number} version           schema version
 * @property {string} targetClaudeDir   config dir that was snapshotted
 * @property {Object<string,string>} files  POSIX-relative path → sha256 hex
 * @property {string} fingerprint       sha256 hex over stableStringify(files)
 */

/**
 * Compute sha256 hex over a Buffer.
 * @param {Buffer} buf
 * @returns {string}
 */
function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Read a file as raw bytes and return its sha256 hex. Returns null on any error
 * (ENOENT, EACCES, etc.) — never throws.
 *
 * NOTE: a tracked file that is unreadable (locked, EACCES, or deleted mid-walk)
 * returns null and is therefore OMITTED from the files map. On a later diff that
 * absence reads as a 'removed' change — i.e. a transiently-unreadable file can
 * surface as a (spurious) drift. This is intentional best-effort: we never block
 * or throw on a single bad file. analyzeDrift cannot distinguish "deleted" from
 * "unreadable", so the user should treat an unexpected 'removed' as "verify the
 * file is still readable" before assuming it was deleted.
 * @param {string} absPath
 * @returns {string|null}
 */
function hashFileSync(absPath) {
  try {
    const buf = readFileSync(absPath); // no encoding → Buffer (binary-safe, BOM-stable)
    return sha256Hex(buf);
  } catch {
    return null;
  }
}

/**
 * Convert an absolute file path to a POSIX-style relative path (forward slashes,
 * OS-stable) from configDir.
 * @param {string} configDir
 * @param {string} absPath
 * @returns {string}
 */
function toPosixRel(configDir, absPath) {
  return relative(configDir, absPath).split(sep).join('/');
}

/**
 * Recursively collect file hashes from a directory, populating `files`.
 * Never follows symlinks. Depth-guarded at WALK_MAX_DEPTH. Any readdir error
 * silently stops that branch (ENOENT/EACCES etc. are benign).
 *
 * @param {string} dir         absolute path to walk
 * @param {string} configDir   root used for relative-path computation
 * @param {Object<string,string>} files  accumulator (mutated in-place)
 * @param {number} [depth]
 */
function collectDirFiles(dir, configDir, files, depth = 0) {
  if (depth >= WALK_MAX_DEPTH) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // ENOENT, EACCES, etc. — benign
  }
  for (const ent of entries) {
    if (ent.isSymbolicLink()) continue; // never follow symlinks
    const abs = join(dir, ent.name);
    if (ent.isDirectory()) {
      collectDirFiles(abs, configDir, files, depth + 1);
    } else if (ent.isFile()) {
      const rel = toPosixRel(configDir, abs);
      // Guard against prototype-poisoning keys.
      if (rel === '__proto__' || rel === 'constructor' || rel === 'prototype') continue;
      const h = hashFileSync(abs);
      if (h !== null) files[rel] = h;
    }
  }
}

/**
 * Build the empty TrackedState returned when configDir is bad.
 * @param {string} configDir
 * @returns {TrackedState}
 */
function emptyState(configDir) {
  return {
    version: STATE_VERSION,
    targetClaudeDir: configDir,
    files: {},
    fingerprint: sha256Hex(Buffer.from(stableStringify({}))),
  };
}

/**
 * Gather the current TrackedState by hashing TRACKED_FILES and walking TRACKED_DIRS.
 *
 * Per-file hash failures and per-directory walk failures degrade SILENTLY (no
 * diagnostic) — mirroring probe-fs.mjs's "individual readdir/stat failures
 * degrade silently" convention — so the success-path `diagnostics` is always [].
 * An unreadable tracked file is simply absent from `files` (see hashFileSync).
 * The ONLY diagnostic this function emits is `discover-bad-root` for a bad configDir.
 *
 * @param {{ configDir?: string }} [opts]
 * @returns {{ state: TrackedState, diagnostics: Diagnostic[] }}
 */
export function gatherTrackedState(opts) {
  const bag = new DiagnosticBag();
  const { configDir } = opts ?? {};

  if (typeof configDir !== 'string' || configDir.length === 0) {
    bag.add({ severity: 'error', code: 'discover-bad-root', message: 'configDir must be a non-empty string', phase: 'state-probe' });
    return { state: emptyState(''), diagnostics: bag.all() };
  }

  const files = {};

  // Hash the top-level tracked files (skip when absent — null return from hashFileSync).
  for (const name of TRACKED_FILES) {
    const h = hashFileSync(join(configDir, name));
    if (h !== null) files[name] = h;
  }

  // Recursively hash each tracked directory. Guard the ROOT against symlinks
  // BEFORE walking: collectDirFiles only checks dir ENTRIES, so a symlinked
  // TRACKED_DIRS root (e.g. skills/ being a directory symlink pointing OUTSIDE the
  // governed tree) would otherwise have its TARGET enumerated by readdirSync —
  // hashing out-of-tree files into the drift fingerprint + lockfile. lstatSync
  // reports the symlink itself without following it; a real dir is false, so normal
  // roots are never over-rejected. Mirrors snapshot-walk.mjs's root guard
  // (follow-up #7). (A Windows junction — not a symlink — is a separate vector the
  // realpath-gated WRITE path covers; drift hashing here is read-only.)
  for (const name of TRACKED_DIRS) {
    const abs = join(configDir, name);
    try {
      if (lstatSync(abs).isSymbolicLink()) continue; // never follow a symlinked root
    } catch {
      continue; // absent / unreadable root — benign, nothing to hash
    }
    collectDirFiles(abs, configDir, files, 0);
  }

  const fingerprint = sha256Hex(Buffer.from(stableStringify(files)));

  return {
    state: { version: STATE_VERSION, targetClaudeDir: configDir, files, fingerprint },
    diagnostics: [],
  };
}

/**
 * Read the persisted lockfile from mgrStateDir. Returns null on first run
 * (missing is benign). Never throws.
 *
 * @param {string} stateDir   absolute path to the mgr state dir
 * @param {{ readJsonFn?: function }} [opts]
 * @returns {{ lockfile: object|null, diagnostics: Diagnostic[] }}
 */
export function readLockfile(stateDir, opts) {
  const { readJsonFn = readJsonFile } = opts ?? {};
  const path = join(stateDir, LOCKFILE_NAME);
  const { value, error, missing } = readJsonFn(path);

  if (missing) return { lockfile: null, diagnostics: [] };
  if (error) {
    return {
      lockfile: null,
      diagnostics: [{ severity: 'warn', code: 'lockfile-unreadable', message: error, path, phase: 'state-probe' }],
    };
  }
  if (!isJsonObject(value)) {
    return {
      lockfile: null,
      diagnostics: [{ severity: 'warn', code: 'lockfile-malformed', message: 'lockfile.json is not a JSON object', path, phase: 'state-probe' }],
    };
  }
  return { lockfile: value, diagnostics: [] };
}

/**
 * Write the current TrackedState as a lockfile to mgrStateDir. Creates the dir
 * if absent (mkdirSync recursive). Uses assertWritable with the default 'apply'
 * context — assertWritable's .mgr-state passthrough permits this without a special
 * context flag.
 *
 * @param {string} stateDir   absolute path to the mgr state dir
 * @param {TrackedState} state
 * @param {{
 *   assertWritableFn?: (p: string) => string,
 *   mkdirFn?: (d: string) => void,
 *   writeFn?: (p: string, c: string) => void,
 *   now?: () => string
 * }} [opts]
 * @returns {{ path: string, diagnostics: Diagnostic[] }}
 */
export function writeLockfile(stateDir, state, opts) {
  const {
    assertWritableFn = assertWritable,
    mkdirFn = (d) => mkdirSync(d, { recursive: true }),
    writeFn = (p, c) => writeFileSync(p, c, 'utf8'),
    now = () => new Date().toISOString(),
  } = opts ?? {};

  const path = join(stateDir, LOCKFILE_NAME);

  try {
    assertWritableFn(path);
    const record = {
      version: STATE_VERSION,
      generatedAt: now(),
      targetClaudeDir: state?.targetClaudeDir ?? '',
      fingerprint: state?.fingerprint ?? '',
      files: state?.files ?? {},
    };
    mkdirFn(stateDir);
    writeFn(path, stableStringify(record));
    return { path, diagnostics: [] };
  } catch (err) {
    return {
      path,
      diagnostics: [{ severity: 'warn', code: 'lockfile-write-failed', message: err && err.message ? err.message : String(err), path, phase: 'state-probe' }],
    };
  }
}
