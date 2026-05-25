/**
 * P2.U7a — integration/doctor-no-hook-execution.test.mjs
 *
 * DoD gate: verifies that gatherHookSyntaxProbes uses real `node --check` to
 * detect syntax errors, but NEVER executes the hook script itself.
 *
 * Uses real spawning (no injected runNodeCheck). Writes three scripts to a temp
 * dir:
 *   good.mjs       — valid syntax → status 'ok'
 *   bad.mjs        — syntax error → status 'syntax-error'
 *   side-effect.mjs — valid syntax, but IF EXECUTED writes a sentinel file
 *                     → must NOT appear (proves no execution)
 *
 * The sentinel check is the core invariant: node --check parses but never runs.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gatherHookSyntaxProbes } from '../../src/discovery/probe-hook-syntax.mjs';
import { runDoctor } from '../../src/analysis/doctor/index.mjs';

test('integration: node --check detects syntax errors without executing scripts', async () => {
  // Create a temporary directory; clean up in finally.
  const dir = mkdtempSync(join(tmpdir(), 'mgr-u7a-'));
  const sentinelPath = join(dir, 'sentinel.txt');

  try {
    const goodPath = join(dir, 'good.mjs');
    const badPath = join(dir, 'bad.mjs');
    const sideEffectPath = join(dir, 'side-effect.mjs');

    // Valid script.
    writeFileSync(goodPath, 'export const ok = 1;\n', 'utf8');

    // Syntax error script.
    writeFileSync(badPath, 'export const x = ;\n', 'utf8');

    // Valid script that writes a sentinel file IF executed — must NOT run.
    writeFileSync(
      sideEffectPath,
      `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(sentinelPath)}, 'ran');\n`,
      'utf8',
    );

    // Build hookFacts as if from gatherHookProbes.
    const hookFacts = [
      { event: 'E1', command: `node ${goodPath}`, kind: 'file', target: goodPath, status: 'found' },
      { event: 'E2', command: `node ${badPath}`, kind: 'file', target: badPath, status: 'found' },
      { event: 'E3', command: `node ${sideEffectPath}`, kind: 'file', target: sideEffectPath, status: 'found' },
    ];

    // Gather syntax facts using the real node --check.
    const { hookSyntax } = await gatherHookSyntaxProbes({ hookFacts });

    // Verify: three facts returned.
    assert.equal(hookSyntax.length, 3, 'expected one fact per hook');

    // Find each fact by path.
    const goodFact = hookSyntax.find((f) => f.path === goodPath);
    const badFact = hookSyntax.find((f) => f.path === badPath);
    const seFact = hookSyntax.find((f) => f.path === sideEffectPath);

    assert.ok(goodFact, 'good.mjs fact must exist');
    assert.ok(badFact, 'bad.mjs fact must exist');
    assert.ok(seFact, 'side-effect.mjs fact must exist');

    assert.equal(goodFact.status, 'ok', 'good.mjs must be ok');
    assert.equal(badFact.status, 'syntax-error', 'bad.mjs must be syntax-error');
    assert.equal(seFact.status, 'ok', 'side-effect.mjs is valid syntax so must be ok');

    // CRITICAL: sentinel must NOT exist — node --check parsed but never executed.
    assert.equal(
      existsSync(sentinelPath),
      false,
      'sentinel file must NOT exist: side-effect.mjs was executed, but only node --check should have run',
    );

    // Feed into doctor and verify exactly one hook-node-syntax error for bad.mjs.
    const r = runDoctor({ hookSyntax }, { activeProbes: true });
    const found = r.diagnostics.filter((d) => d.code === 'hook-node-syntax');
    assert.equal(found.length, 1, 'exactly one hook-node-syntax finding expected');
    assert.ok(found[0].message.includes(badPath), 'finding must reference bad.mjs path');
    assert.equal(found[0].severity, 'error');
  } finally {
    // Clean up temp dir even if assertions fail.
    rmSync(dir, { recursive: true, force: true });
  }
});

test('integration: TOCTOU — a found file that vanished before the check → indeterminate, not a false syntax error', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mgr-u7a-toctou-'));
  try {
    // Simulate the concurrent-edit window: the passive probe reported status
    // 'found', but the file is gone by the time node --check runs. node exits
    // non-zero (numeric code) with "Cannot find module" — NOT a SyntaxError —
    // so it must be demoted to indeterminate, never reported as a syntax error.
    const gonePath = join(dir, 'gone.mjs'); // never created
    const hookFacts = [
      { event: 'E', command: `node ${gonePath}`, kind: 'file', target: gonePath, status: 'found' },
    ];

    const { hookSyntax } = await gatherHookSyntaxProbes({ hookFacts });
    assert.equal(hookSyntax.length, 1);
    assert.equal(hookSyntax[0].status, 'indeterminate', 'a vanished file must be indeterminate, not syntax-error');

    const r = runDoctor({ hookSyntax }, { activeProbes: true });
    assert.equal(r.diagnostics.filter((d) => d.code === 'hook-node-syntax').length, 0, 'no false syntax-error for a missing file');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
