/**
 * P2.3 — tar-availability GATE GUARD (the anti-false-green sentinel).
 *
 * THE FINDING: every Phase-3 governed-write acceptance oracle
 * (test/integration/snapshot-roundtrip, claude-md-rollback, apply-roundtrip,
 * apply-commit-roundtrip, rollback-decompress-verify, snapshot-tar-roundtrip)
 * begins with
 *     const { tarPath } = resolveTar();
 *     if (!tarPath) { t.skip(...); return; }
 * On a tar-less host (a fresh clone, a Linux/mac CI runner, or a box where
 * resolveTar rejects a remote-misreading GNU tar) EVERY one of those oracles
 * SKIPS and `node --test` still exits 0 — so the release gate could report PASS
 * with the headline snapshot/rollback/apply round-trips never having executed.
 *
 * THIS TEST is the missing counter-assertion: it UNCONDITIONALLY asserts that
 * resolveTar() actually found a system tar. If it did not, this test fails RED,
 * which turns the otherwise-silent "all the real oracles skipped" condition into
 * a visible, gate-failing red. It carries NO platform guard and NO t.skip — that
 * is deliberate: the whole point is that a tar-less host MUST go red here.
 *
 * FALSIFIABLE ORACLE: on this machine (Windows, System32 bsdtar present)
 * resolveTar().tarPath is truthy and this test PASSES. Falsifiability is
 * structural — if resolveTar ever returned no tarPath, this assertion FAILS,
 * which is exactly the intended signal (a silent skip becomes a visible red).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveTar } from '../../src/ops/snapshot-tar.mjs';

test('system tar is resolvable (else the Phase-3 acceptance oracles silently skip)', () => {
  const { tarPath } = resolveTar();
  assert.ok(
    tarPath,
    'resolveTar() found no system tar: every Phase-3 snapshot/rollback/apply '
    + 'acceptance oracle (snapshot-roundtrip, claude-md-rollback, apply-roundtrip, '
    + 'apply-commit-roundtrip, rollback-decompress-verify, snapshot-tar-roundtrip) '
    + 'guards on `if (!tarPath) t.skip()`, so without a system tar they all skip '
    + 'and `node --test` false-greens — the release gate would report PASS with the '
    + 'governed-write round-trips never executed. Install a system tar (Windows 10+ '
    + 'ships bsdtar in System32) to actually run them.',
  );
});
