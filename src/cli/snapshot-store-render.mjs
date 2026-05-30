/**
 * Snapshot management table rendering (P3/P4a) — the `snapshot list` + `snapshot
 * gc` human-format bodies. Extracted from render.mjs so that module stays under
 * the 200-SLOC lint ceiling (mirroring the snapshot-store-command.mjs extraction
 * on the handler side). render.mjs's `renderBody` switch delegates here.
 *
 * Pure and never-throws — every cell flows through formatTable's String()
 * coercion; missing/incomplete records render as empty cells.
 *
 * Zero npm dependencies. Node stdlib only.
 */

import { formatTable } from '../output/table.mjs';

/**
 * snapshot:list → one row per snapshot (newest-first), with its id, createdAt,
 * reason, fileCount, and completeness. Defensive — a missing/incomplete record
 * renders empty cells.
 * @param {Record<string, unknown>} r
 * @returns {string}
 */
export function snapshotListTable(r) {
  const snapshots = Array.isArray(r.snapshots) ? r.snapshots : [];
  const rows = snapshots.map((s) => ({
    id: s && s.id,
    createdAt: s && s.createdAt,
    reason: s && s.reason,
    files: s && typeof s.fileCount === 'number' ? s.fileCount : '',
    complete: s && s.complete ? 'yes' : 'no',
  }));
  return formatTable([
    { key: 'id', header: 'id' },
    { key: 'createdAt', header: 'createdAt' },
    { key: 'reason', header: 'reason' },
    { key: 'files', header: 'files', align: 'right' },
    { key: 'complete', header: 'complete' },
  ], rows);
}

/**
 * snapshot:gc → a header line (mode + the relevant count) followed by one row per
 * affected id. In dry-run the rows are the WOULD-delete ids; on apply they are the
 * DELETED ids. Defensive — missing arrays render as an empty table.
 * @param {Record<string, unknown>} r
 * @returns {string}
 */
export function snapshotGcTable(r) {
  const applied = r.mode === 'applied';
  const ids = applied
    ? (Array.isArray(r.deleted) ? r.deleted : [])
    : (Array.isArray(r.wouldDelete) ? r.wouldDelete : []);
  const retainedCount = typeof r.retainedCount === 'number' ? r.retainedCount : 0;
  const verb = applied ? 'deleted' : 'would delete';
  const header = `gc ${applied ? 'applied' : 'dry-run'}: ${verb} ${ids.length}, retained ${retainedCount}`;
  const rows = ids.map((id) => ({ action: verb, id }));
  const table = formatTable([
    { key: 'action', header: 'action' },
    { key: 'id', header: 'id' },
  ], rows);
  return table ? `${header}\n${table}` : header;
}
