/**
 * Target descriptor registry + resolver (P6.U1).
 *
 * claude-mgr's target-specific knowledge already lives in frozen DATA tables, not
 * logic (KIND_RULES, KNOWN_TOP_DIRS/FILES, WALK_DIRS, APPLY_WRITABLE_FILES). This
 * module packages each target's read-only tables into one descriptor and resolves
 * the requested one.
 *
 * PURE / never-throws / proto-safe / frozen / zero npm deps. Imports only the two
 * sibling descriptor modules (themselves frozen pure data). NEVER imports
 * paths.mjs (async, top-level-await) — fs auto-detect of a configDir lands in U2.
 */

import { claudeDescriptor } from './claude.mjs';
import { codexDescriptor } from './codex.mjs';

/**
 * @typedef {Object} ComponentKindSpec
 * @property {'skill'|'agent'|'command'} kind
 * @property {string} dir                          sub-directory under the config root
 * @property {'skill-md'|'flat-md'|'flat-toml'} layout   on-disk shape of each component
 */

/**
 * @typedef {Object} HookSource
 * @property {'settings-merge'|'json-file'} kind   where this target's hooks live:
 *   'settings-merge' = the merged settings layers' `hooks` (Claude); 'json-file' =
 *   a standalone top-level JSON file's pointer field (Codex `hooks.json` → `.hooks`).
 * @property {string} [file]      json-file: the file name under the config root (e.g. 'hooks.json')
 * @property {string} [pointer]   json-file: the top-level key holding the hooks map (e.g. 'hooks')
 */

/**
 * @typedef {Object} ConfigSource
 * @property {'settings-merge'|'toml-file'} kind   where this target's effective config lives:
 *   'settings-merge' = the merged settings layers (Claude settings.json + .local); 'toml-file'
 *   = a single TOML file (Codex `config.toml` — one source, no layering/merge).
 * @property {string} [file]      toml-file: the file name under the config root (e.g. 'config.toml')
 */

/**
 * @typedef {Object} McpSource
 * @property {'json-files'|'toml-table'} kind   where this target's MCP servers live:
 *   'json-files' = project `.mcp.json` + user appFile `mcpServers` (Claude); 'toml-table'
 *   = a `<pointer>` table inside a single TOML file (Codex `config.toml` → `mcp_servers`).
 * @property {string} [file]      toml-table: the TOML file under the config root (e.g. 'config.toml')
 * @property {string} [pointer]   toml-table: the top-level table holding the servers (e.g. 'mcp_servers')
 */

/**
 * @typedef {Object} PluginSource
 * @property {'json-file'|'toml-table'} kind   where this target's plugins live:
 *   'json-file' = plugins/installed_plugins.json (Claude); 'toml-table' = a `<pointer>`
 *   table inside a single TOML file (Codex `config.toml` → `plugins`).
 * @property {string} [file]      toml-table: the TOML file under the config root (e.g. 'config.toml')
 * @property {string} [pointer]   toml-table: the top-level table holding the plugins (e.g. 'plugins')
 */

/**
 * @typedef {Object} TargetDescriptor
 * @property {'claude'|'codex'} id
 * @property {string} label
 * @property {string} defaultHomeSubdir            e.g. '.claude' / '.codex'
 * @property {string} signatureFile                the file whose presence identifies this target (auto-detect, U2)
 * @property {ComponentKindSpec[]} componentKinds
 * @property {string[]} governedConfigFiles
 * @property {string[]} knownTopDirs
 * @property {string[]} knownTopFiles
 * @property {RegExp[]} knownTopFilePatterns
 * @property {HookSource} hookSource               where to read the effective hooks map (P6.U4)
 * @property {ConfigSource} configSource           where to read the effective config (P6 TOML wave)
 * @property {McpSource} mcpSource                 where to read MCP servers (P6 TOML wave)
 * @property {PluginSource} pluginSource           where to read plugins (P6 TOML wave)
 * @property {'settings-map'|'record-flag'} pluginEnableModel  how the doctor decides a
 *   plugin is enabled (P6 doctor wave): 'settings-map' = the merged settings
 *   enabledPlugins map is authoritative and the install record's own `enabled` flag is
 *   IGNORED (Claude — that flag is unreliable, false even for active plugins);
 *   'record-flag' = each plugin record's own `enabled` flag is authoritative and there
 *   is no settings enabledPlugins map (Codex — config.toml `[plugins."k"] enabled`).
 */

/** The frozen registry of known targets, keyed by descriptor id. */
export const TARGETS = Object.freeze({
  claude: claudeDescriptor,
  codex: codexDescriptor,
});

/**
 * Resolve the requested target descriptor.
 *
 * Semantics (pure, never-throws, proto-safe):
 *   - opts null/undefined/non-object        → the DEFAULT (claudeDescriptor).
 *   - opts.target a known id 'claude'|'codex' → that descriptor.
 *   - opts.target an UNKNOWN non-empty string → undefined (the U2 CLI maps this to
 *                                               a usage error; we do NOT silently
 *                                               default an invalid target to claude).
 *   - opts.target absent/empty/non-string    → the DEFAULT (claudeDescriptor).
 *
 * `opts.configDir` is accepted in the signature but UNUSED in U1 — fs auto-detect
 * (signatureFile probing) lands in U2.
 *
 * @param {{target?: string, configDir?: string}|null} [opts]
 * @returns {TargetDescriptor|undefined}
 */
export function resolveTarget(opts) {
  if (opts === null || typeof opts !== 'object') return claudeDescriptor;

  const target = opts.target;
  if (typeof target !== 'string' || target.length === 0) return claudeDescriptor;

  // Own-property lookup ONLY: 'constructor'/'__proto__'/'prototype' resolve to
  // undefined (NOT inherited functions), so an unknown/hostile target is rejected.
  if (Object.prototype.hasOwnProperty.call(TARGETS, target)) return TARGETS[target];

  return undefined;
}
