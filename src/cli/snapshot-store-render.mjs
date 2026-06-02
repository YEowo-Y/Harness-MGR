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
 * snapshot:gc → a header line (mode + the snapshot count) followed by one row per
 * affected snapshot id, then the THREE extra cleanup categories (audit-large orphans
 * / orphan apply-lock / leftover sidecars). In dry-run the snapshot rows are the
 * WOULD-delete ids and the extra lines show the would-delete/would-reap counts; on
 * apply they show the actually-deleted/reaped counts. Defensive — missing fields
 * render as 0 and missing arrays as an empty table.
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
  const body = table ? `${header}\n${table}` : header;
  return `${body}\n${extraCategoryLines(applied, r)}`;
}

/**
 * The three extra-category summary lines. Each names its category and the count for
 * the current mode (deleted/reaped on apply, would-delete/would-reap in dry-run).
 * Defensive — a missing category object or count reads as 0.
 * @param {boolean} applied
 * @param {Record<string, unknown>} r
 * @returns {string}
 */
function extraCategoryLines(applied, r) {
  const al = obj(r.auditLarge);
  const lk = obj(r.lock);
  const lo = obj(r.leftovers);
  const fileVerb = applied ? 'deleted' : 'would-delete';
  const lockVerb = applied ? 'reaped' : 'would-reap';
  return [
    `audit-large: ${fileVerb} ${num(applied ? al.deleted : al.wouldDelete)}`,
    `lock: ${lockVerb} ${num(applied ? lk.reaped : lk.wouldReap)}`,
    `leftovers: ${fileVerb} ${num(applied ? lo.deleted : lo.wouldDelete)}`,
  ].join('\n');
}

/** A plain object or {} (never null/array). @param {unknown} v @returns {Record<string, unknown>} */
function obj(v) {
  return v && typeof v === 'object' && !Array.isArray(v) ? /** @type {Record<string, unknown>} */ (v) : {};
}

/** A finite number or 0. @param {unknown} v @returns {number} */
function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
