/**
 * CLI handlers for `disable`/`enable --type plugin|mcp|skill <name> [--apply]` (P6 config-edit unit).
 *
 * Thin wrappers over the setComponentEnabled engine (src/ops/config-edit.mjs), behind
 * the SAME two-factor write gate every write command uses: resolveWriteIntent requires
 * --apply (dry-run by default; CLAUDE_MGR_ENABLE_WRITES=0 force-locks writes). disable
 * sets enabled=false, enable sets enabled=true — one shared configEditCommand.
 *
 * Target support is per-target: Codex has an in-place config.toml surface
 * (configEditFiles=['config.toml'] + features.configEdit; --type plugin|mcp|skill, a skill
 * selecting by a bare name OR by `--path` — 51% of live entries are path-keyed); CLAUDE has
 * the settings.json enabledPlugins map (pluginEnableModel:'settings-map'; --type plugin →
 * setPluginEnabledClaude, --type mcp → the delegate+stash mcpToggleCommand, --type skill →
 * declined). A target with neither surface refuses with a clear message rather than no-op'ing.
 *
 * M2-SAFETY: never STATICALLY imports paths.mjs; the gate is resolved via a DYNAMIC
 * import ONLY on the real --apply path (mirrors remove-command.mjs). Dry-run touches no
 * gate. `deps` (loadPaths/setEnabledFn/env) makes every path hermetically testable.
 * Never throws. Zero npm deps.
 */

import { setComponentEnabled } from '../ops/config-edit.mjs';
import { setPluginEnabledClaude } from '../ops/plugin-toggle.mjs';
import { mcpToggleCommand } from './mcp-toggle-command.mjs';
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
      field: o.field ?? null,
      desired: typeof o.desired === 'boolean' ? o.desired : null, target: o.target ?? null,
      diff: o.diff ?? null, alreadyInState: !!o.alreadyInState,
      applied: o.apply ? !!o.apply.applied : false,
      snapshotId: o.apply ? (o.apply.snapshotId ?? null) : null,
    };
  } catch {
    return { status: 'summary-error', ok: false, dryRun: false, kind: null, name: null, field: null,
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
  const positional = Array.isArray(args.positionals) ? args.positionals[0] : undefined;
  const pathArg = typeof args.path === 'string' ? args.path : undefined;
  const descriptor = ctx && ctx.descriptor && typeof ctx.descriptor === 'object' ? ctx.descriptor : null;
  const cli = (code, message, status, exit) => ({ result: { status }, diagnostics: [{ severity: 'error', code, phase: 'cli', message }], code: exit });

  // Target support: Codex has an in-place config.toml surface (plugin/mcp/skill); Claude has the
  // settings.json enabledPlugins map (plugin only). A target with NEITHER is refused.
  const ws = descriptor && descriptor.writeSurface;
  const codexConfigEdit = !!(ws && ws.features && ws.features.configEdit === true && Array.isArray(ws.configEditFiles) && ws.configEditFiles.length > 0);
  const claudePluginToggle = !!(descriptor && descriptor.pluginEnableModel === 'settings-map');
  if (!codexConfigEdit && !claudePluginToggle) {
    return cli(`${verb}-unsupported-target`, `${verb} is only supported for a target with an in-place config surface (Codex config.toml) or the Claude enabledPlugins map; the current target has neither`, 'unsupported-target', 3);
  }
  // CLAUDE write paths (the codex config.toml path continues below unchanged):
  //   --type plugin → settings.json enabledPlugins flip (claudePluginCommand)
  //   --type mcp    → delegate+stash MCP toggle (mcpToggleCommand)
  //   --type skill  → declined (no per-skill enable lever; claudePluginCommand refuses)
  if (claudePluginToggle && !codexConfigEdit) {
    if (kind === 'mcp') return mcpToggleCommand(ctx, deps, desired, verb);
    return claudePluginCommand(ctx, deps, desired, verb, { kind, positional, pathArg });
  }
  if (!kind) return cli(`${verb}-no-type`, `${verb} requires --type plugin|mcp|skill and a name: ${verb} --type plugin <name@marketplace> | ${verb} --type mcp <server> | ${verb} --type skill <name> | ${verb} --type skill --path "<path>"`, 'no-type', 3);

  // Resolve the selector VALUE + (skill-only) field. A skill selects by a bare name OR by
  // --path (mutually exclusive); plugin/mcp take the single positional and reject --path.
  let name, selectorField;
  if (kind === 'skill') {
    const hasName = typeof positional === 'string' && positional.length > 0;
    if (pathArg !== undefined && hasName) return cli(`${verb}-skill-selector-conflict`, `${verb} --type skill takes EITHER a name OR --path, not both`, 'selector-conflict', 3);
    if (pathArg !== undefined) { name = pathArg; selectorField = 'path'; }
    else if (hasName) { name = positional; selectorField = 'name'; }
    else return cli(`${verb}-no-name`, `${verb} --type skill needs a skill name or --path: ${verb} --type skill <name> | ${verb} --type skill --path "<path>"`, 'no-name', 3);
  } else {
    if (pathArg !== undefined) return cli(`${verb}-path-not-allowed`, `--path is only valid with --type skill (not --type ${kind})`, 'path-not-allowed', 3);
    name = positional;
    if (typeof name !== 'string' || name.length === 0) return cli(`${verb}-no-name`, `${verb} requires a name: ${verb} --type ${kind} <name>`, 'no-name', 3);
  }

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
      kind, name, selectorField, desired,
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

/**
 * The CLAUDE plugin-toggle path: `disable`/`enable --type plugin <name@marketplace>` flips the
 * settings.json enabledPlugins boolean via setPluginEnabledClaude. Only --type plugin is
 * supported for Claude this increment (mcp has no enabledMcpServers map; skills have no settings
 * enable flag). Mirrors the codex path's two-factor gate + M2-safe dynamic paths import on --apply.
 * @param {CommandContext} ctx
 * @param {{loadPaths?:Function, setPluginEnabledFn?:Function, env?:Record<string,string|undefined>}} deps
 * @param {boolean} desired @param {string} verb @param {{kind?:string, positional?:string, pathArg?:string}} parsed
 * @returns {Promise<CommandOutput & {code:number}>}
 */
async function claudePluginCommand(ctx, deps, desired, verb, parsed) {
  const { kind, positional, pathArg } = parsed;
  const cli = (code, message, status, exit) => ({ result: { status }, diagnostics: [{ severity: 'error', code, phase: 'cli', message }], code: exit });
  if (!kind) return cli(`${verb}-no-type`, `${verb} requires --type plugin and a name: ${verb} --type plugin <name@marketplace>`, 'no-type', 3);
  if (kind !== 'plugin') return cli(`${verb}-claude-kind-unsupported`, `for the Claude target, ${verb} --type ${kind} is not supported (plugin and mcp are); Claude has no per-skill enable/disable lever — use \`remove skill:<name>\` to remove a skill (rollback-reversible)`, 'kind-unsupported', 3);
  if (pathArg !== undefined) return cli(`${verb}-path-not-allowed`, '--path is not valid for --type plugin', 'path-not-allowed', 3);
  const name = positional;
  if (typeof name !== 'string' || name.length === 0) return cli(`${verb}-no-name`, `${verb} requires a plugin name: ${verb} --type plugin <name@marketplace>`, 'no-name', 3);

  const apply = !!(ctx.args && ctx.args.apply);
  const env = deps.env ?? process.env;
  const intent = resolveWriteIntent({ apply, env });
  if (intent.refusal) return { result: { status: 'refused', mode: 'apply-requested' }, diagnostics: [intent.refusal], code: intent.code };

  let assertWritable;
  if (intent.enableWrites) {
    try {
      const paths = await (deps.loadPaths ?? (() => import('../paths.mjs')))();
      assertWritable = resolveAssertWritable(paths, ctx); // claude → bare assertWritable (settings.json apply-writable)
    } catch (err) {
      return { result: { status: 'write-unavailable' }, diagnostics: [{ severity: 'warn', code: `${verb}-write-unavailable`, phase: 'cli',
        message: `the write gate is unloadable; ${verb} --apply needs it: ${err instanceof Error ? err.message : String(err)}` }], code: 1 };
    }
  }

  const fn = deps.setPluginEnabledFn ?? setPluginEnabledClaude;
  let r;
  try {
    r = await fn({
      key: name, desired,
      targetClaudeDir: ctx.configDir, mgrStateDir: ctx.mgrStateDir,
      assertWritable, enableWrites: intent.enableWrites,
      scope: ctx.descriptor && ctx.descriptor.snapshotScope, pid: process.pid,
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
