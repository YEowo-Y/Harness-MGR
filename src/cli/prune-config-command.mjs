/**
 * CLI handler for `remove skill:<name> --target codex --prune-config [--apply]`
 * (P6 prune-config wave · U3).
 *
 * Wires the `pruneConfigRemove` engine (src/ops/prune-config.mjs) into the CLI behind the
 * SAME two-factor write gate every write command uses: `resolveWriteIntent` requires
 * `--apply` (dry-run by default; HARNESS_MGR_ENABLE_WRITES=0 force-locks writes).
 *
 * Routed from remove-command.mjs when `--prune-config` is present. It is a per-target
 * feature: only a target whose write surface enables in-place config-edit (Codex —
 * config.toml lives only there) is accepted; on any other target (Claude has no
 * config.toml) it refuses with a clear "run with --target codex" message rather than
 * silently no-op'ing. `--prune-config` and `--cascade` are distinct cleanup models, so
 * combining them is a clean refusal (never an ambiguous overload).
 *
 * DRY-RUN BY DEFAULT: a bare `remove skill:x --prune-config --target codex` previews
 * "would delete skills/x + N orphaned config entries" and writes NOTHING. With `--apply`
 * + the env factor it runs: ONE auto-snapshot (codex scope captures skills/ AND
 * config.toml) → the governed dir delete + block deletes, reversible by one rollback.
 *
 * M2-SAFETY: never STATICALLY imports paths.mjs; the write gate (assertWritable) is
 * resolved via a DYNAMIC import ONLY on the real --apply path (mirrors remove-command.mjs).
 * `deps` (loadPaths/pruneFn/env) makes every path hermetically testable. Never throws.
 * Zero npm deps.
 */

import { pruneConfigRemove } from '../ops/prune-config.mjs';
import { resolveWriteIntent, resolveAssertWritable } from './write-gate.mjs';

/** @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic */
/** @typedef {import('./commands.mjs').CommandContext} CommandContext */
/** @typedef {import('./commands.mjs').CommandOutput} CommandOutput */
/** @typedef {import('../ops/prune-config.mjs').PruneConfigResult} PruneConfigResult */

/** Map a PruneConfigResult to a CLI exit code (mirrors removeExitCode). @param {PruneConfigResult} r */
function pruneExitCode(r) {
  if (r.refused) return 2;
  if (r.ok) return 0;
  const ar = r.apply;
  if (ar && ar.lock && ar.lock.acquired === false) return 6;
  if (ar && Array.isArray(ar.diagnostics) && ar.diagnostics.some((d) => d && d.code === 'apply-snapshot-failed')) return 4;
  return 1;
}

/** Shape a PruneConfigResult into a lean, totally-defensive flat summary. @param {PruneConfigResult} r */
function summarizePrune(r) {
  const o = r && typeof r === 'object' ? r : {};
  try {
    return {
      status: o.refused ? 'refused' : (o.dryRun ? 'dry-run' : (o.ok ? 'removed' : 'failed')),
      ok: !!o.ok,
      dryRun: !!o.dryRun,
      kind: o.kind ?? null,
      name: o.name ?? null,
      target: o.target ?? null,
      prunedCount: typeof o.prunedCount === 'number' ? o.prunedCount : 0,
      pruned: Array.isArray(o.pruned) ? o.pruned.slice() : [],
      applied: o.apply ? !!o.apply.applied : false,
      snapshotId: o.apply ? (o.apply.snapshotId ?? null) : null,
      lockAcquired: o.apply && o.apply.lock ? !!o.apply.lock.acquired : null,
    };
  } catch {
    return {
      status: 'summary-error', ok: false, dryRun: false, kind: null, name: null, target: null,
      prunedCount: 0, pruned: [], applied: false, snapshotId: null, lockAcquired: null,
    };
  }
}

/**
 * Drive `pruneConfigRemove` from the CLI.
 *
 * @param {CommandContext} ctx  { configDir, mgrStateDir, descriptor, args }
 * @param {{
 *   loadPaths?: () => Promise<{assertWritable: Function, makeAssertWritable: Function}>,
 *   pruneFn?: typeof pruneConfigRemove,
 *   env?: Record<string, string|undefined>
 * }} [deps]
 * @returns {Promise<CommandOutput & {code: number}>}
 */
export async function pruneConfigCommand(ctx, deps = {}) {
  const args = ctx && ctx.args ? ctx.args : {};
  const spec = args && Array.isArray(args.positionals) ? args.positionals[0] : undefined;
  const descriptor = ctx && ctx.descriptor && typeof ctx.descriptor === 'object' ? ctx.descriptor : null;
  const cli = (code, message, status, exit) => ({ result: { status }, diagnostics: [{ severity: 'error', code, phase: 'cli', message }], code: exit });

  // --prune-config and --cascade are different cleanup models (graph dependents vs config
  // orphans) — combining is undefined; refuse rather than silently picking one.
  if (args && args.cascade) {
    return cli('prune-config-cascade-conflict', '--prune-config and --cascade are different cleanup models; use one at a time', 'flag-conflict', 3);
  }

  // Target support: only a target whose write surface enables config-edit (Codex). Claude
  // has no config.toml → a clean refusal, never a silent no-op.
  const ws = descriptor && descriptor.writeSurface;
  const supported = !!(ws && ws.features && ws.features.configEdit === true && Array.isArray(ws.configEditFiles) && ws.configEditFiles.length > 0);
  if (!supported) {
    return cli('prune-config-unsupported-target', '--prune-config is codex-only (config.toml lives only in a Codex harness); run with --target codex', 'unsupported-target', 3);
  }

  if (typeof spec !== 'string' || spec.length === 0) {
    return cli('prune-config-no-spec', 'remove --prune-config requires a target: remove skill:<name> --target codex --prune-config', 'no-spec', 3);
  }

  const reason = typeof args.reason === 'string' ? args.reason : undefined;
  const apply = !!(args && args.apply);
  const env = deps.env ?? process.env;

  const intent = resolveWriteIntent({ apply, env });
  if (intent.refusal) {
    return { result: { status: 'refused', mode: 'apply-requested' }, diagnostics: [intent.refusal], code: intent.code };
  }

  // Resolve the codex-bound write gate ONLY on the real --apply path (M2-safe).
  let assertWritable;
  if (intent.enableWrites) {
    try {
      const paths = await (deps.loadPaths ?? (() => import('../paths.mjs')))();
      assertWritable = resolveAssertWritable(paths, ctx); // codex ctx → codex config-edit + remove gate
    } catch (err) {
      return {
        result: { status: 'write-unavailable' },
        diagnostics: [{ severity: 'warn', code: 'prune-config-write-unavailable', phase: 'cli',
          message: `the write gate is unloadable; --prune-config --apply needs it: ${err instanceof Error ? err.message : String(err)}` }],
        code: 1,
      };
    }
  }

  const pruneFn = deps.pruneFn ?? pruneConfigRemove;
  let r;
  try {
    r = await pruneFn({
      spec,
      targetClaudeDir: ctx.configDir,
      mgrStateDir: ctx.mgrStateDir,
      configFile: ws.configEditFiles[0],
      componentKinds: descriptor.componentKinds,
      scope: descriptor.snapshotScope,
      assertWritable,
      enableWrites: intent.enableWrites,
      reason,
      pid: process.pid,
    });
  } catch (err) {
    return {
      result: { status: 'error' },
      diagnostics: [{ severity: 'error', code: 'prune-config-unexpected-error', phase: 'cli',
        message: `prune-config failed unexpectedly: ${err instanceof Error ? err.message : String(err)}` }],
      code: 1,
    };
  }

  const o = r && typeof r === 'object' ? r : {};
  return {
    result: summarizePrune(o),
    diagnostics: Array.isArray(o.diagnostics) ? o.diagnostics.slice() : [],
    code: pruneExitCode(o),
  };
}
