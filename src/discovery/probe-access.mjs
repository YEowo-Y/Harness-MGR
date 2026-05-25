/**
 * Access passive probe gatherer (P2.U6b-3).
 *
 * Performs the read-only I/O behind two doctor checks — keeping the doctor
 * itself pure (no I/O) by gathering facts here in the discovery layer:
 *
 *   #17 windows-file-locks — attempt a shared READ open of settings.json and
 *                            close it immediately. Success → free. A lock-type
 *                            error code → locked. ENOENT → absent.
 *                            Limitation: a read-open detects only EXCLUSIVE
 *                            locks; shared locks held by other readers will not
 *                            surface. This is the honest behaviour for a
 *                            dry-run tool that only reads.
 *
 *   #24 insecure-permissions — icacls-based ACL probe (async, Windows only).
 *                            Reads the ACL of .mgr-state/ via a read-only
 *                            `icacls <path>` invocation (no side effects).
 *                            Skipped on non-Windows and when the dir is absent.
 *
 * Never throws. Degrades to diagnostics on any bad input. Zero npm
 * dependencies. Node stdlib only.
 */

import { join } from 'node:path';
import { openSync, closeSync, statSync } from 'node:fs';
import os from 'node:os';
import { DiagnosticBag } from '../lib/diagnostic.mjs';
import { safeSpawn } from '../lib/safe-spawn.mjs';

/**
 * @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic
 */

/**
 * @typedef {Object} LockFact
 * @property {string} path    absolute path to the file that was probed
 * @property {'free'|'locked'|'absent'|'indeterminate'} status
 *   - free          opened and closed with no error (no exclusive lock detected)
 *   - locked        OS returned EBUSY / EACCES / EPERM / ELOCK (file locked)
 *   - absent        ENOENT — the file does not exist (benign; no settings.json)
 *   - indeterminate an unexpected error; cannot determine lock status
 */

/** Error codes that indicate a lock rather than absence or an unknown error. */
const LOCK_CODES = new Set(['EBUSY', 'EACCES', 'EPERM', 'ELOCK']);

/**
 * The real opener used by default — opens the file for reading (shared) and
 * immediately closes the descriptor. Throws on any OS error (mirrors node:fs).
 * @param {string} p  absolute path
 * @returns {void}
 */
function defaultOpenFn(p) {
  const fd = openSync(p, 'r');
  closeSync(fd);
}

/**
 * Classify a caught error from openFn into a LockFact status.
 * @param {unknown} err
 * @returns {'locked'|'absent'|'indeterminate'}
 */
function classifyError(err) {
  if (err && typeof err === 'object') {
    const code = /** @type {any} */ (err).code;
    if (code === 'ENOENT') return 'absent';
    if (LOCK_CODES.has(code)) return 'locked';
  }
  return 'indeterminate';
}

/**
 * Gather the passive settings.json lock fact for the doctor layer.
 *
 * @param {{ configDir?: string, openFn?: (path: string) => void }} opts
 * @returns {{ lock: LockFact | null, diagnostics: Diagnostic[] }}
 */
export function gatherLockProbe(opts) {
  const bag = new DiagnosticBag();
  const { configDir, openFn } = opts ?? {};

  if (typeof configDir !== 'string' || configDir.length === 0) {
    bag.add({ severity: 'error', code: 'discover-bad-root', message: 'configDir must be a non-empty string', phase: 'access-probe' });
    return { lock: null, diagnostics: bag.all() };
  }

  const target = join(configDir, 'settings.json');
  const opener = typeof openFn === 'function' ? openFn : defaultOpenFn;

  /** @type {'free'|'locked'|'absent'|'indeterminate'} */
  let status;
  try {
    opener(target);
    status = 'free';
  } catch (err) {
    status = classifyError(err);
  }

  return { lock: { path: target, status }, diagnostics: bag.all() };
}

// ---------------------------------------------------------------------------
// #24 insecure-permissions — Windows ACL probe via icacls
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} AclFact
 * @property {string} path  absolute path that was probed
 * @property {'owner-only'|'broad'|'absent'|'unsupported'|'indeterminate'} status
 *   - owner-only   ACL parsed; no broad principals found
 *   - broad        ACL parsed; at least one broad principal (Everyone/Users/Authenticated Users)
 *   - absent       path does not exist (ENOENT) — icacls was not spawned
 *   - unsupported  platform is not win32 — icacls not available
 *   - indeterminate ACL could not be determined (spawn error / unparseable output)
 * @property {string[]} broadPrincipals  the broad principal tokens found (sorted); [] when status !== 'broad'
 */

/**
 * The set of bare names (part after the last backslash, or the whole token)
 * that make a principal "broad" (grants wide-open access beyond the owner).
 * Comparison is done via .toLowerCase().
 */
const BROAD_NAMES = new Set(['everyone', 'users', 'authenticated users']);

/**
 * Parse the stdout of `icacls <path>` into an AclFact.
 *
 * icacls prints one ACE per line. The FIRST line also contains the probed path
 * before the first principal token, e.g.:
 *
 *   C:\Users\me\.mgr-state NT AUTHORITY\SYSTEM:(OI)(CI)(F)
 *                           BUILTIN\Administrators:(OI)(CI)(F)
 *                           DESKTOP-X\me:(F)
 *   Successfully processed 1 files; Failed processing 0 files
 *
 * We extract every principal via a global regex matching `(\S+):\(` — capture
 * group 1 is the principal token (e.g. `BUILTIN\Users`, `Everyone`). NOTE: a
 * path that literally contains `:(' could confuse this regex on the first line
 * — this is an accepted limitation. NOTE: a principal containing a space is
 * captured as only its LAST token (e.g. `NT AUTHORITY\Authenticated Users` →
 * `Users`); the broad/not-broad verdict stays correct, but a custom group whose
 * last word is a BROAD_NAMES entry (e.g. `Remote Desktop Users` → `Users`) is a
 * known false-positive — accepted for this advisory-only, Windows-only check.
 *
 * A principal is broad if its bare name (part after the last `\`, or the whole
 * token when no `\` is present), lowercased, is in BROAD_NAMES.
 *
 * @param {string} stdout
 * @param {string} path
 * @returns {AclFact}
 */
export function parseIcaclsAcl(stdout, path) {
  /** @type {string[]} */
  const principals = [];
  const re = /(\S+):\(/g;
  let m;
  while ((m = re.exec(stdout)) !== null) {
    principals.push(m[1]);
  }

  if (principals.length === 0) {
    return { path, status: 'indeterminate', broadPrincipals: [] };
  }

  /** @type {string[]} */
  const broad = [];
  for (const p of principals) {
    const slash = p.lastIndexOf('\\');
    const bare = slash >= 0 ? p.slice(slash + 1) : p;
    if (BROAD_NAMES.has(bare.toLowerCase())) {
      broad.push(p);
    }
  }

  if (broad.length > 0) {
    const unique = [...new Set(broad)].sort();
    return { path, status: 'broad', broadPrincipals: unique };
  }
  return { path, status: 'owner-only', broadPrincipals: [] };
}

/**
 * Default icacls runner — uses safeSpawn (the only sanctioned spawn path).
 * Tests inject `runIcacls` so they never spawn real icacls.
 *
 * Security note: only ONE positional (the path) is passed, validated by the
 * schema's positionalPattern (a drive-lettered path). icacls MUTATION flags
 * (/grant, /deny, /remove, /inheritance, ...) begin with `/`, not `-`, so they
 * are blocked here by FAILING positionalPattern (a `/`-token is not a path) —
 * NOT by safeSpawn's flag gate, which only rejects `-`-prefixed tokens. maxArgs:1
 * additionally forbids injecting a second argument.
 * @param {string} aclDir
 * @returns {Promise<string>}  resolves with stdout
 */
async function defaultRunIcacls(aclDir) {
  const exe = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'icacls.exe');
  const result = await safeSpawn({
    exe,
    args: [aclDir],
    cwd: os.tmpdir(),
    allowedCwds: [os.tmpdir()],
    schema: { positionalPattern: /^[A-Za-z]:[\\/].+/, maxArgs: 1 },
    timeoutMs: 5000,
  });
  return result.stdout;
}

/**
 * Gather the passive ACL fact for the doctor layer (#24).
 *
 * - Non-win32 platform → status 'unsupported' (no spawn).
 * - Bad/empty aclDir → discover-bad-root error + { acl: null }.
 * - ENOENT on stat → status 'absent' (no spawn — dir not created yet is benign).
 * - Other stat error → status 'indeterminate'.
 * - Otherwise calls runIcacls and parses the output.
 *
 * Never rejects.
 *
 * @param {{ aclDir?: string, platform?: string, runIcacls?: (dir: string) => Promise<string>, statFn?: (p: string) => unknown }} opts
 *   statFn is an injectable existence-check seam (default node:fs statSync); tests use it to exercise the non-ENOENT → indeterminate branch.
 * @returns {Promise<{ acl: AclFact|null, diagnostics: Diagnostic[] }>}
 */
export async function gatherAclProbe(opts) {
  const bag = new DiagnosticBag();
  const { aclDir, platform = process.platform, runIcacls = defaultRunIcacls, statFn = statSync } = opts ?? {};

  if (platform !== 'win32') {
    return { acl: { path: aclDir || '', status: 'unsupported', broadPrincipals: [] }, diagnostics: [] };
  }

  if (typeof aclDir !== 'string' || aclDir.length === 0) {
    bag.add({ severity: 'error', code: 'discover-bad-root', message: 'aclDir must be a non-empty string', phase: 'access-probe' });
    return { acl: null, diagnostics: bag.all() };
  }

  // Check existence before spawning — absent is benign (.mgr-state may not exist yet).
  try {
    statFn(aclDir);
  } catch (err) {
    const code = err && typeof err === 'object' ? /** @type {any} */ (err).code : null;
    const status = code === 'ENOENT' ? 'absent' : 'indeterminate';
    return { acl: { path: aclDir, status, broadPrincipals: [] }, diagnostics: bag.all() };
  }

  // Spawn icacls and parse output.
  try {
    const stdout = await runIcacls(aclDir);
    const acl = parseIcaclsAcl(stdout, aclDir);
    return { acl, diagnostics: bag.all() };
  } catch {
    return { acl: { path: aclDir, status: 'indeterminate', broadPrincipals: [] }, diagnostics: bag.all() };
  }
}
