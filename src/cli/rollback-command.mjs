/**
 * CLI handler for `rollback <id> [--force] [--apply]` (P3.U22).
 *
 * The first piece of CLI wiring that drives the already-built `rollbackSnapshot`
 * engine (src/ops/rollback.mjs) from the command line, behind the two-factor write
 * gate (`resolveWriteIntent`: `--apply`; `HARNESS_MGR_ENABLE_WRITES=0` force-locks writes).
 *
 * DRY-RUN BY DEFAULT, like the engine: a bare `rollback <id>` runs the read-only
 * preflight (drift-check + archive verify) and reports what WOULD happen, touching
 * nothing — no lock, no write gate, no restore. `--apply` (with the env factor set)
 * acquires the apply lock and restores the snapshot's bytes onto the live tree.
 *
 * M2-SAFETY: this module never STATICALLY imports src/paths.mjs — the write gate
 * (`assertWritable`) + dirs are injected/dynamically resolved, keeping this module's
 * static graph paths.mjs-free (the M2-safe property the boundary self-check enforces).
 * The gate is resolved via a DYNAMIC `import()` ONLY on the real --apply path (mirrors
 * snapshotCommand in ops-commands.mjs) and is wrapped in try/catch so that if its load
 * ever fails the command degrades to a `rollback-write-unavailable` warn instead of
 * crashing (defence-in-depth). (Historically paths.mjs -> reexport.mjs top-level-awaited
 * and rejected when `~/.claude/hooks/lib` was absent; the resolver is first-party now, so
 * that specific reject is gone.) The dry-run path needs no gate, so paths.mjs is never
 * reached there.
 *
 * `deps` is the injectable test seam (mirrors snapshotCommand): fake `loadPaths` +
 * `rollbackFn` + `env` make every path hermetically unit-testable without a real
 * gate / lock / drift / verify / restore / fs.
 *
 * Never throws — rollbackSnapshot is ops-pure/never-throws, the dynamic import is
 * guarded, and the summary helper is fully defensive.
 *
 * Spec: plan harness-mgr-v5.md, P3.U22 (wire the write commands into the CLI).
 *
 * Zero npm dependencies. Node stdlib only.
 */

import { rollbackSnapshot } from '../ops/rollback.mjs';
import { resolveWriteIntent, resolveAssertWritable } from './write-gate.mjs';

/** @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic */
/** @typedef {import('./commands.mjs').CommandContext} CommandContext */
/** @typedef {import('./commands.mjs').CommandOutput} CommandOutput */

/**
 * Shape a RollbackResult into a LEAN, flat summary for the table renderer. Fully
 * defensive — a dry-run has no `restore`/`lock`, and the ops-layer RestoreResult's
 * `restored` is a BOOLEAN flag (not an array), so every field is coerced to a safe
 * scalar / null. GENUINELY TOTAL: the body is wrapped so even a pathological result
 * (a property that is a throwing getter) degrades to a constant summary instead of
 * throwing — this helper feeds only the cosmetic `result` payload and must never be
 * able to derail the command (review LOW-1; the gate/exit decision is independent).
 *
 * @param {import('../ops/rollback.mjs').RollbackResult} r
 * @returns {object}
 */
function summarizeRollback(r) {
  const o = r && typeof r === 'object' ? r : {};
  try {
    return {
      status: o.status ?? null,
      ok: !!o.ok,
      dryRun: !!o.dryRun,
      snapshotId: o.snapshotId ?? null,
      driftClean: o.drift && typeof o.drift === 'object' ? (o.drift.clean ?? null) : null,
      // `restored` is the ops-layer boolean; `restoredCount` stays for a future
      // array-shaped result (then null) so the table has a real signal either way.
      restored: o.restore && typeof o.restore === 'object' ? !!o.restore.restored : null,
      restoredCount: o.restore && Array.isArray(o.restore.restored) ? o.restore.restored.length : null,
      skippedCount: o.restore && Array.isArray(o.restore.skipped) ? o.restore.skipped.length : null,
      lockAcquired: o.lock ? !!o.lock.acquired : false,
    };
  } catch {
    return { status: 'summary-error', ok: false, dryRun: false, snapshotId: null,
      driftClean: null, restored: null, restoredCount: null, skippedCount: null, lockAcquired: false };
  }
}

/**
 * Drive `rollbackSnapshot` from the CLI. Reads the snapshot id from
 * `ctx.args.positionals[0]`, applies the two-factor write gate, and (only on the
 * real --apply path) dynamically resolves the governed-write gate.
 *
 * @param {CommandContext} ctx  { configDir, mgrStateDir, args } (args may be null-proto)
 * @param {{loadPaths?: () => Promise<{assertWritable: Function}>, rollbackFn?: typeof rollbackSnapshot, env?: Record<string, string|undefined>}} [deps]
 * @returns {Promise<CommandOutput & {code: number}>}
 */
export async function rollbackCommand(ctx, deps = {}) {
  const args = ctx && ctx.args ? ctx.args : {};
  const id = args && Array.isArray(args.positionals) ? args.positionals[0] : undefined;
  if (typeof id !== 'string' || id.length === 0) {
    return {
      result: { status: 'no-id' },
      diagnostics: [{
        severity: 'error', code: 'rollback-no-id', phase: 'cli',
        message: 'rollback requires a snapshot id: rollback <id> [--force] [--apply]',
      }],
      code: 3,
    };
  }

  const force = !!(args && args.force);
  const apply = !!(args && args.apply);
  const env = deps.env ?? process.env;

  // Write gate: --apply enables the write; HARNESS_MGR_ENABLE_WRITES=0 is an explicit
  // opt-out lock. A closed gate REFUSES here — the engine is never called.
  const intent = resolveWriteIntent({ apply, env });
  if (intent.refusal) {
    return {
      result: { status: 'refused', mode: 'apply-requested' },
      diagnostics: [intent.refusal],
      code: intent.code,
    };
  }

  // Resolve the governed-write gate ONLY on the real --apply path. The dry-run path
  // performs no write, so assertWritable stays undefined (the engine's dry-run path
  // needs no gate). paths.mjs is imported DYNAMICALLY (M2-safe); a failure degrades.
  let assertWritable;
  if (intent.enableWrites) {
    try {
      const paths = await (deps.loadPaths ?? (() => import('../paths.mjs')))();
      // Pick the target-bound gate: a codex ctx (descriptor.writeSurface) → a gate bound
      // to ~/.codex + the codex rollback surface; Claude → the bare assertWritable (byte-
      // identical). The restore gates every write-back with context 'rollback'.
      assertWritable = resolveAssertWritable(paths, ctx);
    } catch (err) {
      return {
        result: { status: 'write-unavailable' },
        diagnostics: [{
          severity: 'warn', code: 'rollback-write-unavailable', phase: 'cli',
          message: `the write gate is unloadable; rollback --apply needs it: ${err instanceof Error ? err.message : String(err)}`,
        }],
        code: 1,
      };
    }
  }

  const rollbackFn = deps.rollbackFn ?? rollbackSnapshot;
  // The engine boundary is a seam: rollbackSnapshot is proven never-throws/never-
  // rejects, but guarding the await keeps the handler total even against a buggy or
  // injected seam (review LOW-1) — a throw/reject degrades to a clean error result.
  let r;
  try {
    r = await rollbackFn({
      mgrStateDir: ctx.mgrStateDir,
      targetClaudeDir: ctx.configDir,
      snapshotId: id,
      assertWritable,
      force,
      enableWrites: intent.enableWrites,
      expectedTarget: ctx.configDir,
    });
  } catch (err) {
    return {
      result: { status: 'error' },
      diagnostics: [{
        severity: 'error', code: 'rollback-unexpected-error', phase: 'cli',
        message: `rollback failed unexpectedly: ${err instanceof Error ? err.message : String(err)}`,
      }],
      code: 1,
    };
  }

  const o = r && typeof r === 'object' ? r : {};
  return {
    result: summarizeRollback(o),
    diagnostics: Array.isArray(o.diagnostics) ? o.diagnostics.slice() : [],
    code: typeof o.code === 'number' ? o.code : (o.ok ? 0 : 1),
  };
}
