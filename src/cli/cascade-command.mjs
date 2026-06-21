/**
 * CLI handler for `remove <kind>:<name> --cascade [--force] [--apply]` (P4b.U4).
 *
 * Wires the `cascadeRemove` engine (src/ops/cascade.mjs) into the CLI behind the
 * SAME write gate every write command uses: `resolveWriteIntent` requires
 * `--apply` (dry-run by default; set `CLAUDE_MGR_ENABLE_WRITES=0` to force-lock writes).
 *
 * DRY-RUN BY DEFAULT: a bare `remove agent:foo --cascade` discovers the graph,
 * previews the target + dependents, and writes NOTHING. With `--apply` + the env
 * factor the cascade actually runs: ONE auto-snapshot first (reversible via
 * `rollback`), then the multi-op governed delete.
 *
 * CLAUDE-ONLY: cascade's edge model lives in component-graph-edges.mjs and reads
 * Claude-specific skill frontmatter (agent/next-skill/pipeline). A `--target codex`
 * cascade is refused at the top with `cascade-unsupported-for-codex` (see the guard
 * in cascadeCommand) — codex has no such edge model, and this handler is not
 * descriptor-aware. Plain `remove --target codex` and `--prune-config` cover codex.
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
 * The codex refusal for `--cascade`. cascade's edge model (component-graph-edges.mjs
 * REFERENCE_FIELDS) reads Claude-only skill frontmatter (agent/next-skill/pipeline);
 * codex components declare no such references, AND this handler is not descriptor-aware
 * (it would run the Claude component walk + a Claude-default snapshot scope against
 * ~/.codex). So a codex cascade is refused cleanly and the user is routed to the two
 * codex paths that DO work (plain remove, --prune-config) — never silently mis-run.
 * Mirrors prune-config-command.mjs's unsupported-target refusal + the conflicts
 * descriptor.id==='codex' special-case. The diagnostic code intentionally follows the
 * codex-specific `conflicts-unverified-for-codex` `-for-codex` convention (this guard
 * shares that exact id==='codex' predicate) rather than prune-config's capability-generic
 * `-unsupported-target` form — the refusal is codex-specific, not "any unsupported target".
 * Returns null for any non-codex target (the Claude cascade proceeds). The natural
 * flip-point to a real cascade once codex grows an edge model.
 *
 * @param {unknown} descriptor  ctx.descriptor
 * @returns {{result: object, diagnostics: Diagnostic[], code: number} | null}
 */
function codexCascadeRefusal(descriptor) {
  const d = descriptor && typeof descriptor === 'object' ? descriptor : null;
  if (!d || d.id !== 'codex') return null;
  return {
    result: { status: 'unsupported-target' },
    diagnostics: [{
      severity: 'error', code: 'cascade-unsupported-for-codex', phase: 'cli',
      message: '--cascade has no codex edge model (codex components declare no cross-component ' +
        'references); use plain remove --target codex, or remove skill:<name> --target codex ' +
        '--prune-config to clean orphaned config entries',
    }],
    code: 3,
  };
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

  // CODEX GUARD — checked FIRST so even a spec-less `--cascade --target codex` is told
  // the feature is unsupported (a spec would not help). See codexCascadeRefusal.
  const codexRefusal = codexCascadeRefusal(ctx && ctx.descriptor);
  if (codexRefusal) return codexRefusal;

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
