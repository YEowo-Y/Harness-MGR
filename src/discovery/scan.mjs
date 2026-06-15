/**
 * Discovery orchestrator (P1.U10).
 *
 * scan({targetClaudeDir, appFile?, kinds?}) → ScanResult
 *
 * Integrates all discovery modules into a single pass. No caching in Phase 1.
 * Never throws; bad input → discover-bad-root diagnostic + empty result.
 *
 * kinds[] (default: all) lets callers run a subset:
 *   'components'   skills / agents / commands  (components.mjs)
 *   'plugins'      installed plugins + known marketplaces (plugins.mjs, marketplaces.mjs)
 *   'settings'     settings.json + top-level dir layout (settings.mjs)
 *   'mcp'          MCP servers across project + user scopes (mcp.mjs)
 *
 * Phase 1 parses all JSON with JSON.parse. The JSONC retrofit (P2.U1) is a
 * one-module swap in read-json.mjs — scan.mjs has no parser dependency.
 *
 * Zero npm dependencies. Node stdlib only.
 */

import { discoverComponentsForTarget } from './components-target.mjs';
import { discoverPluginsForTarget } from './plugins-target.mjs';
import { discoverMarketplaces } from './marketplaces.mjs';
import { discoverSettings, discoverTopLevelDirs } from './settings.mjs';
import { discoverMcpForTarget } from './mcp-target.mjs';
import { DiagnosticBag } from '../lib/diagnostic.mjs';

/**
 * @typedef {import('./components.mjs').ComponentRecord} ComponentRecord
 * @typedef {import('./plugins.mjs').PluginRecord} PluginRecord
 * @typedef {import('./marketplaces.mjs').MarketplaceRecord} MarketplaceRecord
 * @typedef {import('./settings.mjs').SettingsRecord} SettingsRecord
 * @typedef {import('./settings.mjs').TopDirsRecord} TopDirsRecord
 * @typedef {import('./mcp.mjs').McpServerRecord} McpServerRecord
 * @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic
 */

/**
 * The four discovery categories, in execution order.
 * Pass a subset via `kinds?` to run only those scanners.
 */
export const ALL_KINDS = Object.freeze(['components', 'plugins', 'settings', 'mcp']);

/**
 * @typedef {Object} ScanMeta
 * @property {number} durationMs  wall-clock ms from scan start to end
 * @property {string} scannedAt   ISO 8601 timestamp (UTC)
 */

/**
 * @typedef {Object} ScanResult
 * @property {ComponentRecord[]} components
 * @property {PluginRecord[]} plugins
 * @property {MarketplaceRecord[]} marketplaces
 * @property {SettingsRecord} settings      empty stub when 'settings' kind not requested
 * @property {TopDirsRecord} topDirs        empty stub when 'settings' kind not requested;
 *                                          stub's `known` is [] (not the 19-element absent list)
 * @property {McpServerRecord[]} mcpServers
 * @property {Diagnostic[]} diagnostics  AUTHORITATIVE superset: aggregated from all sub-scanners.
 *                                       `settings.diagnostics` and `topDirs.diagnostics` are
 *                                       duplicated here for per-scanner introspection; callers
 *                                       must not union them with this array (double-count risk).
 * @property {ScanMeta} scanMeta
 */

/**
 * Run a full (or filtered) discovery scan against a Claude Code config root.
 *
 * `descriptor` governs component, mcp, AND plugin discovery now (mcp by mcpSource,
 * plugins by pluginSource: Claude reads JSON installed_plugins.json, Codex reads the
 * config.toml `plugins` table); marketplaces/settings stay claude-specific (deferred
 * TOML wave).
 *
 * @param {{targetClaudeDir: string, appFile?: string, kinds?: string[], descriptor?: import('../targets/descriptor.mjs').TargetDescriptor}} opts
 * @returns {ScanResult}
 */
export function scan(opts) {
  const start = Date.now();
  const bag = new DiagnosticBag();
  const { targetClaudeDir, appFile, kinds, descriptor } = opts ?? {};

  if (typeof targetClaudeDir !== 'string' || targetClaudeDir.length === 0) {
    bag.add({ severity: 'error', code: 'discover-bad-root', message: 'targetClaudeDir must be a non-empty string', phase: 'scan' });
    return mkEmpty(bag, start);
  }

  const enabled = normaliseKinds(kinds);

  // ── Components (skills / agents / commands) ─────────────────────────────────
  // discoverComponentsForTarget = the per-target HOME walk PLUS any extra
  // componentSources the descriptor declares (codex plugin caches). Claude declares
  // none → byte-identical to the old discoverComponents call (drift-guarded).
  let components = [];
  if (enabled.has('components')) {
    const r = discoverComponentsForTarget({ rootDir: targetClaudeDir, descriptor });
    components = r.components;
    addAll(bag, r.diagnostics);
  }

  // ── Plugins + Marketplaces ──────────────────────────────────────────────────
  let plugins = [];
  let marketplaces = [];
  if (enabled.has('plugins')) {
    const rp = discoverPluginsForTarget({ rootDir: targetClaudeDir, descriptor });
    plugins = rp.plugins;
    addAll(bag, rp.diagnostics);

    const rm = discoverMarketplaces(targetClaudeDir);
    marketplaces = rm.marketplaces;
    addAll(bag, rm.diagnostics);
  }

  // ── Settings + Top-level dirs ───────────────────────────────────────────────
  let settings = mkEmptySettings();
  let topDirs = mkEmptyTopDirs();
  if (enabled.has('settings')) {
    settings = discoverSettings(targetClaudeDir);
    addAll(bag, settings.diagnostics);
    topDirs = discoverTopLevelDirs(targetClaudeDir);
    addAll(bag, topDirs.diagnostics);
  }

  // ── MCP servers ─────────────────────────────────────────────────────────────
  let mcpServers = [];
  if (enabled.has('mcp')) {
    const r = discoverMcpForTarget({ rootDir: targetClaudeDir, appFile, descriptor });
    mcpServers = r.mcpServers;
    addAll(bag, r.diagnostics);
  }

  return {
    components,
    plugins,
    marketplaces,
    settings,
    topDirs,
    mcpServers,
    diagnostics: bag.all(),
    scanMeta: { durationMs: Date.now() - start, scannedAt: new Date().toISOString() },
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Normalize the kinds parameter. An absent, empty, or fully-invalid list
 * defaults to ALL_KINDS. Unknown kind strings are silently dropped.
 * @param {unknown} kinds
 * @returns {Set<string>}
 */
function normaliseKinds(kinds) {
  if (!Array.isArray(kinds) || kinds.length === 0) return new Set(ALL_KINDS);
  const valid = kinds.filter((k) => ALL_KINDS.includes(k));
  return valid.length > 0 ? new Set(valid) : new Set(ALL_KINDS);
}

/**
 * Append every diagnostic in `diags` to `bag`. Re-normalises each entry so
 * any stray malformed diagnostic from a sub-scanner is sanitised here.
 * @param {DiagnosticBag} bag
 * @param {readonly Diagnostic[]} diags
 */
function addAll(bag, diags) {
  for (const d of diags) bag.add(d);
}

/** @returns {SettingsRecord} */
function mkEmptySettings() {
  return /** @type {any} */ ({ path: '', present: false, statusLine: null, diagnostics: [] });
}

/** @returns {TopDirsRecord} */
function mkEmptyTopDirs() {
  return /** @type {any} */ ({ known: [], unknown: [], diagnostics: [] });
}

/**
 * Build a fully-empty ScanResult for the error/bad-input path.
 * @param {DiagnosticBag} bag
 * @param {number} start
 * @returns {ScanResult}
 */
function mkEmpty(bag, start) {
  return {
    components: [],
    plugins: [],
    marketplaces: [],
    settings: mkEmptySettings(),
    topDirs: mkEmptyTopDirs(),
    mcpServers: [],
    diagnostics: bag.all(),
    scanMeta: { durationMs: Date.now() - start, scannedAt: new Date().toISOString() },
  };
}
