/**
 * Doctor fact-gathering — the I/O orchestration boundary for `doctor` (P2.U11).
 *
 * A sibling of resolve-config.mjs: where that decides WHICH `~/.claude` is
 * governed, this gathers the FACTS the pure `runDoctor` judges. The doctor's
 * index.mjs is a pure consumer (no I/O); all the filesystem reads, the merged
 * settings, the conflict/orphan analysis, and the probe gathers happen HERE.
 *
 * --- paths.mjs-free static graph (do not break) ---
 * commands.mjs's static import graph must stay paths.mjs-free (the M2-safe
 * property the boundary self-check enforces). The PASSIVE probes
 * (probe-mcp/hooks/fs/statusline/access) do NOT touch paths.mjs, so they are
 * statically imported. The ACTIVE loader probe (#19, probe-loader.mjs) DOES
 * import paths.mjs, so it is DYNAMICALLY imported inside loaderProbe() under a
 * try/catch — only when activeProbes is set — exactly mirroring selftestCommand's
 * dynamic paths.mjs import for its boundary gate. That keeps the static graph
 * clean, and the try/catch degrades to a single warn if that load ever fails
 * (defence-in-depth). (Historically paths.mjs -> reexport.mjs top-level-awaited and
 * rejected when ~/.claude/hooks/lib was absent; the resolver is first-party now, so
 * that specific reject is gone.)
 *
 * The returned `diagnostics` are ONLY the probe-gather operational diagnostics
 * (e.g. an unreadable auth cache). scan.diagnostics is NOT surfaced here: those
 * facts are CONSUMED by the doctor checks (escalated into judgments like
 * settings-json-valid), so re-emitting them would duplicate the raw fact
 * alongside the doctor's verdict.
 *
 * --- `facts` (P5.U5, ADDITIVE third return key) ---
 * The `health` command needs facts this gather ALREADY computes internally but
 * DoctorInput does not expose (raw components, the full scan diagnostics, the
 * merged effective.hooks). They are EXPOSED — never recomputed — as a third
 * return key. doctorCommand destructures only `{input, diagnostics}` and is
 * byte-identical; nothing is scanned twice.
 *
 * Never throws. Zero npm dependencies. Node stdlib only.
 */

import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scan } from '../discovery/scan.mjs';
import { detectOrphans } from '../discovery/orphan-detector.mjs';
import { gatherCodexConfig } from '../discovery/probe-codex-config.mjs';
import { analyzeConflicts } from '../analysis/conflicts.mjs';
import { targetModelsShadowing } from '../analysis/codex-coexistence.mjs';
import { analyzeOrphans } from '../analysis/orphans.mjs';
import { isCaseInsensitiveFs } from '../lib/name-identity.mjs';
import { mergeSettings } from '../analysis/settings-merge.mjs';
import { readSettingsLayers } from './settings-layers.mjs';
import { gatherEffectiveHooks } from './effective-hooks.mjs';
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
 * The already-computed facts the `health` command (P5.U5) consumes — exposed,
 * not recomputed (module header). All fields are total: arrays/objects even on
 * the failure path.
 *
 * @typedef {Object} HealthFacts
 * @property {import('../discovery/components.mjs').ComponentRecord[]} components  scan().components
 * @property {Diagnostic[]} scanDiagnostics  the FULL aggregated scan diagnostics
 * @property {import('../analysis/conflicts.mjs').ConflictCluster[]} conflicts  analyzeConflicts clusters (same array as input.conflicts)
 * @property {Record<string, unknown>} effectiveHooks  merged effective.hooks ({} when absent)
 * @property {object[]} hookFacts  passive probe-hooks facts (same array as input.hookFacts)
 */

/**
 * Gather the DoctorInput facts bundle for a config dir.
 *
 * `descriptor` makes the gathered facts target-aware. The scan() threads the
 * descriptor, so COMPONENTS, PLUGINS (by pluginSource), and MCP (by mcpSource) are
 * codex-aware, and the HOOK SOURCE is target-aware (Claude merges settings layers;
 * Codex reads hooks.json). The plugin checks #7/#8/#9/#10 judge a target-aware
 * enabledPlugins map (enabledPluginsForTarget). What stays Claude-CONFIG-shaped (an
 * honest deferral, not a false finding — these produce nothing for codex): #6/#22
 * settings/plugin-schema validity, #23 permissions-overbroad, #18 statusline — codex's
 * equivalents live in config.toml / are the per-project trust_level model (#27). #11
 * duplicate-component-shadowing is kept empty for codex on purpose: codex models no
 * Claude-style shadowing (same-name components coexist per Codex docs), so the Claude
 * shadowing model is NOT run on a codex target — the multi-source co-existence view is
 * surfaced by `conflicts --target codex` instead (targetModelsShadowing single-sources this).
 *
 * @param {{ configDir: string, mgrStateDir: string, descriptor?: import('../targets/descriptor.mjs').TargetDescriptor, activeProbes?: boolean, now?: number, cwd?: string }} opts
 * @returns {Promise<{ input: DoctorInput, diagnostics: Diagnostic[], facts: HealthFacts }>}
 */
export async function gatherDoctorInput({ configDir, mgrStateDir, descriptor, activeProbes = false, now, cwd } = {}) {
  try {
    /** @type {Diagnostic[]} */
    const diagnostics = [];

    const s = scan({ targetClaudeDir: configDir, descriptor });
    const effective = mergeSettings(readSettingsLayers(configDir).layers).effective || {};
    // Target-aware hook source: reuse `effective` for the settings-merge (Claude)
    // path; read hooks.json for the json-file (Codex) path. A codex hooks.json
    // read error surfaces as a warn here.
    const hookSrc = gatherEffectiveHooks({ configDir, descriptor, effective });
    push(diagnostics, hookSrc.diagnostics);
    // #11 duplicate-component-shadowing. Codex models no Claude-style shadowing
    // (same-name components coexist per Codex docs); the multi-source scan now puts
    // plugin skills in s.components, so running the Claude shadowing model on a codex
    // target would mis-report plugin-vs-plugin co-existence as a #11 winner. Keep #11
    // honestly empty for codex; Claude is byte-identical. targetModelsShadowing is the
    // single source for the "codex doesn't shadow" decision (shared with conflictsCommand).
    // Whether the governed volume folds case (Windows NTFS / macOS APFS default).
    // Threaded into both conflict grouping and the #29 skillOverrides audit so a
    // differently-cased name is treated as the SAME identity there (and stays
    // distinct on a case-sensitive Linux volume).
    const caseInsensitive = isCaseInsensitiveFs();
    const conflicts = targetModelsShadowing(descriptor)
      ? analyzeConflicts(s.components, { caseInsensitive }).conflicts
      : [];

    /** @type {DoctorInput} */
    const input = {
      // Facts the doctor escalates into judgments (the raw scan diagnostics are
      // NOT re-surfaced in our `diagnostics` return — see the header).
      settingsDiagnostics: s.diagnostics,
      pluginDiagnostics: s.diagnostics,
      // Target-aware enable signal (descriptor.pluginEnableModel). Claude/default reads
      // the merged settings enabledPlugins map (byte-identical); Codex synthesizes one
      // from the scanned record `enabled` flags. The scan() above threads the descriptor
      // so codex plugins/mcp are visible to the doctor — the #8 false-positive U6 warned
      // about is prevented HERE by the correct enable model, not by hiding the facts.
      enabledPlugins: enabledPluginsForTarget(descriptor, effective, s.plugins),
      // skillOverrides audit facts (#29): the Claude-only merged visibility map + the
      // directory-backed skill names it should point at. Codex → {} (no skillOverrides).
      skillOverrides: skillOverridesForTarget(descriptor, effective),
      skillDirs: skillNamesFromScan(s.components),
      caseInsensitive, // #29 compares override keys vs skillDirs by case-folded identity here
      installedPlugins: s.plugins,
      marketplaces: s.marketplaces,
      conflicts,
      // Descriptor threaded so codex dirs are NOT flagged as orphans (CC byte-identical:
      // no-descriptor === claudeDescriptor, drift-guarded).
      orphans: analyzeOrphans(detectOrphans(configDir, { descriptor })).orphans,
      permissions: effective.permissions,
      now: typeof now === 'number' ? now : Date.now(),
    };

    // Codex-only facts: config.toml validity (#26) + project trust (#27) +
    // leftover-state-tmp bloat (#28). Only gathered for a codex target; a
    // Claude/absent descriptor leaves input.codexConfig undefined, so #26/#27/#28
    // contribute nothing to a Claude run.
    if (descriptor && descriptor.id === 'codex') {
      const cc = gatherCodexConfig({ configDir, homeDir: homedir() });
      input.codexConfig = cc.codexConfig;
      push(diagnostics, cc.diagnostics);
    }

    await addPassiveProbes(input, diagnostics, { configDir, mgrStateDir, effective, hooksMap: hookSrc.hooks, mcpServers: s.mcpServers, cwd });
    if (activeProbes) await addActiveProbes(input, diagnostics, configDir);

    return { input, diagnostics, facts: buildHealthFacts(s, hookSrc.hooks, conflicts, input) };
  } catch (err) {
    // Belt-and-suspenders: the probes never throw, but a defensive envelope keeps
    // the doctor command itself never-throws even if a future probe regresses.
    return { input: {}, diagnostics: [{ severity: 'warn', code: 'doctor-facts-failed', message: errMessage(err), phase: 'doctor' }], facts: emptyHealthFacts() };
  }
}

/**
 * Assemble the HealthFacts bundle from values this gather already computed —
 * EXPOSE, never recompute (no second scan). `hooksMap` is the target-aware hooks
 * map (gatherEffectiveHooks output, already normalised toward an object); hookFacts
 * was attached to `input` by addPassiveProbes just above.
 * @param {import('../discovery/scan.mjs').ScanResult} s
 * @param {unknown} hooksMap
 * @param {object[]} conflicts
 * @param {DoctorInput} input
 * @returns {HealthFacts}
 */
function buildHealthFacts(s, hooksMap, conflicts, input) {
  return {
    components: s.components,
    scanDiagnostics: s.diagnostics,
    conflicts,
    effectiveHooks: hooksMap !== null && typeof hooksMap === 'object' && !Array.isArray(hooksMap) ? /** @type {Record<string, unknown>} */ (hooksMap) : {},
    hookFacts: Array.isArray(input.hookFacts) ? input.hookFacts : [],
  };
}

/** A total (all-empty) HealthFacts for the defensive failure path. @returns {HealthFacts} */
function emptyHealthFacts() {
  return { components: [], scanDiagnostics: [], conflicts: [], effectiveHooks: {}, hookFacts: [] };
}

/**
 * Gather the PASSIVE probe facts (read-only: no spawns, no governed-dir writes)
 * and attach them to the input. All passive probes are sync except the ACL probe
 * (read-only icacls, async), which is awaited here so #24 always has its fact.
 * @param {DoctorInput} input  mutated in place
 * @param {Diagnostic[]} diagnostics  appended in place
 * @param {{ configDir: string, mgrStateDir: string, effective: Record<string, unknown>, hooksMap: unknown, mcpServers: object[], cwd?: string }} ctx
 * @returns {Promise<void>}
 */
async function addPassiveProbes(input, diagnostics, ctx) {
  const { configDir, mgrStateDir, effective, hooksMap, mcpServers, cwd } = ctx;

  const mcp = gatherMcpProbes({ configDir, mcpServers });
  input.mcpAuth = mcp.mcpAuth;
  input.mcpResolution = mcp.mcpResolution;
  push(diagnostics, mcp.diagnostics);

  // hooksMap is the target-aware hooks (Codex hooks.json or Claude merged settings);
  // statusLine stays Claude-specific (effective.statusLine) — deferred codex wave.
  const hooks = gatherHookProbes({ hooks: hooksMap, cwd });
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
 * paths.mjs, so it MUST NOT be in the static graph (keeping this module's static
 * graph paths.mjs-free — the M2-safe property the boundary self-check enforces);
 * the dynamic import under try/catch also isolates any load failure to a single
 * warn rather than breaking the whole CLI (defence-in-depth). Mirrors selftestCommand.
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
 * The enabledPlugins map the pure plugin checks (#7/#8/#10) judge, made target-aware
 * so codex plugins are evaluated with the CORRECT enable signal once scan() threads
 * the descriptor.
 *
 *   - 'record-flag' (Codex): there is no settings enabledPlugins map, so synthesize one
 *     from the scanned config.toml records — `{ [key]: record.enabled === true }`. A codex
 *     entry is BOTH the install record and the enable flag, so #7 plugin-enabled-not-installed
 *     is structurally 0 (every key is also an installed key) and #8 fires only for the
 *     records whose own flag is false. Null-proto map + proto-key-guarded.
 *   - 'settings-map' / absent / Claude: the merged settings enabledPlugins map — today's
 *     behavior, byte-identical (the install record's own `enabled` flag is unreliable).
 *
 * Never throws (defensive against a non-array plugins list / malformed records).
 * @param {import('../targets/descriptor.mjs').TargetDescriptor|undefined} descriptor
 * @param {Record<string, unknown>} effective
 * @param {import('../discovery/plugins.mjs').PluginRecord[]} plugins
 * @returns {Record<string, unknown>|undefined}
 */
function enabledPluginsForTarget(descriptor, effective, plugins) {
  if (descriptor && descriptor.pluginEnableModel === 'record-flag') {
    const map = Object.create(null);
    const list = Array.isArray(plugins) ? plugins : [];
    for (const p of list) {
      if (p && typeof p.key === 'string' && p.key.length > 0 && isSafeKey(p.key)) {
        map[p.key] = p.enabled === true;
      }
    }
    return map;
  }
  return effective.enabledPlugins;
}

/**
 * Target-aware skillOverrides map (Claude-only). skillOverrides is a Claude settings.json
 * concept (Codex governs skills via config.toml [[skills.config]]); a codex target gets {} so
 * the orphan check (#29) contributes nothing. Claude/absent reads the merged effective map
 * (the U1 single read point); a missing/malformed value degrades to {} (never throws).
 * @param {import('../targets/descriptor.mjs').TargetDescriptor|undefined} descriptor
 * @param {Record<string, unknown>} effective
 * @returns {Record<string, unknown>}
 */
function skillOverridesForTarget(descriptor, effective) {
  if (descriptor && descriptor.id === 'codex') return {};
  const so = effective && effective.skillOverrides;
  return so && typeof so === 'object' && !Array.isArray(so) ? so : {};
}

/**
 * The directory-backed skill NAMES from the scan (the set skillOverrides governs). For a Claude
 * scan s.components skills ARE the user-scope skills/<name> dirs (plugin skills come from a
 * separate discovery, not s.components), so an override key absent here = a removed/renamed skill
 * or a plugin skill the override can't affect. Pure; tolerates a non-array.
 * @param {import('../discovery/components.mjs').ComponentRecord[]} components
 * @returns {string[]}
 */
function skillNamesFromScan(components) {
  const list = Array.isArray(components) ? components : [];
  return list.filter((c) => c && c.kind === 'skill' && typeof c.name === 'string').map((c) => c.name);
}

/**
 * Reject prototype-polluting keys when building a map from user/config-authored keys.
 * @param {string} key
 * @returns {boolean}
 */
function isSafeKey(key) {
  return key !== '__proto__' && key !== 'constructor' && key !== 'prototype';
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
