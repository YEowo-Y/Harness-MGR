/**
 * Reuse shim: re-export the BATTLE-TESTED hook primitives from
 * ~/.claude/hooks/lib/ so claude-mgr never reimplements atomic writes or
 * config-dir resolution (per plan: paths.mjs "DELEGATES ... never reimplements").
 *
 * --- Async-shim note (clarification #2, kept in code on purpose) ---
 * ESM `import` requires a STATIC string specifier and cannot expand `~`. The
 * hooks live under the user's home dir, whose absolute path is only known at
 * runtime. So we resolve homedir() -> absolute path -> file:// URL and use a
 * top-level `await import()`. Because this module performs a top-level await,
 * every consumer importing it is implicitly async-loaded. That is intended for
 * an ESM CLI but worth stating: `reexport.mjs` is an ASYNC module, and so is
 * everything downstream of it (paths.mjs, the CLI).
 *
 * Override: CLAUDE_MGR_HOOKS_LIB_DIR lets tests/sandboxes point the shim at a
 * copy of the lib dir without touching the real ~/.claude.
 *
 * Zero npm dependencies (node:os / node:path / node:url stdlib only).
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Compute the absolute hooks/lib directory. Honors an env override first, then
 * falls back to ~/.claude/hooks/lib. Note this is the HOOKS dir, independent of
 * CLAUDE_CONFIG_DIR (the hooks shipped with OMC live under the real home).
 * @returns {string}
 */
export function resolveHooksLibDir() {
  const override = process.env.CLAUDE_MGR_HOOKS_LIB_DIR?.trim();
  if (override) return override;
  return join(homedir(), '.claude', 'hooks', 'lib');
}

const libDir = resolveHooksLibDir();

// file:// URLs are required for absolute-path dynamic import on Windows
// (a bare 'C:\...' specifier is rejected by the ESM loader).
const atomicUrl = pathToFileURL(join(libDir, 'atomic-write.mjs')).href;
const configUrl = pathToFileURL(join(libDir, 'config-dir.mjs')).href;

const atomicMod = await import(atomicUrl);
const configMod = await import(configUrl);

/** @type {(filePath: string, content: string) => void} */
export const atomicWriteFileSync = atomicMod.atomicWriteFileSync;

/** @type {(dir: string) => void} */
export const ensureDirSync = atomicMod.ensureDirSync;

/** @type {() => string} */
export const getClaudeConfigDir = configMod.getClaudeConfigDir;

// Fail loud at load time if the borrowed surface ever changes shape, rather
// than NPE-ing deep in a write path later.
if (typeof atomicWriteFileSync !== 'function') {
  throw new Error(`reexport: atomicWriteFileSync missing from ${atomicUrl}`);
}
if (typeof ensureDirSync !== 'function') {
  throw new Error(`reexport: ensureDirSync missing from ${atomicUrl}`);
}
if (typeof getClaudeConfigDir !== 'function') {
  throw new Error(`reexport: getClaudeConfigDir missing from ${configUrl}`);
}
