/**
 * CLI handler for `skill visibility <name> <state> [--apply]` (Claude per-skill visibility).
 *
 * A NEW skill subcommand (alongside `skill propose` / `skill accept`) that sets one member of
 * settings.json's `skillOverrides` map to a 4-state visibility enum via the setSkillVisibility
 * engine (src/ops/skill-visibility.mjs), behind the SAME two-factor write gate every write command
 * uses: resolveWriteIntent requires --apply (dry-run by default; HARNESS_MGR_ENABLE_WRITES=0
 * force-locks writes).
 *
 * CLAUDE-ONLY: skillOverrides is a Claude settings.json concept. A non-Claude target (Codex governs
 * skills via config.toml `[[skills.config]]` — see `disable/enable --type skill`) refuses with a
 * clear message rather than mis-routing.
 *
 * M2-SAFETY: never STATICALLY imports paths.mjs; the gate is resolved via a DYNAMIC import ONLY on
 * the real --apply path (mirrors remove-command.mjs / plugin-toggle CLI). Dry-run touches no gate.
 * `deps` (loadPaths/setSkillVisibilityFn/env) makes every path hermetically testable. Never throws.
 * Zero npm deps.
 */

import { setSkillVisibility } from '../ops/skill-visibility.mjs';
import { resolveWriteIntent, resolveAssertWritable } from './write-gate.mjs';

/** @typedef {import('./commands.mjs').CommandContext} CommandContext */
/** @typedef {import('./commands.mjs').CommandOutput} CommandOutput */

/** The four visibility states, surfaced in usage messages. */
const STATES = 'on|name-only|user-invocable-only|off';

/** Map a setSkillVisibility result to a CLI exit code (mirrors configEditExitCode). */
function exitCode(r) {
  if (r.refused) return 2;
  if (r.ok) return 0;
  const ar = r.apply;
  if (ar && ar.lock && ar.lock.acquired === false) return 6;
  if (ar && Array.isArray(ar.diagnostics) && ar.diagnostics.some((d) => d && d.code === 'apply-snapshot-failed')) return 4;
  return 1;
}

/** Shape a result into a lean, totally-defensive flat summary for the table renderer. */
function summarize(r) {
  const o = r && typeof r === 'object' ? r : {};
  try {
    const status = o.refused ? 'refused'
      : (o.alreadyInState ? 'already' : (o.dryRun ? 'dry-run' : (o.ok ? 'set' : 'failed')));
    return {
      status, ok: !!o.ok, dryRun: !!o.dryRun, kind: o.kind ?? null, name: o.name ?? null,
      state: o.state ?? null, target: o.target ?? null, diff: o.diff ?? null,
      alreadyInState: !!o.alreadyInState,
      applied: o.apply ? !!o.apply.applied : false,
      snapshotId: o.apply ? (o.apply.snapshotId ?? null) : null,
    };
  } catch {
    return { status: 'summary-error', ok: false, dryRun: false, kind: null, name: null, state: null,
      target: null, diff: null, alreadyInState: false, applied: false, snapshotId: null };
  }
}

/**
 * Drive setSkillVisibility from the CLI. Reads `<name>` from positionals[0] and `<state>` from
 * positionals[1], checks the target is Claude, applies the two-factor gate, and (only on --apply)
 * dynamically resolves the governed-write gate.
 * @param {CommandContext} ctx
 * @param {{loadPaths?:Function, setSkillVisibilityFn?:Function, env?:Record<string,string|undefined>}} [deps]
 * @returns {Promise<CommandOutput & {code:number}>}
 */
export async function skillVisibilityCommand(ctx, deps = {}) {
  const args = ctx && ctx.args ? ctx.args : {};
  const positionals = Array.isArray(args.positionals) ? args.positionals : [];
  const name = positionals[0];
  const state = positionals[1];
  const descriptor = ctx && ctx.descriptor && typeof ctx.descriptor === 'object' ? ctx.descriptor : null;
  const cli = (code, message, status, exit) => ({ result: { status }, diagnostics: [{ severity: 'error', code, phase: 'cli', message }], code: exit });

  // CLAUDE-ONLY: skillOverrides is a Claude settings.json concept.
  if (!descriptor || descriptor.id !== 'claude') {
    return cli('skill-visibility-unsupported-target', `skill visibility governs Claude's settings.json skillOverrides and is only supported for the Claude target; for Codex use \`disable/enable --type skill <name> --target codex\``, 'unsupported-target', 3);
  }
  if (typeof name !== 'string' || name.length === 0) {
    return cli('skill-visibility-no-name', `skill visibility requires a skill name and a state: skill visibility <name> <${STATES}>`, 'no-name', 3);
  }
  if (typeof state !== 'string' || state.length === 0) {
    return cli('skill-visibility-no-state', `skill visibility requires a state: skill visibility ${name} <${STATES}>`, 'no-state', 3);
  }

  const apply = !!(args && args.apply);
  const env = deps.env ?? process.env;
  const intent = resolveWriteIntent({ apply, env });
  if (intent.refusal) return { result: { status: 'refused', mode: 'apply-requested' }, diagnostics: [intent.refusal], code: intent.code };

  let assertWritable;
  if (intent.enableWrites) {
    try {
      const paths = await (deps.loadPaths ?? (() => import('../paths.mjs')))();
      assertWritable = resolveAssertWritable(paths, ctx); // claude → bare assertWritable (settings.json apply-writable)
    } catch (err) {
      return { result: { status: 'write-unavailable' }, diagnostics: [{ severity: 'warn', code: 'skill-visibility-write-unavailable', phase: 'cli',
        message: `the write gate is unloadable; skill visibility --apply needs it: ${err instanceof Error ? err.message : String(err)}` }], code: 1 };
    }
  }

  const fn = deps.setSkillVisibilityFn ?? setSkillVisibility;
  let r;
  try {
    r = await fn({
      name, state,
      targetClaudeDir: ctx.configDir, mgrStateDir: ctx.mgrStateDir,
      assertWritable, enableWrites: intent.enableWrites,
      scope: descriptor.snapshotScope, pid: process.pid,
    });
  } catch (err) {
    return { result: { status: 'error' }, diagnostics: [{ severity: 'error', code: 'skill-visibility-unexpected-error', phase: 'cli',
      message: `skill visibility failed unexpectedly: ${err instanceof Error ? err.message : String(err)}` }], code: 1 };
  }
  const o = r && typeof r === 'object' ? r : {};
  return { result: summarize(o), diagnostics: Array.isArray(o.diagnostics) ? o.diagnostics.slice() : [], code: exitCode(o) };
}
