/**
 * Write-gate for the governed-config write commands (P3.U22 / off-ramp 2026-06-09).
 *
 * ORIGINAL (Phase-3 soak): required BOTH `--apply` AND `CLAUDE_MGR_ENABLE_WRITES=1`.
 * RELAXED  (evidence-driven off-ramp, conditions (a)+(b)+(c) all met 2026-06-09):
 *   `--apply` alone now enables writes.  The env var becomes an EXPLICIT OPT-OUT
 *   lock: set `CLAUDE_MGR_ENABLE_WRITES=0` to hard-disable writes (e.g. in CI or
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
 *   apply falsy                              → dry-run; enableWrites:false, no refusal.
 *   apply truthy + env === '0'               → REFUSED; enableWrites:false, code:3 +
 *                                              a `writes-disabled-env` error Diagnostic.
 *   apply truthy + env === '1' (back-compat) → enabled; enableWrites:true,  no refusal.
 *   apply truthy + env unset / any other val → enabled; enableWrites:true,  no refusal.
 *
 * `code:3` mirrors the rollback orchestrator's "refused" exit-code HINT so the CLI
 * surfaces a non-zero, non-crash exit when the gate is closed.
 *
 * Zero npm dependencies. Node stdlib only. Never throws.
 */

/** @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic */

/** The env var name; set to '0' to explicitly lock writes (opt-out). */
const ENABLE_WRITES_ENV = 'CLAUDE_MGR_ENABLE_WRITES';
/** The ONLY value that locks writes; everything else (incl. unset / '1') allows. */
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

  // --apply present: check for the explicit opt-out lock (only exact '0' locks).
  // A null/undefined env, unset var, '1', or any other value → writes enabled.
  const lockedOut = !!env && env[ENABLE_WRITES_ENV] === DISABLE_WRITES_VALUE;
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
        '--apply requested but governed-config writes are locked out; unset CLAUDE_MGR_ENABLE_WRITES (or set it to any value other than "0") to allow writes',
      fix: 'unset CLAUDE_MGR_ENABLE_WRITES (or remove the =0 value) and re-run with --apply',
    },
  };
}
