/**
 * Post-hoc sha256 spawned-write boundary check (Unit B / P3.U5 prereq).
 *
 * A DETECTIVE control backing the threat-model §5.7 / §6 promise: after a
 * spawned process (tar/git/claude-mcp) runs, compare a directory snapshot taken
 * before vs. after and flag any path that was added, removed, or modified
 * WITHOUT being declared in the spawn's `declaredWrites` allowlist.
 *
 * Two exports:
 *   snapshotDirHashes(dir, opts?)   → { [posixRelPath]: sha256hex }
 *   checkSpawnWriteBoundary({before, after, declaredWrites})
 *                                   → { ok: boolean, diagnostics: Diagnostic[] }
 *
 * Both are PURE / never-throw.  No outside state, no npm dependencies.
 * Mirrors probe-state.mjs's walk logic exactly: symlink-never-follow,
 * depth-guarded, proto-poisoning-guarded, unreadable entries omitted.
 *
 * Zero npm dependencies.  node:fs + node:path + node:crypto only.
 */

import { join, relative, sep } from 'node:path';
import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

/** @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic */

/** Maximum recursion depth for directory walks. Mirrors probe-state.mjs. */
const WALK_MAX_DEPTH = 64;

// ── private helpers ────────────────────────────────────────────────────────

/**
 * Compute sha256 hex over a Buffer.
 * @param {Buffer} buf
 * @returns {string}
 */
function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Read a file as raw bytes and return its sha256 hex. Returns null on any
 * error — never throws. Unreadable entries are silently omitted from the map.
 * @param {string} absPath
 * @returns {string|null}
 */
function hashFileSync(absPath) {
  try {
    const buf = readFileSync(absPath); // no encoding → Buffer (BOM-stable)
    return sha256Hex(buf);
  } catch {
    return null;
  }
}

/**
 * Convert an absolute file path to a POSIX-style relative path (forward
 * slashes) from `root`.
 * @param {string} root
 * @param {string} absPath
 * @returns {string}
 */
function toPosixRel(root, absPath) {
  return relative(root, absPath).split(sep).join('/');
}

/**
 * Recursively collect file hashes from `dir`, populating `files`.
 * Never follows symlinks. Depth-guarded at WALK_MAX_DEPTH.
 * Any readdir error silently stops that branch.
 *
 * @param {string} dir
 * @param {string} root   root used for relative-path computation
 * @param {Object<string,string>} files   accumulator (mutated in-place)
 * @param {number} [depth]
 */
function collectDirFiles(dir, root, files, depth = 0) {
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
      collectDirFiles(abs, root, files, depth + 1);
    } else if (ent.isFile()) {
      const rel = toPosixRel(root, abs);
      // Guard against prototype-poisoning keys.
      if (rel === '__proto__' || rel === 'constructor' || rel === 'prototype') continue;
      const h = hashFileSync(abs);
      if (h !== null) files[rel] = h;
    }
  }
}

// ── exported API ───────────────────────────────────────────────────────────

/**
 * Snapshot all regular files in `dir` as a POSIX-relative-path → sha256hex
 * map.  Never follows symlinks.  Depth-guarded.  Proto-poisoning keys skipped.
 * Unreadable entries omitted (best-effort).
 *
 * Returns `{}` on a bad, missing, or non-string `dir` — never throws.
 *
 * @param {string} dir   absolute path to the directory root to snapshot
 * @param {object} [_opts]   reserved for future injectable seams; ignored now
 * @returns {Object<string,string>}
 */
export function snapshotDirHashes(dir, _opts) {
  if (typeof dir !== 'string' || dir.length === 0) return {};
  /** @type {Object<string,string>} */
  const files = Object.create(null);
  collectDirFiles(dir, dir, files, 0);
  return files;
}

/**
 * Determine whether a key is safe to iterate on a hash-like object (guards
 * against prototype-poisoning attacks on the snapshot maps).
 * @param {object} obj
 * @param {string} key
 * @returns {boolean}
 */
function safeHas(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/**
 * Compare `before` and `after` directory snapshots and flag any file that was
 * added, removed, or modified without appearing in `declaredWrites`.
 *
 * - A change to a DECLARED path produces no diagnostic.
 * - `declaredWrites` is an array of POSIX-relative paths.
 * - Non-object `before`/`after` and non-array `declaredWrites` are treated as
 *   empty without throwing.
 * - Diagnostics are sorted by path for stable output.
 *
 * Never throws.
 *
 * @param {{
 *   before?: Object<string,string>,
 *   after?: Object<string,string>,
 *   declaredWrites?: string[]
 * }} opts
 * @returns {{ ok: boolean, diagnostics: Diagnostic[] }}
 */
export function checkSpawnWriteBoundary({ before, after, declaredWrites } = {}) {
  /** @type {Diagnostic[]} */
  const diags = [];

  // Tolerate non-object inputs.
  const b = (before !== null && typeof before === 'object') ? before : {};
  const a = (after  !== null && typeof after  === 'object') ? after  : {};
  const declared = new Set(Array.isArray(declaredWrites) ? declaredWrites : []);

  // Collect all paths from both maps (proto-safe).
  const allPaths = new Set();
  for (const k in b) { if (safeHas(b, k)) allPaths.add(k); }
  for (const k in a) { if (safeHas(a, k)) allPaths.add(k); }

  // Evaluate each path for undeclared change.
  const offenders = [];
  for (const rel of allPaths) {
    if (declared.has(rel)) continue; // declared — skip regardless of change
    const inBefore = safeHas(b, rel);
    const inAfter  = safeHas(a, rel);
    let kind;
    if (!inBefore && inAfter) {
      kind = 'added';
    } else if (inBefore && !inAfter) {
      kind = 'removed';
    } else if (inBefore && inAfter && b[rel] !== a[rel]) {
      kind = 'modified';
    } else {
      continue; // unchanged — no diagnostic
    }
    offenders.push({ rel, kind });
  }

  // Sort by path for deterministic output.
  offenders.sort((x, y) => (x.rel < y.rel ? -1 : x.rel > y.rel ? 1 : 0));

  for (const { rel, kind } of offenders) {
    diags.push({
      severity: 'error',
      code: 'spawn-write-outside-expected',
      message: `spawned process ${kind} undeclared path: ${rel}`,
      path: rel,
      phase: 'boundary',
    });
  }

  return { ok: diags.length === 0, diagnostics: diags };
}
