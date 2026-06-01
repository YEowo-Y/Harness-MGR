/**
 * Release-gate orchestrator (P3 gate infrastructure).
 *
 * Runs 6 sequential steps; the first failure records the step, sets the exit code,
 * and stops (later steps do NOT run).
 *
 * ENVELOPE RECONCILIATION:
 *   The plan specifies a standalone gate envelope {version:1, gate:'release', pass, steps}.
 *   Per plan line 149 (multi-consumer contract) the CLI always wraps in
 *   {version:1, command, result, diagnostics}. Resolution: this module returns the
 *   INNER payload {gate:'release', pass, steps} as `result`; the CLI handler wraps it.
 *   So `selftest --release-gate --format json` emits:
 *     {version:1, command:'selftest', result:{gate:'release', pass, steps}, diagnostics:[...]}
 *
 * REENTRANCY GUARD:
 *   runReleaseGate accepts injectable seams (runTests, runCoverage, changedSrcFiles,
 *   runDoctorPassive). Unit tests inject fakes and NEVER spawn node --test from
 *   within node --test. Only the real CLI path uses the default spawning seams.
 *
 * Steps:
 *   1 catalog-tests  node --test exits 0.                       FAIL → code 2.
 *   2 coverage       changed src/**.mjs files ≥80% line cov.    FAIL → code 2.
 *   3 invariants     checkInvariants: no error diagnostics.      FAIL → code 2.
 *   4 boundary       checkBoundary: no error diagnostics.        FAIL → code 2.
 *   5 lint           lintTree: no error diagnostics.             FAIL → code 2.
 *   schema-canary    schema surface fingerprint check.           ALWAYS pass:true (WARN only).
 *   6 doctor-smoke   passive doctor: 0 error diagnostics.        FAIL → code 1.
 *
 * Exit codes: 0=all pass, 2=step 1-5 failed, 1=step 6 failed.
 * The schema-canary step is non-failing: drift is a WARN, never changes pass/code.
 * Zero npm dependencies. Never throws.
 */

import { checkInvariants } from './invariants.mjs';
import { checkBoundary } from './boundary.mjs';
import { lintTree } from './lint.mjs';
import {
  defaultRunTests,
  defaultRunCoverage,
  defaultChangedSrcFiles,
  defaultRunDoctorPassive,
  defaultRunSchemaCanary,
} from './release-gate-seams.mjs';

/** @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic */

/**
 * Coverage thresholds for a changed src file. A file fails the coverage step when
 * its line% is below LINE_THRESHOLD OR its branch% is below BRANCH_THRESHOLD.
 * BRANCH_THRESHOLD is deliberately lenient (70): this codebase is never-throws +
 * defensive, so a few unreachable guard arms should not block, while egregious
 * branch under-testing is still caught. LINE_THRESHOLD stays the original 80.
 */
const LINE_THRESHOLD = 80;
const BRANCH_THRESHOLD = 70;

/**
 * @typedef {Object} GateStep
 * @property {number} step
 * @property {string} name
 * @property {boolean} pass
 * @property {string} detail
 */

/**
 * @typedef {Object} GateResult
 * @property {boolean} pass
 * @property {GateStep[]} steps
 * @property {Diagnostic[]} diagnostics
 * @property {number} code   0=all pass, 2=step1-5 fail, 1=step6 fail
 */

/**
 * @typedef {Object} ReleaseGateOpts
 * @property {string} srcDir
 * @property {string} configDir
 * @property {string} mgrStateDir
 * @property {string} repoRoot
 * @property {string} [base]
 * @property {Function} [assertWritable]
 * @property {object} [roots]
 * @property {Function} [runTests]
 * @property {Function} [runCoverage]
 * @property {Function} [changedSrcFiles]
 * @property {Function} [runDoctorPassive]
 * @property {Function} [runSchemaCanary]   injectable seam (default: defaultRunSchemaCanary); non-failing
 * @property {Function} [checkInvariants]   injectable seam (default: the real import); enables hermetic step-3 failure tests
 * @property {Function} [checkBoundary]     injectable seam (default: the real import); enables hermetic step-4 failure tests
 * @property {Function} [lintTree]          injectable seam (default: the real import); enables hermetic step-5 failure tests
 */

/**
 * Run the 6-step release gate. Steps run in order; first failure stops the run.
 * Accepts injectable seams so unit tests never spawn real node --test.
 * Never throws.
 *
 * @param {ReleaseGateOpts} opts
 * @returns {Promise<GateResult>}
 */
export async function runReleaseGate(opts) {
  try {
    return await runGate(opts || {});
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err ?? '');
    return { pass: false, steps: [], diagnostics: [
      { severity: 'error', code: 'release-gate-internal', message: msg, phase: 'release-gate' },
    ], code: 2 };
  }
}

// ── inner orchestration ───────────────────────────────────────────────────────

/**
 * @param {ReleaseGateOpts} opts
 * @returns {Promise<GateResult>}
 */
async function runGate(opts) {
  const {
    srcDir = '', configDir = '', mgrStateDir = '', repoRoot = '', base,
    assertWritable, roots,
    runTests = defaultRunTests,
    runCoverage = defaultRunCoverage,
    changedSrcFiles = defaultChangedSrcFiles,
    runDoctorPassive = defaultRunDoctorPassive,
    runSchemaCanary = defaultRunSchemaCanary,
    checkInvariants: invariantsFn = checkInvariants,
    checkBoundary: boundaryFn = checkBoundary,
    lintTree: lintFn = lintTree,
  } = opts;

  /** @type {GateStep[]} */
  const steps = [];
  /** @type {Diagnostic[]} */
  const diagnostics = [];

  const step1 = await safeStep(1, 'catalog-tests', () => runTests({ repoRoot }));
  steps.push(step1);
  if (!step1.pass) return { pass: false, steps, diagnostics, code: 2 };

  const step2 = await safeStep(2, 'coverage', () =>
    coverageStep({ repoRoot, base, changedSrcFiles, runCoverage, diagnostics }));
  steps.push(step2);
  if (!step2.pass) return { pass: false, steps, diagnostics, code: 2 };

  const step3 = await safeStep(3, 'invariants', () => {
    const r = invariantsFn(srcDir);
    const errs = r.diagnostics.filter((d) => d.severity === 'error');
    for (const d of r.diagnostics) diagnostics.push(d);
    return { pass: errs.length === 0, detail: errs.length === 0 ? 'ok' : `${errs.length} error(s)` };
  });
  steps.push(step3);
  if (!step3.pass) return { pass: false, steps, diagnostics, code: 2 };

  const step4 = await safeStep(4, 'boundary', () => {
    const r = boundaryFn({ srcDir, assertWritable, roots });
    const errs = r.diagnostics.filter((d) => d.severity === 'error');
    for (const d of r.diagnostics) diagnostics.push(d);
    return { pass: errs.length === 0, detail: errs.length === 0 ? 'ok' : `${errs.length} error(s)` };
  });
  steps.push(step4);
  if (!step4.pass) return { pass: false, steps, diagnostics, code: 2 };

  const step5 = await safeStep(5, 'lint', () => {
    const r = lintFn(srcDir);
    const errs = r.diagnostics.filter((d) => d.severity === 'error');
    for (const d of r.diagnostics) diagnostics.push(d);
    return { pass: errs.length === 0, detail: errs.length === 0 ? 'ok' : `${errs.length} error(s)` };
  });
  steps.push(step5);
  if (!step5.pass) return { pass: false, steps, diagnostics, code: 2 };

  // Schema-canary: ALWAYS pass:true — drift is a WARN, never a gate failure.
  const stepCanary = await safeStep(0, 'schema-canary', async () => {
    const r = await Promise.resolve(runSchemaCanary({ configDir }));
    // Push any drift diagnostics into the shared array so they appear in output.
    if (r && Array.isArray(r.diagnostics)) {
      for (const d of r.diagnostics) diagnostics.push(d);
    }
    const detail = (r && typeof r.detail === 'string') ? r.detail : 'ok';
    return { pass: true, detail };
  });
  steps.push(stepCanary);
  // No abort: schema-canary never fails the gate.

  const step6 = await safeStep(6, 'doctor-smoke', () => runDoctorPassive({ configDir, mgrStateDir }));
  steps.push(step6);
  if (!step6.pass) return { pass: false, steps, diagnostics, code: 1 };

  return { pass: true, steps, diagnostics, code: 0 };
}

/**
 * Run the coverage step: collect changed files, run c8, find under-threshold files.
 * A file fails when line% < LINE_THRESHOLD OR branch% < BRANCH_THRESHOLD.
 * Pushes per-file Diagnostics (distinct line- vs branch-coverage codes) into the
 * outer diagnostics array.
 *
 * @param {{ repoRoot: string, base?: string, changedSrcFiles: Function, runCoverage: Function, diagnostics: Diagnostic[] }} opts
 * @returns {Promise<{pass: boolean, detail: string}>}
 */
async function coverageStep({ repoRoot, base, changedSrcFiles, runCoverage, diagnostics }) {
  const changed = changedSrcFiles({ repoRoot, base });
  if (!Array.isArray(changed) || changed.length === 0) {
    return { pass: true, detail: 'no changed src files to gate' };
  }
  const { coverageMap, detail: covDetail } = await Promise.resolve(runCoverage({ repoRoot }));
  if (coverageMap === null) {
    diagnostics.push({ severity: 'error', code: 'release-gate-coverage-unavailable',
      message: covDetail, phase: 'release-gate' });
    return { pass: false, detail: covDetail };
  }
  const low = new Set();
  for (const relPath of changed) {
    if (evaluateCoverage(lookupCoverage(coverageMap, relPath), relPath, diagnostics)) {
      low.add(relPath);
    }
  }
  return low.size === 0
    ? { pass: true, detail: `${changed.length} changed file(s) meet line ≥${LINE_THRESHOLD}% / branch ≥${BRANCH_THRESHOLD}%` }
    : { pass: false, detail: `${low.size} file(s) below line ${LINE_THRESHOLD}% or branch ${BRANCH_THRESHOLD}% coverage` };
}

/**
 * Judge one changed file's coverage entry against both thresholds, pushing a
 * line-coverage AND/OR branch-coverage Diagnostic (distinct codes) as needed.
 * A missing entry (not in summary) is treated as a line failure.
 *
 * @param {{lines:number, branches:number}|null} entry
 * @param {string} relPath
 * @param {Diagnostic[]} diagnostics
 * @returns {boolean} true when the file is below at least one threshold
 */
function evaluateCoverage(entry, relPath, diagnostics) {
  if (entry === null) {
    diagnostics.push({ severity: 'error', code: 'release-gate-coverage-low',
      message: `${relPath}: not in coverage summary (treating as 0%)`,
      phase: 'release-gate', path: relPath });
    return true;
  }
  let below = false;
  if (entry.lines < LINE_THRESHOLD) {
    diagnostics.push({ severity: 'error', code: 'release-gate-coverage-low',
      message: `${relPath}: line coverage ${entry.lines.toFixed(1)}% < ${LINE_THRESHOLD}%`,
      phase: 'release-gate', path: relPath });
    below = true;
  }
  if (entry.branches < BRANCH_THRESHOLD) {
    diagnostics.push({ severity: 'error', code: 'release-gate-coverage-branch-low',
      message: `${relPath}: branch coverage ${entry.branches.toFixed(1)}% < ${BRANCH_THRESHOLD}%`,
      phase: 'release-gate', path: relPath });
    below = true;
  }
  return below;
}

/**
 * Run one step function, catching any unexpected throw.
 * @param {number} step @param {string} name
 * @param {() => ({pass:boolean,detail:string}|Promise<{pass:boolean,detail:string}>)} fn
 * @returns {Promise<GateStep>}
 */
async function safeStep(step, name, fn) {
  try {
    const r = await fn();
    const pass = typeof r === 'object' && r !== null && r.pass === true;
    const detail = r && typeof r.detail === 'string' ? r.detail : '';
    return { step, name, pass, detail };
  } catch (err) {
    return { step, name, pass: false, detail: err instanceof Error ? err.message : String(err ?? '') };
  }
}

/**
 * Find the coverage entry ({lines, branches}) for a relative path in the map.
 * c8 summary keys are ABSOLUTE; git diff output is relative to repo root.
 * Match by checking if the absolute key ends with '/' + normalised relPath.
 *
 * @param {Record<string, {lines:number, branches:number}>} coverageMap
 * @param {string} relPath
 * @returns {{lines:number, branches:number}|null}
 */
function lookupCoverage(coverageMap, relPath) {
  if (coverageMap === null || typeof coverageMap !== 'object') return null;
  if (typeof relPath !== 'string') return null;
  const norm = relPath.replace(/\\/g, '/');
  for (const key of Object.keys(coverageMap)) {
    const kn = key.replace(/\\/g, '/');
    if (kn.endsWith('/' + norm) || kn === norm) {
      const entry = coverageMap[key];
      return entry && typeof entry === 'object' ? entry : null;
    }
  }
  return null;
}
