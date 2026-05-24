/**
 * MCP passive probe gatherer (P2.U5b).
 *
 * Performs the read-only I/O behind two doctor checks — keeping the doctor
 * itself pure (no I/O) by gathering facts here in the discovery layer:
 *
 *   #1 mcp-auth-stale    — read <configDir>/mcp-needs-auth-cache.json and emit
 *                          each server's needs-auth timestamp as a McpAuthFact.
 *                          The doctor computes staleness against a reference time.
 *
 *   #2 mcp-server-resolvable — for each STDIO MCP server, probe whether its
 *                              `command` token resolves on PATH via filesystem
 *                              reads only (resolveCommand never spawns).
 *
 * Never throws. Degrades to diagnostics on any bad input or unreadable file.
 * Zero npm dependencies. Node stdlib only.
 */

import { join } from 'node:path';
import { DiagnosticBag } from '../lib/diagnostic.mjs';
import { readJsonFile, isJsonObject } from './read-json.mjs';
import { resolveCommand } from '../lib/resolve-command.mjs';

/**
 * @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic
 */

/**
 * @typedef {Object} McpAuthFact
 * @property {string} name       MCP server / connector name (the cache key)
 * @property {number} timestamp  epoch ms recorded in the needs-auth cache
 */

/**
 * @typedef {Object} McpResolutionFact
 * @property {string} name       MCP server name
 * @property {string} command    the stdio command token that was probed
 * @property {boolean} resolved  whether the command resolved on PATH / disk
 */

/**
 * Guard against prototype-polluting keys that JSON.parse can produce as own
 * enumerable keys when the JSON literally contains "__proto__".
 * @param {string} key
 * @returns {boolean}
 */
function isSafeKey(key) {
  return key !== '__proto__' && key !== 'constructor' && key !== 'prototype';
}

/**
 * Read the mcp-needs-auth-cache.json file and return McpAuthFact[] plus any
 * diagnostics. A missing file is benign (nothing awaiting auth).
 * @param {string} file  absolute path to mcp-needs-auth-cache.json
 * @param {DiagnosticBag} bag
 * @returns {McpAuthFact[]}
 */
function readAuthCache(file, bag) {
  const { value, error, missing } = readJsonFile(file);

  if (missing) return [];

  if (error) {
    bag.add({ severity: 'warn', code: 'mcp-auth-cache-unreadable', message: error, path: file, phase: 'mcp-probe' });
    return [];
  }

  if (!isJsonObject(value)) {
    bag.add({ severity: 'warn', code: 'mcp-auth-cache-malformed', message: 'mcp-needs-auth-cache.json is not a JSON object', path: file, phase: 'mcp-probe' });
    return [];
  }

  /** @type {McpAuthFact[]} */
  const facts = [];

  for (const key of Object.keys(value)) {
    if (!isSafeKey(key)) continue;

    const entry = value[key];
    if (isJsonObject(entry) && Number.isFinite(entry.timestamp)) {
      facts.push({ name: key, timestamp: entry.timestamp });
    } else {
      bag.add({ severity: 'warn', code: 'mcp-auth-entry-malformed', message: `mcp-needs-auth cache entry '${key}' is missing a valid timestamp`, phase: 'mcp-probe' });
    }
  }

  return facts;
}

/**
 * Probe each stdio MCP server's command for PATH resolution and return
 * McpResolutionFact[] (one per stdio server that has a string command).
 * @param {object[]} servers  McpServerRecord array (may be empty/junk-filtered)
 * @param {{ env?: object, platform?: string, cwd?: string }} probeOpts
 * @returns {McpResolutionFact[]}
 */
function resolveServers(servers, probeOpts) {
  /** @type {McpResolutionFact[]} */
  const facts = [];

  for (const server of servers) {
    if (!isJsonObject(server)) continue;
    if (server.transport !== 'stdio') continue;
    if (typeof server.command !== 'string' || server.command.length === 0) continue;

    const { resolved } = resolveCommand(server.command, probeOpts);
    const name = typeof server.name === 'string' ? server.name : '';
    facts.push({ name, command: server.command, resolved });
  }

  return facts;
}

/**
 * Gather passive MCP probe facts for the doctor layer.
 * @param {{ configDir?: string, mcpServers?: object[], env?: object, platform?: string, cwd?: string }} opts
 * @returns {{ mcpAuth: McpAuthFact[], mcpResolution: McpResolutionFact[], diagnostics: Diagnostic[] }}
 */
export function gatherMcpProbes(opts) {
  const bag = new DiagnosticBag();
  const { configDir, mcpServers, env, platform, cwd } = opts ?? {};

  /** @type {McpAuthFact[]} */
  let mcpAuth = [];

  if (typeof configDir === 'string' && configDir.length > 0) {
    const file = join(configDir, 'mcp-needs-auth-cache.json');
    mcpAuth = readAuthCache(file, bag);
  } else {
    bag.add({ severity: 'error', code: 'discover-bad-root', message: 'configDir must be a non-empty string', phase: 'mcp-probe' });
  }

  const servers = Array.isArray(mcpServers) ? mcpServers : [];
  const mcpResolution = resolveServers(servers, { env, platform, cwd });

  return { mcpAuth, mcpResolution, diagnostics: bag.all() };
}
