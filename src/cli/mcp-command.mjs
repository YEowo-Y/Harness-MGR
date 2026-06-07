/**
 * CLI handler for `mcp remove <name> [--scope local|user|project] [--reason <msg>] [--apply]`
 * (P4b.U6b).
 *
 * Wires the `mcpRemove` engine (src/ops/mcp-write.mjs) into the CLI behind the
 * SAME two-factor write gate every write command uses: `resolveWriteIntent`
 * requires BOTH `--apply` AND `CLAUDE_MGR_ENABLE_WRITES=1`.
 *
 * DRY-RUN BY DEFAULT: a bare `mcp remove someServer` validates the name + scope and
 * PREVIEWS the delegated `claude mcp remove <name> [--scope …]` command, writing
 * NOTHING and spawning NOTHING. With `--apply` + the env factor the engine auto-
 * snapshots the governed surface FIRST (the undo point — project scope only), then
 * delegates the removal to the external `claude` CLI via safeSpawn.
 * (docs/phase-4b-mcp-design.md §1/§3.)
 *
 * `mcp remove` is a TWO-WORD command, so cli.mjs's canonicalize() collapses
 * `mcp remove` → `mcp:remove` (consumed 2) and `<name>` lands in
 * `args.positionals[0]` (mirrors `snapshot list`).
 *
 * EXIT-CODE MAP (docs/phase-4b-mcp-design.md §6):
 *   0 — clean dry-run preview or successful delegated remove
 *   2 — validation refused (bad spec, bad scope, bad args, not spawnable)
 *   3 — no server name given, or the writes-disabled gate is closed
 *   4 — auto-snapshot integrity failure during --apply
 *   1 — any other apply failure (spawn failed, write-gate unloadable, unexpected)
 *
 * M2-SAFETY: never STATICALLY imports src/paths.mjs. The write gate
 * (assertWritable) is resolved via DYNAMIC `import()` ONLY on the real --apply
 * path; on import failure the command degrades gracefully. The dry-run path
 * never touches paths.mjs.
 *
 * `deps` is the injectable test seam: fake `loadPaths` + `mcpFn` + `env` +
 * `homedirFn` make every path hermetically unit-testable.
 *
 * Never throws — mcpRemove is never-throws, the dynamic import is guarded, and the
 * summary helper is fully defensive.
 *
 * Zero npm dependencies. Node stdlib only.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { mcpRemove } from '../ops/mcp-write.mjs';
import { resolveWriteIntent } from './write-gate.mjs';

/** @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic */
/** @typedef {import('../ops/mcp-write.mjs').McpRemoveResult} McpRemoveResult */

/**
 * Map an McpRemoveResult to a CLI exit code.
 *   refused          → 2 (bad spec / bad scope / bad args / not spawnable)
 *   ok               → 0 (dry-run preview or successful delegated remove)
 *   snapshot failure → 4 (the auto-snapshot integrity gate)
 *   anything else    → 1 (spawn failed / unexpected)
 * @param {McpRemoveResult} r
 * @returns {number}
 */
function mcpExitCode(r) {
  if (r.refused) return 2;
  if (r.ok) return 0;
  const hasSnapshotFail = Array.isArray(r.diagnostics) &&
    r.diagnostics.some((d) => d && d.code === 'mcp-snapshot-failed');
  if (hasSnapshotFail) return 4;
  return 1;
}

/**
 * Shape an McpRemoveResult into a lean summary for the table renderer. Fully
 * defensive — every field is coerced to a safe scalar / null. Never throws.
 * @param {McpRemoveResult} r
 * @returns {object}
 */
function summarizeMcp(r) {
  const o = r && typeof r === 'object' ? r : {};
  try {
    const server = o.server && typeof o.server === 'object'
      ? { name: o.server.name, scope: o.server.scope, transport: o.server.transport }
      : null;
    return {
      status: o.refused ? 'refused' : (o.dryRun ? 'dry-run' : (o.ok ? 'removed' : 'failed')),
      ok: !!o.ok,
      dryRun: !!o.dryRun,
      name: o.name ?? null,
      scope: o.scope ?? null,
      server,
      command: Array.isArray(o.command) ? o.command : null,
      snapshotId: o.snapshotId ?? null,
      spawned: !!o.spawned,
    };
  } catch {
    return {
      status: 'summary-error', ok: false, dryRun: false,
      name: null, scope: null, server: null, command: null, snapshotId: null, spawned: false,
    };
  }
}

/**
 * Drive `mcpRemove` from the CLI.
 *
 * @param {import('./commands.mjs').CommandContext} ctx  { configDir, mgrStateDir, args }
 * @param {{
 *   loadPaths?: () => Promise<{assertWritable: Function}>,
 *   mcpFn?: typeof mcpRemove,
 *   env?: Record<string, string|undefined>,
 *   homedirFn?: () => string
 * }} [deps]
 * @returns {Promise<{result: object, diagnostics: Diagnostic[], code: number}>}
 */
export async function mcpCommand(ctx, deps = {}) {
  const args = ctx && ctx.args ? ctx.args : {};
  const name = args && Array.isArray(args.positionals) ? args.positionals[0] : undefined;

  if (typeof name !== 'string' || name.length === 0) {
    return {
      result: { status: 'no-spec' },
      diagnostics: [{
        severity: 'error', code: 'mcp-no-spec', phase: 'cli',
        message: 'mcp remove requires a server name: mcp remove <name> [--scope local|user|project] [--apply]',
      }],
      code: 3,
    };
  }

  const scope = typeof args.scope === 'string' ? args.scope : undefined;
  const reason = typeof args.reason === 'string' ? args.reason : undefined;
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
          severity: 'warn', code: 'mcp-write-unavailable', phase: 'cli',
          message: `~/.claude/hooks/lib unloadable; mcp remove --apply needs the write gate: ${err instanceof Error ? err.message : String(err)}`,
        }],
        code: 1,
      };
    }
  }

  // Derive the ~/.claude.json app file for the engine's best-effort (advisory)
  // existence check across the user scope.
  const hd = deps.homedirFn ?? homedir;
  const appFile = join(hd(), '.claude.json');

  const mcpFn = deps.mcpFn ?? mcpRemove;
  let r;
  try {
    r = await mcpFn({
      name,
      scope,
      targetClaudeDir: ctx.configDir,
      mgrStateDir: ctx.mgrStateDir,
      appFile,
      assertWritable,
      enableWrites: intent.enableWrites,
      reason,
      env,
      // NOTE: no `pid` — `mcp remove` deliberately takes no apply lock (design §3,
      // like `update`/`snapshot`), so there is no lock pid to thread through.
    });
  } catch (err) {
    return {
      result: { status: 'error' },
      diagnostics: [{
        severity: 'error', code: 'mcp-unexpected-error', phase: 'cli',
        message: `mcp remove failed unexpectedly: ${err instanceof Error ? err.message : String(err)}`,
      }],
      code: 1,
    };
  }

  const o = r && typeof r === 'object' ? r : {};
  return {
    result: summarizeMcp(o),
    diagnostics: Array.isArray(o.diagnostics) ? o.diagnostics.slice() : [],
    code: mcpExitCode(o),
  };
}
