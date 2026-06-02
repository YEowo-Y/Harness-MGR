/**
 * P3/P4a — snapshot-store.test.mjs
 *
 * Tests src/ops/snapshot-store.mjs: listSnapshots + gcSnapshots (+ the bounded
 * delete). Acceptance (DoD), all falsifiable:
 *   - listSnapshots over a real temp `.mgr-state/snapshots/` with 2 valid manifests
 *     + 1 incomplete dir + 1 non-id-named dir (ignored) → the exact newest-first list.
 *   - gcSnapshots --keep 1 retains the newest, wouldDelete the rest (dry-run);
 *     apply:true bounded-deletes them and the dirs are GONE (real fs).
 *   - DELETE-BOUNDING oracle: a spy unlink/rmdir proves every deleted path is under
 *     snapshots/<id>; a crafted non-id dir (../evil, .., x) is NEVER deleted; a
 *     snapshot dir containing a SUBDIR → rmdir fails → warn, dir SURVIVES (no recursion).
 *   - --older-than with an injected now; no-criterion deletes nothing + warns.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync,
  unlinkSync, rmdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { listSnapshots, gcSnapshots } from '../src/ops/snapshot-store.mjs';
import { snapshotDir, SNAPSHOTS_DIRNAME } from '../src/ops/snapshot-manifest.mjs';
import { pinMarkerPath } from '../src/ops/snapshot-pin.mjs';

// ── helpers ───────────────────────────────────────────────────────────────────

/** A temp `.mgr-state` dir + cleanup. */
function makeStateDir() {
  const dir = mkdtempSync(join(tmpdir(), 'cmgr-store-'));
  return {
    dir,
    cleanup() { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } },
  };
}

/** Build a manifest object for a snapshot id with `fileCount` file records. */
function manifestFor(id, { reason = '', fileCount = 0, createdAt } = {}) {
  const files = [];
  for (let i = 0; i < fileCount; i++) files.push({ path: `f${i}.md`, preSha256: 'a', currentSha256: 'a' });
  return {
    manifestVersion: 1, planVersion: 1, snapshotId: id,
    targetClaudeDir: '/c/Users/test/.claude',
    createdAt: createdAt ?? `${id.slice(0, 10)}T00:00:00.000Z`,
    reason, files,
  };
}

/** Create a real snapshot dir on disk with a manifest.json (or omit it). */
function plantSnapshot(stateDir, id, opts = {}) {
  const dir = snapshotDir(stateDir, id);
  mkdirSync(dir, { recursive: true });
  // A files.tar alongside, so the dir is realistically populated.
  writeFileSync(join(dir, 'files.tar'), Buffer.from('TAR', 'utf8'));
  if (opts.manifest !== false) {
    writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifestFor(id, opts), null, 2)}\n`, 'utf8');
  }
  return dir;
}

const ID_A = '2026-05-20T10-00-00Z'; // oldest
const ID_B = '2026-05-22T10-00-00Z';
const ID_C = '2026-05-25T10-00-00Z'; // newest

// ── listSnapshots ───────────────────────────────────────────────────────────────

test('listSnapshots: 2 valid + 1 incomplete + 1 non-id → exact newest-first list', () => {
  const st = makeStateDir();
  try {
    plantSnapshot(st.dir, ID_A, { reason: 'first', fileCount: 2 });
    plantSnapshot(st.dir, ID_C, { reason: 'third', fileCount: 5 });
    plantSnapshot(st.dir, ID_B, { manifest: false }); // incomplete: no manifest
    // A non-id-named dir must be IGNORED entirely.
    mkdirSync(join(st.dir, SNAPSHOTS_DIRNAME, 'not-a-snapshot'), { recursive: true });

    const { snapshots, diagnostics } = listSnapshots({ mgrStateDir: st.dir });
    // Newest-first: C, B, A.
    assert.deepEqual(snapshots.map((s) => s.id), [ID_C, ID_B, ID_A]);
    // C complete with its fields (no .pin marker → pinned:false).
    assert.deepEqual(snapshots[0], { id: ID_C, createdAt: '2026-05-25T00:00:00.000Z', reason: 'third', fileCount: 5, complete: true, pinned: false });
    // B incomplete (no manifest) → {id, complete:false, pinned:false}.
    assert.deepEqual(snapshots[1], { id: ID_B, complete: false, pinned: false });
    // A complete.
    assert.equal(snapshots[2].complete, true);
    assert.equal(snapshots[2].fileCount, 2);
    // No diagnostics for a healthy listing.
    assert.equal(diagnostics.length, 0, JSON.stringify(diagnostics));
  } finally { st.cleanup(); }
});

test('listSnapshots: a missing snapshots dir → empty list, no diagnostics', () => {
  const st = makeStateDir(); // no snapshots/ subdir created
  try {
    const { snapshots, diagnostics } = listSnapshots({ mgrStateDir: st.dir });
    assert.deepEqual(snapshots, []);
    assert.equal(diagnostics.length, 0);
  } finally { st.cleanup(); }
});

test('listSnapshots: a dir with an UNPARSEABLE manifest is listed as incomplete', () => {
  const st = makeStateDir();
  try {
    const dir = snapshotDir(st.dir, ID_A);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'manifest.json'), '{ this is not json', 'utf8');
    const { snapshots } = listSnapshots({ mgrStateDir: st.dir });
    assert.deepEqual(snapshots, [{ id: ID_A, complete: false, pinned: false }]);
  } finally { st.cleanup(); }
});

test('listSnapshots: a non-string mgrStateDir → error diagnostic, no throw', () => {
  const { snapshots, diagnostics } = listSnapshots({ mgrStateDir: 0 });
  assert.deepEqual(snapshots, []);
  assert.ok(diagnostics.some((d) => d.code === 'snapshot-bad-state-dir' && d.severity === 'error'));
});

test('listSnapshots: a readFn seam supplies manifests without disk', () => {
  // readdirFn returns the dir names; readFn returns the manifest text for each id.
  const readdirFn = () => [ID_A, ID_C];
  const readFn = (p) => {
    const id = p.includes(ID_C) ? ID_C : ID_A;
    return `${JSON.stringify(manifestFor(id, { fileCount: id === ID_C ? 3 : 1 }))}\n`;
  };
  const { snapshots } = listSnapshots({ mgrStateDir: '/virtual', readdirFn, readFn });
  assert.deepEqual(snapshots.map((s) => s.id), [ID_C, ID_A]);
  assert.equal(snapshots[0].fileCount, 3);
  assert.equal(snapshots[1].fileCount, 1);
});

// ── gcSnapshots: dry-run by default ──────────────────────────────────────────────

test('gcSnapshots --keep 1: dry-run reports wouldDelete the older, deletes nothing', () => {
  const st = makeStateDir();
  try {
    plantSnapshot(st.dir, ID_A, { fileCount: 1 });
    plantSnapshot(st.dir, ID_B, { fileCount: 1 });
    plantSnapshot(st.dir, ID_C, { fileCount: 1 });

    const r = gcSnapshots({ mgrStateDir: st.dir, keep: 1 }); // apply defaults to false
    assert.deepEqual(r.retained, [ID_C]);            // newest kept
    assert.deepEqual(r.wouldDelete, [ID_B, ID_A]);   // older two would go
    assert.deepEqual(r.deleted, []);                 // dry-run deletes nothing
    // CRITICAL: every dir still on disk.
    for (const id of [ID_A, ID_B, ID_C]) assert.ok(existsSync(snapshotDir(st.dir, id)), `${id} must survive dry-run`);
  } finally { st.cleanup(); }
});

test('gcSnapshots --keep 1 --apply: bounded-deletes the older dirs (they are GONE)', () => {
  const st = makeStateDir();
  try {
    plantSnapshot(st.dir, ID_A, { fileCount: 1 });
    plantSnapshot(st.dir, ID_B, { fileCount: 1 });
    plantSnapshot(st.dir, ID_C, { fileCount: 1 });

    const r = gcSnapshots({ mgrStateDir: st.dir, keep: 1, apply: true });
    assert.deepEqual(r.retained, [ID_C]);
    assert.deepEqual(r.deleted, [ID_B, ID_A]);
    assert.deepEqual(r.wouldDelete, []); // apply → no preview list
    // The older two dirs are GONE; the newest survives; only those dirs were touched.
    assert.ok(!existsSync(snapshotDir(st.dir, ID_A)), 'A deleted');
    assert.ok(!existsSync(snapshotDir(st.dir, ID_B)), 'B deleted');
    assert.ok(existsSync(snapshotDir(st.dir, ID_C)), 'C survives');
    // The snapshots root itself is untouched.
    assert.ok(existsSync(join(st.dir, SNAPSHOTS_DIRNAME)));
  } finally { st.cleanup(); }
});

test('gcSnapshots: no criterion → gc-no-criterion warn, deletes nothing, lists all retained', () => {
  const st = makeStateDir();
  try {
    plantSnapshot(st.dir, ID_A, { fileCount: 1 });
    plantSnapshot(st.dir, ID_C, { fileCount: 1 });
    const r = gcSnapshots({ mgrStateDir: st.dir, apply: true }); // apply but no criterion
    assert.deepEqual(r.deleted, []);
    assert.deepEqual(r.wouldDelete, []);
    assert.deepEqual(r.retained.sort(), [ID_A, ID_C].sort());
    assert.ok(r.diagnostics.some((d) => d.code === 'gc-no-criterion' && d.severity === 'warn'));
    // Nothing deleted despite apply:true.
    assert.ok(existsSync(snapshotDir(st.dir, ID_A)));
    assert.ok(existsSync(snapshotDir(st.dir, ID_C)));
  } finally { st.cleanup(); }
});

// ── gcSnapshots: --older-than with injected now ──────────────────────────────────

test('gcSnapshots --older-than with injected now: prunes the OLD ones only', () => {
  const st = makeStateDir();
  try {
    // createdAt is derived from the id date (midnight). now = just after ID_C.
    plantSnapshot(st.dir, ID_A, { fileCount: 1 }); // 2026-05-20
    plantSnapshot(st.dir, ID_B, { fileCount: 1 }); // 2026-05-22
    plantSnapshot(st.dir, ID_C, { fileCount: 1 }); // 2026-05-25
    const now = () => Date.parse('2026-05-25T12:00:00.000Z'); // noon on the 25th
    // older-than 2 days → cutoff = 2026-05-23 12:00. A(20th)+B(22nd) are older → prune.
    const twoDaysMs = 2 * 86400000;
    const r = gcSnapshots({ mgrStateDir: st.dir, olderThanMs: twoDaysMs, now, apply: true });
    assert.deepEqual(r.retained, [ID_C]);          // only the 25th is newer than cutoff
    assert.deepEqual(r.deleted.sort(), [ID_A, ID_B].sort());
    assert.ok(!existsSync(snapshotDir(st.dir, ID_A)));
    assert.ok(!existsSync(snapshotDir(st.dir, ID_B)));
    assert.ok(existsSync(snapshotDir(st.dir, ID_C)));
  } finally { st.cleanup(); }
});

test('gcSnapshots: keep + older-than is the STRICTER intersection (retain iff BOTH)', () => {
  const st = makeStateDir();
  try {
    plantSnapshot(st.dir, ID_A, { fileCount: 1 });
    plantSnapshot(st.dir, ID_B, { fileCount: 1 });
    plantSnapshot(st.dir, ID_C, { fileCount: 1 });
    const now = () => Date.parse('2026-05-25T12:00:00.000Z');
    // keep:3 (would keep all) AND older-than 2d (would keep only C). Intersection → only C.
    const r = gcSnapshots({ mgrStateDir: st.dir, keep: 3, olderThanMs: 2 * 86400000, now });
    assert.deepEqual(r.retained, [ID_C]);
    assert.deepEqual(r.wouldDelete, [ID_B, ID_A]);
  } finally { st.cleanup(); }
});

test('gcSnapshots: incomplete snapshot (no manifest) is a prune candidate under --older-than', () => {
  const st = makeStateDir();
  try {
    plantSnapshot(st.dir, ID_A, { manifest: false }); // incomplete, id-date 2026-05-20
    plantSnapshot(st.dir, ID_C, { fileCount: 1 });
    const now = () => Date.parse('2026-05-25T12:00:00.000Z');
    // A has no createdAt → falls back to its id timestamp (the 20th) → older → pruned.
    const r = gcSnapshots({ mgrStateDir: st.dir, olderThanMs: 2 * 86400000, now, apply: true });
    assert.deepEqual(r.deleted, [ID_A]);
    assert.deepEqual(r.retained, [ID_C]);
    assert.ok(!existsSync(snapshotDir(st.dir, ID_A)));
  } finally { st.cleanup(); }
});

// ── DELETE-BOUNDING ORACLE (the security-critical proofs) ─────────────────────────

test('gc DELETE-BOUNDING: every unlink/rmdir path is under snapshots/<id> (spy)', () => {
  const st = makeStateDir();
  try {
    plantSnapshot(st.dir, ID_A, { fileCount: 1 });
    plantSnapshot(st.dir, ID_C, { fileCount: 1 });
    const root = join(st.dir, SNAPSHOTS_DIRNAME);
    const unlinked = [];
    const rmdired = [];
    // Spy seams: real listFn (default), but spy the delete fs ops.
    const r = gcSnapshots({
      mgrStateDir: st.dir, keep: 1, apply: true,
      seams: {
        direntFn: (p) => readdirSync(p, { withFileTypes: true }),
        unlinkFn: (p) => { unlinked.push(p); unlinkSync(p); },
        rmdirFn: (p) => { rmdired.push(p); rmdirSync(p); }, // empty-only, like production
      },
    });
    assert.deepEqual(r.deleted, [ID_A]); // keep newest C, delete A
    // EVERY touched path must be strictly under snapshots/<the deleted id>/.
    const allowedPrefix = join(root, ID_A);
    for (const p of [...unlinked, ...rmdired]) {
      assert.ok(p.startsWith(allowedPrefix), `delete path escaped bound: ${p}`);
    }
    // The retained id's dir was NEVER a delete target.
    for (const p of [...unlinked, ...rmdired]) {
      assert.ok(!p.includes(ID_C), `retained id touched: ${p}`);
    }
    // Exactly one rmdir (the one deleted dir).
    assert.equal(rmdired.length, 1);
    assert.equal(rmdired[0], join(root, ID_A));
  } finally { st.cleanup(); }
});

test('gc DELETE-BOUNDING: a crafted non-id dir name is NEVER deleted', () => {
  const st = makeStateDir();
  try {
    plantSnapshot(st.dir, ID_A, { fileCount: 1 });
    // Plant hostile sibling dirs that must be invisible to gc.
    for (const evil of ['..', 'x', 'not-a-snapshot', '2026-05-20']) { // last = wrong shape (no T..Z)
      try { mkdirSync(join(st.dir, SNAPSHOTS_DIRNAME, evil), { recursive: true }); } catch { /* '..' is the parent, ok */ }
    }
    const unlinked = [];
    const rmdired = [];
    // Force a list that INCLUDES the hostile names as if readdir returned them, to
    // prove the id-revalidation inside the delete refuses them even if they slip in.
    const listFn = () => ({
      snapshots: [
        { id: ID_A, complete: true, fileCount: 1, createdAt: '2026-05-20T00:00:00.000Z', reason: '' },
        { id: '../evil', complete: false },
        { id: '..', complete: false },
        { id: 'x', complete: false },
      ],
      diagnostics: [],
    });
    const r = gcSnapshots({
      mgrStateDir: st.dir, keep: 0, apply: true, // keep 0 → ALL are delete candidates
      seams: {
        listFn,
        direntFn: (p) => readdirSync(p, { withFileTypes: true }),
        unlinkFn: (p) => { unlinked.push(p); unlinkSync(p); },
        rmdirFn: (p) => { rmdired.push(p); rmdirSync(p); }, // empty-only, like production
      },
    });
    // Only the VALID id was deleted; the 3 crafted ids were refused.
    assert.deepEqual(r.deleted, [ID_A]);
    // The STRONG bound: every touched path is strictly under snapshots/<the one valid id>.
    const allowedPrefix = join(st.dir, SNAPSHOTS_DIRNAME, ID_A);
    for (const p of [...unlinked, ...rmdired]) {
      assert.ok(p.startsWith(allowedPrefix), `delete path escaped the valid-id bound: ${p}`);
    }
    // The hostile dirs still exist on disk (never removed).
    for (const evil of ['x', 'not-a-snapshot']) {
      assert.ok(existsSync(join(st.dir, SNAPSHOTS_DIRNAME, evil)), `${evil} must survive`);
    }
    // A warn was emitted for each refused id.
    const skipWarns = r.diagnostics.filter((d) => d.code === 'gc-delete-skipped');
    assert.equal(skipWarns.length, 3, JSON.stringify(r.diagnostics));
  } finally { st.cleanup(); }
});

test('gc DELETE-BOUNDING: a snapshot dir with a SUBDIR → rmdir fails → warn, dir SURVIVES (no recursion)', () => {
  const st = makeStateDir();
  try {
    const dir = plantSnapshot(st.dir, ID_A, { fileCount: 1 });
    // Plant a nested SUBDIR inside the snapshot — gc must NOT recurse into it.
    const nested = join(dir, 'nested-dir');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, 'deep.txt'), 'DEEP', 'utf8');

    const r = gcSnapshots({ mgrStateDir: st.dir, keep: 0, apply: true });
    // The dir was NOT deleted (rmdir refused a non-empty dir).
    assert.deepEqual(r.deleted, []);
    assert.ok(existsSync(dir), 'snapshot dir with a subdir must survive');
    assert.ok(existsSync(nested), 'the subdir must be untouched (no recursion)');
    assert.ok(existsSync(join(nested, 'deep.txt')), 'the deep file must be untouched');
    // A skip warn for the subdir entry + a delete-failed warn for the non-empty rmdir.
    assert.ok(r.diagnostics.some((d) => d.code === 'gc-delete-skipped-entry'), 'subdir entry skipped');
    assert.ok(r.diagnostics.some((d) => d.code === 'gc-delete-failed'), 'non-empty rmdir warned');
  } finally { st.cleanup(); }
});

test('gc DELETE-BOUNDING: the top-level files.tar IS removed but the dir-walk never recurses', () => {
  const st = makeStateDir();
  try {
    const dir = plantSnapshot(st.dir, ID_A, { fileCount: 1 }); // has files.tar + manifest.json
    // Sanity: the dir has exactly the 2 expected files before gc.
    assert.equal(readdirSync(dir).length, 2);
    const r = gcSnapshots({ mgrStateDir: st.dir, keep: 0, apply: true });
    assert.deepEqual(r.deleted, [ID_A]);
    assert.ok(!existsSync(dir), 'the (flat) snapshot dir is fully removed');
  } finally { st.cleanup(); }
});

// ── never-throws + arg coercion ──────────────────────────────────────────────────

test('gcSnapshots: a non-string mgrStateDir → error diagnostic, no throw', () => {
  const r = gcSnapshots({ mgrStateDir: null, keep: 1 });
  assert.deepEqual(r.deleted, []);
  assert.ok(r.diagnostics.some((d) => d.code === 'snapshot-bad-state-dir' && d.severity === 'error'));
});

test('gcSnapshots: an invalid keep (negative/float) is ignored; with no other criterion → no-criterion', () => {
  const st = makeStateDir();
  try {
    plantSnapshot(st.dir, ID_A, { fileCount: 1 });
    const r = gcSnapshots({ mgrStateDir: st.dir, keep: -5 }); // invalid → treated as absent
    assert.ok(r.diagnostics.some((d) => d.code === 'gc-no-criterion'));
    assert.deepEqual(r.deleted, []);
  } finally { st.cleanup(); }
});

test('gcSnapshots: keep 0 with valid criterion deletes ALL snapshots (dry-run preview)', () => {
  const st = makeStateDir();
  try {
    plantSnapshot(st.dir, ID_A, { fileCount: 1 });
    plantSnapshot(st.dir, ID_C, { fileCount: 1 });
    const r = gcSnapshots({ mgrStateDir: st.dir, keep: 0 }); // keep nothing
    assert.deepEqual(r.retained, []);
    assert.deepEqual(r.wouldDelete, [ID_C, ID_A]); // newest-first order preserved
    assert.deepEqual(r.deleted, []); // still dry-run
  } finally { st.cleanup(); }
});

test('gcSnapshots: never throws on a junk opts object', () => {
  assert.doesNotThrow(() => gcSnapshots(undefined));
  assert.doesNotThrow(() => gcSnapshots(42));
  const r = gcSnapshots(null);
  assert.ok(Array.isArray(r.deleted) && Array.isArray(r.diagnostics));
});

// ── PIN-AWARENESS (P3.U21) ────────────────────────────────────────────────────────

test('listSnapshots: a snapshot whose .pin marker exists reports pinned:true (existsFn seam)', () => {
  const st = makeStateDir();
  try {
    plantSnapshot(st.dir, ID_A, { fileCount: 1 });
    plantSnapshot(st.dir, ID_C, { fileCount: 1 });
    // Inject an existsFn that reports the .pin present ONLY for ID_C's marker path.
    const cPinPath = pinMarkerPath(st.dir, ID_C);
    const existsFn = (p) => p === cPinPath;

    const { snapshots } = listSnapshots({ mgrStateDir: st.dir, existsFn });
    const byId = Object.fromEntries(snapshots.map((s) => [s.id, s]));
    assert.equal(byId[ID_C].pinned, true, 'C has a .pin → pinned');
    assert.equal(byId[ID_A].pinned, false, 'A has no .pin → not pinned');
  } finally { st.cleanup(); }
});

test('listSnapshots: an INCOMPLETE (no-manifest) but pinned dir still reports pinned:true', () => {
  const st = makeStateDir();
  try {
    plantSnapshot(st.dir, ID_A, { manifest: false }); // incomplete
    const aPinPath = pinMarkerPath(st.dir, ID_A);
    const { snapshots } = listSnapshots({ mgrStateDir: st.dir, existsFn: (p) => p === aPinPath });
    assert.deepEqual(snapshots, [{ id: ID_A, complete: false, pinned: true }]);
  } finally { st.cleanup(); }
});

test('listSnapshots: no .pin markers → every snapshot pinned:false (default existsFn over real fs)', () => {
  const st = makeStateDir();
  try {
    plantSnapshot(st.dir, ID_A, { fileCount: 1 });
    const { snapshots } = listSnapshots({ mgrStateDir: st.dir });
    assert.equal(snapshots[0].pinned, false);
  } finally { st.cleanup(); }
});

test('gcSnapshots HEADLINE: keep 0 (delete all) but one id PINNED → it is RETAINED, never deleted', () => {
  const st = makeStateDir();
  try {
    plantSnapshot(st.dir, ID_A, { fileCount: 1 });
    plantSnapshot(st.dir, ID_B, { fileCount: 1 });
    plantSnapshot(st.dir, ID_C, { fileCount: 1 });
    // Pin ID_B via a fake isPinnedFn (no real .pin file needed).
    const isPinnedFn = ({ snapshotId }) => snapshotId === ID_B;

    // Dry-run first: keep 0 would delete ALL, but the pin saves B.
    const dry = gcSnapshots({ mgrStateDir: st.dir, keep: 0, seams: { isPinnedFn } });
    assert.ok(dry.retained.includes(ID_B), 'pinned B retained in dry-run');
    assert.ok(!dry.wouldDelete.includes(ID_B), 'pinned B NOT in wouldDelete');
    assert.deepEqual(dry.wouldDelete.sort(), [ID_A, ID_C].sort(), 'only the non-pinned would go');
    // The pin-saved info diagnostic is surfaced.
    assert.ok(dry.diagnostics.some((d) => d.code === 'gc-pin-retained' && d.path === ID_B && d.severity === 'info'),
      JSON.stringify(dry.diagnostics));

    // Apply: B survives on disk; A and C are gone.
    const r = gcSnapshots({ mgrStateDir: st.dir, keep: 0, apply: true, seams: { isPinnedFn } });
    assert.ok(r.retained.includes(ID_B), 'pinned B retained on apply');
    assert.ok(!r.deleted.includes(ID_B), 'pinned B NEVER deleted');
    assert.deepEqual(r.deleted.sort(), [ID_A, ID_C].sort());
    assert.ok(existsSync(snapshotDir(st.dir, ID_B)), 'pinned B dir survives on disk');
    assert.ok(!existsSync(snapshotDir(st.dir, ID_A)), 'A deleted');
    assert.ok(!existsSync(snapshotDir(st.dir, ID_C)), 'C deleted');
  } finally { st.cleanup(); }
});

test('gcSnapshots: --older-than would prune an OLD snapshot, but a pin retains it', () => {
  const st = makeStateDir();
  try {
    plantSnapshot(st.dir, ID_A, { fileCount: 1 }); // 2026-05-20 (old)
    plantSnapshot(st.dir, ID_C, { fileCount: 1 }); // 2026-05-25 (new)
    const now = () => Date.parse('2026-05-25T12:00:00.000Z');
    // older-than 2d → A would be pruned. Pin A → it must be retained instead.
    const isPinnedFn = ({ snapshotId }) => snapshotId === ID_A;
    const r = gcSnapshots({ mgrStateDir: st.dir, olderThanMs: 2 * 86400000, now, apply: true, seams: { isPinnedFn } });
    assert.deepEqual(r.retained.sort(), [ID_A, ID_C].sort(), 'both retained: C by age, A by pin');
    assert.deepEqual(r.deleted, [], 'nothing deleted — the only prune candidate was pinned');
    assert.ok(existsSync(snapshotDir(st.dir, ID_A)), 'pinned old A survives');
    assert.ok(r.diagnostics.some((d) => d.code === 'gc-pin-retained' && d.path === ID_A));
  } finally { st.cleanup(); }
});

test('gcSnapshots: a NON-pinned snapshot is still pruned normally (pin does not break ordinary gc)', () => {
  const st = makeStateDir();
  try {
    plantSnapshot(st.dir, ID_A, { fileCount: 1 });
    plantSnapshot(st.dir, ID_B, { fileCount: 1 });
    plantSnapshot(st.dir, ID_C, { fileCount: 1 });
    // Pin only C (the newest, which keep:1 would retain anyway → NO pin-saved info).
    const isPinnedFn = ({ snapshotId }) => snapshotId === ID_C;
    const r = gcSnapshots({ mgrStateDir: st.dir, keep: 1, apply: true, seams: { isPinnedFn } });
    assert.deepEqual(r.retained, [ID_C]);
    assert.deepEqual(r.deleted, [ID_B, ID_A], 'non-pinned older two pruned as usual');
    assert.ok(!existsSync(snapshotDir(st.dir, ID_A)));
    assert.ok(!existsSync(snapshotDir(st.dir, ID_B)));
    // C was retained by the keep criterion anyway, so NO gc-pin-retained info is emitted.
    assert.ok(!r.diagnostics.some((d) => d.code === 'gc-pin-retained'),
      'no pin-saved info when the criteria would have kept it regardless');
  } finally { st.cleanup(); }
});

test('gcSnapshots: the real isPinned path force-retains via an on-disk .pin marker', () => {
  const st = makeStateDir();
  try {
    plantSnapshot(st.dir, ID_A, { fileCount: 1 });
    plantSnapshot(st.dir, ID_C, { fileCount: 1 });
    // Write a real .pin marker into A's dir — no isPinnedFn seam, exercise production isPinned.
    writeFileSync(pinMarkerPath(st.dir, ID_A), '{"pinnedAt":"2026-05-21T00:00:00.000Z"}\n', 'utf8');
    const r = gcSnapshots({ mgrStateDir: st.dir, keep: 0, apply: true }); // keep 0 = delete all
    assert.ok(r.retained.includes(ID_A), 'A retained by its real .pin marker');
    assert.deepEqual(r.deleted, [ID_C], 'only the unpinned C deleted');
    assert.ok(existsSync(snapshotDir(st.dir, ID_A)), 'pinned A dir survives');
    assert.ok(!existsSync(snapshotDir(st.dir, ID_C)));
  } finally { st.cleanup(); }
});

test('gcSnapshots: a THROWING isPinnedFn seam never aborts gc — fail-open, deletes proceed (Low-1)', () => {
  const st = makeStateDir();
  try {
    plantSnapshot(st.dir, ID_A, { fileCount: 1 });
    plantSnapshot(st.dir, ID_C, { fileCount: 1 });
    // A hostile injected pin-check that throws must be treated as "not pinned" (fail-
    // open is safe — an un-evaluatable pin is simply prunable) and must NOT make
    // gcSnapshots throw. The default isPinned never throws; this guards the seam.
    const isPinnedFn = () => { throw new Error('pin probe blew up'); };
    let r;
    assert.doesNotThrow(() => {
      r = gcSnapshots({ mgrStateDir: st.dir, keep: 0, apply: true, seams: { isPinnedFn } });
    }, 'a throwing isPinnedFn must not propagate out of gcSnapshots');
    // Fail-open: neither id is treated as pinned, so keep:0 prunes both.
    assert.deepEqual(r.deleted.sort(), [ID_A, ID_C].sort(), 'both pruned (throw → not pinned)');
    assert.deepEqual(r.retained, [], 'nothing retained when the pin probe fails open');
    assert.ok(!existsSync(snapshotDir(st.dir, ID_A)));
    assert.ok(!existsSync(snapshotDir(st.dir, ID_C)));
  } finally { st.cleanup(); }
});

test('gcSnapshots: a pin on EVERY snapshot under keep 0 → nothing deleted', () => {
  const st = makeStateDir();
  try {
    plantSnapshot(st.dir, ID_A, { fileCount: 1 });
    plantSnapshot(st.dir, ID_C, { fileCount: 1 });
    const r = gcSnapshots({ mgrStateDir: st.dir, keep: 0, apply: true, seams: { isPinnedFn: () => true } });
    assert.deepEqual(r.retained.sort(), [ID_A, ID_C].sort());
    assert.deepEqual(r.deleted, []);
    assert.deepEqual(r.wouldDelete, []);
    for (const id of [ID_A, ID_C]) assert.ok(existsSync(snapshotDir(st.dir, id)), `${id} survives — all pinned`);
  } finally { st.cleanup(); }
});
