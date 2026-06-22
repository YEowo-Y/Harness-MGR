/**
 * `compare` table body (SLOC split out of render.mjs — the conflicts-render.mjs /
 * health-render.mjs precedent).
 *
 * Two parts:
 *   1. a per-target totals header line, then a per-category COUNTS table
 *      (category | <each target's total> | both | <each target>-only) built with
 *      columns derived from the summary's `targets` so it generalises past two.
 *   2. the divergence list — full ONLY with `--detail` (result.detail===true, the
 *      config-effective `--explain` precedent); otherwise a one-line hint pointing
 *      at --detail / --format json. This keeps the default human view compact even
 *      when one target has hundreds of unique components.
 *
 * Defensive: missing fields render as safe blanks/zeros; never throws. Pure; zero
 * npm dependencies; Node stdlib only.
 */

import { formatTable } from '../output/table.mjs';

/** True for a non-null, non-array object. @param {unknown} v @returns {v is Record<string, unknown>} */
function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
/** @param {unknown} v @returns {any[]} */
function arr(v) { return Array.isArray(v) ? v : []; }

/**
 * compare → totals header + per-category counts table + (with --detail) the
 * divergent-item list. @param {Record<string, unknown>} r @returns {string}
 */
export function compareTable(r) {
  const obj = isObject(r) ? r : {};
  const targets = arr(obj.targets).filter(isObject);
  const categories = arr(obj.categories).filter(isObject);
  const items = arr(obj.items).filter(isObject);

  const header = targets.map((t) => `${t.id} (${t.label}): ${t.total ?? 0}`).join('  ·  ');

  // Counts table: columns generated per target so 3+ targets would still render.
  const cols = [{ key: 'category', header: 'category' }];
  for (const t of targets) cols.push({ key: `t_${t.id}`, header: String(t.id), align: 'right' });
  cols.push({ key: 'both', header: 'both', align: 'right' });
  for (const t of targets) cols.push({ key: `only_${t.id}`, header: `${t.id}-only`, align: 'right' });

  const rows = categories.map((c) => {
    const totals = isObject(c.totals) ? c.totals : {};
    const only = isObject(c.only) ? c.only : {};
    const row = { category: c.category, both: c.both ?? 0 };
    for (const t of targets) { row[`t_${t.id}`] = totals[t.id] ?? 0; row[`only_${t.id}`] = only[t.id] ?? 0; }
    return row;
  });
  const counts = formatTable(cols, rows);

  let out = header ? `${header}\n\n${counts}` : counts;

  if (obj.detail === true) {
    out += items.length === 0
      ? '\n\ndivergent: (none — every name present on all targets)'
      : `\n\ndivergent (present on a subset of targets):\n${formatTable(
        [{ key: 'category', header: 'category' }, { key: 'name', header: 'name' }, { key: 'presence', header: 'only in' }],
        items.map((it) => ({ category: it.category, name: it.name ?? it.key ?? '', presence: it.presence ?? '' })),
      )}`;
  } else if (items.length > 0) {
    out += `\n\n${items.length} divergent item(s) — pass --detail or --format json to list them`;
  }
  return out;
}
