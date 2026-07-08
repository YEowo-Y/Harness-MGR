/**
 * `conflicts` command (SLOC split from commands.mjs; codex co-existence P6).
 *
 * Two target models:
 *   - CLAUDE (default): the verified Claude shadowing model — `analyzeConflicts`
 *     clusters same-(kind, resolution-key) components and reports a likelyWinner,
 *     plus the P5.U10 `dispositions` advice overlay. BYTE-IDENTICAL to the pre-split
 *     handler (the extraction moved this code verbatim).
 *   - CODEX: codex's own docs say same-name components COEXIST, they do not shadow.
 *     So once the multi-source scan surfaces cross-source same-name skills (a home
 *     skill + a plugin skill, or one plugin name shipped from two marketplaces), it
 *     would be dishonest to assert a Claude-style winner. For codex this command runs
 *     `analyzeCoexistence` instead and returns `{conflicts: [], dispositions: [],
 *     coexistence}` plus the codex caveat. `targetModelsShadowing` is the single
 *     source for that "codex doesn't shadow" decision (shared with doctor-facts).
 *
 * Authority: docs/phase-6-codex-loadorder-design.md. Pure CLI handler over scan() +
 * the analysis modules; never throws.
 */

import { scan } from '../discovery/scan.mjs';
import { analyzeConflicts } from '../analysis/conflicts.mjs';
import { isCaseInsensitiveFs } from '../lib/name-identity.mjs';
import { analyzeDisposition } from '../analysis/disposition.mjs';
import { analyzeCoexistence, targetModelsShadowing } from '../analysis/codex-coexistence.mjs';
import { loaderConfidence } from '../analysis/load-order.mjs';

/**
 * @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic
 * @typedef {import('./commands.mjs').CommandContext} CommandContext
 */

/**
 * The codex honesty caveat (P6). On a codex target this REPLACES the Claude-Code
 * version diagnostic `loader-rules-unverified-version` (whose "verified for 2.1.x"
 * wording is meaningless on codex). Codex's own docs say same-name components coexist
 * rather than shadow, so multi-source same-name skills are reported as co-existing
 * (not shadowing) and precedence stays unverified (best-effort).
 * Authority: docs/phase-6-codex-loadorder-design.md.
 * @type {Readonly<Diagnostic>}
 */
const CODEX_CONFLICTS_CAVEAT = Object.freeze({
  severity: 'info',
  code: 'conflicts-unverified-for-codex',
  phase: 'conflicts',
  message: 'Codex component resolution is not verified: same-name components coexist rather than shadow (per Codex docs), so multi-source same-name skills are shown as co-existing, not shadowing -- precedence is unverified and results are best-effort.',
});

/**
 * The load-order confidence diagnostics for a conflicts run. On a codex target, the
 * honest codex caveat; otherwise the Claude version-guard info (byte-identical to
 * `loaderConfidence(undefined).diagnostics`).
 * @param {import('../targets/descriptor.mjs').TargetDescriptor} [descriptor]
 * @returns {Diagnostic[]}
 */
function conflictLoadOrderDiagnostics(descriptor) {
  if (descriptor && descriptor.id === 'codex') return [CODEX_CONFLICTS_CAVEAT];
  return loaderConfidence(undefined).diagnostics;
}

/**
 * Shadowing conflicts (Claude) or co-existence (codex) among loaded components.
 * `args.name` (optional RegExp source string) filters clusters — by `key` for the
 * Claude shadowing clusters, by `name` for the codex co-existence clusters; an
 * invalid regex is skipped with an info diagnostic (never throws). The load-order
 * confidence info is appended via conflictLoadOrderDiagnostics(ctx.descriptor).
 * @param {CommandContext} ctx
 * @returns {{ result: object, diagnostics: Diagnostic[] }}
 */
export function conflictsCommand(ctx) {
  const s = scan({ targetClaudeDir: ctx.configDir, descriptor: ctx.descriptor });
  /** @type {Diagnostic[]} */
  const extra = [];
  const re = compileNameFilter(ctx.args && ctx.args.name, extra);

  // CODEX: no Claude-style shadowing — report honest co-existence (no winner).
  if (!targetModelsShadowing(ctx.descriptor)) {
    const co = analyzeCoexistence(s.components);
    let coexistence = co.coexistence;
    if (re) coexistence = coexistence.filter((cl) => re.test(cl.name));
    const diagnostics = [...s.diagnostics, ...co.diagnostics, ...conflictLoadOrderDiagnostics(ctx.descriptor), ...extra];
    return { result: { conflicts: [], dispositions: [], coexistence }, diagnostics };
  }

  // CLAUDE (default): the verified shadowing model. caseInsensitive folds case-only
  // shadows on a Windows/macOS volume (NFC folding applies on every platform).
  const c = analyzeConflicts(s.components, { caseInsensitive: isCaseInsensitiveFs() });
  let conflicts = c.conflicts;
  if (re) conflicts = conflicts.filter((cl) => re.test(cl.key));

  // P5.U10 ADDITIVE overlay: rule-backed disposition advice over the (filtered)
  // clusters. `conflicts` stays byte-identical; dispositions derive from it so they
  // stay in sync with the --name filter. Gate-safe (pure analysis).
  const diagnostics = [...s.diagnostics, ...c.diagnostics, ...conflictLoadOrderDiagnostics(ctx.descriptor), ...extra];
  return { result: { conflicts, dispositions: analyzeDisposition({ conflicts }).dispositions }, diagnostics };
}

/**
 * Compile the optional --name filter. Returns a RegExp, or null when the flag is
 * absent OR invalid; an invalid pattern pushes an info diagnostic into `extra`
 * (matching the pre-split behavior exactly). Never throws.
 * @param {unknown} name
 * @param {Diagnostic[]} extra
 * @returns {RegExp|null}
 */
function compileNameFilter(name, extra) {
  if (typeof name !== 'string' || name.length === 0) return null;
  const re = safeRegExp(name);
  if (!re) extra.push({ severity: 'info', code: 'conflicts-bad-filter', message: `ignoring invalid --name filter: ${name}`, phase: 'cli' });
  return re;
}

/** Compile a RegExp from a source string without throwing; null on a bad pattern. @param {string} src @returns {RegExp|null} */
function safeRegExp(src) { try { return new RegExp(src); } catch { return null; } }
