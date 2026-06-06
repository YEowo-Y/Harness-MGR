/**
 * P4a.U1b — atomic-delete.test.mjs (fully hermetic).
 *
 * Drives every branch of atomicApplyDelete deterministically via INJECTED seams
 * (renameFn / rmFn) — failure-branch tests pass retry:{tries:1, backoffMs:[]} so
 * withRetry never sleeps. Plus a couple of REAL temp-dir round-trips (mkdtempSync
 * under os.tmpdir, cleaned up in finally) that prove the production defaults remove
 * a file and leave NO `.mgr-old` sidecar.
 *
 * Branch matrix covered:
 *   - happy DELETE (target exists)            → ok:true, deleted:true, no sidecars
 *   - gate-denied (assertWritable throws)     → apply-delete-gate-denied, NOTHING touched
 *   - rename-fail: absent target (ENOENT)     → apply-delete-failed, deleted:false
 *   - rename-fail: persistent EBUSY           → apply-delete-failed, target untouched
 *   - stale .mgr-old clobbered                → backup holds the REAL prior bytes
 *   - best-effort cleanup swallows a failing rm → still ok:true, deleted:true
 *   - never-throws on bad args + a throwing seam
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicApplyDelete } from '../src/ops/atomic-delete.mjs';

const TARGET = 'C:\\tmp\\.claude\\agents\\foo.md';
const PASS = (p) => p; // passthrough governed-write gate
const NO_SLEEP = { tries: 1, backoffMs: [] };

/** A taggable Error with an optional .code (so we can simulate EBUSY etc.). */
function err(message, code) {
  const e = new Error(message);
  if (code) e.code = code;
  return e;
}

/**
 * Build a recording in-memory fs seam set over a backing Map<path,content>.
 * Each op records its calls; tests reassign a seam to force a specific op to throw.
 */
function makeFs(initial = {}) {
  const store = new Map(Object.entries(initial));
  const calls = { rename: [], rm: [] };
  return {
    store, calls,
    seams: {
      renameFn: (a, b) => {
        calls.rename.push([a, b]);
        if (!store.has(a)) throw err(`ENOENT rename ${a}`, 'ENOENT');
        store.set(b, store.get(a)); // rename-replace clobbers any stale dest
        store.delete(a);
      },
      rmFn: (p) => { calls.rm.push(p); store.delete(p); },
    },
  };
}

// ── hermetic branch tests ────────────────────────────────────────────────────────

test('happy DELETE (target exists): ok:true, deleted:true, target gone, no sidecars (in-memory)', async () => {
  const fs = makeFs({ [TARGET]: 'content' });
  const r = await atomicApplyDelete({ target: TARGET, assertWritable: PASS, seams: fs.seams, retry: NO_SLEEP });
  assert.equal(r.ok, true);
  assert.equal(r.deleted, true);
  assert.deepEqual(r.leftovers, { oldPath: null });
  assert.equal(fs.store.has(TARGET), false);                 // target gone from its path
  assert.equal(fs.store.has(TARGET + '.mgr-old'), false);    // cleanup ran
  assert.equal(r.diagnostics.length, 0);
  // the move-aside was target → .mgr-old.
  assert.deepEqual(fs.calls.rename[0], [TARGET, TARGET + '.mgr-old']);
});

test('gate-denied (assertWritable throws): apply-delete-gate-denied, NOTHING touched, rename never called', async () => {
  const fs = makeFs({ [TARGET]: 'content' });
  const deny = () => { throw new Error('outside target'); };
  const r = await atomicApplyDelete({ target: TARGET, assertWritable: deny, seams: fs.seams, retry: NO_SLEEP });
  assert.equal(r.ok, false);
  assert.equal(r.deleted, false);
  assert.equal(r.diagnostics.some((d) => d.code === 'apply-delete-gate-denied'), true);
  assert.equal(fs.store.get(TARGET), 'content');             // target still present
  assert.equal(fs.calls.rename.length, 0);                   // no move-aside attempted
});

test('rename-fail: absent target (ENOENT) → apply-delete-failed, deleted:false, no leftovers (in-memory)', async () => {
  const fs = makeFs(); // target NOT in store
  const r = await atomicApplyDelete({ target: TARGET, assertWritable: PASS, seams: fs.seams, retry: NO_SLEEP });
  assert.equal(r.ok, false);
  assert.equal(r.deleted, false);
  assert.deepEqual(r.leftovers, { oldPath: null });
  assert.equal(r.diagnostics.some((d) => d.code === 'apply-delete-failed'), true);
});

test('rename-fail: persistent EBUSY → apply-delete-failed, target untouched (in-memory)', async () => {
  const fs = makeFs({ [TARGET]: 'content' });
  fs.seams.renameFn = (a, b) => { fs.calls.rename.push([a, b]); throw err('EBUSY locked', 'EBUSY'); };
  const r = await atomicApplyDelete({ target: TARGET, assertWritable: PASS, seams: fs.seams, retry: NO_SLEEP });
  assert.equal(r.ok, false);
  assert.equal(r.deleted, false);
  assert.deepEqual(r.leftovers, { oldPath: null });
  assert.equal(r.diagnostics.some((d) => d.code === 'apply-delete-failed'), true);
  assert.equal(fs.store.get(TARGET), 'content');             // target untouched
});

test('stale .mgr-old from a prior crash is clobbered by the move-aside (in-memory)', async () => {
  // A prior interrupted op left a stale .mgr-old on disk. The move-aside must
  // clobber it with the REAL current target bytes — never trusting stale bytes.
  const fs = makeFs({ [TARGET]: 'real', [TARGET + '.mgr-old']: 'STALE' });
  // rm records but does NOT delete, so we can inspect what the move-aside captured.
  fs.seams.rmFn = (p) => { fs.calls.rm.push(p); };
  const r = await atomicApplyDelete({ target: TARGET, assertWritable: PASS, seams: fs.seams, retry: NO_SLEEP });
  assert.equal(r.ok, true);
  assert.equal(r.deleted, true);
  assert.equal(fs.store.has(TARGET), false);                          // target moved away
  assert.equal(fs.store.get(TARGET + '.mgr-old'), 'real');            // REAL bytes clobbered STALE
  assert.equal(fs.calls.rm.includes(TARGET + '.mgr-old'), true);      // success-path cleanup targeted the sidecar
});

test('best-effort cleanup swallows a failing rm: still ok:true, deleted:true (in-memory)', async () => {
  const fs = makeFs({ [TARGET]: 'content' });
  fs.seams.rmFn = (p) => { fs.calls.rm.push(p); throw err('EPERM rm', 'EPERM'); };
  const r = await atomicApplyDelete({ target: TARGET, assertWritable: PASS, seams: fs.seams, retry: NO_SLEEP });
  assert.equal(r.ok, true);                                   // rm failure is swallowed
  assert.equal(r.deleted, true);
  assert.deepEqual(r.leftovers, { oldPath: null });           // not surfaced as a leftover
  assert.equal(r.diagnostics.length, 0);
  assert.equal(fs.store.has(TARGET), false);                  // target still moved away (deleted)
});

// ── never-throws ────────────────────────────────────────────────────────────────

test('never-throws: missing assertWritable → apply-delete-bad-args', async () => {
  const r = await atomicApplyDelete({ target: TARGET });
  assert.equal(r.ok, false);
  assert.equal(r.deleted, false);
  assert.equal(r.diagnostics.some((d) => d.code === 'apply-delete-bad-args'), true);
});

test('never-throws: empty target → apply-delete-bad-args', async () => {
  const r = await atomicApplyDelete({ target: '', assertWritable: PASS });
  assert.equal(r.ok, false);
  assert.equal(r.diagnostics.some((d) => d.code === 'apply-delete-bad-args'), true);
});

test('never-throws: atomicApplyDelete(undefined) returns a result, does not throw', async () => {
  const r = await atomicApplyDelete(undefined);
  assert.equal(r.ok, false);
  assert.equal(r.deleted, false);
  assert.deepEqual(r.leftovers, { oldPath: null });
  assert.equal(r.diagnostics.some((d) => d.code === 'apply-delete-bad-args'), true);
});

test('never-throws: a throwing seams getter becomes apply-delete-unexpected-error', async () => {
  // A throwing getter on seams.renameFn makes resolveSeams throw while reading it,
  // so the failure happens AFTER the gate (a non-fs step) and is caught by the
  // top-level backstop — proving it returns a result, not a throw.
  const seams = {};
  Object.defineProperty(seams, 'renameFn', { get() { throw new Error('boom'); }, enumerable: true });
  const r = await atomicApplyDelete({ target: TARGET, assertWritable: PASS, seams, retry: NO_SLEEP });
  assert.equal(r.ok, false);
  assert.equal(r.deleted, false);
  assert.equal(r.diagnostics.some((d) => d.code === 'apply-delete-unexpected-error'), true);
});

// ── REAL temp-dir round-trips (production default seams) ──────────────────────────

test('REAL fs: happy delete round-trip, file removed, no .mgr-old remains', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mgr-atomic-del-'));
  try {
    const target = join(dir, 'agents', 'foo.md');
    mkdirSync(join(dir, 'agents'), { recursive: true });
    writeFileSync(target, 'agent body', 'utf8');
    assert.equal(existsSync(target), true); // precondition
    const r = await atomicApplyDelete({ target, assertWritable: PASS, context: 'remove', retry: NO_SLEEP });
    assert.equal(r.ok, true);
    assert.equal(r.deleted, true);
    assert.equal(existsSync(target), false);             // file gone
    assert.equal(existsSync(target + '.mgr-old'), false); // no sidecar left
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('REAL fs: gate-denied deletes NOTHING (file still present, no .mgr-old)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mgr-atomic-del-'));
  try {
    const target = join(dir, 'agents', 'foo.md');
    mkdirSync(join(dir, 'agents'), { recursive: true });
    writeFileSync(target, 'agent body', 'utf8');
    const deny = () => { throw new Error('denied'); };
    const r = await atomicApplyDelete({ target, assertWritable: deny, context: 'remove', retry: NO_SLEEP });
    assert.equal(r.ok, false);
    assert.equal(existsSync(target), true);              // file STILL there
    assert.equal(existsSync(target + '.mgr-old'), false); // no sidecar appeared
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── context default + passthrough ─────────────────────────────────────────────────

test('default context is "remove" when omitted (in-memory)', async () => {
  const fs = makeFs({ [TARGET]: 'content' });
  const ctxSeen = [];
  const gate = (p, ctx) => { ctxSeen.push(ctx); return p; };
  const r = await atomicApplyDelete({ target: TARGET, assertWritable: gate, seams: fs.seams, retry: NO_SLEEP });
  assert.equal(r.ok, true);
  assert.deepEqual(ctxSeen, ['remove']); // the delete-specific default
});

test('explicit context passes through verbatim to the gate (in-memory)', async () => {
  const fs = makeFs({ [TARGET]: 'content' });
  const ctxSeen = [];
  const gate = (p, ctx) => { ctxSeen.push(ctx); return p; };
  const r = await atomicApplyDelete({ target: TARGET, assertWritable: gate, context: 'apply', seams: fs.seams, retry: NO_SLEEP });
  assert.equal(r.ok, true);
  assert.deepEqual(ctxSeen, ['apply']); // passed through, not overridden
});
