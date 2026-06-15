/**
 * config:show-effective SUMMARY table for a single-source effective view (P6 — codex
 * effective table summary).
 *
 * The Codex `config show-effective` result is `{ effective }` with NO merge `keys`
 * (config.toml is one source). Its table render used to fall through to the generic
 * kvTable, which DUMPS the whole ~49 KB config — unreadable. This renders a digestible
 * SUMMARY instead: one row per TOP-LEVEL key, with the value summarized — a scalar
 * shows its (truncated) value, a redacted leaf shows `<redacted>`, an array shows
 * `[array: N]`, a nested table shows `{table: N keys}`. The FULL config stays available
 * via `--format json` (the machine surface) and `--key <name>` (drill-down) — the table
 * is the human overview, so a one-line note points there.
 *
 * The input is ALREADY redacted (redactEffective ran in the command), so a redacted
 * scalar leaf is the `{redacted:true, sha256}` sentinel — rendered as `<redacted>`,
 * never expanded.
 *
 * Pure; never throws; depends only on output/table.mjs. Zero npm deps.
 */

import { formatTable } from '../output/table.mjs';

/** True for a non-null, non-array object. @param {unknown} v @returns {boolean} */
function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

/**
 * Summarize one value for the overview table: scalar → (truncated) value; redaction
 * sentinel → `<redacted>`; array → `[array: N]`; table → `{table: N keys}`.
 * @param {unknown} v @returns {string}
 */
export function summarizeValue(v) {
  if (v === null) return 'null';
  if (isObject(v) && v.redacted === true) return '<redacted>';
  if (Array.isArray(v)) return `[array: ${v.length}]`;
  if (isObject(v)) return `{table: ${Object.keys(v).length} keys}`;
  const s = typeof v === 'string' ? v : String(v);
  return s.length > 60 ? `${s.slice(0, 59)}…` : s;
}

/**
 * Render the single-source effective config as a per-top-level-key summary table,
 * sorted by key, with a note pointing to --key / --format json for full values.
 * @param {Record<string, unknown>} effective @returns {string}
 */
export function effectiveSummary(effective) {
  const keys = isObject(effective) ? Object.keys(effective).sort() : [];
  const rows = keys.map((key) => ({ key, value: summarizeValue(effective[key]) }));
  const table = formatTable([{ key: 'key', header: 'key' }, { key: 'value', header: 'value' }], rows);
  return `config summary — ${keys.length} top-level key(s); use --key <name> or --format json for full values\n${table}`;
}
