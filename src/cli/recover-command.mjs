/**
 * CLI handler for `recover <id> [--mark-failed|--resume|--rollback|--from-manifest]
 * [--force] [--apply]` (P3.U22).
 *
 * Drives the already-built crash-recovery engine (src/ops/recover.mjs) from the
 * command line, behind the two-factor write gate (`resolveWriteIntent`: `--apply`
 * AND `CLAUDE_MGR_ENABLE_WRITES=1`). The flag → mode mapping is here; the engine
 * dispatches on the resolved mode.
 *
 * MODE ASYMMETRY (vs rollbackCommand): recover's shared validation
 * (recover-shared.mjs::validateRecoverTarget) treats `assertWritable` as REQUIRED
 * for EVERY mode — even a dry-run --rollback/--from-manifest preview. So unlike
 * rollbackCommand (which loads paths.mjs ONLY on the real --apply path), this
 * handler ALWAYS resolves the write gate before calling the engine. Two further
 * asymmetries follow:
 *   • --mark-failed / --resume have NO dry-run — they always write the journal — so
 *     they REFUSE up front (code:3, recover-needs-apply) when the gate is closed,
 *     never loading paths.mjs or the engine.
 *   • --rollback / --from-manifest are dry-run-by-default: a bare invocation still
 *     loads the gate (recover requires it) and runs the engine with
 *     enableWrites:false (read-only preview, touches nothing governed).
 *
 * M2-SAFETY: this module never STATICALLY imports src/paths.mjs (its top-level await
 * rejects when `~/.claude/hooks/lib` is absent). The gate is resolved via a DYNAMIC
 * `import()`, guarded so a failure degrades to a `recover-unavailable` warn.
 *
 * `deps` is the injectable test seam (mirrors rollbackCommand): a fake `loadPaths`,
 * a recording `recoverFn`, and an injected `env` make every path hermetic.
 *
 * Never throws — recover is ops-pure/never-throws, the dynamic import is guarded, and
 * the summary helper is fully defensive.
 *
 * Spec: plan claude-mgr-v5.md, P3.U22 (wire the write commands into the CLI).
 *
 * Zero npm dependencies. Node stdlib only.
 */

import { recover } from '../ops/recover.mjs';
import { resolveWriteIntent } from './write-gate.mjs';

/** @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic */
/** @typedef {import('./commands.mjs').CommandContext} CommandContext */
/** @typedef {import('./commands.mjs').CommandOutput} CommandOutput */

/** The recover modes that ALWAYS write the journal (no dry-run preview). */
const ALWAYS_WRITE_MODES = new Set(['mark-failed', 'resume']);

/**
 * Resolve the recover mode from the four boolean flags. Returns the single chosen
 * mode, or a discriminated refusal when zero/many are set. None → the engine's
 * default 'mark-failed'; exactly one → that mode; more than one → ambiguous.
 * @param {Record<string, unknown>} args
 * @returns {{ mode: string } | { ambiguous: true }}
 */
function resolveMode(args) {
  const flags = [
    ['mark-failed', args['mark-failed']],
    ['resume', args.resume],
    ['rollback', args.rollback],
    ['from-manifest', args['from-manifest']],
  ];
  const chosen = flags.filter(([, on]) => !!on).map(([name]) => name);
  if (chosen.length > 1) return { ambiguous: true };
  if (chosen.length === 0) return { mode: 'mark-failed' };
  return { mode: chosen[0] };
}

/**
 * Shape a RecoverResult into a LEAN, flat summary for the table renderer. Fully
 * defensive / TOTAL — the body is wrapped so even a pathological result (a throwing
 * getter) degrades to a constant summary instead of throwing; this helper feeds only
 * the cosmetic `result` payload and must never derail the command. `restored` reads
 * the nested rollback restore flag (rollback/from-manifest modes) or null otherwise.
 * @param {import('../ops/recover-shared.mjs').RecoverResult} r
 * @returns {object}
 */
function summarizeRecover(r) {
  const o = r && typeof r === 'object' ? r : {};
  try {
    return {
      mode: o.mode ?? null,
      ok: !!o.ok,
      dryRun: !!o.dryRun,
      snapshotId: o.snapshotId ?? null,
      state: o.state ?? null,
      journalPath: o.journalPath ?? null,
      restored: o.rollback && typeof o.rollback === 'object'
        && o.rollback.restore && typeof o.rollback.restore === 'object'
        ? !!o.rollback.restore.restored : null,
    };
  } catch {
    return { mode: null, ok: false, dryRun: false, snapshotId: null,
      state: null, journalPath: null, restored: null };
  }
}

/**
 * Resolve the governed-write gate (DYNAMIC, M2-safe paths.mjs import) recover needs
 * for EVERY mode. On success returns `{ assertWritable }`; on import failure returns
 * `{ refusal }` — a ready CommandOutput degrading to a `recover-unavailable` warn.
 * @param {() => Promise<{assertWritable: Function}>} loadPaths
 * @param {string} mode
 * @returns {Promise<{assertWritable: Function}|{refusal: CommandOutput & {code: number}}>}
 */
async function resolveGate(loadPaths, mode) {
  try {
    const paths = await loadPaths();
    return { assertWritable: paths.assertWritable };
  } catch (err) {
    return {
      refusal: {
        result: { status: 'write-unavailable', mode },
        diagnostics: [{
          severity: 'warn', code: 'recover-unavailable', phase: 'cli',
          message: `~/.claude/hooks/lib unloadable; recover needs the write gate: ${err instanceof Error ? err.message : String(err)}`,
        }],
        code: 1,
      },
    };
  }
}

/**
 * Call the recover engine, guarding the await so a buggy/injected seam that throws
 * degrades to a clean `recover-unexpected-error` result instead of escaping. On
 * success returns `{ result: <RecoverResult> }`; on throw `{ refusal }`.
 * @param {typeof recover} recoverFn @param {object} callOpts @param {string} mode
 * @returns {Promise<{result: object}|{refusal: CommandOutput & {code: number}}>}
 */
async function runEngine(recoverFn, callOpts, mode) {
  try {
    return { result: await recoverFn(callOpts) };
  } catch (err) {
    return {
      refusal: {
        result: { status: 'error', mode },
        diagnostics: [{
          severity: 'error', code: 'recover-unexpected-error', phase: 'cli',
          message: `recover failed unexpectedly: ${err instanceof Error ? err.message : String(err)}`,
        }],
        code: 1,
      },
    };
  }
}

/**
 * Drive `recover` from the CLI. Reads the snapshot id from
 * `ctx.args.positionals[0]`, resolves the mode + two-factor gate, and (recover
 * requires the gate for ALL modes) dynamically resolves the governed-write gate.
 *
 * @param {CommandContext} ctx  { configDir, mgrStateDir, args } (args may be null-proto)
 * @param {{loadPaths?: () => Promise<{assertWritable: Function}>, recoverFn?: typeof recover, env?: Record<string, string|undefined>}} [deps]
 * @returns {Promise<CommandOutput & {code: number}>}
 */
export async function recoverCommand(ctx, deps = {}) {
  const args = ctx && ctx.args ? ctx.args : {};
  const id = args && Array.isArray(args.positionals) ? args.positionals[0] : undefined;
  if (typeof id !== 'string' || id.length === 0) {
    return {
      result: { status: 'no-id' },
      diagnostics: [{
        severity: 'error', code: 'recover-no-id', phase: 'cli',
        message: 'recover requires a snapshot id: recover <id> [--mark-failed|--resume|--rollback|--from-manifest] [--force] [--apply]',
      }],
      code: 3,
    };
  }

  const resolved = resolveMode(args);
  if ('ambiguous' in resolved) {
    return {
      result: { status: 'ambiguous-mode' },
      diagnostics: [{
        severity: 'error', code: 'recover-ambiguous-mode', phase: 'cli',
        message: 'pass exactly one of --mark-failed / --resume / --rollback / --from-manifest',
      }],
      code: 3,
    };
  }
  const { mode } = resolved;

  const force = !!(args && args.force);
  const apply = !!(args && args.apply);
  const env = deps.env ?? process.env;

  // Two-factor gate: --apply alone is not enough; CLAUDE_MGR_ENABLE_WRITES=1 is the
  // second factor. A closed gate REFUSES here — the engine is never called.
  const intent = resolveWriteIntent({ apply, env });
  if (intent.refusal) {
    return { result: { status: 'refused', mode }, diagnostics: [intent.refusal], code: intent.code };
  }

  // ALWAYS-WRITE modes have NO dry-run: refuse up front when the gate is closed so we
  // never load paths.mjs or the engine for a write the user didn't arm.
  if (ALWAYS_WRITE_MODES.has(mode) && !intent.enableWrites) {
    return {
      result: { status: 'needs-apply', mode },
      diagnostics: [{
        severity: 'error', code: 'recover-needs-apply', phase: 'cli',
        message: `recover --${mode} writes the apply journal; it needs --apply and CLAUDE_MGR_ENABLE_WRITES=1 (no dry-run for this mode)`,
      }],
      code: 3,
    };
  }

  // recover REQUIRES the gate injected for ALL modes (even dry-run rollback/from-
  // manifest), so ALWAYS resolve it. paths.mjs is imported DYNAMICALLY (M2-safe);
  // a failure degrades to a warn (see resolveGate).
  const gate = await resolveGate(deps.loadPaths ?? (() => import('../paths.mjs')), mode);
  if ('refusal' in gate) return gate.refusal;

  const engine = await runEngine(deps.recoverFn ?? recover, {
    mode,
    snapshotId: id,
    mgrStateDir: ctx.mgrStateDir,
    targetClaudeDir: ctx.configDir,
    assertWritable: gate.assertWritable,
    force,
    enableWrites: intent.enableWrites,
    expectedTarget: ctx.configDir,
  }, mode);
  if ('refusal' in engine) return engine.refusal;

  const o = engine.result && typeof engine.result === 'object' ? engine.result : {};
  return {
    result: summarizeRecover(o),
    diagnostics: Array.isArray(o.diagnostics) ? o.diagnostics.slice() : [],
    code: typeof o.code === 'number' ? o.code : (o.ok ? 0 : 1),
  };
}
