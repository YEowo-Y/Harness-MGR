/**
 * render.test.mjs — per-command table rendering (renderTable / renderQuiet).
 *
 * Exercises every per-command case in render.mjs's dispatch (so each table helper
 * is directly covered, not just transitively via the CLI shell), the generic
 * key/value fallback, the quiet one-liner, and the defensive paths (null/non-object
 * results, missing fields). The point is breadth: one realistic result shape per
 * command, asserting the body is non-empty and contains the expected anchor text.
 *
 * Added alongside the P3 `snapshot` command wiring — covers the new `snapshotTable`
 * case (dry-run vs applied) plus the pre-existing helpers that lacked a direct test.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { renderTable, renderQuiet } from '../src/cli/render.mjs';

// ── snapshot (the new case) ──────────────────────────────────────────────────────

test('renderTable snapshot: dry-run shows mode + counts, no archive/manifest rows', () => {
  const out = renderTable('snapshot', {
    mode: 'dry-run', ok: true, snapshotId: '2026-05-30T00-00-00Z',
    fileCount: 5, keptCount: 5, droppedCount: 2, dropped: ['a', 'b'],
    archivePath: null, manifestPath: null,
  });
  assert.match(out, /harness-mgr snapshot/);
  assert.match(out, /dry-run/);
  assert.match(out, /2026-05-30T00-00-00Z/);
  assert.match(out, /keptCount/);
  assert.match(out, /droppedCount/);
  // dry-run does not surface archive/manifest path rows.
  assert.doesNotMatch(out, /archivePath/);
  assert.doesNotMatch(out, /manifestPath/);
});

test('renderTable snapshot: applied surfaces archivePath + manifestPath rows', () => {
  const out = renderTable('snapshot', {
    mode: 'applied', ok: true, snapshotId: '2026-05-30T00-00-00Z',
    fileCount: 3, keptCount: 3, droppedCount: 0, dropped: [],
    archivePath: '/x/.mgr-state/snapshots/id/files.tar',
    manifestPath: '/x/.mgr-state/snapshots/id/manifest.json',
  });
  assert.match(out, /applied/);
  assert.match(out, /archivePath/);
  assert.match(out, /files\.tar/);
  assert.match(out, /manifestPath/);
  assert.match(out, /manifest\.json/);
});

test('renderTable snapshot: defensive on a missing/empty result', () => {
  const out = renderTable('snapshot', {});
  assert.match(out, /harness-mgr snapshot/);
  // mode cell is empty but the table still renders its field rows.
  assert.match(out, /snapshotId/);
});

// ── snapshot:list / snapshot:gc (the new management cases) ─────────────────────────

test('renderTable snapshot:list: one row per snapshot with completeness', () => {
  const out = renderTable('snapshot:list', {
    count: 2,
    snapshots: [
      { id: '2026-05-25T10-00-00Z', createdAt: '2026-05-25T00:00:00.000Z', reason: 'nightly', fileCount: 42, complete: true },
      { id: '2026-05-20T10-00-00Z', complete: false }, // incomplete → empty cells + complete:no
    ],
  });
  assert.match(out, /harness-mgr snapshot:list/);
  assert.match(out, /2026-05-25T10-00-00Z/);
  assert.match(out, /nightly/);
  assert.match(out, /42/);
  assert.match(out, /yes/); // complete:true
  assert.match(out, /no/);  // complete:false (the incomplete row)
});

test('renderTable snapshot:list: defensive on a missing snapshots array', () => {
  const out = renderTable('snapshot:list', {});
  assert.match(out, /harness-mgr snapshot:list/); // header renders even with no rows
});

test('renderTable snapshot:gc dry-run: header counts + a "would delete" row per id', () => {
  const out = renderTable('snapshot:gc', {
    mode: 'dry-run',
    deleted: [], wouldDelete: ['2026-05-20T10-00-00Z', '2026-05-18T10-00-00Z'], retained: ['2026-05-25T10-00-00Z'],
    deletedCount: 0, wouldDeleteCount: 2, retainedCount: 1,
  });
  assert.match(out, /gc dry-run: would delete 2, retained 1/);
  assert.match(out, /would delete/);
  assert.match(out, /2026-05-20T10-00-00Z/);
  assert.match(out, /2026-05-18T10-00-00Z/);
  assert.doesNotMatch(out, /2026-05-25T10-00-00Z/); // retained id is not a delete row
});

test('renderTable snapshot:gc applied: header + a "deleted" row per id', () => {
  const out = renderTable('snapshot:gc', {
    mode: 'applied',
    deleted: ['2026-05-20T10-00-00Z'], wouldDelete: [], retained: ['2026-05-25T10-00-00Z'],
    deletedCount: 1, wouldDeleteCount: 0, retainedCount: 1,
  });
  assert.match(out, /gc applied: deleted 1, retained 1/);
  assert.match(out, /2026-05-20T10-00-00Z/);
});

test('renderTable snapshot:gc: empty (nothing to delete) → header only, no rows table', () => {
  const out = renderTable('snapshot:gc', {
    mode: 'dry-run', deleted: [], wouldDelete: [], retained: [], deletedCount: 0, wouldDeleteCount: 0, retainedCount: 0,
  });
  assert.match(out, /gc dry-run: would delete 0, retained 0/);
});

// ── every other command case ─────────────────────────────────────────────────────

test('renderTable inventory: one row per count metric', () => {
  const out = renderTable('inventory', { counts: { skills: 10, agents: 2 }, statusLine: null, topDirs: [], unknownTopDirs: [] });
  assert.match(out, /skills/);
  assert.match(out, /agents/);
});

test('renderTable conflicts: one row per cluster', () => {
  const out = renderTable('conflicts', { conflicts: [{ kind: 'skill', key: 'foo', likelyWinner: 'plugin:foo' }] });
  assert.match(out, /skill/);
  assert.match(out, /plugin:foo/);
});

test('renderTable orphans: one row per orphan', () => {
  const out = renderTable('orphans', { orphans: [{ category: 'hard', name: 'weird.txt' }], summary: { hard: 1, soft: 0, total: 1 } });
  assert.match(out, /hard/);
  assert.match(out, /weird\.txt/);
});

test('renderTable config:show-effective: keys map → one row per key', () => {
  const out = renderTable('config:show-effective', { effective: {}, keys: { model: { mergeConfidence: 'known' } } });
  assert.match(out, /model/);
  assert.match(out, /known/);
});

test('renderTable config:show-effective: narrowed --key result falls back to kv dump', () => {
  const out = renderTable('config:show-effective', { key: 'model', merge: null, value: 'opus' });
  assert.match(out, /model/);
  assert.match(out, /opus/);
});

test('renderTable hooks: one row per event with merged count', () => {
  const out = renderTable('hooks', { hooks: { PreToolUse: [{}, {}], Stop: [{}] } });
  assert.match(out, /PreToolUse/);
  assert.match(out, /Stop/);
});

test('renderTable permissions: rows per rule, overbroad flagged', () => {
  const out = renderTable('permissions', { allow: ['Edit(*)', 'Bash(ls)'], ask: [], deny: ['Write(/etc/*)'], overbroad: ['Edit(*)'] });
  assert.match(out, /Edit\(\*\)/);
  assert.match(out, /Write\(\/etc\/\*\)/);
  assert.match(out, /yes/); // overbroad marker for Edit(*)
});

test('renderTable selftest: smoke checks table', () => {
  const out = renderTable('selftest', { checks: [{ name: 'lint', ok: true }, { name: 'boundary', ok: false }] });
  assert.match(out, /lint/);
  assert.match(out, /boundary/);
});

test('renderTable selftest: release-gate steps table', () => {
  const out = renderTable('selftest', { gate: 'release', pass: true, steps: [{ step: 1, name: 'catalog-tests', pass: true, detail: 'ok' }] });
  assert.match(out, /catalog-tests/);
  assert.match(out, /release-gate: PASS/);
});

test('renderTable selftest: schema-canary table', () => {
  const out = renderTable('selftest', { canary: 'schema', status: 'clean', changes: [] });
  assert.match(out, /schema-canary: clean/);
});

test('renderTable doctor: one row per check', () => {
  const out = renderTable('doctor', { probeLevel: 'passive', checks: [{ id: 6, code: 'settings-json-valid', ran: true, findings: 0 }] });
  assert.match(out, /settings-json-valid/);
});

test('renderTable audit: one row per entry', () => {
  const out = renderTable('audit', { entries: [{ timestamp: '2026-05-30T00:00:00Z', command: 'apply' }], summary: { total: 1, returned: 1 } });
  assert.match(out, /apply/);
});

test('renderTable drift: one row per change', () => {
  const out = renderTable('drift', { status: 'drifted', changes: [{ change: 'modified', path: 'settings.json' }], summary: {} });
  assert.match(out, /modified/);
  assert.match(out, /settings\.json/);
});

// ── generic fallback + defensive shapes ──────────────────────────────────────────

test('renderTable unknown command: generic key/value dump (incl. nested object → JSON)', () => {
  const out = renderTable('whatever', { a: 1, nested: { b: 2 } });
  assert.match(out, /harness-mgr whatever/);
  assert.match(out, /nested/);
  assert.match(out, /"b":2/); // scalarize JSON-stringifies an object value on one line
});

test('renderTable: a null result is coerced to {} → empty-rows table (header only, no throw)', () => {
  const out = renderTable('inventory', null);
  assert.match(out, /harness-mgr inventory/);
  assert.match(out, /metric/); // the inventory table header still renders
});

test('renderTable: a non-object (array) result falls through to the empty kv table', () => {
  const out = renderTable('orphans', [1, 2, 3]);
  // orphans reads r.orphans (absent on an array) → empty rows → title only.
  assert.match(out, /harness-mgr orphans/);
});

// ── quiet ────────────────────────────────────────────────────────────────────────

test('renderQuiet: one-line summary with the tallies', () => {
  assert.equal(renderQuiet('snapshot', 0, 2), 'snapshot: 0 error(s), 2 warning(s)');
  assert.equal(renderQuiet('doctor', 1, 0), 'doctor: 1 error(s), 0 warning(s)');
});
