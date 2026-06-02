/**
 * P3.U21 — snapshot-pin.test.mjs
 *
 * Tests src/ops/snapshot-pin.mjs: pinMarkerPath / isPinned / pinSnapshot (CREATE,
 * gated) / unpinSnapshot (bounded DELETE). All falsifiable, real temp dirs.
 * The gate is a passthrough `PASS=(p)=>p` (the real gate is exercised by
 * boundary.mjs / integration); these prove the fail-safe + the .pin lifecycle.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  PIN_MARKER_NAME, pinMarkerPath, isPinned, pinSnapshot, unpinSnapshot,
} from '../src/ops/snapshot-pin.mjs';
import { snapshotDir, SNAPSHOTS_DIRNAME } from '../src/ops/snapshot-manifest.mjs';

const ID = '2026-06-01T12-00-00Z';

/** A passthrough governed-write gate (the real gate is tested elsewhere). */
const PASS = (p) => p;

/** A temp `.mgr-state` dir + cleanup. */
function makeStateDir() {
  const dir = mkdtempSync(join(tmpdir(), 'cmgr-pin-'));
  return {
    dir,
    cleanup() { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } },
  };
}

/** Create the snapshots/<id>/ dir on disk (so a pin is allowed). */
function plantSnapshotDir(stateDir, id) {
  const dir = snapshotDir(stateDir, id);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ── pinMarkerPath ───────────────────────────────────────────────────────────────

test('pinMarkerPath is under snapshots/<id>/ and ends with .pin', () => {
  const p = pinMarkerPath('/state', ID);
  assert.equal(PIN_MARKER_NAME, '.pin');
  assert.ok(p.endsWith(PIN_MARKER_NAME), `expected ${p} to end with .pin`);
  // Contains the snapshots dir, the id, and the marker name as the final segment.
  assert.ok(p.includes(SNAPSHOTS_DIRNAME), 'path should include the snapshots dir');
  assert.ok(p.includes(ID), 'path should include the snapshot id');
  assert.equal(p, join(snapshotDir('/state', ID), '.pin'));
});

// ── pin / unpin lifecycle ─────────────────────────────────────────────────────

test('pin a snapshot whose dir exists → pinned:true, marker on disk, isPinned true', () => {
  const st = makeStateDir();
  try {
    plantSnapshotDir(st.dir, ID);
    const res = pinSnapshot({ mgrStateDir: st.dir, snapshotId: ID, assertWritable: PASS });
    assert.equal(res.pinned, true);
    assert.equal(res.path, pinMarkerPath(st.dir, ID));
    assert.equal(res.diagnostics.filter((d) => d.severity === 'error').length, 0);
    assert.ok(existsSync(pinMarkerPath(st.dir, ID)), 'marker file must exist on disk');
    assert.equal(isPinned({ mgrStateDir: st.dir, snapshotId: ID }), true);
  } finally { st.cleanup(); }
});

test('unpin → unpinned:true, marker gone, isPinned false', () => {
  const st = makeStateDir();
  try {
    plantSnapshotDir(st.dir, ID);
    pinSnapshot({ mgrStateDir: st.dir, snapshotId: ID, assertWritable: PASS });
    assert.equal(isPinned({ mgrStateDir: st.dir, snapshotId: ID }), true);

    const res = unpinSnapshot({ mgrStateDir: st.dir, snapshotId: ID });
    assert.equal(res.unpinned, true);
    assert.equal(res.diagnostics.length, 0);
    assert.equal(existsSync(pinMarkerPath(st.dir, ID)), false, 'marker must be gone');
    assert.equal(isPinned({ mgrStateDir: st.dir, snapshotId: ID }), false);
  } finally { st.cleanup(); }
});

test('unpin when not pinned → unpinned:false, no throw, no error diagnostic', () => {
  const st = makeStateDir();
  try {
    plantSnapshotDir(st.dir, ID); // dir exists but no .pin marker
    const res = unpinSnapshot({ mgrStateDir: st.dir, snapshotId: ID });
    assert.equal(res.unpinned, false);
    assert.equal(res.diagnostics.length, 0, 'absent marker is benign — no diagnostic');
  } finally { st.cleanup(); }
});

// ── pin failure modes ─────────────────────────────────────────────────────────

test('pin a non-existent snapshot (no dir) → pinned:false + snapshot-pin-not-found', () => {
  const st = makeStateDir();
  try {
    // No snapshots/<id>/ dir planted.
    const res = pinSnapshot({ mgrStateDir: st.dir, snapshotId: ID, assertWritable: PASS });
    assert.equal(res.pinned, false);
    assert.ok(res.diagnostics.some((d) => d.code === 'snapshot-pin-not-found'),
      'expected snapshot-pin-not-found');
    assert.equal(existsSync(pinMarkerPath(st.dir, ID)), false, 'nothing written');
  } finally { st.cleanup(); }
});

test('pin with missing assertWritable → pinned:false + snapshot-pin-error (fail-safe), nothing written', () => {
  const st = makeStateDir();
  try {
    plantSnapshotDir(st.dir, ID);
    const res = pinSnapshot({ mgrStateDir: st.dir, snapshotId: ID }); // no gate injected
    assert.equal(res.pinned, false);
    assert.ok(res.diagnostics.some((d) => d.code === 'snapshot-pin-error'),
      'expected snapshot-pin-error for a missing gate');
    assert.equal(existsSync(pinMarkerPath(st.dir, ID)), false, 'fail-safe: nothing written');
  } finally { st.cleanup(); }
});

test('pin with a gate that throws → pinned:false, marker NOT created', () => {
  const st = makeStateDir();
  try {
    plantSnapshotDir(st.dir, ID);
    const denyingGate = () => { throw new Error('write-forbidden'); };
    const res = pinSnapshot({ mgrStateDir: st.dir, snapshotId: ID, assertWritable: denyingGate });
    assert.equal(res.pinned, false);
    assert.ok(res.diagnostics.some((d) => d.code === 'snapshot-pin-error'));
    assert.equal(existsSync(pinMarkerPath(st.dir, ID)), false, 'gate denial must block the write');
  } finally { st.cleanup(); }
});

test('pin where the marker is absent after a "successful" write → snapshot-pin-verify-failed', () => {
  const st = makeStateDir();
  try {
    plantSnapshotDir(st.dir, ID);
    const markerPath = pinMarkerPath(st.dir, ID);
    // existsFn says the snapshot dir IS there (so the pin is allowed), but the
    // post-write marker probe says it is NOT — exercising the light-verify branch.
    const existsFn = (p) => p !== markerPath;     // true for the dir, false for the marker
    const noopWrite = () => {};                    // "succeeds" but writes nothing real
    const res = pinSnapshot({
      mgrStateDir: st.dir, snapshotId: ID, assertWritable: PASS,
      seams: { write: noopWrite, existsFn },
    });
    assert.equal(res.pinned, false);
    assert.ok(res.diagnostics.some((d) => d.code === 'snapshot-pin-verify-failed'),
      'expected snapshot-pin-verify-failed when the marker is missing after write');
  } finally { st.cleanup(); }
});

test('a throwing write seam → pinned:false + diagnostic, never throws', () => {
  const st = makeStateDir();
  try {
    plantSnapshotDir(st.dir, ID);
    const throwingWrite = () => { throw new Error('EIO'); };
    let res;
    assert.doesNotThrow(() => {
      res = pinSnapshot({
        mgrStateDir: st.dir, snapshotId: ID, assertWritable: PASS,
        seams: { write: throwingWrite },
      });
    });
    assert.equal(res.pinned, false);
    assert.ok(res.diagnostics.some((d) => d.code === 'snapshot-pin-error'));
    assert.equal(existsSync(pinMarkerPath(st.dir, ID)), false, 'failed write leaves no marker');
  } finally { st.cleanup(); }
});

// ── invalid id: all three reject safely, no fs escape ─────────────────────────

test("invalid id → pin/unpin/isPinned all reject safely (no throw, no fs escape)", () => {
  const st = makeStateDir();
  try {
    for (const badId of ['../evil', 'not-an-id', '', '..', 'a/b']) {
      let pinRes; let unpinRes; let pinnedRes;
      assert.doesNotThrow(() => {
        pinRes = pinSnapshot({ mgrStateDir: st.dir, snapshotId: badId, assertWritable: PASS });
        unpinRes = unpinSnapshot({ mgrStateDir: st.dir, snapshotId: badId });
        pinnedRes = isPinned({ mgrStateDir: st.dir, snapshotId: badId });
      }, `id ${JSON.stringify(badId)} must not throw`);
      assert.equal(pinRes.pinned, false, `pin must refuse id ${JSON.stringify(badId)}`);
      assert.ok(pinRes.diagnostics.some((d) => d.code === 'snapshot-pin-id-invalid'),
        `expected snapshot-pin-id-invalid for ${JSON.stringify(badId)}`);
      assert.equal(unpinRes.unpinned, false);
      assert.ok(unpinRes.diagnostics.some((d) => d.code === 'snapshot-pin-id-invalid'));
      assert.equal(pinnedRes, false, `isPinned must be false for ${JSON.stringify(badId)}`);
    }
  } finally { st.cleanup(); }
});
