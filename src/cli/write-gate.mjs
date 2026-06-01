/**
 * Two-factor write gate for the governed-config write commands (P3.U22).
 *
 * The Phase-3 write commands (apply / rollback / recover) are held behind a
 * deliberately-annoying SAFETY GATE while the 30-day stability soak runs: a
 * user must BOTH pass `--apply` AND export `CLAUDE_MGR_ENABLE_WRITES=1` before any
 * governed-config file is touched. `--apply` alone is a strong intent signal but
 * is easy to fat-finger; the env var is a second, deliberate out-of-band switch
 * that a mistyped flag or a copy-pasted command line can't accidentally satisfy.
 *
 * This module is the SINGLE SOURCE for that decision so every write command reads
 * the gate identically (no per-command env-string drift). It is PURE and
 * NEVER-THROWS: it reads only the two inputs it is handed, tolerates a
 * null/undefined `env`, and builds plain Diagnostic literals (it imports nothing).
 *
 * Decision table:
 *   apply falsy                          → dry-run; enableWrites:false, no refusal.
 *   apply truthy + env === '1'           → enabled; enableWrites:true,  no refusal.
 *   apply truthy + env !== '1' (or unset)→ REFUSED; enableWrites:false, code:3 +
 *                                          a `writes-disabled-env` error Diagnostic.
 *
 * `code:3` mirrors the rollback orchestrator's "refused" exit-code HINT so the CLI
 * surfaces a non-zero, non-crash exit when the gate is closed.
 *
 * Zero npm dependencies. Node stdlib only. Never throws.
 */

/** @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic */

/** The env var name that arms governed-config writes (the second factor). */
const ENABLE_WRITES_ENV = 'CLAUDE_MGR_ENABLE_WRITES';
/** The exact value required — only '1' enables; '0'/'true'/'' all stay closed. */
const ENABLE_WRITES_VALUE = '1';

/**
 * Resolve whether governed-config writes are permitted for this invocation.
 *
 * @param {object} opts
 * @param {boolean} [opts.apply]  the `--apply` flag (the first factor).
 * @param {Record<string, string|undefined>|null} [opts.env]  the environment
 *        (production passes `process.env`; tests pass a fake `{}`). A null/undefined
 *        env is treated as "not set" and never dereferenced unsafely.
 * @returns {{ enableWrites: boolean, refusal: Diagnostic|null, code: number|null }}
 *          `enableWrites` true only when BOTH factors are present; `refusal` is a
 *          ready-to-surface error Diagnostic (and `code` its exit-code HINT) only
 *          when `--apply` was requested but the env factor is missing — otherwise
 *          both are null.
 */
export function resolveWriteIntent({ apply, env } = {}) {
  // No --apply → dry-run. The env factor is irrelevant; never a refusal.
  if (!apply) {
    return { enableWrites: false, refusal: null, code: null };
  }

  // --apply present: the env factor must be exactly '1'. Tolerate a null/undefined
  // env (read defensively) — a missing env reads as not-armed.
  const armed = !!env && env[ENABLE_WRITES_ENV] === ENABLE_WRITES_VALUE;
  if (armed) {
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
        '--apply requested but governed-config writes are disabled; set CLAUDE_MGR_ENABLE_WRITES=1 to enable (the Phase-3 stability safety gate)',
      fix: 'set CLAUDE_MGR_ENABLE_WRITES=1 in the environment and re-run with --apply',
    },
  };
}
