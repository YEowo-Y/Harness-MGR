/**
 * Target-aware MCP discovery (P6 TOML wave, unit 3).
 *
 * Dispatches MCP-server discovery by the descriptor's mcpSource:
 *   - 'json-files' (Claude / default) — the existing discoverMcp: project-scope
 *     `.mcp.json` + user-scope appFile `mcpServers`.
 *   - 'toml-table' (Codex) — the `mcp_servers` table of a single config.toml. Codex
 *     server entries are FIELD-SHAPE-IDENTICAL to Claude's (command/args/url/type/env),
 *     so each is built through the SAME secret-safe `toRecord` (env -> envKeys NAMES
 *     only, never values), scope 'user' (config.toml is the single user-level config).
 *
 * SECRET-SAFE by reuse: the record builder is mcp.mjs::toRecord (single source) —
 * this module adds NO new secret-handling logic. M2-safe (readTomlFile -> parseToml,
 * both pure, no paths.mjs). Never throws.
 *
 * Zero npm dependencies. Node stdlib only.
 */

import { join } from 'node:path';
import { DiagnosticBag } from '../lib/diagnostic.mjs';
import { isJsonObject } from './read-json.mjs';
import { readTomlFile } from './read-toml.mjs';
import { discoverMcp, toRecord, cmp } from './mcp.mjs';

/**
 * @typedef {import('./mcp.mjs').McpServerRecord} McpServerRecord
 * @typedef {import('./mcp.mjs').McpDiscoveryResult} McpDiscoveryResult
 * @typedef {import('../targets/descriptor.mjs').TargetDescriptor} TargetDescriptor
 */

/** The default mcp source when a descriptor is absent or lacks a usable mcpSource. */
const DEFAULT_SOURCE = Object.freeze({ kind: 'json-files' });

/**
 * Discover MCP servers for the requested target. Claude/default reads JSON
 * (.mcp.json + appFile); Codex reads the config.toml `mcp_servers` table.
 * @param {{rootDir: string, appFile?: string, descriptor?: TargetDescriptor}} opts
 * @returns {McpDiscoveryResult}
 */
export function discoverMcpForTarget(opts) {
  const { rootDir, appFile, descriptor } = opts ?? {};
  const src = mcpSourceOf(descriptor);
  if (src.kind === 'toml-table' && typeof src.file === 'string' && typeof src.pointer === 'string') {
    return discoverMcpToml({ rootDir, file: src.file, pointer: src.pointer });
  }
  return discoverMcp({ rootDir, appFile });
}

/**
 * The mcpSource of a descriptor, or the json-files default. Never throws.
 * @param {unknown} descriptor
 * @returns {{kind: string, file?: string, pointer?: string}}
 */
function mcpSourceOf(descriptor) {
  const src = descriptor && /** @type {any} */ (descriptor).mcpSource;
  if (isJsonObject(src) && typeof src.kind === 'string') return src;
  return DEFAULT_SOURCE;
}

/**
 * Read a config.toml's `<pointer>` table (e.g. mcp_servers) into secret-safe
 * McpServerRecords (scope 'user'). A missing file is benign (no servers); a parse
 * error -> one `mcp-toml-invalid` warn; a non-table server entry -> one
 * `mcp-entry-malformed` warn. Never throws.
 * @param {{rootDir: string, file: string, pointer: string}} opts
 * @returns {McpDiscoveryResult}
 */
function discoverMcpToml(opts) {
  const bag = new DiagnosticBag();
  /** @type {McpServerRecord[]} */
  const servers = [];
  const { rootDir, file, pointer } = opts;

  if (typeof rootDir !== 'string' || rootDir.length === 0) {
    bag.add({ severity: 'error', code: 'discover-bad-root', message: 'rootDir must be a non-empty string', phase: 'mcp' });
    return { mcpServers: servers, diagnostics: bag.all() };
  }

  const path = join(rootDir, file);
  const { value, error, missing } = readTomlFile(path);
  if (missing) return { mcpServers: servers, diagnostics: bag.all() }; // benign — no config.toml
  if (error) {
    bag.add({ severity: 'warn', code: 'mcp-toml-invalid', message: `${file}: ${error}`, path, phase: 'mcp' });
    return { mcpServers: servers, diagnostics: bag.all() };
  }

  const config = isJsonObject(value) ? value : {};
  const map = isJsonObject(config[pointer]) ? config[pointer] : null;
  if (map) {
    for (const name of Object.keys(map)) {
      const cfg = map[name];
      if (!isJsonObject(cfg)) {
        bag.add({ severity: 'warn', code: 'mcp-entry-malformed', message: `MCP server '${name}' is not a table`, path, phase: 'mcp' });
        continue;
      }
      servers.push(toRecord(name, 'user', cfg)); // SAME secret-safe builder as the JSON path
    }
    servers.sort((a, b) => cmp(a.name, b.name));
  }
  return { mcpServers: servers, diagnostics: bag.all() };
}
