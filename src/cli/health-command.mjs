/**
 * `health` command handler (P5.U5) — wires the three already-built analysis
 * engines into ONE read-only command (the D2 first-batch capstone):
 *
 *   health.summary/groups/components  — per-component loadability (P5.U2
 *                                       analysis/health.mjs over scan + conflict
 *                                       + doctor facts)
 *   advice.summary/advice             — offline best-practice advice (P5.U3
 *                                       analysis/advice.mjs over the same facts)
 *   hooks.summary/explanations        — human hook explanations (P5.U4
 *                                       analysis/hook-explain.mjs over the merged
 *                                       effective.hooks + passive probe statuses)
 *
 * PASSIVE-ONLY by design: facts are gathered ONCE via gatherDoctorInput with
 * activeProbes:false — `health` takes no --active-probes; active probing
 * (spawns + the loader's transient agents/ write) is `doctor`'s job. The
 * passive gather never touches paths.mjs, so every import here is STATIC and
 * the M2/invariants gate stays green (the doctor-facts.mjs precedent).
 *
 * SECRET-SAFE (audit P1): the WHOLE result passes redactSecretsDeep (hook
 * explanation entries carry raw command strings), and the merged diagnostics
 * pass it too as belt-and-suspenders — so a token embedded in a hook command
 * can never reach json/ndjson via any surface of this command.
 *
 * EXIT SEMANTICS (the doctorCommand precedent): diagnostics = the gather
 * operational diagnostics + EVERY doctor finding, so an error-severity doctor
 * finding drives exit 1; a clean config exits 0.
 *
 * Never throws — junk ctx or a misbehaving injected seam degrades to an
 * all-empty result plus one `health-command-failed` warn.
 */

import { gatherDoctorInput } from './doctor-facts.mjs';
import { runDoctor } from '../analysis/doctor/index.mjs';
import { analyzeHealth } from '../analysis/health.mjs';
import { analyzeAdvice } from '../analysis/advice.mjs';
import { explainHooks } from '../analysis/hook-explain.mjs';
import { redactSecretsDeep } from '../lib/redact-secrets-text.mjs';

/**
 * @typedef {import('./commands.mjs').CommandContext} CommandContext
 * @typedef {import('./commands.mjs').CommandOutput} CommandOutput
 */

/**
 * The severity-layered health report: loadability + advice + hook status.
 *
 * @param {CommandContext} ctx
 * @param {{ gatherFn?: Function, runDoctorFn?: Function, env?: object }} [deps]
 *   test seams: the fact gatherer (default gatherDoctorInput), the doctor
 *   judgment (default runDoctor), and the env map (default process.env).
 * @returns {Promise<CommandOutput>}
 */
export async function healthCommand(ctx, deps = {}) {
  try {
    const configDir = ctx && typeof ctx === 'object' ? ctx.configDir : undefined;
    const mgrStateDir = ctx && typeof ctx === 'object' ? ctx.mgrStateDir : undefined;
    const gather = typeof deps.gatherFn === 'function' ? deps.gatherFn : gatherDoctorInput;
    const judge = typeof deps.runDoctorFn === 'function' ? deps.runDoctorFn : runDoctor;
    const env = (deps.env && typeof deps.env === 'object') ? deps.env : process.env;

    // Gather ONCE, passive always (header). `now` mirrors doctorCommand exactly.
    const gathered = await gather({ configDir, mgrStateDir, activeProbes: false, now: Date.now(), cwd: configDir });
    const g = gathered && typeof gathered === 'object' ? gathered : {};
    const facts = g.facts && typeof g.facts === 'object' ? g.facts : {};
    const gatherDiags = Array.isArray(g.diagnostics) ? g.diagnostics : [];

    const report = judge(g.input ?? {}, { activeProbes: false });
    const doctorDiagnostics = report && Array.isArray(report.diagnostics) ? report.diagnostics : [];

    const health = analyzeHealth({
      components: facts.components, conflicts: facts.conflicts,
      diagnostics: facts.scanDiagnostics, doctorDiagnostics,
    });
    const advice = analyzeAdvice({ diagnostics: facts.scanDiagnostics, doctorDiagnostics, health });
    const hooks = explainHooks({ hooks: facts.effectiveHooks, hookFacts: facts.hookFacts, env });

    return {
      // SECRET-SAFE: hook explanation entries carry command strings; the health
      // reasons / advice paths are file paths but cost nothing to cover too.
      result: redactSecretsDeep({
        health: { summary: health.summary, groups: health.groups, components: health.components },
        advice: { summary: advice.summary, advice: advice.advice },
        hooks: { summary: hooks.summary, explanations: hooks.entries },
      }),
      // doctorCommand precedent: gather diags + every doctor finding (exit
      // semantics inherit: any error-severity finding → exit 1). Redacted as
      // belt-and-suspenders so the whole stdout is token-free.
      diagnostics: /** @type {any} */ (redactSecretsDeep([...gatherDiags, ...doctorDiagnostics])),
    };
  } catch (err) {
    return {
      result: emptyHealthResult(),
      diagnostics: [{ severity: 'warn', code: 'health-command-failed', message: err instanceof Error ? err.message : String(err ?? ''), phase: 'cli' }],
    };
  }
}

/** All-empty result keeping the three-section shape stable on the degrade path. */
function emptyHealthResult() {
  return {
    health: { summary: { total: 0, loadable: 0, degraded: 0, notLoaded: 0 }, groups: [], components: [] },
    advice: { summary: { total: 0, error: 0, warn: 0, info: 0 }, advice: [] },
    hooks: { summary: { total: 0, missing: 0, indeterminate: 0, byKind: { file: 0, external: 0, opaque: 0 } }, explanations: [] },
  };
}
