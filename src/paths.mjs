/**
 * Three-root path vocabulary for claude-mgr.
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
 * The governed write-allowlist gate (assertWritable / makeAssertWritable) lives in
 * write-gate.mjs — a PURE module that never imports paths.mjs. paths.mjs owns the
 * Claude DEFAULT entry `assertWritable` (it resolves the dirs at call time) and
 * re-exports the gate's public surface, so existing callers import unchanged.
 *
 * --- Async-shim note ---
 * Re-export is async (top-level await in reexport.mjs), so importing this module
 * is also async. That is by design (clarification #2).
 *
 * Zero npm dependencies.
 */

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Re-export the borrowed resolver so callers get it through paths.mjs too,
// reinforcing "one source of truth for config-dir". (reexport BEFORE paths:
// clarification #3 — paths imports reexport, so the shim must load first.)
import { getClaudeConfigDir } from './lib/reexport.mjs';
export { getClaudeConfigDir };

// The write-allowlist gate lives in write-gate.mjs (pure, never imports paths.mjs).
// Re-export its public surface so existing callers keep importing makeAssertWritable
// / WriteForbiddenError / APPLY_WRITABLE_FILES / CLAUDE_WRITE_SURFACE from paths.mjs.
import { makeAssertWritable, WriteForbiddenError, APPLY_WRITABLE_FILES, CLAUDE_WRITE_SURFACE } from './write-gate.mjs';
export { makeAssertWritable, WriteForbiddenError, APPLY_WRITABLE_FILES, CLAUDE_WRITE_SURFACE };

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
 * Enforce the write-allowlist for the CLAUDE DEFAULT target. Throws
 * WriteForbiddenError when `target` is not writable in the given context; returns
 * the canonical path on success. Resolves the config/state dirs at CALL time (so a
 * CLAUDE_CONFIG_DIR override keeps working) and runs the shared, surface-driven gate
 * (write-gate.mjs) with the built-in CLAUDE_WRITE_SURFACE — byte-identical to the
 * prior hardcoded implementation (pinned by test/paths.test.mjs + boundary-cases).
 *
 * For a NON-default target (Codex), a CLI write command builds its gate via
 * `makeAssertWritable({configDir, mgrStateDir, surface: descriptor.writeSurface})`
 * instead of using this default entry.
 *
 * @param {string} target            absolute path intended for writing
 * @param {import('./write-gate.mjs').WriteContext} [context]  'apply' (default), 'rollback',
 *   'probe', 'remove', 'remove-skill', 'propose', or 'accept'
 * @returns {string} the canonical target path
 */
export function assertWritable(target, context = 'apply') {
  const claudeDir = targetClaudeDir();
  return makeAssertWritable({ configDir: claudeDir, mgrStateDir: mgrStateDir(claudeDir) })(target, context);
}
