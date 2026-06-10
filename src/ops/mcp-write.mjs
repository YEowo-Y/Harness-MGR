/**
 * MCP write delegator (P4b.U6) — the user-facing engine for
 * `mcp remove <name> [--scope local|user|project]` (remove ONE MCP server).
 *
 * U6 is the SECOND claude-mgr command that DELEGATES a governed mutation to the
 * external `claude` CLI (via safeSpawn), after U5 `update`. It reuses U5's proven
 * machinery wholesale — resolveClaudeExe, snapshot-before-delegate, dry-run-by-
 * default, best-effort audit — and adds nothing new to the trust surface beyond
 * the injection-proof argv (`mcp remove <name> [--scope <enum>]`).
 *
 *   mcpRemove(opts)
 *      ├─ validate <name> + scope + args (the §2 refusal matrix)  →  clean refusal,
 *      │     never snapshots, never spawns, never a crash
 *      ├─ best-effort existence check (ADVISORY only — our discovery can't see
 *      │     `local` scope, so absence is never a refusal)
 *      ├─ enableWrites !== true (DEFAULT):  dry-run preview — writes NOTHING,
 *      │     never spawns; emits the would-run command + the §5 caveats
 *      └─ enableWrites === true:  resolve a spawnable native claude → auto-snapshot
 *            FIRST (the undo) → delegate to `claude mcp remove <name>[ --scope …]`
 *            via safeSpawn → best-effort audit
 *
 * IMPORTANT — like the `snapshot`/`update` commands (and UNLIKE remove/cascade),
 * this module does NOT use applyPlan and does NOT acquire the apply lock. There is
 * no governed file op kind for a delegated spawn; the mutation is performed by
 * `claude` itself. The pre-snapshot is the undo point (project scope only — see
 * §5); the safeSpawn schema (§4) is the preventive bound on the delegated process.
 * (docs/phase-4b-mcp-design.md §3.)
 *
 * REFUSAL MATRIX (docs/phase-4b-mcp-design.md §2) — each is a clean refusal with a
 * clear error Diagnostic + `{ ok:false, refused:true }`; NOTHING is snapshotted or
 * spawned:
 *   - <name> not a non-empty string / fails `/^[A-Za-z0-9._-]+$/`  → mcp-bad-spec
 *     (rejects `;`, `|`, `$()`, backticks, `..`, `/`, `\`, spaces, ADS, flag-shape)
 *   - --scope present but ∉ {local,user,project}                   → mcp-bad-scope
 *   - targetClaudeDir not a non-empty string                       → mcp-bad-args
 *   - --apply but assertWritable gate not injected                 → mcp-bad-args
 *   - --apply but no spawnable native claude exe found             → mcp-claude-not-spawnable
 *
 * NOT a refusal — ADVISORY only: server-not-found. Discovery sees project
 * (`.mcp.json`) + user (`~/.claude.json`) scopes but NOT `local` scope, so we
 * cannot authoritatively say a server is absent; we emit an info
 * `mcp-server-not-visible` and proceed (claude is the authority).
 *
 * SECURITY (docs/phase-4b-mcp-design.md §4):
 *   - DRY-RUN BY DEFAULT. Without enableWrites it previews + touches nothing.
 *   - MCP_REMOVE_SCHEMA is the frozen, security-critical argv schema:
 *     allowedFlags:['--scope'] (the ONLY flag; `-s`/anything else is a denied
 *     flag), a strict positionalPattern admitting only `mcp`/`remove`/the name/the
 *     enum values, and maxArgs:5. The <name> is validated TWICE — by the refusal
 *     matrix's name shape AND by the safeSpawn positionalPattern. Scope is enum-
 *     validated in the builder BEFORE it ever becomes an argv token.
 *   - We NEVER spawn a guessed/untrusted binary: an unresolvable claude exe is a
 *     graceful refusal that prints the exact would-run command.
 *   - assertWritable is INJECTED (required only for --apply); never imported here.
 *
 * M2-SAFETY: imports ONLY node:os(tmpdir), ../lib/diagnostic, ../lib/safe-spawn,
 * ../lib/resolve-claude-exe, ./snapshot.mjs, ./audit-writer.mjs, and
 * ../discovery/mcp.mjs (behind an injectable seam — discovery carries no top-level
 * await, so this is M2-safe; cascade.mjs / update.mjs set the precedent). NEVER
 * src/paths.mjs or src/lib/reexport.mjs.
 *
 * Ops-layer constraint: node:* stdlib + src/lib/** + sibling src/ops/* +
 * src/discovery/* (seam) only. Zero npm deps. NEVER THROWS — the whole body is
 * wrapped; any unexpected error becomes a Diagnostic + `{ ok:false }`. An
 * McpRemoveResult ALWAYS carries the full shape so callers / render never see
 * undefined.
 *
 * Spec: docs/phase-4b-mcp-design.md §2/§3/§4/§5/§6.
 */

import { tmpdir } from 'node:os';
import { DiagnosticBag } from '../lib/diagnostic.mjs';
import { safeSpawn } from '../lib/safe-spawn.mjs';
import { resolveClaudeExe } from '../lib/resolve-claude-exe.mjs';
import { createSnapshot } from './snapshot.mjs';
import { buildAuditEntry, appendAuditEntry } from './audit-writer.mjs';
import { discoverMcp } from '../discovery/mcp.mjs';
import { checkDelegateTargetSnapshotted } from './delegate-manifest-check.mjs';

/** @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic */
/** @typedef {import('./snapshot.mjs').SnapshotResult} SnapshotResult */
/** @typedef {import('../discovery/mcp.mjs').McpServerRecord} McpServerRecord */

/** Stable diagnostic phase tag for this module's own findings. */
const PHASE = 'mcp';

/** Spawn timeout for the delegated `claude mcp remove` (2 min — fast local edit). */
const SPAWN_TIMEOUT_MS = 120000;

/** Safe <name> shape (the ENGINE's layer-(a) validator). Admits the same
 *  alphanumeric/`._-` alphabet as the safeSpawn positionalPattern below, but
 *  ADDITIONALLY forbids a leading `-` so a flag-shaped name (`-rf`, `--scope`)
 *  fails closed at `mcp-bad-spec` here — never building a command at all (design
 *  §4: "a leading `-` (flag-shape)" must be rejected). At the spawn layer a
 *  leading-`-` token bypasses positionalPattern and hits the flag gate instead,
 *  so this engine check is the single source closing that gap. Rejects
 *  separators, traversal, ADS, spaces, and every shell metacharacter. */
const NAME_RE = /^[A-Za-z0-9._][A-Za-z0-9._-]*$/;

/** The valid `--scope` enum values (claude's `mcp remove -s`). */
export const VALID_SCOPES = Object.freeze(['local', 'user', 'project']);

/**
 * THE security-critical argv schema for the delegated `claude mcp remove`.
 *
 *   allowedFlags: ['--scope'] — the ONLY flag permitted; `-s`/`--anything`/a
 *                       `/`-token is rejected by safeSpawn's deny-by-default flag
 *                       gate. allowSlashPositionals is NOT set.
 *   positionalPattern — admits `mcp`, `remove`, the validated <name>, and the enum
 *                       values local|user|project (all alphanumeric); rejects path
 *                       separators, `..`, spaces, quotes, and shell metacharacters.
 *   maxArgs: 5        — exactly ['mcp','remove', <name>] or
 *                       ['mcp','remove', <name>, '--scope', <scope>].
 */
export const MCP_REMOVE_SCHEMA = Object.freeze({
  allowedFlags: ['--scope'],
  positionalPattern: /^[A-Za-z0-9._-]+$/,
  maxArgs: 5,
});

/**
 * @typedef {Object} McpRemoveResult
 * @property {boolean} ok          true on a clean dry-run preview or a successful delegated remove.
 * @property {boolean} refused     true when validation refused (nothing snapshotted/spawned).
 * @property {boolean} dryRun      true for the preview path; false for the apply path.
 * @property {string|null} name    the validated server name (null on a refusal before validation).
 * @property {string|null} scope   the validated scope, or null when none was given.
 * @property {McpServerRecord|null} server  the discovered record if visible, else null.
 * @property {string|null} claudeExe  the resolved spawnable claude exe (--apply path only).
 * @property {string[]|null} command  ['mcp','remove', name, ...scopeArgs] (null on early refusal).
 * @property {string|null} snapshotId  the auto-snapshot id (--apply path only).
 * @property {boolean} spawned     true when a delegated spawn was attempted.
 * @property {SnapshotResult|null} apply  the auto-snapshot result (--apply path only).
 * @property {Diagnostic[]} diagnostics  this module's findings + any from sub-calls.
 */

/**
 * Build an McpRemoveResult, defaulting every field so callers always get the full
 * shape (no undefined). `diagnostics` is written LAST from the bag.
 * @param {Partial<McpRemoveResult>} fields
 * @param {DiagnosticBag} bag
 * @returns {McpRemoveResult}
 */
function buildResult(fields, bag) {
  const defaults = {
    ok: false, refused: false, dryRun: false,
    name: null, scope: null, server: null, claudeExe: null,
    command: null, snapshotId: null, spawned: false, apply: null,
  };
  return { ...defaults, ...fields, diagnostics: bag.all() };
}

/**
 * Add an error diagnostic and return a refused McpRemoveResult carrying any known
 * fields (name/scope/command when already resolved). Shared refusal helper.
 * @param {DiagnosticBag} bag
 * @param {string} code @param {string} message @param {Partial<McpRemoveResult>} [fields]
 * @returns {McpRemoveResult}
 */
function refuse(bag, code, message, fields = {}) {
  bag.add({ severity: 'error', code, message, phase: PHASE });
  return buildResult({ refused: true, ...fields }, bag);
}

/**
 * Validate name + scope (§2). Returns `{ scope }` (normalized: '' / undefined →
 * undefined) on success, or `{ refusal:{code,message} }`. Pure; never throws.
 * @param {unknown} name @param {unknown} scope
 * @returns {{scope:(string|undefined)}|{refusal:{code:string,message:string}}}
 */
function validateNameScope(name, scope) {
  if (typeof name !== 'string' || name.length === 0 || !NAME_RE.test(name)) {
    return { refusal: { code: 'mcp-bad-spec',
      message: `invalid MCP server name ${JSON.stringify(name)}; must match ${NAME_RE} ` +
        '(no path, traversal, spaces, or shell metacharacters)' } };
  }
  // undefined/null/'' = no scope (allowed); any other non-string is malformed.
  if (scope === undefined || scope === null || scope === '') {
    return { scope: undefined };
  }
  if (typeof scope !== 'string' || !VALID_SCOPES.includes(scope)) {
    return { refusal: { code: 'mcp-bad-scope',
      message: `invalid --scope ${JSON.stringify(scope)}; must be one of ${VALID_SCOPES.join(', ')}` } };
  }
  return { scope };
}

/**
 * Best-effort existence check (ADVISORY — never a refusal). Finds the server in
 * the VISIBLE scopes; when scope is given, requires an exact scope match. Emits an
 * info `mcp-server-not-visible` when absent (local scope is invisible to us).
 * Single object param to stay within the 5-param lint ceiling.
 * @param {object} a
 * @param {DiagnosticBag} a.bag @param {Function} a.discoverMcpFn
 * @param {string} a.targetClaudeDir @param {string|undefined} a.appFile
 * @param {string} a.name @param {string|undefined} a.scope
 * @returns {McpServerRecord|null}
 */
function findVisibleServer(a) {
  const { bag, discoverMcpFn, targetClaudeDir, appFile, name, scope } = a;
  const disc = discoverMcpFn({ rootDir: targetClaudeDir, appFile });
  for (const d of disc?.diagnostics ?? []) bag.add(d);
  const list = Array.isArray(disc?.mcpServers) ? disc.mcpServers : [];
  const server = list.find((s) =>
    s && s.name === name && (scope ? s.scope === scope : true)) ?? null;
  if (!server) {
    bag.add({ severity: 'info', code: 'mcp-server-not-visible', phase: PHASE,
      message: `server '${name}' not found in the project/user scopes claude-mgr can see; ` +
        'it may be local-scope — claude is the authority; proceeding' });
  }
  return server;
}

/**
 * Emit the dry-run preview diagnostics (the would-run command + the §5 caveats).
 * Writes NOTHING. Shared so the caveat text lives in one place.
 * @param {DiagnosticBag} bag
 * @param {string} human @param {McpServerRecord|null} server @param {string|undefined} scope
 */
function emitDryRunDiagnostics(bag, human, server, scope) {
  const where = server ? ` (transport ${server.transport}, scope ${server.scope})` : '';
  bag.add({ severity: 'info', code: 'mcp-dry-run', phase: PHASE,
    message: `would run \`${human}\`${where}; ` +
      're-run with --apply to execute' });
  bag.add({ severity: 'info', code: 'mcp-restart-required', phase: PHASE,
    message: 'the change may require a Claude Code restart to take full effect' });
  // --scope user/local (or unspecified) writes ~/.claude.json, OUTSIDE the
  // governed tree → NOT captured by the auto-snapshot (only project is reversible).
  if (scope === 'user' || scope === 'local' || scope === undefined) {
    bag.add({ severity: 'info', code: 'mcp-user-scope-not-snapshotted', phase: PHASE,
      message: '--scope user/local writes ~/.claude.json, OUTSIDE claude-mgr\'s governed tree and ' +
        'NOT captured by the auto-snapshot; only --scope project is reversible via rollback' });
  }
}

/**
 * Remove ONE MCP server (`mcp remove <name> [--scope …]`). Validates the name +
 * scope, runs a best-effort (advisory) existence check, then either previews the
 * delegated command (dry-run, the DEFAULT — writes nothing, never spawns) or, for
 * the --apply path, resolves a spawnable native claude, auto-snapshots FIRST, and
 * delegates to `claude mcp remove <name>[ --scope <scope>]` via safeSpawn (best-
 * effort audit after). NEVER throws; every failure is a Diagnostic + a full-shape
 * `{ ok:false }` McpRemoveResult.
 *
 * @param {object} opts
 * @param {string}  opts.name                       the MCP server name
 * @param {string}  [opts.scope]                    local|user|project (omitted = any scope)
 * @param {string}  opts.targetClaudeDir            absolute governed dir
 * @param {string}  opts.mgrStateDir                absolute .mgr-state dir
 * @param {string}  [opts.appFile]                  ~/.claude.json (best-effort existence check)
 * @param {(path:string, ctx:string)=>string} [opts.assertWritable]  governed-write
 *           gate; REQUIRED only for the --apply path (forwarded to createSnapshot/audit).
 * @param {boolean} [opts.enableWrites]             true = delegate; false/absent = dry-run.
 * @param {string}  [opts.reason]                   snapshot reason (defaults to "mcp remove <name>").
 * @param {Record<string,string|undefined>} [opts.env]   passed to resolveClaudeExe (default process.env).
 * @param {string}  [opts.platform]                 passed to resolveClaudeExe (default process.platform).
 * @param {string}  [opts.cwd]                       passed to resolveClaudeExe.
 * @param {() => Date} [opts.now]                    clock injection forwarded to snapshot/audit.
 * @param {{discoverMcpFn?:Function, resolveClaudeFn?:Function, createSnapshotFn?:Function, spawnFn?:Function, auditFn?:Function}} [opts.seams]
 * @returns {Promise<McpRemoveResult>}
 */
export async function mcpRemove(opts) {
  const bag = new DiagnosticBag();
  try {
    const o = opts && typeof opts === 'object' ? opts : {};
    const { name, targetClaudeDir, mgrStateDir, appFile, assertWritable, reason } = o;
    const env = o.env ?? process.env;
    const platform = o.platform ?? process.platform;
    const cwd = o.cwd;
    const now = o.now;
    const enableWrites = o.enableWrites === true;
    const seams = o.seams && typeof o.seams === 'object' ? o.seams : {};
    const discoverMcpFn = typeof seams.discoverMcpFn === 'function' ? seams.discoverMcpFn : discoverMcp;
    const resolveClaudeFn = typeof seams.resolveClaudeFn === 'function' ? seams.resolveClaudeFn : resolveClaudeExe;
    const createSnapshotFn = typeof seams.createSnapshotFn === 'function' ? seams.createSnapshotFn : createSnapshot;
    const spawnFn = typeof seams.spawnFn === 'function' ? seams.spawnFn : safeSpawn;
    const auditFn = typeof seams.auditFn === 'function' ? seams.auditFn : appendAuditEntry;
    const manifestReadFileFn = typeof seams.manifestReadFileFn === 'function' ? seams.manifestReadFileFn : undefined;
    const existsFn = typeof seams.existsFn === 'function' ? seams.existsFn : undefined;

    // 1. Validate name + 2. scope (§2).
    const v = validateNameScope(name, o.scope);
    if ('refusal' in v) return refuse(bag, v.refusal.code, v.refusal.message);
    const scope = v.scope; // normalized: a valid enum or undefined
    if (typeof targetClaudeDir !== 'string' || targetClaudeDir.length === 0) {
      return refuse(bag, 'mcp-bad-args', 'targetClaudeDir must be a non-empty string', { name });
    }

    // 3. Best-effort existence (ADVISORY — never a refusal).
    const server = findVisibleServer({ bag, discoverMcpFn, targetClaudeDir, appFile, name, scope });

    // 4. Build the delegated command.
    const command = ['mcp', 'remove', name];
    if (scope) command.push('--scope', scope);
    const human = `claude mcp remove ${name}${scope ? ` --scope ${scope}` : ''}`;

    // 5. DRY-RUN (default): preview only — write NOTHING, spawn NOTHING.
    if (!enableWrites) {
      emitDryRunDiagnostics(bag, human, server, scope);
      return buildResult({ ok: true, dryRun: true, name, scope: scope ?? null, server, command }, bag);
    }

    // 6. APPLY: gate + spawnable exe + snapshot-first + delegate + best-effort audit.
    return await applyRemove({
      bag, name, scope, server, command, human, targetClaudeDir, mgrStateDir, assertWritable,
      reason, env, platform, cwd, now,
      resolveClaudeFn, createSnapshotFn, spawnFn, auditFn, manifestReadFileFn, existsFn,
    });
  } catch (e) {
    // 7. Absolute backstop: an unexpected error becomes a diagnostic, never a throw.
    bag.add({ severity: 'error', code: 'mcp-unexpected-error', phase: PHASE,
      message: `unexpected error during mcp remove: ${e instanceof Error ? e.message : String(e)}` });
    return buildResult({}, bag);
  }
}

/**
 * The --apply path (docs/phase-4b-mcp-design.md §3): require the gate, resolve a
 * spawnable native claude, auto-snapshot FIRST, then delegate to
 * `claude mcp remove <name>[ --scope …]` via safeSpawn, then best-effort audit.
 * Extracted to keep mcpRemove under the 80-SLOC lint ceiling. Never throws (the
 * caller wraps it; this body only awaits guarded sub-calls).
 * @param {object} a  bundled state from mcpRemove
 * @returns {Promise<McpRemoveResult>}
 */
async function applyRemove(a) {
  const { bag, name, scope, server, command, human, targetClaudeDir, mgrStateDir,
    assertWritable, reason, env, platform, cwd, now,
    resolveClaudeFn, createSnapshotFn, spawnFn, auditFn,
    manifestReadFileFn, existsFn } = a;
  const known = { name, scope: scope ?? null, server, command };

  // a. The governed-write gate must be injected to --apply.
  if (typeof assertWritable !== 'function') {
    return refuse(bag, 'mcp-bad-args',
      'assertWritable (the governed-write gate) must be injected to --apply an mcp remove', known);
  }

  // b. Resolve a spawnable native claude exe. None → refuse-with-guidance; we
  //    NEVER spawn a guessed binary, and we do NOT snapshot/spawn.
  const cr = resolveClaudeFn({ env, platform, cwd });
  for (const d of cr?.diagnostics ?? []) bag.add(d);
  if (!cr || !cr.exe) {
    return refuse(bag, 'mcp-claude-not-spawnable',
      `no spawnable native claude found; run \`${human}\` yourself`, known);
  }
  const claudeExe = cr.exe;

  // c. Auto-snapshot the governed surface FIRST (the undo point). skipSecretFilter
  //    is true so every governed file — including content-sniffer-matched ones like
  //    a .mcp.json that contains a token-shaped value — is captured in the manifest.
  //    A snapshot failure aborts — we refuse to delegate without an undo point, and
  //    do NOT spawn.
  const snap = await createSnapshotFn({
    targetClaudeDir, mgrStateDir, reason: reason ?? ('mcp remove ' + name),
    assertWritable, now, skipSecretFilter: true,
  });
  for (const d of snap?.diagnostics ?? []) bag.add(d);
  if (!snap || snap.ok !== true) {
    bag.add({ severity: 'error', code: 'mcp-snapshot-failed', phase: PHASE,
      message: 'auto-snapshot failed; refusing to delegate without an undo point' });
    return buildResult({ ...known, claudeExe, apply: snap ?? null }, bag);
  }
  const snapshotId = snap.snapshotId ?? null;

  // c2. Cross-check (project scope only): .mcp.json MUST appear in the manifest.
  //     user/local scope writes ~/.claude.json which is OUTSIDE our snapshot scope —
  //     refusing there would break the documented advisory behavior for those scopes.
  //     Only checked when the file exists on disk (mirrors the 'create' skip in
  //     apply-manifest-check: a not-yet-existing file cannot be in the snapshot).
  if (scope === 'project') {
    const crossCheck = checkDelegateTargetSnapshotted({
      snap, targetClaudeDir,
      targetRelPath: '.mcp.json',
      errorCode: 'mcp-target-not-snapshotted', phase: PHASE, bag,
      manifestReadFileFn, existsFn,
    });
    if (!crossCheck.ok) {
      return buildResult({ ok: false, ...known, claudeExe, snapshotId, apply: snap }, bag);
    }
  }

  // d. Delegate to `claude mcp remove …` via safeSpawn (the §4 schema).
  const tmp = tmpdir();
  const spec = { exe: claudeExe, args: command, cwd: tmp, allowedCwds: [tmp],
    schema: MCP_REMOVE_SCHEMA, timeoutMs: SPAWN_TIMEOUT_MS };
  let ok;
  let spawned = false;
  try {
    spawned = true;
    await spawnFn(spec);
    ok = true;
  } catch (e) {
    ok = false;
    bag.add({ severity: 'error', code: 'mcp-spawn-failed', phase: PHASE,
      message: `delegated \`${human}\` failed: ${e instanceof Error ? e.message : String(e)}; the snapshot remains as the undo point` });
  }

  // e. Audit (best-effort) — never blocks the result.
  recordAudit({ bag, auditFn, mgrStateDir, assertWritable, snapshotId, ok, now });

  // f. Return the spawn outcome.
  return buildResult({ ok, dryRun: false, ...known, claudeExe, snapshotId, spawned, apply: snap }, bag);
}

/**
 * Best-effort audit of the mcp remove (metadata only). A throw OR a {written:false}
 * return degrades to a warn — it NEVER flips the result. Extracted to keep
 * applyRemove within the lint ceiling and the audit error handling in one place.
 * @param {object} a
 */
function recordAudit(a) {
  const { bag, auditFn, mgrStateDir, assertWritable, snapshotId, ok, now } = a;
  try {
    const res = auditFn({
      stateDir: mgrStateDir,
      entry: buildAuditEntry({ command: 'mcp-remove', snapshotId, exitCode: ok ? 0 : 1, opCount: 1, now }),
      assertWritable,
    });
    if (res && res.written === false) {
      bag.add({ severity: 'warn', code: 'mcp-audit-unavailable', phase: PHASE,
        message: 'audit entry was not written (best-effort; the mcp remove result is unaffected)' });
    }
  } catch (e) {
    bag.add({ severity: 'warn', code: 'mcp-audit-unavailable', phase: PHASE,
      message: `audit append failed: ${e instanceof Error ? e.message : String(e)} (best-effort; the mcp remove result is unaffected)` });
  }
}
