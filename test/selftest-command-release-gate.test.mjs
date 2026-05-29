/**
 * Tests for the release-gate dispatch path of src/cli/selftest-command.mjs.
 *
 * Covers releaseGateDispatch (with an injected fake gate — NO node --test spawn)
 * and the pure buildStabilityRow helper. Verifies the wrapped CommandOutput shape,
 * that --log appends one row to a TEMP STABILITY-LOG.jsonl (read back), and that
 * without --log nothing is written.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { releaseGateDispatch, buildStabilityRow } from '../src/cli/selftest-command.mjs';

// ── buildStabilityRow (pure) ────────────────────────────────────────────────────

test('buildStabilityRow: picks the latest non-empty cc_version from rows', () => {
  const rows = [
    { cc_version: '2.1.146', gate_pass: true },
    { cc_version: '2.1.150', gate_pass: true },
    { cc_version: '', gate_pass: false },        // trailing empty must be skipped
  ];
  const row = buildStabilityRow({ rows, pass: true, errorDiagCount: 0, ts: '2026-05-29T00:00:00.000Z' });
  assert.equal(row.cc_version, '2.1.150');
  assert.equal(row.gate_pass, true);
  assert.equal(row.error_diag_count, 0);
  assert.equal(row.ts, '2026-05-29T00:00:00.000Z');
});

test('buildStabilityRow: cc_version falls back to "unknown" when no row carries one', () => {
  assert.equal(buildStabilityRow({ rows: [], pass: false, errorDiagCount: 3, ts: 't' }).cc_version, 'unknown');
  assert.equal(buildStabilityRow({ rows: [{ gate_pass: true }], pass: false, errorDiagCount: 3, ts: 't' }).cc_version, 'unknown');
  // non-array rows degrade to 'unknown' (never throws)
  assert.equal(buildStabilityRow({ rows: null, pass: true, errorDiagCount: 0, ts: 't' }).cc_version, 'unknown');
});

test('buildStabilityRow: error count and pass pass through; non-number count → 0; non-bool pass → false', () => {
  const a = buildStabilityRow({ rows: [], pass: true, errorDiagCount: 7, ts: 't' });
  assert.equal(a.error_diag_count, 7);
  assert.equal(a.gate_pass, true);
  const b = buildStabilityRow({ rows: [], pass: 'yes', errorDiagCount: 'x', ts: 5 });
  assert.equal(b.error_diag_count, 0);
  assert.equal(b.gate_pass, false);
  assert.equal(b.ts, '');
});

// ── releaseGateDispatch (injected fake gate — no spawn) ──────────────────────────

/** A fake gate runner that records its opts and returns a canned GateResult. */
function fakeGate(result) {
  const calls = [];
  const fn = async (opts) => { calls.push(opts); return result; };
  fn.calls = calls;
  return fn;
}

test('releaseGateDispatch: wraps the gate result as {result:{gate,pass,steps}, diagnostics, code}', async () => {
  const steps = [{ step: 1, name: 'catalog-tests', pass: true, detail: 'ok' }];
  const gate = fakeGate({ pass: true, steps, diagnostics: [{ severity: 'info', code: 'x', message: 'm', phase: 'release-gate' }], code: 0 });
  const out = await releaseGateDispatch({ args: {}, configDir: '/fake/.claude', mgrStateDir: '/fake/.mgr-state' }, gate);

  assert.deepEqual(out.result, { gate: 'release', pass: true, steps });
  assert.equal(out.code, 0);
  assert.equal(out.diagnostics.length, 1);
  assert.equal(out.diagnostics[0].code, 'x');
  // The gate was called once with a resolved srcDir/repoRoot and our configDir.
  assert.equal(gate.calls.length, 1);
  assert.equal(gate.calls[0].configDir, '/fake/.claude');
  assert.ok(typeof gate.calls[0].srcDir === 'string' && gate.calls[0].srcDir.length > 0);
  assert.ok(typeof gate.calls[0].repoRoot === 'string' && gate.calls[0].repoRoot.length > 0);
});

test('releaseGateDispatch: failing gate propagates code 2 and the gate diagnostics', async () => {
  const gate = fakeGate({ pass: false, steps: [{ step: 3, name: 'invariants', pass: false, detail: '1 error(s)' }],
    diagnostics: [{ severity: 'error', code: 'inv-fail', message: 'bad', phase: 'invariants' }], code: 2 });
  const out = await releaseGateDispatch({ args: {}, configDir: '/x', mgrStateDir: '' }, gate);
  assert.equal(out.code, 2);
  assert.equal(out.result.pass, false);
  assert.ok(out.diagnostics.some((d) => d.code === 'inv-fail'));
});

// The --log path normally resolves <repoRoot>/STABILITY-LOG.jsonl internally, which
// a test must not pollute. ctx.logPath is a test-only override that redirects the
// real --log branch (appendLogRow → readStabilityLog → buildStabilityRow →
// appendStabilityRow) into a TEMP file, so the end-to-end branch is exercised here.
test('releaseGateDispatch --log: appends one parseable row to the TEMP logPath (read back)', async () => {
  const { readStabilityLog } = await import('../src/ops/stability-log.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'mgr-gate-log-'));
  const logPath = join(dir, 'STABILITY-LOG.jsonl');
  try {
    // Seed one prior row so the cc_version carry-forward is exercised.
    writeFileSync(logPath, JSON.stringify({ ts: 't0', cc_version: '2.1.152', gate_pass: true, error_diag_count: 0 }) + '\n', 'utf8');

    const gate = fakeGate({ pass: false, steps: [{ step: 6, name: 'doctor-smoke', pass: false, detail: '1 error(s)' }],
      diagnostics: [{ severity: 'error', code: 'doc-fail', message: 'bad', phase: 'doctor' }], code: 1 });
    const out = await releaseGateDispatch({ args: { log: true }, configDir: '/x', mgrStateDir: '', logPath }, gate);

    // The wrapped result is still returned normally.
    assert.equal(out.code, 1);
    assert.equal(out.result.pass, false);

    // And exactly one row was appended to the temp log.
    const after = readStabilityLog({ logPath });
    assert.equal(after.rows.length, 2, 'one row appended on top of the seed');
    const last = after.rows[after.rows.length - 1];
    assert.equal(last.cc_version, '2.1.152', 'carried forward from the seed row');
    assert.equal(last.gate_pass, false, 'reflects the failing gate');
    assert.equal(last.error_diag_count, 1, 'one error-severity diagnostic counted');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('releaseGateDispatch without --log: does NOT write to the provided logPath', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mgr-gate-nolog2-'));
  const logPath = join(dir, 'STABILITY-LOG.jsonl');
  try {
    const gate = fakeGate({ pass: true, steps: [], diagnostics: [], code: 0 });
    // args.log is absent → appendLogRow must not run, so no file is created.
    const out = await releaseGateDispatch({ args: {}, configDir: '/x', mgrStateDir: '', logPath }, gate);
    assert.equal(out.code, 0);
    assert.ok(!existsSync(logPath), 'no log written when --log is absent');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
