/**
 * P3.U13 sub-unit B — atomic-write.test.mjs (fully hermetic).
 *
 * Drives every branch of atomicApplyWrite deterministically via INJECTED seams
 * (writeFn / renameFn / existsFn / rmFn) — failure-branch tests pass
 * retry:{tries:1, backoffMs:[]} so withRetry never sleeps. Plus a couple of REAL
 * temp-dir round-trips (mkdtempSync under os.tmpdir, cleaned up in finally) that
 * prove the production defaults create/overwrite a file and leave NO sidecars.
 *
 * Failure-branch matrix covered:
 *   - happy CREATE (no prior target)         → ok:true, file has content, no sidecars
 *   - happy OVERWRITE (prior target)         → ok:true, new content, backup cleaned up
 *   - gate-denied (assertWritable throws)    → apply-write-gate-denied, NOTHING written
 *   - staging-fail (writeFn throws)          → apply-write-staging-failed, target untouched
 *   - backup-fail (1st rename throws)        → apply-write-backup-failed, target untouched, .mgr-new cleaned
 *   - commit-fail + restore OK               → apply-write-commit-failed, ORIGINAL content, no leftovers
 *   - commit-fail + restore FAILS            → apply-write-commit-unrecoverable, leftovers={new,old}
 *   - never-throws on a throwing seam + bad args
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicApplyWrite } from '../src/ops/atomic-write.mjs';

const TARGET = 'C:\\tmp\\.claude\\settings.json';
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
 * Each op records its calls; `throwOn` lets a test force a specific op to throw.
 *   throwOn: { write?, renameTo?(b)=>bool|throwValue, rename?(a,b), exists?, rm? }
 */
function makeFs(initial = {}) {
  const store = new Map(Object.entries(initial));
  const calls = { write: [], rename: [], exists: [], rm: [] };
  return {
    store, calls,
    seams: {
      writeFn: (p, c) => { calls.write.push([p, c]); store.set(p, c); },
      renameFn: (a, b) => {
        calls.rename.push([a, b]);
        if (!store.has(a)) throw err(`ENOENT rename ${a}`, 'ENOENT');
        store.set(b, store.get(a));
        store.delete(a);
      },
      existsFn: (p) => { calls.exists.push(p); return store.has(p); },
      rmFn: (p) => { calls.rm.push(p); store.delete(p); },
    },
  };
}

// ── hermetic branch tests ────────────────────────────────────────────────────────

test('happy CREATE (no prior target): writes content, ok:true, no sidecars (in-memory)', async () => {
  const fs = makeFs();
  const r = await atomicApplyWrite({ target: TARGET, content: 'new', assertWritable: PASS, seams: fs.seams, retry: NO_SLEEP });
  assert.equal(r.ok, true);
  assert.equal(r.wrote, true);
  assert.deepEqual(r.leftovers, { newPath: null, oldPath: null });
  assert.equal(fs.store.get(TARGET), 'new');
  assert.equal(fs.store.has(TARGET + '.mgr-new'), false);
  assert.equal(fs.store.has(TARGET + '.mgr-old'), false);
  assert.equal(r.diagnostics.length, 0);
});

test('happy OVERWRITE (prior target): backs up then replaces, backup cleaned, no leftovers', async () => {
  const fs = makeFs({ [TARGET]: 'old' });
  const r = await atomicApplyWrite({ target: TARGET, content: 'new', assertWritable: PASS, seams: fs.seams, retry: NO_SLEEP });
  assert.equal(r.ok, true);
  assert.equal(r.wrote, true);
  assert.deepEqual(r.leftovers, { newPath: null, oldPath: null });
  assert.equal(fs.store.get(TARGET), 'new');
  assert.equal(fs.store.has(TARGET + '.mgr-new'), false);
  assert.equal(fs.store.has(TARGET + '.mgr-old'), false);
  // backup happened (target→old) then commit (new→target).
  assert.deepEqual(fs.calls.rename[0], [TARGET, TARGET + '.mgr-old']);
  assert.deepEqual(fs.calls.rename[1], [TARGET + '.mgr-new', TARGET]);
});

test('gate-denied (assertWritable throws): apply-write-gate-denied, NOTHING written', async () => {
  const fs = makeFs({ [TARGET]: 'old' });
  const deny = () => { throw new Error('outside target'); };
  const r = await atomicApplyWrite({ target: TARGET, content: 'new', assertWritable: deny, seams: fs.seams, retry: NO_SLEEP });
  assert.equal(r.ok, false);
  assert.equal(r.wrote, false);
  assert.equal(r.diagnostics.some((d) => d.code === 'apply-write-gate-denied'), true);
  // No staging happened — newPath does not exist, target unchanged.
  assert.equal(fs.store.has(TARGET + '.mgr-new'), false);
  assert.equal(fs.store.get(TARGET), 'old');
  assert.equal(fs.calls.write.length, 0);
});

test('staging-fail (writeFn throws): apply-write-staging-failed, target untouched, .mgr-new cleaned', async () => {
  const fs = makeFs({ [TARGET]: 'old' });
  fs.seams.writeFn = (p) => { fs.calls.write.push(p); throw err('EBUSY write', 'EBUSY'); };
  const r = await atomicApplyWrite({ target: TARGET, content: 'new', assertWritable: PASS, seams: fs.seams, retry: NO_SLEEP });
  assert.equal(r.ok, false);
  assert.equal(r.wrote, false);
  assert.deepEqual(r.leftovers, { newPath: null, oldPath: null });
  assert.equal(r.diagnostics.some((d) => d.code === 'apply-write-staging-failed'), true);
  assert.equal(fs.store.get(TARGET), 'old');       // target untouched
  assert.equal(fs.store.has(TARGET + '.mgr-new'), false);
  assert.equal(fs.calls.rm.includes(TARGET + '.mgr-new'), true); // best-effort cleanup ran
});

test('backup-fail (rename throws on the backup move only): apply-write-backup-failed, target untouched, .mgr-new cleaned', async () => {
  const fs = makeFs({ [TARGET]: 'old' });
  const realRename = fs.seams.renameFn;
  fs.seams.renameFn = (a, b) => {
    fs.calls.rename.push([a, b]);
    if (a === TARGET) throw err('EPERM backup', 'EPERM'); // fail ONLY the target→old backup
    return realRename(a, b);
  };
  const r = await atomicApplyWrite({ target: TARGET, content: 'new', assertWritable: PASS, seams: fs.seams, retry: NO_SLEEP });
  assert.equal(r.ok, false);
  assert.equal(r.wrote, false);
  assert.deepEqual(r.leftovers, { newPath: null, oldPath: null });
  assert.equal(r.diagnostics.some((d) => d.code === 'apply-write-backup-failed'), true);
  assert.equal(fs.store.get(TARGET), 'old');       // target untouched
  assert.equal(fs.calls.rm.includes(TARGET + '.mgr-new'), true); // staged file cleaned up
});

test('commit-fail + restore OK: apply-write-commit-failed, ORIGINAL content restored, no leftovers', async () => {
  const fs = makeFs({ [TARGET]: 'old' });
  fs.seams.renameFn = (a, b) => {
    fs.calls.rename.push([a, b]);
    if (a === TARGET + '.mgr-new' && b === TARGET) throw err('EBUSY commit', 'EBUSY'); // fail the commit only
    // backup (target→old) and restore (old→target) succeed via the store.
    if (!fs.store.has(a)) throw err(`ENOENT ${a}`, 'ENOENT');
    fs.store.set(b, fs.store.get(a));
    fs.store.delete(a);
  };
  const r = await atomicApplyWrite({ target: TARGET, content: 'new', assertWritable: PASS, seams: fs.seams, retry: NO_SLEEP });
  assert.equal(r.ok, false);
  assert.equal(r.wrote, false);
  assert.deepEqual(r.leftovers, { newPath: null, oldPath: null });
  assert.equal(r.diagnostics.some((d) => d.code === 'apply-write-commit-failed'), true);
  assert.equal(fs.store.get(TARGET), 'old');       // ORIGINAL content restored
  assert.equal(fs.store.has(TARGET + '.mgr-new'), false);
  assert.equal(fs.store.has(TARGET + '.mgr-old'), false);
});

test('commit-fail + restore FAILS: apply-write-commit-unrecoverable, leftovers={new,old} both non-null', async () => {
  const fs = makeFs({ [TARGET]: 'old' });
  fs.seams.renameFn = (a, b) => {
    fs.calls.rename.push([a, b]);
    if (a === TARGET) { // backup target→old succeeds
      fs.store.set(b, fs.store.get(a)); fs.store.delete(a); return;
    }
    // every OTHER rename (commit new→target AND restore old→target) throws
    throw err('EBUSY locked', 'EBUSY');
  };
  const r = await atomicApplyWrite({ target: TARGET, content: 'new', assertWritable: PASS, seams: fs.seams, retry: NO_SLEEP });
  assert.equal(r.ok, false);
  assert.equal(r.wrote, false);
  assert.equal(r.leftovers.newPath, TARGET + '.mgr-new');
  assert.equal(r.leftovers.oldPath, TARGET + '.mgr-old');
  assert.equal(r.diagnostics.some((d) => d.code === 'apply-write-commit-unrecoverable'), true);
  // BOTH sidecars deliberately left on disk; nothing removed.
  assert.equal(fs.store.has(TARGET + '.mgr-new'), true);
  assert.equal(fs.store.has(TARGET + '.mgr-old'), true);
  assert.equal(fs.calls.rm.length, 0);
});

test('commit-fail + NO prior target: apply-write-commit-failed, .mgr-new cleaned, no leftovers', async () => {
  const fs = makeFs(); // no target on disk
  fs.seams.renameFn = (a, b) => {
    fs.calls.rename.push([a, b]);
    throw err('EBUSY commit', 'EBUSY'); // commit (the only rename) fails
  };
  const r = await atomicApplyWrite({ target: TARGET, content: 'new', assertWritable: PASS, seams: fs.seams, retry: NO_SLEEP });
  assert.equal(r.ok, false);
  assert.equal(r.wrote, false);
  assert.deepEqual(r.leftovers, { newPath: null, oldPath: null });
  assert.equal(r.diagnostics.some((d) => d.code === 'apply-write-commit-failed'), true);
  assert.equal(fs.calls.rm.includes(TARGET + '.mgr-new'), true);
});

test('stale sidecars from a prior crash do NOT corrupt a fresh overwrite', async () => {
  // A prior interrupted apply left BOTH sidecars on disk. A new overwrite must
  // clobber them: staging overwrites the stale .mgr-new, and the backup overwrites
  // the stale .mgr-old with the REAL current target — never trusting stale bytes.
  const fs = makeFs({ [TARGET]: 'real-old', [TARGET + '.mgr-new']: 'STALE-NEW', [TARGET + '.mgr-old']: 'STALE-OLD' });
  // rm records but does NOT delete, so we can inspect what the backup captured.
  fs.seams.rmFn = (p) => { fs.calls.rm.push(p); };
  const r = await atomicApplyWrite({ target: TARGET, content: 'new', assertWritable: PASS, seams: fs.seams, retry: NO_SLEEP });
  assert.equal(r.ok, true);
  assert.equal(r.wrote, true);
  assert.equal(fs.store.get(TARGET), 'new');                         // stale .mgr-new did NOT win
  assert.equal(fs.store.get(TARGET + '.mgr-old'), 'real-old');       // backup clobbered STALE-OLD with the REAL prior target
  assert.equal(fs.calls.rm.includes(TARGET + '.mgr-old'), true);     // success-path cleanup targeted the backup
});

// ── never-throws ────────────────────────────────────────────────────────────────

test('never-throws: missing assertWritable → apply-write-bad-args', async () => {
  const r = await atomicApplyWrite({ target: TARGET, content: 'x' });
  assert.equal(r.ok, false);
  assert.equal(r.wrote, false);
  assert.equal(r.diagnostics.some((d) => d.code === 'apply-write-bad-args'), true);
});

test('never-throws: non-string content → apply-write-bad-args, NOTHING written', async () => {
  const fs = makeFs();
  const r = await atomicApplyWrite({ target: TARGET, content: 42, assertWritable: PASS, seams: fs.seams });
  assert.equal(r.ok, false);
  assert.equal(r.diagnostics.some((d) => d.code === 'apply-write-bad-args'), true);
  assert.equal(fs.calls.write.length, 0);
});

test('never-throws: empty target → apply-write-bad-args', async () => {
  const r = await atomicApplyWrite({ target: '', content: 'x', assertWritable: PASS });
  assert.equal(r.ok, false);
  assert.equal(r.diagnostics.some((d) => d.code === 'apply-write-bad-args'), true);
});

test('never-throws: atomicApplyWrite(undefined) returns a result, does not throw', async () => {
  const r = await atomicApplyWrite(undefined);
  assert.equal(r.ok, false);
  assert.equal(r.wrote, false);
  assert.deepEqual(r.leftovers, { newPath: null, oldPath: null });
  assert.equal(r.diagnostics.some((d) => d.code === 'apply-write-bad-args'), true);
});

test('never-throws: a throwing existsFn seam becomes apply-write-unexpected-error', async () => {
  const fs = makeFs({ [TARGET]: 'old' });
  fs.seams.existsFn = () => { throw new Error('boom'); };
  const r = await atomicApplyWrite({ target: TARGET, content: 'new', assertWritable: PASS, seams: fs.seams, retry: NO_SLEEP });
  assert.equal(r.ok, false);
  // staging succeeds, then existsFn throws → caught by the top-level backstop.
  assert.equal(r.diagnostics.some((d) => d.code === 'apply-write-unexpected-error'), true);
});

// ── REAL temp-dir round-trips (production default seams) ──────────────────────────

test('REAL fs: happy CREATE round-trip, file created, no sidecars remain', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mgr-atomic-'));
  try {
    const target = join(dir, 'settings.json');
    const r = await atomicApplyWrite({ target, content: '{"model":"opus"}', assertWritable: PASS, retry: NO_SLEEP });
    assert.equal(r.ok, true);
    assert.equal(r.wrote, true);
    assert.equal(readFileSync(target, 'utf8'), '{"model":"opus"}');
    assert.equal(existsSync(target + '.mgr-new'), false);
    assert.equal(existsSync(target + '.mgr-old'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('REAL fs: happy OVERWRITE round-trip, new content, backup removed, no sidecars', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mgr-atomic-'));
  try {
    const target = join(dir, 'settings.json');
    writeFileSync(target, 'OLD', 'utf8');
    const r = await atomicApplyWrite({ target, content: 'NEW', assertWritable: PASS, retry: NO_SLEEP });
    assert.equal(r.ok, true);
    assert.equal(r.wrote, true);
    assert.equal(readFileSync(target, 'utf8'), 'NEW');
    assert.equal(existsSync(target + '.mgr-new'), false);
    assert.equal(existsSync(target + '.mgr-old'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('REAL fs: gate-denied writes NOTHING (no sidecar on disk)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mgr-atomic-'));
  try {
    const target = join(dir, 'settings.json');
    const deny = () => { throw new Error('denied'); };
    const r = await atomicApplyWrite({ target, content: 'NEW', assertWritable: deny, retry: NO_SLEEP });
    assert.equal(r.ok, false);
    assert.equal(existsSync(target), false);
    assert.equal(existsSync(target + '.mgr-new'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── P3.U17: Buffer content (binary-safe) + rollback context ───────────────────────

test('REAL fs: Buffer content round-trips byte-identical (all bytes 0x00..0xFF)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mgr-atomic-'));
  try {
    const target = join(dir, 'agents', 'a.md'); // a rollback-restorable governed path
    // The atomic-write primitive does not mkdir; create the parent first (the
    // rollback-restore caller mkdirs the parent before calling this).
    mkdirSync(join(dir, 'agents'), { recursive: true });
    const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i)); // 0x00..0xFF
    const r = await atomicApplyWrite({ target, content: bytes, assertWritable: PASS, context: 'rollback', retry: NO_SLEEP });
    assert.equal(r.ok, true);
    assert.equal(r.wrote, true);
    const back = readFileSync(target); // no encoding → raw Buffer
    assert.equal(Buffer.compare(back, bytes), 0); // byte-identical
    assert.equal(existsSync(target + '.mgr-new'), false);
    assert.equal(existsSync(target + '.mgr-old'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('REAL fs: invalid-utf8 bytes survive (would be CORRUPTED by a utf8 write)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mgr-atomic-'));
  try {
    const target = join(dir, 'CLAUDE.md');
    // 0xff/0xfe/0x80 are not valid standalone utf8 — a string round-trip via 'utf8'
    // would replace them with U+FFFD; writing the Buffer raw preserves them.
    const bytes = Buffer.from([0xff, 0xfe, 0x00, 0x80]);
    const r = await atomicApplyWrite({ target, content: bytes, assertWritable: PASS, context: 'rollback', retry: NO_SLEEP });
    assert.equal(r.ok, true);
    const back = readFileSync(target);
    assert.equal(Buffer.compare(back, bytes), 0);
    // Prove the corruption oracle is real: decoding-then-re-encoding would NOT match.
    assert.notEqual(Buffer.compare(Buffer.from(back.toString('utf8'), 'utf8'), bytes), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('context:rollback passes the rollback context to the injected gate (in-memory)', async () => {
  const fs = makeFs();
  const ctxSeen = [];
  const gate = (p, ctx) => { ctxSeen.push(ctx); return p; }; // records the context arg
  const r = await atomicApplyWrite({
    target: TARGET, content: Buffer.from('hi'), assertWritable: gate, context: 'rollback', seams: fs.seams, retry: NO_SLEEP,
  });
  assert.equal(r.ok, true);
  assert.deepEqual(ctxSeen, ['rollback']); // the gate was called with 'rollback', not 'apply'
  // The staged content is the Buffer we passed (binary-safe through the seam).
  assert.equal(Buffer.isBuffer(fs.calls.write[0][1]), true);
});

test('default context stays apply when omitted (backward-compatible)', async () => {
  const fs = makeFs();
  const ctxSeen = [];
  const gate = (p, ctx) => { ctxSeen.push(ctx); return p; };
  const r = await atomicApplyWrite({ target: TARGET, content: 'x', assertWritable: gate, seams: fs.seams, retry: NO_SLEEP });
  assert.equal(r.ok, true);
  assert.deepEqual(ctxSeen, ['apply']); // unchanged default
});
