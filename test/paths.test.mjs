import test from 'node:test';
import assert from 'node:assert/strict';
import { homedir, tmpdir } from 'node:os';
import { join, normalize } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import {
  resolveRoots,
  targetClaudeDir,
  mgrInstallDir,
  mgrStateDir,
  MGR_STATE_DIRNAME,
  assertWritable,
  WriteForbiddenError,
} from '../src/paths.mjs';

test('resolveRoots returns all three roots', () => {
  const r = resolveRoots();
  assert.ok(r.mgrInstallDir, 'mgrInstallDir present');
  assert.ok(r.targetClaudeDir, 'targetClaudeDir present');
  assert.ok(r.mgrStateDir, 'mgrStateDir present');
});

test('mgrInstallDir resolves to the package root (parent of src/)', () => {
  const root = mgrInstallDir();
  assert.ok(root.endsWith('claude-mgr'), `unexpected install dir: ${root}`);
});

test('mgrStateDir is <targetClaudeDir>/.mgr-state (canonical const)', () => {
  const state = mgrStateDir();
  assert.ok(state.includes(targetClaudeDir()), 'state dir under target');
  assert.equal(MGR_STATE_DIRNAME, '.mgr-state');
  assert.ok(state.endsWith(MGR_STATE_DIRNAME), `state dir named ${MGR_STATE_DIRNAME}`);
});

test('targetClaudeDir defaults to <home>/.claude when CLAUDE_CONFIG_DIR unset', () => {
  const saved = process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CLAUDE_CONFIG_DIR;
  try {
    assert.equal(targetClaudeDir(), normalize(join(homedir(), '.claude')));
  } finally {
    if (saved !== undefined) process.env.CLAUDE_CONFIG_DIR = saved;
  }
});

test('targetClaudeDir RESPECTS an absolute CLAUDE_CONFIG_DIR override', () => {
  const saved = process.env.CLAUDE_CONFIG_DIR;
  const override = normalize(join(tmpdir(), 'cmgr-cfg-override'));
  process.env.CLAUDE_CONFIG_DIR = override;
  try {
    assert.equal(targetClaudeDir(), override);
    assert.ok(mgrStateDir().startsWith(override), 'state dir tracks the override');
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
  }
});

test('targetClaudeDir expands a ~ CLAUDE_CONFIG_DIR (delegated, not reimplemented)', () => {
  const saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = '~';
  try {
    assert.equal(targetClaudeDir(), normalize(homedir()));
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
  }
});

// --- assertWritable: exercised against a REAL temp dir so realpathSync resolves.
test('assertWritable ALLOWS the mgr state dir and DENIES the forbidden/rollback-only surfaces', () => {
  const saved = process.env.CLAUDE_CONFIG_DIR;
  const dir = mkdtempSync(join(tmpdir(), 'cmgr-aw-'));
  process.env.CLAUDE_CONFIG_DIR = dir;
  try {
    const state = mgrStateDir(dir);

    // ALLOW: writes under the mgr state dir (snapshots, journals, logs).
    assert.doesNotThrow(() => assertWritable(join(state, 'snapshots', 'x', 'manifest.json')));

    // DENY: outside the governed config dir entirely.
    assert.throws(
      () => assertWritable(join(tmpdir(), 'somewhere-else', 'a.txt')),
      (e) => e instanceof WriteForbiddenError && e.code === 'write-outside-target',
    );

    // DENY: always-forbidden subtree (marketplaces).
    assert.throws(
      () => assertWritable(join(dir, 'plugins', 'marketplaces', 'm', 'x.md')),
      (e) => e.code === 'write-forbidden',
    );

    // DENY: rollback-only surface in default ('apply') context.
    assert.throws(
      () => assertWritable(join(dir, 'CLAUDE.md')),
      (e) => e.code === 'write-rollback-only',
    );
    assert.throws(
      () => assertWritable(join(dir, 'agents', 'executor.md')),
      (e) => e.code === 'write-rollback-only',
    );

    // ALLOW: same rollback-only surface WHEN context === 'rollback'.
    assert.doesNotThrow(() => assertWritable(join(dir, 'CLAUDE.md'), 'rollback'));
    assert.doesNotThrow(() => assertWritable(join(dir, 'skills', 'foo', 'SKILL.md'), 'rollback'));

    // DENY: unknown path under config dir (conservative default).
    assert.throws(
      () => assertWritable(join(dir, 'telemetry', 'blob.bin')),
      (e) => e.code === 'write-not-allowed',
    );

    // DENY: empty/invalid target.
    assert.throws(
      () => assertWritable(''),
      (e) => e instanceof WriteForbiddenError && e.code === 'write-target-invalid',
    );
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- security L1: a symlink/junction inside the allowed dir that resolves
// OUTSIDE the allowlist must be DENIED (realpathSync-before-allowlist). ---
test('assertWritable DENIES a junction that escapes the allowlist', () => {
  const saved = process.env.CLAUDE_CONFIG_DIR;
  const cfg = mkdtempSync(join(tmpdir(), 'cmgr-sym-cfg-'));
  const outside = mkdtempSync(join(tmpdir(), 'cmgr-sym-out-'));
  process.env.CLAUDE_CONFIG_DIR = cfg;
  try {
    const state = mgrStateDir(cfg);
    mkdirSync(state, { recursive: true });
    const link = join(state, 'escape');
    let made = false;
    try {
      // 'junction' needs no elevation on Windows; falls through on POSIX too.
      symlinkSync(outside, link, 'junction');
      made = true;
    } catch {
      // no symlink privilege on this box — skip without failing
    }
    if (made) {
      assert.throws(
        () => assertWritable(join(link, 'pwned.txt')),
        (e) => e instanceof WriteForbiddenError && e.code === 'write-outside-target',
        'a write through a junction that escapes the config dir must be denied',
      );
    }
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
    rmSync(cfg, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
