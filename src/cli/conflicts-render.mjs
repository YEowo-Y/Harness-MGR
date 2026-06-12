/**
 * conflicts table body (P5.U10 SLOC split out of render.mjs — the
 * snapshot-store-render.mjs / health-render.mjs precedent).
 *
 * Renders the shadowing-cluster table followed by the P5.U10 DISPOSITION
 * section: for each disposition the loader winner path + each shadowed loser
 * (its `remove` command when removable, else a plugin disable/uninstall
 * advisory) + the one-sentence suggestion. Defensive — missing fields render as
 * safe blanks; never throws (every cell flows through String() coercion or a
 * nullish fallback). Pure; zero npm dependencies; Node stdlib only.
 */

import { formatTable } from '../output/table.mjs';

/** True for a non-null, non-array object. @param {unknown} v @returns {v is Record<string, unknown>} */
function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

/**
 * conflicts → one row per shadowing cluster, then the disposition advice block.
 * @param {Record<string, unknown>} r @returns {string}
 */
export function conflictsTable(r) {
  const obj = isObject(r) ? r : {};
  const clusters = Array.isArray(obj.conflicts) ? obj.conflicts : [];
  const rows = clusters.map((c) => ({ kind: c && c.kind, key: c && c.key, likelyWinner: c && c.likelyWinner }));
  const table = formatTable([
    { key: 'kind', header: 'kind' },
    { key: 'key', header: 'key' },
    { key: 'likelyWinner', header: 'likelyWinner' },
  ], rows);
  const disp = dispositionLines(Array.isArray(obj.dispositions) ? obj.dispositions : []);
  return disp ? `${table}\n\ndispositions:\n${disp}` : table;
}

/**
 * Format the disposition advice block (one stanza per disposition). Defensive;
 * never throws.
 * @param {unknown[]} dispositions @returns {string}
 */
function dispositionLines(dispositions) {
  const lines = [];
  for (const d of dispositions) {
    const dd = isObject(d) ? d : {};
    const w = isObject(dd.winner) ? dd.winner : {};
    lines.push(`  ${dd.kind}:${dd.key} keeps ${w.path ?? ''}`);
    for (const s of Array.isArray(dd.shadowed) ? dd.shadowed : []) {
      const ss = isObject(s) ? s : {};
      const how = ss.removable && typeof ss.removeCommand === 'string'
        ? ss.removeCommand : `(plugin ${ss.plugin ?? '?'} — disable/uninstall)`;
      lines.push(`    shadowed: ${ss.path ?? ''} -> ${how}`);
    }
    if (typeof dd.suggestion === 'string') lines.push(`    ${dd.suggestion}`);
  }
  return lines.join('\n');
}
