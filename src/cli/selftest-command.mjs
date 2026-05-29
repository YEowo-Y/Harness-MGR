/**
 * Selftest command handler (extracted from commands.mjs to keep that module ≤200 SLOC).
 *
 * Handles `selftest` (smoke + rigorous gates), `selftest --release-gate`
 * (the 6-step P3 release gate), and `selftest --schema-canary` (the schema
 * surface fingerprint canary). All dispatch paths return the standard
 * { result, diagnostics, code? } CommandOutput shape.
 *
 * Zero npm dependencies. Node stdlib only. Never throws.
 */

import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';
import { scan } from '../discovery/scan.mjs';
import { detectOrphans } from '../discovery/orphan-detector.mjs';
import { lintTree } from '../selftest/lint.mjs';
import { checkInvariants } from '../selftest/invariants.mjs';
import { checkBoundary } from '../selftest/boundary.mjs';
import { runReleaseGate } from '../selftest/release-gate.mjs';
import { readStabilityLog, appendStabilityRow } from '../ops/stability-log.mjs';
import { readJsonFile } from '../discovery/read-json.mjs';
import { stableStringify } from '../output/json.mjs';

/** @typedef {import('./commands.mjs').CommandHandler} CommandHandler */
/** @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic */

/**
 * Selftest command (ASYNC). Smoke + optional rigorous gates over mgr's own source.
 * With `--release-gate`: delegates entirely to runReleaseGate (6-step gate) and
 * optionally writes a stability-log row when `--log` is set.
 * With `--schema-canary`: gathers facts + compares to committed baseline; always code 0.
 *
 * Flags:
 *   --release-gate     run the 6-step release gate
 *   --base <branch>    (release-gate only) changed-files base branch for coverage
 *   --log              (release-gate only) append a row to STABILITY-LOG.jsonl
 *   --schema-canary    run the schema fingerprint canary
 *   --update-baseline  (schema-canary only) rewrite src/selftest/schema-baseline.json
 *   --lint             smoke+lint gate
 *   --invariants       smoke+invariants gate
 *   --boundary         smoke+boundary gate
 *   --all              smoke + all three rigorous gates
 *
 * @type {CommandHandler}
 */
export async function selftestCommand(ctx) {
  const args = ctx.args || {};

  if (args['release-gate']) {
    return releaseGateDispatch(ctx);
  }

  if (args['schema-canary']) {
    return canaryDispatch(ctx);
  }

  return smokeDispatch(ctx);
}

// ── schema-canary dispatch ────────────────────────────────────────────────────

/**
 * Dispatch for `selftest --schema-canary [--update-baseline]`.
 * Gathers schema surface facts, computes fingerprint, compares to the committed
 * baseline. Code is ALWAYS 0 — drift is a WARN, never a gate failure.
 * With `--update-baseline`, rewrites src/selftest/schema-baseline.json (source
 * tree write, NOT governed ~/.claude — do NOT route through assertWritable).
 *
 * Injectable seams for tests: ctx.baselinePath, ctx.gatherSchemaFn.
 *
 * @param {import('./commands.mjs').CommandContext & {baselinePath?: string, gatherSchemaFn?: Function}} ctx
 * @returns {Promise<import('./commands.mjs').CommandOutput>}
 */
export async function canaryDispatch(ctx) {
  try {
    const args = (ctx && ctx.args) || {};
    const srcDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

    // Default baseline path: src/selftest/schema-baseline.json (source tree).
    const baselinePath = (ctx && typeof ctx.baselinePath === 'string' && ctx.baselinePath.length > 0)
      ? ctx.baselinePath
      : join(srcDir, 'selftest', 'schema-baseline.json');

    // Dynamic import for M2-safety (probe-schema → no paths.mjs in static graph).
    const { gatherSchemaFacts } = ctx && typeof ctx.gatherSchemaFn === 'function'
      ? { gatherSchemaFacts: ctx.gatherSchemaFn }
      : await import('../discovery/probe-schema.mjs');
    const { computeFingerprint, compareFingerprint } = await import('../selftest/schema-canary.mjs');

    // Gather facts from configDir. Pass the real scan as scanFn so mcp + topDirs
    // dimensions are consistent with the baseline (which was generated via scan).
    // The injectable ctx.gatherSchemaFn seam replaces the whole gather for tests.
    const configDir = (ctx && ctx.configDir) || '';
    const { facts, diagnostics: gatherDiags } = gatherSchemaFacts({ configDir, scanFn: scan });

    const { fingerprint, dimensions, diagnostics: computeDiags } = computeFingerprint(facts);

    // Read committed baseline (missing → no-baseline, benign).
    const { value: baseline } = readJsonFile(baselinePath);

    const { status, changes, summary, diagnostics: compareDiags } = compareFingerprint({
      current: { fingerprint, dimensions },
      baseline: baseline,
    });

    const allDiags = [...gatherDiags, ...computeDiags, ...compareDiags];

    if (args['update-baseline']) {
      const newBaseline = {
        schemaCanaryVersion: 1,
        generatedAt: new Date().toISOString(),
        fingerprint,
        dimensions,
      };
      try {
        writeFileSync(baselinePath, stableStringify(newBaseline, { indent: 2 }), 'utf8');
      } catch (err) {
        allDiags.push({ severity: 'error', code: 'schema-canary-baseline-write-failed',
          message: err instanceof Error ? err.message : String(err ?? ''),
          phase: 'schema-canary', path: baselinePath });
      }
      return { result: { canary: 'schema', status: 'baseline-updated', changes: [], summary, dimensions }, diagnostics: allDiags, code: 0 };
    }

    return { result: { canary: 'schema', status, changes, summary, dimensions }, diagnostics: allDiags, code: 0 };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err ?? '');
    return { result: { canary: 'schema', status: 'no-baseline', changes: [], summary: { added: 0, removed: 0, modified: 0 }, dimensions: null },
      diagnostics: [{ severity: 'error', code: 'schema-canary-dispatch-failed', message: msg, phase: 'schema-canary' }], code: 0 };
  }
}

// ── release-gate dispatch ─────────────────────────────────────────────────────

/**
 * Dispatch for `selftest --release-gate [--log] [--base <branch>]`.
 * Resolves paths, runs the gate (via the injected `runGate`, default the real
 * runReleaseGate), and optionally appends a stability-log row to STABILITY-LOG.jsonl.
 * The `runGate` seam lets tests drive this WITHOUT spawning node --test, and a
 * test-only `ctx.logPath` redirects the --log write away from the repo-root log.
 *
 * @param {import('./commands.mjs').CommandContext & {logPath?: string}} ctx
 * @param {Function} [runGate]  gate runner (default: runReleaseGate)
 * @returns {Promise<import('./commands.mjs').CommandOutput>}
 */
export async function releaseGateDispatch(ctx, runGate = runReleaseGate) {
  const args = (ctx && ctx.args) || {};
  const srcDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const repoRoot = resolve(srcDir, '..');

  let assertWritable;
  let roots;
  try {
    const p = await import('../paths.mjs');
    assertWritable = p.assertWritable;
    roots = p.resolveRoots();
  } catch {
    // M2: paths.mjs may reject; boundary gate degrades to static-only (same as smoke path).
  }

  const gateResult = await runGate({
    srcDir,
    configDir: ctx && ctx.configDir,
    mgrStateDir: (ctx && ctx.mgrStateDir) || '',
    repoRoot,
    base: typeof args.base === 'string' ? args.base : undefined,
    assertWritable,
    roots,
  });

  if (args.log) {
    // ctx.logPath is a test-only override; the production CLI leaves it unset and
    // the row lands in the repo-root STABILITY-LOG.jsonl.
    const logPath = (ctx && typeof ctx.logPath === 'string' && ctx.logPath.length > 0)
      ? ctx.logPath
      : resolve(repoRoot, 'STABILITY-LOG.jsonl');
    appendLogRow(logPath, gateResult);
  }

  return {
    result: { gate: 'release', pass: gateResult.pass, steps: gateResult.steps },
    diagnostics: gateResult.diagnostics,
    code: gateResult.code,
  };
}

/**
 * Build the stability-log row from the prior rows + the gate outcome. PURE: picks
 * the latest non-empty cc_version from `rows` (else 'unknown'), passes the error
 * count through, and stamps `ts`. Never throws, never mutates input.
 *
 * @param {{ rows: Array<{cc_version?: string}>, pass: boolean, errorDiagCount: number, ts: string }} input
 * @returns {{ ts: string, cc_version: string, gate_pass: boolean, error_diag_count: number }}
 */
export function buildStabilityRow({ rows, pass, errorDiagCount, ts }) {
  const list = Array.isArray(rows) ? rows : [];
  let ccVersion = 'unknown';
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const r = list[i];
    if (r && typeof r.cc_version === 'string' && r.cc_version.length > 0) {
      ccVersion = r.cc_version;
      break;
    }
  }
  return {
    ts: typeof ts === 'string' ? ts : '',
    cc_version: ccVersion,
    gate_pass: pass === true,
    error_diag_count: typeof errorDiagCount === 'number' ? errorDiagCount : 0,
  };
}

/**
 * Append a stability-log row after a release-gate run to an explicit logPath.
 * Best-effort: any failure is silently swallowed (the gate result is already
 * set; logging is advisory). Row contents are built by the pure buildStabilityRow.
 *
 * @param {string} logPath  absolute path to STABILITY-LOG.jsonl
 * @param {{ pass: boolean, diagnostics: Diagnostic[] }} gateResult
 */
function appendLogRow(logPath, gateResult) {
  try {
    const { rows } = readStabilityLog({ logPath });
    const errorDiagCount = gateResult.diagnostics.filter((d) => d && d.severity === 'error').length;
    appendStabilityRow({
      logPath,
      row: buildStabilityRow({
        rows,
        pass: gateResult.pass,
        errorDiagCount,
        ts: new Date().toISOString(),
      }),
    });
  } catch {
    // Best-effort: logging failure must never crash the CLI.
  }
}

// ── smoke dispatch ────────────────────────────────────────────────────────────

/**
 * The original selftest smoke + optional rigorous gates.
 *
 * @param {import('./commands.mjs').CommandContext} ctx
 * @returns {Promise<import('./commands.mjs').CommandOutput>}
 */
async function smokeDispatch(ctx) {
  const s = scan({ targetClaudeDir: ctx.configDir });
  const o = detectOrphans(ctx.configDir);

  const scanErrors = s.diagnostics.filter((d) => d.severity === 'error');
  const orphanErrors = o.diagnostics.filter((d) => d.severity === 'error');
  const checks = [
    { name: 'scan', ok: scanErrors.length === 0 },
    { name: 'orphans', ok: orphanErrors.length === 0 },
  ];

  /** @type {Diagnostic[]} */
  const diagnostics = [...s.diagnostics, ...o.diagnostics]
    .filter((d) => d.severity === 'error' || d.severity === 'warn');

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
      // ~/.claude/hooks/lib absent → degrade to static-only.
    }
    const br = checkBoundary({ srcDir, assertWritable, roots });
    checks.push({ name: 'boundary', ok: !br.diagnostics.some((d) => d.severity === 'error') });
    for (const d of br.diagnostics) diagnostics.push(d);
  }

  return { result: { ok: checks.every((c) => c.ok), checks }, diagnostics };
}
