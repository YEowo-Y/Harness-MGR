import test from 'node:test';
import assert from 'node:assert/strict';
import { homedir, tmpdir } from 'node:os';
import { join, normalize } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

// --- assertWritable: 'probe' context tests ---
test('assertWritable probe context: valid __mgr-probe-<uuid>.md in agents/ -> returns canonical path', () => {
  const saved = process.env.CLAUDE_CONFIG_DIR;
  const dir = mkdtempSync(join(tmpdir(), 'cmgr-probe-'));
  process.env.CLAUDE_CONFIG_DIR = dir;
  try {
    // The probe file itself need not exist; canonical() resolves the parent.
    const probePath = join(dir, 'agents', '__mgr-probe-a1b2c3d4-e5f6-7890-abcd-ef1234567890.md');
    const result = assertWritable(probePath, 'probe');
    assert.ok(typeof result === 'string' && result.length > 0, 'returns canonical path string');
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('assertWritable probe context: non-probe name in agents/ -> throws write-probe-only', () => {
  const saved = process.env.CLAUDE_CONFIG_DIR;
  const dir = mkdtempSync(join(tmpdir(), 'cmgr-probe-'));
  process.env.CLAUDE_CONFIG_DIR = dir;
  try {
    assert.throws(
      () => assertWritable(join(dir, 'agents', 'real-agent.md'), 'probe'),
      (e) => e instanceof WriteForbiddenError && e.code === 'write-probe-only',
    );
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('assertWritable probe context: probe name in nested subdir -> throws write-probe-only', () => {
  const saved = process.env.CLAUDE_CONFIG_DIR;
  const dir = mkdtempSync(join(tmpdir(), 'cmgr-probe-'));
  process.env.CLAUDE_CONFIG_DIR = dir;
  try {
    // dirname check: must be DIRECTLY in agents/, not nested
    assert.throws(
      () => assertWritable(join(dir, 'agents', 'sub', '__mgr-probe-0000.md'), 'probe'),
      (e) => e instanceof WriteForbiddenError && e.code === 'write-probe-only',
    );
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('assertWritable probe context: CLAUDE.md -> throws write-probe-only', () => {
  const saved = process.env.CLAUDE_CONFIG_DIR;
  const dir = mkdtempSync(join(tmpdir(), 'cmgr-probe-'));
  process.env.CLAUDE_CONFIG_DIR = dir;
  try {
    assert.throws(
      () => assertWritable(join(dir, 'CLAUDE.md'), 'probe'),
      (e) => e instanceof WriteForbiddenError && e.code === 'write-probe-only',
    );
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('assertWritable probe context: path outside config dir -> throws write-outside-target', () => {
  const saved = process.env.CLAUDE_CONFIG_DIR;
  const dir = mkdtempSync(join(tmpdir(), 'cmgr-probe-'));
  process.env.CLAUDE_CONFIG_DIR = dir;
  try {
    // outside check runs before the probe branch
    assert.throws(
      () => assertWritable(join(tmpdir(), 'outside', '__mgr-probe-0000.md'), 'probe'),
      (e) => e instanceof WriteForbiddenError && e.code === 'write-outside-target',
    );
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('assertWritable apply context: probe-named file in agents/ -> still throws write-rollback-only', () => {
  const saved = process.env.CLAUDE_CONFIG_DIR;
  const dir = mkdtempSync(join(tmpdir(), 'cmgr-probe-'));
  process.env.CLAUDE_CONFIG_DIR = dir;
  try {
    // unchanged behavior: apply context cannot write agents/ regardless of filename
    assert.throws(
      () => assertWritable(join(dir, 'agents', '__mgr-probe-0000.md'), 'apply'),
      (e) => e instanceof WriteForbiddenError && e.code === 'write-rollback-only',
    );
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('assertWritable probe context: mgrStateDir path -> ALLOW (stateDir check runs first)', () => {
  const saved = process.env.CLAUDE_CONFIG_DIR;
  const dir = mkdtempSync(join(tmpdir(), 'cmgr-probe-'));
  process.env.CLAUDE_CONFIG_DIR = dir;
  try {
    const state = mgrStateDir(dir);
    // stateDir is always writable regardless of context
    assert.doesNotThrow(() => assertWritable(join(state, 'x'), 'probe'));
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('assertWritable probe context: uppercase variant of probe name matches (regex /i)', () => {
  const saved = process.env.CLAUDE_CONFIG_DIR;
  const dir = mkdtempSync(join(tmpdir(), 'cmgr-probe-'));
  process.env.CLAUDE_CONFIG_DIR = dir;
  try {
    // /i flag: __MGR-PROBE-0000.MD should match
    const probePath = join(dir, 'agents', '__MGR-PROBE-0000.MD');
    assert.doesNotThrow(() => assertWritable(probePath, 'probe'));
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- assertWritable: forbidden-vs-rollback-writable table fully enforced (P3.U1) ---
test('assertWritable: forbidden-vs-rollback-writable table fully enforced (P3.U1)', () => {
  const saved = process.env.CLAUDE_CONFIG_DIR;
  const dir = mkdtempSync(join(tmpdir(), 'cmgr-rbtable-'));
  process.env.CLAUDE_CONFIG_DIR = dir;
  try {
    // Rollback ALLOW: rollback context permits all governed content surfaces.
    assert.doesNotThrow(() => assertWritable(join(dir, 'agents', 'executor.md'), 'rollback'));
    assert.doesNotThrow(() => assertWritable(join(dir, 'agents', 'sub', 'deep.md'), 'rollback'));
    assert.doesNotThrow(() => assertWritable(join(dir, 'commands', 'greet.md'), 'rollback'));
    assert.doesNotThrow(() => assertWritable(join(dir, 'hooks', 'pre.mjs'), 'rollback'));
    // stateDir is writable in EVERY context (the stateDir check precedes context branching).
    assert.doesNotThrow(() => assertWritable(join(mgrStateDir(dir), 'x'), 'rollback'));

    // Apply DENY: rollback-only surfaces throw write-rollback-only under 'apply'.
    assert.throws(
      () => assertWritable(join(dir, 'commands', 'greet.md'), 'apply'),
      (e) => e instanceof WriteForbiddenError && e.code === 'write-rollback-only',
    );
    assert.throws(
      () => assertWritable(join(dir, 'hooks', 'pre.mjs'), 'apply'),
      (e) => e instanceof WriteForbiddenError && e.code === 'write-rollback-only',
    );
    assert.throws(
      () => assertWritable(join(dir, 'skills', 'foo.md'), 'apply'),
      (e) => e instanceof WriteForbiddenError && e.code === 'write-rollback-only',
    );

    // Forbidden subtrees stay forbidden EVEN in rollback context.
    assert.throws(
      () => assertWritable(join(dir, 'plugins', 'marketplaces', 'm', 'x.md'), 'rollback'),
      (e) => e instanceof WriteForbiddenError && e.code === 'write-forbidden',
    );
    assert.throws(
      () => assertWritable(join(dir, 'projects', 'p', 'notes.md'), 'apply'),
      (e) => e instanceof WriteForbiddenError && e.code === 'write-forbidden',
    );
    assert.throws(
      () => assertWritable(join(dir, 'projects', 'p', 'notes.md'), 'rollback'),
      (e) => e instanceof WriteForbiddenError && e.code === 'write-forbidden',
    );

    // Outside config dir in rollback context -> write-outside-target.
    assert.throws(
      () => assertWritable(join(tmpdir(), 'cmgr-outside-rb', 'a.txt'), 'rollback'),
      (e) => e instanceof WriteForbiddenError && e.code === 'write-outside-target',
    );

    // Unknown path under config dir in rollback context -> write-not-allowed.
    assert.throws(
      () => assertWritable(join(dir, 'telemetry', 'blob.bin'), 'rollback'),
      (e) => e instanceof WriteForbiddenError && e.code === 'write-not-allowed',
    );
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- assertWritable: always-writable governed settings files (P3.U13-A) ---
// Plan line 432 "Forbidden vs Rollback-Writable": settings.json /
// settings.local.json / .mcp.json are "Always writable (with --apply)" — Yes in
// BOTH 'apply' and 'rollback'. Matched by EXACT basename + directly-under config
// dir, so near-misses (settings.jsonx, nested sub/settings.json) are refused.
test('assertWritable: the three governed settings files are writable in apply AND rollback (P3.U13-A)', () => {
  const saved = process.env.CLAUDE_CONFIG_DIR;
  const dir = mkdtempSync(join(tmpdir(), 'cmgr-aw-settings-'));
  process.env.CLAUDE_CONFIG_DIR = dir;
  try {
    for (const name of ['settings.json', 'settings.local.json', '.mcp.json']) {
      // ALLOW in 'apply' (default) — and the canonical path is returned.
      const applyResult = assertWritable(join(dir, name), 'apply');
      assert.ok(
        typeof applyResult === 'string' && applyResult.length > 0,
        `${name} apply returns a canonical path string`,
      );
      assert.doesNotThrow(() => assertWritable(join(dir, name)), `${name} apply (default ctx) allowed`);
      // ALLOW in 'rollback' too.
      const rbResult = assertWritable(join(dir, name), 'rollback');
      assert.ok(
        typeof rbResult === 'string' && rbResult.length > 0,
        `${name} rollback returns a canonical path string`,
      );
    }

    // DENY near-miss: a longer basename (settings.jsonx) is NOT an exact match.
    assert.throws(
      () => assertWritable(join(dir, 'settings.jsonx'), 'apply'),
      (e) => e instanceof WriteForbiddenError && e.code === 'write-not-allowed',
      'settings.jsonx must not be treated as settings.json',
    );

    // DENY near-miss: the right basename but NESTED (not directly under config dir).
    assert.throws(
      () => assertWritable(join(dir, 'sub', 'settings.json'), 'apply'),
      (e) => e instanceof WriteForbiddenError && e.code === 'write-not-allowed',
      'a nested sub/settings.json must not be writable',
    );

    // The near-misses are rejected in 'rollback' too (no special-casing).
    assert.throws(
      () => assertWritable(join(dir, 'settings.jsonx'), 'rollback'),
      (e) => e instanceof WriteForbiddenError && e.code === 'write-not-allowed',
    );
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── security Low-1: file symlinks through settings.json that escape or redirect ──
//
// assertWritable must resolve symlinks (via realpathSync) BEFORE checking the
// allowlist, so a settings.json that is itself a symlink cannot bypass the gate.

test('assertWritable DENIES settings.json file-symlink pointing outside the config dir (Low-1a)', () => {
  const saved = process.env.CLAUDE_CONFIG_DIR;
  const cfg = mkdtempSync(join(tmpdir(), 'cmgr-sym-a-'));
  const outside = mkdtempSync(join(tmpdir(), 'cmgr-sym-victim-'));
  process.env.CLAUDE_CONFIG_DIR = cfg;
  try {
    // Create the victim file outside the config dir so the file symlink can be made.
    const victimFile = join(outside, 'victim.txt');
    writeFileSync(victimFile, 'secret');
    const link = join(cfg, 'settings.json');
    let made = false;
    try {
      symlinkSync(victimFile, link, 'file');
      made = true;
    } catch {
      // No symlink privilege on this box — skip the assertion.
    }
    if (made) {
      // canonical() resolves the symlink to victimFile (outside the config dir).
      // isUnder(target, claudeDir) is false → write-outside-target.
      assert.throws(
        () => assertWritable(link, 'apply'),
        (e) => e instanceof WriteForbiddenError && e.code === 'write-outside-target',
        'a settings.json file-symlink pointing outside the config dir must be denied',
      );
    }
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
    rmSync(cfg, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('assertWritable DENIES settings.json file-symlink pointing to CLAUDE.md → write-rollback-only (Low-1b)', () => {
  const saved = process.env.CLAUDE_CONFIG_DIR;
  const cfg = mkdtempSync(join(tmpdir(), 'cmgr-sym-b-'));
  process.env.CLAUDE_CONFIG_DIR = cfg;
  try {
    // Create the target file so a file symlink can be made.
    const claudeMd = join(cfg, 'CLAUDE.md');
    writeFileSync(claudeMd, '# CLAUDE');
    const link = join(cfg, 'settings.json');
    let made = false;
    try {
      symlinkSync(claudeMd, link, 'file');
      made = true;
    } catch {
      // No symlink privilege — skip.
    }
    if (made) {
      // canonical() resolves the symlink to CLAUDE.md. basename is 'CLAUDE.md'
      // which is not in APPLY_WRITABLE_FILES, so isApplyWritableFile is false.
      // Then the rollbackOnly list matches CLAUDE.md → write-rollback-only.
      assert.throws(
        () => assertWritable(link, 'apply'),
        (e) => e instanceof WriteForbiddenError && e.code === 'write-rollback-only',
        'a settings.json symlink resolving to CLAUDE.md must be denied as rollback-only',
      );
    }
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
    rmSync(cfg, { recursive: true, force: true });
  }
});

// ── security Low-2: Windows near-misses (NTFS ADS + trailing dot + case folding) ──
//
// On win32 the canonical() helper lowercases paths so case-insensitive NTFS
// behaves correctly. NTFS ADS (`file:stream`) and trailing-dot filenames are
// near-misses that must NOT be admitted as settings.json.

test('assertWritable DENIES NTFS ADS and trailing-dot near-misses on win32 (Low-2c)', () => {
  if (process.platform !== 'win32') return; // skip on non-Windows
  const saved = process.env.CLAUDE_CONFIG_DIR;
  const cfg = mkdtempSync(join(tmpdir(), 'cmgr-win-c-'));
  process.env.CLAUDE_CONFIG_DIR = cfg;
  try {
    // NTFS Alternate Data Stream: basename 'settings.json:evil' is not in APPLY_WRITABLE_FILES.
    assert.throws(
      () => assertWritable(join(cfg, 'settings.json:evil'), 'apply'),
      (e) => e instanceof WriteForbiddenError && e.code === 'write-not-allowed',
      'settings.json:evil (NTFS ADS) must be denied',
    );
    // Trailing dot: 'settings.json.' — on NTFS the trailing dot is stripped by the
    // kernel, but the path does not yet exist so canonical() uses the plain resolve
    // fallback. basename 'settings.json.' is not an exact match → write-not-allowed.
    assert.throws(
      () => assertWritable(join(cfg, 'settings.json.'), 'apply'),
      (e) => e instanceof WriteForbiddenError && e.code === 'write-not-allowed',
      'settings.json. (trailing dot) must be denied',
    );
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
    rmSync(cfg, { recursive: true, force: true });
  }
});

test('assertWritable ALLOWS Settings.JSON (case-insensitive NTFS) on win32 (Low-2d)', () => {
  if (process.platform !== 'win32') return; // skip on non-Windows
  const saved = process.env.CLAUDE_CONFIG_DIR;
  const cfg = mkdtempSync(join(tmpdir(), 'cmgr-win-d-'));
  process.env.CLAUDE_CONFIG_DIR = cfg;
  try {
    // canonical() lowercases on win32: 'Settings.JSON' → 'settings.json'.
    // dirname check: canonical(cfg)/settings.json is directly under canonical(cfg).
    // APPLY_WRITABLE_FILES.includes('settings.json') → true → returns canonical path.
    const result = assertWritable(join(cfg, 'Settings.JSON'), 'apply');
    assert.ok(
      typeof result === 'string' && result.length > 0,
      'Settings.JSON should be allowed on case-insensitive NTFS and return a canonical path',
    );
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
    rmSync(cfg, { recursive: true, force: true });
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
