/**
 * OS-loader-style command resolution for passive health checks (P2.U5b).
 *
 * The doctor's mcp-server-resolvable (#2) and hook-external-command (#5) need to
 * answer "would the OS find this executable?" without spawning anything. This module
 * walks PATH (and Windows PATHEXT) with statSync — filesystem reads only, zero I/O
 * side-effects observable by the process.
 *
 * Key design constraints:
 *   - NEVER spawns, exec-s, or forks. Passive checks must be pure filesystem reads.
 *   - NEVER throws. All errors are caught and degrade to { resolved:false, path:null }.
 *   - Uses the host node:path for join/isAbsolute/sep (fs.statSync is always host-bound).
 *   - The injected `platform` controls ONLY PATHEXT usage and PATH delimiter, not
 *     path.win32 vs path.posix (which would break statSync on the host).
 *   - A matching directory name does NOT count (the isExecutableFile check rejects it).
 *   - On POSIX a non-executable regular file does NOT count (no execute bit → the
 *     OS loader would refuse it); on Windows executability is by extension (PATHEXT).
 *
 * Zero npm dependencies; node:fs and node:path only.
 */

import { statSync, accessSync, constants } from 'node:fs';
import { join, isAbsolute, resolve } from 'node:path';

/** Default PATHEXT when env.PATHEXT is missing on Windows. */
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

/**
 * Decide whether `p` is a regular file the OS loader would actually run.
 * Uses statSync (synchronous, no child process). Returns false on any error
 * (ENOENT, EACCES, etc.) and explicitly rejects directories.
 *
 * On POSIX (win=false) a regular file is only launchable if it has the execute
 * bit, so an additional accessSync(X_OK) is required — otherwise a readable but
 * non-executable file that happens to share a command's name (e.g. a stray
 * README) would be falsely reported as resolvable, then EACCES at spawn time.
 * On Windows executability is decided by extension (PATHEXT), not a mode bit, and
 * X_OK is inert, so no exec-bit check is applied there.
 *
 * @param {string} p absolute candidate path
 * @param {boolean} win whether the target platform is Windows (skip the X_OK check)
 * @returns {boolean}
 */
function isExecutableFile(p, win) {
  try {
    if (!statSync(p).isFile()) return false;
    if (!win) accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Build the ordered list of extensions to try when resolving `command`.
 * Always starts with `''` (try the token as-is). On Windows, appends each
 * dot-prefixed PATHEXT extension LOWERCASED, so dedup and candidate matching are
 * case-insensitive: PATHEXT is conventionally uppercase (.EXE;.CMD) but files on
 * disk are often lowercase (tool.cmd), which would miss on a case-sensitive FS.
 * @param {boolean} win whether to apply Windows PATHEXT logic
 * @param {Record<string,string|undefined>} env environment object
 * @returns {string[]}
 */
function candidateExtensions(win, env) {
  if (!win) return [''];
  const raw = typeof env.PATHEXT === 'string' ? env.PATHEXT : DEFAULT_PATHEXT;
  const extras = raw.split(';').map((e) => e.trim().toLowerCase()).filter((e) => e.startsWith('.'));
  const seen = new Set(['']);
  const exts = [''];
  for (const e of extras) {
    if (!seen.has(e)) { seen.add(e); exts.push(e); }
  }
  return exts;
}

/**
 * Split the PATH environment variable into an ordered list of directories,
 * dropping empty segments that result from doubled delimiters.
 * @param {Record<string,string|undefined>} env environment object
 * @param {boolean} win use ';' as delimiter when true, ':' otherwise
 * @returns {string[]}
 */
function pathDirs(env, win) {
  const raw = typeof env.PATH === 'string' ? env.PATH
    : typeof env.Path === 'string' ? env.Path : '';
  const delim = win ? ';' : ':';
  return raw.split(delim).filter((d) => d.length > 0);
}

/**
 * Probe whether a command token would be found by the OS loader, using only
 * synchronous filesystem reads — no spawning.
 *
 * `command` must be a single executable token (not a full command line with
 * arguments). A path-like command (absolute, or containing `/` or `\`) is
 * resolved relative to `cwd` if relative; otherwise each dir in PATH is tried.
 * On Windows the PATHEXT extensions are appended after the bare token.
 *
 * @param {string} command a single executable token (NOT a full command line with args)
 * @param {{ env?: Record<string,string|undefined>, platform?: string, cwd?: string }} [opts]
 * @returns {{ resolved: boolean, path: string|null }}
 */
export function resolveCommand(command, opts = {}) {
  if (typeof command !== 'string') return { resolved: false, path: null };
  const cmd = command.trim();
  if (cmd.length === 0) return { resolved: false, path: null };

  const env = (opts && typeof opts.env === 'object' && opts.env !== null) ? opts.env : process.env;
  const platform = (opts && typeof opts.platform === 'string') ? opts.platform : process.platform;
  const cwd = (opts && typeof opts.cwd === 'string') ? opts.cwd : process.cwd();

  const win = platform === 'win32';
  const exts = candidateExtensions(win, env);

  const pathLike = isAbsolute(cmd) || cmd.includes('/') || cmd.includes('\\');

  if (pathLike) {
    const base = isAbsolute(cmd) ? cmd : resolve(cwd, cmd);
    for (const ext of exts) {
      const candidate = base + ext;
      if (isExecutableFile(candidate, win)) return { resolved: true, path: candidate };
    }
    return { resolved: false, path: null };
  }

  for (const dir of pathDirs(env, win)) {
    for (const ext of exts) {
      const candidate = join(dir, cmd + ext);
      if (isExecutableFile(candidate, win)) return { resolved: true, path: candidate };
    }
  }
  return { resolved: false, path: null };
}
