/**
 * P2.U7c-2 — integration/loader-probe-roundtrip.test.mjs
 *
 * Real-filesystem roundtrip test for gatherLoaderProbe().
 *
 * Uses a temp dir as configDir with a real agents/ subdir. Injects ONLY
 * assertProbeWritable (bypasses the real-claudeDir gate; the gate itself is
 * tested in paths.test.mjs) and uses the REAL writeFn/discoverFn/removeFn/
 * existsFn. Asserts:
 *   - wrote === true
 *   - observed === true  (real discoverComponents found the probe agent)
 *   - cleanedUp === true
 *   - no __mgr-probe-* file remains on disk
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gatherLoaderProbe } from '../../src/discovery/probe-loader.mjs';

test('roundtrip: real write+discover+cleanup leaves no probe file on disk', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mgr-loader-probe-test-'));
  try {
    mkdirSync(join(dir, 'agents'));

    const { loader, diagnostics } = await gatherLoaderProbe({
      configDir: dir,
      ccVersion: '2.1.5',
      // Bypass the real-claudeDir gate: this temp dir is not ~/.claude
      assertProbeWritable: (p) => p,
    });

    assert.equal(loader.wrote, true, 'probe file must have been written');
    assert.equal(loader.observed, true, 'discoverComponents must detect the probe agent');
    assert.equal(loader.cleanedUp, true, 'probe file must have been removed');
    assert.equal(typeof loader.probeName, 'string');
    assert.ok(loader.probeName.startsWith('__mgr-probe-'), 'probeName must have the expected prefix');
    assert.equal(loader.ccVersion, '2.1.5');
    assert.equal(diagnostics.length, 0, 'no diagnostics on a clean run');

    // Confirm no probe file remains on disk.
    const probeFile = join(dir, 'agents', `${loader.probeName}.md`);
    assert.equal(existsSync(probeFile), false, 'probe file must not exist on disk after cleanup');

    // Confirm no __mgr-probe-* files remain anywhere in agents/.
    const leftover = readdirSync(join(dir, 'agents')).filter((f) => f.startsWith('__mgr-probe-'));
    assert.equal(leftover.length, 0, `leftover probe files found: ${leftover.join(', ')}`);
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  }
});
