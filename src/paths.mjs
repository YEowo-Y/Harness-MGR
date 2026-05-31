/**
 * Three-root path vocabulary for claude-mgr + the write-allowlist gate.
 *
 * Per plan: paths.mjs establishes a THREE-ROOT vocabulary and DELEGATES to the
 * reexported getClaudeConfigDir() — it must NEVER reimplement config-dir logic.
 *
 *   1. mgrInstallDir   — where claude-mgr's own code lives (the package root).
 *                        Resolved from import.meta.url (clarification #4): this
 *                        file is <root>/src/paths.mjs, so the root is its grandparent.
 *   2. targetClaudeDir — the ~/.claude being governed (the SUBJECT of the CLI).
 *                        This is the ONLY root that varies with CLAUDE_CONFIG_DIR,
 *                        and it comes straight from the borrowed resolver.
 *   3. mgrStateDir     — where claude-mgr keeps ITS OWN state (snapshots, logs,
 *                        STABILITY-LOG). This is <targetClaudeDir>/.mgr-state.
 *                        Canonical name is the exported MGR_STATE_DIRNAME constant
 *                        (single source of truth for the 13 downstream refs to this
 *                        dir: snapshot capture, doctor #24 ACL check, lockfile path,
 *                        etc.). NOT inside mgrInstallDir — state travels with the
 *                        config it describes. The self-exclusion invariant (snapshots
 *                        must never capture .mgr-state itself to prevent recursive
 *                        bloat) is enforced via the assertWritable allowlist and
 *                        the snapshot walker's explicit skip of this dir.
 *
 * --- Async-shim note ---
 * Re-export is async (top-level await in reexport.mjs), so importing this module
 * is also async. That is by design (clarification #2).
 *
 * Zero npm dependencies.
 */

import { basename, dirname, join, resolve, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';

// Re-export the borrowed resolver so callers get it through paths.mjs too,
// reinforcing "one source of truth for config-dir". (reexport BEFORE paths:
// clarification #3 — paths imports reexport, so the shim must load first.)
import { getClaudeConfigDir } from './lib/reexport.mjs';
export { getClaudeConfigDir };

/** A loader-probe artifact filename: __mgr-probe-<uuid>.md. The ONLY name the
 *  'probe' write context permits in agents/. */
const PROBE_NAME_RE = /^__mgr-probe-[0-9a-f-]+\.md$/i;

/**
 * The governed settings files writable in BOTH 'apply' and 'rollback' contexts,
 * each ONLY when placed DIRECTLY under the governed config dir (NOT nested).
 * Single source of truth — plan line 432 ("Forbidden vs Rollback-Writable",
 * the "Always writable (with --apply)" row). Matched by EXACT basename.
 * @type {ReadonlyArray<string>}
 */
export const APPLY_WRITABLE_FILES = Object.freeze(['settings.json', 'settings.local.json', '.mcp.json']);

/**
 * Canonical dir name for claude-mgr's own state. SINGLE SOURCE OF TRUTH:
 * snapshot capture, the snapshot self-exclusion invariant, doctor #24 ACL check,
 * and the lockfile path all import this so the literal can never drift.
 * (Corrected from an earlier `.claude-mgr` per P1.U2–U5 code-review H1.)
 */
export const MGR_STATE_DIRNAME = '.mgr-state';

/**
 * @typedef {Object} Roots
 * @property {string} mgrInstallDir
 * @property {string} targetClaudeDir
 * @property {string} mgrStateDir
 */

/**
 * @typedef {'apply'|'rollback'|'probe'} WriteContext
 *   - 'apply'    — normal apply operation (default)
 *   - 'rollback' — snapshot restore: may write to governed content surfaces
 *   - 'probe'    — transient loader-probe artifact: ONLY agents/__mgr-probe-<uuid>.md
 */

/**
 * The package root: this file is at <root>/src/paths.mjs, so go up one level.
 * @returns {string}
 */
export function mgrInstallDir() {
  const here = fileURLToPath(import.meta.url); // <root>/src/paths.mjs
  return resolve(dirname(here), '..');
}

/**
 * The ~/.claude under governance. DELEGATES to the borrowed resolver — this is
 * the single place CLAUDE_CONFIG_DIR is honored. No reimplementation.
 * @returns {string}
 */
export function targetClaudeDir() {
  return getClaudeConfigDir();
}

/**
 * claude-mgr's own state dir, under the governed config dir.
 * @param {string} [target] override target (defaults to targetClaudeDir())
 * @returns {string}
 */
export function mgrStateDir(target) {
  return join(target ?? targetClaudeDir(), MGR_STATE_DIRNAME);
}

/**
 * Resolve all three roots at once.
 * @returns {Roots}
 */
export function resolveRoots() {
  const target = targetClaudeDir();
  return {
    mgrInstallDir: mgrInstallDir(),
    targetClaudeDir: target,
    mgrStateDir: mgrStateDir(target),
  };
}

/**
 * Error thrown when a write target violates the allowlist.
 */
export class WriteForbiddenError extends Error {
  /** @param {string} message @param {string} code */
  constructor(message, code) {
    super(message);
    this.name = 'WriteForbiddenError';
    this.code = code;
  }
}

/**
 * Normalize a path for prefix comparison: resolve symlinks where possible
 * (security L1 — resolve via realpathSync BEFORE the allowlist check so a
 * symlink cannot escape the allowlist), then lowercase-normalize on Windows
 * where the filesystem is case-insensitive. Falls back to a plain resolve when
 * the path does not yet exist (the common case for to-be-created files).
 * @param {string} p
 * @returns {string}
 */
function canonical(p) {
  const abs = resolve(p);
  let real;
  try {
    real = realpathSync(abs);
  } catch (err) {
    // M1: branch on err.code. ONLY ENOENT means "not created yet" — anything
    // else (ELOOP cycle, EACCES, ENOTDIR) must FAIL CLOSED, never be treated
    // as a writable path.
    if (err && err.code === 'ENOENT') {
      // Resolve the deepest existing ancestor so a symlinked parent dir still
      // can't escape the allowlist.
      try {
        real = join(realpathSync(dirname(abs)), abs.slice(dirname(abs).length));
      } catch (err2) {
        if (err2 && err2.code === 'ENOENT') {
          real = abs; // neither the path nor its parent exists yet
        } else {
          throw new WriteForbiddenError(
            `cannot canonicalize path (${err2.code}): ${abs}`,
            'write-canonicalize-failed',
          );
        }
      }
    } else {
      throw new WriteForbiddenError(
        `cannot canonicalize path (${err && err.code}): ${abs}`,
        'write-canonicalize-failed',
      );
    }
  }
  const norm = normalize(real);
  return process.platform === 'win32' ? norm.toLowerCase() : norm;
}

/**
 * True when `child` is at or under `parent` (after canonicalization).
 * @param {string} child
 * @param {string} parent
 * @returns {boolean}
 */
function isUnder(child, parent) {
  const c = canonical(child);
  const p = canonical(parent);
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}

/**
 * True when `canonicalTarget` is one of the governed settings files placed
 * DIRECTLY under the config dir. Matches by EXACT basename + direct parent
 * (NOT isUnder / NOT a prefix), so `settings.jsonx`, a `settings.json/`
 * directory subtree, and a nested `sub/settings.json` are all rejected.
 * @param {string} canonicalTarget already-canonicalized target path
 * @param {string} claudeDir governed config dir
 * @returns {boolean}
 */
function isApplyWritableFile(canonicalTarget, claudeDir) {
  return dirname(canonicalTarget) === canonical(claudeDir)
    && APPLY_WRITABLE_FILES.includes(basename(canonicalTarget));
}

/**
 * Enforce the write-allowlist. Throws WriteForbiddenError when `target` is not
 * writable in the given context. Returns the canonical path on success.
 *
 * Three categories (plan "Forbidden vs Rollback-Writable"):
 *   - Forbidden (always): ~/.claude/plugins/marketplaces/**, ~/.claude/projects/**,
 *     and the mgr state dir's own snapshot/marketplace mirrors are out of scope.
 *     Also: nothing outside targetClaudeDir / mgrStateDir may be written.
 *   - Rollback-only writable: CLAUDE.md + agents/skills/commands/hooks under the
 *     target dir — writable ONLY when context === 'rollback'.
 *   - Normally writable: mgrStateDir/** (snapshots, journals, logs) in any context.
 *   - Always-writable settings files (plan line 432, "Always writable with --apply"):
 *     settings.json / settings.local.json / .mcp.json DIRECTLY under the config dir,
 *     writable in BOTH 'apply' and 'rollback' (see APPLY_WRITABLE_FILES).
 *   - Probe-only: context === 'probe' permits ONLY agents/__mgr-probe-<uuid>.md
 *     (the transient loader-probe artifact, P2.U7c) — nothing else.
 *
 * Per P1-10, U3 is apply-centric; the rollback context is recognized here per
 * the documented signature so P3 can wire it without reshaping the API.
 *
 * @param {string} target            absolute path intended for writing
 * @param {WriteContext} [context]   'apply' (default), 'rollback', or 'probe'
 * @returns {string} the canonical target path
 */
export function assertWritable(target, context = 'apply') {
  if (typeof target !== 'string' || target.length === 0) {
    throw new WriteForbiddenError('write target must be a non-empty string', 'write-target-invalid');
  }
  const ctx = (context === 'rollback' || context === 'probe') ? context : 'apply';
  const claudeDir = targetClaudeDir();
  const stateDir = mgrStateDir(claudeDir);

  // mgr's own state dir is always writable (it is NOT part of the governed
  // config surface and is excluded from snapshot scope).
  if (isUnder(target, stateDir)) {
    return canonical(target);
  }

  // Anything outside the governed config dir is out of scope for writes.
  if (!isUnder(target, claudeDir)) {
    throw new WriteForbiddenError(
      `refusing to write outside the governed config dir: ${target}`,
      'write-outside-target',
    );
  }

  // Always-forbidden subtrees within the config dir.
  const forbiddenSubdirs = [
    join(claudeDir, 'plugins', 'marketplaces'),
    join(claudeDir, 'projects'),
  ];
  for (const f of forbiddenSubdirs) {
    if (isUnder(target, f)) {
      throw new WriteForbiddenError(`path is forbidden to write: ${target}`, 'write-forbidden');
    }
  }

  // 'probe' context: allow ONLY a transient loader-probe artifact placed
  // DIRECTLY in agents/ with a __mgr-probe-<uuid>.md name. Everything else
  // (any other name, any nested dir, any other governed surface) is refused.
  // canonical() still denies a symlinked agents/ that escapes the config dir.
  if (ctx === 'probe') {
    const canonicalTarget = canonical(target);
    const agentsDir = canonical(join(claudeDir, 'agents'));
    if (dirname(canonicalTarget) === agentsDir && PROBE_NAME_RE.test(basename(canonicalTarget))) {
      return canonicalTarget;
    }
    throw new WriteForbiddenError(
      `probe context permits only agents/__mgr-probe-*.md: ${target}`,
      'write-probe-only',
    );
  }

  // Always-writable governed settings files (plan line 432, "Forbidden vs
  // Rollback-Writable" — the "Always writable (with --apply)" row): exactly
  // settings.json / settings.local.json / .mcp.json, DIRECTLY under the config
  // dir, in BOTH 'apply' and 'rollback'. After the forbidden/outside/probe
  // checks above, so those denials always win; disjoint from rollbackOnly below.
  const canonicalTarget = canonical(target);
  if ((ctx === 'apply' || ctx === 'rollback') && isApplyWritableFile(canonicalTarget, claudeDir)) {
    return canonicalTarget;
  }

  // Rollback-only-writable surfaces: governed content that normal apply must
  // never touch directly, but rollback restores from a verified snapshot.
  const rollbackOnly = [
    join(claudeDir, 'CLAUDE.md'),
    join(claudeDir, 'agents'),
    join(claudeDir, 'skills'),
    join(claudeDir, 'commands'),
    join(claudeDir, 'hooks'),
  ];
  for (const r of rollbackOnly) {
    if (isUnder(target, r)) {
      if (ctx === 'rollback') return canonical(target);
      throw new WriteForbiddenError(
        `path is rollback-only writable (not in 'apply' context): ${target}`,
        'write-rollback-only',
      );
    }
  }

  // Remaining paths under the config dir are not part of the writable surface
  // in Stage A; reject conservatively rather than allowing unknown writes.
  throw new WriteForbiddenError(
    `path is not in the writable allowlist: ${target}`,
    'write-not-allowed',
  );
}
