/**
 * CLI handlers for `disable`/`enable --type plugin <name> [--apply]` (P6 config-edit unit).
 *
 * Thin wrappers over the setComponentEnabled engine (src/ops/config-edit.mjs), behind
 * the SAME two-factor write gate every write command uses: resolveWriteIntent requires
 * --apply (dry-run by default; CLAUDE_MGR_ENABLE_WRITES=0 force-locks writes). disable
 * sets enabled=false, enable sets enabled=true — one shared configEditCommand.
 *
 * Target support: config-edit is a per-target feature. Only a target whose write
 * surface enables it (Codex: configEditFiles=['config.toml'] + features.configEdit) is
 * accepted; on any other target (Claude) the command refuses with a clear message
 * rather than silently no-op'ing. MVP --type is plugin (the engine refuses mcp/skill).
 *
 * M2-SAFETY: never STATICALLY imports paths.mjs; the gate is resolved via a DYNAMIC
 * import ONLY on the real --apply path (mirrors remove-command.mjs). Dry-run touches no
 * gate. `deps` (loadPaths/setEnabledFn/env) makes every path hermetically testable.
 * Never throws. Zero npm deps.
 */

import { setComponentEnabled } from '../ops/config-edit.mjs';
import { resolveWriteIntent, resolveAssertWritable } from './write-gate.mjs';

/** @typedef {import('./commands.mjs').CommandContext} CommandContext */
/** @typedef {import('./commands.mjs').CommandOutput} CommandOutput */

/** Map a setComponentEnabled result to a CLI exit code (mirrors removeExitCode). */
function configEditExitCode(r) {
  if (r.refused) return 2;
  if (r.ok) return 0;
  const ar = r.apply;
  if (ar && ar.lock && ar.lock.acquired === false) return 6;
  if (ar && Array.isArray(ar.diagnostics) && ar.diagnostics.some((d) => d && d.code === 'apply-snapshot-failed')) return 4;
  return 1;
}

/** Shape a result into a lean, totally-defensive flat summary for the table renderer. */
function summarize(r, verb) {
  const o = r && typeof r === 'object' ? r : {};
  try {
    const status = o.refused ? 'refused'
      : (o.alreadyInState ? 'already'
        : (o.dryRun ? 'dry-run' : (o.ok ? (verb === 'enable' ? 'enabled' : 'disabled') : 'failed')));
    return {
      status, ok: !!o.ok, dryRun: !!o.dryRun, kind: o.kind ?? null, name: o.name ?? null,
      desired: typeof o.desired === 'boolean' ? o.desired : null, target: o.target ?? null,
      diff: o.diff ?? null, alreadyInState: !!o.alreadyInState,
      applied: o.apply ? !!o.apply.applied : false,
      snapshotId: o.apply ? (o.apply.snapshotId ?? null) : null,
    };
  } catch {
    return { status: 'summary-error', ok: false, dryRun: false, kind: null, name: null,
      desired: null, target: null, diff: null, alreadyInState: false, applied: false, snapshotId: null };
  }
}

/**
 * Shared driver for disable/enable. Reads `--type <kind>` + the name positional,
 * checks the target supports config-edit, applies the two-factor gate, and (only on
 * --apply) dynamically resolves the governed-write gate.
 * @param {CommandContext} ctx
 * @param {{loadPaths?:Function, setEnabledFn?:Function, env?:Record<string,string|undefined>}} deps
 * @param {boolean} desired  true = enable, false = disable
 * @returns {Promise<CommandOutput & {code:number}>}
 */
async function configEditCommand(ctx, deps, desired) {
  const verb = desired ? 'enable' : 'disable';
  const args = ctx && ctx.args ? ctx.args : {};
  const kind = typeof args.type === 'string' ? args.type : undefined;
  const name = Array.isArray(args.positionals) ? args.positionals[0] : undefined;
  const descriptor = ctx && ctx.descriptor && typeof ctx.descriptor === 'object' ? ctx.descriptor : null;
  const cli = (code, message, status, exit) => ({ result: { status }, diagnostics: [{ severity: 'error', code, phase: 'cli', message }], code: exit });

  // Target support: only a target whose write surface enables config-edit (Codex).
  const ws = descriptor && descriptor.writeSurface;
  const supported = !!(ws && ws.features && ws.features.configEdit === true && Array.isArray(ws.configEditFiles) && ws.configEditFiles.length > 0);
  if (!supported) {
    return cli(`${verb}-unsupported-target`, `${verb} is only supported for a target with an in-place config surface (run with --target codex); the current target has none`, 'unsupported-target', 3);
  }
  if (!kind) return cli(`${verb}-no-type`, `${verb} requires --type plugin and a name: ${verb} --type plugin <name@marketplace>`, 'no-type', 3);
  if (typeof name !== 'string' || name.length === 0) return cli(`${verb}-no-name`, `${verb} requires a name: ${verb} --type ${kind} <name>`, 'no-name', 3);

  const apply = !!(args && args.apply);
  const env = deps.env ?? process.env;
  const intent = resolveWriteIntent({ apply, env });
  if (intent.refusal) return { result: { status: 'refused', mode: 'apply-requested' }, diagnostics: [intent.refusal], code: intent.code };

  let assertWritable;
  if (intent.enableWrites) {
    try {
      const paths = await (deps.loadPaths ?? (() => import('../paths.mjs')))();
      assertWritable = resolveAssertWritable(paths, ctx); // codex ctx → codex-bound config-edit gate
    } catch (err) {
      return { result: { status: 'write-unavailable' }, diagnostics: [{ severity: 'warn', code: `${verb}-write-unavailable`, phase: 'cli',
        message: `the write gate is unloadable; ${verb} --apply needs it: ${err instanceof Error ? err.message : String(err)}` }], code: 1 };
    }
  }

  const fn = deps.setEnabledFn ?? setComponentEnabled;
  let r;
  try {
    r = await fn({
      kind, name, desired,
      targetClaudeDir: ctx.configDir, mgrStateDir: ctx.mgrStateDir,
      configFile: ws.configEditFiles[0],
      assertWritable, enableWrites: intent.enableWrites,
      scope: descriptor.snapshotScope, pid: process.pid,
    });
  } catch (err) {
    return { result: { status: 'error' }, diagnostics: [{ severity: 'error', code: `${verb}-unexpected-error`, phase: 'cli',
      message: `${verb} failed unexpectedly: ${err instanceof Error ? err.message : String(err)}` }], code: 1 };
  }
  const o = r && typeof r === 'object' ? r : {};
  return { result: summarize(o, verb), diagnostics: Array.isArray(o.diagnostics) ? o.diagnostics.slice() : [], code: configEditExitCode(o) };
}

/** `disable --type plugin <name> [--apply]` — set enabled=false. */
export function disableCommand(ctx, deps = {}) { return configEditCommand(ctx, deps, false); }

/** `enable --type plugin <name> [--apply]` — set enabled=true. */
export function enableCommand(ctx, deps = {}) { return configEditCommand(ctx, deps, true); }
