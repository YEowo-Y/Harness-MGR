/**
 * Snapshot allowlist walker (P3.U5) — decides EXACTLY which files a snapshot
 * captures. This is a SECURITY-BOUNDARY module: an over-capture leaks secrets or
 * bloats the archive with `.mgr-state/**`; an under-capture means rollback can't
 * restore what was never saved. It therefore walks ONLY an allowlist and never
 * `readdir`s the whole target dir.
 *
 * Output is a RAW FILE LIST — no hashing, no compression, NO secrets filtering
 * (those are later units U6 secrets-filter / U7 tar / U8 orchestrator). Paths are
 * POSIX-relative to targetClaudeDir and SORTED ascending, so the list is byte-
 * stable across machines (a golden-file property).
 *
 * DEFENSE IN DEPTH: the allowlist/exclusion constants are defined LOCALLY here,
 * intentionally independent of discovery's KNOWN_TOP_DIRS classification — the
 * snapshot scope must not silently follow a change to discovery. Two belts:
 *   1. ALLOWLIST-DRIVEN — only WALK_DIRS + the named files/plugins JSON are ever
 *      visited; the target dir is never enumerated and filtered.
 *   2. EXCLUDE set — a SECOND filter applied to every candidate path, so even a
 *      future edit that broadens the allowlist can never emit `.mgr-state/**`,
 *      `.mgr/**`, `plugins/cache/**`, `plugins/marketplaces/**`, or any ephemeral
 *      top dir.
 *
 * Ops-layer constraint: imports only node:* stdlib and src/lib/**. Never follows
 * symlinks. Depth-guarded. Never throws — a bad root yields one `discover-bad-root`
 * diagnostic + empty files; per-dir/per-file errors degrade silently (mirrors
 * src/discovery/probe-state.mjs::collectDirFiles). Zero npm dependencies.
 *
 * Spec: plan "Snapshot Scope (v4 hardened)", lines 378-424.
 */

import { join, relative, sep } from 'node:path';
import { readdirSync, lstatSync } from 'node:fs';
import { DiagnosticBag } from '../lib/diagnostic.mjs';

/** @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic */

/**
 * Top-level dirs walked RECURSIVELY (every file under them is a candidate).
 * @type {readonly string[]}
 */
export const WALK_DIRS = Object.freeze(['agents', 'skills', 'commands', 'hooks', 'hud']);

/**
 * Top-level files captured only when present (POSIX-relative, no nesting).
 * @type {readonly string[]}
 */
export const TOP_FILES = Object.freeze([
  'settings.json', 'settings.local.json', '.mcp.json', 'CLAUDE.md',
]);

/**
 * Nested `plugins/` files captured only when present. The `plugins/` dir is NOT
 * walked recursively — only these two named JSON files are eligible, so
 * `plugins/cache/**` and `plugins/marketplaces/**` are never reached.
 * @type {readonly string[]}
 */
export const PLUGIN_FILES = Object.freeze([
  'plugins/installed_plugins.json', 'plugins/known_marketplaces.json',
]);

/**
 * EXPLICIT top-segment exclusions — the belt-and-suspenders second filter. Any
 * candidate whose FIRST path segment is in this set is NEVER emitted, even if a
 * future allowlist edit would otherwise include it. None of these overlap the
 * allowlist (WALK_DIRS / TOP_FILES / PLUGIN_FILES), so they only ever REMOVE.
 *
 * `.mgr-state` is added dynamically from the injectable `mgrStateDirname` so
 * self-exclusion is parameterized; the rest are the plan's exclusion list. NOTE:
 * `plans/` (a KNOWN_TOP_DIR) is listed here for EXPLICIT accounting + defense in
 * depth — user plan docs are not governed CC config and must never be snapshotted;
 * being allowlist-driven the walker would skip it regardless, but listing it keeps
 * "all 19 top dirs explicitly decided" true (drift-guard test).
 *
 * `plugins` is deliberately NOT here: the 2 named PLUGIN_FILES live directly under
 * it, so a whole-segment exclusion would wrongly drop them. `plugins/` is instead
 * excluded by simply never being walked (it is not in WALK_DIRS); its rebuildable
 * sub-trees are the prefix exclusions below.
 * @type {readonly string[]}
 */
export const EXCLUDE_TOP = Object.freeze([
  '.mgr', // .mgr-state appended per-call from mgrStateDirname
  'projects', 'sessions', 'session-env', 'backups', 'cache', 'debug',
  'downloads', 'file-history', 'paste-cache', 'shell-snapshots', 'tasks',
  'telemetry',
  'plans', // user plan docs — explicit accounting, not governed config
]);

/**
 * EXPLICIT path-PREFIX exclusions — the plan's `plugins/cache/**` +
 * `plugins/marketplaces/**` (rebuildable caches / catalog clones). A candidate
 * whose POSIX path starts with one of these prefixes is NEVER emitted. These are
 * a second belt under "plugins/ is never walked": the only files reaching the
 * filter from plugins/ are the 2 named PLUGIN_FILES, but if a future edit ever
 * walked plugins/, these prefixes still keep cache/marketplaces out.
 * @type {readonly string[]}
 */
export const EXCLUDE_PREFIXES = Object.freeze([
  'plugins/cache/', 'plugins/marketplaces/',
]);

/** Maximum recursion depth for directory walks (matches probe-state.mjs). */
const WALK_MAX_DEPTH = 64;

/** Default self-exclusion dir; injectable via walkSnapshotScope opts. */
const DEFAULT_MGR_STATE_DIRNAME = '.mgr-state';

/**
 * @typedef {Object} SnapshotWalkResult
 * @property {string[]} files        POSIX-relative paths (to targetClaudeDir),
 *                                   sorted ascending — deterministic golden output
 * @property {Diagnostic[]} diagnostics
 */

/**
 * Convert an absolute path to a POSIX-style relative path (forward slashes,
 * OS-stable) from configDir. Mirrors probe-state.mjs::toPosixRel.
 * @param {string} configDir
 * @param {string} absPath
 * @returns {string}
 */
function toPosixRel(configDir, absPath) {
  return relative(configDir, absPath).split(sep).join('/');
}

/**
 * True when a POSIX-relative path is excluded — either its FIRST segment is an
 * excluded top dir, or it starts with an excluded path prefix (plugins/cache/,
 * plugins/marketplaces/). The belt-and-suspenders filter applied to every emitted
 * candidate.
 * @param {string} rel
 * @param {Set<string>} excludeSet  top-segment exclusions
 * @returns {boolean}
 */
function isExcluded(rel, excludeSet) {
  const first = rel.split('/', 1)[0];
  if (excludeSet.has(first)) return true;
  for (const prefix of EXCLUDE_PREFIXES) {
    if (rel.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * Recursively collect file paths under `dir`, pushing POSIX-relative paths into
 * `out`. Never follows symlinks (checked BEFORE descending). Depth-guarded. Any
 * readdir error silently stops that branch (ENOENT/EACCES etc. are benign).
 * Excluded candidates are skipped.
 *
 * NOTE: `out` is a plain ARRAY, not a path-keyed object, so there is no
 * prototype-poisoning vector here (unlike probe-state.mjs which does `files[rel] =
 * h`). A file literally named `__proto__` is captured verbatim as e.g.
 * `agents/__proto__` — harmless as an array element.
 *
 * @param {string} dir          absolute path to walk
 * @param {string} configDir    root used for relative-path computation
 * @param {string[]} out        accumulator (mutated in place)
 * @param {Set<string>} excludeSet
 * @param {number} [depth]
 */
function collectDirFiles(dir, configDir, out, excludeSet, depth = 0) {
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
      collectDirFiles(abs, configDir, out, excludeSet, depth + 1);
    } else if (ent.isFile()) {
      const rel = toPosixRel(configDir, abs);
      if (isExcluded(rel, excludeSet)) continue; // second belt: never emit excluded
      out.push(rel);
    }
  }
}

/**
 * Add a single named file (top-level or nested) to `out` only when it exists as a
 * regular, NON-symlink file. The exclude filter still applies (a named file under
 * an excluded top dir is refused). Uses lstatSync (not statSync) so a symlinked
 * settings.json is NOT captured — consistent with the walk's never-follow-symlink
 * invariant. Errors (ENOENT/EACCES) degrade silently → file simply not captured.
 * @param {string} configDir
 * @param {string} rel          POSIX-relative candidate
 * @param {string[]} out
 * @param {Set<string>} excludeSet
 */
function addFileIfPresent(configDir, rel, out, excludeSet) {
  if (isExcluded(rel, excludeSet)) return; // belt-and-suspenders
  const abs = join(configDir, ...rel.split('/'));
  try {
    const st = lstatSync(abs);
    if (st.isFile()) out.push(rel); // lstat: a symlink is isSymbolicLink(), not isFile()
  } catch {
    // absent / unreadable — file simply not captured
  }
}

/**
 * Walk the snapshot allowlist scope of `targetClaudeDir` and return the sorted,
 * POSIX-relative list of files to capture. Pure data-collection; never throws.
 *
 * @param {object} opts
 * @param {string} opts.targetClaudeDir              absolute path to the governed dir
 * @param {string} [opts.mgrStateDirname='.mgr-state'] self-exclusion dir name
 * @returns {SnapshotWalkResult}
 */
export function walkSnapshotScope(opts) {
  const bag = new DiagnosticBag();
  const { targetClaudeDir, mgrStateDirname = DEFAULT_MGR_STATE_DIRNAME } = opts ?? {};

  if (typeof targetClaudeDir !== 'string' || targetClaudeDir.length === 0) {
    bag.add({
      severity: 'error', code: 'discover-bad-root',
      message: 'targetClaudeDir must be a non-empty string', phase: 'snapshot-walk',
    });
    return { files: [], diagnostics: bag.all() };
  }

  // Exclusion set = the static top-dir list + the (parameterized) self-exclusion.
  const stateDir = typeof mgrStateDirname === 'string' && mgrStateDirname.length > 0
    ? mgrStateDirname : DEFAULT_MGR_STATE_DIRNAME;
  const excludeSet = new Set([...EXCLUDE_TOP, stateDir]);

  /** @type {string[]} */
  const out = [];

  // 1. Recursively walk each allowlisted dir. Guard the ROOT against symlinks
  //    BEFORE recursing: collectDirFiles only checks dir ENTRIES, so a symlinked
  //    WALK_DIR root (e.g. skills/ or hooks/ being a directory symlink) would
  //    otherwise have its TARGET enumerated by readdirSync — escaping the governed
  //    tree (secret leak) or pointing back at .mgr-state (recursive snapshot bloat).
  //    lstatSync reports the symlink itself (isSymbolicLink()===true) without
  //    following it; a real dir is false, so normal roots are never over-rejected.
  for (const name of WALK_DIRS) {
    const abs = join(targetClaudeDir, name);
    try {
      if (lstatSync(abs).isSymbolicLink()) continue; // never follow a symlinked root
    } catch {
      continue; // absent / unreadable root — benign, simply nothing to capture
    }
    collectDirFiles(abs, targetClaudeDir, out, excludeSet, 0);
  }
  // 2. Top-level named files (present-only).
  for (const rel of TOP_FILES) addFileIfPresent(targetClaudeDir, rel, out, excludeSet);
  // 3. The two named plugins JSON files (present-only); plugins/ is otherwise excluded.
  for (const rel of PLUGIN_FILES) addFileIfPresent(targetClaudeDir, rel, out, excludeSet);

  // Sort ascending → byte-stable golden output. De-dup defensively (a name can't
  // be added twice by construction, but keep the contract explicit).
  out.sort();
  const files = dedupeSorted(out);

  return { files, diagnostics: bag.all() };
}

/**
 * De-duplicate an already-sorted array (adjacent equals only). Cheap + keeps the
 * output a strict set without a second pass over a Set (preserves sort order).
 * @param {string[]} sorted
 * @returns {string[]}
 */
function dedupeSorted(sorted) {
  /** @type {string[]} */
  const out = [];
  for (let i = 0; i < sorted.length; i++) {
    if (i === 0 || sorted[i] !== sorted[i - 1]) out.push(sorted[i]);
  }
  return out;
}
