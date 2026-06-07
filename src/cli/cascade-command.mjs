/**
 * CLI handler for `remove <kind>:<name> --cascade [--force] [--apply]` (P4b.U4).
 *
 * Wires the `cascadeRemove` engine (src/ops/cascade.mjs) into the CLI behind the
 * SAME two-factor write gate every write command uses: `resolveWriteIntent`
 * requires BOTH `--apply` AND `CLAUDE_MGR_ENABLE_WRITES=1`.
 *
 * DRY-RUN BY DEFAULT: a bare `remove agent:foo --cascade` discovers the graph,
 * previews the target + dependents, and writes NOTHING. With `--apply` + the env
 * factor the cascade actually runs: ONE auto-snapshot first (reversible via
 * `rollback`), then the multi-op governed delete.
 *
 * EXIT-CODE MAP:
 *   0 — clean dry-run preview or successful apply
 *   2 — validation refused (bad spec, unsupported kind, target not found)
 *   3 — writes-disabled gate / cascade-needs-force (confirmation required)
 *   4 — snapshot integrity failure during apply
 *   6 — apply lock could not be acquired
 *   1 — any other apply failure
 *
 * M2-SAFETY: never STATICALLY imports src/paths.mjs. The write gate
 * (assertWritable) is resolved via DYNAMIC `import()` ONLY on the real --apply
 * path; on import failure the command degrades gracefully. The dry-run path
 * never touches paths.mjs.
 *
 * `deps` is the injectable test seam: fake `loadPaths` + `cascadeFn` + `env`
 * make every path hermetically unit-testable.
 *
 * Never throws — cascadeRemove is never-throws, the dynamic import is guarded,
 * and the summary helper is fully defensive.
 *
 * Zero npm dependencies. Node stdlib only.
 */

import { cascadeRemove } from '../ops/cascade.mjs';
import { resolveWriteIntent } from './write-gate.mjs';

/** @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic */
/** @typedef {import('../ops/cascade.mjs').CascadeResult} CascadeResult */

/**
 * Map a CascadeResult to a CLI exit code.
 * @param {CascadeResult} r
 * @returns {number}
 */
function cascadeExitCode(r) {
  if (r.refused) {
    // cascade-needs-force is a confirmation refusal → 3 (not a validation error)
    const needsForce = Array.isArray(r.diagnostics) &&
      r.diagnostics.some((d) => d && d.code === 'cascade-needs-force');
    return needsForce ? 3 : 2;
  }
  if (r.ok) return 0;
  const ar = r.apply;
  if (ar && ar.lock && ar.lock.acquired === false) return 6;
  if (ar && Array.isArray(ar.diagnostics) &&
      ar.diagnostics.some((d) => d && d.code === 'apply-snapshot-failed')) return 4;
  return 1;
}

/**
 * Shape a CascadeResult into a lean summary for the table renderer. Fully
 * defensive — a dry-run has no `apply`, and every field is coerced to a safe
 * scalar / null. Never throws.
 * @param {CascadeResult} r
 * @returns {object}
 */
function summarizeCascade(r) {
  const o = r && typeof r === 'object' ? r : {};
  try {
    const preview = o.preview && typeof o.preview === 'object' ? o.preview : null;
    const dependentCount = Array.isArray(o.dependents) ? o.dependents.length : 0;
    return {
      status: o.refused ? 'refused' : (o.dryRun ? 'dry-run' : (o.ok ? 'removed' : 'failed')),
      ok: !!o.ok,
      dryRun: !!o.dryRun,
      target: o.target ?? null,
      dependentCount,
      total: dependentCount + (o.target ? 1 : 0),
      wouldRemove: preview ? preview.wouldRemove : [],
      applied: o.apply ? !!o.apply.applied : false,
      snapshotId: o.apply ? (o.apply.snapshotId ?? null) : null,
      lockAcquired: o.apply && o.apply.lock ? !!o.apply.lock.acquired : null,
    };
  } catch {
    return {
      status: 'summary-error', ok: false, dryRun: false,
      target: null, dependentCount: 0, total: 0, wouldRemove: [],
      applied: false, snapshotId: null, lockAcquired: null,
    };
  }
}

/**
 * Drive `cascadeRemove` from the CLI.
 *
 * @param {import('./commands.mjs').CommandContext} ctx  { configDir, mgrStateDir, args }
 * @param {{
 *   loadPaths?: () => Promise<{assertWritable: Function}>,
 *   cascadeFn?: typeof cascadeRemove,
 *   env?: Record<string, string|undefined>
 * }} [deps]
 * @returns {Promise<{result: object, diagnostics: Diagnostic[], code: number}>}
 */
export async function cascadeCommand(ctx, deps = {}) {
  const args = ctx && ctx.args ? ctx.args : {};
  const spec = args && Array.isArray(args.positionals) ? args.positionals[0] : undefined;

  if (typeof spec !== 'string' || spec.length === 0) {
    return {
      result: { status: 'no-spec' },
      diagnostics: [{
        severity: 'error', code: 'cascade-no-spec', phase: 'cli',
        message: 'remove --cascade requires a target: remove <kind>:<name> --cascade',
      }],
      code: 3,
    };
  }

  const reason = typeof args.reason === 'string' ? args.reason : undefined;
  const apply = !!(args && args.apply);
  const force = !!(args && args.force);
  const env = deps.env ?? process.env;

  // Two-factor gate.
  const intent = resolveWriteIntent({ apply, env });
  if (intent.refusal) {
    return {
      result: { status: 'refused', mode: 'apply-requested' },
      diagnostics: [intent.refusal],
      code: intent.code,
    };
  }

  // Resolve the write gate ONLY on the real --apply path (M2-safe).
  let assertWritable;
  if (intent.enableWrites) {
    try {
      const paths = await (deps.loadPaths ?? (() => import('../paths.mjs')))();
      assertWritable = paths.assertWritable;
    } catch (err) {
      return {
        result: { status: 'write-unavailable' },
        diagnostics: [{
          severity: 'warn', code: 'cascade-write-unavailable', phase: 'cli',
          message: `~/.claude/hooks/lib unloadable; cascade --apply needs the write gate: ${err instanceof Error ? err.message : String(err)}`,
        }],
        code: 1,
      };
    }
  }

  const cascadeFn = deps.cascadeFn ?? cascadeRemove;
  let r;
  try {
    r = await cascadeFn({
      spec,
      targetClaudeDir: ctx.configDir,
      mgrStateDir: ctx.mgrStateDir,
      assertWritable,
      enableWrites: intent.enableWrites,
      force,
      reason,
      pid: process.pid,
    });
  } catch (err) {
    return {
      result: { status: 'error' },
      diagnostics: [{
        severity: 'error', code: 'cascade-unexpected-error', phase: 'cli',
        message: `cascade failed unexpectedly: ${err instanceof Error ? err.message : String(err)}`,
      }],
      code: 1,
    };
  }

  const o = r && typeof r === 'object' ? r : {};
  return {
    result: summarizeCascade(o),
    diagnostics: Array.isArray(o.diagnostics) ? o.diagnostics.slice() : [],
    code: cascadeExitCode(o),
  };
}
