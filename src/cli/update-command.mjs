/**
 * CLI handler for `update <plugin> [--lock-version <ver>] [--reason <msg>] [--apply]`
 * (P4b.U5).
 *
 * Wires the `updatePlugin` engine (src/ops/update.mjs) into the CLI behind the
 * SAME two-factor write gate every write command uses: `resolveWriteIntent`
 * requires BOTH `--apply` AND `CLAUDE_MGR_ENABLE_WRITES=1`.
 *
 * DRY-RUN BY DEFAULT: a bare `update somePlugin` discovers + resolves the plugin
 * and PREVIEWS the delegated `claude plugin update <key>` command, writing NOTHING
 * and spawning NOTHING. With `--apply` + the env factor the engine auto-snapshots
 * the governed surface FIRST (the undo point), then delegates the update to the
 * external `claude` CLI via safeSpawn. (docs/phase-4b-update-design.md §2/§8.)
 *
 * EXIT-CODE MAP (docs/phase-4b-update-design.md §8):
 *   0 — clean dry-run preview or successful delegated update
 *   2 — validation refused (bad spec, plugin not found, ambiguous, missing gate)
 *   3 — no plugin spec given, or the writes-disabled gate is closed
 *   4 — auto-snapshot integrity failure during --apply
 *   1 — any other apply failure (spawn failed, write-gate unloadable, unexpected)
 *
 * M2-SAFETY: never STATICALLY imports src/paths.mjs. The write gate
 * (assertWritable) is resolved via DYNAMIC `import()` ONLY on the real --apply
 * path; on import failure the command degrades gracefully. The dry-run path
 * never touches paths.mjs.
 *
 * `deps` is the injectable test seam: fake `loadPaths` + `updateFn` + `env` make
 * every path hermetically unit-testable.
 *
 * Never throws — updatePlugin is never-throws, the dynamic import is guarded, and
 * the summary helper is fully defensive.
 *
 * Zero npm dependencies. Node stdlib only.
 */

import { updatePlugin } from '../ops/update.mjs';
import { resolveWriteIntent } from './write-gate.mjs';

/** @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic */
/** @typedef {import('../ops/update.mjs').UpdateResult} UpdateResult */

/**
 * Map an UpdateResult to a CLI exit code.
 *   refused          → 2 (bad spec / not found / ambiguous / missing gate)
 *   ok               → 0 (dry-run preview or successful delegated update)
 *   snapshot failure → 4 (the auto-snapshot integrity gate)
 *   anything else    → 1 (spawn failed / unexpected)
 * @param {UpdateResult} r
 * @returns {number}
 */
function updateExitCode(r) {
  if (r.refused) return 2;
  if (r.ok) return 0;
  const hasSnapshotFail = Array.isArray(r.diagnostics) &&
    r.diagnostics.some((d) => d && d.code === 'update-snapshot-failed');
  if (hasSnapshotFail) return 4;
  return 1;
}

/**
 * Shape an UpdateResult into a lean summary for the table renderer. Fully
 * defensive — every field is coerced to a safe scalar / null. Never throws.
 * @param {UpdateResult} r
 * @returns {object}
 */
function summarizeUpdate(r) {
  const o = r && typeof r === 'object' ? r : {};
  try {
    const plugin = o.plugin && typeof o.plugin === 'object'
      ? { key: o.plugin.key, version: o.plugin.version, marketplace: o.plugin.marketplace }
      : null;
    return {
      status: o.refused ? 'refused' : (o.dryRun ? 'dry-run' : (o.ok ? 'updated' : 'failed')),
      ok: !!o.ok,
      dryRun: !!o.dryRun,
      plugin,
      command: Array.isArray(o.command) ? o.command : null,
      snapshotId: o.snapshotId ?? null,
      spawned: !!o.spawned,
    };
  } catch {
    return {
      status: 'summary-error', ok: false, dryRun: false,
      plugin: null, command: null, snapshotId: null, spawned: false,
    };
  }
}

/**
 * Drive `updatePlugin` from the CLI.
 *
 * @param {import('./commands.mjs').CommandContext} ctx  { configDir, mgrStateDir, args }
 * @param {{
 *   loadPaths?: () => Promise<{assertWritable: Function}>,
 *   updateFn?: typeof updatePlugin,
 *   env?: Record<string, string|undefined>
 * }} [deps]
 * @returns {Promise<{result: object, diagnostics: Diagnostic[], code: number}>}
 */
export async function updateCommand(ctx, deps = {}) {
  const args = ctx && ctx.args ? ctx.args : {};
  const spec = args && Array.isArray(args.positionals) ? args.positionals[0] : undefined;

  if (typeof spec !== 'string' || spec.length === 0) {
    return {
      result: { status: 'no-spec' },
      diagnostics: [{
        severity: 'error', code: 'update-no-spec', phase: 'cli',
        message: 'update requires a plugin: update <plugin> [--lock-version <ver>] [--apply]',
      }],
      code: 3,
    };
  }

  const reason = typeof args.reason === 'string' ? args.reason : undefined;
  // cli.mjs's flagKey strips the leading `--` verbatim (only `--config-dir` is
  // camel-cased), so `--lock-version <ver>` lands under args['lock-version'].
  const lockVersion = typeof args['lock-version'] === 'string' ? args['lock-version'] : undefined;
  const apply = !!(args && args.apply);
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
          severity: 'warn', code: 'update-write-unavailable', phase: 'cli',
          message: `~/.claude/hooks/lib unloadable; update --apply needs the write gate: ${err instanceof Error ? err.message : String(err)}`,
        }],
        code: 1,
      };
    }
  }

  const updateFn = deps.updateFn ?? updatePlugin;
  let r;
  try {
    r = await updateFn({
      spec,
      targetClaudeDir: ctx.configDir,
      mgrStateDir: ctx.mgrStateDir,
      assertWritable,
      enableWrites: intent.enableWrites,
      reason,
      lockVersion,
      env,
      // NOTE: no `pid` — `update` deliberately takes no apply lock (design §4),
      // so unlike cascade/remove there is no lock pid to thread through.
    });
  } catch (err) {
    return {
      result: { status: 'error' },
      diagnostics: [{
        severity: 'error', code: 'update-unexpected-error', phase: 'cli',
        message: `update failed unexpectedly: ${err instanceof Error ? err.message : String(err)}`,
      }],
      code: 1,
    };
  }

  const o = r && typeof r === 'object' ? r : {};
  return {
    result: summarizeUpdate(o),
    diagnostics: Array.isArray(o.diagnostics) ? o.diagnostics.slice() : [],
    code: updateExitCode(o),
  };
}
