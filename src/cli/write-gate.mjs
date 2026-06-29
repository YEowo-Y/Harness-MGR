/**
 * Write-gate for the governed-config write commands (P3.U22 / off-ramp 2026-06-09).
 *
 * ORIGINAL (Phase-3 soak): required BOTH `--apply` AND `HARNESS_MGR_ENABLE_WRITES=1`.
 * RELAXED  (evidence-driven off-ramp, conditions (a)+(b)+(c) all met 2026-06-09):
 *   `--apply` alone now enables writes.  The env var becomes an EXPLICIT OPT-OUT
 *   lock: set `HARNESS_MGR_ENABLE_WRITES=0` to hard-disable writes (e.g. in CI or
 *   scripts that should never mutate governed config).  Setting it to `1` continues
 *   to work for backward-compatibility; any other value (unset, empty, "true", …)
 *   is treated as "not locked" and writes proceed when `--apply` is given.
 *
 * This module is the SINGLE SOURCE for that decision so every write command reads
 * the gate identically (no per-command env-string drift). It is PURE and
 * NEVER-THROWS: it reads only the two inputs it is handed, tolerates a
 * null/undefined `env`, and builds plain Diagnostic literals (it imports nothing).
 *
 * Decision table (post-relaxation):
 *   apply falsy                                   → dry-run; enableWrites:false, no refusal.
 *   apply truthy + env.trim() === '0'             → REFUSED; enableWrites:false, code:3 +
 *                                                   a `writes-disabled-env` error Diagnostic.
 *                                                   Whitespace-trimmed so ' 0', '0\n', '\t0'
 *                                                   etc. all lock correctly in CI pipelines.
 *   apply truthy + env === '1' (back-compat)      → enabled; enableWrites:true,  no refusal.
 *   apply truthy + env unset / any other val      → enabled; enableWrites:true,  no refusal.
 *   NOTE: 'false', '00', '0x' do NOT lock (only the digit zero, trimmed).
 *
 * `code:3` mirrors the rollback orchestrator's "refused" exit-code HINT so the CLI
 * surfaces a non-zero, non-crash exit when the gate is closed.
 *
 * Zero npm dependencies. Node stdlib only. Never throws.
 */

/** @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic */

/** The env var name; set to '0' to explicitly lock writes (opt-out). */
const ENABLE_WRITES_ENV = 'HARNESS_MGR_ENABLE_WRITES';
/**
 * The value that locks writes (whitespace-trimmed before comparison so CI
 * pipelines that produce ' 0', '0\n', or '\t0' are treated identically to
 * a bare '0').  Everything else — unset, '1', 'false', empty — allows writes.
 */
const DISABLE_WRITES_VALUE = '0';

/**
 * Resolve whether governed-config writes are permitted for this invocation.
 *
 * @param {object} opts
 * @param {boolean} [opts.apply]  the `--apply` flag (the first factor).
 * @param {Record<string, string|undefined>|null} [opts.env]  the environment
 *        (production passes `process.env`; tests pass a fake object). A
 *        null/undefined env is treated as "not locked" and never dereferenced
 *        unsafely.
 * @returns {{ enableWrites: boolean, refusal: Diagnostic|null, code: number|null }}
 *          `enableWrites` true when `--apply` is given and env is not locked;
 *          `refusal` is a ready-to-surface error Diagnostic (and `code` its
 *          exit-code HINT) only when `--apply` was requested but the env opt-out
 *          lock is set — otherwise both are null.
 */
export function resolveWriteIntent({ apply, env } = {}) {
  // No --apply → dry-run. The env factor is irrelevant; never a refusal.
  if (!apply) {
    return { enableWrites: false, refusal: null, code: null };
  }

  // --apply present: check for the explicit opt-out lock.  The raw env value is
  // trimmed before comparison so CI values like ' 0', '0\n', '\t0' reliably lock.
  // A null/undefined env, unset var, '1', 'false', or any other value → enabled.
  const raw = env && typeof env[ENABLE_WRITES_ENV] === 'string'
    ? env[ENABLE_WRITES_ENV].trim()
    : undefined;
  const lockedOut = raw === DISABLE_WRITES_VALUE;
  if (!lockedOut) {
    return { enableWrites: true, refusal: null, code: null };
  }

  return {
    enableWrites: false,
    code: 3,
    refusal: {
      severity: 'error',
      code: 'writes-disabled-env',
      phase: 'cli',
      message:
        '--apply requested but governed-config writes are locked out; unset HARNESS_MGR_ENABLE_WRITES (or set it to any value other than "0") to allow writes',
      fix: 'unset HARNESS_MGR_ENABLE_WRITES (or remove the =0 value) and re-run with --apply',
    },
  };
}

/**
 * Pick the governed-write gate (`assertWritable`) for the active target (P6 write wave).
 *
 * A target whose descriptor carries a `writeSurface` (Codex) needs a gate BOUND to its
 * own config dir + state dir + surface — the bare `paths.assertWritable` is bound to
 * `~/.claude` (it resolves `targetClaudeDir()` internally) and would reject a
 * `~/.codex/...` write as `write-outside-target`. The default target (Claude, no
 * `writeSurface`) keeps the bare `paths.assertWritable` so existing behavior + test seams
 * are byte-identical.
 *
 * Pure router: it receives the already-imported `paths` module (so it imports nothing
 * itself) and returns the gate function. Reused by every codex write command
 * (snapshot/rollback/remove). Never throws — a missing descriptor/dir falls back to the
 * default gate.
 *
 * @param {{assertWritable: Function, makeAssertWritable: Function}} paths  the imported paths.mjs
 * @param {{descriptor?: {writeSurface?: object}, configDir?: string, mgrStateDir?: string}} ctx
 * @returns {(target: string, context?: string) => string}
 */
export function resolveAssertWritable(paths, ctx) {
  const c = ctx && typeof ctx === 'object' ? ctx : {};
  const surface = c.descriptor && typeof c.descriptor === 'object' ? c.descriptor.writeSurface : undefined;
  if (surface && typeof paths.makeAssertWritable === 'function'
    && typeof c.configDir === 'string' && typeof c.mgrStateDir === 'string') {
    return paths.makeAssertWritable({ configDir: c.configDir, mgrStateDir: c.mgrStateDir, surface });
  }
  return paths.assertWritable;
}
