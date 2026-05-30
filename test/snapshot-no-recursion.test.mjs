/**
 * P3.U5 — snapshot-no-recursion.test.mjs
 *
 * The HEADLINE INVARIANT: a snapshot NEVER captures `.mgr-state/**` (or `.mgr/**`).
 * If it did, every snapshot would archive the previous snapshot → unbounded
 * recursive bloat. This test simulates a PRIOR snapshot already on disk inside the
 * tree, re-runs the walk, and proves no `.mgr-state` path is ever emitted.
 *
 * Also proves: a symlinked subdir under an allowlisted dir is NOT followed (no
 * escape, no infinite loop). Symlink creation is gracefully skipped if the OS
 * refuses it (no Developer Mode / permission), so the test never falsely fails.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { walkSnapshotScope } from '../src/ops/snapshot-walk.mjs';

function makeTmpDir() {
  const dir = mkdtempSync(join(tmpdir(), 'cmgr-snaprec-'));
  return { dir, cleanup() { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } } };
}

function writeFileAt(root, rel, content = 'x') {
  const abs = join(root, ...rel.split('/'));
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content);
}

/** A minimal real tree: one file per allowlisted dir + top files. */
function seedTree(root) {
  writeFileAt(root, 'agents/a.md');
  writeFileAt(root, 'skills/s/SKILL.md');
  writeFileAt(root, 'commands/c.md');
  writeFileAt(root, 'hooks/h.mjs');
  writeFileAt(root, 'hud/hud.mjs');
  writeFileAt(root, 'settings.json');
  writeFileAt(root, 'CLAUDE.md');
}

/** True if any emitted path is inside .mgr-state/ or .mgr/. */
function hasMgrPath(files) {
  return files.some((f) => f.startsWith('.mgr-state/') || f === '.mgr-state'
    || f.startsWith('.mgr/') || f === '.mgr');
}

test('a prior snapshot inside .mgr-state/ is NEVER recaptured (no recursive bloat)', () => {
  const { dir, cleanup } = makeTmpDir();
  try {
    seedTree(dir);

    // First walk — baseline (no .mgr-state yet).
    const first = walkSnapshotScope({ targetClaudeDir: dir });
    assert.equal(hasMgrPath(first.files), false, 'baseline: no .mgr-state path');

    // Simulate a PRIOR snapshot's payload sitting inside the tree.
    writeFileAt(dir, '.mgr-state/snapshots/2026-01-01T00-00-00Z/manifest.json');
    writeFileAt(dir, '.mgr-state/snapshots/2026-01-01T00-00-00Z/payload.tar');
    writeFileAt(dir, '.mgr-state/lockfile.json');
    writeFileAt(dir, '.mgr/state.json');

    // Second walk — must still exclude EVERY .mgr-state / .mgr path.
    const second = walkSnapshotScope({ targetClaudeDir: dir });
    assert.equal(hasMgrPath(second.files), false, 'second snapshot did not capture the first');
    // The governed file set is unchanged between the two walks.
    assert.deepStrictEqual(second.files, first.files, 'snapshot scope stable across snapshots');
  } finally {
    cleanup();
  }
});

test('custom mgrStateDirname is honored for self-exclusion', () => {
  const { dir, cleanup } = makeTmpDir();
  try {
    seedTree(dir);
    // Use a non-default state dir name and place a prior snapshot under it.
    writeFileAt(dir, '.my-state/snapshots/snap/payload.tar');
    const { files } = walkSnapshotScope({ targetClaudeDir: dir, mgrStateDirname: '.my-state' });
    assert.equal(files.some((f) => f.startsWith('.my-state')), false,
      'parameterized state dir excluded');
  } finally {
    cleanup();
  }
});

test('empty / non-string mgrStateDirname falls back to .mgr-state exclusion', () => {
  const { dir, cleanup } = makeTmpDir();
  try {
    seedTree(dir);
    writeFileAt(dir, '.mgr-state/snapshots/snap/payload.tar');
    for (const bad of ['', null, undefined, 42]) {
      const { files } = walkSnapshotScope({ targetClaudeDir: dir, mgrStateDirname: bad });
      assert.equal(hasMgrPath(files), false, `bad mgrStateDirname ${String(bad)} still excludes .mgr-state`);
    }
  } finally {
    cleanup();
  }
});

test('a symlinked subdir under an allowlisted dir is NOT followed (no escape)', () => {
  const { dir, cleanup } = makeTmpDir();
  try {
    seedTree(dir);

    // An OUTSIDE dir holding a sentinel that must NEVER be captured via a symlink.
    const outside = join(dir, '..', `cmgr-outside-${Date.now()}`);
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'SECRET-OUTSIDE.md'), 'must not be captured');

    let symlinked = false;
    try {
      // Create skills/linkdir -> outside (junction-style). May throw without
      // Developer Mode / permission → gracefully skip the symlink assertion.
      symlinkSync(outside, join(dir, 'skills', 'linkdir'), 'dir');
      symlinked = true;
    } catch {
      symlinked = false;
    }

    const { files } = walkSnapshotScope({ targetClaudeDir: dir });
    // Regardless of whether the symlink was created, the sentinel must be absent.
    assert.equal(files.some((f) => f.includes('SECRET-OUTSIDE')), false,
      'symlink target content not captured');
    if (symlinked) {
      // The symlink itself is a directory symlink → isSymbolicLink() short-circuits
      // before descent, so nothing under skills/linkdir is emitted.
      assert.equal(files.some((f) => f.startsWith('skills/linkdir')), false,
        'symlinked subdir not descended');
    }

    try { rmSync(outside, { recursive: true, force: true }); } catch { /* ignore */ }
  } finally {
    cleanup();
  }
});

test('a symlinked WALK_DIR ROOT (skills/ -> outside) is NOT followed (no escape, no secret leak)', () => {
  const { dir, cleanup } = makeTmpDir();
  try {
    // A legitimate sibling dir provides a real file to prove the walk still works.
    writeFileAt(dir, 'agents/a.md');

    // An OUTSIDE dir holding a sentinel + an SSH-key-named file that must NEVER be
    // captured by following a symlinked root.
    const outside = join(dir, '..', `cmgr-outside-root-${Date.now()}`);
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'STOLEN-SECRET.md'), 'must not be captured');
    writeFileSync(join(outside, 'id_rsa'), 'must not be captured');

    let symlinked = false;
    try {
      // skills/ ITSELF is the symlink (a WALK_DIR root), pointing outside the tree.
      symlinkSync(outside, join(dir, 'skills'), 'dir');
      symlinked = true;
    } catch {
      symlinked = false;
    }

    const { files } = walkSnapshotScope({ targetClaudeDir: dir });
    // Regardless of whether the symlink was created, no outside content leaks.
    assert.equal(files.some((f) => f.includes('STOLEN-SECRET')), false,
      'outside sentinel not captured via symlinked root');
    assert.equal(files.some((f) => f.endsWith('id_rsa')), false,
      'outside SSH-key-named file not captured via symlinked root');
    if (symlinked) {
      // The symlinked root is rejected by lstat → nothing under skills/ is emitted.
      assert.equal(files.some((f) => f.startsWith('skills/')), false,
        'symlinked WALK_DIR root not descended');
    }
    assert.ok(files.includes('agents/a.md'), 'real sibling file still captured');

    try { rmSync(outside, { recursive: true, force: true }); } catch { /* ignore */ }
  } finally {
    cleanup();
  }
});

test('a symlinked WALK_DIR ROOT (hooks/ -> .mgr-state) does NOT recapture a prior snapshot', () => {
  const { dir, cleanup } = makeTmpDir();
  try {
    writeFileAt(dir, 'agents/a.md');
    // A prior snapshot's payload sits inside .mgr-state/.
    writeFileAt(dir, '.mgr-state/snapshots/prev/payload.tar');

    let symlinked = false;
    try {
      // hooks/ ITSELF is a symlink pointing at the self-excluded .mgr-state dir —
      // following it would archive a PRIOR snapshot (the recursive-bloat invariant).
      symlinkSync(join(dir, '.mgr-state'), join(dir, 'hooks'), 'dir');
      symlinked = true;
    } catch {
      symlinked = false;
    }

    const { files } = walkSnapshotScope({ targetClaudeDir: dir });
    // The .mgr-state payload must never appear — not directly, nor via hooks/.
    assert.equal(hasMgrPath(files), false, 'no .mgr-state path emitted');
    if (symlinked) {
      assert.equal(files.some((f) => f.startsWith('hooks/')), false,
        'symlinked hooks/ root (-> .mgr-state) not descended');
      assert.equal(files.some((f) => f.includes('payload.tar')), false,
        'prior snapshot payload not recaptured via symlinked root');
    }
    assert.ok(files.includes('agents/a.md'), 'real sibling file still captured');
  } finally {
    cleanup();
  }
});

test('a symlinked top-level file (e.g. settings.json) is NOT captured', () => {
  const { dir, cleanup } = makeTmpDir();
  try {
    writeFileAt(dir, 'agents/a.md'); // something legitimate to capture
    const realTarget = join(dir, '..', `cmgr-real-settings-${Date.now()}.json`);
    writeFileSync(realTarget, '{}');

    let symlinked = false;
    try {
      symlinkSync(realTarget, join(dir, 'settings.json'), 'file');
      symlinked = true;
    } catch {
      symlinked = false;
    }

    const { files } = walkSnapshotScope({ targetClaudeDir: dir });
    if (symlinked) {
      assert.equal(files.includes('settings.json'), false,
        'symlinked settings.json not captured (lstat: symlink, not a file)');
    }
    assert.ok(files.includes('agents/a.md'), 'real file still captured');

    try { rmSync(realTarget, { force: true }); } catch { /* ignore */ }
  } finally {
    cleanup();
  }
});
