/**
 * Human + quiet output rendering for the CLI shell (P1.U15, sub-unit B).
 *
 * The shell (cli.mjs) owns argv parsing and dispatch; this module owns the two
 * NON-json renderings so cli.mjs stays small and each module stays ≤ ~200 LOC:
 *
 *   - renderTable(canonical, result) → a human block: a title line, a per-command
 *     `formatTable` of the most table-able slice of `result`, with a generic
 *     2-column key/value fallback for any shape not special-cased.
 *   - renderQuiet(canonical, errCount, warnCount) → a single deterministic summary
 *     line. The exit CODE carries the real signal; this is just a human breadcrumb.
 *
 * The diagnostics FOOTER (one line per diagnostic) is appended by cli.mjs, which
 * owns the merged diagnostics set — keeping that concern out of the per-command
 * table switch. Both functions are pure and never throw (every cell flows through
 * formatTable's String() coercion; unknown shapes hit the kv fallback).
 *
 * Zero npm dependencies. Node stdlib only. Pure.
 */

import { formatTable } from '../output/table.mjs';

/**
 * @typedef {import('./commands.mjs').CommandOutput} CommandOutput
 */

/**
 * Render the human (default-format) BODY for a command: a title line followed by
 * a table of the most relevant slice of `result`. The caller appends the
 * diagnostics footer. Any `result` shape without a dedicated case falls back to a
 * 2-column key/value dump, so this never returns empty for a real result.
 *
 * @param {string} canonical   the canonical command name
 * @param {unknown} result      the command's data payload
 * @returns {string}
 */
export function renderTable(canonical, result) {
  const title = `claude-mgr ${canonical}`;
  const body = renderBody(canonical, result);
  return body ? `${title}\n${body}` : title;
}

/**
 * Dispatch a result to its per-command table. The default arm is the generic
 * key/value dump, which also covers a null/non-object result (→ empty rows).
 *
 * @param {string} canonical
 * @param {unknown} result
 * @returns {string}
 */
function renderBody(canonical, result) {
  const r = isObject(result) ? result : {};
  switch (canonical) {
    case 'inventory': return inventoryTable(r);
    case 'conflicts': return conflictsTable(r);
    case 'orphans': return orphansTable(r);
    case 'config:show-effective': return effectiveTable(r);
    case 'hooks': return hooksTable(r);
    case 'permissions': return permissionsTable(r);
    case 'selftest': return selftestTable(r);
    case 'doctor': return doctorTable(r);
    default: return kvTable(r);
  }
}

/** inventory → one row per count metric. @param {Record<string, unknown>} r */
function inventoryTable(r) {
  const counts = isObject(r.counts) ? r.counts : {};
  const rows = Object.keys(counts).map((metric) => ({ metric, count: counts[metric] }));
  return formatTable([
    { key: 'metric', header: 'metric' },
    { key: 'count', header: 'count', align: 'right' },
  ], rows);
}

/** conflicts → one row per shadowing cluster. @param {Record<string, unknown>} r */
function conflictsTable(r) {
  const clusters = Array.isArray(r.conflicts) ? r.conflicts : [];
  const rows = clusters.map((c) => ({ kind: c && c.kind, key: c && c.key, likelyWinner: c && c.likelyWinner }));
  return formatTable([
    { key: 'kind', header: 'kind' },
    { key: 'key', header: 'key' },
    { key: 'likelyWinner', header: 'likelyWinner' },
  ], rows);
}

/** orphans → one row per orphan fact. @param {Record<string, unknown>} r */
function orphansTable(r) {
  const orphans = Array.isArray(r.orphans) ? r.orphans : [];
  const rows = orphans.map((o) => ({ category: o && o.category, name: o && o.name }));
  return formatTable([
    { key: 'category', header: 'category' },
    { key: 'name', header: 'name' },
  ], rows);
}

/**
 * config:show-effective → one row per top-level key with its merge confidence.
 * When `--key` narrowed the result there is no `keys` map, so fall back to the
 * generic key/value dump of the narrowed `{key, merge, value}`.
 * @param {Record<string, unknown>} r
 */
function effectiveTable(r) {
  if (!isObject(r.keys)) return kvTable(r);
  const rows = Object.keys(r.keys).map((key) => ({ key, mergeConfidence: r.keys[key] && r.keys[key].mergeConfidence }));
  return formatTable([
    { key: 'key', header: 'key' },
    { key: 'mergeConfidence', header: 'mergeConfidence' },
  ], rows);
}

/** hooks → one row per event with the count of merged hook entries. @param {Record<string, unknown>} r */
function hooksTable(r) {
  const hooks = isObject(r.hooks) ? r.hooks : {};
  const rows = Object.keys(hooks).map((event) => ({ event, count: Array.isArray(hooks[event]) ? hooks[event].length : 0 }));
  return formatTable([
    { key: 'event', header: 'event' },
    { key: 'count', header: 'count', align: 'right' },
  ], rows);
}

/** permissions → one row per rule (allow/ask/deny), flagging overbroad allow. @param {Record<string, unknown>} r */
function permissionsTable(r) {
  const overbroad = new Set(Array.isArray(r.overbroad) ? r.overbroad : []);
  const rows = [];
  for (const cat of ['allow', 'ask', 'deny']) {
    const list = Array.isArray(r[cat]) ? r[cat] : [];
    for (const rule of list) rows.push({ category: cat, rule, overbroad: cat === 'allow' && overbroad.has(rule) ? 'yes' : '' });
  }
  return formatTable([
    { key: 'category', header: 'category' },
    { key: 'rule', header: 'rule' },
    { key: 'overbroad', header: 'overbroad' },
  ], rows);
}

/** selftest → one row per check with its ok flag. @param {Record<string, unknown>} r */
function selftestTable(r) {
  const checks = Array.isArray(r.checks) ? r.checks : [];
  const rows = checks.map((c) => ({ name: c && c.name, ok: c && c.ok }));
  return formatTable([
    { key: 'name', header: 'check' },
    { key: 'ok', header: 'ok' },
  ], rows);
}

/** doctor → one row per registered check with its run status and finding count. @param {Record<string, unknown>} r */
function doctorTable(r) {
  const checks = Array.isArray(r.checks) ? r.checks : [];
  const rows = checks.map((c) => ({ id: c && c.id, code: c && c.code, ran: c && c.ran, findings: c && c.findings }));
  return formatTable([
    { key: 'id', header: 'id', align: 'right' },
    { key: 'code', header: 'code' },
    { key: 'ran', header: 'ran' },
    { key: 'findings', header: 'findings', align: 'right' },
  ], rows);
}

/**
 * Generic fallback: a 2-column key/value dump of an object's own enumerable
 * keys. Object/array values are JSON-stringified so they render on one line;
 * the table's String() coercion handles the rest. Never throws.
 * @param {Record<string, unknown>} r
 */
function kvTable(r) {
  const rows = Object.keys(r).map((key) => ({ key, value: scalarize(r[key]) }));
  return formatTable([
    { key: 'key', header: 'key' },
    { key: 'value', header: 'value' },
  ], rows);
}

/**
 * Render the QUIET one-line summary. The exit code is authoritative; this is a
 * short, deterministic human breadcrumb naming the command and its tallies.
 *
 * @param {string} canonical
 * @param {number} errCount    number of error-severity diagnostics
 * @param {number} warnCount   number of warn-severity diagnostics
 * @returns {string}
 */
export function renderQuiet(canonical, errCount, warnCount) {
  return `${canonical}: ${errCount} error(s), ${warnCount} warning(s)`;
}

/**
 * Collapse a value to a one-line string for the kv fallback: objects/arrays via
 * JSON (degrading to String() on an unserializable value), primitives untouched.
 * @param {unknown} v
 * @returns {unknown}
 */
function scalarize(v) {
  if (v === null || typeof v !== 'object') return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}

/**
 * True for a non-null, non-array object — the shape every table reader expects.
 * @param {unknown} v
 * @returns {v is Record<string, unknown>}
 */
function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
