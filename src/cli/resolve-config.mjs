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
 *     `targetClaudeDir()`, which honours CLAUDE_CONFIG_DIR via the borrowed loader.
 *
 * --- The M2 missing-hooks-lib fallback ---
 * Importing paths.mjs is ASYNC and can REJECT at load time: paths.mjs → reexport.mjs
 * does a top-level await that requires `~/.claude/hooks/lib`; if that lib is absent
 * the dynamic import throws. A read-mostly governance CLI must still work in that
 * state (you cannot inspect a broken config if the inspector refuses to start). So
 * any throw on the live branch degrades to a direct config-dir fallback plus a
 * single `missing-hooks-lib` warn Diagnostic — read commands work; writes (which
 * need the loader) stay unavailable until the lib is restored.
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
 * @property {string} configDir   the governed ~/.claude directory
 * @property {Diagnostic[]} diagnostics
 */

/** Default loader for paths.mjs — the async/throwing dependency we isolate. */
const defaultLoadPaths = () => import('../paths.mjs');

/**
 * Resolve the governed config directory.
 *
 * @param {{configDir?: string, loadPaths?: () => Promise<{targetClaudeDir: () => string}>}} [opts]
 * @returns {Promise<ResolvedConfig>}
 */
export async function resolveConfigDir({ configDir, loadPaths } = {}) {
  // Explicit override wins — never import paths.mjs, so no async/throw exposure.
  if (typeof configDir === 'string' && configDir.length > 0) {
    return { configDir, diagnostics: [] };
  }

  // Live resolution: a missing hooks/lib makes this import reject (the M2 case).
  try {
    const mod = await (loadPaths ?? defaultLoadPaths)();
    return { configDir: mod.targetClaudeDir(), diagnostics: [] };
  } catch {
    return { configDir: fallbackConfigDir(), diagnostics: [missingHooksLibDiag()] };
  }
}

/**
 * The read-only fallback config dir when paths.mjs cannot load: honour
 * CLAUDE_CONFIG_DIR (the same env the borrowed loader reads) if set, else
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
    message: '~/.claude/hooks/lib not found or unloadable; using a direct config-dir fallback '
      + '(read-only commands work; writes are unavailable until the hooks lib is present)',
    phase: 'cli',
  };
}
