/**
 * MCP server discovery (P1.U9).
 *
 * Emits a deterministic `McpServerRecord[]` from two scopes, NEVER throwing:
 *   - project: `<rootDir>/.mcp.json`            → scope 'project'
 *   - user:    `<appFile>` TOP-LEVEL mcpServers → scope 'user'
 *
 * `appFile` is the home-level `~/.claude.json` (resolved by the CLI via
 * paths.mjs::targetAppFile). We read ONLY its top-level `mcpServers` — the
 * per-project `projects["<path>"].mcpServers` blocks are project state, not
 * user-scope, and are intentionally ignored.
 *
 * --- Secret safety (decided) ---
 * A server's `env` block can hold API keys. We record env KEY NAMES only
 * (`envKeys`), never values, so inventory output and snapshots cannot leak a
 * secret. command/args/url are recorded verbatim (they are not secrets).
 *
 * --- Pure module ---
 * Takes explicit paths; depends only on node:path + the shared JSON reader and
 * DiagnosticBag. No reexport, no homedir resolution.
 *
 * Zero npm dependencies. Node stdlib only.
 */

import { join } from 'node:path';
import { DiagnosticBag } from '../lib/diagnostic.mjs';
import { readJsonFile, isJsonObject } from './read-json.mjs';

/**
 * @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic
 */

/**
 * @typedef {'project'|'user'} McpScope
 */

/**
 * @typedef {Object} McpServerRecord
 * @property {string} name
 * @property {McpScope} scope
 * @property {'stdio'|'http'|'unknown'} transport
 * @property {string} [command]
 * @property {string[]} [args]
 * @property {string} [url]
 * @property {string[]} [envKeys]   env variable NAMES only — never values (secret-safe)
 */

/**
 * @typedef {Object} McpDiscoveryResult
 * @property {McpServerRecord[]} mcpServers
 * @property {Diagnostic[]} diagnostics
 */

/**
 * Discover MCP servers across project and user scopes.
 * @param {{rootDir: string, appFile?: string}} opts
 * @returns {McpDiscoveryResult}
 */
export function discoverMcp(opts) {
  const bag = new DiagnosticBag();
  // `?? {}` makes every junk input (null/undefined/number/string) destructure
  // safely to undefined fields — the bad-root guard below then handles them.
  const { rootDir, appFile } = opts ?? {};

  /** @type {McpServerRecord[]} */
  const servers = [];

  if (typeof rootDir === 'string' && rootDir.length > 0) {
    readScope(join(rootDir, '.mcp.json'), 'project', servers, bag);
  } else {
    bag.add({ severity: 'error', code: 'discover-bad-root', message: 'rootDir must be a non-empty string', phase: 'mcp' });
  }

  if (typeof appFile === 'string' && appFile.length > 0) {
    readScope(appFile, 'user', servers, bag);
  }

  servers.sort((a, b) => (a.scope !== b.scope ? cmp(a.scope, b.scope) : cmp(a.name, b.name)));
  return { mcpServers: servers, diagnostics: bag.all() };
}

/**
 * Read one scope's file and append its top-level `mcpServers` as records.
 * A missing file is benign (no servers at that scope). Unreadable/malformed
 * JSON and malformed entries become diagnostics.
 * @param {string} file
 * @param {McpScope} scope
 * @param {McpServerRecord[]} out
 * @param {DiagnosticBag} bag
 */
function readScope(file, scope, out, bag) {
  const { value, error, missing } = readJsonFile(file);
  if (missing) return;
  if (error) {
    bag.add({ severity: 'error', code: 'mcp-unreadable', message: error, path: file, phase: 'mcp' });
    return;
  }
  if (!isJsonObject(value)) {
    bag.add({ severity: 'warn', code: 'mcp-malformed', message: 'MCP config is not a JSON object', path: file, phase: 'mcp' });
    return;
  }
  const map = value.mcpServers;
  if (!isJsonObject(map)) return; // no servers declared at this scope — fine

  for (const name of Object.keys(map)) {
    const cfg = map[name];
    if (!isJsonObject(cfg)) {
      bag.add({ severity: 'warn', code: 'mcp-entry-malformed', message: `MCP server '${name}' is not an object`, path: file, phase: 'mcp' });
      continue;
    }
    out.push(toRecord(name, scope, cfg));
  }
}

/**
 * Build a secret-safe record from a server config.
 * @param {string} name
 * @param {McpScope} scope
 * @param {Record<string, *>} cfg
 * @returns {McpServerRecord}
 */
export function toRecord(name, scope, cfg) {
  /** @type {McpServerRecord} */
  const rec = { name, scope, transport: transportOf(cfg) };
  if (typeof cfg.command === 'string') rec.command = cfg.command;
  if (Array.isArray(cfg.args)) rec.args = cfg.args.filter((a) => typeof a === 'string');
  if (typeof cfg.url === 'string') rec.url = cfg.url;
  if (isJsonObject(cfg.env)) rec.envKeys = Object.keys(cfg.env).sort(); // NAMES ONLY — never values
  return rec;
}

/**
 * Classify transport: explicit `type:"http"` or a `url` is http; a `command` is
 * stdio; otherwise unknown.
 * @param {Record<string, *>} cfg
 * @returns {'stdio'|'http'|'unknown'}
 */
function transportOf(cfg) {
  if (cfg.type === 'http' || typeof cfg.url === 'string') return 'http';
  if (typeof cfg.command === 'string') return 'stdio';
  return 'unknown';
}

/** @param {string} a @param {string} b @returns {number} */
export function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}
