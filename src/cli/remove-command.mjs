/**
 * CLI handler for `remove <kind>:<name> [--reason <msg>] [--apply]` (P4a.U5).
 *
 * Wires the already-built `removeComponent` engine (src/ops/remove.mjs) into the
 * CLI behind the SAME write gate every write command uses: `resolveWriteIntent`
 * requires `--apply` (dry-run by default; set `HARNESS_MGR_ENABLE_WRITES=0` to force-lock writes).
 *
 * DRY-RUN BY DEFAULT: a bare `remove agent:foo` previews the operation (builds the
 * Plan, resolves the target, confirms it exists) and writes NOTHING. With `--apply`
 * + the env factor the remove actually runs: auto-snapshot first, then the governed
 * atomic delete. The snapshot makes every remove reversible via `rollback`.
 *
 * M2-SAFETY: this module never STATICALLY imports src/paths.mjs — the
 * `assertWritable` gate + dirs are injected params, keeping this module's static
 * graph paths.mjs-free (the M2-safe property the boundary self-check enforces). The
 * gate is instead resolved via a DYNAMIC `import()` ONLY on the real --apply path
 * (mirrors rollback-command.mjs); on import failure the command degrades gracefully
 * to a `remove-write-unavailable` warn. The dry-run path never touches paths.mjs.
 *
 * `deps` is the injectable test seam (mirrors rollback-command.mjs): fake
 * `loadPaths` + `removeFn` + `env` make every path hermetically unit-testable
 * without a real gate / lock / snapshot / delete / fs.
 *
 * Never throws — removeComponent is ops-pure/never-throws, the dynamic import is
 * guarded, and the summary helper is fully defensive.
 *
 * Spec: docs/phase-4a-design.md §5; plan harness-mgr-v5.md Phase 4a.U5.
 *
 * Zero npm dependencies. Node stdlib only.
 */

import { removeComponent } from '../ops/remove.mjs';
import { resolveWriteIntent, resolveAssertWritable } from './write-gate.mjs';
import { cascadeCommand } from './cascade-command.mjs';
import { pruneConfigCommand } from './prune-config-command.mjs';

/** @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic */
/** @typedef {import('./commands.mjs').CommandContext} CommandContext */
/** @typedef {import('./commands.mjs').CommandOutput} CommandOutput */
/** @typedef {import('../ops/remove.mjs').RemoveResult} RemoveResult */

/**
 * Map a RemoveResult to a CLI exit code. Mirrors the design §5 exit-code table:
 *   0 — clean dry-run preview or successful apply
 *   2 — validation refused (bad spec, unsupported kind, target not found, …)
 *   3 — invalid args / writes-disabled gate (handled upstream; here for completeness)
 *   4 — snapshot integrity failure during apply
 *   6 — apply lock could not be acquired
 *   1 — any other apply failure
 *
 * @param {RemoveResult} r
 * @returns {number}
 */
function removeExitCode(r) {
  if (r.refused) return 2;
  if (r.ok) return 0;
  // Apply path failed — inspect the ApplyResult for a more specific code.
  const ar = r.apply;
  if (ar && ar.lock && ar.lock.acquired === false) return 6;
  if (ar && Array.isArray(ar.diagnostics) &&
      ar.diagnostics.some((d) => d && d.code === 'apply-snapshot-failed')) return 4;
  return 1;
}

/**
 * Shape a RemoveResult into a LEAN, flat summary for the table renderer. Fully
 * defensive — a dry-run has no `apply`, and every field is coerced to a safe
 * scalar / null. GENUINELY TOTAL: the body is wrapped so even a pathological
 * result (a property that is a throwing getter) degrades to a constant summary
 * instead of throwing (mirrors summarizeRollback in rollback-command.mjs).
 *
 * @param {RemoveResult} r
 * @returns {object}
 */
function summarizeRemove(r) {
  const o = r && typeof r === 'object' ? r : {};
  try {
    return {
      status: o.refused ? 'refused' : (o.dryRun ? 'dry-run' : (o.ok ? 'removed' : 'failed')),
      ok: !!o.ok,
      dryRun: !!o.dryRun,
      kind: o.kind ?? null,
      name: o.name ?? null,
      target: o.target ?? null,
      applied: o.apply ? !!o.apply.applied : false,
      snapshotId: o.apply ? (o.apply.snapshotId ?? null) : null,
      lockAcquired: o.apply && o.apply.lock ? !!o.apply.lock.acquired : null,
    };
  } catch {
    return {
      status: 'summary-error', ok: false, dryRun: false,
      kind: null, name: null, target: null,
      applied: false, snapshotId: null, lockAcquired: null,
    };
  }
}

/**
 * Drive `removeComponent` from the CLI. Reads the spec from
 * `ctx.args.positionals[0]`, applies the two-factor write gate, and (only on the
 * real --apply path) dynamically resolves the governed-write gate.
 *
 * @param {CommandContext} ctx  { configDir, mgrStateDir, args }
 * @param {{
 *   loadPaths?: () => Promise<{assertWritable: Function}>,
 *   removeFn?: typeof removeComponent,
 *   env?: Record<string, string|undefined>
 * }} [deps]
 * @returns {Promise<CommandOutput & {code: number}>}
 */
export async function removeCommand(ctx, deps = {}) {
  const args = ctx && ctx.args ? ctx.args : {};

  // Route --prune-config to the prune-aware remove path (codex skill + orphaned
  // [[skills.config]] cleanup in ONE reversible plan). Checked BEFORE --cascade: the
  // two are distinct cleanup models, and pruneConfigCommand refuses if both are set.
  if (args && args['prune-config']) {
    return pruneConfigCommand(ctx, deps);
  }

  // Route --cascade to the cascade handler (same ctx + deps shape).
  if (args && args.cascade) {
    return cascadeCommand(ctx, deps);
  }

  const spec = args && Array.isArray(args.positionals) ? args.positionals[0] : undefined;

  if (typeof spec !== 'string' || spec.length === 0) {
    return {
      result: { status: 'no-spec' },
      diagnostics: [{
        severity: 'error', code: 'remove-no-spec', phase: 'cli',
        message: 'remove requires a target: remove <kind>:<name> (kind = agent|command|skill)',
      }],
      code: 3,
    };
  }

  const reason = typeof args.reason === 'string' ? args.reason : undefined;
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

  // Resolve the governed-write gate ONLY on the real --apply path. The dry-run
  // path performs no write, so assertWritable stays undefined (the engine's
  // dry-run path needs no gate). paths.mjs is imported DYNAMICALLY under try/catch
  // so that if its load ever fails the command degrades instead of crashing
  // (defence-in-depth). (Historically paths.mjs -> reexport.mjs top-level-awaited
  // and rejected when ~/.claude/hooks/lib was absent; the resolver is first-party
  // now, so that specific reject is gone.)
  let assertWritable;
  if (intent.enableWrites) {
    try {
      const paths = await (deps.loadPaths ?? (() => import('../paths.mjs')))();
      // Codex ctx → a gate bound to ~/.codex + the codex remove surface; Claude → bare.
      assertWritable = resolveAssertWritable(paths, ctx);
    } catch (err) {
      return {
        result: { status: 'write-unavailable' },
        diagnostics: [{
          severity: 'warn', code: 'remove-write-unavailable', phase: 'cli',
          message: `the write gate is unloadable; remove --apply needs it: ${err instanceof Error ? err.message : String(err)}`,
        }],
        code: 1,
      };
    }
  }

  const removeFn = deps.removeFn ?? removeComponent;
  // The engine boundary is a seam: removeComponent is proven never-throws/never-
  // rejects, but guarding the await keeps the handler total even against a buggy
  // or injected seam — a throw/reject degrades to a clean error result.
  let r;
  try {
    const descriptor = ctx && ctx.descriptor && typeof ctx.descriptor === 'object' ? ctx.descriptor : null;
    r = await removeFn({
      spec,
      targetClaudeDir: ctx.configDir,
      mgrStateDir: ctx.mgrStateDir,
      assertWritable,
      enableWrites: intent.enableWrites,
      reason,
      pid: process.pid,
      // Codex: the remove kind table (agent→agents/.toml/command→prompts/.md/skill→skills/)
      // + the snapshot scope for the reversibility auto-snapshot. Absent → Claude defaults.
      componentKinds: descriptor ? descriptor.componentKinds : undefined,
      scope: descriptor ? descriptor.snapshotScope : undefined,
    });
  } catch (err) {
    return {
      result: { status: 'error' },
      diagnostics: [{
        severity: 'error', code: 'remove-unexpected-error', phase: 'cli',
        message: `remove failed unexpectedly: ${err instanceof Error ? err.message : String(err)}`,
      }],
      code: 1,
    };
  }

  const o = r && typeof r === 'object' ? r : {};
  return {
    result: summarizeRemove(o),
    diagnostics: Array.isArray(o.diagnostics) ? o.diagnostics.slice() : [],
    code: removeExitCode(o),
  };
}
