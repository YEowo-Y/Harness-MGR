/**
 * Snapshot TAR shell-out (P3.U7) — the FIRST snapshot unit that SPAWNS an
 * external process (the system `tar`). It captures the U5 walker's allowlisted
 * file set into an uncompressed tar archive and extracts it back, byte-identical,
 * for rollback. This is a SECURITY-BOUNDARY module: every tar invocation goes
 * through safe-spawn (the only sanctioned spawn gate), so a malicious arg cannot
 * become an option-injection (`--checkpoint-action=exec=...`) and the archive
 * path / file list cannot smuggle a shell metacharacter.
 *
 * WHY UNCOMPRESSED: the DoD is byte-identical EXTRACTED FILES, which tar preserves
 * regardless of compression. Dropping `-z` keeps the spawn deterministic and the
 * flag surface minimal (no codec to argue about).
 *
 * WHY DIRECT ARGV (not `-T listfile`): the plan suggested staging the file list to
 * a `-T` list file to dodge the Windows argv length cap. EMPIRICALLY (P3.U7
 * round-trip) the Windows-shipped bsdtar's `-T` reader cannot decode non-ASCII
 * names from the list file — it aborts with "Can't convert a path to a wchar_t
 * string" — and `~/.claude` legitimately holds unicode-named components (verified
 * byte-identical via direct argv: `café-señor-日本語.md`, `commands/münchen.md`).
 * Correctness (a byte-identical round-trip INCLUDING unicode filenames) is the
 * headline DoD, so we pass the relative file paths as direct argv, which Node
 * marshals as wide-char arguments that bsdtar decodes correctly. The cost is the
 * Windows command-line length cap (~32 KiB): we BUDGET the argv up front and, when
 * a tree would exceed the safe budget, FAIL CLEANLY with a `tar-too-many-files`
 * diagnostic rather than silently truncating or corrupting a snapshot. A chunked /
 * list-file path for very large ASCII-only trees is a DEFERRED enhancement.
 *
 * WINDOWS-PRIMARY / no allowSlashPositionals: on Windows the absolute path
 * positionals are drive-letter paths (`C:\...`), which do NOT begin with `/`, so
 * they are positionals by DEFAULT and a Windows-style mutation token is caught by
 * safe-spawn's default flag gate. We therefore do NOT opt into the slash-flag
 * escape and do NOT register a descriptor in spawn-spec-registry.mjs. POSIX
 * support (`/abs` paths, which would need the slash escape + a registered,
 * guardrail-passing descriptor) is a DEFERRED enhancement — the project is
 * Windows-primary and the OSS hand-rolled-tar fallback was already removed.
 *
 * NEVER THROWS: a missing tar, a spawn failure, or a non-zero tar exit becomes a
 * Diagnostic + `{ ok:false }`. Injectable resolveFn / spawnFn / statFn seams make
 * every path hermetically unit-testable without a real tar.
 *
 * Ops-layer constraint: imports only node:* stdlib + src/lib/**. Zero npm deps.
 */

import { statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DiagnosticBag } from '../lib/diagnostic.mjs';
import { resolveCommand } from '../lib/resolve-command.mjs';
import { safeSpawn } from '../lib/safe-spawn.mjs';

/** @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic */

/**
 * The exhaustive flag allowlist for every tar invocation. NOTHING beyond these:
 * no `-z`/`-j` (codec), no `--checkpoint*` (the classic exec-injection vector),
 * no `@` (concatenate-archive). A token not in this set and starting with `-`
 * (or `/`, by the default flag gate) is rejected `spawn-flag-not-allowed`.
 * @type {ReadonlyArray<string>}
 */
const TAR_ALLOWED_FLAGS = Object.freeze(['-c', '-f', '-x', '-C', '--version']);

/**
 * Second-belt positional pattern, applied by safe-spawn to EVERY non-flag token —
 * both the absolute path args (archivePath / baseDir / destDir) and the relative
 * file entries we pass as direct argv (`skills/a/SKILL.md`). The flag gate already
 * rejects `-`/`/`-leading tokens; this additionally FORBIDS any character a shell
 * could weaponise — control chars (incl. newline/CR/tab), quotes, and the
 * pipe/redirect/background/command-sub/glob family (`| & ; < > $ * ?`). It is
 * intentionally permissive on STRUCTURE (relative names have no drive/`/` anchor),
 * so a separate `..`-segment guard (hasTraversal) rejects path traversal — the one
 * structural attack a pure char-class cannot catch. Backslash IS allowed (Windows
 * separators); the dangerous-char class is what neutralises injection.
 * @type {RegExp}
 */
const TAR_PATH_RE = /^[^\0-\x1F"'`|&;<>$*?]+$/;

/**
 * Conservative byte budget for the assembled tar command line. The Windows
 * CreateProcess limit is ~32767 chars; we stay well under it (and leave room for
 * the exe path + fixed flags) so a snapshot of a normal `~/.claude` always fits and
 * an oversized tree fails cleanly via tar-too-many-files instead of a truncated
 * CreateProcess. (Direct-argv tradeoff — see the module header.)
 */
const TAR_ARGV_BUDGET = 24000;

/** Spawn timeout (ms) — generous for a large config tree, still bounded. */
const TAR_TIMEOUT_MS = 60000;

/**
 * Build the safe-spawn schema for a tar call. `maxArgs` is sized to the EXACT argv
 * length of this call (no slack) so the cap is a tight, call-specific bound rather
 * than a loose constant. Single source of truth for the flag allowlist + path
 * pattern. Deliberately NO allowSlashPositionals (Windows absolute positionals are
 * drive-lettered, so a `/`-leading token stays a flag and is rejected).
 * @param {number} argvLen exact number of tokens in this call's args array
 * @returns {{ allowedFlags: string[], positionalPattern: RegExp, maxArgs: number }}
 */
function tarSchema(argvLen) {
  return {
    allowedFlags: [...TAR_ALLOWED_FLAGS],
    positionalPattern: TAR_PATH_RE,
    maxArgs: argvLen,
  };
}

/** True if any segment of a POSIX/Windows path is exactly `..` (traversal). */
function hasTraversal(p) {
  return /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(p);
}

/**
 * On Windows, prefer the OS-shipped bsdtar at `%SystemRoot%\System32\tar.exe`
 * over whatever appears first on PATH. This is a CORRECTNESS requirement, not a
 * preference: a GNU tar (e.g. the one bundled with Git for Windows) treats a
 * drive-letter archive path `C:\...` as a `host:path` remote spec and fails with
 * "Cannot connect to C: resolve failed" — but every path this tool produces is
 * drive-lettered. bsdtar handles `C:\...` correctly. Returns the System32 path
 * only when it actually exists (statSync, never spawns); otherwise null so the
 * caller falls back to the PATH search.
 * @param {string} platform @param {object} env @param {(p:string)=>unknown} statFn
 * @returns {string|null}
 */
function preferredWindowsTar(platform, env, statFn) {
  if (platform !== 'win32') return null;
  const root = (env && typeof env.SystemRoot === 'string' && env.SystemRoot.length > 0)
    ? env.SystemRoot : 'C:\\Windows';
  const candidate = join(root, 'System32', 'tar.exe');
  try { statFn(candidate); return candidate; } catch { return null; }
}

/**
 * Locate the system `tar` executable's ABSOLUTE path. On Windows the OS-shipped
 * bsdtar (`System32\tar.exe`) is preferred — it is the only tar that handles the
 * drive-letter archive paths this tool emits (a PATH GNU tar would misread `C:`
 * as a remote host). Falls back to a resolveCommand PATH search (statSync only,
 * never spawns). Returns `{ tarPath:null }` + a diagnostic when tar is absent.
 *
 * @param {{ env?: object, platform?: string, cwd?: string,
 *           resolveFn?: (cmd:string, o:object) => {resolved:boolean, path:string|null},
 *           statFn?: (p:string) => unknown }} [opts]
 *   statFn is an injectable existence seam for the System32 probe (default node:fs statSync).
 * @returns {{ tarPath: string|null, diagnostics: Diagnostic[] }}
 */
export function resolveTar(opts = {}) {
  const { env, platform, cwd, resolveFn = resolveCommand, statFn = statSync } = opts ?? {};
  const plat = typeof platform === 'string' ? platform : process.platform;
  const environ = (env && typeof env === 'object') ? env : process.env;
  const bag = new DiagnosticBag();

  const win = preferredWindowsTar(plat, environ, statFn);
  if (win) return { tarPath: win, diagnostics: bag.all() };

  let resolved;
  try {
    resolved = resolveFn('tar', { env, platform, cwd });
  } catch {
    // resolveCommand is contractually never-throws; if it ever does, treat tar
    // as unavailable rather than propagating.
    resolved = { resolved: false, path: null };
  }
  if (!resolved || resolved.resolved !== true || typeof resolved.path !== 'string' || resolved.path.length === 0) {
    bag.add({
      severity: 'error', code: 'tar-not-found', phase: 'snapshot',
      message: 'system tar executable not found on PATH (bsdtar ships in System32 on Windows 10+)',
      fix: 'install tar or ensure it is on PATH',
    });
    return { tarPath: null, diagnostics: bag.all() };
  }
  return { tarPath: resolved.path, diagnostics: bag.all() };
}

/**
 * Run `tar --version` to confirm the resolved tar is launchable and capture its
 * banner (the plan's install-time probe). Never throws — a spawn failure becomes
 * `{ available:false }` + a diagnostic.
 *
 * @param {{ tarPath: string, cwd?: string,
 *           spawnFn?: (spec:object) => Promise<{stdout:string, stderr:string}> }} opts
 * @returns {Promise<{ available: boolean, version: string|null, diagnostics: Diagnostic[] }>}
 */
export async function probeTarVersion(opts) {
  const { tarPath, cwd = tmpdir(), spawnFn = safeSpawn } = opts ?? {};
  const bag = new DiagnosticBag();
  if (typeof tarPath !== 'string' || tarPath.length === 0) {
    bag.add({ severity: 'error', code: 'tar-not-found', phase: 'snapshot', message: 'tarPath must be a non-empty string' });
    return { available: false, version: null, diagnostics: bag.all() };
  }
  try {
    const versionArgs = ['--version'];
    const { stdout } = await spawnFn({
      exe: tarPath, args: versionArgs, cwd, allowedCwds: [cwd],
      schema: tarSchema(versionArgs.length), timeoutMs: TAR_TIMEOUT_MS,
    });
    const first = typeof stdout === 'string' ? stdout.split(/\r?\n/, 1)[0].trim() : '';
    return { available: true, version: first.length > 0 ? first.slice(0, 200) : null, diagnostics: bag.all() };
  } catch (e) {
    bag.add({ severity: 'error', code: 'tar-version-failed', phase: 'snapshot', message: `tar --version failed: ${errMsg(e)}` });
    return { available: false, version: null, diagnostics: bag.all() };
  }
}

/**
 * Create an uncompressed tar archive of `files` (POSIX-relative paths from the U5
 * walker), rooted at `baseDir`, written to `archivePath`. The relative file paths
 * are passed as DIRECT ARGV (`tar -c -f <archive> -C <baseDir> a b c ...`) so the
 * Windows bsdtar decodes unicode names correctly (the `-T` list-file form cannot
 * — see the module header). When the assembled command line would exceed the safe
 * argv budget, the call FAILS CLEANLY with `tar-too-many-files` instead of
 * truncating. Never throws.
 *
 * @param {object} opts
 * @param {string}   opts.tarPath      absolute path to tar
 * @param {string}   opts.archivePath  absolute path of the archive to write
 * @param {string}   opts.baseDir      absolute root the relative paths resolve under
 * @param {string[]} opts.files        POSIX-relative file paths to archive (no `..`)
 * @param {string}   [opts.cwd]        spawn cwd (defaults to os.tmpdir())
 * @param {(spec:object)=>Promise<{stdout:string,stderr:string}>} [opts.spawnFn]  spawn seam
 * @returns {Promise<{ ok: boolean, archivePath: string|null, diagnostics: Diagnostic[] }>}
 */
export async function createSnapshotTar(opts) {
  const bag = new DiagnosticBag();
  const o = opts ?? {};
  const fail = (code, message) => {
    bag.add({ severity: 'error', code, message, phase: 'snapshot' });
    return { ok: false, archivePath: null, diagnostics: bag.all() };
  };
  const badArg = validateCreateArgs(o);
  if (badArg) return fail('tar-create-bad-args', badArg);

  const { tarPath, archivePath, baseDir, files, cwd = tmpdir() } = o;
  const spawnFn = o.spawnFn ?? safeSpawn;

  const args = ['-c', '-f', archivePath, '-C', baseDir, ...files];
  // Budget the whole command line (exe + every arg + a join separator each) so an
  // oversized tree is refused, never silently truncated by CreateProcess.
  const argvChars = tarPath.length + args.reduce((n, a) => n + a.length + 1, 0);
  if (argvChars > TAR_ARGV_BUDGET) {
    return fail('tar-too-many-files',
      `snapshot file list (${files.length} files, ~${argvChars} argv chars) exceeds the safe ` +
      `command-line budget (${TAR_ARGV_BUDGET}); chunked archiving is a deferred enhancement`);
  }

  try {
    await spawnFn({
      exe: tarPath, args, cwd, allowedCwds: [cwd],
      schema: tarSchema(args.length), timeoutMs: TAR_TIMEOUT_MS,
    });
    return { ok: true, archivePath, diagnostics: bag.all() };
  } catch (e) {
    return fail('tar-create-failed', `tar create failed: ${errMsg(e)}`);
  }
}

/**
 * Extract a tar archive into `destDir` (uncompressed). Never throws — a spawn
 * failure / non-zero exit becomes `{ ok:false }` + a diagnostic.
 *
 * @param {object} opts
 * @param {string} opts.tarPath      absolute path to tar
 * @param {string} opts.archivePath  absolute path of the archive to read
 * @param {string} opts.destDir      absolute directory to extract into (must exist)
 * @param {string} [opts.cwd]        spawn cwd (defaults to os.tmpdir())
 * @param {(spec:object)=>Promise<{stdout:string,stderr:string}>} [opts.spawnFn]  spawn seam
 * @returns {Promise<{ ok: boolean, diagnostics: Diagnostic[] }>}
 */
export async function extractSnapshotTar(opts) {
  const bag = new DiagnosticBag();
  const o = opts ?? {};
  const fail = (code, message) => {
    bag.add({ severity: 'error', code, message, phase: 'snapshot' });
    return { ok: false, diagnostics: bag.all() };
  };
  const { tarPath, archivePath, destDir, cwd = tmpdir() } = o;
  const spawnFn = o.spawnFn ?? safeSpawn;
  if (!isNonEmptyStr(tarPath)) return fail('tar-extract-bad-args', 'tarPath must be a non-empty string');
  if (!isNonEmptyStr(archivePath)) return fail('tar-extract-bad-args', 'archivePath must be a non-empty string');
  if (!isNonEmptyStr(destDir)) return fail('tar-extract-bad-args', 'destDir must be a non-empty string');

  const args = ['-x', '-f', archivePath, '-C', destDir];
  try {
    await spawnFn({
      exe: tarPath, args, cwd, allowedCwds: [cwd],
      schema: tarSchema(args.length), timeoutMs: TAR_TIMEOUT_MS,
    });
    return { ok: true, diagnostics: bag.all() };
  } catch (e) {
    return fail('tar-extract-failed', `tar extract failed: ${errMsg(e)}`);
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

/** True for a non-empty string. */
function isNonEmptyStr(v) {
  return typeof v === 'string' && v.length > 0;
}

/** Validate createSnapshotTar's core args; returns an error message or ''. */
function validateCreateArgs(o) {
  if (!isNonEmptyStr(o.tarPath)) return 'tarPath must be a non-empty string';
  if (!isNonEmptyStr(o.archivePath)) return 'archivePath must be a non-empty string';
  if (!isNonEmptyStr(o.baseDir)) return 'baseDir must be a non-empty string';
  if (!Array.isArray(o.files)) return 'files must be an array of POSIX-relative paths';
  for (const f of o.files) {
    if (typeof f !== 'string' || f.length === 0) return 'every files[] entry must be a non-empty string';
    // Defense-in-depth: a `..` segment in a file entry could let the archive
    // escape baseDir; the walker never emits one, but refuse it here too.
    if (hasTraversal(f)) return `files[] entry must not contain a '..' segment: ${f}`;
  }
  return '';
}

/** Message from an unknown thrown value; never throws. */
function errMsg(e) {
  return e instanceof Error ? e.message : String(e);
}
