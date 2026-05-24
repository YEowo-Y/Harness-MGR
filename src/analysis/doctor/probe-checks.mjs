/**
 * Doctor probe-fact checks — #1 mcp-auth-stale, #2 mcp-server-resolvable.
 *
 * These two checks are the PURE judgment layer for facts gathered by the
 * discovery probe (src/discovery/probe-mcp.mjs). The probe does the I/O;
 * these checks receive the resulting fact arrays and decide severity.
 *
 * NOTE: check #1 requires `input.now` (a reference timestamp in ms, provided
 * by the CLI via Date.now()). If `now` is absent or non-finite the check emits
 * NOTHING — this keeps the doctor layer free of any Date.now() call and
 * therefore truly pure (no side effects, deterministic, time-injectable).
 *
 * Zero npm dependencies. Node stdlib only. Never throws.
 */

/**
 * @typedef {import('./index.mjs').DoctorInput} DoctorInput
 * @typedef {import('../../discovery/probe-mcp.mjs').McpAuthFact} McpAuthFact
 * @typedef {import('../../discovery/probe-mcp.mjs').McpResolutionFact} McpResolutionFact
 * @typedef {import('../../lib/diagnostic.mjs').Diagnostic} Diagnostic
 */

const DAY_MS = 86400000;
const STALE_WARN_MS = 30 * DAY_MS;
const STALE_ERROR_MS = 90 * DAY_MS;

/**
 * #1 mcp-auth-stale — judge each McpAuthFact against the reference time.
 *
 * The reference time `input.now` MUST be provided by the caller (the CLI passes
 * Date.now()). When `now` is absent or non-finite this function returns [] so
 * that the doctor never calls Date.now() itself — age-based checks simply emit
 * nothing rather than produce findings against an unreliable clock.
 *
 * Thresholds (strictly greater, not >=):
 *   age > 90 days  →  error
 *   age > 30 days  →  warn
 *   otherwise      →  nothing (includes future timestamps, i.e. negative age)
 *
 * Output is sorted by server name for deterministic ordering.
 *
 * @param {DoctorInput} input
 * @returns {Diagnostic[]}
 */
function checkMcpAuthStale(input) {
  const now =
    typeof input.now === 'number' && Number.isFinite(input.now)
      ? input.now
      : null;

  // Without a reference time the doctor stays pure — emit nothing.
  if (now === null) return [];

  const facts = Array.isArray(input.mcpAuth) ? input.mcpAuth : [];

  /** @type {Diagnostic[]} */
  const out = [];

  for (const fact of facts) {
    if (!fact || typeof fact !== 'object') continue;
    if (typeof fact.timestamp !== 'number' || !Number.isFinite(fact.timestamp)) continue;

    const age = now - fact.timestamp;
    if (age <= STALE_WARN_MS) continue; // future timestamps (age < 0) also skip here

    const days = Math.floor(age / DAY_MS);
    const name = typeof fact.name === 'string' && fact.name.length > 0 ? fact.name : '(unknown)';
    const severity = age > STALE_ERROR_MS ? 'error' : 'warn';

    out.push({
      severity,
      code: 'mcp-auth-stale',
      message: `MCP server "${name}" has needed authentication for ${days} days`,
      phase: 'doctor',
      fix: `re-run authentication for "${name}", or remove the MCP server if it is unused`,
    });
  }

  // Sort by server name for determinism.
  out.sort((a, b) => (a.message < b.message ? -1 : a.message > b.message ? 1 : 0));

  return out;
}

/**
 * #2 mcp-server-resolvable — judge each McpResolutionFact.
 *
 * A fact with `resolved === false` (strict) means the command was not found on
 * PATH at probe time. WARN: the runtime PATH may differ from the probe-time PATH,
 * so this is advisory rather than a hard error. Facts with resolved===true or
 * resolved===undefined/missing are silently skipped.
 *
 * Output is sorted by server name for deterministic ordering.
 *
 * @param {DoctorInput} input
 * @returns {Diagnostic[]}
 */
function checkMcpServerResolvable(input) {
  const facts = Array.isArray(input.mcpResolution) ? input.mcpResolution : [];

  /** @type {Diagnostic[]} */
  const out = [];

  for (const fact of facts) {
    if (!fact || typeof fact !== 'object') continue;
    if (fact.resolved !== false) continue; // strict: skip true / undefined / missing

    const name = typeof fact.name === 'string' && fact.name.length > 0 ? fact.name : '(unknown)';
    const command = typeof fact.command === 'string' && fact.command.length > 0 ? fact.command : '(unknown)';

    out.push({
      severity: 'warn',
      code: 'mcp-server-resolvable',
      message: `MCP server "${name}" command "${command}" was not found on PATH`,
      phase: 'doctor',
      fix: 'install the command or correct it in .mcp.json (PATH at check time may differ from the launch environment)',
    });
  }

  // Sort by server name for determinism.
  out.sort((a, b) => (a.message < b.message ? -1 : a.message > b.message ? 1 : 0));

  return out;
}

/**
 * The two passive probe-fact checks, frozen in registry order.
 * Imported by index.mjs and prepended to CHECKS so the full registry is [1,2,6..11].
 * @type {ReadonlyArray<import('./index.mjs').DoctorCheck>}
 */
export const PROBE_CHECKS = Object.freeze([
  Object.freeze({ id: 1, code: 'mcp-auth-stale', probeLevel: 'passive', run: checkMcpAuthStale }),
  Object.freeze({ id: 2, code: 'mcp-server-resolvable', probeLevel: 'passive', run: checkMcpServerResolvable }),
]);
