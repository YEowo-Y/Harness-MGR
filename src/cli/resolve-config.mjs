/**
 * Config-dir resolution for the CLI boundary (P1.U15, sub-unit A).
 *
 * The pure data modules (scan / conflicts / orphans / settings-merge) all take a
 * `configDir` STRING and never touch paths.mjs — so the one place that decides
 * WHICH `~/.claude` is governed lives here, at the boundary. Two inputs:
 *
 *   - an explicit `configDir` override (e.g. a `--config-dir` flag, or a test) →
 *     used verbatim; paths.mjs is never imported (no async, no throw risk).
 *   - otherwise the live resolution: dynamically import paths.mjs and call
 *     `targetClaudeDir()`, which honours CLAUDE_CONFIG_DIR via the first-party resolver.
 *
 * --- The defensive load-failure fallback (`missing-hooks-lib`) ---
 * The live branch is wrapped in try/catch as insurance: a read-mostly governance CLI
 * must still START even if importing paths.mjs ever throws, so any failure degrades to
 * a direct config-dir fallback plus a single `missing-hooks-lib` warn Diagnostic — read
 * commands work; writes (which need the resolver) stay unavailable. This once guarded a
 * REAL fault: reexport.mjs did a top-level await that rejected when `~/.claude/hooks/lib`
 * was absent (breaking CI and fresh clones). The resolver is first-party now, so that
 * rejection is gone and the catch is pure defence-in-depth; the diagnostic code is kept
 * as a stable identifier.
 *
 * `loadPaths` is the injectable test seam (defaults to importing paths.mjs). It is
 * the ONLY async/throwing dependency; everything else here is pure aside from
 * `process.env` + `homedir()` on the fallback path.
 *
 * Zero npm dependencies. Node stdlib only. Never throws.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic
 */

/**
 * @typedef {Object} ResolvedConfig
 * @property {string} configDir     the governed ~/.claude directory
 * @property {string} mgrStateDir   claude-mgr's own state dir (configDir/.mgr-state)
 * @property {Diagnostic[]} diagnostics
 */

/** Default loader for paths.mjs — the async/throwing dependency we isolate. */
const defaultLoadPaths = () => import('../paths.mjs');

/**
 * The .mgr-state dir name, kept as a LOCAL literal so this module can build a
 * fallback path WITHOUT statically importing paths.mjs — the live branch imports it
 * dynamically inside the try, so a load failure degrades here instead of crashing the
 * import. Mirrors the orphan-detector precedent (a local literal reconciled by a
 * drift-guard test against paths.mjs's MGR_STATE_DIRNAME).
 */
const MGR_STATE_DIRNAME = '.mgr-state';

/**
 * Resolve the governed config directory.
 *
 * @param {{configDir?: string, loadPaths?: () => Promise<{targetClaudeDir: () => string}>}} [opts]
 * @returns {Promise<ResolvedConfig>}
 */
export async function resolveConfigDir({ configDir, loadPaths } = {}) {
  // Explicit override wins — never import paths.mjs, so no async/throw exposure.
  if (typeof configDir === 'string' && configDir.length > 0) {
    return { configDir, mgrStateDir: join(configDir, MGR_STATE_DIRNAME), diagnostics: [] };
  }

  // Live resolution: dynamically import the resolver; degrade on any load failure.
  try {
    const mod = await (loadPaths ?? defaultLoadPaths)();
    const cd = mod.targetClaudeDir();
    return { configDir: cd, mgrStateDir: mod.mgrStateDir(cd), diagnostics: [] };
  } catch {
    const cd = fallbackConfigDir();
    return { configDir: cd, mgrStateDir: join(cd, MGR_STATE_DIRNAME), diagnostics: [missingHooksLibDiag()] };
  }
}

/**
 * The read-only fallback config dir when paths.mjs cannot load: honour
 * CLAUDE_CONFIG_DIR (the same env `getClaudeConfigDir` reads) if set, else
 * `~/.claude`. Mirrors the loader's default without importing it.
 * @returns {string}
 */
function fallbackConfigDir() {
  const env = process.env.CLAUDE_CONFIG_DIR;
  if (typeof env === 'string' && env.trim().length > 0) return env.trim();
  return join(homedir(), '.claude');
}

/** @returns {Diagnostic} the single warn surfaced when the hooks lib is unloadable */
function missingHooksLibDiag() {
  return {
    severity: 'warn',
    code: 'missing-hooks-lib',
    message: 'config-dir resolver failed to load; using a direct config-dir fallback '
      + '(read-only commands work; writes are unavailable until it loads)',
    phase: 'cli',
  };
}
