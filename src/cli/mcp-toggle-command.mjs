/**
 * CLI handler for `disable`/`enable --type mcp <server> --target claude` — the non-destructive,
 * reversible USER-scope MCP toggle (delegate + stash; see docs/claude-mcp-toggle-design.md).
 *
 * Thin wrapper over setMcpEnabledClaude (src/ops/mcp-toggle.mjs) behind the SAME two-factor
 * write gate every write command uses: resolveWriteIntent requires --apply (dry-run by default;
 * HARNESS_MGR_ENABLE_WRITES=0 force-locks). Reached from config-edit-command.mjs's claude branch
 * when --type is mcp. harness-mgr never writes ~/.claude.json — the engine delegates the mutation
 * to the official `claude mcp remove`/`add-json` CLI and only manages a .mgr-state stash.
 *
 * M2-SAFETY: never STATICALLY imports paths.mjs; the gate is resolved via a DYNAMIC import ONLY
 * on the real --apply path (mirrors the other write commands). `deps` (loadPaths /
 * setMcpEnabledFn / env / homedirFn) makes every path hermetically testable. Never throws.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { setMcpEnabledClaude } from '../ops/mcp-toggle.mjs';
import { resolveWriteIntent, resolveAssertWritable } from './write-gate.mjs';

/** @typedef {import('./commands.mjs').CommandContext} CommandContext */
/** @typedef {import('./commands.mjs').CommandOutput} CommandOutput */

/** Map a setMcpEnabledClaude result to a CLI exit code (mirrors removeExitCode). */
function mcpToggleExitCode(r) {
  if (r.refused) return 2;
  if (r.ok) return 0;
  return 1;
}

/** Shape the engine result into a lean, fully-defensive flat summary for the table renderer. */
function summarize(r, verb) {
  const o = r && typeof r === 'object' ? r : {};
  try {
    const status = o.refused ? 'refused'
      : (o.alreadyInState ? 'already'
        : (o.dryRun ? 'dry-run' : (o.ok ? (verb === 'enable' ? 'enabled' : 'disabled') : 'failed')));
    return {
      status, ok: !!o.ok, dryRun: !!o.dryRun, kind: 'mcp', name: o.name ?? null,
      desired: typeof o.desired === 'boolean' ? o.desired : null, action: o.action ?? null,
      alreadyInState: !!o.alreadyInState, stashWritten: !!o.stashWritten, stashDeleted: !!o.stashDeleted,
      command: Array.isArray(o.command) ? o.command : null,
    };
  } catch {
    return { status: 'summary-error', ok: false, dryRun: false, kind: 'mcp', name: null, desired: null,
      action: null, alreadyInState: false, stashWritten: false, stashDeleted: false, command: null };
  }
}

/**
 * `disable`/`enable --type mcp <server>` for the Claude target. Validates the name positional,
 * applies the two-factor gate, resolves the gate (claude → bare assertWritable) on --apply only,
 * derives ~/.claude.json (best-effort raw read in the engine), and calls setMcpEnabledClaude.
 * @param {CommandContext} ctx
 * @param {{loadPaths?:Function, setMcpEnabledFn?:Function, env?:Record<string,string|undefined>, homedirFn?:Function}} deps
 * @param {boolean} desired  true = enable, false = disable
 * @param {string} verb
 * @returns {Promise<CommandOutput & {code:number}>}
 */
export async function mcpToggleCommand(ctx, deps, desired, verb) {
  const args = ctx && ctx.args ? ctx.args : {};
  const pathArg = typeof args.path === 'string' ? args.path : undefined;
  const name = Array.isArray(args.positionals) ? args.positionals[0] : undefined;
  const cli = (code, message, status, exit) => ({ result: { status }, diagnostics: [{ severity: 'error', code, phase: 'cli', message }], code: exit });

  if (pathArg !== undefined) return cli(`${verb}-path-not-allowed`, '--path is not valid for --type mcp', 'path-not-allowed', 3);
  if (typeof name !== 'string' || name.length === 0) return cli(`${verb}-no-name`, `${verb} requires an mcp server name: ${verb} --type mcp <server>`, 'no-name', 3);

  const apply = !!(args && args.apply);
  const env = deps.env ?? process.env;
  const intent = resolveWriteIntent({ apply, env });
  if (intent.refusal) return { result: { status: 'refused', mode: 'apply-requested' }, diagnostics: [intent.refusal], code: intent.code };

  let assertWritable;
  if (intent.enableWrites) {
    try {
      const paths = await (deps.loadPaths ?? (() => import('../paths.mjs')))();
      assertWritable = resolveAssertWritable(paths, ctx); // claude → bare assertWritable (.mgr-state stash is always-writable)
    } catch (err) {
      return { result: { status: 'write-unavailable' }, diagnostics: [{ severity: 'warn', code: `${verb}-write-unavailable`, phase: 'cli',
        message: `the write gate is unloadable; ${verb} --apply needs it: ${err instanceof Error ? err.message : String(err)}` }], code: 1 };
    }
  }

  const hd = deps.homedirFn ?? homedir;
  const appFile = join(hd(), '.claude.json');
  const fn = deps.setMcpEnabledFn ?? setMcpEnabledClaude;
  let r;
  try {
    r = await fn({
      name, desired, targetClaudeDir: ctx.configDir, mgrStateDir: ctx.mgrStateDir,
      appFile, assertWritable, enableWrites: intent.enableWrites, env,
    });
  } catch (err) {
    return { result: { status: 'error' }, diagnostics: [{ severity: 'error', code: `${verb}-unexpected-error`, phase: 'cli',
      message: `${verb} failed unexpectedly: ${err instanceof Error ? err.message : String(err)}` }], code: 1 };
  }
  const o = r && typeof r === 'object' ? r : {};
  return { result: summarize(o, verb), diagnostics: Array.isArray(o.diagnostics) ? o.diagnostics.slice() : [], code: mcpToggleExitCode(o) };
}
