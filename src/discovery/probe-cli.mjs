/**
 * CLI resolution/liveness probe gatherer (P2.U7b).
 *
 * Gathers the `claude` CLI resolution/liveness fact for doctor check #15
 * (claude-cli-resolvable), keeping the doctor itself pure (no I/O) by
 * gathering facts here in the discovery layer.
 *
 * RESOLUTION-PRIMARY — the Windows shim problem:
 *   On Windows, npm installs `claude` as three shim files: an extensionless
 *   bash shim, `claude.cmd`, and `claude.ps1`. resolveCommand() returns the
 *   extensionless shim (the first hit in PATH). None of these can be run by
 *   Node's execFile with shell:false (the safeSpawn gate FORBIDS shell:true):
 *   .cmd/.bat throw EINVAL since the Node CVE-2024-27980 fix, and the
 *   extensionless bash shim is not a Windows PE executable.
 *
 *   Therefore spawning `claude --version` is ONLY attempted when the resolved
 *   path is a NATIVE executable that execFile can run without a shell. On
 *   win32 that means extension .exe or .com ONLY; on non-win32 the POSIX
 *   kernel honours shebangs so any file is spawnable. A non-spawnable shim
 *   reports status 'resolved' (claude IS present) — never 'unresponsive',
 *   which would be a false positive on every standard Windows install.
 *
 * Never throws. Returns a single CliFact. Zero npm dependencies. Node stdlib only.
 */

import { tmpdir } from 'node:os';
import { resolveCommand } from '../lib/resolve-command.mjs';
import { safeSpawn } from '../lib/safe-spawn.mjs';

/** @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic */

/**
 * @typedef {Object} CliFact
 * @property {string} command        the probed command ('claude')
 * @property {'ok'|'resolved'|'unresolved'|'unresponsive'|'indeterminate'} status
 *   - ok           resolved to a native exe AND `--version` exited 0
 *   - resolved     found on PATH but not safely spawnable without a shell
 *                  (e.g. a Windows .cmd/.ps1/extensionless npm shim) —
 *                  claude IS present; `--version` was not run
 *   - unresolved   not found on PATH at all
 *   - unresponsive resolved to a native exe but `--version` failed
 *   - indeterminate could not determine (resolution itself threw)
 * @property {string|null} resolvedPath  absolute path claude resolved to, or null
 * @property {string|null} version       version string parsed from --version output, or null
 */

/**
 * Windows native executable extensions (lowercased). Only these are safe
 * to pass to execFile with shell:false on win32.
 * @type {ReadonlySet<string>}
 */
const WINDOWS_NATIVE_EXTS = new Set(['.exe', '.com']);

/**
 * Returns true when the resolved path can be passed to execFile without a shell.
 *
 * On non-win32 the POSIX kernel honours shebangs, so any file is spawnable.
 * On win32, only .exe/.com are native PE executables; extensionless shims and
 * .cmd/.bat/.ps1 require a shell (FORBIDDEN by the safeSpawn gate).
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
 * Parse a version string from the output of `claude --version`.
 * Prefers a semver-like token; falls back to the first non-empty trimmed line
 * (capped at 80 chars) so any version format is captured. Returns null when
 * no parseable content is found.
 *
 * @param {unknown} stdout  raw stdout string from the spawn
 * @returns {string|null}
 */
export function extractVersion(stdout) {
  if (typeof stdout !== 'string') return null;
  // Cap before matching: bound the regex/split work on untrusted process stdout
  // (a version banner is never this large) — prevents O(n^2) regex backtracking
  // on a pathological all-digit stream from a rogue executable.
  const text = stdout.slice(0, 4096).trim();
  if (text.length === 0) return null;
  const m = text.match(/\d+\.\d+\.\d+[\w.-]*/);
  if (m) return m[0];
  // Fallback: first non-empty trimmed line, capped at 80 chars.
  const first = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
  return first ? first.slice(0, 80) : null;
}

/**
 * Default I/O runner — invokes `claude --version` via safeSpawn.
 * Tests inject `runVersion` so they never spawn a real process.
 *
 * safeSpawn rejects when claude exits non-zero; on any validation/spawn
 * failure err.code is a STRING. The schema allows only `--version`.
 *
 * @param {string} absPath  absolute path to the claude native executable
 * @returns {Promise<{ok:boolean, version:string|null}>}
 */
async function defaultRunVersion(absPath) {
  try {
    const { stdout } = await safeSpawn({
      exe: absPath,
      args: ['--version'],
      cwd: tmpdir(),
      allowedCwds: [tmpdir()],
      schema: { allowedFlags: ['--version'], maxArgs: 1 },
      timeoutMs: 15000,
    });
    return { ok: true, version: extractVersion(stdout) };
  } catch {
    return { ok: false, version: null };
  }
}

/**
 * Gather the claude-CLI fact for the doctor active layer (#15).
 *
 * Resolution-primary: resolve `claude` on PATH via resolveCommand (statSync
 * only, never spawns). Only attempt `claude --version` for a native executable
 * (see isSpawnable) so a Windows npm shim never produces a false 'unresponsive'.
 *
 * Never throws.
 *
 * @param {{ env?: object, platform?: string, cwd?: string,
 *           resolveFn?: (cmd:string, o:object) => {resolved:boolean, path:string|null},
 *           runVersion?: (absPath:string) => Promise<{ok:boolean, version:string|null}>
 *        }} [opts]
 * @returns {Promise<{ cli: CliFact, diagnostics: Diagnostic[] }>}
 */
export async function gatherCliProbe(opts) {
  const {
    env,
    platform = process.platform,
    cwd,
    resolveFn = resolveCommand,
    runVersion = defaultRunVersion,
  } = opts ?? {};

  const command = 'claude';

  let resolved;
  try {
    resolved = resolveFn(command, { env, platform, cwd });
  } catch {
    // resolveCommand is contractually never-throws; if it ever does we cannot
    // determine resolution → indeterminate (silent), never a false 'unresolved'
    // WARN that would claim claude is absent when we simply could not tell.
    return {
      cli: { command, status: 'indeterminate', resolvedPath: null, version: null },
      diagnostics: [],
    };
  }

  if (
    !resolved ||
    resolved.resolved !== true ||
    typeof resolved.path !== 'string' ||
    resolved.path.length === 0
  ) {
    return {
      cli: { command, status: 'unresolved', resolvedPath: null, version: null },
      diagnostics: [],
    };
  }

  const resolvedPath = resolved.path;

  if (!isSpawnable(resolvedPath, platform)) {
    // Present but not execFile-able without a shell (Windows npm shim). Report
    // 'resolved' — claude IS installed — rather than risk a false 'unresponsive'.
    return {
      cli: { command, status: 'resolved', resolvedPath, version: null },
      diagnostics: [],
    };
  }

  let res;
  try {
    res = await runVersion(resolvedPath);
  } catch {
    res = { ok: false, version: null };
  }

  if (res && res.ok === true) {
    return {
      cli: {
        command,
        status: 'ok',
        resolvedPath,
        version: res && typeof res.version === 'string' ? res.version : null,
      },
      diagnostics: [],
    };
  }

  return {
    cli: { command, status: 'unresponsive', resolvedPath, version: null },
    diagnostics: [],
  };
}
