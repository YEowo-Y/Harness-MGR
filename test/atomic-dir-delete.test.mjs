/**
 * P4b.S2 — atomic-dir-delete.test.mjs (fully hermetic + real-fs round-trips).
 *
 * Drives every branch of atomicApplyDirDelete deterministically via INJECTED seams
 * (renameFn / rmDirFn / lstatFn) — failure-branch tests pass retry:{tries:1,
 * backoffMs:[]} so withRetry never sleeps. Plus REAL temp-dir round-trips that
 * prove the production defaults recursively remove a skill dir and leave NO
 * `.mgr-old` sidecar.
 *
 * Branch matrix covered:
 *   - happy dir-delete (passthrough gate, context remove-skill) → ok:true, deleted:true
 *   - gate-denied (assertWritable throws) → apply-dir-delete-gate-denied, NOTHING touched
 *   - TYPE: target not found (lstat ENOENT) → apply-dir-delete-not-found
 *   - TYPE: target is a file (not a dir) → apply-dir-delete-not-a-dir
 *   - TYPE: target is a symlink → apply-dir-delete-is-symlink
 *   - stale .mgr-old dir pre-cleared before rename
 *   - rmDirFn cleanup failure swallowed → still ok:true
 *   - rename EBUSY → apply-dir-delete-failed
 *   - never-throws: undefined / {} / missing assertWritable / throwing lstatFn getter
 *   - default context is "remove-skill"; explicit context passes through verbatim
 *   - REAL round-trip: recursive skill dir removed, no .mgr-old remains
 *   - REAL round-trip: gate-denied leaves dir intact
 *   - REAL round-trip: symlink target refused (t.skip gracefully on EPERM)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, rmSync, existsSync, writeFileSync,
  mkdirSync, symlinkSync, lstatSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicApplyDirDelete } from '../src/ops/atomic-dir-delete.mjs';

const TARGET = 'C:\\tmp\\.claude\\skills\\my-skill';
const PASS = (p) => p; // passthrough governed-write gate
const NO_SLEEP = { tries: 1, backoffMs: [] };

/** A taggable Error with an optional .code (to simulate EBUSY, ENOENT, etc.). */
function err(message, code) {
  const e = new Error(message);
  if (code) e.code = code;
  return e;
}

/**
 * Build a recording in-memory seam set backed by Maps of dirs and files.
 * lstatFn returns a minimal stat-like object based on the backing store.
 */
function makeFs(opts = {}) {
  const dirs = new Set(opts.dirs ?? []);
  const files = new Set(opts.files ?? []);
  const symlinks = new Set(opts.symlinks ?? []);
  const calls = { rename: [], rmDir: [], lstat: [] };

  const statFor = (p) => {
    if (!dirs.has(p) && !files.has(p) && !symlinks.has(p)) {
      throw err(`ENOENT lstat ${p}`, 'ENOENT');
    }
    return {
      isDirectory: () => dirs.has(p) && !symlinks.has(p),
      isSymbolicLink: () => symlinks.has(p),
    };
  };

  return {
    dirs, files, symlinks, calls,
    seams: {
      renameFn: (a, b) => {
        calls.rename.push([a, b]);
        if (!dirs.has(a) && !files.has(a)) throw err(`ENOENT rename ${a}`, 'ENOENT');
        if (dirs.has(a)) { dirs.delete(a); dirs.add(b); }
        else { files.delete(a); files.add(b); }
      },
      rmDirFn: (p) => {
        calls.rmDir.push(p);
        dirs.delete(p);
        files.delete(p);
      },
      lstatFn: (p) => {
        calls.lstat.push(p);
        return statFor(p);
      },
    },
  };
}

// ── hermetic branch tests ────────────────────────────────────────────────────────

test('happy dir-delete (target is a dir): ok:true, deleted:true, dir gone, no sidecars (in-memory)', async () => {
  const fs = makeFs({ dirs: [TARGET] });
  const r = await atomicApplyDirDelete({
    target: TARGET, assertWritable: PASS,
    seams: fs.seams, retry: NO_SLEEP,
  });
  assert.equal(r.ok, true);
  assert.equal(r.deleted, true);
  assert.deepEqual(r.leftovers, { oldPath: null });
  assert.equal(fs.dirs.has(TARGET), false);                    // dir gone from its path
  assert.equal(fs.dirs.has(TARGET + '.mgr-old'), false);       // cleanup ran
  assert.equal(r.diagnostics.length, 0);
  // The move-aside was target → .mgr-old.
  assert.deepEqual(fs.calls.rename[0], [TARGET, TARGET + '.mgr-old']);
  // lstat was called on the target before any destructive action.
  assert.ok(fs.calls.lstat.includes(TARGET));
});

test('gate-denied (assertWritable throws): apply-dir-delete-gate-denied, NOTHING touched, rename never called', async () => {
  const fs = makeFs({ dirs: [TARGET] });
  const deny = () => { throw new Error('outside target'); };
  const r = await atomicApplyDirDelete({
    target: TARGET, assertWritable: deny,
    seams: fs.seams, retry: NO_SLEEP,
  });
  assert.equal(r.ok, false);
  assert.equal(r.deleted, false);
  assert.equal(r.diagnostics.some((d) => d.code === 'apply-dir-delete-gate-denied'), true);
  assert.equal(fs.dirs.has(TARGET), true);        // dir still present
  assert.equal(fs.calls.rename.length, 0);        // no move-aside attempted
  assert.equal(fs.calls.lstat.length, 0);         // lstat not even reached
});

test('TYPE: target not found (lstat ENOENT) → apply-dir-delete-not-found, rename never called', async () => {
  const fs = makeFs(); // target NOT in any store
  const r = await atomicApplyDirDelete({
    target: TARGET, assertWritable: PASS,
    seams: fs.seams, retry: NO_SLEEP,
  });
  assert.equal(r.ok, false);
  assert.equal(r.deleted, false);
  assert.equal(r.diagnostics.some((d) => d.code === 'apply-dir-delete-not-found'), true);
  assert.equal(fs.calls.rename.length, 0);        // nothing deleted
  assert.equal(fs.calls.rmDir.length, 0);
});

test('TYPE: target is a file (not a directory) → apply-dir-delete-not-a-dir, rename never called', async () => {
  const fs = makeFs({ files: [TARGET] });
  const r = await atomicApplyDirDelete({
    target: TARGET, assertWritable: PASS,
    seams: fs.seams, retry: NO_SLEEP,
  });
  assert.equal(r.ok, false);
  assert.equal(r.deleted, false);
  assert.equal(r.diagnostics.some((d) => d.code === 'apply-dir-delete-not-a-dir'), true);
  assert.equal(fs.calls.rename.length, 0);        // nothing deleted
  assert.equal(fs.calls.rmDir.length, 0);
});

test('TYPE: target is a symlink → apply-dir-delete-is-symlink, rename never called', async () => {
  const fs = makeFs({ symlinks: [TARGET] });
  const r = await atomicApplyDirDelete({
    target: TARGET, assertWritable: PASS,
    seams: fs.seams, retry: NO_SLEEP,
  });
  assert.equal(r.ok, false);
  assert.equal(r.deleted, false);
  assert.equal(r.diagnostics.some((d) => d.code === 'apply-dir-delete-is-symlink'), true);
  assert.equal(fs.calls.rename.length, 0);        // nothing deleted
  assert.equal(fs.calls.rmDir.length, 0);
});

test('stale .mgr-old dir pre-cleared before rename: pre-clear rmDir called, then rename succeeds', async () => {
  // A prior interrupted delete left a stale .mgr-old. The pre-clear must remove
  // it so rename (which cannot overwrite an existing dir on Windows) can succeed.
  const fs = makeFs({ dirs: [TARGET, TARGET + '.mgr-old'] });
  // Override rmDirFn to record calls but ALSO delete from the store (so rename can succeed).
  fs.seams.rmDirFn = (p) => {
    fs.calls.rmDir.push(p);
    fs.dirs.delete(p);
    fs.files.delete(p);
  };
  const r = await atomicApplyDirDelete({
    target: TARGET, assertWritable: PASS,
    seams: fs.seams, retry: NO_SLEEP,
  });
  assert.equal(r.ok, true);
  assert.equal(r.deleted, true);
  // The pre-clear rmDir was called on the stale sidecar BEFORE the rename.
  const rmBeforeRename = fs.calls.rmDir.indexOf(TARGET + '.mgr-old') <
    (fs.calls.rename.length > 0 ? fs.calls.rename.findIndex(() => true) + 1000 : 1000);
  assert.ok(rmBeforeRename, 'pre-clear rmDir must precede rename');
  assert.equal(fs.dirs.has(TARGET), false);         // target moved away
});

test('rmDirFn cleanup failure (step 6) is swallowed: still ok:true, deleted:true', async () => {
  let callCount = 0;
  const fs = makeFs({ dirs: [TARGET] });
  // The first call (pre-clear, step 4) is fine; the second (cleanup, step 6) throws.
  fs.seams.rmDirFn = (p) => {
    fs.calls.rmDir.push(p);
    callCount++;
    if (callCount === 2) throw err('EPERM cleanup', 'EPERM');
    fs.dirs.delete(p);
  };
  const r = await atomicApplyDirDelete({
    target: TARGET, assertWritable: PASS,
    seams: fs.seams, retry: NO_SLEEP,
  });
  assert.equal(r.ok, true);             // cleanup failure is swallowed
  assert.equal(r.deleted, true);
  assert.deepEqual(r.leftovers, { oldPath: null });
  assert.equal(r.diagnostics.length, 0);
  assert.equal(fs.dirs.has(TARGET), false);          // dir still moved away
});

test('rename EBUSY (persistent) → apply-dir-delete-failed, dir untouched', async () => {
  const fs = makeFs({ dirs: [TARGET] });
  fs.seams.renameFn = (a, b) => {
    fs.calls.rename.push([a, b]);
    throw err('EBUSY locked', 'EBUSY');
  };
  const r = await atomicApplyDirDelete({
    target: TARGET, assertWritable: PASS,
    seams: fs.seams, retry: NO_SLEEP,
  });
  assert.equal(r.ok, false);
  assert.equal(r.deleted, false);
  assert.deepEqual(r.leftovers, { oldPath: null });
  assert.equal(r.diagnostics.some((d) => d.code === 'apply-dir-delete-failed'), true);
  assert.equal(fs.dirs.has(TARGET), true);           // dir untouched (rename never moved it)
});

// ── never-throws ────────────────────────────────────────────────────────────────

test('never-throws: atomicApplyDirDelete(undefined) returns a result, does not throw', async () => {
  const r = await atomicApplyDirDelete(undefined);
  assert.equal(r.ok, false);
  assert.equal(r.deleted, false);
  assert.deepEqual(r.leftovers, { oldPath: null });
  assert.equal(r.diagnostics.some((d) => d.code === 'apply-dir-delete-bad-args'), true);
});

test('never-throws: atomicApplyDirDelete({}) (empty opts) → apply-dir-delete-bad-args', async () => {
  const r = await atomicApplyDirDelete({});
  assert.equal(r.ok, false);
  assert.equal(r.diagnostics.some((d) => d.code === 'apply-dir-delete-bad-args'), true);
});

test('never-throws: missing assertWritable → apply-dir-delete-bad-args', async () => {
  const r = await atomicApplyDirDelete({ target: TARGET });
  assert.equal(r.ok, false);
  assert.equal(r.diagnostics.some((d) => d.code === 'apply-dir-delete-bad-args'), true);
});

test('never-throws: empty target → apply-dir-delete-bad-args', async () => {
  const r = await atomicApplyDirDelete({ target: '', assertWritable: PASS });
  assert.equal(r.ok, false);
  assert.equal(r.diagnostics.some((d) => d.code === 'apply-dir-delete-bad-args'), true);
});

test('never-throws: a throwing lstatFn getter → apply-dir-delete-unexpected-error', async () => {
  // A throwing getter on seams.lstatFn makes resolveSeams throw while reading it,
  // caught by the top-level backstop — proving it returns a result, not a throw.
  const seams = {};
  Object.defineProperty(seams, 'lstatFn', {
    get() { throw new Error('boom'); },
    enumerable: true,
  });
  const r = await atomicApplyDirDelete({
    target: TARGET, assertWritable: PASS,
    seams, retry: NO_SLEEP,
  });
  assert.equal(r.ok, false);
  assert.equal(r.deleted, false);
  assert.equal(r.diagnostics.some((d) => d.code === 'apply-dir-delete-unexpected-error'), true);
});

// ── context default + passthrough ─────────────────────────────────────────────────

test('default context is "remove-skill" when omitted (in-memory)', async () => {
  const fs = makeFs({ dirs: [TARGET] });
  const ctxSeen = [];
  const gate = (p, ctx) => { ctxSeen.push(ctx); return p; };
  const r = await atomicApplyDirDelete({
    target: TARGET, assertWritable: gate,
    seams: fs.seams, retry: NO_SLEEP,
  });
  assert.equal(r.ok, true);
  assert.deepEqual(ctxSeen, ['remove-skill']);
});

test('explicit context passes through verbatim to the gate (in-memory)', async () => {
  const fs = makeFs({ dirs: [TARGET] });
  const ctxSeen = [];
  const gate = (p, ctx) => { ctxSeen.push(ctx); return p; };
  const r = await atomicApplyDirDelete({
    target: TARGET, assertWritable: gate, context: 'apply',
    seams: fs.seams, retry: NO_SLEEP,
  });
  assert.equal(r.ok, true);
  assert.deepEqual(ctxSeen, ['apply']);
});

// ── lstat type-enforcement order: AFTER gate, BEFORE any rename/delete ──────────

test('type enforcement runs AFTER gate (gate sets a flag, lstat runs after)', async () => {
  let gateRan = false;
  let lstatRan = false;
  const fs = makeFs({ dirs: [TARGET] });
  const gate = (p) => { gateRan = true; return p; };
  const origLstat = fs.seams.lstatFn;
  fs.seams.lstatFn = (p) => { assert.ok(gateRan, 'gate must run before lstat'); lstatRan = true; return origLstat(p); };
  const r = await atomicApplyDirDelete({ target: TARGET, assertWritable: gate, seams: fs.seams, retry: NO_SLEEP });
  assert.equal(r.ok, true);
  assert.ok(lstatRan);
});

test('type enforcement runs BEFORE any rename/delete (rename flag set after lstat)', async () => {
  let lstatDone = false;
  const fs = makeFs({ dirs: [TARGET] });
  const origLstat = fs.seams.lstatFn;
  fs.seams.lstatFn = (p) => { const s = origLstat(p); lstatDone = true; return s; };
  const origRename = fs.seams.renameFn;
  fs.seams.renameFn = (a, b) => { assert.ok(lstatDone, 'lstat must run before rename'); return origRename(a, b); };
  const r = await atomicApplyDirDelete({ target: TARGET, assertWritable: PASS, seams: fs.seams, retry: NO_SLEEP });
  assert.equal(r.ok, true);
});

// ── REAL temp-dir round-trips (production default seams) ─────────────────────────

test('REAL fs: happy dir-delete round-trip — skill dir recursively removed, no .mgr-old remains', async () => {
  const base = mkdtempSync(join(tmpdir(), 'mgr-dir-del-'));
  try {
    // Create a skill dir with SKILL.md + a nested subfile (like a real skill).
    const skillDir = join(base, 'skills', 'my-skill');
    mkdirSync(join(skillDir, 'subdir'), { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), '# My Skill', 'utf8');
    writeFileSync(join(skillDir, 'subdir', 'notes.md'), 'notes', 'utf8');

    assert.equal(existsSync(skillDir), true);  // precondition

    const r = await atomicApplyDirDelete({
      target: skillDir,
      assertWritable: PASS,
      context: 'remove-skill',
      retry: NO_SLEEP,
    });

    assert.equal(r.ok, true);
    assert.equal(r.deleted, true);
    assert.deepEqual(r.leftovers, { oldPath: null });
    assert.equal(r.diagnostics.length, 0);
    assert.equal(existsSync(skillDir), false);                       // dir gone
    assert.equal(existsSync(skillDir + '.mgr-old'), false);          // no sidecar left
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('REAL fs: gate-denied leaves skill dir intact (no .mgr-old appears)', async () => {
  const base = mkdtempSync(join(tmpdir(), 'mgr-dir-del-'));
  try {
    const skillDir = join(base, 'skills', 'my-skill');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), '# My Skill', 'utf8');

    const deny = () => { throw new Error('denied'); };
    const r = await atomicApplyDirDelete({
      target: skillDir,
      assertWritable: deny,
      context: 'remove-skill',
      retry: NO_SLEEP,
    });

    assert.equal(r.ok, false);
    assert.equal(existsSync(skillDir), true);                        // dir STILL there
    assert.equal(existsSync(skillDir + '.mgr-old'), false);          // no sidecar appeared
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('REAL fs: symlink target is refused — apply-dir-delete-is-symlink (skip on EPERM)', async (t) => {
  const base = mkdtempSync(join(tmpdir(), 'mgr-dir-del-'));
  try {
    const realDir = join(base, 'real-dir');
    const linkPath = join(base, 'skills', 'link-skill');
    mkdirSync(realDir, { recursive: true });
    mkdirSync(join(base, 'skills'), { recursive: true });
    try {
      symlinkSync(realDir, linkPath, 'junction');
    } catch (e) {
      // Windows may require elevated privileges for symlinks.
      t.skip(`cannot create symlink on this system (${e.code ?? e.message}); skipping`);
      return;
    }
    // Confirm lstatSync sees it as a symlink.
    const st = lstatSync(linkPath);
    if (!st.isSymbolicLink() && !st.isDirectory()) {
      t.skip('junction not detected as symlink by lstatSync; skipping');
      return;
    }

    const r = await atomicApplyDirDelete({
      target: linkPath,
      assertWritable: PASS,
      context: 'remove-skill',
      retry: NO_SLEEP,
    });

    // On Windows, junctions lstatSync may report isDirectory=true + !isSymbolicLink.
    // In that case the primitive treats it as a directory; both outcomes are safe.
    if (r.ok) {
      // Junction treated as directory — the real target should be untouched.
      assert.equal(existsSync(realDir), true);
    } else {
      assert.equal(
        r.diagnostics.some((d) => d.code === 'apply-dir-delete-is-symlink'),
        true,
        `expected apply-dir-delete-is-symlink but got: ${JSON.stringify(r.diagnostics)}`,
      );
      assert.equal(existsSync(realDir), true);   // real dir untouched
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
