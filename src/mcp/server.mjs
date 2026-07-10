/**
 * MCP server (P5.U6) — exposes harness-mgr's READ-ONLY view as Model Context
 * Protocol tools over stdio, so the same local user's Claude Code can inspect
 * the live harness (inventory / health / conflicts / doctor).
 *
 * --- A separate PROCESS ROLE, not a CLI subcommand ---
 * This module is deliberately NOT registered in `COMMANDS` (a hanging stdio
 * server has no place in the run()→exit command model, and the full-command
 * smoke drift-guard deepEquals its table against COMMANDS keys). Launch it
 * directly:  `node src/mcp/server.mjs`  — e.g. registered in Claude Code via
 * `claude mcp add harness-mgr -- node <abs path>/src/mcp/server.mjs`.
 *
 * --- Tools delegate to the EXISTING stable contract ---
 * Every tool invokes `run(['<command>','--format','json'])` from cli.mjs — the
 * same `version:1` JSON envelope the TUI consumes — so secret redaction,
 * diagnostics, and exit semantics come for free and cannot drift from the CLI.
 * `harness_mgr_doctor` runs PASSIVE checks only (never `--active-probes`:
 * active probing spawns tools and briefly writes a probe file — that stays an
 * explicit human opt-in, not an MCP client's whim). Tools take NO inputs in
 * U6 (least surface; the client gets the live-harness view).
 *
 * --- exit-code → isError mapping (documented contract) ---
 *   0  clean report                 → isError false
 *   1  report CONTAINS error-severity diagnostics — still a VALID report the
 *      client should read, not a protocol failure → isError false
 *   ≥2 usage error / internal throw → isError true (the envelope still carries
 *      the JSON error body as the text content)
 *
 * --- Dependency exception (owner-sanctioned 2026-06-10) ---
 * The ONLY imports from `@modelcontextprotocol/sdk` are the stdio-transport
 * server entry points + protocol types — never an HTTP/SSE transport module.
 * harness-mgr's own code still opens no sockets (the P5.U1 zero-network gate
 * keeps machine-enforcing that); this server speaks stdio pipes only. See
 * docs/threat-model.md §5.10 for the supply-chain carve-out.
 *
 * buildServer() is IN-PROCESS TESTABLE (SDK Client + InMemoryTransport pair);
 * the stdio bootstrap runs ONLY under the main-guard at the bottom, so
 * importing this module in tests never touches stdio. Tool handlers never
 * throw for tool execution (run() is never-throws; the seam is guarded) — the
 * one deliberate throw is the SDK-standard McpError for an unknown tool name.
 */

import { pathToFileURL } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  McpError,
  ErrorCode,
} from '@modelcontextprotocol/sdk/types.js';
import { run } from '../cli.mjs';
import PKG from '../../package.json' with { type: 'json' };

/** Server identity presented in the MCP initialize handshake. Version tracks
 * package.json (mirrors web/server) so a client never sees a stale hardcoded value. */
const SERVER_INFO = Object.freeze({ name: 'harness-mgr', version: PKG.version });

/** All four U6 tools take no inputs — one shared empty-object schema. */
const NO_INPUT_SCHEMA = Object.freeze({
  type: 'object',
  properties: Object.freeze({}),
  additionalProperties: false,
});

/**
 * The frozen tool table — the single source for tools/list AND dispatch, in
 * DETERMINISTIC declaration order. Each `argv` is the read-only CLI command
 * the tool delegates to (`--format json` is appended at call time).
 * @type {ReadonlyArray<{name: string, description: string, argv: ReadonlyArray<string>}>}
 */
export const TOOLS = Object.freeze([
  Object.freeze({
    name: 'harness_mgr_inventory',
    description: 'Read-only inventory of the Claude Code harness: counts and lists skills, agents, commands, plugins, and MCP servers.',
    argv: Object.freeze(['inventory']),
  }),
  Object.freeze({
    name: 'harness_mgr_health',
    description: 'Read-only severity-layered health report: per-component loadability, offline best-practice advice, and hook explanations.',
    argv: Object.freeze(['health']),
  }),
  Object.freeze({
    name: 'harness_mgr_conflicts',
    description: 'Read-only load-order conflict report: duplicate component names and which copy Claude Code likely loads.',
    argv: Object.freeze(['conflicts']),
  }),
  Object.freeze({
    name: 'harness_mgr_doctor',
    description: 'Read-only doctor report running the passive health checks only (active probes stay behind an explicit human opt-in).',
    argv: Object.freeze(['doctor']),
  }),
]);

/**
 * Build the MCP Server with the four read-only tools registered. Pure setup —
 * no transport is connected here (the caller connects stdio or an in-memory
 * test pair), so tests can drive it fully in-process.
 *
 * @param {Object} [opts]
 * @param {Function} [opts.runFn]     test seam for cli.mjs run() (default: run)
 * @param {string}  [opts.configDir]  when set, appended as `--config-dir <dir>`
 *   to every tool argv — the hermetic-test seam; production omits it so run()
 *   resolves the live governed dir exactly like any CLI invocation.
 * @returns {Server}
 */
export function buildServer({ runFn, configDir } = {}) {
  const exec = typeof runFn === 'function' ? runFn : run;
  const server = new Server(SERVER_INFO, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: NO_INPUT_SCHEMA })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request && request.params ? request.params.name : undefined;
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) {
      // The SDK-standard protocol error path: the framework converts this into
      // a JSON-RPC error response (client callTool rejects with code -32601).
      throw new McpError(ErrorCode.MethodNotFound, `unknown tool: ${String(name)}`);
    }
    return callTool(exec, tool, configDir);
  });

  return server;
}

/**
 * Execute one tool: delegate to run() and wrap the JSON envelope as MCP text
 * content. Never throws — a misbehaving injected seam degrades to an isError
 * result carrying a JSON error body (run() itself is never-throws).
 *
 * @param {Function} exec  the run() seam
 * @param {{argv: ReadonlyArray<string>}} tool
 * @param {string|undefined} configDir
 * @returns {Promise<{content: Array<{type: 'text', text: string}>, isError: boolean}>}
 */
async function callTool(exec, tool, configDir) {
  try {
    const argv = [...tool.argv, '--format', 'json'];
    if (typeof configDir === 'string' && configDir.length > 0) argv.push('--config-dir', configDir);
    const out = await exec(argv);
    const code = out && typeof out.code === 'number' ? out.code : 2;
    const text = out && typeof out.stdout === 'string' ? out.stdout : '';
    // exit 1 (error diagnostics PRESENT) is still a valid report — see header.
    return { content: [{ type: 'text', text }], isError: code >= 2 };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err ?? '');
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: 'mcp-tool-failed', message }) }],
      isError: true,
    };
  }
}

// ── stdio bootstrap ──────────────────────────────────────────────────────────
//
// Fire ONLY when this module is the process entry script (`node src/mcp/server.mjs`),
// NEVER under import — tests import buildServer() without hijacking stdio. The
// transport import is dynamic so even loading this module in-process never pulls
// the stdio transport in. The process stays alive reading stdin until the client
// closes the pipe (Claude Code manages the child lifecycle).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  await buildServer().connect(new StdioServerTransport());
}
