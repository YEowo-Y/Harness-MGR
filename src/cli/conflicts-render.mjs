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
 * conflicts → one row per shadowing cluster, then the disposition advice block, then
 * (codex only) the co-existence block. `coexistence` is absent on Claude → that
 * section is omitted and the output is byte-identical to the pre-P6 render.
 * @param {Record<string, unknown>} r @returns {string}
 */
export function conflictsTable(r) {
  const obj = isObject(r) ? r : {};
  const clusters = Array.isArray(obj.conflicts) ? obj.conflicts : [];
  const rows = clusters.map((c) => ({ kind: c && c.kind, key: c && c.key, likelyWinner: c && c.likelyWinner }));
  let out = formatTable([
    { key: 'kind', header: 'kind' },
    { key: 'key', header: 'key' },
    { key: 'likelyWinner', header: 'likelyWinner' },
  ], rows);
  const disp = dispositionLines(Array.isArray(obj.dispositions) ? obj.dispositions : []);
  if (disp) out += `\n\ndispositions:\n${disp}`;
  // Codex co-existence (same name from multiple sources, all load, no winner).
  const co = coexistenceLines(Array.isArray(obj.coexistence) ? obj.coexistence : []);
  if (co) out += `\n\nco-existence (codex — same name from multiple sources, all load):\n${co}`;
  return out;
}

/**
 * Format the codex co-existence block (one stanza per co-existing name). Defensive;
 * never throws.
 * @param {unknown[]} coexistence @returns {string}
 */
function coexistenceLines(coexistence) {
  const lines = [];
  for (const c of coexistence) {
    const cc = isObject(c) ? c : {};
    lines.push(`  ${cc.kind}:${cc.name} (${cc.count ?? 0} sources)`);
    for (const s of Array.isArray(cc.sources) ? cc.sources : []) {
      const ss = isObject(s) ? s : {};
      const prov = ss.tier === 'plugin' ? `plugin ${ss.plugin ?? '?'}@${ss.marketplace ?? '?'}` : String(ss.tier ?? 'user');
      lines.push(`    ${prov}: ${ss.path ?? ''}`);
    }
  }
  return lines.join('\n');
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
