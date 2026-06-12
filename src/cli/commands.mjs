/**
 * Pure read-command handlers for the CLI (P1.U15, sub-unit A).
 *
 * One handler per read subcommand. Each is a PURE data function:
 *
 *     (ctx) => { result, diagnostics }      ctx = { configDir: string, args: object }
 *
 * `configDir` is resolved upstream by resolve-config.mjs; `args` is the flags
 * object the shell (a later unit) parses from argv. Handlers read ONLY the flags
 * they document and do NOTHING with argv or output formatting — parsing and
 * rendering (json/table) are the shell's job. The underlying discovery/analysis
 * modules are all SYNC and never throw, so these handlers are sync and never throw
 * either; any failure surfaces as a Diagnostic in the returned set.
 *
 * The `diagnostics` each handler returns is the AUTHORITATIVE set for that command
 * (already de-duplicated against the scan's own aggregation — see scan.mjs: callers
 * must not also union `settings.diagnostics` / `topDirs.diagnostics`).
 *
 * Zero npm dependencies. Node stdlib only. Never throws.
 */

import { scan } from '../discovery/scan.mjs';
import { detectOrphans } from '../discovery/orphan-detector.mjs';
import { analyzeConflicts } from '../analysis/conflicts.mjs';
import { analyzeOrphans } from '../analysis/orphans.mjs';
import { mergeSettings, explainEffective } from '../analysis/settings-merge.mjs';
import { auditPermissions } from '../analysis/permissions.mjs';
import { loaderConfidence } from '../analysis/load-order.mjs';
import { runDoctor } from '../analysis/doctor/index.mjs';
import { gatherDoctorInput } from './doctor-facts.mjs';
import { readSettingsLayers } from './settings-layers.mjs';
import { redactEffective, redactKeysMap, redactMergeEntry, redactKeyedValue } from '../analysis/redact-effective.mjs';
import { redactMcpArgs } from '../analysis/redact-mcp-args.mjs';
import { redactSecretsDeep, redactSecretsInString } from '../analysis/redact-secrets-text.mjs';
import { categorizeComponents } from '../analysis/categorize.mjs';
import { categorizeMcp } from '../analysis/categorize-mcp.mjs';
import { auditCommand, driftCommand, snapshotCommand } from './ops-commands.mjs';
import { snapshotListCommand, snapshotGcCommand } from './snapshot-store-command.mjs';
import { snapshotPinCommand, snapshotUnpinCommand } from './snapshot-pin-command.mjs';
import { selftestCommand } from './selftest-command.mjs';
import { rollbackCommand } from './rollback-command.mjs';
import { recoverCommand } from './recover-command.mjs';
import { lockCommand } from './lock-command.mjs';
import { removeCommand } from './remove-command.mjs';
import { updateCommand } from './update-command.mjs';
import { mcpCommand } from './mcp-command.mjs';
import { hooksCommand } from './hooks-command.mjs';
import { healthCommand } from './health-command.mjs';
import { skillProposeCommand, skillAcceptCommand } from './skill-command.mjs';
import { configDiffCommand } from './config-diff-command.mjs';
import { completionCommand } from './completion.mjs';

/**
 * @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic
 * @typedef {import('../discovery/components.mjs').ComponentRecord} ComponentRecord
 * @typedef {import('../discovery/components.mjs').ComponentKind} ComponentKind
 */

/**
 * The handler contract: pure, sync, never-throws. `ctx.args` is the parsed-flags
 * object; a handler only reads the flags named in its own JSDoc.
 *
 * @typedef {Object} CommandContext
 * @property {string} configDir   the governed ~/.claude (resolved upstream)
 * @property {string} [mgrStateDir]  claude-mgr's own state dir (resolved upstream; used by doctor's fs/acl probes)
 * @property {Object} args        parsed flags (handler reads only what it needs)
 *
 * @typedef {Object} CommandOutput
 * @property {unknown} result            the command's data payload
 * @property {Diagnostic[]} diagnostics  authoritative diagnostics for this command
 *
 * @callback CommandHandler
 * @param {CommandContext} ctx
 * @returns {CommandOutput | Promise<CommandOutput>}
 */

// ── inventory ───────────────────────────────────────────────────────────────────

/**
 * Component / plugin / mcp counts plus the statusLine and top-dir layout.
 * Flags:
 *   `args.type`   (optional 'skill'|'agent'|'command'|'plugin'|'mcp') narrows the
 *                 result to that kind's list instead of the count summary.
 *   `args.detail` (optional boolean) when truthy AND no `--type` narrowing is in
 *                 effect, ADDS FOUR object arrays to the count summary so a TUI can
 *                 build an all-object tree + detail pane: `components` (each
 *                 skill/agent/command trimmed to `{ name, kind, source, path,
 *                 description }`), `plugins`, `marketplaces`, and `mcpServers` (each
 *                 a record trimmed to its UI fields — see the trim helpers below).
 *                 When absent the result is the counts-only summary, byte-for-byte
 *                 as before (none of these four keys) so existing callers and the
 *                 lean path are unchanged.
 *   `args['by-category']` (optional boolean) ADDS a `categories` block
 *                 (`{summary, byCategory}`) that sorts skills/agents/commands into
 *                 purpose buckets (writing/development/self-iteration/…) for a grouped
 *                 TUI/Web-UI view, PLUS an `mcpCategories` block grouping the MCP
 *                 servers by purpose the same way; absent → unchanged.
 * @type {CommandHandler}
 */
export function inventoryCommand(ctx) {
  const s = scan({ targetClaudeDir: ctx.configDir });

  const narrowed = narrowInventory(s, ctx.args && ctx.args.type);
  if (narrowed) return { result: narrowed, diagnostics: s.diagnostics.slice() };

  const result = {
    counts: {
      skills: countKind(s.components, 'skill'),
      agents: countKind(s.components, 'agent'),
      commands: countKind(s.components, 'command'),
      plugins: s.plugins.length,
      marketplaces: s.marketplaces.length,
      mcpServers: s.mcpServers.length,
    },
    // SECRET-SAFE: a token embedded in the statusLine command string is redacted to
    // <redacted> before it reaches json/ndjson (audit P1). See redact-secrets-text.mjs.
    statusLine: redactSecretsDeep(s.settings.statusLine),
    topDirs: s.topDirs.known.filter((d) => d.present).map((d) => d.name),
    unknownTopDirs: s.topDirs.unknown,
  };
  if (ctx.args && ctx.args.detail) {
    result.components = s.components.map(trimComponent);
    result.plugins = s.plugins.map(trimPlugin);
    result.marketplaces = s.marketplaces.map(trimMarketplace);
    result.mcpServers = s.mcpServers.map(trimMcpServer);
  }
  const diagnostics = s.diagnostics.slice();
  // --by-category: ADD a purpose-grouped view of the components for the TUI/Web-UI
  // (writing/development/self-iteration/… + uncategorized). Pure enrichment over the
  // already-scanned components — no new I/O or secret surface. See analysis/categorize.mjs.
  if (ctx.args && ctx.args['by-category']) {
    const cat = categorizeComponents(s.components);
    result.categories = { summary: cat.summary, byCategory: cat.byCategory };
    diagnostics.push(...cat.diagnostics);
    const mcpCat = categorizeMcp(s.mcpServers);
    result.mcpCategories = { summary: mcpCat.summary, byCategory: mcpCat.byCategory };
    diagnostics.push(...mcpCat.diagnostics);
  }
  return { result, diagnostics };
}

/**
 * Trim a discovered ComponentRecord down to the fields a browsing UI needs:
 * the loader identity (`name`), the `kind`, the provenance `source` (already a
 * minimal `{tier, plugin?, marketplace?, version?}` map), the absolute file
 * `path`, and the human-readable `description` lifted from the frontmatter (the
 * "what this does" string; '' when absent or non-string). Drops the rest of the
 * raw `frontmatter` blob so `--detail` output stays lean. Pure and total — a
 * malformed record degrades to undefined fields + an empty description, never throws.
 * @param {ComponentRecord} c
 * @returns {{name: unknown, kind: unknown, source: unknown, path: unknown, description: string}}
 */
function trimComponent(c) {
  const r = c || {};
  const fm = r.frontmatter;
  const description = fm && typeof fm.description === 'string' ? fm.description : '';
  // SECRET-SAFE: a credential pasted into a frontmatter description is redacted (audit P1).
  return { name: r.name, kind: r.kind, source: r.source, path: r.path, description: redactSecretsInString(description) };
}

/**
 * Trim a PluginRecord to the UI fields a tree/detail pane needs. Pure and total —
 * a malformed record degrades to undefined fields, never throws.
 * @param {import('../discovery/plugins.mjs').PluginRecord} p
 * @returns {{name: unknown, key: unknown, marketplace: unknown, version: unknown, enabled: unknown, cachePresent: unknown}}
 */
function trimPlugin(p) {
  const r = p || {};
  return { name: r.name, key: r.key, marketplace: r.marketplace, version: r.version, enabled: r.enabled, cachePresent: r.cachePresent };
}

/**
 * Trim a MarketplaceRecord to the UI fields. Pure and total — never throws.
 * @param {import('../discovery/marketplaces.mjs').MarketplaceRecord} m
 * @returns {{name: unknown, sourceRepo: unknown, onDisk: unknown, installLocation: unknown}}
 */
function trimMarketplace(m) {
  const r = m || {};
  return { name: r.name, sourceRepo: r.sourceRepo, onDisk: r.onDisk, installLocation: r.installLocation };
}

/**
 * Trim an McpServerRecord to the UI fields. SECRET-SAFE: copies ONLY name,
 * transport, scope, command, and args — never `envKeys`/`url` and never any env
 * VALUE (the record already holds no secret values). The `args` are additionally
 * passed through `redactMcpArgs`, which replaces a secret VALUE embedded in argv
 * (an inline `--token=xxx`, a separate `--api-key xxx`, or a URL query token) with
 * `<redacted>` while leaving benign args (package names, paths, ports, non-sensitive
 * flags) untouched — so this single chokepoint covers both `--type mcp` AND
 * `--detail`. Pure and total — never throws.
 * @param {import('../discovery/mcp.mjs').McpServerRecord} m
 * @returns {{name: unknown, transport: unknown, scope: unknown, command: unknown, args: unknown}}
 */
function trimMcpServer(m) {
  const r = m || {};
  return { name: r.name, transport: r.transport, scope: r.scope, command: r.command, args: redactMcpArgs(r.args) };
}

/**
 * Optional `--type` narrowing: return the matching list, or null when `type` is
 * absent/unrecognised (the caller then falls back to the count summary).
 *
 * SECRET-SAFE: the `mcp` list is mapped through `trimMcpServer` (the SAME
 * redaction the `--detail` path applies) so it drops `url` + `envKeys` and is NO
 * LEAKIER than `--detail` under every output format (json/ndjson). command + args
 * are intentionally kept. The other lists carry no secrets and pass through raw.
 * @param {import('../discovery/scan.mjs').ScanResult} s
 * @param {unknown} type
 * @returns {{type: string, items: unknown[]}|null}
 */
function narrowInventory(s, type) {
  switch (type) {
    case 'skill': case 'agent': case 'command':
      return { type, items: s.components.filter((c) => c.kind === type) };
    case 'plugin': return { type, items: s.plugins };
    case 'marketplace': return { type, items: s.marketplaces };
    case 'mcp': return { type, items: s.mcpServers.map(trimMcpServer) };
    default: return null;
  }
}

/**
 * Count components of one kind.
 * @param {ComponentRecord[]} components
 * @param {ComponentKind} kind
 * @returns {number}
 */
function countKind(components, kind) {
  let n = 0;
  for (const c of components) if (c.kind === kind) n += 1;
  return n;
}

// ── conflicts ─────────────────────────────────────────────────────────────────

/**
 * Shadowing conflicts among loaded skills/agents/commands. Flags: `args.name`
 * (optional RegExp source string) filters clusters by `key`; an invalid regex is
 * skipped with an info diagnostic (never throws). The Phase-1 version-guard info
 * is appended via loaderConfidence(undefined) — there is no CC-version detection
 * yet, so confidence is always 'likely'.
 * @type {CommandHandler}
 */
export function conflictsCommand(ctx) {
  const s = scan({ targetClaudeDir: ctx.configDir });
  const c = analyzeConflicts(s.components);
  /** @type {Diagnostic[]} */
  const extra = [];

  let conflicts = c.conflicts;
  const name = ctx.args && ctx.args.name;
  if (typeof name === 'string' && name.length > 0) {
    const re = safeRegExp(name);
    if (re) conflicts = conflicts.filter((cl) => re.test(cl.key));
    else extra.push({ severity: 'info', code: 'conflicts-bad-filter', message: `ignoring invalid --name filter: ${name}`, phase: 'cli' });
  }

  const diagnostics = [...s.diagnostics, ...c.diagnostics, ...loaderConfidence(undefined).diagnostics, ...extra];
  return { result: { conflicts }, diagnostics };
}

/**
 * Compile a RegExp from a source string without throwing; null on a bad pattern.
 * @param {string} src
 * @returns {RegExp|null}
 */
function safeRegExp(src) { try { return new RegExp(src); } catch { return null; } }

// ── orphans ─────────────────────────────────────────────────────────────────────

/**
 * Hard + soft orphan facts in the config root, flattened for the CLI.
 * @type {CommandHandler}
 */
export function orphansCommand(ctx) {
  const a = analyzeOrphans(detectOrphans(ctx.configDir));
  return { result: { orphans: a.orphans, summary: a.summary }, diagnostics: a.diagnostics.slice() };
}

// ── config:show-effective ─────────────────────────────────────────────────────

/**
 * The merged effective settings (user < local). Flags: `args.key` (optional dotted
 * path) narrows to that key — `merge` is the top-level segment's KeyMerge, `value`
 * is the value navigated down the full path (undefined if absent; never throws).
 *
 * SECRET-SAFE: sensitive VALUES are redacted to `{redacted:true, sha256}` BEFORE
 * the result is returned, so EVERY output format (json/ndjson/table/quiet) is
 * uniformly safe — every value under the top-level `env` map plus any value whose
 * KEY is sensitive (token/secret/key/password/credential/auth). Both value-bearing
 * surfaces are covered: the merged `effective` AND the per-key `keys` map (whose
 * KeyMerge `value`/`perLayer[].value` hold raw values — an unknown sensitive key
 * like `apiKeyHelper` lives ONLY there). Key NAMES and the merge metadata stay
 * visible; the originals are left untouched (redaction returns fresh copies).
 * See analysis/redact-effective.mjs.
 * @type {CommandHandler}
 */
export function configShowEffectiveCommand(ctx) {
  const layers = readSettingsLayers(ctx.configDir);
  const m = mergeSettings(layers.layers);
  const diagnostics = [...layers.diagnostics, ...m.diagnostics];
  const explain = !!(ctx.args && ctx.args.explain);

  const key = ctx.args && ctx.args.key;
  if (typeof key === 'string' && key.length > 0) {
    const segments = key.split('.');
    const sourceKeys = explain ? explainEffective(layers.layers).keys : m.keys;
    const result = { key, merge: redactMergeEntry(segments[0], sourceKeys[segments[0]] ?? null), value: redactKeyedValue(segments, navigate(m.effective, segments)) };
    return { result, diagnostics };
  }

  if (explain) {
    const ex = explainEffective(layers.layers);
    return { result: { explain: true, effective: redactEffective(m.effective), keys: redactKeysMap(ex.keys) }, diagnostics };
  }

  return { result: { effective: redactEffective(m.effective), keys: redactKeysMap(m.keys) }, diagnostics };
}

/**
 * Walk an object down a path of segments. Returns undefined the moment the path
 * leaves a real object — total and never throws (used for `--key a.b.c` lookups).
 * @param {unknown} obj
 * @param {string[]} segments
 * @returns {unknown}
 */
function navigate(obj, segments) {
  let cur = obj;
  for (const seg of segments) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = /** @type {Record<string, unknown>} */ (cur)[seg];
  }
  return cur;
}

// ── hooks ─────────────────────────────────────────────────────────────────────
// hooksCommand lives in hooks-command.mjs (P5.U4 SLOC split — the ops-commands
// precedent): merged hooks (byte-compatible key) + the new human explanations.

// ── permissions ──────────────────────────────────────────────────────────────────

/**
 * Effective permissions (allow/ask/deny). With `--audit` also surfaces overbroad
 * wildcard allow entries (`overbroad` list + one warn per entry). Without `--audit`
 * it is a plain read — no overbroad diagnostics. Pure, never throws.
 * @type {CommandHandler}
 */
export function permissionsCommand(ctx) {
  const layers = readSettingsLayers(ctx.configDir);
  const m = mergeSettings(layers.layers);
  const baseDiag = [...layers.diagnostics, ...m.diagnostics];
  const perms = (m.effective && m.effective.permissions) || {};
  const audit = auditPermissions(perms);
  // SECRET-SAFE: a credential embedded in a permission rule string (e.g. a URL with
  // userinfo) is redacted before it reaches json/ndjson (audit P1).
  const allow = redactSecretsDeep(audit.allow);
  const ask = redactSecretsDeep(audit.ask);
  const deny = redactSecretsDeep(audit.deny);
  if (ctx.args && ctx.args.audit) {
    return {
      result: { allow, ask, deny, overbroad: redactSecretsDeep(audit.overbroad) },
      diagnostics: [...baseDiag, ...audit.diagnostics],
    };
  }
  return { result: { allow, ask, deny }, diagnostics: baseDiag };
}

// ── doctor ──────────────────────────────────────────────────────────────────────

/**
 * Health-check command (ASYNC). Gathers the DoctorInput facts (scan + merged
 * settings + conflict/orphan analysis + the passive probes), then runs the pure
 * `runDoctor` judgment layer over them. With `--active-probes` it ALSO gathers
 * the active probe facts (node --check, claude --version, the loader probe) and
 * runs the active checks; without it those checks are reported as `ran:false`
 * and produce no side effects.
 *
 * The result is `{ probeLevel, checks }` (the per-check run/findings summary);
 * diagnostics are the gather operational diagnostics PLUS every doctor finding.
 * Never throws — gatherDoctorInput and runDoctor are both never-throws.
 * @type {CommandHandler}
 */
export async function doctorCommand(ctx) {
  const activeProbes = !!(ctx.args && ctx.args['active-probes']);
  const { input, diagnostics: gatherDiags } = await gatherDoctorInput({
    configDir: ctx.configDir, mgrStateDir: ctx.mgrStateDir, activeProbes, now: Date.now(),
    cwd: ctx.configDir,
  });
  const report = runDoctor(input, { activeProbes });
  return {
    result: { probeLevel: report.probeLevel, checks: report.checks },
    diagnostics: [...gatherDiags, ...report.diagnostics],
  };
}

// ── registry ────────────────────────────────────────────────────────────────────

/**
 * Canonical command name → handler. Frozen so the shell cannot mutate the routing
 * table at runtime. Names are the user-facing subcommands the shell dispatches on.
 * @type {Readonly<Record<string, CommandHandler>>}
 */
export const COMMANDS = Object.freeze({
  'inventory': inventoryCommand,
  'conflicts': conflictsCommand,
  'orphans': orphansCommand,
  'config:show-effective': configShowEffectiveCommand,
  // config diff (P4b.U7b): READ-ONLY Myers line-diff of two files. Two-word command.
  'config:diff': (ctx) => configDiffCommand(ctx),
  // completion (P4b.U9): emit a bash|powershell tab-completion script. PURE READ-ONLY.
  // Vocabulary passed at call time to avoid a commands↔completion cycle.
  'completion': (ctx) => completionCommand(ctx, { commandKeys: Object.keys(COMMANDS) }),
  'hooks': hooksCommand,
  'permissions': permissionsCommand,
  'selftest': selftestCommand,
  'doctor': doctorCommand,
  // health (P5.U5): severity-layered loadability + advice + hook status. READ-ONLY,
  // passive always (doctor owns --active-probes). Takes an optional deps arg.
  'health': (ctx) => healthCommand(ctx),
  'audit': auditCommand,
  'drift': driftCommand,
  // snapshot: create (dry-run default); list/gc/pin/unpin: management.
  // All take an optional deps arg; registry passes only ctx → default (real) deps.
  'snapshot': (ctx) => snapshotCommand(ctx),
  'snapshot:list': (ctx) => snapshotListCommand(ctx),
  'snapshot:gc': (ctx) => snapshotGcCommand(ctx),
  'snapshot:pin': (ctx) => snapshotPinCommand(ctx),
  'snapshot:unpin': (ctx) => snapshotUnpinCommand(ctx),
  // Governed-config WRITE commands (P3.U22+), DRY-RUN by default + write gate
  // (--apply; CLAUDE_MGR_ENABLE_WRITES=0 is an explicit opt-out lock). Each takes an optional deps arg.
  'rollback': (ctx) => rollbackCommand(ctx),
  'recover': (ctx) => recoverCommand(ctx),
  'lock': (ctx) => lockCommand(ctx),
  'remove': (ctx) => removeCommand(ctx),
  'update': (ctx) => updateCommand(ctx),
  'mcp:remove': (ctx) => mcpCommand(ctx),
  // skill propose (P5.U8): write skills/<name>/SKILL.proposed-<ts>.md (dry-run default; 'propose' gate).
  'skill:propose': (ctx) => skillProposeCommand(ctx),
  // skill accept (P5.U9): overwrite skills/<name>/SKILL.md from a proposal, snapshot-first (dry-run default; 'accept' gate).
  'skill:accept': (ctx) => skillAcceptCommand(ctx),
});

// Re-export commands so tests can import them directly from this module.
export { auditCommand, driftCommand, snapshotCommand, selftestCommand, snapshotListCommand, snapshotGcCommand, snapshotPinCommand, snapshotUnpinCommand, rollbackCommand, recoverCommand, lockCommand, removeCommand, updateCommand, mcpCommand, hooksCommand, healthCommand, configDiffCommand, completionCommand, skillProposeCommand, skillAcceptCommand };
