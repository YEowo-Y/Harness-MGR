/**
 * safe-spawn: the ONLY sanctioned way harness-mgr launches an external process.
 *
 * Per plan P1-7 (spawned-write trust boundary): records per call an absolute
 * exe path + an argv schema (allowed flags/positionals) + an allowed cwd, and
 * REJECTS shell:true.
 *
 * SCOPE (clarification #5): this module is the validation + execFile GATE ONLY.
 * The post-hoc sha256 drift check that compares the target dir before/after a
 * spawned write is U8 (boundary.mjs) — NOT built here. This gate is what makes
 * that later check meaningful.
 *
 * execFile (NOT exec/spawn-with-shell) is used so arguments are passed as an
 * argv array with no shell interpolation. Zero npm dependencies.
 *
 * HARDENING (slash-flag gate): a `/`-prefixed token (e.g. icacls's /grant,
 * /deny) is treated as a FLAG by default — allowed ONLY if listed in
 * schema.allowedFlags — so Windows-style mutation flags are denied by default,
 * not merely by incidentally failing a positionalPattern. A consumer that
 * legitimately passes POSIX absolute-path positionals (which begin with `/`)
 * opts out via schema.allowSlashPositionals:true.
 */

import { execFile } from 'node:child_process';
import { isAbsolute } from 'node:path';

/**
 * @typedef {Object} ArgvSchema
 * @property {string[]} [allowedFlags]        exact flag tokens permitted (e.g. '-C', '--mirror')
 * @property {RegExp} [positionalPattern]     each non-flag token must match this
 * @property {number} [maxArgs]               hard cap on argv length
 * @property {boolean} [allowSlashPositionals]
 *   Secure-by-default switch for `/`-prefixed tokens. By DEFAULT (absent/false)
 *   a `/`-token is treated as a FLAG — allowed only if it appears in
 *   allowedFlags — so Windows-style mutation flags (icacls /grant, /deny, ...)
 *   are denied by the flag gate, not merely by incidentally failing
 *   positionalPattern. Set true ONLY for a consumer whose legitimate positionals
 *   are POSIX absolute paths (which begin with `/`, e.g. `node --check /abs.mjs`
 *   on Linux/macOS); then a `/`-token falls through to the positional branch and
 *   is validated by positionalPattern as before.
 */

/**
 * @typedef {Object} SafeSpawnSpec
 * @property {string} exe                     ABSOLUTE path to the executable
 * @property {string[]} args                  argv (no shell, no globbing)
 * @property {string} cwd                     working directory; must be in allowedCwds
 * @property {string[]} allowedCwds           allowlist of permitted cwd values
 * @property {ArgvSchema} [schema]            optional argv validation schema
 * @property {boolean} [shell]                MUST be false/absent; present-and-true is rejected
 * @property {number} [timeoutMs]
 */

export class SafeSpawnError extends Error {
  /** @param {string} message @param {string} code */
  constructor(message, code) {
    super(message);
    this.name = 'SafeSpawnError';
    this.code = code;
  }
}

/**
 * Validate a spec WITHOUT executing. Returns the validated spec or throws
 * SafeSpawnError. Exposed separately so callers (and later boundary.mjs) can
 * assert the gate in a pure (non-spawning) test.
 *
 * @param {SafeSpawnSpec} spec
 * @returns {SafeSpawnSpec}
 */
export function validateSpawnSpec(spec) {
  if (!spec || typeof spec !== 'object') {
    throw new SafeSpawnError('spec must be an object', 'spawn-bad-spec');
  }
  // Hard reject any attempt to run through a shell.
  if (spec.shell === true) {
    throw new SafeSpawnError('shell:true is forbidden', 'spawn-shell-forbidden');
  }
  if (typeof spec.exe !== 'string' || !isAbsolute(spec.exe)) {
    throw new SafeSpawnError(`exe must be an absolute path: ${String(spec.exe)}`, 'spawn-exe-not-absolute');
  }
  if (!Array.isArray(spec.args)) {
    throw new SafeSpawnError('args must be an array', 'spawn-args-not-array');
  }
  if (typeof spec.cwd !== 'string' || spec.cwd.length === 0) {
    throw new SafeSpawnError('cwd is required', 'spawn-cwd-missing');
  }
  if (!Array.isArray(spec.allowedCwds) || !spec.allowedCwds.includes(spec.cwd)) {
    throw new SafeSpawnError(`cwd not in allowlist: ${spec.cwd}`, 'spawn-cwd-not-allowed');
  }

  // H2: the argv schema is MANDATORY (deny-by-default). Without it, callers
  // (tar/git/claude mcp) would get unvalidated argv — the sole PREVENTIVE layer
  // for spawned writes (U8's drift check is detective-only).
  const schema = spec.schema;
  if (!schema || typeof schema !== 'object') {
    throw new SafeSpawnError('an argv schema is required (security gate)', 'spawn-schema-required');
  }
  if (Number.isInteger(schema.maxArgs) && spec.args.length > schema.maxArgs) {
    throw new SafeSpawnError(`argv exceeds maxArgs (${schema.maxArgs})`, 'spawn-argv-too-long');
  }
  for (const tok of spec.args) {
    if (typeof tok !== 'string') {
      throw new SafeSpawnError('argv tokens must be strings', 'spawn-argv-nonstring');
    }
    // Secure-by-default: `-`-tokens are always flags; `/`-tokens are flags too
    // UNLESS the consumer opted into POSIX absolute-path positionals. This shuts
    // the door on Windows-style mutation flags (icacls /grant, /deny, ...) by
    // default rather than relying on them incidentally failing positionalPattern.
    const isFlag =
      tok.startsWith('-') || (tok.startsWith('/') && schema.allowSlashPositionals !== true);
    if (isFlag) {
      // Flags: allowed ONLY if explicitly listed (no list => no flags).
      if (!schema.allowedFlags || !schema.allowedFlags.includes(tok)) {
        throw new SafeSpawnError(`flag not allowed: ${tok}`, 'spawn-flag-not-allowed');
      }
    } else {
      // Positionals: allowed ONLY via an explicit positionalPattern (no pattern
      // => no positionals — the write-target/RCE surface for tar/git).
      if (!schema.positionalPattern) {
        throw new SafeSpawnError(`positional not allowed (no positionalPattern): ${tok}`, 'spawn-positional-not-allowed');
      }
      if (!schema.positionalPattern.test(tok)) {
        throw new SafeSpawnError(`positional rejected by pattern: ${tok}`, 'spawn-positional-rejected');
      }
    }
  }
  return spec;
}

/**
 * Validate then run via execFile. Resolves { stdout, stderr }; rejects with the
 * validation error (before spawn) or the execFile error (after spawn).
 *
 * @param {SafeSpawnSpec} spec
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
export function safeSpawn(spec) {
  let valid;
  try {
    valid = validateSpawnSpec(spec);
  } catch (err) {
    return Promise.reject(err);
  }
  return new Promise((resolve, reject) => {
    execFile(
      valid.exe,
      valid.args,
      { cwd: valid.cwd, timeout: valid.timeoutMs ?? 0, shell: false, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) reject(err);
        else resolve({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}
