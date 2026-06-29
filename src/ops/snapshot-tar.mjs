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
 * Windows command-line length cap (~32 KiB): we BUDGET the argv per spawn and, when
 * a tree would exceed it, CHUNK the file list (P3.D1) — the first chunk is created
 * (`-c`) and each subsequent ASCII-only chunk is appended (`-r`) into the same
 * archive, so a real `~/.claude` (664 files ≈ 28614 argv chars) archives without
 * the old `tar-too-many-files` hard failure. UNICODE-SAFE APPEND: bsdtar's `-r`
 * mode CORRUPTS a non-ASCII member name on Windows (it reads the appended arg
 * through the OEM codepage, e.g. `ñ`→`_`), while `-c` marshals wide-chars correctly
 * — so the chunker (see snapshot-tar-chunk.mjs) forces EVERY non-ASCII-named member
 * into the first `-c` chunk; only pure-ASCII members are ever appended. The only
 * clean failures are a single member too long for any chunk (`tar-path-too-long`)
 * or non-ASCII members that together overflow one chunk (`tar-unicode-overflow`).
 *
 * CROSS-PLATFORM POSITIONALS: on Windows the absolute path positionals are drive-
 * letter paths (`C:\...`), which do NOT begin with `/`, so they are positionals by
 * default and we KEEP safe-spawn's strict flag-gate (a `/`-token stays a denied flag —
 * a Windows mutation flag can never become a positional). On POSIX the paths are `/abs`,
 * so tarSchema opts into allowSlashPositionals ONLY there (process.platform !== 'win32'):
 * a `/`-leading token is then validated as a POSITIONAL by TAR_PATH_RE — tightened to
 * require a MULTI-SEGMENT path, so it admits real archive/base/dest paths while still
 * rejecting the single-segment `/grant`-family mutation flags the guardrail probes
 * (TAR_SPAWN_SPEC, registered in spawn-spec-registry.mjs). The `-`/`--` flag families
 * stay deny-by-default everywhere.
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
import { chunkByArgvBudget } from './snapshot-tar-chunk.mjs';

/** @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic */

/**
 * The exhaustive flag allowlist for every tar invocation. NOTHING beyond these:
 * no `-z`/`-j` (codec), no `--checkpoint*` (the classic exec-injection vector),
 * no `@` (concatenate-archive). A token not in this set and starting with `-`
 * (or `/`, by the default flag gate) is rejected `spawn-flag-not-allowed`.
 *
 * `-r` (append) is part of chunked archiving (P3.D1): a large file list is split
 * into argv-budget-sized chunks, the FIRST written with `-c` (create) and each
 * SUBSEQUENT one appended with `-r` into the same uncompressed archive. bsdtar
 * (Windows System32) supports `-r -f <archive> -C <baseDir> <members...>`. `-r`
 * cannot extract or run a codec, so it adds no new injection surface beyond `-c`.
 * @type {ReadonlyArray<string>}
 */
const TAR_ALLOWED_FLAGS = Object.freeze(['-c', '-r', '-f', '-x', '-C', '--version']);

/**
 * Second-belt positional pattern, applied by safe-spawn to EVERY non-flag token —
 * the absolute path args (archivePath / baseDir / destDir) and the relative file
 * entries passed as direct argv (`skills/a/SKILL.md`). It FORBIDS any character a
 * shell could weaponise — control chars (incl. newline/CR/tab), quotes, and the
 * pipe/redirect/background/command-sub/glob family (`| & ; < > $ * ?`). Backslash
 * and `/` ARE allowed (path separators); a separate `..`-segment guard (hasTraversal)
 * rejects traversal — the one structural attack a char-class cannot catch.
 *
 * POSIX-SAFE STRUCTURE (so allowSlashPositionals can be enabled — see TAR_SPAWN_SPEC):
 * a `/`-leading token MUST be MULTI-SEGMENT (contain a second `/`). Real archive /
 * base / dest paths are always deep (`/tmp/cmgr-xxx/.mgr-state/...`, `/home/u/.claude`),
 * so this admits them while REJECTING the single-segment `/grant`-family Windows icacls
 * mutation flags the spawn-spec guardrail probes. Relative members (no leading `/`) and
 * Windows drive paths (`C:\...`) take the first alternative, unchanged from before.
 * @type {RegExp}
 */
const TAR_PATH_RE = /^(?:[^/\0-\x1F"'`|&;<>$*?][^\0-\x1F"'`|&;<>$*?]*|\/[^\0-\x1F"'`|&;<>$*?]*\/[^\0-\x1F"'`|&;<>$*?]*)$/;

/**
 * Spawn-spec descriptor for snapshot-tar's safeSpawn calls. DECLARES the POSIX
 * allowSlashPositionals opt-in (`true`) + the positional pattern, and is registered in
 * spawn-spec-registry.mjs so the guardrail PROVES TAR_PATH_RE rejects every known
 * Windows mutation flag while accepting a real POSIX path — that proof is what makes
 * the opt-in safe. The descriptor stays `true` for the guardrail; the RUNTIME schema
 * (tarSchema) gates the opt-in to non-win32, so on Windows a `/`-token stays a denied
 * flag (paths are drive-lettered `C:\...`, never `/`-leading).
 * @type {Readonly<{id:string, allowSlashPositionals:true, positionalPattern:RegExp}>}
 */
export const TAR_SPAWN_SPEC = Object.freeze({
  id: 'snapshot-tar',
  allowSlashPositionals: /** @type {true} */ (true),
  positionalPattern: TAR_PATH_RE,
});

/**
 * Conservative per-CHUNK byte budget for an assembled tar command line. The Windows
 * CreateProcess limit is ~32767 chars (EMPIRICALLY confirmed on this box: a single
 * spawn fails `ENAMETOOLONG` between ~32600 and ~33000 argv chars). We stay under it
 * with headroom for the exe path + fixed flags + per-arg marshalling. We budget in
 * UTF-8 BYTES (Buffer.byteLength; #11) — a multi-byte name's byte count >= its UTF-16
 * length, so byte-budgeting OVER-counts vs the char cap and errs SAFE. A file list
 * that would exceed this budget is SPLIT across a `-c` create + `-r` append sequence
 * (P3.D1) rather than refused, so a real `~/.claude` (664 files ≈ 28614 argv chars)
 * archives in a SINGLE chunk and a larger harness chunks cleanly. Failures: a SINGLE
 * member too long for any chunk (tar-path-too-long), or non-ASCII members that
 * together exceed one chunk (tar-unicode-overflow — they must all ride the unicode-
 * safe `-c` chunk; see the chunker header). Injectable per-call via `argvBudget` so
 * tests force multi-chunk with a handful of files. (Direct-argv tradeoff — header.)
 */
const TAR_ARGV_BUDGET = 30000;

/** Spawn timeout (ms) — generous for a large config tree, still bounded. */
const TAR_TIMEOUT_MS = 60000;

/**
 * Build the safe-spawn schema for a tar call. `maxArgs` is sized to the EXACT argv
 * length of this call (no slack) so the cap is a tight, call-specific bound rather
 * than a loose constant. The flag allowlist + positionalPattern are the single source
 * of truth (positionalPattern is spread from TAR_SPAWN_SPEC, so the GATED and the
 * guardrail-CHECKED pattern are the SAME object). allowSlashPositionals is gated to
 * POSIX (process.platform !== 'win32'): the opt-in is needed only where the paths are
 * `/abs`, and Windows keeps the strict flag-gate default — see the module header.
 * @param {number} argvLen exact number of tokens in this call's args array
 * @returns {{ allowedFlags: string[], positionalPattern: RegExp, allowSlashPositionals: boolean, maxArgs: number }}
 */
function tarSchema(argvLen) {
  return {
    allowedFlags: [...TAR_ALLOWED_FLAGS],
    positionalPattern: TAR_SPAWN_SPEC.positionalPattern,
    // POSIX-only opt-in (see header + TAR_SPAWN_SPEC): on Windows we KEEP safe-spawn's
    // strict default so a `/`-token stays a denied flag (Windows paths are `C:\...`).
    allowSlashPositionals: process.platform !== 'win32',
    maxArgs: argvLen,
  };
}

/** True if any segment of a POSIX/Windows path is exactly `..` (traversal). */
function hasTraversal(p) {
  return /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(p);
}

/**
 * True when a member path is NOT a safe relative path — a leading `/` or `\`
 * (POSIX/UNC absolute), a `^[A-Za-z]:` drive prefix (Windows absolute), or a
 * leading `@` (tar's concatenate-archive sigil). Any of these would let an
 * absolute/foreign path become an archive member, so tar would READ a file
 * OUTSIDE baseDir into the snapshot (information disclosure). The U5 walker only
 * ever emits relative POSIX paths, so this is a defense-in-depth hardening of
 * createSnapshotTar's EXPORTED contract for any future non-walker caller.
 * @param {string} p
 * @returns {boolean}
 */
function isNonRelativeMember(p) {
  return p.startsWith('/') || p.startsWith('\\') || p.startsWith('@') || /^[A-Za-z]:/.test(p);
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
 * — see the module header).
 *
 * CHUNKED (P3.D1): when the member list would exceed the per-spawn argv budget the
 * list is SPLIT — the FIRST chunk is created (`-c`) and each subsequent chunk is
 * APPENDED (`-r`) into the same archive — so a real `~/.claude` (664 files) archives
 * in a single chunk and a larger harness chunks cleanly. Every chunk's argv passes
 * the SAME safe-spawn schema (allowedFlags incl. `-r`, the same TAR_PATH_RE, an exact
 * maxArgs). UNICODE-SAFE: the chunker forces every non-ASCII-named member into the
 * `-c` chunk (Windows bsdtar `-r` corrupts non-ASCII names — see the chunker header),
 * so only ASCII members are appended. If ANY chunk spawn fails the call returns
 * `{ ok:false }` + a diagnostic (the caller cleans up the partial archive). Two clean
 * failures (never an oversized OR corrupting spawn): a single member too long for any
 * chunk → `tar-path-too-long`; non-ASCII members that together overflow one chunk →
 * `tar-unicode-overflow`. Never throws.
 *
 * CALLER CONTRACT — WRITE GATE (#9b): createSnapshotTar does NOT call
 * assertWritable on `archivePath`; it is a low-level tar wrapper. The CALLER must
 * validate `archivePath` through the governed-write gate (assertWritable) BEFORE
 * invoking, so the spawn only ever writes into an approved location. The U8
 * orchestrator (snapshot.mjs) gates it before the spawn; any future caller (e.g.
 * the apply path P3.U12) reusing this function MUST do the same.
 *
 * @param {object} opts
 * @param {string}   opts.tarPath      absolute path to tar
 * @param {string}   opts.archivePath  absolute path of the archive to write
 * @param {string}   opts.baseDir      absolute root the relative paths resolve under
 * @param {string[]} opts.files        POSIX-relative file paths to archive (no `..`)
 * @param {string}   [opts.cwd]        spawn cwd (defaults to os.tmpdir())
 * @param {number}   [opts.argvBudget] per-chunk argv BYTE budget (UTF-8; defaults TAR_ARGV_BUDGET)
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
  const budget = Number.isFinite(o.argvBudget) && o.argvBudget > 0 ? o.argvBudget : TAR_ARGV_BUDGET;

  // Fixed per-spawn argv cost: exe + the fixed flags/paths + their join separators.
  // Mirrors the old single-spawn `tarPath + Σ(arg.length+1)` budgeting, minus the
  // members (which the chunker accounts for per-chunk).
  const fixed = ['-c', '-f', archivePath, '-C', baseDir];
  // Byte-accurate budgeting (#11): count UTF-8 bytes, not UTF-16 code units, so a
  // unicode-heavy archivePath/baseDir can't undercount vs the OS argv cap (the
  // chunker's memberBytes accounts for member names the same way).
  const fixedOverhead = Buffer.byteLength(tarPath, 'utf8') + fixed.reduce((n, a) => n + Buffer.byteLength(a, 'utf8') + 1, 0);

  const { chunks, tooLong, unicodeOverflow } = chunkByArgvBudget(files, fixedOverhead, budget);
  if (chunks === null && unicodeOverflow) {
    return fail('tar-unicode-overflow',
      `the non-ASCII-named snapshot members exceed a single tar command-line budget (${budget}); ` +
      `they cannot all ride the unicode-safe create chunk and bsdtar's append corrupts non-ASCII names`);
  }
  if (chunks === null) {
    return fail('tar-path-too-long',
      `a single snapshot member exceeds the per-spawn argv budget (${budget}) and cannot be chunked: ${tooLong}`);
  }

  // Empty list → one empty-archive create (no members). Otherwise: -c the first
  // chunk, -r (append) each subsequent chunk into the same archive.
  const batches = chunks.length === 0 ? [[]] : chunks;
  const ctx = { spawnFn, tarPath, archivePath, baseDir, cwd };
  for (let i = 0; i < batches.length; i += 1) {
    const mode = i === 0 ? '-c' : '-r';
    const err = await runTarChunk(ctx, mode, batches[i]);
    if (err) return fail('tar-create-failed', `tar ${mode === '-c' ? 'create' : 'append'} failed: ${err}`);
  }
  return { ok: true, archivePath, diagnostics: bag.all() };
}

/**
 * Spawn ONE tar create/append for a single chunk through safe-spawn. Returns an
 * error message string on failure (so the caller turns it into a diagnostic) or
 * null on success. `mode` is `-c` (create, first chunk) or `-r` (append). The
 * members are validated upstream (validateCreateArgs) and re-gated by the schema.
 * Never throws.
 * @param {{spawnFn:(spec:object)=>Promise<unknown>, tarPath:string, archivePath:string, baseDir:string, cwd:string}} ctx
 * @param {string} mode @param {string[]} members @returns {Promise<string|null>}
 */
async function runTarChunk(ctx, mode, members) {
  const { spawnFn, tarPath, archivePath, baseDir, cwd } = ctx;
  const args = [mode, '-f', archivePath, '-C', baseDir, ...members];
  try {
    await spawnFn({
      exe: tarPath, args, cwd, allowedCwds: [cwd],
      schema: tarSchema(args.length), timeoutMs: TAR_TIMEOUT_MS,
    });
    return null;
  } catch (e) {
    return errMsg(e);
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
    // Defense-in-depth: a non-relative member (absolute /\ , drive C:, or a
    // leading @ concat sigil) could make tar read a file OUTSIDE baseDir into
    // the archive. The walker only emits relative POSIX paths; refuse the rest.
    if (isNonRelativeMember(f)) return `files[] entry must be a relative path (no absolute/drive/@ prefix): ${f}`;
  }
  return '';
}

/** Message from an unknown thrown value; never throws. */
function errMsg(e) {
  return e instanceof Error ? e.message : String(e);
}
