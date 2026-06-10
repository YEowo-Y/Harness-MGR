/**
 * Update command-level delegator (P4b.U5) — the user-facing entry for
 * `update <plugin> [--lock-version <ver>]` (update ONE installed plugin to latest).
 *
 * `update` is a NEW capability class: the FIRST claude-mgr command that
 * DELEGATES a governed mutation to the external `claude` CLI (via safeSpawn),
 * rather than mutating governed FILES itself through assertWritable + the apply
 * lifecycle. "Updating a plugin" means refetching code from a marketplace
 * (network + git); claude-mgr is a verified zero-network, read-mostly governance
 * tool, so it cannot do that itself — it delegates to `claude plugin update <key>`.
 *
 *   updatePlugin(opts)
 *      ├─ validate <plugin> + args (the §3 refusal matrix)  →  clean refusal,
 *      │     never snapshots, never spawns, never a crash
 *      ├─ enableWrites !== true (DEFAULT):  dry-run preview — writes NOTHING,
 *      │     never spawns; emits the would-run command + the §6 caveats
 *      └─ enableWrites === true:  resolve a spawnable native claude → auto-snapshot
 *            FIRST (the undo) → delegate to `claude plugin update <key>` via
 *            safeSpawn → best-effort audit
 *
 * IMPORTANT — like the `snapshot` command (and UNLIKE remove/cascade), this module
 * does NOT use applyPlan and does NOT acquire the apply lock. There is no governed
 * file op kind for a delegated spawn; the mutation is performed by `claude` itself.
 * The pre-snapshot is the undo point; the safeSpawn schema (§5) is the preventive
 * bound on the delegated process. (docs/phase-4b-update-design.md §4.)
 *
 * REFUSAL MATRIX (docs/phase-4b-update-design.md §3) — each is a clean refusal with
 * a clear error Diagnostic + `{ ok:false, refused:true }`; NOTHING is snapshotted
 * or spawned:
 *   - <plugin> not a non-empty string / fails the name shape  → update-bad-spec
 *     (rejects `;`, `|`, `$()`, backticks, `..`, `/`, `\`, spaces, ADS)
 *   - targetClaudeDir not a non-empty string                  → update-bad-args
 *   - <plugin> not in installed_plugins.json                  → update-plugin-not-found
 *   - bare name resolves to >=2 installed marketplaces        → update-plugin-ambiguous
 *   - --apply but assertWritable gate not injected            → update-bad-args
 *   - --apply but no spawnable native claude exe found        → update-claude-not-spawnable
 *
 * SECURITY (docs/phase-4b-update-design.md §5):
 *   - DRY-RUN BY DEFAULT. Without enableWrites it previews + touches nothing.
 *   - CLAUDE_PLUGIN_UPDATE_SCHEMA is the frozen, security-critical argv schema:
 *     allowedFlags:[] (NO flags reach the CLI, so --lock-version/--anything can
 *     never be passed; a `-`/`/`-token is a denied flag), a strict
 *     positionalPattern, and maxArgs:3. The <plugin> key is validated TWICE — by
 *     the refusal matrix's name shape AND by the safeSpawn positionalPattern.
 *   - We NEVER spawn a guessed/untrusted binary: an unresolvable claude exe is a
 *     graceful refusal that prints the exact `claude plugin update <key>` command.
 *   - assertWritable is INJECTED (required only for --apply); never imported here.
 *
 * M2-SAFETY: imports ONLY node:os(tmpdir), ../lib/diagnostic, ../lib/safe-spawn,
 * ../lib/resolve-claude-exe, ./snapshot.mjs, ./audit-writer.mjs, and
 * ../discovery/plugins.mjs (behind an injectable seam — discovery carries no
 * top-level await, so this is M2-safe; cascade.mjs sets the precedent). NEVER
 * src/paths.mjs or src/lib/reexport.mjs.
 *
 * Ops-layer constraint: node:* stdlib + src/lib/** + sibling src/ops/* +
 * src/discovery/* (seam) only. Zero npm deps. NEVER THROWS — the whole body is
 * wrapped; any unexpected error becomes a Diagnostic + `{ ok:false }`. An
 * UpdateResult ALWAYS carries the full shape so callers / render never see undefined.
 *
 * Spec: docs/phase-4b-update-design.md §3/§4/§5/§6/§7/§8.
 */

import { tmpdir } from 'node:os';
import { DiagnosticBag } from '../lib/diagnostic.mjs';
import { safeSpawn } from '../lib/safe-spawn.mjs';
import { resolveClaudeExe } from '../lib/resolve-claude-exe.mjs';
import { createSnapshot } from './snapshot.mjs';
import { buildAuditEntry, appendAuditEntry } from './audit-writer.mjs';
import { discoverPlugins } from '../discovery/plugins.mjs';

/** @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic */
/** @typedef {import('./snapshot.mjs').SnapshotResult} SnapshotResult */

/** Stable diagnostic phase tag for this module's own findings. */
const PHASE = 'update';

/** Spawn timeout for the delegated `claude plugin update` (5 min — git fetch). */
const SPAWN_TIMEOUT_MS = 300000;

/**
 * THE security-critical argv schema for the delegated `claude plugin update`.
 *
 *   allowedFlags: []  — NO flags accepted, so `--lock-version`/`--anything` can
 *                       never reach the CLI; a `-`/`/`-prefixed token is rejected
 *                       by safeSpawn's deny-by-default flag gate. allowSlashPositionals
 *                       is NOT set, so a `/`-token is treated as a (denied) flag.
 *   positionalPattern — `plugin`, `update`, and the validated key must each match;
 *                       no path separators, `..`, spaces, quotes, or shell metachars.
 *   maxArgs: 3        — exactly ['plugin','update', <key>].
 */
export const CLAUDE_PLUGIN_UPDATE_SCHEMA = Object.freeze({
  allowedFlags: [],
  positionalPattern: /^[A-Za-z0-9._@-]+$/,
  maxArgs: 3,
});

/** Safe <plugin> spec shape: `name` or `name@marketplace`. Rejects separators,
 *  traversal, ADS, spaces, and shell metacharacters. */
const SPEC_RE = /^[A-Za-z0-9._-]+(@[A-Za-z0-9._-]+)?$/;

/**
 * @typedef {Object} UpdateResult
 * @property {boolean} ok          true on a clean dry-run preview or a successful delegated update.
 * @property {boolean} refused     true when validation refused (nothing snapshotted/spawned).
 * @property {boolean} dryRun      true for the preview path; false for the apply path.
 * @property {object|null} plugin  the resolved PluginRecord (null on a refusal before resolution).
 * @property {string|null} claudeExe  the resolved spawnable claude exe (--apply path only).
 * @property {string[]|null} command  ['plugin','update', key] (null on early refusal).
 * @property {string|null} snapshotId  the auto-snapshot id (--apply path only).
 * @property {boolean} spawned     true when a delegated spawn was attempted.
 * @property {SnapshotResult|null} apply  the auto-snapshot result (--apply path only).
 * @property {Diagnostic[]} diagnostics  this module's findings + any from sub-calls.
 */

/**
 * Build an UpdateResult, defaulting every field so callers always get the full
 * shape (no undefined). `diagnostics` is written LAST from the bag.
 * @param {Partial<UpdateResult>} fields
 * @param {DiagnosticBag} bag
 * @returns {UpdateResult}
 */
function buildResult(fields, bag) {
  const defaults = {
    ok: false, refused: false, dryRun: false,
    plugin: null, claudeExe: null, command: null,
    snapshotId: null, spawned: false, apply: null,
  };
  return { ...defaults, ...fields, diagnostics: bag.all() };
}

/**
 * Add an error diagnostic and return a refused UpdateResult carrying any known
 * fields (plugin/command when already resolved). Shared refusal helper.
 * @param {DiagnosticBag} bag
 * @param {string} code @param {string} message @param {Partial<UpdateResult>} [fields]
 * @returns {UpdateResult}
 */
function refuse(bag, code, message, fields = {}) {
  bag.add({ severity: 'error', code, message, phase: PHASE });
  return buildResult({ refused: true, ...fields }, bag);
}

/**
 * Validate the <plugin> spec shape (§3/§5). Returns `null` on success or a
 * `{ code, message }` refusal. Pure; never throws.
 * @param {unknown} spec
 * @returns {{code:string, message:string}|null}
 */
function validateSpec(spec) {
  if (typeof spec !== 'string' || spec.length === 0) {
    return { code: 'update-bad-spec', message: 'plugin spec must be a non-empty "name" or "name@marketplace" string' };
  }
  if (!SPEC_RE.test(spec)) {
    return { code: 'update-bad-spec',
      message: `invalid plugin spec "${spec}"; must match ${SPEC_RE} (no path, traversal, spaces, or shell metacharacters)` };
  }
  return null;
}

/**
 * Resolve the <plugin> spec against discovered installed plugins. Matches by
 * `.key === spec` when the spec carries an `@`, else by `.name === spec`.
 * Returns `{ record }` on a single match, or `{ refusal:{code,message} }`.
 * @param {string} spec
 * @param {Array<object>} plugins
 * @returns {{record:object}|{refusal:{code:string,message:string}}}
 */
function resolvePlugin(spec, plugins) {
  const list = Array.isArray(plugins) ? plugins : [];
  const matches = spec.includes('@')
    ? list.filter((p) => p && p.key === spec)
    : list.filter((p) => p && p.name === spec);

  if (matches.length === 0) {
    return { refusal: { code: 'update-plugin-not-found',
      message: `plugin "${spec}" is not installed (not in installed_plugins.json)` } };
  }
  if (matches.length > 1) {
    const keys = matches.map((p) => p.key ?? p.name ?? '(unknown)').join(', ');
    return { refusal: { code: 'update-plugin-ambiguous',
      message: `plugin "${spec}" is installed from multiple marketplaces [${keys}]; ` +
        'disambiguate with name@marketplace' } };
  }
  return { record: matches[0] };
}

/**
 * Emit the dry-run preview diagnostics (the would-run command + the §6 caveats).
 * Writes NOTHING. Shared so the caveat text lives in one place.
 * @param {DiagnosticBag} bag
 * @param {object} record  the resolved PluginRecord
 * @param {string} human   the human "claude plugin update <key>" line
 */
function emitDryRunDiagnostics(bag, record, human) {
  bag.add({ severity: 'info', code: 'update-dry-run', phase: PHASE,
    message: `would run \`${human}\` (current version ${record.version || '(unknown)'}, ` +
      `marketplace ${record.marketplace || '(unknown)'}, cachePresent ${record.cachePresent === true}); ` +
      're-run with --apply to execute' });
  bag.add({ severity: 'info', code: 'update-restart-required', phase: PHASE,
    message: 'the change applies on restart (`claude plugin update` requires a Claude Code restart to take effect)' });
  bag.add({ severity: 'info', code: 'update-cache-not-snapshotted', phase: PHASE,
    message: 'a rollback restores installed_plugins.json but NOT the downloaded plugins/cache/** code (cache is deliberately excluded from snapshots)' });
}

/**
 * Update ONE installed plugin to latest (`update <plugin>`). Validates the spec
 * + resolves it against discovered plugins, then either previews the delegated
 * command (dry-run, the DEFAULT — writes nothing, never spawns) or, for the
 * --apply path, resolves a spawnable native claude, auto-snapshots FIRST, and
 * delegates to `claude plugin update <key>` via safeSpawn (best-effort audit
 * after). NEVER throws; every failure is a Diagnostic + a full-shape
 * `{ ok:false }` UpdateResult.
 *
 * @param {object} opts
 * @param {string}  opts.spec                       the "name" or "name@marketplace" spec
 * @param {string}  opts.targetClaudeDir            absolute governed dir
 * @param {string}  opts.mgrStateDir                absolute .mgr-state dir
 * @param {(path:string, ctx:string)=>string} [opts.assertWritable]  governed-write
 *           gate; REQUIRED only for the --apply path (forwarded to createSnapshot/audit).
 * @param {boolean} [opts.enableWrites]             true = delegate; false/absent = dry-run.
 * @param {string}  [opts.reason]                   snapshot reason (defaults to "update <key>").
 * @param {string}  [opts.lockVersion]              reported unsupported (CLI can't target a version).
 * @param {Record<string,string|undefined>} [opts.env]   passed to resolveClaudeExe (default process.env).
 * @param {string}  [opts.platform]                 passed to resolveClaudeExe (default process.platform).
 * @param {string}  [opts.cwd]                       passed to resolveClaudeExe.
 * @param {() => Date} [opts.now]                    clock injection forwarded to snapshot/audit.
 * @param {{discoverPluginsFn?:Function, resolveClaudeFn?:Function, createSnapshotFn?:Function, spawnFn?:Function, auditFn?:Function}} [opts.seams]
 * @returns {Promise<UpdateResult>}
 */
export async function updatePlugin(opts) {
  const bag = new DiagnosticBag();
  try {
    const o = opts && typeof opts === 'object' ? opts : {};
    const { spec, targetClaudeDir, mgrStateDir, assertWritable, reason, lockVersion } = o;
    const env = o.env ?? process.env;
    const platform = o.platform ?? process.platform;
    const cwd = o.cwd;
    const now = o.now;
    const enableWrites = o.enableWrites === true;
    const seams = o.seams && typeof o.seams === 'object' ? o.seams : {};
    const discoverPluginsFn = typeof seams.discoverPluginsFn === 'function' ? seams.discoverPluginsFn : discoverPlugins;
    const resolveClaudeFn = typeof seams.resolveClaudeFn === 'function' ? seams.resolveClaudeFn : resolveClaudeExe;
    const createSnapshotFn = typeof seams.createSnapshotFn === 'function' ? seams.createSnapshotFn : createSnapshot;
    const spawnFn = typeof seams.spawnFn === 'function' ? seams.spawnFn : safeSpawn;
    const auditFn = typeof seams.auditFn === 'function' ? seams.auditFn : appendAuditEntry;

    // 1. Validate the spec shape + the basic args.
    const specRefusal = validateSpec(spec);
    if (specRefusal) return refuse(bag, specRefusal.code, specRefusal.message);
    if (typeof targetClaudeDir !== 'string' || targetClaudeDir.length === 0) {
      return refuse(bag, 'update-bad-args', 'targetClaudeDir must be a non-empty string');
    }

    // 2. Discover installed plugins + resolve the spec to exactly one record.
    const discovery = discoverPluginsFn(targetClaudeDir);
    for (const d of discovery?.diagnostics ?? []) bag.add(d);
    const resolved = resolvePlugin(spec, discovery?.plugins);
    if ('refusal' in resolved) return refuse(bag, resolved.refusal.code, resolved.refusal.message);
    const record = resolved.record;

    // 2b. DEFENSE-IN-DEPTH (security review): the spawn positional is record.key,
    //     which comes straight from installed_plugins.json's keys — NOT the raw
    //     spec validateSpec() already checked. Re-validate the RESOLVED key here so
    //     a poisoned/corrupt plugins file with a metacharacter-laden key refuses
    //     CLEANLY (before any snapshot/spawn), rather than only being caught by the
    //     downstream safeSpawn gate after a wasted snapshot. This makes the design's
    //     "validated twice" property true at the source.
    if (typeof record.key !== 'string' || !SPEC_RE.test(record.key)) {
      return refuse(bag, 'update-bad-spec',
        `resolved plugin key ${JSON.stringify(record.key)} has an unsafe shape ` +
        '(corrupt installed_plugins.json?); refusing before snapshot/delegate',
        { plugin: record });
    }

    // 3. Build the delegated command. The spawn positional is the record's KEY.
    const command = ['plugin', 'update', record.key];
    const human = `claude plugin update ${record.key}`;
    if (typeof lockVersion === 'string' && lockVersion.length > 0) {
      bag.add({ severity: 'info', code: 'update-lock-version-unsupported', phase: PHASE,
        message: "the claude CLI's `plugin update` cannot target a version; updating to latest" });
    }

    // 4. DRY-RUN (default): preview only — write NOTHING, spawn NOTHING.
    if (!enableWrites) {
      emitDryRunDiagnostics(bag, record, human);
      return buildResult({ ok: true, dryRun: true, plugin: record, command }, bag);
    }

    // 5. APPLY: gate + spawnable exe + snapshot-first + delegate + best-effort audit.
    return await applyUpdate({
      bag, record, command, human, targetClaudeDir, mgrStateDir, assertWritable,
      reason, env, platform, cwd, now,
      resolveClaudeFn, createSnapshotFn, spawnFn, auditFn,
    });
  } catch (e) {
    // Absolute backstop: an unexpected error becomes a diagnostic, never a throw.
    bag.add({ severity: 'error', code: 'update-unexpected-error', phase: PHASE,
      message: `unexpected error during update: ${e instanceof Error ? e.message : String(e)}` });
    return buildResult({}, bag);
  }
}

/**
 * The --apply path (docs/phase-4b-update-design.md §4): require the gate, resolve
 * a spawnable native claude, auto-snapshot FIRST, then delegate to
 * `claude plugin update <key>` via safeSpawn, then best-effort audit. Extracted
 * to keep updatePlugin under the 80-SLOC lint ceiling. Never throws (the caller
 * wraps it; this body only awaits guarded sub-calls).
 * @param {object} a  bundled state from updatePlugin
 * @returns {Promise<UpdateResult>}
 */
async function applyUpdate(a) {
  const { bag, record, command, human, targetClaudeDir, mgrStateDir, assertWritable,
    reason, env, platform, cwd, now, resolveClaudeFn, createSnapshotFn, spawnFn, auditFn } = a;

  // a. The governed-write gate must be injected to --apply.
  if (typeof assertWritable !== 'function') {
    return refuse(bag, 'update-bad-args',
      'assertWritable (the governed-write gate) must be injected to --apply an update',
      { plugin: record, command });
  }

  // b. Resolve a spawnable native claude exe. None → refuse-with-guidance; we
  //    NEVER spawn a guessed binary, and we do NOT snapshot/spawn.
  const cr = resolveClaudeFn({ env, platform, cwd });
  for (const d of cr?.diagnostics ?? []) bag.add(d);
  if (!cr || !cr.exe) {
    return refuse(bag, 'update-claude-not-spawnable',
      `no spawnable native claude found; run \`${human}\` yourself`,
      { plugin: record, command });
  }
  const claudeExe = cr.exe;

  // c. Auto-snapshot the governed surface FIRST (the undo point). A snapshot
  //    failure aborts — we refuse to delegate without an undo point, and do NOT spawn.
  const snap = await createSnapshotFn({
    targetClaudeDir, mgrStateDir, reason: reason ?? ('update ' + record.key),
    assertWritable, now,
  });
  for (const d of snap?.diagnostics ?? []) bag.add(d);
  if (!snap || snap.ok !== true) {
    bag.add({ severity: 'error', code: 'update-snapshot-failed', phase: PHASE,
      message: 'auto-snapshot failed; refusing to delegate without an undo point' });
    return buildResult({ ok: false, plugin: record, claudeExe, command, apply: snap ?? null }, bag);
  }
  const snapshotId = snap.snapshotId ?? null;

  // d. Delegate to `claude plugin update <key>` via safeSpawn (the §5 schema).
  const tmp = tmpdir();
  const spec = {
    exe: claudeExe, args: command, cwd: tmp, allowedCwds: [tmp],
    schema: CLAUDE_PLUGIN_UPDATE_SCHEMA, timeoutMs: SPAWN_TIMEOUT_MS,
  };
  let ok;
  let spawned = false;
  try {
    spawned = true;
    await spawnFn(spec);
    ok = true;
  } catch (e) {
    ok = false;
    bag.add({ severity: 'error', code: 'update-spawn-failed', phase: PHASE,
      message: `delegated \`${human}\` failed: ${e instanceof Error ? e.message : String(e)}; the snapshot remains as the undo point` });
  }

  // e. Audit (best-effort) — never blocks the result.
  recordAudit({ bag, auditFn, mgrStateDir, assertWritable, snapshotId, ok, now });

  // f. Return the spawn outcome.
  return buildResult({ ok, dryRun: false, plugin: record, claudeExe, command, snapshotId, spawned, apply: snap }, bag);
}

/**
 * Best-effort audit of the update (metadata only). A throw OR a {written:false}
 * return degrades to a warn — it NEVER flips the update result. Extracted to keep
 * applyUpdate within the lint ceiling and the audit error handling in one place.
 * @param {object} a
 */
function recordAudit(a) {
  const { bag, auditFn, mgrStateDir, assertWritable, snapshotId, ok, now } = a;
  try {
    const res = auditFn({
      stateDir: mgrStateDir,
      entry: buildAuditEntry({ command: 'update', snapshotId, exitCode: ok ? 0 : 1, opCount: 1, now }),
      assertWritable,
    });
    if (res && res.written === false) {
      bag.add({ severity: 'warn', code: 'update-audit-unavailable', phase: PHASE,
        message: 'audit entry was not written (best-effort; the update result is unaffected)' });
    }
  } catch (e) {
    bag.add({ severity: 'warn', code: 'update-audit-unavailable', phase: PHASE,
      message: `audit append failed: ${e instanceof Error ? e.message : String(e)} (best-effort; the update result is unaffected)` });
  }
}
