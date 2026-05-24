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

import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scan } from '../discovery/scan.mjs';
import { detectOrphans } from '../discovery/orphan-detector.mjs';
import { analyzeConflicts } from '../analysis/conflicts.mjs';
import { analyzeOrphans } from '../analysis/orphans.mjs';
import { mergeSettings } from '../analysis/settings-merge.mjs';
import { loaderConfidence } from '../analysis/load-order.mjs';
import { readJsonFile, isJsonObject } from '../discovery/read-json.mjs';
import { lintTree } from '../selftest/lint.mjs';
import { checkInvariants } from '../selftest/invariants.mjs';
import { checkBoundary } from '../selftest/boundary.mjs';

/**
 * @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic
 * @typedef {import('../discovery/components.mjs').ComponentRecord} ComponentRecord
 * @typedef {import('../discovery/components.mjs').ComponentKind} ComponentKind
 * @typedef {import('../analysis/settings-merge.mjs').SettingsLayer} SettingsLayer
 */

/**
 * The handler contract: pure, sync, never-throws. `ctx.args` is the parsed-flags
 * object; a handler only reads the flags named in its own JSDoc.
 *
 * @typedef {Object} CommandContext
 * @property {string} configDir   the governed ~/.claude (resolved upstream)
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
    statusLine: s.settings.statusLine,
    topDirs: s.topDirs.known.filter((d) => d.present).map((d) => d.name),
    unknownTopDirs: s.topDirs.unknown,
  };
  if (ctx.args && ctx.args.detail) {
    result.components = s.components.map(trimComponent);
    result.plugins = s.plugins.map(trimPlugin);
    result.marketplaces = s.marketplaces.map(trimMarketplace);
    result.mcpServers = s.mcpServers.map(trimMcpServer);
  }
  return { result, diagnostics: s.diagnostics.slice() };
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
  return { name: r.name, kind: r.kind, source: r.source, path: r.path, description };
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
 * VALUE (the record already holds no secret values). Pure and total — never throws.
 * @param {import('../discovery/mcp.mjs').McpServerRecord} m
 * @returns {{name: unknown, transport: unknown, scope: unknown, command: unknown, args: unknown}}
 */
function trimMcpServer(m) {
  const r = m || {};
  return { name: r.name, transport: r.transport, scope: r.scope, command: r.command, args: r.args };
}

/**
 * Optional `--type` narrowing: return the matching list, or null when `type` is
 * absent/unrecognised (the caller then falls back to the count summary).
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
    case 'mcp': return { type, items: s.mcpServers };
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
function safeRegExp(src) {
  try { return new RegExp(src); } catch { return null; }
}

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
 * @type {CommandHandler}
 */
export function configShowEffectiveCommand(ctx) {
  const layers = readSettingsLayers(ctx.configDir);
  const m = mergeSettings(layers.layers);
  const diagnostics = [...layers.diagnostics, ...m.diagnostics];

  const key = ctx.args && ctx.args.key;
  if (typeof key === 'string' && key.length > 0) {
    const segments = key.split('.');
    const result = { key, merge: m.keys[segments[0]] ?? null, value: navigate(m.effective, segments) };
    return { result, diagnostics };
  }

  return { result: { effective: m.effective, keys: m.keys }, diagnostics };
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

/**
 * The merged per-event hooks order (the `hooks` key of effective settings).
 * Flag `args.order` is accepted for forward-compat but the data is identical in
 * Phase 1 (settings-merge already concatenates hooks in layer order).
 * @type {CommandHandler}
 */
export function hooksCommand(ctx) {
  const layers = readSettingsLayers(ctx.configDir);
  const m = mergeSettings(layers.layers);
  const hooks = (m.effective && m.effective.hooks) || {};
  return { result: { hooks }, diagnostics: [...layers.diagnostics, ...m.diagnostics] };
}

// ── selftest ────────────────────────────────────────────────────────────────────

/**
 * Self-check command (ASYNC). Always runs the SMOKE liveness probe — the two
 * filesystem walks (scan + orphan detector) over `ctx.configDir` — and then, when
 * the matching flag (or `--all`) is set, ADDS one or more rigorous gates over the
 * mgr's OWN source tree (resolved from this module's URL, NOT configDir):
 *   --lint        SLOC/param limits on src/**.mjs       (lintTree)
 *   --invariants  load-order single-source-of-truth     (checkInvariants)
 *   --boundary    import-graph + write-allowlist probe   (checkBoundary)
 *   --all         run all three in addition to the smoke checks
 *
 * The boundary gate dynamically imports paths.mjs for the runtime write-allowlist
 * probe; when `~/.claude/hooks/lib` is absent that import rejects, so it is guarded
 * and the gate degrades to a static-only scan (+ a `boundary-runtime-skipped` info).
 *
 * Returns `{ ok, checks }` (ok = every check passed) plus the aggregated
 * diagnostics: the smoke error+warn set PLUS every rigorous-check diagnostic
 * (info such as `boundary-runtime-skipped` is included but never affects the exit
 * code, which keys off error-severity only). Never throws — the selftest modules
 * never throw and the paths.mjs import is guarded.
 * @type {CommandHandler}
 */
export async function selftestCommand(ctx) {
  const s = scan({ targetClaudeDir: ctx.configDir });
  const o = detectOrphans(ctx.configDir);

  const scanErrors = errorDiags(s.diagnostics);
  const orphanErrors = errorDiags(o.diagnostics);
  const checks = [
    { name: 'scan', ok: scanErrors.length === 0 },
    { name: 'orphans', ok: orphanErrors.length === 0 },
  ];

  // Smoke layer: aggregate the error AND warn diagnostics from both walks (info is noise here).
  /** @type {Diagnostic[]} */
  const diagnostics = [...s.diagnostics, ...o.diagnostics].filter((d) => d.severity === 'error' || d.severity === 'warn');

  // Rigorous gates run against the mgr's OWN source dir (src/), resolved from this
  // module's URL — commands.mjs lives at src/cli/commands.mjs, so '..' is src/.
  const args = ctx.args || {};
  const srcDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

  if (args.all || args.lint) {
    const lr = lintTree(srcDir);
    checks.push({ name: 'lint', ok: !lr.diagnostics.some((d) => d.severity === 'error') });
    for (const d of lr.diagnostics) diagnostics.push(d);
  }
  if (args.all || args.invariants) {
    const ir = checkInvariants(srcDir);
    checks.push({ name: 'invariants', ok: !ir.diagnostics.some((d) => d.severity === 'error') });
    for (const d of ir.diagnostics) diagnostics.push(d);
  }
  if (args.all || args.boundary) {
    let assertWritable;
    let roots;
    try {
      const p = await import('../paths.mjs');
      assertWritable = p.assertWritable;
      roots = p.resolveRoots();
    } catch {
      // ~/.claude/hooks/lib absent → paths.mjs import rejects; fall back to static-only.
    }
    const br = checkBoundary({ srcDir, assertWritable, roots });
    checks.push({ name: 'boundary', ok: !br.diagnostics.some((d) => d.severity === 'error') });
    for (const d of br.diagnostics) diagnostics.push(d);
  }

  return { result: { ok: checks.every((c) => c.ok), checks }, diagnostics };
}

/** @param {readonly Diagnostic[]} diags @returns {Diagnostic[]} error-severity only */
function errorDiags(diags) {
  return diags.filter((d) => d.severity === 'error');
}

// ── shared: settings layers ─────────────────────────────────────────────────────

/**
 * Read the ordered settings layers for a config dir: `<dir>/settings.json` (name
 * 'user', LOWER precedence) then `<dir>/settings.local.json` (name 'local', HIGHER).
 * A file is included as a layer only when present AND a JSON object; a present-but-
 * malformed/unreadable file contributes NO layer and a diagnostic instead. Read
 * once here so callers (config:show-effective, hooks) never re-read.
 *
 * NOTE: this merge path still uses the strict `readJsonFile` (JSON.parse), so a
 * commented / trailing-comma settings.json is rejected here even though
 * `discoverSettings` (the inventory path) now tolerates it via JSONC (P2.U3).
 * TODO(P2): retrofit to `readJsoncFile` so the two paths converge.
 * @param {string} configDir
 * @returns {{layers: SettingsLayer[], diagnostics: Diagnostic[]}}
 */
function readSettingsLayers(configDir) {
  /** @type {SettingsLayer[]} */
  const layers = [];
  /** @type {Diagnostic[]} */
  const diagnostics = [];
  for (const { name, file } of [
    { name: 'user', file: 'settings.json' },
    { name: 'local', file: 'settings.local.json' },
  ]) {
    const abs = join(configDir, file);
    const { value, error, missing } = readJsonFile(abs);
    if (missing) continue; // absent file is benign — no layer, no diagnostic
    if (error) {
      diagnostics.push({ severity: 'error', code: 'settings-unreadable', message: error, path: abs, phase: 'cli' });
      continue;
    }
    if (!isJsonObject(value)) {
      diagnostics.push({ severity: 'warn', code: 'settings-malformed', message: `${file} is not a JSON object`, path: abs, phase: 'cli' });
      continue;
    }
    layers.push({ name, settings: value });
  }
  return { layers, diagnostics };
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
  'hooks': hooksCommand,
  'selftest': selftestCommand,
});
