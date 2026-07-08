/**
 * integration/rollback-mode-roundtrip.test.mjs — deferred item #1 (snapshot POSIX
 * file-mode preservation) proven END-TO-END with NO injected seams.
 *
 * Every OTHER mode test is hermetic — it injects lstatFn (capture), and
 * chmodFn + platform (restore) — so none of them exercises the DEFAULT wiring:
 * resolveSnapshotSeams' real lstatSync, and restoreFileMode's real chmodSync +
 * process.platform. This test runs the whole real path:
 *
 *   real lstatSync  →  real JSON manifest write/read  →  real system tar
 *   create/extract  →  real chmodSync  →  real statSync
 *
 * so a regression in that default wiring (e.g. lstat stops reading `.mode`, or the
 * restore stops calling restoreFileMode, or the mode is lost across the real
 * serialize/parse) is CAUGHT here even though every seam-mocked unit stays green.
 * This directly closes the "POSIX host-OS semantics are asserted but only truly
 * exercised on the CI runners" gap the cross-platform hardening exists to close.
 *
 * POSIX-ONLY graceful-skip: on win32 there is no meaningful exec bit and
 * restoreFileMode skips chmod by design, so the mode oracle cannot hold — the test
 * skips (mirrors the system-tar graceful-skip in the sibling round-trip tests).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, statSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSnapshot } from '../../src/ops/snapshot.mjs';
import { restoreSnapshot } from '../../src/ops/rollback-restore.mjs';
import { resolveTar } from '../../src/ops/snapshot-tar.mjs';

const PASS_GATE = (p) => p; // passthrough gate (the real gate is exercised by selftest --boundary)

test('roundtrip: a POSIX exec bit survives create → mutate → rollback with REAL default seams', async (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX-only: win32 has no meaningful exec bit and restoreFileMode skips chmod by design');
    return;
  }
  const { tarPath, diagnostics } = resolveTar();
  if (!tarPath) {
    t.skip(`system tar not found (${diagnostics.map((d) => d.code).join(',')}) — skipping mode round-trip`);
    return;
  }

  const root = mkdtempSync(join(tmpdir(), 'cmgr-mode-rt-'));
  const claudeDir = join(root, '.claude');
  const stateDir = join(claudeDir, '.mgr-state');
  const hookAbs = join(claudeDir, 'hooks', 'run.sh');
  const plainAbs = join(claudeDir, 'agents', 'a.md');

  try {
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(join(claudeDir, 'hooks'), { recursive: true });
    mkdirSync(join(claudeDir, 'agents'), { recursive: true });
    // An EXECUTABLE hook (0o755) + a plain 0o644 file. chmod is absolute (umask-free).
    writeFileSync(hookAbs, '#!/bin/sh\necho hi\n');
    chmodSync(hookAbs, 0o755);
    writeFileSync(plainAbs, '# agent a\n');
    chmodSync(plainAbs, 0o644);
    const origHookBytes = readFileSync(hookAbs);

    // 1. SNAPSHOT with REAL default seams — real lstat must capture the two modes.
    const snap = await createSnapshot({
      targetClaudeDir: claudeDir, mgrStateDir: stateDir, reason: 'mode-rt', assertWritable: PASS_GATE,
    });
    assert.equal(snap.ok, true, JSON.stringify(snap.diagnostics));
    const byPath = Object.fromEntries(
      JSON.parse(readFileSync(snap.manifestPath, 'utf8')).files.map((f) => [f.path, f]),
    );
    assert.equal(byPath['hooks/run.sh'].mode, 0o755, 'the exec bit is captured into the manifest');
    assert.equal(byPath['agents/a.md'].mode, 0o644);

    // 2. MUTATE: strip the exec bit AND change the bytes (the drift a rollback undoes).
    chmodSync(hookAbs, 0o644);
    writeFileSync(hookAbs, 'TAMPERED\n');
    assert.equal(statSync(hookAbs).mode & 0o777, 0o644, 'precondition: exec bit stripped before rollback');

    // 3. ROLLBACK with REAL default seams — real chmod, NO injected platform.
    const r = await restoreSnapshot({
      mgrStateDir: stateDir, snapshotId: snap.snapshotId, targetClaudeDir: claudeDir,
      assertWritable: PASS_GATE, expectedTarget: claudeDir,
    });
    assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
    assert.equal(r.restored, true);

    // 4. ORACLE: both the bytes AND the exec bit are restored (this is the whole feature).
    assert.equal(Buffer.compare(readFileSync(hookAbs), origHookBytes), 0, 'content restored byte-identical');
    assert.equal(statSync(hookAbs).mode & 0o777, 0o755, 'the exec bit is restored — deferred item #1');
  } finally {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});
