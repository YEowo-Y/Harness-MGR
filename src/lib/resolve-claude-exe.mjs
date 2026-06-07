/**
 * Spawnable native `claude` executable resolver (P4b.U5 prerequisite).
 *
 * Used by `src/ops/update.mjs` (P4b.U5) and `src/ops/mcp-write.mjs` (U6)
 * when they need a native binary to hand to safeSpawn. This module lives in
 * src/lib/ (not src/discovery/) so the ops layer can import it without
 * crossing the ops→discovery boundary.
 *
 * ## The Windows-shim problem
 *
 * On Windows, npm installs `claude` as three shim files: an extensionless
 * bash shim, `claude.cmd`, and `claude.ps1`. resolveCommand() returns the
 * extensionless shim (the first hit in PATH). None of these can be run by
 * Node's execFile with shell:false (the safeSpawn gate FORBIDS shell:true):
 * .cmd/.bat throw EINVAL since the Node CVE-2024-27980 fix, and the
 * extensionless bash shim is not a Windows PE executable.
 *
 * Therefore we attempt a fallback: when resolveCommand returns a non-spawnable
 * path on win32 we look for the actual native binary that the @anthropic-ai/
 * claude-code npm package ships at `bin/claude.exe`, sitting alongside the
 * shim directory inside node_modules. If that file exists, it is safe to pass
 * to execFile without a shell.
 *
 * ## isSpawnable — deliberate duplicate of probe-cli.mjs
 *
 * This module re-implements isSpawnable rather than importing it from
 * src/discovery/probe-cli.mjs because lib must not import discovery (the
 * layering rule). The logic is intentionally identical; a drift-guard test in
 * test/lib-resolve-claude-exe.test.mjs pins the two implementations against the
 * same battery of (path, platform) pairs.
 *
 * ## Never-throws contract
 *
 * resolveClaudeExe catches all synchronous errors in an outer try/catch and
 * returns { exe:null, kind:null, diagnostics:[{code:'claude-exe-resolve-error'}] }
 * on any unexpected exception.
 *
 * Zero npm dependencies. node:fs and node:path only (plus resolveCommand).
 */

import { statSync } from 'node:fs';
import { dirname, join, isAbsolute } from 'node:path';
import { resolveCommand } from './resolve-command.mjs';

/** @typedef {import('./diagnostic.mjs').Diagnostic} Diagnostic */

/**
 * Windows native executable extensions (lowercased). Only .exe and .com are
 * safe to pass to execFile with shell:false on win32.
 * @type {ReadonlySet<string>}
 */
const WINDOWS_NATIVE_EXTS = new Set(['.exe', '.com']);

/**
 * Returns true when `resolvedPath` can be passed to execFile without a shell.
 *
 * On non-win32 the POSIX kernel honours shebangs, so any file is spawnable.
 * On win32, only .exe/.com are native PE executables; extensionless shims and
 * .cmd/.bat/.ps1 require a shell (FORBIDDEN by the safeSpawn gate).
 *
 * NOTE: This is a deliberate single-source DUPLICATE of the identically-named
 * function exported by src/discovery/probe-cli.mjs. The duplication exists
 * because lib/ must not import discovery/. A drift-guard test pins both
 * implementations against the same (path, platform) battery.
 *
 * @param {unknown} resolvedPath  absolute path from resolveCommand
 * @param {string} platform       process.platform string
 * @returns {boolean}
 */
export function isSpawnable(resolvedPath, platform) {
  if (typeof resolvedPath !== 'string' || resolvedPath.length === 0) return false;
  if (platform !== 'win32') return true;
  const dot = resolvedPath.lastIndexOf('.');
  if (dot < 0) return false; // extensionless on win32 → shim, not spawnable
  return WINDOWS_NATIVE_EXTS.has(resolvedPath.slice(dot).toLowerCase());
}

/**
 * Default existsFn — returns true when `p` is an existing regular file.
 * Never throws (ENOENT / EACCES / etc. → false).
 * @param {string} p
 * @returns {boolean}
 */
function defaultExistsFn(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * @typedef {Object} ResolveClaudeExeResult
 * @property {string|null} exe        absolute path to a spawnable claude binary, or null
 * @property {'native'|'package-bin'|null} kind
 *   - 'native'      resolveCommand returned a path isSpawnable() accepts directly
 *   - 'package-bin' resolved via the npm package's bin/claude.exe fallback (win32 only)
 *   - null          no spawnable binary found
 * @property {Diagnostic[]} diagnostics  empty on success; populated when exe is null
 */

/**
 * Resolve a spawnable native `claude` executable for use with safeSpawn.
 *
 * Steps (in order):
 *  a) resolveCommand('claude') — if the result is spawnable, return it as
 *     kind:'native'.
 *  b) win32 only — if resolveCommand returned a non-spawnable shim, derive the
 *     npm package binary at dirname(shim)/node_modules/@anthropic-ai/
 *     claude-code/bin/claude.exe and return it as kind:'package-bin' if the
 *     file exists and the path is absolute.
 *  c) Fallback — return { exe:null, kind:null } with a 'claude-exe-unresolved'
 *     info Diagnostic so the caller can refuse gracefully.
 *
 * Never throws.
 *
 * @param {{ env?: Record<string,string|undefined>,
 *            platform?: string,
 *            cwd?: string,
 *            resolveFn?: (cmd:string, o:object) => {resolved:boolean, path:string|null},
 *            existsFn?: (p:string) => boolean
 *         }} [opts]
 * @returns {ResolveClaudeExeResult}
 */
export function resolveClaudeExe(opts = {}) {
  try {
    const {
      env = process.env,
      platform = process.platform,
      cwd,
      resolveFn = resolveCommand,
      existsFn = defaultExistsFn,
    } = opts ?? {};

    const r = resolveFn('claude', { env, platform, cwd });

    // Step a — direct native exe
    if (
      r &&
      r.resolved === true &&
      typeof r.path === 'string' &&
      r.path.length > 0 &&
      isSpawnable(r.path, platform)
    ) {
      return { exe: r.path, kind: 'native', diagnostics: [] };
    }

    // Step b — win32 shim fallback: derive the package-local native binary
    if (
      platform === 'win32' &&
      r &&
      r.resolved === true &&
      typeof r.path === 'string' &&
      r.path.length > 0
    ) {
      const pkgBin = join(
        dirname(r.path),
        'node_modules',
        '@anthropic-ai',
        'claude-code',
        'bin',
        'claude.exe',
      );
      if (isAbsolute(pkgBin) && existsFn(pkgBin)) {
        return { exe: pkgBin, kind: 'package-bin', diagnostics: [] };
      }
    }

    // Step c — no spawnable binary found
    return {
      exe: null,
      kind: null,
      diagnostics: [
        {
          severity: 'info',
          code: 'claude-exe-unresolved',
          phase: 'update',
          message:
            'no spawnable native `claude` executable found (PATH resolved only an' +
            ' unspawnable shim or nothing); cannot delegate to `claude plugin update`',
        },
      ],
    };
  } catch (error) {
    return {
      exe: null,
      kind: null,
      diagnostics: [
        {
          severity: 'error',
          code: 'claude-exe-resolve-error',
          phase: 'update',
          message: String(error),
        },
      ],
    };
  }
}
