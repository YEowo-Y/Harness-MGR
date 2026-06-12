/**
 * Hermetic unit tests for canaryDispatch (src/cli/selftest-command.mjs).
 *
 * All five branches driven via injectable seams — no real ~/.claude, no real
 * baseline write. Uses a tmp file for the --update-baseline write test.
 *
 *   1. clean    : gatherSchemaFn returns facts whose fingerprint matches a
 *                 pre-written tmp baseline → status 'clean', changes:[]
 *   2. drifted  : mismatched facts/baseline → status 'drifted' + WARN diag
 *                 + code 0 (drift is advisory, never a gate failure)
 *   3. no-baseline: nonexistent ctx.baselinePath → status 'no-baseline', INFO
 *   4. update-baseline: --update-baseline writes a new tmp baseline and
 *                 returns status 'baseline-updated'
 *   5. dispatch-failed catch: gatherSchemaFn that throws → code 0,
 *                 'schema-canary-dispatch-failed' error diagnostic
 *
 * No production code changes required — the feature logic is correct; only
 * test coverage was missing.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { canaryDispatch } from '../src/cli/selftest-command.mjs';
import { computeFingerprint } from '../src/selftest/schema-canary.mjs';
import { stableStringify } from '../src/output/json.mjs';

// ── helpers ───────────────────────────────────────────────────────────────────

/** A minimal set of schema facts that produce a valid fingerprint. */
const BASE_FACTS = {
  pluginSchemaVersion: 2,
  settingsKeys: ['hooks', 'model', 'permissions'],
  topDirs: ['agents', 'commands', 'skills'],
  hookEvents: ['PostToolUse', 'PreToolUse'],
  mcpServerCount: 3,
  mcpTransports: ['http', 'stdio'],
  // Structural (non-ephemeral) appKeys — the denylist in schema-canary.mjs filters
  // CC-internal keys (e.g. 'autoUpdates') out of the appKeys dimension.
  appKeys: ['oauthAccount', 'userID'],
};

/** A different set of facts guaranteed to produce a different fingerprint. */
const ALT_FACTS = {
  ...BASE_FACTS,
  settingsKeys: ['hooks', 'model', 'permissions', 'extraKey'],
};

/**
 * Write a baseline JSON file for the given facts and return the path.
 * @param {string} dir   directory to write into
 * @param {string} name  filename
 * @param {object} facts
 */
function writeBaseline(dir, name, facts) {
  const { fingerprint, dimensions } = computeFingerprint(facts);
  const baseline = {
    schemaCanaryVersion: 1,
    generatedAt: '2026-01-01T00:00:00.000Z',
    fingerprint,
    dimensions,
  };
  const p = join(dir, name);
  writeFileSync(p, stableStringify(baseline, { indent: 2 }), 'utf8');
  return p;
}

// ── test state ────────────────────────────────────────────────────────────────

let tmpDir;
/** Paths written during tests (cleaned up in after()). */
const toCleanup = [];

before(() => {
  tmpDir = join(tmpdir(), `mgr-canary-test-${process.pid}`);
  mkdirSync(tmpDir, { recursive: true });
});

after(() => {
  for (const p of toCleanup) {
    try { unlinkSync(p); } catch { /* already gone */ }
  }
});

// ── tests ─────────────────────────────────────────────────────────────────────

describe('canaryDispatch', () => {

  it('1. clean: fingerprint matches baseline → status clean, no changes', async () => {
    const baselinePath = writeBaseline(tmpDir, 'baseline-clean.json', BASE_FACTS);
    toCleanup.push(baselinePath);

    const gatherSchemaFn = () => ({ facts: BASE_FACTS, diagnostics: [] });
    const out = await canaryDispatch({ configDir: '', args: {}, baselinePath, gatherSchemaFn });

    assert.equal(out.code, 0, 'code must always be 0');
    assert.equal(out.result.canary, 'schema');
    assert.equal(out.result.status, 'clean', `expected clean but got ${out.result.status}`);
    assert.deepEqual(out.result.changes, []);
    // No error or warn diagnostics for a clean canary.
    const noisy = out.diagnostics.filter((d) => d.severity === 'error' || d.severity === 'warn');
    assert.deepEqual(noisy, [], 'clean canary must produce no error/warn diagnostics');
  });

  it('2. drifted: mismatched facts/baseline → status drifted, WARN, code 0', async () => {
    const baselinePath = writeBaseline(tmpDir, 'baseline-drift.json', BASE_FACTS);
    toCleanup.push(baselinePath);

    // ALT_FACTS has an extra settingsKey → different fingerprint → drift
    const gatherSchemaFn = () => ({ facts: ALT_FACTS, diagnostics: [] });
    const out = await canaryDispatch({ configDir: '', args: {}, baselinePath, gatherSchemaFn });

    assert.equal(out.code, 0, 'drift must never produce a non-zero exit code');
    assert.equal(out.result.canary, 'schema');
    assert.equal(out.result.status, 'drifted', `expected drifted but got ${out.result.status}`);
    assert.ok(Array.isArray(out.result.changes), 'changes must be an array');
    // At least one change entry describing the drift.
    assert.ok(out.result.changes.length > 0, 'drifted canary must report at least one change');
    // WARN diagnostic emitted.
    const warnDiags = out.diagnostics.filter((d) => d.severity === 'warn');
    assert.ok(warnDiags.length > 0, 'drifted canary must emit at least one warn diagnostic');
    assert.ok(
      warnDiags.some((d) => d.code === 'schema-drift-detected'),
      'expected schema-drift-detected warn',
    );
  });

  it('3. no-baseline: nonexistent baselinePath → status no-baseline, INFO, code 0', async () => {
    const baselinePath = join(tmpDir, 'does-not-exist-baseline.json');
    // Ensure it really does not exist.
    assert.ok(!existsSync(baselinePath), 'precondition: baseline file must not exist');

    const gatherSchemaFn = () => ({ facts: BASE_FACTS, diagnostics: [] });
    const out = await canaryDispatch({ configDir: '', args: {}, baselinePath, gatherSchemaFn });

    assert.equal(out.code, 0);
    assert.equal(out.result.canary, 'schema');
    assert.equal(out.result.status, 'no-baseline', `expected no-baseline but got ${out.result.status}`);
    // INFO diagnostic emitted (not an error or warn).
    const infoDiags = out.diagnostics.filter((d) => d.severity === 'info');
    assert.ok(infoDiags.length > 0, 'no-baseline must emit at least one info diagnostic');
    // No errors or warnings.
    const noisy = out.diagnostics.filter((d) => d.severity === 'error' || d.severity === 'warn');
    assert.deepEqual(noisy, []);
  });

  it('4. --update-baseline: writes new baseline to tmp path, status baseline-updated', async () => {
    const baselinePath = join(tmpDir, 'baseline-updated.json');
    // Must NOT exist before the call so we can assert creation.
    assert.ok(!existsSync(baselinePath), 'precondition: file must not exist before update');
    toCleanup.push(baselinePath);

    const gatherSchemaFn = () => ({ facts: BASE_FACTS, diagnostics: [] });
    const out = await canaryDispatch({
      configDir: '',
      args: { 'update-baseline': true },
      baselinePath,
      gatherSchemaFn,
    });

    assert.equal(out.code, 0);
    assert.equal(out.result.canary, 'schema');
    assert.equal(out.result.status, 'baseline-updated', `expected baseline-updated but got ${out.result.status}`);
    // The file must have been written.
    assert.ok(existsSync(baselinePath), 'baseline file must have been written');
    // No error diagnostics from the write.
    const errDiags = out.diagnostics.filter((d) => d.severity === 'error');
    assert.deepEqual(errDiags, []);
  });

  it('5. dispatch-failed catch: gatherSchemaFn throws → code 0, schema-canary-dispatch-failed error', async () => {
    const gatherSchemaFn = () => { throw new Error('boom: gather failed'); };
    const out = await canaryDispatch({
      configDir: '',
      args: {},
      baselinePath: join(tmpDir, 'irrelevant.json'),
      gatherSchemaFn,
    });

    assert.equal(out.code, 0, 'even on a dispatch failure code must be 0');
    assert.equal(out.result.canary, 'schema');
    assert.equal(out.result.status, 'no-baseline');
    assert.deepEqual(out.result.changes, []);
    const errDiags = out.diagnostics.filter((d) => d.severity === 'error');
    assert.ok(errDiags.length > 0, 'dispatch-failed must emit at least one error diagnostic');
    assert.ok(
      errDiags.some((d) => d.code === 'schema-canary-dispatch-failed'),
      'expected schema-canary-dispatch-failed error diagnostic',
    );
    // The error message must contain the original error text.
    const diag = errDiags.find((d) => d.code === 'schema-canary-dispatch-failed');
    assert.ok(diag && diag.message.includes('boom: gather failed'), 'error message must include original cause');
  });

  it('dimensions:null on dispatch-failed does not cause renderTable to throw', async () => {
    // Non-blocking note: the catch path returns dimensions:null which renderTable
    // receives as r.dimensions; the schema-canary arm only reads r.changes/r.status
    // so this is harmless — but assert it explicitly.
    const gatherSchemaFn = () => { throw new Error('deliberate'); };
    const out = await canaryDispatch({ configDir: '', args: {}, gatherSchemaFn });
    assert.equal(out.result.dimensions, null, 'dispatch-failed result must carry dimensions:null');
    // Import renderTable and confirm it does not throw on this result.
    const { renderTable } = await import('../src/cli/render.mjs');
    let rendered;
    assert.doesNotThrow(() => { rendered = renderTable('selftest', out.result); });
    assert.ok(typeof rendered === 'string', 'renderTable must return a string even with dimensions:null');
    assert.ok(rendered.includes('schema-canary:'), 'rendered output must include the schema-canary summary');
  });
});
