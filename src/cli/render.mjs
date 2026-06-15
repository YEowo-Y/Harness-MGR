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
import { conflictsTable } from './conflicts-render.mjs';
import { effectiveSummary } from './config-effective-render.mjs';
import { snapshotListTable, snapshotGcTable } from './snapshot-store-render.mjs';
import { hooksTable } from './hooks-render.mjs';
import { healthTable } from './health-render.mjs';
import { skillProposeTable, skillAcceptTable } from './skill-render.mjs';

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
  // completion (P4b.U9) returns the RAW shell script with NO title line — a title
  // would corrupt a `source <(claude-mgr completion bash)`. Special-cased here.
  if (canonical === 'completion') {
    const r = isObject(result) ? result : {};
    return typeof r.script === 'string' ? r.script : '';
  }
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
    // config diff: mode-aware rendering.
    //   manifest mode → a readable added/removed/modified file-list block.
    //   content mode  → the raw unified-diff text (same as the old file mode).
    //   file mode (no .mode) → the raw unified-diff text (unchanged from P4b.U7b).
    case 'config:diff': return configDiffTable(r);
    case 'hooks': return hooksTable(r);
    // health (P5.U5): the severity-layered tier view lives in health-render.mjs.
    case 'health': return healthTable(r);
    case 'permissions': return permissionsTable(r);
    case 'selftest': return selftestTable(r);
    case 'doctor': return doctorTable(r);
    case 'audit': return auditTable(r);
    case 'drift': return driftTable(r);
    case 'snapshot': return snapshotTable(r);
    case 'snapshot:list': return snapshotListTable(r);
    case 'snapshot:gc': return snapshotGcTable(r);
    // skill propose (P5.U8): flat summary + raw unified diff (skill-render.mjs).
    case 'skill:propose': return skillProposeTable(r);
    // skill accept (P5.U9): flat overwrite summary (skill-render.mjs).
    case 'skill:accept': return skillAcceptTable(r);
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

// conflicts body lives in conflicts-render.mjs (P5.U10 SLOC split — the
// snapshot-store-render.mjs / health-render.mjs precedent): the cluster table
// plus the disposition advice section.

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
 * config:show-effective → per-key table. With `--explain` (result.explain===true):
 * provenance block (winner/layers). Without: mergeConfidence table. Falls back to
 * kvTable when `--key` narrowed the result (no `keys` map). Never throws.
 * @param {Record<string, unknown>} r
 */
function effectiveTable(r) {
  // Codex single-source effective ({effective} with NO merge `keys`): a digestible
  // per-top-level-key SUMMARY, not a 49 KB dump (--format json / --key give full values).
  if (isObject(r.effective) && !isObject(r.keys)) return effectiveSummary(r.effective);
  if (!isObject(r.keys)) return kvTable(r);

  if (r.explain === true) {
    // Provenance block: one line per top-level key.
    const lines = [];
    for (const key of Object.keys(r.keys)) {
      const km = isObject(r.keys[key]) ? r.keys[key] : {};
      const perLayer = Array.isArray(km.perLayer) ? km.perLayer : [];
      const layerNames = perLayer.map((e) => (isObject(e) && typeof e.name === 'string' ? e.name : '?'));
      const winnerStr = typeof km.winner === 'string' ? `winner: ${km.winner}` : `merged from ${layerNames.length} layer(s)`;
      const sourceStr = layerNames.length > 0 ? ` [${layerNames.join(', ')}]` : '';
      lines.push(`${key}: ${winnerStr}${sourceStr}`);
    }
    return lines.join('\n');
  }

  const rows = Object.keys(r.keys).map((key) => ({ key, mergeConfidence: r.keys[key] && r.keys[key].mergeConfidence }));
  return formatTable([
    { key: 'key', header: 'key' },
    { key: 'mergeConfidence', header: 'mergeConfidence' },
  ], rows);
}

// hooks body lives in hooks-render.mjs (P5.U4 SLOC split — the
// snapshot-store-render.mjs precedent): explanation rows + legacy count fallback.

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

/** selftest → release-gate step table, schema-canary table, or regular check table. @param {Record<string, unknown>} r */
function selftestTable(r) {
  // Release-gate path: result has gate:'release' and steps array.
  if (r.gate === 'release' && Array.isArray(r.steps)) {
    const steps = r.steps;
    const rows = steps.map((s) => ({
      step: s && s.step, name: s && s.name,
      ok: s && s.pass ? 'yes' : 'no', detail: s && s.detail,
    }));
    const pass = r.pass ? 'PASS' : 'FAIL';
    const table = formatTable([
      { key: 'step', header: 'step', align: 'right' },
      { key: 'name', header: 'name' },
      { key: 'ok', header: 'ok' },
      { key: 'detail', header: 'detail' },
    ], rows);
    return table ? `${table}\nrelease-gate: ${pass}` : `release-gate: ${pass}`;
  }
  // Schema-canary path: result has canary:'schema'.
  if (r.canary === 'schema') {
    const changes = Array.isArray(r.changes) ? r.changes : [];
    const rows = changes.map((c) => ({
      change: c && c.change, dimension: c && c.dimension, detail: c && c.detail,
    }));
    const status = typeof r.status === 'string' ? r.status : 'unknown';
    const table = rows.length > 0 ? formatTable([
      { key: 'change', header: 'change' },
      { key: 'dimension', header: 'dimension' },
      { key: 'detail', header: 'detail' },
    ], rows) : '';
    return table ? `${table}\nschema-canary: ${status}` : `schema-canary: ${status}`;
  }
  // Smoke/rigorous path: result has checks array.
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

/** audit → one row per log entry with timestamp and command. @param {Record<string, unknown>} r */
function auditTable(r) {
  const entries = Array.isArray(r.entries) ? r.entries : [];
  const rows = entries.map((e) => ({ timestamp: e && e.timestamp, command: e && e.command }));
  return formatTable([
    { key: 'timestamp', header: 'timestamp' },
    { key: 'command', header: 'command' },
  ], rows);
}

/** drift → one row per change (path + change kind). @param {Record<string, unknown>} r */
function driftTable(r) {
  const changes = Array.isArray(r.changes) ? r.changes : [];
  const rows = changes.map((c) => ({ change: c && c.change, path: c && c.path }));
  return formatTable([
    { key: 'change', header: 'change' },
    { key: 'path', header: 'path' },
  ], rows);
}

/**
 * snapshot → a key/value summary: mode (dry-run|applied), snapshotId, file/kept/
 * drop counts, and on a successful apply the archive + manifest paths. Defensive —
 * missing fields render as empty cells. @param {Record<string, unknown>} r
 */
function snapshotTable(r) {
  const rows = [
    { field: 'mode', value: r.mode },
    { field: 'snapshotId', value: r.snapshotId },
    { field: 'fileCount', value: r.fileCount },
    { field: 'keptCount', value: r.keptCount },
    { field: 'droppedCount', value: r.droppedCount },
  ];
  if (r.mode === 'applied') { rows.push({ field: 'archivePath', value: r.archivePath }); rows.push({ field: 'manifestPath', value: r.manifestPath }); }
  return formatTable([
    { key: 'field', header: 'field' },
    { key: 'value', header: 'value' },
  ], rows);
}

// snapshot:list + snapshot:gc bodies live in snapshot-store-render.mjs (imported
// above) so this module stays under the 200-SLOC lint ceiling.

/**
 * config:diff — mode-aware. manifest → file-list summary; else → unified text.
 * @param {Record<string, unknown>} r @returns {string}
 */
function configDiffTable(r) {
  if (r.mode !== 'manifest') return typeof r.unified === 'string' ? r.unified : '';
  const added = Array.isArray(r.added) ? r.added : [];
  const removed = Array.isArray(r.removed) ? r.removed : [];
  const modified = Array.isArray(r.modified) ? r.modified : [];
  const lines = [`snapshot diff ${typeof r.idA === 'string' ? r.idA : '?'} -> ${typeof r.idB === 'string' ? r.idB : '?'}`];
  for (const p of added) lines.push(`+ ${p}`);
  for (const p of removed) lines.push(`- ${p}`);
  for (const p of modified) lines.push(`~ ${p}`);
  if (!added.length && !removed.length && !modified.length) lines.push('no file changes');
  lines.push(`unchanged: ${typeof r.unchanged === 'number' ? r.unchanged : 0}`);
  return lines.join('\n');
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
function scalarize(v) { if (v === null || typeof v !== 'object') return v; try { return JSON.stringify(v); } catch { return String(v); } }

/** True for a non-null, non-array object. @param {unknown} v @returns {v is Record<string, unknown>} */
function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
