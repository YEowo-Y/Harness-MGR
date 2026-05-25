/**
 * P2.U4 — doctor-passive-default.test.mjs (plan catalog test #15)
 *
 * The dispatch contract: passive is the DEFAULT and produces ZERO side effects.
 * "Zero side effects" is proven structurally — an ACTIVE check's run() is a spy,
 * and in the default (passive) mode that spy must never be invoked. Active checks
 * run only when the caller opts in via { activeProbes: true }, which also emits the
 * `doctor-active-probes` side-effect notice. Passive checks always run.
 *
 * The registry is overridden via the documented opts.checks seam so the dispatch
 * can be tested independently of whichever real checks happen to be registered.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { runDoctor, CHECKS } from '../src/analysis/doctor/index.mjs';

const byCode = (diags, code) => diags.filter((d) => d.code === code);

/** A check whose run() counts its invocations, so we can assert it never fires. */
function spyCheck(id, code, probeLevel) {
  let calls = 0;
  return {
    check: { id, code, probeLevel, run: () => { calls += 1; return []; } },
    calls: () => calls,
  };
}

// ── A. PASSIVE IS THE DEFAULT, WITH ZERO SIDE EFFECTS ─────────────────────────

test('default mode is passive: an active check never runs (zero side effects)', () => {
  const passive = spyCheck(1, 'passive-spy', 'passive');
  const active = spyCheck(2, 'active-spy', 'active');

  const r = runDoctor({}, { checks: [passive.check, active.check] });

  assert.equal(r.probeLevel, 'passive');
  assert.equal(passive.calls(), 1, 'passive check runs by default');
  assert.equal(active.calls(), 0, 'active check must NOT run in passive mode');

  const activeSummary = r.checks.find((c) => c.code === 'active-spy');
  assert.equal(activeSummary.ran, false);
  assert.equal(activeSummary.findings, 0);
  assert.equal(r.checks.find((c) => c.code === 'passive-spy').ran, true);

  // No active probes requested → no side-effect notice emitted.
  assert.equal(byCode(r.diagnostics, 'doctor-active-probes').length, 0);
});

test('the real registry has passive checks that all run by default; active checks are skipped (P2.U7a)', () => {
  const r = runDoctor({});
  assert.equal(r.probeLevel, 'passive');
  assert.equal(r.checks.length, CHECKS.length);
  // Passive checks all run; active checks (e.g. #4 hook-node-syntax, added P2.U7a) do not.
  assert.ok(r.checks.filter((c) => c.probeLevel === 'passive').every((c) => c.ran), 'all passive checks run in default mode');
  assert.ok(r.checks.filter((c) => c.probeLevel === 'active').every((c) => !c.ran), 'active checks do not run in passive mode');
  assert.equal(byCode(r.diagnostics, 'doctor-active-probes').length, 0);
});

// ── B. ACTIVE IS OPT-IN ───────────────────────────────────────────────────────

test('activeProbes:true runs active checks and emits the side-effect notice', () => {
  const passive = spyCheck(1, 'passive-spy', 'passive');
  const active = spyCheck(2, 'active-spy', 'active');

  const r = runDoctor({}, { checks: [passive.check, active.check], activeProbes: true });

  assert.equal(r.probeLevel, 'active');
  assert.equal(passive.calls(), 1);
  assert.equal(active.calls(), 1, 'active check runs when opted in');
  assert.equal(r.checks.find((c) => c.code === 'active-spy').ran, true);

  const notice = byCode(r.diagnostics, 'doctor-active-probes');
  assert.equal(notice.length, 1);
  assert.equal(notice[0].severity, 'info');
});

// ── C. ROBUST DISPATCH ────────────────────────────────────────────────────────

test('an unrecognised probeLevel is treated as passive (fail safe, never skipped)', () => {
  const weird = spyCheck(9, 'weird', 'banana');
  const r = runDoctor({}, { checks: [weird.check] });
  assert.equal(weird.calls(), 1);
  assert.equal(r.checks[0].probeLevel, 'passive');
  assert.equal(r.checks[0].ran, true);
});

test('a check that throws is contained as a doctor-check-threw error, run continues', () => {
  const boom = { id: 1, code: 'boom', probeLevel: 'passive', run: () => { throw new Error('kaboom'); } };
  const ok = spyCheck(2, 'ok', 'passive');
  let r;
  assert.doesNotThrow(() => { r = runDoctor({}, { checks: [boom, ok.check] }); });
  assert.equal(ok.calls(), 1, 'a sibling check still runs after one throws');
  const thrown = byCode(r.diagnostics, 'doctor-check-threw');
  assert.equal(thrown.length, 1);
  assert.match(thrown[0].message, /kaboom/);
});

// ── D. DETERMINISM ────────────────────────────────────────────────────────────

test('determinism: default-mode dispatch is stable across calls', () => {
  assert.deepEqual(runDoctor({}), runDoctor({}));
});
