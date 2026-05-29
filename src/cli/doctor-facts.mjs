/**
 * Doctor fact-gathering — the I/O orchestration boundary for `doctor` (P2.U11).
 *
 * A sibling of resolve-config.mjs: where that decides WHICH `~/.claude` is
 * governed, this gathers the FACTS the pure `runDoctor` judges. The doctor's
 * index.mjs is a pure consumer (no I/O); all the filesystem reads, the merged
 * settings, the conflict/orphan analysis, and the probe gathers happen HERE.
 *
 * --- M2 fault-tolerance (do not break) ---
 * Importing src/paths.mjs triggers a top-level await (via lib/reexport.mjs) that
 * REJECTS when ~/.claude/hooks/lib is absent. The CLI must still run read
 * commands in that state, so commands.mjs's static import graph must stay
 * paths.mjs-free. The PASSIVE probes (probe-mcp/hooks/fs/statusline/access) do
 * NOT touch paths.mjs, so they are statically imported. The ACTIVE loader probe
 * (#19, probe-loader.mjs) DOES import paths.mjs, so it is DYNAMICALLY imported
 * inside loaderProbe() under a try/catch — only when activeProbes is set —
 * exactly mirroring selftestCommand's dynamic paths.mjs import for its boundary
 * gate. That keeps the static graph clean and preserves the missing-hooks-lib
 * fallback.
 *
 * The returned `diagnostics` are ONLY the probe-gather operational diagnostics
 * (e.g. an unreadable auth cache). scan.diagnostics is NOT surfaced here: those
 * facts are CONSUMED by the doctor checks (escalated into judgments like
 * settings-json-valid), so re-emitting them would duplicate the raw fact
 * alongside the doctor's verdict.
 *
 * Never throws. Zero npm dependencies. Node stdlib only.
 */

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scan } from '../discovery/scan.mjs';
import { detectOrphans } from '../discovery/orphan-detector.mjs';
import { analyzeConflicts } from '../analysis/conflicts.mjs';
import { analyzeOrphans } from '../analysis/orphans.mjs';
import { mergeSettings } from '../analysis/settings-merge.mjs';
import { readSettingsLayers } from './settings-layers.mjs';
import { gatherMcpProbes } from '../discovery/probe-mcp.mjs';
import { gatherHookProbes } from '../discovery/probe-hooks.mjs';
import { gatherFsProbes } from '../discovery/probe-fs.mjs';
import { gatherStatuslineProbe } from '../discovery/probe-statusline.mjs';
import { gatherLockProbe, gatherAclProbe } from '../discovery/probe-access.mjs';
import { gatherHookSyntaxProbes } from '../discovery/probe-hook-syntax.mjs';
import { gatherCliProbe } from '../discovery/probe-cli.mjs';

/**
 * @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic
 * @typedef {import('../analysis/doctor/index.mjs').DoctorInput} DoctorInput
 */

/**
 * Gather the DoctorInput facts bundle for a config dir.
 *
 * @param {{ configDir: string, mgrStateDir: string, activeProbes?: boolean, now?: number, cwd?: string }} opts
 * @returns {Promise<{ input: DoctorInput, diagnostics: Diagnostic[] }>}
 */
export async function gatherDoctorInput({ configDir, mgrStateDir, activeProbes = false, now, cwd } = {}) {
  try {
    /** @type {Diagnostic[]} */
    const diagnostics = [];

    const s = scan({ targetClaudeDir: configDir });
    const effective = mergeSettings(readSettingsLayers(configDir).layers).effective || {};

    /** @type {DoctorInput} */
    const input = {
      // Facts the doctor escalates into judgments (the raw scan diagnostics are
      // NOT re-surfaced in our `diagnostics` return — see the header).
      settingsDiagnostics: s.diagnostics,
      pluginDiagnostics: s.diagnostics,
      enabledPlugins: effective.enabledPlugins,
      installedPlugins: s.plugins,
      marketplaces: s.marketplaces,
      conflicts: analyzeConflicts(s.components).conflicts,
      orphans: analyzeOrphans(detectOrphans(configDir)).orphans,
      permissions: effective.permissions,
      now: typeof now === 'number' ? now : Date.now(),
    };

    await addPassiveProbes(input, diagnostics, { configDir, mgrStateDir, effective, mcpServers: s.mcpServers, cwd });
    if (activeProbes) await addActiveProbes(input, diagnostics, configDir);

    return { input, diagnostics };
  } catch (err) {
    // Belt-and-suspenders: the probes never throw, but a defensive envelope keeps
    // the doctor command itself never-throws even if a future probe regresses.
    return { input: {}, diagnostics: [{ severity: 'warn', code: 'doctor-facts-failed', message: errMessage(err), phase: 'doctor' }] };
  }
}

/**
 * Gather the PASSIVE probe facts (read-only: no spawns, no governed-dir writes)
 * and attach them to the input. All passive probes are sync except the ACL probe
 * (read-only icacls, async), which is awaited here so #24 always has its fact.
 * @param {DoctorInput} input  mutated in place
 * @param {Diagnostic[]} diagnostics  appended in place
 * @param {{ configDir: string, mgrStateDir: string, effective: Record<string, unknown>, mcpServers: object[], cwd?: string }} ctx
 * @returns {Promise<void>}
 */
async function addPassiveProbes(input, diagnostics, ctx) {
  const { configDir, mgrStateDir, effective, mcpServers, cwd } = ctx;

  const mcp = gatherMcpProbes({ configDir, mcpServers });
  input.mcpAuth = mcp.mcpAuth;
  input.mcpResolution = mcp.mcpResolution;
  push(diagnostics, mcp.diagnostics);

  const hooks = gatherHookProbes({ hooks: effective.hooks, cwd });
  input.hookFacts = hooks.hookFacts;
  push(diagnostics, hooks.diagnostics);

  const fs = gatherFsProbes({ configDir, mgrStateDir, rulesDocPath: rulesDocPath() });
  input.fsFacts = fs.fsFacts;
  push(diagnostics, fs.diagnostics);

  const sl = gatherStatuslineProbe({ statusLineCommand: statusLineCommand(effective), cwd });
  input.statusline = sl.statusline;
  push(diagnostics, sl.diagnostics);

  const lk = gatherLockProbe({ configDir });
  input.lock = lk.lock;
  push(diagnostics, lk.diagnostics);

  const acl = await gatherAclProbe({ aclDir: mgrStateDir });
  input.acl = acl.acl;
  push(diagnostics, acl.diagnostics);
}

/**
 * Gather the ACTIVE probes (hook-syntax #4, cli #15, loader #19) and attach
 * them. Called ONLY when activeProbes is true, so these spawn/write probes
 * produce ZERO side effects in the default passive run (input.hookSyntax /
 * .cli / .loader stay undefined, and those checks emit nothing).
 * @param {DoctorInput} input  mutated in place
 * @param {Diagnostic[]} diagnostics  appended in place
 * @param {string} configDir
 * @returns {Promise<void>}
 */
async function addActiveProbes(input, diagnostics, configDir) {
  const hs = await gatherHookSyntaxProbes({ hookFacts: input.hookFacts });
  input.hookSyntax = hs.hookSyntax;
  push(diagnostics, hs.diagnostics);

  const cli = await gatherCliProbe({});
  input.cli = cli.cli;
  push(diagnostics, cli.diagnostics);

  const ld = await loaderProbe(configDir);
  input.loader = ld.loader;
  push(diagnostics, ld.diagnostics);
}

/**
 * Dynamically import + run the loader probe (#19). probe-loader.mjs imports
 * paths.mjs (top-level await), so it MUST NOT be in the static graph — a
 * dynamic import isolates that rejection (the M2 missing-hooks-lib case) to a
 * single warn rather than breaking the whole CLI. Mirrors selftestCommand.
 * @param {string} configDir
 * @returns {Promise<{ loader: object|undefined, diagnostics: Diagnostic[] }>}
 */
async function loaderProbe(configDir) {
  try {
    const m = await import('../discovery/probe-loader.mjs');
    return await m.gatherLoaderProbe({ configDir });
  } catch (err) {
    return { loader: undefined, diagnostics: [{ severity: 'warn', code: 'loader-probe-unavailable', message: errMessage(err), phase: 'doctor' }] };
  }
}

// ── small helpers ─────────────────────────────────────────────────────────────

/**
 * Extract the statusLine command string from merged effective settings.
 * statusLine is `{type?, command?}|null`.
 * @param {Record<string, unknown>} effective
 * @returns {string|undefined}
 */
function statusLineCommand(effective) {
  const sl = effective && effective.statusLine;
  return sl && typeof sl === 'object' ? /** @type {any} */ (sl).command : undefined;
}

/**
 * The mgr's own effective-config-rules doc path (powers #25 config-rules-stale).
 * Resolved from this module's URL (src/cli → repo root), NOT via paths.mjs.
 * @returns {string}
 */
function rulesDocPath() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  return join(root, 'docs', 'effective-config-rules.md');
}

/**
 * Append every diagnostic in `src` to `dst`.
 * @param {Diagnostic[]} dst
 * @param {readonly Diagnostic[]} src
 * @returns {void}
 */
function push(dst, src) {
  if (Array.isArray(src)) for (const d of src) dst.push(d);
}

/** @param {unknown} err @returns {string} */
function errMessage(err) {
  return err instanceof Error ? err.message : String(err ?? '');
}
