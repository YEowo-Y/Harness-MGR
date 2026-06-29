/**
 * Tests for src/selftest/release-gate.mjs
 *
 * FULLY HERMETIC: every one of the seven seams is injected — no real node --test,
 * no real c8, no real doctor I/O, and srcDir is a dummy path the real tree is never
 * touched. Steps 3/4/5 (invariants/boundary/lint) are now injectable, so their
 * failure paths are exercised directly.
 *
 * Cases: all-pass; per-step failures (1-6) with the right exit codes & abort point;
 * step-2 variants (no-changed / below-70 / exactly-80 / unavailable / missing-from-
 * summary); boundary INFO does NOT fail; envelope shape; never-throws on junk;
 * coverage lookup rel-vs-abs; non-object coverage map (MEDIUM-1 guard); ordering.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runReleaseGate } from '../src/selftest/release-gate.mjs';

// ── fake seam factories ────────────────────────────────────────────────────────

const passTests = () => ({ pass: true, detail: 'node --test exited 0' });
const failTests = () => ({ pass: false, detail: 'node --test exited 1' });

const passCoverage = () => ({ coverageMap: {}, detail: 'ok' });
const noChangedFiles = () => [];
// The cannot-determine sentinel: the default seam returns null when git fails.
const cannotDetermineChangedFiles = () => null;
const oneChangedFile = () => ['src/selftest/release-gate.mjs'];

/**
 * Make a coverage seam that returns a map where the changed file has the given
 * line pct (branch pct defaults to 100 so only the line dimension is exercised).
 * @param {number} pct
 */
function coverageAt(pct) {
  return () => ({
    coverageMap: { '/repo/src/selftest/release-gate.mjs': { lines: pct, branches: 100 } },
    detail: 'ok',
  });
}

/**
 * Make a coverage seam with explicit line AND branch pct for the changed file.
 * @param {number} lines @param {number} branches
 */
function coverageLinesBranches(lines, branches) {
  return () => ({
    coverageMap: { '/repo/src/selftest/release-gate.mjs': { lines, branches } },
    detail: 'ok',
  });
}

const nullCoverage = () => ({ coverageMap: null, detail: 'c8 not found' });

const passInvariants = () => ({ diagnostics: [] });
const failInvariants = () => ({ diagnostics: [{ severity: 'error', code: 'inv-fail', message: 'inv error', phase: 'invariants' }] });

const passLint = () => ({ diagnostics: [] });
const failLint = () => ({ diagnostics: [{ severity: 'error', code: 'lint-fail', message: 'lint error', phase: 'lint' }] });

// boundary PASS returns a single INFO diagnostic (the M2 static-only degrade marker),
// which must NOT fail the step; boundary FAIL returns an error diagnostic.
const passBoundary = () => ({ diagnostics: [{ severity: 'info', code: 'boundary-runtime-skipped', message: 'skipped', phase: 'boundary' }] });
const failBoundary = () => ({ diagnostics: [{ severity: 'error', code: 'bound-fail', message: 'boundary error', phase: 'boundary' }] });

const passDoctor = async () => ({ pass: true, detail: 'doctor passive: 22 checks, 0 errors' });
const failDoctor = async () => ({ pass: false, detail: 'doctor passive: 1 error(s)' });

const passSchemaCanary = async () => ({ pass: true, detail: 'clean', diagnostics: [] });

/**
 * Build an opts object with ALL EIGHT seams injected with passing fakes by default.
 * srcDir is a dummy that the real tree is never touched. Override any seam per test.
 * @param {Record<string, unknown>} [overrides]
 */
function makeOpts(overrides = {}) {
  return {
    srcDir: '/fake/src',
    configDir: '/fake/.claude',
    mgrStateDir: '/fake/.mgr-state',
    repoRoot: '/fake',
    runTests: passTests,
    runCoverage: passCoverage,
    changedSrcFiles: noChangedFiles,
    runDoctorPassive: passDoctor,
    runSchemaCanary: passSchemaCanary,
    checkInvariants: passInvariants,
    checkBoundary: passBoundary,
    lintTree: passLint,
    ...overrides,
  };
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('runReleaseGate', () => {

  it('all-pass: code 0, pass true, 7 steps (incl schema-canary)', async () => {
    const r = await runReleaseGate(makeOpts());
    assert.equal(r.code, 0, `expected code 0 but got ${r.code}`);
    assert.equal(r.pass, true);
    assert.equal(r.steps.length, 7);
    for (const s of r.steps) {
      assert.equal(s.pass, true, `step ${s.step} (${s.name}) failed: ${s.detail}`);
    }
    // schema-canary step is present by name
    assert.ok(r.steps.some((s) => s.name === 'schema-canary'), 'schema-canary step present');
    assert.ok(r.steps.some((s) => s.name === 'doctor-smoke'), 'doctor-smoke step present');
  });

  it('step 1 fail: code 2, only 1 step in steps', async () => {
    const r = await runReleaseGate(makeOpts({ runTests: failTests }));
    assert.equal(r.code, 2);
    assert.equal(r.pass, false);
    assert.equal(r.steps.length, 1);
    assert.equal(r.steps[0].step, 1);
    assert.equal(r.steps[0].pass, false);
  });

  it('step 2 genuinely-empty diff ([]): pass, detail says no changed files', async () => {
    // ORACLE (c): a real empty array (git ran, nothing under src/ changed) must
    // STILL pass — the cannot-determine fix must not regress the empty-diff case.
    const r = await runReleaseGate(makeOpts({ changedSrcFiles: noChangedFiles }));
    assert.equal(r.code, 0);
    const s2 = r.steps.find((s) => s.step === 2);
    assert.ok(s2);
    assert.equal(s2.pass, true);
    assert.ok(s2.detail.includes('no changed src files'));
    // A genuinely-empty diff must NOT emit the cannot-determine diagnostic.
    assert.ok(!r.diagnostics.some((d) => d.code === 'release-gate-changed-files-unknown'),
      'empty diff must not be treated as cannot-determine');
  });

  it('step 2 cannot-determine changed files (null): code 2, distinct diagnostic, no vacuous pass', async () => {
    // ORACLE (b): the default seam returns null when git fails (no HEAD / unavailable
    // / timeout). coverageStep must FAIL — pre-fix [] passed vacuously; the null
    // sentinel routes to a distinct release-gate-changed-files-unknown error.
    const r = await runReleaseGate(makeOpts({ changedSrcFiles: cannotDetermineChangedFiles }));
    assert.equal(r.code, 2, 'cannot-determine must fail the gate (code 2), not pass vacuously');
    assert.equal(r.pass, false);
    const s2 = r.steps.find((s) => s.step === 2);
    assert.ok(s2);
    assert.equal(s2.pass, false, 'step 2 must not pass when the changed set is unknown');
    const d = r.diagnostics.find((x) => x.code === 'release-gate-changed-files-unknown');
    assert.ok(d, 'expected release-gate-changed-files-unknown diagnostic');
    assert.equal(d.severity, 'error');
    // It must be the cannot-determine code, NOT the c8-unavailable one.
    assert.ok(!r.diagnostics.some((x) => x.code === 'release-gate-coverage-unavailable'),
      'cannot-determine is distinct from coverage-unavailable');
  });

  it('step 2 below-threshold (70%): code 2, per-file diagnostic', async () => {
    const r = await runReleaseGate(makeOpts({
      changedSrcFiles: oneChangedFile,
      runCoverage: coverageAt(70),
    }));
    assert.equal(r.code, 2);
    assert.equal(r.pass, false);
    const s2 = r.steps.find((s) => s.step === 2);
    assert.ok(s2);
    assert.equal(s2.pass, false);
    const covDiag = r.diagnostics.find((d) => d.code === 'release-gate-coverage-low');
    assert.ok(covDiag, 'expected release-gate-coverage-low diagnostic');
    assert.equal(covDiag.severity, 'error');
    assert.ok(covDiag.message.includes('70.0%'));
  });

  it('step 2 exactly 80%: pass', async () => {
    const r = await runReleaseGate(makeOpts({
      changedSrcFiles: oneChangedFile,
      runCoverage: coverageAt(80),
    }));
    const s2 = r.steps.find((s) => s.step === 2);
    assert.ok(s2);
    assert.equal(s2.pass, true);
  });

  it('step 2 line 100% but branch 50%: code 2, BRANCH-coverage diagnostic (distinct from line)', async () => {
    // The headline new behavior: a file with full line coverage but weak branch
    // coverage MUST fail. Pre-fix (line-only) this passed; post-fix it fails with a
    // branch-specific diagnostic, NOT a line-coverage one.
    const r = await runReleaseGate(makeOpts({
      changedSrcFiles: oneChangedFile,
      runCoverage: coverageLinesBranches(100, 50),
    }));
    assert.equal(r.code, 2);
    assert.equal(r.pass, false);
    const s2 = r.steps.find((s) => s.step === 2);
    assert.ok(s2);
    assert.equal(s2.pass, false);
    const branchDiag = r.diagnostics.find((d) => d.code === 'release-gate-coverage-branch-low');
    assert.ok(branchDiag, 'expected release-gate-coverage-branch-low diagnostic');
    assert.equal(branchDiag.severity, 'error');
    assert.ok(branchDiag.message.includes('50.0%'));
    assert.ok(branchDiag.message.includes('branch'), 'message should distinguish branch coverage');
    // A line-coverage diagnostic must NOT fire (line is at 100%).
    assert.ok(!r.diagnostics.some((d) => d.code === 'release-gate-coverage-low'),
      'no line-coverage diagnostic when line is 100%');
  });

  it('step 2 line 100% branch 75%: pass (above the 70 branch bar)', async () => {
    const r = await runReleaseGate(makeOpts({
      changedSrcFiles: oneChangedFile,
      runCoverage: coverageLinesBranches(100, 75),
    }));
    assert.equal(r.code, 0);
    const s2 = r.steps.find((s) => s.step === 2);
    assert.ok(s2);
    assert.equal(s2.pass, true, `step 2 should pass at branch 75%: ${s2.detail}`);
    assert.ok(!r.diagnostics.some((d) => d.code === 'release-gate-coverage-branch-low'));
  });

  it('step 2 branch exactly 70%: pass (boundary, ≥70 ok)', async () => {
    const r = await runReleaseGate(makeOpts({
      changedSrcFiles: oneChangedFile,
      runCoverage: coverageLinesBranches(100, 70),
    }));
    const s2 = r.steps.find((s) => s.step === 2);
    assert.ok(s2);
    assert.equal(s2.pass, true);
  });

  it('step 2 line 70% (branch ok): still fails on LINE coverage (existing behavior intact)', async () => {
    const r = await runReleaseGate(makeOpts({
      changedSrcFiles: oneChangedFile,
      runCoverage: coverageLinesBranches(70, 100),
    }));
    assert.equal(r.code, 2);
    const lineDiag = r.diagnostics.find((d) => d.code === 'release-gate-coverage-low');
    assert.ok(lineDiag, 'expected line-coverage diagnostic');
    assert.ok(lineDiag.message.includes('line coverage'));
    // Branch is fine → no branch diagnostic.
    assert.ok(!r.diagnostics.some((d) => d.code === 'release-gate-coverage-branch-low'));
  });

  it('step 2 both line 50% and branch 40% low: file counted once, both diagnostics present', async () => {
    const r = await runReleaseGate(makeOpts({
      changedSrcFiles: oneChangedFile,
      runCoverage: coverageLinesBranches(50, 40),
    }));
    assert.equal(r.code, 2);
    const s2 = r.steps.find((s) => s.step === 2);
    assert.ok(s2);
    assert.equal(s2.pass, false);
    assert.ok(r.diagnostics.some((d) => d.code === 'release-gate-coverage-low'), 'line diag present');
    assert.ok(r.diagnostics.some((d) => d.code === 'release-gate-coverage-branch-low'), 'branch diag present');
    // Detail reports a single failing file (not double-counted across dimensions).
    assert.ok(s2.detail.includes('1 file(s)'), `detail should count 1 file: ${s2.detail}`);
  });

  it('step 2 coverage unavailable: code 2, coverage-unavailable diagnostic', async () => {
    const r = await runReleaseGate(makeOpts({
      changedSrcFiles: oneChangedFile,
      runCoverage: nullCoverage,
    }));
    assert.equal(r.code, 2);
    const s2 = r.steps.find((s) => s.step === 2);
    assert.ok(s2);
    assert.equal(s2.pass, false);
    const d = r.diagnostics.find((d) => d.code === 'release-gate-coverage-unavailable');
    assert.ok(d, 'expected release-gate-coverage-unavailable diagnostic');
  });

  it('step 2 changed file missing from summary: code 2, coverage-low diagnostic', async () => {
    const r = await runReleaseGate(makeOpts({
      changedSrcFiles: () => ['src/some/new-file.mjs'],
      // summary has no entry for that file
      runCoverage: () => ({ coverageMap: { '/other/file.mjs': { lines: 95, branches: 95 } }, detail: 'ok' }),
    }));
    assert.equal(r.code, 2);
    const d = r.diagnostics.find((d) => d.code === 'release-gate-coverage-low');
    assert.ok(d);
    assert.ok(d.message.includes('not in coverage summary'));
  });

  it('step 2 non-object coverage map (42): degrades gracefully, no throw (MEDIUM-1 guard)', async () => {
    // runCoverage returns a non-null but non-object coverageMap. coverageStep only
    // short-circuits on `=== null`, so it proceeds into lookupCoverage(42, …) — the
    // MEDIUM-1 guard must return null there rather than throw inside Object.keys.
    const r = await runReleaseGate(makeOpts({
      changedSrcFiles: oneChangedFile,
      runCoverage: () => ({ coverageMap: 42, detail: 'x' }),
    }));
    assert.equal(r.code, 2);
    const s2 = r.steps.find((s) => s.step === 2);
    assert.ok(s2);
    assert.equal(s2.pass, false, 'step 2 should fail (file treated as not covered)');
    // The file is "not in coverage summary" → coverage-low, NOT an internal throw.
    const d = r.diagnostics.find((d) => d.code === 'release-gate-coverage-low');
    assert.ok(d, 'expected coverage-low diagnostic, not a TypeError');
    // No internal-error diagnostic leaked.
    assert.ok(!r.diagnostics.some((x) => x.code === 'release-gate-internal'));
  });

  it('step 3 invariants error: code 2, abort after 3 steps, inv diag present', async () => {
    const r = await runReleaseGate(makeOpts({ checkInvariants: failInvariants }));
    assert.equal(r.code, 2);
    assert.equal(r.pass, false);
    assert.equal(r.steps.length, 3, 'should stop at step 3');
    const s3 = r.steps.find((s) => s.step === 3);
    assert.ok(s3);
    assert.equal(s3.name, 'invariants');
    assert.equal(s3.pass, false);
    assert.ok(r.diagnostics.some((d) => d.code === 'inv-fail'), 'invariants diag should propagate');
  });

  it('step 4 boundary error: code 2, abort after 4 steps, boundary diag present', async () => {
    const r = await runReleaseGate(makeOpts({ checkBoundary: failBoundary }));
    assert.equal(r.code, 2);
    assert.equal(r.pass, false);
    assert.equal(r.steps.length, 4, 'should stop at step 4');
    const s4 = r.steps.find((s) => s.step === 4);
    assert.ok(s4);
    assert.equal(s4.name, 'boundary');
    assert.equal(s4.pass, false);
    assert.ok(r.diagnostics.some((d) => d.code === 'bound-fail'));
  });

  it('step 4 boundary INFO does NOT fail the gate', async () => {
    // passBoundary returns a single boundary-runtime-skipped INFO; step 4 must pass.
    const r = await runReleaseGate(makeOpts({ checkBoundary: passBoundary }));
    const s4 = r.steps.find((s) => s.step === 4);
    assert.ok(s4);
    assert.equal(s4.name, 'boundary');
    assert.equal(s4.pass, true);
    assert.equal(r.code, 0);
    // The INFO diagnostic IS surfaced (it's still pushed) but does not fail the step.
    assert.ok(r.diagnostics.some((d) => d.code === 'boundary-runtime-skipped'));
  });

  it('step 5 lint error: code 2, abort after 5 steps, lint diag present', async () => {
    const r = await runReleaseGate(makeOpts({ lintTree: failLint }));
    assert.equal(r.code, 2);
    assert.equal(r.pass, false);
    assert.equal(r.steps.length, 5, 'should stop at step 5');
    const s5 = r.steps.find((s) => s.step === 5);
    assert.ok(s5);
    assert.equal(s5.name, 'lint');
    assert.equal(s5.pass, false);
    assert.ok(r.diagnostics.some((d) => d.code === 'lint-fail'));
  });

  it('step 6 doctor error: code 1 (not 2)', async () => {
    const r = await runReleaseGate(makeOpts({ runDoctorPassive: failDoctor }));
    assert.equal(r.code, 1);
    assert.equal(r.pass, false);
    assert.equal(r.steps.length, 7); // steps 1-5 + schema-canary + doctor-smoke
    const s6 = r.steps.find((s) => s.name === 'doctor-smoke');
    assert.ok(s6);
    assert.equal(s6.pass, false);
    assert.equal(s6.name, 'doctor-smoke');
  });

  it('envelope shape: GateResult fields all present and typed', async () => {
    // The CLI wraps this in {version:1, command, result, diagnostics}; the gate
    // returns the INNER GateResult. Here we check that shape directly.
    const r = await runReleaseGate(makeOpts());
    assert.ok(typeof r.pass === 'boolean');
    assert.ok(Array.isArray(r.steps));
    assert.ok(Array.isArray(r.diagnostics));
    assert.ok(typeof r.code === 'number');
    for (const s of r.steps) {
      assert.ok(typeof s.step === 'number');
      assert.ok(typeof s.name === 'string');
      assert.ok(typeof s.pass === 'boolean');
      assert.ok(typeof s.detail === 'string');
    }
  });

  it('never-throws on null opts', async () => {
    const r = await runReleaseGate(null);
    assert.ok(typeof r === 'object');
    assert.ok(typeof r.pass === 'boolean');
    assert.ok(Array.isArray(r.steps));
    assert.ok(typeof r.code === 'number');
  });

  it('never-throws on empty opts {}', async () => {
    // With empty opts the seams default to the REAL spawners, but srcDir='' makes
    // lint/invariants/boundary return empty results; runTests with repoRoot='' fails
    // → step 1 fails and the run aborts before the coverage step. What matters here:
    // it never throws and returns a shaped result.
    const r = await runReleaseGate({});
    assert.ok(typeof r === 'object');
    assert.ok(typeof r.code === 'number');
  });

  it('coverage lookup: relative path matched against absolute summary key', async () => {
    // The summary key is ABSOLUTE; the changed file is RELATIVE (git output format).
    // lookupCoverage must match them via suffix.
    const r = await runReleaseGate(makeOpts({
      changedSrcFiles: () => ['src/cli/selftest-command.mjs'],
      runCoverage: () => ({
        coverageMap: {
          'C:/Dev/Projects/harness-mgr/src/cli/selftest-command.mjs': { lines: 90, branches: 90 },
          '/home/user/proj/src/cli/selftest-command.mjs': { lines: 90, branches: 90 },
        },
        detail: 'ok',
      }),
    }));
    const s2 = r.steps.find((s) => s.step === 2);
    assert.ok(s2, 'step 2 should exist');
    assert.equal(s2.pass, true, `step 2 should pass but got: ${s2.detail}`);
  });

  it('step ordering by name: catalog-tests,coverage,invariants,boundary,lint,schema-canary,doctor-smoke', async () => {
    const r = await runReleaseGate(makeOpts());
    const names = r.steps.map((s) => s.name);
    assert.deepEqual(names, [
      'catalog-tests', 'coverage', 'invariants', 'boundary', 'lint', 'schema-canary', 'doctor-smoke',
    ]);
  });

  it('step 6: fixture doctor pass:true → gate code 0 (seam wires fixture result)', async () => {
    // The seam returns pass:true (as if the fixture run passed). Gate code must be 0.
    const r = await runReleaseGate(makeOpts({
      runDoctorPassive: async () => ({ pass: true, detail: 'doctor passive (fixture): 29 checks, 0 error(s)' }),
    }));
    assert.equal(r.code, 0);
    assert.equal(r.pass, true);
    const s6 = r.steps.find((s) => s.name === 'doctor-smoke');
    assert.ok(s6);
    assert.equal(s6.pass, true);
    assert.ok(s6.detail.includes('fixture'), `detail should mention fixture: ${s6.detail}`);
  });

  it('step 6: fixture doctor pass:false → gate code 1 (fixture result gates, not live)', async () => {
    // Fixture run fails; this must produce code 1 regardless of any live state.
    const r = await runReleaseGate(makeOpts({
      runDoctorPassive: async () => ({ pass: false, detail: 'doctor passive (fixture): 2 error(s)' }),
    }));
    assert.equal(r.code, 1);
    assert.equal(r.pass, false);
    const s6 = r.steps.find((s) => s.name === 'doctor-smoke');
    assert.ok(s6);
    assert.equal(s6.pass, false);
  });
});
