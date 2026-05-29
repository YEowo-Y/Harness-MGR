/**
 * Tests for the release-gate branch of src/cli/render.mjs::renderTable.
 *
 * Covers selftestTable's `gate:'release'` arm (render.mjs ~140-156): the step
 * table rows (step#, name, ok yes/no, detail) plus the trailing `release-gate:
 * PASS/FAIL` line, for pass:true, pass:false, and the empty-steps ternary fallback.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { renderTable, renderQuiet } from '../src/cli/render.mjs';

function gateResult(pass, steps) {
  return { gate: 'release', pass, steps };
}

const steps = [
  { step: 1, name: 'catalog-tests', pass: true, detail: 'node --test exited 0' },
  { step: 2, name: 'coverage', pass: true, detail: '3 changed file(s) all ≥80% line coverage' },
  { step: 6, name: 'doctor-smoke', pass: false, detail: 'doctor passive: 1 error(s)' },
];

test('renderTable: release-gate PASS renders title, step rows, and PASS line', () => {
  const out = renderTable('selftest', gateResult(true, steps));
  // Title line from renderTable.
  assert.ok(out.startsWith('claude-mgr selftest'), 'title line present');
  // Column headers.
  assert.ok(/\bstep\b/.test(out) && /\bname\b/.test(out) && /\bok\b/.test(out) && /\bdetail\b/.test(out), 'headers present');
  // Step names rendered.
  assert.ok(out.includes('catalog-tests'));
  assert.ok(out.includes('coverage'));
  assert.ok(out.includes('doctor-smoke'));
  // ok column maps pass→'yes' and !pass→'no'.
  assert.ok(out.includes('yes'), 'a passing step renders ok=yes');
  assert.ok(out.includes('no'), 'a failing step renders ok=no');
  // detail text surfaced.
  assert.ok(out.includes('node --test exited 0'));
  assert.ok(out.includes('doctor passive: 1 error(s)'));
  // Trailing summary line.
  assert.ok(out.includes('release-gate: PASS'), 'PASS summary line present');
});

test('renderTable: release-gate FAIL renders the FAIL summary line', () => {
  const out = renderTable('selftest', gateResult(false, steps));
  assert.ok(out.includes('release-gate: FAIL'), 'FAIL summary line present');
});

test('renderTable: release-gate with empty steps still renders the summary line', () => {
  // Exercises the `table ? `${table}\n...` : `release-gate: ...`` ternary fallback
  // where formatTable returns '' for zero rows would still produce a header/sep —
  // assert the summary line is present regardless.
  const out = renderTable('selftest', gateResult(true, []));
  assert.ok(out.includes('release-gate: PASS'));
});

test('renderTable: a non-release selftest result falls to the checks table', () => {
  // The smoke/rigorous path (no gate:'release') must hit the checks branch, not
  // the release-gate branch.
  const out = renderTable('selftest', { ok: true, checks: [{ name: 'scan', ok: true }, { name: 'lint', ok: false }] });
  assert.ok(out.startsWith('claude-mgr selftest'));
  assert.ok(out.includes('scan'));
  assert.ok(out.includes('lint'));
  assert.ok(!out.includes('release-gate:'), 'must not render the release-gate summary line');
});

test('renderQuiet: selftest one-line summary names command + tallies', () => {
  assert.equal(renderQuiet('selftest', 0, 2), 'selftest: 0 error(s), 2 warning(s)');
});
