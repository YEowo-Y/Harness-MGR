/**
 * Integration test: doctor --passive over test/fixtures/real-snapshot/ yields
 * 0 ERROR-severity diagnostics and is ENV-INDEPENDENT (the cwd thread makes
 * relative hook paths resolve regardless of CLAUDE_PROJECT_DIR).
 *
 * This is the acceptance oracle for the hermetic fixture tree.
 * It exercises the REAL gatherDoctorInput + runDoctor over the synthetic tree
 * (no mocks, no fakes) and pins the cwd-thread fix that removed the live-config
 * fragility from release-gate step 6.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gatherDoctorInput } from '../../src/cli/doctor-facts.mjs';
import { runDoctor } from '../../src/analysis/doctor/index.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = resolve(here, '..', 'fixtures', 'real-snapshot');
const fixtureMgrState = join(fixtureDir, '.mgr-state');

/**
 * Run gatherDoctorInput + runDoctor over the fixture with the given env setup.
 * @param {() => void} setup   called before gather (e.g. mutate env)
 * @param {() => void} teardown called in finally
 */
async function gatherFixture(setup, teardown) {
  setup();
  try {
    const { input } = await gatherDoctorInput({
      configDir: fixtureDir,
      mgrStateDir: fixtureMgrState,
      activeProbes: false,
      now: Date.now(),
      cwd: fixtureDir,
    });
    const report = runDoctor(input, { activeProbes: false });
    return { input, report };
  } finally {
    teardown();
  }
}

test('doctor-fixture-clean: 0 error-severity diagnostics over the synthetic tree', async () => {
  const { report } = await gatherFixture(() => {}, () => {});
  const errors = report.diagnostics.filter((d) => d.severity === 'error');
  assert.equal(
    errors.length,
    0,
    `Expected 0 errors; got ${errors.length}: ${errors.map((d) => d.code + ': ' + d.message).join(', ')}`,
  );
});

test('doctor-fixture-clean: all 27 checks registered', async () => {
  const { report } = await gatherFixture(() => {}, () => {});
  assert.equal(report.checks.length, 27, `Expected 27 checks, got ${report.checks.length}`);
});

test('doctor-fixture-clean: CLAUDE_PROJECT_DIR unset → 0 errors (cwd-thread is env-independent)', async () => {
  const saved = process.env.CLAUDE_PROJECT_DIR;
  const { report } = await gatherFixture(
    () => { delete process.env.CLAUDE_PROJECT_DIR; },
    () => { if (saved !== undefined) process.env.CLAUDE_PROJECT_DIR = saved; },
  );
  const errors = report.diagnostics.filter((d) => d.severity === 'error');
  assert.equal(
    errors.length,
    0,
    `UNSET env: ${errors.map((d) => d.code + ': ' + d.message).join(', ')}`,
  );
});

test('doctor-fixture-clean: CLAUDE_PROJECT_DIR set to bogus path → 0 errors (cwd-thread is env-independent)', async () => {
  const saved = process.env.CLAUDE_PROJECT_DIR;
  const { report } = await gatherFixture(
    () => { process.env.CLAUDE_PROJECT_DIR = '/does/not/exist/synthetic-bogus'; },
    () => {
      if (saved === undefined) delete process.env.CLAUDE_PROJECT_DIR;
      else process.env.CLAUDE_PROJECT_DIR = saved;
    },
  );
  const errors = report.diagnostics.filter((d) => d.severity === 'error');
  assert.equal(
    errors.length,
    0,
    `SET-BOGUS env: ${errors.map((d) => d.code + ': ' + d.message).join(', ')}`,
  );
});

test('doctor-fixture-clean: all hookFacts are found or indeterminate (none missing)', async () => {
  const { input } = await gatherFixture(() => {}, () => {});
  const facts = Array.isArray(input.hookFacts) ? input.hookFacts : [];
  const missing = facts.filter((f) => f.status === 'missing');
  assert.equal(
    missing.length,
    0,
    `Expected 0 missing hook facts; got: ${missing.map((f) => f.target).join(', ')}`,
  );
});
