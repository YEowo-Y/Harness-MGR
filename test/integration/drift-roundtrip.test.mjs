/**
 * P2.U9 — integration/drift-roundtrip.test.mjs
 *
 * THE DoD oracle: "fixture mutation between runs detected".
 *
 * Uses a real temp directory to exercise the full I/O path:
 *   gatherTrackedState → writeLockfile → readLockfile → (mutate) → gatherTrackedState → analyzeDrift
 *
 * NOTE: assertWritableFn is injected as `(p) => p` in all tests because the temp
 * dir is OUTSIDE the real ~/.claude, and the real assertWritable would reject the
 * lockfile path with 'write-outside-target'. The real gate is covered by
 * selftest --boundary (boundary.mjs buildAllowlistCases).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gatherTrackedState, writeLockfile, readLockfile } from '../../src/discovery/probe-state.mjs';
import { analyzeDrift } from '../../src/analysis/drift.mjs';

/** Create a fresh temp dir for one test; caller is responsible for cleanup. */
function makeTempDir() {
  return mkdtempSync(join(tmpdir(), 'mgr-drift-test-'));
}

// ---------------------------------------------------------------------------
// Test 1: mutation detected
// ---------------------------------------------------------------------------

test('mutation detected: overwriting a tracked file changes fingerprint and is reported as drifted', () => {
  const tmp = makeTempDir();
  try {
    // Create tracked files and dirs with known content.
    writeFileSync(join(tmp, 'CLAUDE.md'), '# Initial CLAUDE.md content');
    writeFileSync(join(tmp, 'settings.json'), '{"model":"sonnet"}');
    mkdirSync(join(tmp, 'skills', 'foo'), { recursive: true });
    writeFileSync(join(tmp, 'skills', 'foo', 'SKILL.md'), '# skill foo');
    mkdirSync(join(tmp, 'agents'), { recursive: true });
    writeFileSync(join(tmp, 'agents', 'bar.md'), '# agent bar');

    // Gather initial state.
    const { state: state1, diagnostics: diag1 } = gatherTrackedState({ configDir: tmp });
    assert.equal(diag1.length, 0, 'no diagnostics on initial gather');

    // Assert all expected keys are present in files (POSIX slashes).
    assert.ok(Object.prototype.hasOwnProperty.call(state1.files, 'CLAUDE.md'), 'CLAUDE.md must be tracked');
    assert.ok(Object.prototype.hasOwnProperty.call(state1.files, 'settings.json'), 'settings.json must be tracked');
    assert.ok(Object.prototype.hasOwnProperty.call(state1.files, 'skills/foo/SKILL.md'), 'skills/foo/SKILL.md must be tracked (POSIX slashes)');
    assert.ok(Object.prototype.hasOwnProperty.call(state1.files, 'agents/bar.md'), 'agents/bar.md must be tracked');
    assert.ok(typeof state1.fingerprint === 'string' && state1.fingerprint.length > 0, 'fingerprint must be non-empty');

    // Write lockfile (bypass the real assertWritable gate — it would reject a tmp path).
    const stateDir = join(tmp, '.mgr-state');
    const { path: lockPath, diagnostics: writeDiag } = writeLockfile(stateDir, state1, { assertWritableFn: (p) => p });
    assert.equal(writeDiag.length, 0, 'no diagnostics on write');
    assert.ok(existsSync(join(stateDir, 'lockfile.json')), 'lockfile.json must exist on disk');
    assert.equal(lockPath, join(stateDir, 'lockfile.json'));

    // Read the lockfile back.
    const { lockfile, diagnostics: readDiag } = readLockfile(stateDir);
    assert.equal(readDiag.length, 0, 'no diagnostics on read');
    assert.ok(lockfile !== null, 'lockfile must not be null');
    assert.equal(lockfile.fingerprint, state1.fingerprint, 'persisted fingerprint must match gathered fingerprint');

    // MUTATE: overwrite the skill file with different bytes.
    writeFileSync(join(tmp, 'skills', 'foo', 'SKILL.md'), '# skill foo — MUTATED');

    // Re-gather.
    const { state: state2, diagnostics: diag2 } = gatherTrackedState({ configDir: tmp });
    assert.equal(diag2.length, 0, 'no diagnostics on second gather');
    assert.notEqual(state2.fingerprint, state1.fingerprint, 'fingerprint must change after mutation');

    // Analyze drift.
    const result = analyzeDrift({ current: state2, previous: lockfile });
    assert.equal(result.status, 'drifted', 'status must be drifted');

    const modifiedChange = result.changes.find((c) => c.path === 'skills/foo/SKILL.md');
    assert.ok(modifiedChange !== undefined, 'changes must include skills/foo/SKILL.md');
    assert.equal(modifiedChange.change, 'modified');

    assert.equal(result.diagnostics.length, 1);
    assert.equal(result.diagnostics[0].code, 'drift-detected');
    assert.equal(result.diagnostics[0].severity, 'warn');
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  }
});

// ---------------------------------------------------------------------------
// Test 2: clean round-trip (no mutation)
// ---------------------------------------------------------------------------

test('clean round-trip: gather → write → read → gather (no mutation) → clean', () => {
  const tmp = makeTempDir();
  try {
    writeFileSync(join(tmp, 'CLAUDE.md'), '# stable content');
    mkdirSync(join(tmp, 'skills', 'alpha'), { recursive: true });
    writeFileSync(join(tmp, 'skills', 'alpha', 'SKILL.md'), '# alpha skill');

    const { state: state1 } = gatherTrackedState({ configDir: tmp });

    const stateDir = join(tmp, '.mgr-state');
    writeLockfile(stateDir, state1, { assertWritableFn: (p) => p });

    const { lockfile } = readLockfile(stateDir);
    assert.ok(lockfile !== null, 'lockfile must be readable');

    // Re-gather WITHOUT any mutation.
    const { state: state2 } = gatherTrackedState({ configDir: tmp });

    const result = analyzeDrift({ current: state2, previous: lockfile });
    assert.equal(result.status, 'clean', 'status must be clean when nothing changed');
    assert.equal(result.changes.length, 0);
    assert.equal(result.diagnostics.length, 0);
    assert.deepEqual(result.summary, { added: 0, removed: 0, modified: 0 });
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  }
});

// ---------------------------------------------------------------------------
// Test 3: added + removed files detected
// ---------------------------------------------------------------------------

test('added + removed detected: new file added and existing file deleted after baseline', () => {
  const tmp = makeTempDir();
  try {
    // Initial layout: agents/bar.md present; commands/ absent.
    mkdirSync(join(tmp, 'agents'), { recursive: true });
    writeFileSync(join(tmp, 'agents', 'bar.md'), '# agent bar');

    const { state: state1 } = gatherTrackedState({ configDir: tmp });

    const stateDir = join(tmp, '.mgr-state');
    writeLockfile(stateDir, state1, { assertWritableFn: (p) => p });

    const { lockfile } = readLockfile(stateDir);
    assert.ok(lockfile !== null);

    // Mutate: add commands/new.md and delete agents/bar.md.
    mkdirSync(join(tmp, 'commands'), { recursive: true });
    writeFileSync(join(tmp, 'commands', 'new.md'), '# new command');
    rmSync(join(tmp, 'agents', 'bar.md'));

    const { state: state2 } = gatherTrackedState({ configDir: tmp });

    const result = analyzeDrift({ current: state2, previous: lockfile });
    assert.equal(result.status, 'drifted');

    const added = result.changes.find((c) => c.path === 'commands/new.md');
    assert.ok(added !== undefined, 'commands/new.md must appear as added');
    assert.equal(added.change, 'added');

    const removed = result.changes.find((c) => c.path === 'agents/bar.md');
    assert.ok(removed !== undefined, 'agents/bar.md must appear as removed');
    assert.equal(removed.change, 'removed');

    assert.ok(result.summary.added >= 1);
    assert.ok(result.summary.removed >= 1);
    assert.equal(result.diagnostics.length, 1);
    assert.equal(result.diagnostics[0].code, 'drift-detected');
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  }
});
