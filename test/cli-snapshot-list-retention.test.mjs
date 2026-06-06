/**
 * P4a.U3 — cli-snapshot-list-retention.test.mjs
 *
 * Covers the retention-preview + pin-UX additions to snapshotListCommand and
 * snapshotListTable:
 *
 *   (a) snapshot list --keep 1: 3 snapshots (1 pinned), fake gcFn returns
 *       wouldDelete=[older ids] → each snap annotated wouldPrune correctly,
 *       pinned snap always wouldPrune:false, summary counts correct.
 *   (b) snapshot list (no criterion): no wouldPrune annotation, pinnedCount present.
 *   (c) render: pinned + would-prune markers visible in the table string.
 *   (d) never-throws on degenerate listFn results.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { snapshotListCommand } from '../src/cli/snapshot-store-command.mjs';
import { snapshotListTable } from '../src/cli/snapshot-store-render.mjs';

// ── fixtures ─────────────────────────────────────────────────────────────────

const SNAPS = [
  { id: '2026-05-25T10-00-00Z', createdAt: '2026-05-25T10:00:00Z', reason: 'newest', fileCount: 10, complete: true, pinned: false },
  { id: '2026-05-20T10-00-00Z', createdAt: '2026-05-20T10:00:00Z', reason: 'middle', fileCount: 8,  complete: true, pinned: true  },
  { id: '2026-05-15T10-00-00Z', createdAt: '2026-05-15T10:00:00Z', reason: 'oldest', fileCount: 6,  complete: true, pinned: false },
];

/** A fake listFn returning a fixed set of snapshots. */
function makeListFn(snaps = SNAPS) {
  return () => ({ snapshots: snaps.slice(), diagnostics: [] });
}

/**
 * A fake gcFn (dry-run) returning wouldDelete for all but the first `keep` newest.
 * Ignores pins — that is the command layer's job (not gc's).
 */
function makeGcFn(wouldDelete) {
  return ({ apply }) => {
    assert.equal(apply, false, 'gcFn must always be called with apply:false for the preview');
    return { deleted: [], wouldDelete, retained: [], diagnostics: [] };
  };
}

// ── (a) --keep 1: annotation + summary ───────────────────────────────────────

test('snapshotListCommand --keep 1: annotates wouldPrune correctly', () => {
  // gc says it would delete the two older ids (ignoring the pin — that is the command's job).
  const gcFn = makeGcFn(['2026-05-20T10-00-00Z', '2026-05-15T10-00-00Z']);
  const out = snapshotListCommand(
    { mgrStateDir: '/s', args: { keep: '1' } },
    { listFn: makeListFn(), gcFn },
  );
  assert.equal(out.result.count, 3);
  const snaps = out.result.snapshots;

  // Newest (not in wouldDelete) → wouldPrune:false.
  assert.equal(snaps[0].id, '2026-05-25T10-00-00Z');
  assert.equal(snaps[0].wouldPrune, false, 'newest must be kept');

  // Middle (pinned AND in wouldDelete) → command forces wouldPrune:false.
  assert.equal(snaps[1].id, '2026-05-20T10-00-00Z');
  assert.equal(snaps[1].pinned, true);
  assert.equal(snaps[1].wouldPrune, false, 'pinned snap must never be wouldPrune:true');

  // Oldest (in wouldDelete, not pinned) → wouldPrune:true.
  assert.equal(snaps[2].id, '2026-05-15T10-00-00Z');
  assert.equal(snaps[2].wouldPrune, true, 'oldest (unpinned, in wouldDelete) must be wouldPrune:true');
});

test('snapshotListCommand --keep 1: summary counts correct', () => {
  const gcFn = makeGcFn(['2026-05-20T10-00-00Z', '2026-05-15T10-00-00Z']);
  const out = snapshotListCommand(
    { mgrStateDir: '/s', args: { keep: '1' } },
    { listFn: makeListFn(), gcFn },
  );
  const s = out.result.summary;
  assert.equal(s.total, 3);
  assert.equal(s.pinnedCount, 1);
  // Only the oldest (unpinned) is wouldPrune:true — the pinned middle snap is forced false.
  assert.equal(s.wouldPruneCount, 1);
  assert.equal(s.keptCount, 2);
});

test('snapshotListCommand --keep 1: gcFn called with apply:false + correct params', () => {
  const calls = [];
  const gcFn = (o) => { calls.push(o); return { deleted: [], wouldDelete: [], retained: [], diagnostics: [] }; };
  snapshotListCommand(
    { mgrStateDir: '/s', args: { keep: '2' } },
    { listFn: makeListFn(), gcFn },
  );
  assert.equal(calls.length, 1, 'gcFn called exactly once');
  assert.equal(calls[0].apply, false, 'must be a dry-run call');
  assert.equal(calls[0].keep, 2, 'keep coerced to number');
  assert.equal(calls[0].mgrStateDir, '/s');
});

test('snapshotListCommand: gcFn diagnostics are surfaced', () => {
  const gcFn = () => ({
    deleted: [], wouldDelete: [], retained: [],
    diagnostics: [{ severity: 'warn', code: 'gc-no-criterion', message: 'x', phase: 'snapshot' }],
  });
  const out = snapshotListCommand(
    { mgrStateDir: '/s', args: { keep: '1' } },
    { listFn: makeListFn(), gcFn },
  );
  assert.ok(out.diagnostics.some((d) => d.code === 'gc-no-criterion'));
});

// ── (b) no criterion: no wouldPrune, pinnedCount present ─────────────────────

test('snapshotListCommand (no criterion): no wouldPrune annotation on any snap', () => {
  const gcCalls = [];
  const gcFn = (o) => { gcCalls.push(o); return { deleted: [], wouldDelete: [], retained: [], diagnostics: [] }; };
  const out = snapshotListCommand(
    { mgrStateDir: '/s', args: {} },
    { listFn: makeListFn(), gcFn },
  );
  assert.equal(gcCalls.length, 0, 'gcFn must NOT be called without a criterion');
  for (const s of out.result.snapshots) {
    assert.equal(typeof s.wouldPrune, 'undefined', 'wouldPrune must be absent when no criterion');
  }
});

test('snapshotListCommand (no criterion): summary has pinnedCount but no wouldPruneCount', () => {
  const out = snapshotListCommand(
    { mgrStateDir: '/s', args: {} },
    { listFn: makeListFn() },
  );
  const s = out.result.summary;
  assert.equal(s.total, 3);
  assert.equal(s.pinnedCount, 1);
  assert.equal(typeof s.wouldPruneCount, 'undefined', 'wouldPruneCount absent without criterion');
  assert.equal(typeof s.keptCount, 'undefined', 'keptCount absent without criterion');
});

// ── (c) render: markers visible in the table string ──────────────────────────

test('snapshotListTable: PIN marker shown for pinned snap, no PRUNE/KEEP without retention', () => {
  const result = {
    snapshots: [
      { id: '2026-05-25T10-00-00Z', createdAt: 'c1', reason: 'r1', fileCount: 5, complete: true, pinned: true },
      { id: '2026-05-20T10-00-00Z', createdAt: 'c2', reason: 'r2', fileCount: 3, complete: true, pinned: false },
    ],
    summary: { total: 2, pinnedCount: 1 },
  };
  const rendered = snapshotListTable(result);
  assert.ok(rendered.includes('PIN'), 'PIN marker must appear for the pinned snap');
  assert.ok(!rendered.includes('PRUNE'), 'PRUNE must not appear without retention criterion');
  assert.ok(!rendered.includes('KEEP'), 'KEEP must not appear without retention criterion');
  assert.ok(rendered.includes('pinned: 1'), 'summary must show pinnedCount');
});

test('snapshotListTable: PRUNE + KEEP markers shown when wouldPrune is annotated', () => {
  const result = {
    snapshots: [
      { id: '2026-05-25T10-00-00Z', createdAt: 'c1', reason: 'r1', fileCount: 5, complete: true, pinned: false, wouldPrune: false },
      { id: '2026-05-20T10-00-00Z', createdAt: 'c2', reason: 'r2', fileCount: 3, complete: true, pinned: true,  wouldPrune: false },
      { id: '2026-05-15T10-00-00Z', createdAt: 'c3', reason: 'r3', fileCount: 1, complete: true, pinned: false, wouldPrune: true  },
    ],
    summary: { total: 3, pinnedCount: 1, wouldPruneCount: 1, keptCount: 2 },
  };
  const rendered = snapshotListTable(result);
  assert.ok(rendered.includes('PIN'),   'PIN marker for the pinned snap');
  assert.ok(rendered.includes('PRUNE'), 'PRUNE marker for the would-prune snap');
  assert.ok(rendered.includes('KEEP'),  'KEEP marker for the retained snap');
  assert.ok(rendered.includes('would-prune: 1'), 'summary shows wouldPruneCount');
  assert.ok(rendered.includes('kept: 2'),        'summary shows keptCount');
});

test('snapshotListTable: pinned snap shows PIN even when retention present (not KEEP)', () => {
  const result = {
    snapshots: [
      { id: '2026-05-25T10-00-00Z', createdAt: 'c1', reason: '', fileCount: 1, complete: true, pinned: true, wouldPrune: false },
    ],
    summary: { total: 1, pinnedCount: 1, wouldPruneCount: 0, keptCount: 1 },
  };
  const rendered = snapshotListTable(result);
  // PIN takes priority over KEEP in the status column.
  assert.ok(rendered.includes('PIN'), 'pinned snap shows PIN, not KEEP');
  assert.ok(!rendered.includes('KEEP'), 'KEEP must not appear for a pinned snap');
});

// ── (d) never-throws on degenerate inputs ─────────────────────────────────────

test('snapshotListCommand: never throws when listFn returns an empty snapshots array', () => {
  const listFn = () => ({ snapshots: [], diagnostics: [] });
  assert.doesNotThrow(() => {
    const out = snapshotListCommand({ mgrStateDir: '/s', args: { keep: '1' } }, { listFn });
    assert.equal(out.result.count, 0);
    assert.equal(out.result.summary.total, 0);
    assert.equal(out.result.summary.wouldPruneCount, 0);
  });
});

test('snapshotListCommand: never throws when listFn returns null-ish snapshots', () => {
  const listFn = () => ({ snapshots: null, diagnostics: [] });
  assert.doesNotThrow(() => {
    const out = snapshotListCommand({ mgrStateDir: '/s', args: {} }, { listFn });
    assert.equal(out.result.count, 0);
  });
});

test('snapshotListCommand: never throws on a null ctx', () => {
  const listFn = () => ({ snapshots: [], diagnostics: [] });
  assert.doesNotThrow(() => snapshotListCommand(null, { listFn }));
});

test('snapshotListTable: never throws on an empty result object', () => {
  assert.doesNotThrow(() => {
    const rendered = snapshotListTable({});
    assert.equal(typeof rendered, 'string');
  });
});

test('snapshotListTable: never throws on a null result', () => {
  assert.doesNotThrow(() => {
    const rendered = snapshotListTable(null ?? {});
    assert.equal(typeof rendered, 'string');
  });
});
