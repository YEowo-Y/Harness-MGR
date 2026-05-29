/**
 * Default seam implementations for the release-gate (P3 gate infrastructure).
 *
 * Extracted from release-gate.mjs so that module stays ≤200 SLOC.
 * These are the REAL spawning implementations used by the CLI path.
 * Unit tests MUST inject fakes so they never spawn node --test recursively.
 *
 * Zero npm dependencies. Node stdlib only. Never throws.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic */

/**
 * Build a child-process env with NODE_TEST_CONTEXT stripped. When THIS process is
 * itself running under `node --test` (e.g. a test exercises these seams), the child
 * inherits NODE_TEST_CONTEXT and silently switches to reporter mode — discovering
 * ZERO test files and exiting 0, which would make the gate pass falsely. The real
 * CLI path never sets this var, so stripping it is a no-op there and a correctness
 * guard under nested runs. Never mutates process.env.
 *
 * @returns {NodeJS.ProcessEnv}
 */
function childEnv() {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

/**
 * DEFAULT runTests seam: spawn `node --test` via process.execPath (the absolute
 * Node binary — never 'npm' or any .cmd shim; Windows execFile cannot run .cmd
 * shims since the Node CVE-2024-27980 fix). Returns {pass, detail}.
 * Generous 5-minute timeout for the ~1100-test suite.
 *
 * @param {{repoRoot: string}} opts
 * @returns {{pass: boolean, detail: string}}
 */
export function defaultRunTests({ repoRoot }) {
  try {
    execFileSync(process.execPath, ['--test'], {
      cwd: repoRoot, stdio: 'pipe', timeout: 300_000, env: childEnv(),
    });
    return { pass: true, detail: 'node --test exited 0' };
  } catch (err) {
    const code = err && typeof err.status === 'number' ? err.status : '?';
    return { pass: false, detail: `node --test exited ${code}` };
  }
}

/**
 * DEFAULT runCoverage seam: invoke c8 via `node node_modules/c8/bin/c8.js` with
 * --reporter=json-summary, which writes coverage/coverage-summary.json. Returns a
 * map from absolute file path → line coverage pct, or null when unavailable.
 *
 * @param {{repoRoot: string}} opts
 * @returns {{coverageMap: Record<string, number>|null, detail: string}}
 */
export function defaultRunCoverage({ repoRoot }) {
  const c8Bin = join(repoRoot, 'node_modules', 'c8', 'bin', 'c8.js');
  if (!existsSync(c8Bin)) {
    return { coverageMap: null, detail: 'c8 not found at node_modules/c8/bin/c8.js' };
  }
  try {
    execFileSync(process.execPath, [
      c8Bin, '--reporter=json-summary', '--reporter=text',
      process.execPath, '--test',
    ], { cwd: repoRoot, stdio: 'pipe', timeout: 300_000, env: childEnv() });
  } catch (err) {
    // c8 may exit non-zero even when the summary was written (no threshold config).
    // ETIMEDOUT/ENOENT are real failures; other non-zero exits: still read summary.
    if (err && (err.code === 'ETIMEDOUT' || err.code === 'ENOENT')) {
      const msg = err instanceof Error ? err.message : String(err ?? '');
      return { coverageMap: null, detail: `c8 spawn failed: ${msg}` };
    }
  }
  return readCoverageSummary(join(repoRoot, 'coverage', 'coverage-summary.json'));
}

/**
 * Parse coverage-summary.json into a {absolutePath → linePct} map.
 * Returns {coverageMap: null, detail} on any read/parse failure.
 *
 * Exported so it can be unit-tested directly against a temp summary file
 * (covers the parse branches without spawning c8).
 *
 * @param {string} summaryPath
 * @returns {{coverageMap: Record<string, number>|null, detail: string}}
 */
export function readCoverageSummary(summaryPath) {
  try {
    const raw = readFileSync(summaryPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') {
      return { coverageMap: null, detail: 'coverage-summary.json is not an object' };
    }
    /** @type {Record<string, number>} */
    const map = Object.create(null);
    for (const key of Object.keys(parsed)) {
      const entry = parsed[key];
      if (entry && typeof entry === 'object' && entry.lines && typeof entry.lines.pct === 'number') {
        map[key] = entry.lines.pct;
      }
    }
    return { coverageMap: map, detail: `coverage-summary.json parsed (${Object.keys(map).length} files)` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err ?? '');
    return { coverageMap: null, detail: `could not read coverage-summary.json: ${msg}` };
  }
}

/**
 * DEFAULT changedSrcFiles seam: returns repo-relative paths of changed src/**.mjs
 * files (uncommitted + untracked vs HEAD, or vs merge-base with `base`).
 * Returns [] when git is unavailable (coverage step passes vacuously).
 *
 * @param {{repoRoot: string, base?: string}} opts
 * @returns {string[]}
 */
export function defaultChangedSrcFiles({ repoRoot, base }) {
  try {
    // SECURITY: a `base` value beginning with '-' could be read by git as a flag.
    // A legitimate committish never starts with '-', so treat such a value as
    // "no usable base" and fall through to the default HEAD diff below.
    if (typeof base === 'string' && base.length > 0 && !base.startsWith('-')) {
      const mb = execFileSync('git', ['merge-base', 'HEAD', base],
        { cwd: repoRoot, stdio: 'pipe', timeout: 10_000 }).toString().trim();
      return parseMjsLines(execFileSync('git', ['diff', '--name-only', mb, '--', 'src'],
        { cwd: repoRoot, stdio: 'pipe', timeout: 10_000 }).toString());
    }
    const diff = parseMjsLines(execFileSync('git', ['diff', '--name-only', 'HEAD', '--', 'src'],
      { cwd: repoRoot, stdio: 'pipe', timeout: 10_000 }).toString());
    const untracked = parseMjsLines(execFileSync('git',
      ['ls-files', '--others', '--exclude-standard', '--', 'src'],
      { cwd: repoRoot, stdio: 'pipe', timeout: 10_000 }).toString());
    const seen = new Set(diff);
    for (const p of untracked) if (!seen.has(p)) diff.push(p);
    return diff;
  } catch {
    return [];
  }
}

/**
 * Split newline-separated output into trimmed non-empty .mjs paths.
 * @param {string} text
 * @returns {string[]}
 */
function parseMjsLines(text) {
  /** @type {string[]} */
  const out = [];
  for (const line of text.split('\n')) {
    const p = line.trim();
    if (p.endsWith('.mjs')) out.push(p);
  }
  return out;
}

/**
 * DEFAULT runDoctorPassive seam: dynamically imports doctor-facts + doctor index
 * to avoid the paths.mjs static-graph constraint. Returns {pass, detail}.
 *
 * @param {{configDir: string, mgrStateDir: string}} opts
 * @returns {Promise<{pass: boolean, detail: string}>}
 */
export async function defaultRunDoctorPassive({ configDir, mgrStateDir }) {
  try {
    const { gatherDoctorInput } = await import('../cli/doctor-facts.mjs');
    const { runDoctor } = await import('../analysis/doctor/index.mjs');
    const { input } = await gatherDoctorInput({
      configDir, mgrStateDir, activeProbes: false, now: Date.now(),
    });
    const report = runDoctor(input, { activeProbes: false });
    const errorCount = report.diagnostics.filter((d) => d.severity === 'error').length;
    return errorCount === 0
      ? { pass: true, detail: `doctor passive: ${report.checks.length} checks, 0 errors` }
      : { pass: false, detail: `doctor passive: ${errorCount} error(s)` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err ?? '');
    return { pass: false, detail: `doctor gather failed: ${msg}` };
  }
}
