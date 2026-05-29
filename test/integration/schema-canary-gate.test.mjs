/**
 * Integration tests: schema-canary gate wiring.
 *
 * Proves end-to-end that:
 *   - drift from injected runSchemaCanary => GateResult.pass unchanged, code unchanged,
 *     steps[] contains {name:'schema-canary',pass:true}, diagnostics contains the WARN.
 *   - A failing lint step => pass:false, the canary WARN is not the cause.
 *   - defaultRunSchemaCanary over test/fixtures/minimal => {pass:true} and never throws.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runReleaseGate } from '../../src/selftest/release-gate.mjs';
import { defaultRunSchemaCanary } from '../../src/selftest/release-gate-seams.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const minimalFixture = resolve(here, '..', 'fixtures', 'minimal');

// ── fake seam factories ────────────────────────────────────────────────────────

const passTests = () => ({ pass: true, detail: 'node --test exited 0' });
const passCoverage = () => ({ coverageMap: {}, detail: 'ok' });
const noChangedFiles = () => [];
const passInvariants = () => ({ diagnostics: [] });
const passBoundary = () => ({ diagnostics: [] });
const passLint = () => ({ diagnostics: [] });
const failLint = () => ({ diagnostics: [{ severity: 'error', code: 'lint-fail', message: 'lint error', phase: 'lint' }] });
const passDoctor = async () => ({ pass: true, detail: 'doctor passive: 22 checks, 0 errors' });

/** Injected runSchemaCanary that reports drift. */
const driftingCanary = async () => ({
  pass: true,
  detail: '2 schema change(s) (WARN, non-blocking)',
  diagnostics: [{ severity: 'warn', code: 'schema-drift-detected', message: 'Claude Code schema surface changed since baseline: 2 change(s)', phase: 'schema-canary', fix: 'run --update-baseline' }],
});

/** Injected runSchemaCanary that reports clean. */
const cleanCanary = async () => ({ pass: true, detail: 'clean', diagnostics: [] });

function makeOpts(overrides = {}) {
  return {
    srcDir: '/fake/src',
    configDir: minimalFixture,
    mgrStateDir: '/fake/.mgr-state',
    repoRoot: '/fake',
    runTests: passTests,
    runCoverage: passCoverage,
    changedSrcFiles: noChangedFiles,
    runDoctorPassive: passDoctor,
    runSchemaCanary: cleanCanary,
    checkInvariants: passInvariants,
    checkBoundary: passBoundary,
    lintTree: passLint,
    ...overrides,
  };
}

// ── tests ─────────────────────────────────────────────────────────────────────

test('schema-canary drift: GateResult.pass still true, code still 0', async () => {
  const r = await runReleaseGate(makeOpts({ runSchemaCanary: driftingCanary }));
  assert.equal(r.pass, true, 'drift must not flip pass');
  assert.equal(r.code, 0, 'drift must not change exit code');
});

test('schema-canary drift: steps[] contains schema-canary with pass:true', async () => {
  const r = await runReleaseGate(makeOpts({ runSchemaCanary: driftingCanary }));
  const canaryStep = r.steps.find((s) => s.name === 'schema-canary');
  assert.ok(canaryStep, 'schema-canary step present in steps[]');
  assert.equal(canaryStep.pass, true, 'schema-canary step always pass:true even with drift');
  assert.ok(canaryStep.detail.includes('schema change'), `detail mentions changes: ${canaryStep.detail}`);
});

test('schema-canary drift: WARN diagnostic propagated to gate diagnostics', async () => {
  const r = await runReleaseGate(makeOpts({ runSchemaCanary: driftingCanary }));
  const warnDiag = r.diagnostics.find((d) => d.code === 'schema-drift-detected');
  assert.ok(warnDiag, 'schema-drift-detected diagnostic present');
  assert.equal(warnDiag.severity, 'warn');
});

test('failing lint step: pass:false; canary WARN present but not the cause of failure', async () => {
  const r = await runReleaseGate(makeOpts({ lintTree: failLint, runSchemaCanary: driftingCanary }));
  // Lint fails before schema-canary runs (abort-on-first-failure).
  assert.equal(r.pass, false);
  assert.equal(r.code, 2, 'lint failure → code 2, not 1 or 0');
  // The lint step should be the last step in steps[] (gate aborts at lint).
  const lintStep = r.steps.find((s) => s.name === 'lint');
  assert.ok(lintStep, 'lint step present');
  assert.equal(lintStep.pass, false);
  // schema-canary must NOT appear (aborted before it ran).
  assert.ok(!r.steps.some((s) => s.name === 'schema-canary'), 'schema-canary not in steps when aborted early');
});

test('clean canary: no drift diagnostic in gate diagnostics', async () => {
  const r = await runReleaseGate(makeOpts({ runSchemaCanary: cleanCanary }));
  assert.equal(r.pass, true);
  assert.ok(!r.diagnostics.some((d) => d.code === 'schema-drift-detected'), 'no drift diag when clean');
});

test('doctor-smoke fails: canary WARN in diagnostics, pass:false from doctor (not canary)', async () => {
  const r = await runReleaseGate(makeOpts({
    runSchemaCanary: driftingCanary,
    runDoctorPassive: async () => ({ pass: false, detail: 'doctor passive: 1 error(s)' }),
  }));
  assert.equal(r.pass, false);
  assert.equal(r.code, 1, 'doctor failure → code 1');
  assert.ok(r.diagnostics.some((d) => d.code === 'schema-drift-detected'), 'canary WARN still in diagnostics');
});

// ── defaultRunSchemaCanary over minimal fixture ───────────────────────────────

test('defaultRunSchemaCanary over minimal fixture: {pass:true}, never throws', async () => {
  let result;
  assert.doesNotThrow(() => {
    result = defaultRunSchemaCanary({ configDir: minimalFixture });
  });
  result = await result;
  assert.ok(result && typeof result === 'object', 'returns an object');
  assert.equal(result.pass, true, 'always pass:true');
  assert.equal(typeof result.detail, 'string', 'detail is a string');
  assert.ok(Array.isArray(result.diagnostics), 'diagnostics is an array');
});

test('defaultRunSchemaCanary with no baseline: pass:true, no throw', async () => {
  // The minimal fixture will not have a matching baseline fingerprint (it has very
  // different dims from the committed baseline), but it should still return pass:true.
  const r = await defaultRunSchemaCanary({ configDir: minimalFixture });
  assert.equal(r.pass, true);
  // Either 'no baseline' or a drift/clean result — all are pass:true.
  assert.ok(['clean', 'no baseline', 'no-baseline'].some((s) => r.detail.includes(s))
    || r.detail.includes('schema change')
    || typeof r.detail === 'string',
    `detail should be a string: ${r.detail}`);
});

test('defaultRunSchemaCanary with bad configDir: pass:true, never throws', async () => {
  const r = await defaultRunSchemaCanary({ configDir: '' });
  assert.equal(r.pass, true, 'always pass:true even on bad configDir');
  assert.equal(typeof r.detail, 'string');
});
