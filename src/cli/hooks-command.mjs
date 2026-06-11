/**
 * `hooks` command handler (P5.U4) — extracted from commands.mjs to keep that
 * module under the 200-SLOC lint ceiling (the ops-commands.mjs /
 * settings-layers.mjs precedent).
 *
 * Result shape:
 *   hooks         — the merged effective.hooks, redacted. BYTE-COMPATIBLE with
 *                   the pre-U4 `hooks` result key (computed by the exact same
 *                   expression) — the TUI consumes it.
 *   explanations  — NEW: one explained entry per hook entry (event / matcher /
 *                   command / kind / target / status / one English sentence),
 *                   built by analysis/hook-explain.mjs and enriched with
 *                   found/missing/indeterminate status from the PASSIVE probe
 *                   gatherHookProbes (statSync/PATH resolution only — never
 *                   spawns, never writes; probe-hooks is paths.mjs-free, so the
 *                   STATIC import keeps the M2/invariants gate green, the same
 *                   precedent as doctor-facts.mjs).
 *
 * SECRET-SAFE (audit P1): BOTH result surfaces pass redactSecretsDeep, so a
 * token embedded in a hook command string never reaches json/ndjson via the raw
 * `hooks` NOR via `explanations` (command/target/explanation strings included).
 *
 * Async because the probe does I/O; cli.mjs awaits handlers (doctorCommand
 * precedent). Never throws — a throwing gather seam degrades to explanations
 * with status 'unprobed' rather than failing the command.
 */

import { readSettingsLayers } from './settings-layers.mjs';
import { mergeSettings } from '../analysis/settings-merge.mjs';
import { redactSecretsDeep } from '../analysis/redact-secrets-text.mjs';
import { gatherHookProbes } from '../discovery/probe-hooks.mjs';
import { explainHooks } from '../analysis/hook-explain.mjs';

/**
 * @typedef {import('./commands.mjs').CommandContext} CommandContext
 * @typedef {import('./commands.mjs').CommandOutput} CommandOutput
 */

/**
 * The merged per-event hooks order plus the human explanations.
 *
 * @param {CommandContext} ctx
 * @param {{ gatherFn?: Function, env?: object }} [deps]  test seams: the probe
 *   gatherer (default gatherHookProbes) and the env map (default process.env).
 * @returns {Promise<CommandOutput>}
 */
export async function hooksCommand(ctx, deps = {}) {
  const configDir = ctx && ctx.configDir;
  const layers = readSettingsLayers(configDir);
  const m = mergeSettings(layers.layers);
  const rawHooks = (m.effective && m.effective.hooks) || {};
  const env = (deps.env && typeof deps.env === 'object') ? deps.env : process.env;

  // Probe statuses (best-effort): the probe never throws by contract, but a
  // misbehaving injected seam must not break the command — degrade to [] so
  // every explanation honestly reads 'unprobed'.
  let hookFacts = [];
  try {
    const gather = typeof deps.gatherFn === 'function' ? deps.gatherFn : gatherHookProbes;
    const probes = gather({ hooks: rawHooks, env, cwd: configDir });
    if (probes && Array.isArray(probes.hookFacts)) hookFacts = probes.hookFacts;
  } catch { /* degrade: explanations render as unprobed */ }

  const ex = explainHooks({ hooks: rawHooks, hookFacts, env });

  // SECRET-SAFE: a token embedded in a hook command string (an Authorization
  // header or --token=) is redacted to <redacted> before it reaches json/ndjson
  // (audit P1) — on BOTH the raw hooks and the new explanations surface.
  return {
    result: {
      hooks: redactSecretsDeep(rawHooks),
      explanations: redactSecretsDeep(ex.entries),
    },
    diagnostics: [...layers.diagnostics, ...m.diagnostics],
  };
}
