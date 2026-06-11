/**
 * hooks table renderer (P5.U4) — extracted from render.mjs to keep that module
 * under the 200-SLOC lint ceiling (the snapshot-store-render.mjs precedent).
 *
 * With `explanations` present (the P5.U4 hooks result shape) renders one row
 * per explained hook entry — event / status / explanation — so the owner reads
 * 'On X (when…), for Y, runs Z (kind, status)' at a glance. Falls back to the
 * legacy event+count rows when `explanations` is absent (old-shape results).
 *
 * Defensive on malformed input (null rows, missing fields → empty cells via
 * formatTable's String() coercion); pure; never throws.
 */

import { formatTable } from '../output/table.mjs';

/** True for a non-null, non-array object. @param {unknown} v */
function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

/**
 * hooks → explanation rows (new shape) or event+count rows (legacy fallback).
 * @param {unknown} r the hooks command result
 * @returns {string}
 */
export function hooksTable(r) {
  const obj = isObj(r) ? r : {};

  if (Array.isArray(obj.explanations)) {
    const rows = obj.explanations.map((e) => ({
      event: e && e.event,
      status: e && e.status,
      explanation: e && e.explanation,
    }));
    return formatTable([
      { key: 'event', header: 'event' },
      { key: 'status', header: 'status' },
      { key: 'explanation', header: 'explanation' },
    ], rows);
  }

  const hooks = isObj(obj.hooks) ? obj.hooks : {};
  const rows = Object.keys(hooks).map((event) => ({ event, count: Array.isArray(hooks[event]) ? hooks[event].length : 0 }));
  return formatTable([
    { key: 'event', header: 'event' },
    { key: 'count', header: 'count', align: 'right' },
  ], rows);
}
