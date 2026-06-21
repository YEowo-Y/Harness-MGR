/**
 * MCP add-json delegator (claude mcp toggle — the ENABLE half).
 *
 * Delegates `claude mcp add-json <name> <json> --scope <scope>` to the official `claude`
 * CLI via safeSpawn — the RE-ADD half of the non-destructive mcp toggle (disable = stash +
 * `claude mcp remove`; enable = THIS, from the stash). claude-mgr NEVER writes the
 * OAuth-secret-bearing ~/.claude.json itself — the official CLI performs the mutation; this
 * module only resolves a spawnable native claude and runs the validated argv (execFile, NO
 * shell). The <json> is claude-mgr's OWN stash data (round-tripped from the user's config),
 * passed as a LITERAL argv element. Dry-run-by-default. NEVER throws.
 *
 * SECURITY — the add-json argv schema (the one looser-than-`mcp remove` surface, by design):
 *   safeSpawn uses execFile (no shell) → the JSON arg is a literal argv element, so there is
 *   NO shell-injection risk regardless of its `{ } " : ,` content. The strict positionalPattern
 *   is an extra ALLOWLIST belt; the JSON requires a looser one (printable ASCII, NO control /
 *   NUL / newline). That looseness is bounded + justified by: (a) execFile/no-shell; (b) the
 *   engine validates <name> with the STRICT shared NAME_RE BEFORE argv build (validate twice);
 *   (c) the engine validates <json> PARSES to a plain object + is printable-ASCII (no control
 *   bytes) BEFORE argv build; (d) it is claude-mgr's own round-tripped stash, not a value typed
 *   at the call site; (e) maxArgs bounds the token count. Documented for DoD review.
 *
 * M2-SAFETY: imports ONLY node:os(tmpdir) + ../lib/diagnostic + ../lib/safe-spawn +
 * ../lib/resolve-claude-exe + the sibling mcp-write.mjs (for the shared NAME_RE/VALID_SCOPES —
 * both pure leafs, no top-level await). NEVER src/paths.mjs. Zero npm deps.
 */

import { tmpdir } from 'node:os';
import { DiagnosticBag } from '../lib/diagnostic.mjs';
import { safeSpawn } from '../lib/safe-spawn.mjs';
import { resolveClaudeExe } from '../lib/resolve-claude-exe.mjs';
import { NAME_RE, VALID_SCOPES } from './mcp-write.mjs';

/** @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic */

const PHASE = 'mcp';

/** Spawn timeout for the delegated `claude mcp add-json` (2 min — fast local edit). */
const SPAWN_TIMEOUT_MS = 120000;

/** Printable ASCII, no control / NUL / newline. Matches the schema's positionalPattern so the
 *  engine-layer json check and the spawn-layer belt agree. */
const PRINTABLE_ASCII_RE = /^[\x20-\x7e]+$/;

/**
 * THE add-json argv schema — looser positionalPattern than MCP_REMOVE_SCHEMA BECAUSE the JSON
 * positional needs `{ } " : ,`. See the file header for the full security justification.
 * argv = ['mcp','add-json', <name>, <json>, '--scope', <scope>] = 6 tokens.
 */
export const MCP_ADD_JSON_SCHEMA = Object.freeze({
  allowedFlags: ['--scope'],
  positionalPattern: PRINTABLE_ASCII_RE,
  maxArgs: 6,
});

/** Build a full-shape result (no undefined). */
function build(fields, bag) {
  const defaults = { ok: false, refused: false, dryRun: false, name: null, scope: null, claudeExe: null, command: null, spawned: false };
  return { ...defaults, ...fields, diagnostics: bag.all() };
}

/**
 * Delegate `claude mcp add-json <name> <json> --scope <scope>`. Validates name (strict shared
 * NAME_RE) + scope (enum) + json (parses to a plain object, printable ASCII) BEFORE building
 * argv, then dry-run-previews (default — spawns nothing) or resolves a spawnable native claude
 * and delegates via safeSpawn (MCP_ADD_JSON_SCHEMA). NEVER throws.
 * @param {object} opts
 * @param {string} opts.name                 the MCP server name (strict NAME_RE)
 * @param {string} opts.json                 the server config JSON string (object; env-free per the caller)
 * @param {string} [opts.scope='user']       local|user|project
 * @param {string} opts.targetClaudeDir      absolute governed dir
 * @param {boolean} [opts.enableWrites]      true = delegate; false/absent = dry-run
 * @param {Record<string,string|undefined>} [opts.env] @param {string} [opts.platform] @param {string} [opts.cwd]
 * @param {{resolveClaudeFn?:Function, spawnFn?:Function}} [opts.seams]
 * @returns {Promise<object>}
 */
export async function mcpAddJson(opts) {
  const bag = new DiagnosticBag();
  const refuse = (code, message, fields = {}) => { bag.add({ severity: 'error', code, message, phase: PHASE }); return build({ refused: true, ...fields }, bag); };
  try {
    const o = opts && typeof opts === 'object' ? opts : {};
    const { name, json, targetClaudeDir } = o;
    const scope = typeof o.scope === 'string' && o.scope.length ? o.scope : 'user';
    const enableWrites = o.enableWrites === true;
    const env = o.env ?? process.env;
    const platform = o.platform ?? process.platform;
    const cwd = o.cwd;
    const seams = o.seams && typeof o.seams === 'object' ? o.seams : {};
    const resolveClaudeFn = typeof seams.resolveClaudeFn === 'function' ? seams.resolveClaudeFn : resolveClaudeExe;
    const spawnFn = typeof seams.spawnFn === 'function' ? seams.spawnFn : safeSpawn;

    // Validate BEFORE building argv (the strict engine gate; the schema is the bounded belt).
    if (typeof name !== 'string' || !NAME_RE.test(name)) return refuse('mcp-add-bad-spec', `invalid MCP server name ${JSON.stringify(name)}; must match ${NAME_RE}`);
    if (!VALID_SCOPES.includes(scope)) return refuse('mcp-add-bad-scope', `invalid --scope ${JSON.stringify(scope)}; must be one of ${VALID_SCOPES.join(', ')}`, { name });
    if (typeof json !== 'string' || !PRINTABLE_ASCII_RE.test(json)) return refuse('mcp-add-bad-json', 'json must be a printable-ASCII string (no control characters / newlines)', { name, scope });
    let parsed;
    try { parsed = JSON.parse(json); } catch { return refuse('mcp-add-bad-json', 'json does not parse as JSON', { name, scope }); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return refuse('mcp-add-bad-json', 'json must be a JSON object', { name, scope });
    if (typeof targetClaudeDir !== 'string' || targetClaudeDir.length === 0) return refuse('mcp-add-bad-args', 'targetClaudeDir must be a non-empty string', { name, scope });

    const command = ['mcp', 'add-json', name, json, '--scope', scope];
    const human = `claude mcp add-json ${name} <json> --scope ${scope}`;

    // DRY-RUN (default): preview only — spawn NOTHING.
    if (!enableWrites) {
      bag.add({ severity: 'info', code: 'mcp-add-dry-run', phase: PHASE, message: `would run \`${human}\`; re-run with --apply to execute` });
      return build({ ok: true, dryRun: true, name, scope, command }, bag);
    }

    // APPLY: resolve a spawnable native claude (NEVER a guessed binary), then delegate.
    const cr = resolveClaudeFn({ env, platform, cwd });
    for (const d of cr?.diagnostics ?? []) bag.add(d);
    if (!cr || !cr.exe) return refuse('mcp-add-claude-not-spawnable', `no spawnable native claude found; run \`${human}\` yourself`, { name, scope, command });

    const tmp = tmpdir();
    const spec = { exe: cr.exe, args: command, cwd: tmp, allowedCwds: [tmp], schema: MCP_ADD_JSON_SCHEMA, timeoutMs: SPAWN_TIMEOUT_MS };
    let ok = false; let spawned = false;
    try { spawned = true; await spawnFn(spec); ok = true; } catch (e) {
      bag.add({ severity: 'error', code: 'mcp-add-spawn-failed', phase: PHASE, message: `delegated \`${human}\` failed: ${e instanceof Error ? e.message : String(e)}` });
    }
    return build({ ok, dryRun: false, name, scope, claudeExe: cr.exe, command, spawned }, bag);
  } catch (e) {
    bag.add({ severity: 'error', code: 'mcp-add-unexpected-error', phase: PHASE, message: `unexpected error during mcp add-json: ${e instanceof Error ? e.message : String(e)}` });
    return build({}, bag);
  }
}
