/**
 * P6.U2b — resolve-target.test.mjs
 *
 * Hermetic oracles for resolveTargetAndConfig + isKnownTarget. All fs/home/paths
 * dependencies are injected via seams (homeFn / statFn / loadPaths) so no test
 * touches the real filesystem or the real home dir.
 *
 * The load-bearing M2 oracle: the CODEX path NEVER calls loadPaths (proven by
 * passing a loadPaths that throws — if it were called the test would observe the
 * throw being swallowed into the claude fallback, which we assert does NOT happen).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { resolveTargetAndConfig, isKnownTarget } from '../src/cli/resolve-target.mjs';

// A loadPaths seam that MUST NOT be called on the codex path. If it is, the outer
// never-throws guard would swallow it and degrade to claude — the assertions catch
// that by checking descriptor.id === 'codex' AND that this never ran.
function explodingLoadPaths() {
  throw new Error('loadPaths MUST NOT be called on the codex (home) path — M2 violation');
}

// A loadPaths seam returning a fake paths.mjs module shape (targetClaudeDir +
// mgrStateDir), so the claude delegation is fully hermetic.
function fakeLoadPaths(claudeDir) {
  return () => Promise.resolve({
    targetClaudeDir: () => claudeDir,
    mgrStateDir: (cd) => join(cd, '.mgr-state'),
  });
}

// ── explicit codex, no config dir → home/.codex, NO loadPaths ─────────────────

test('explicit target=codex (no configDir): resolves home/.codex and NEVER calls loadPaths (M2)', async () => {
  let loadPathsCalled = false;
  const trackingExplode = () => { loadPathsCalled = true; explodingLoadPaths(); };

  const r = await resolveTargetAndConfig({
    target: 'codex',
    homeFn: () => '/home/me',
    loadPaths: trackingExplode,
  });

  assert.equal(r.descriptor.id, 'codex');
  assert.equal(r.configDir, join('/home/me', '.codex'));
  assert.equal(r.mgrStateDir, join('/home/me', '.codex', '.mgr-state'));
  assert.deepEqual(r.diagnostics, []);
  assert.equal(loadPathsCalled, false, 'loadPaths must never be invoked on the codex home path');
});

// ── explicit claude, no config dir → delegates to resolveConfigDir ────────────

test('explicit target=claude (no configDir): delegates to resolveConfigDir via loadPaths', async () => {
  const r = await resolveTargetAndConfig({
    target: 'claude',
    loadPaths: fakeLoadPaths('/x'),
  });
  assert.equal(r.descriptor.id, 'claude');
  assert.equal(r.configDir, '/x');
  assert.equal(r.mgrStateDir, join('/x', '.mgr-state'));
});

// ── explicit configDir + target=codex → configDir verbatim, codex descriptor ──

test('explicit --config-dir + target=codex: configDir is used verbatim, descriptor stays codex', async () => {
  const r = await resolveTargetAndConfig({
    target: 'codex',
    configDir: '/y',
    // loadPaths is irrelevant here: resolveConfigDir takes the explicit-override
    // branch and never imports paths.mjs — pass an exploder to prove that too.
    loadPaths: explodingLoadPaths,
  });
  assert.equal(r.descriptor.id, 'codex');
  assert.equal(r.configDir, '/y');
  assert.equal(r.mgrStateDir, join('/y', '.mgr-state'));
  assert.deepEqual(r.diagnostics, []);
});

// ── auto-detect: no target + configDir + signatureFile present → codex ────────

test('auto-detect: no target, configDir with config.toml present → codex', async () => {
  const r = await resolveTargetAndConfig({
    configDir: '/probe',
    statFn: (p) => p === join('/probe', 'config.toml'), // only the codex signature exists
    loadPaths: explodingLoadPaths, // explicit configDir → resolveConfigDir never imports paths
  });
  assert.equal(r.descriptor.id, 'codex');
  assert.equal(r.configDir, '/probe'); // explicit configDir kept verbatim
  assert.equal(r.mgrStateDir, join('/probe', '.mgr-state'));
});

// ── auto-detect: no target + configDir + no signatureFile → claude ────────────

test('auto-detect: no target, configDir without config.toml → claude', async () => {
  const r = await resolveTargetAndConfig({
    configDir: '/plain',
    statFn: () => false, // nothing exists → no codex signature
    loadPaths: explodingLoadPaths,
  });
  assert.equal(r.descriptor.id, 'claude');
  assert.equal(r.configDir, '/plain');
  assert.equal(r.mgrStateDir, join('/plain', '.mgr-state'));
});

// ── no target, no configDir → claude default (delegates to resolveConfigDir) ──

test('no target, no configDir → claude default via resolveConfigDir', async () => {
  const r = await resolveTargetAndConfig({ loadPaths: fakeLoadPaths('/default-claude') });
  assert.equal(r.descriptor.id, 'claude');
  assert.equal(r.configDir, '/default-claude');
});

// ── isKnownTarget matrix (incl. proto-safety) ─────────────────────────────────

test('isKnownTarget: claude/codex known; unknown + proto keys + non-strings → false', () => {
  assert.equal(isKnownTarget('claude'), true);
  assert.equal(isKnownTarget('codex'), true);
  assert.equal(isKnownTarget('bogus'), false);
  assert.equal(isKnownTarget('constructor'), false); // proto-safe own-property lookup
  assert.equal(isKnownTarget('__proto__'), false);
  assert.equal(isKnownTarget('prototype'), false);
  assert.equal(isKnownTarget(''), false);
  assert.equal(isKnownTarget(undefined), false);
  assert.equal(isKnownTarget(null), false);
  assert.equal(isKnownTarget(42), false);
  assert.equal(isKnownTarget({}), false);
});

// ── never-throws: no opts at all ──────────────────────────────────────────────

test('resolveTargetAndConfig: no args degrades to a claude default, never throws', async () => {
  const r = await resolveTargetAndConfig();
  assert.equal(r.descriptor.id, 'claude');
  assert.equal(typeof r.configDir, 'string');
  assert.ok(Array.isArray(r.diagnostics));
});
