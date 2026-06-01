/**
 * Filesystem passive probe gatherer (P2.U6b).
 *
 * Performs the read-only I/O behind five doctor checks — keeping the doctor
 * itself pure (no I/O) by gathering facts here in the discovery layer:
 *
 *   #13 claude-md-backup-bloat   — count CLAUDE.md.backup.* files in configDir
 *   #14 snapshot-retention       — list <mgrStateDir>/snapshots with mtime
 *   #20 probe-residue            — find __mgr-probe-* leftover files
 *   #21 apply-leftover-files     — find *.mgr-new / *.mgr-old leftover files
 *   #25 config-rules-stale       — mtime of docs/effective-config-rules.md
 *
 * Never throws. Degrades to diagnostics on missing/bad configDir; individual
 * readdir/stat failures degrade silently to empty (a missing agents/ or
 * .mgr-state/ dir is benign and expected).
 * Zero npm dependencies. Node stdlib only.
 */

import { join } from 'node:path';
import { readdirSync, statSync, lstatSync } from 'node:fs';
import { DiagnosticBag } from '../lib/diagnostic.mjs';

/**
 * @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic
 */

/**
 * @typedef {Object} FsFacts
 * @property {{ count: number, files: string[] }} claudeMdBackups   #13: CLAUDE.md.backup.* in configDir
 * @property {Array<{ path: string, mtimeMs: number }>} snapshots   #14: entries in <mgrStateDir>/snapshots
 * @property {string[]} probeResidue                                #20: __mgr-probe-* leftovers
 * @property {string[]} applyLeftovers                              #21: *.mgr-new / *.mgr-old leftovers
 * @property {{ path: string, mtimeMs: number } | null} configRulesDoc  #25: mtime of rulesDocPath
 * @property {{ path: string, bytes: number } | null} diskUsage   #16: recursive byte size of mgrStateDir
 */

/**
 * Read directory entries, returning an empty array on any error (ENOENT, EACCES, etc.).
 * @param {string} dir
 * @returns {string[]}
 */
function safeReaddir(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * Stat a path and return its mtimeMs, or null on any error.
 * @param {string} path
 * @returns {number | null}
 */
function safeStatMtime(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Recursively sum the byte size of a directory tree, never following symlinks.
 * Depth-guarded at 64 to prevent infinite loops on adversarial inputs.
 * Any I/O error on a single entry is silently skipped (degrade-gracefully).
 * @param {string} dir
 * @param {number} [depth]
 * @returns {number}
 */
function safeDirSize(dir, depth = 0) {
  if (depth >= 64) return 0;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  let total = 0;
  for (const ent of entries) {
    if (ent.isSymbolicLink()) continue;            // never follow symlinks
    const p = join(dir, ent.name);
    if (ent.isDirectory()) total += safeDirSize(p, depth + 1);
    else if (ent.isFile()) { try { const s = statSync(p).size; if (Number.isFinite(s)) total += s; } catch { /* skip */ } }
  }
  return total;
}

/** Sidecar suffixes left by the atomic-write primitive (atomic-write.mjs). */
const LEFTOVER_SUFFIXES = ['.mgr-new', '.mgr-old'];

/** Is `name` a `.mgr-new` / `.mgr-old` atomic-write sidecar? */
function isLeftover(name) {
  return LEFTOVER_SUFFIXES.some((s) => name.endsWith(s));
}

/**
 * Rollback-writable content subdirs (paths.mjs rollback-only surface) where a
 * catastrophic atomicApplyWrite double-failure can strand NESTED
 * `<target>.mgr-new` / `<target>.mgr-old` sidecars (e.g. agents/foo.md.mgr-old).
 */
const ROLLBACK_CONTENT_DIRS = ['agents', 'skills', 'commands', 'hooks'];

/**
 * Recursively collect `.mgr-new` / `.mgr-old` sidecar paths under a directory
 * tree, never following symlinks. Depth-guarded at 64 like safeDirSize.
 * Any I/O error on a single dir is silently skipped (degrade-gracefully);
 * never throws — a bad subdir contributes nothing.
 * @param {string} dir
 * @param {number} [depth]
 * @returns {string[]}
 */
function collectNestedLeftovers(dir, depth = 0) {
  if (depth >= 64) return [];
  // Never follow a symlinked dir — INCLUDING a symlinked content-dir ROOT
  // (agents/skills/commands/hooks itself a symlink). Entry-level symlinks are
  // skipped in the loop below; this guards the root the caller hands us, the
  // same defect class that was a BLOCKER in snapshot-walk (P3.U5).
  try { if (lstatSync(dir).isSymbolicLink()) return []; } catch { return []; }
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const found = [];
  for (const ent of entries) {
    if (ent.isSymbolicLink()) continue;            // never follow/descend symlinks
    const p = join(dir, ent.name);
    if (ent.isDirectory()) found.push(...collectNestedLeftovers(p, depth + 1));
    else if (ent.isFile() && isLeftover(ent.name)) found.push(p);
  }
  return found;
}

/**
 * The empty FsFacts value returned when configDir is bad.
 * @returns {FsFacts}
 */
function emptyFacts() {
  return {
    claudeMdBackups: { count: 0, files: [] },
    snapshots: [],
    probeResidue: [],
    applyLeftovers: [],
    configRulesDoc: null,
    diskUsage: null,
  };
}

/**
 * Gather passive filesystem probe facts for the doctor layer.
 *
 * @param {{ configDir?: string, mgrStateDir?: string, rulesDocPath?: string }} opts
 * @returns {{ fsFacts: FsFacts, diagnostics: Diagnostic[] }}
 */
export function gatherFsProbes(opts) {
  const bag = new DiagnosticBag();
  const { configDir, mgrStateDir: rawMgrStateDir, rulesDocPath } = opts ?? {};

  if (typeof configDir !== 'string' || configDir.length === 0) {
    bag.add({ severity: 'error', code: 'discover-bad-root', message: 'configDir must be a non-empty string', phase: 'fs-probe' });
    return { fsFacts: emptyFacts(), diagnostics: bag.all() };
  }

  const mgrStateDir = typeof rawMgrStateDir === 'string' && rawMgrStateDir.length > 0
    ? rawMgrStateDir
    : join(configDir, '.mgr-state');

  // #13: CLAUDE.md.backup.* in configDir (non-recursive)
  const backupPrefix = 'CLAUDE.md.backup.';
  const configEntries = safeReaddir(configDir);
  const backupFiles = configEntries
    .filter((name) => name.startsWith(backupPrefix))
    .map((name) => join(configDir, name));
  const claudeMdBackups = { count: backupFiles.length, files: backupFiles };

  // #14: snapshots in <mgrStateDir>/snapshots
  const snapshotsDir = join(mgrStateDir, 'snapshots');
  const snapshotEntries = safeReaddir(snapshotsDir);
  /** @type {Array<{ path: string, mtimeMs: number }>} */
  const snapshots = [];
  for (const name of snapshotEntries) {
    const p = join(snapshotsDir, name);
    const mtimeMs = safeStatMtime(p);
    if (mtimeMs !== null) {
      snapshots.push({ path: p, mtimeMs });
    }
  }

  // #20: __mgr-probe-* leftovers in configDir and configDir/agents (non-recursive)
  const probePrefix = '__mgr-probe-';
  const agentsDir = join(configDir, 'agents');
  const agentEntries = safeReaddir(agentsDir);
  const probeResidue = [
    ...configEntries.filter((name) => name.startsWith(probePrefix)).map((name) => join(configDir, name)),
    ...agentEntries.filter((name) => name.startsWith(probePrefix)).map((name) => join(agentsDir, name)),
  ];

  // #21: *.mgr-new / *.mgr-old leftovers. Root-level configDir + mgrStateDir scans
  // (non-recursive), PLUS a recursive walk of the rollback-writable content subdirs
  // (agents/skills/commands/hooks) where rollback restore strands NESTED sidecars
  // such as agents/foo.md.mgr-old (symlink-never-follow, depth-guarded, never-throws).
  const mgrStateEntries = safeReaddir(mgrStateDir);
  const nestedLeftovers = ROLLBACK_CONTENT_DIRS.flatMap(
    (sub) => collectNestedLeftovers(join(configDir, sub)),
  );
  const applyLeftovers = [
    ...configEntries.filter(isLeftover).map((name) => join(configDir, name)),
    ...mgrStateEntries.filter(isLeftover).map((name) => join(mgrStateDir, name)),
    ...nestedLeftovers,
  ];

  // #25: mtime of rulesDocPath
  let configRulesDoc = null;
  if (typeof rulesDocPath === 'string' && rulesDocPath.length > 0) {
    const mtimeMs = safeStatMtime(rulesDocPath);
    if (mtimeMs !== null) {
      configRulesDoc = { path: rulesDocPath, mtimeMs };
    }
  }

  const diskUsage = { path: mgrStateDir, bytes: safeDirSize(mgrStateDir) };

  return {
    fsFacts: { claudeMdBackups, snapshots, probeResidue, applyLeftovers, configRulesDoc, diskUsage },
    diagnostics: bag.all(),
  };
}
