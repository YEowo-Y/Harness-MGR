/**
 * Stability-log helpers (P3 gate infrastructure).
 *
 * Reads and writes the machine-readable STABILITY-LOG.jsonl at the repo root.
 * Each line is one JSON object: {ts, cc_version, gate_pass, error_diag_count, note?}.
 *
 * Ops-layer constraint: imports only node:fs / node:path / src/lib/diagnostic.mjs.
 * Never throws. Inputs never mutated. PURITY: no wall-clock reads (caller supplies row.ts).
 * Zero npm dependencies.
 */

import { readFileSync, appendFileSync } from 'node:fs';
import { DiagnosticBag } from '../lib/diagnostic.mjs';

/** @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic */

/**
 * One row in the stability log.
 *
 * @typedef {Object} Row
 * @property {string}  ts                ISO timestamp string supplied by the caller
 * @property {string}  cc_version        Claude Code version string, e.g. '2.1.146'
 * @property {boolean} gate_pass         true only when the gate run was clean
 * @property {number}  error_diag_count  count of error-severity diagnostics found
 * @property {string}  [note]            optional human note
 */

/**
 * Reject prototype-poisoning keys.
 * @param {string} key
 * @returns {boolean}
 */
function isSafeKey(key) {
  return key !== '__proto__' && key !== 'constructor' && key !== 'prototype';
}

/**
 * Parse STABILITY-LOG.jsonl text into rows.
 * Splits on newlines, trims, skips blanks; JSON.parse each line.
 * Non-objects and parse failures increment malformed and are skipped.
 * Proto-poisoning keys are stripped from each row.
 *
 * @param {string} text
 * @returns {{ rows: Row[], malformed: number }}
 */
export function parseStabilityLog(text) {
  if (typeof text !== 'string') return { rows: [], malformed: 0 };

  const lines = text.split(/\r?\n/);
  /** @type {Row[]} */
  const rows = [];
  let malformed = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      malformed++;
      continue;
    }

    // Must be a plain non-null non-array object
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      malformed++;
      continue;
    }

    // Build a null-proto row, stripping proto-poisoning keys
    const row = /** @type {Row} */ (Object.create(null));
    for (const key of Object.keys(parsed)) {
      if (isSafeKey(key)) row[key] = parsed[key];
    }
    rows.push(row);
  }

  return { rows, malformed };
}

/**
 * Count rows where gate_pass === true (strict boolean; "true"/1 do not count).
 * Accepts either a raw JSONL text string or an already-parsed rows array.
 *
 * @param {string | Row[]} textOrRows
 * @returns {number}
 */
export function countGatePass(textOrRows) {
  const rows = Array.isArray(textOrRows)
    ? textOrRows
    : parseStabilityLog(typeof textOrRows === 'string' ? textOrRows : '').rows;

  let count = 0;
  for (const row of rows) {
    if (row !== null && typeof row === 'object' && row.gate_pass === true) count++;
  }
  return count;
}

/**
 * Serialize one row to a single-line compact JSON with STABLE key order:
 * ts, cc_version, gate_pass, error_diag_count, note (if present).
 * Never throws — unserializable values degrade to a safe representation.
 *
 * @param {Row} row
 * @returns {string}
 */
export function formatRow(row) {
  try {
    if (row === null || typeof row !== 'object') {
      return JSON.stringify({ ts: '', cc_version: '', gate_pass: false, error_diag_count: 0 });
    }

    // Build object with the canonical stable key order
    /** @type {Record<string, unknown>} */
    const out = {};
    out.ts = safeScalar(row.ts);
    out.cc_version = safeScalar(row.cc_version);
    out.gate_pass = typeof row.gate_pass === 'boolean' ? row.gate_pass : false;
    out.error_diag_count = typeof row.error_diag_count === 'number' ? row.error_diag_count : 0;
    if (Object.prototype.hasOwnProperty.call(row, 'note') && row.note !== undefined) {
      out.note = safeScalar(row.note);
    }

    return JSON.stringify(out);
  } catch {
    return JSON.stringify({ ts: '', cc_version: '', gate_pass: false, error_diag_count: 0, error: 'unserializable' });
  }
}

/**
 * Convert a value to a JSON-serializable scalar. BigInt and unserializable
 * types degrade to their string representation so JSON.stringify never throws.
 *
 * @param {unknown} v
 * @returns {unknown}
 */
function safeScalar(v) {
  if (typeof v === 'bigint') return v.toString();
  try {
    JSON.stringify(v);
    return v;
  } catch {
    return String(v);
  }
}

/**
 * Append one row to the stability log file (creates the file if absent).
 * Writes STABILITY-LOG.jsonl in the repo root — a plain repo file, NOT a
 * governed-config write, so assertWritable is NOT used here.
 *
 * @param {{ logPath: string, row: Row }} opts
 * @returns {{ ok: boolean, diagnostics: Diagnostic[] }}
 */
export function appendStabilityRow(opts) {
  const { logPath, row } = (opts !== null && typeof opts === 'object' ? opts : {});
  const bag = new DiagnosticBag();

  if (typeof logPath !== 'string' || logPath.length === 0) {
    bag.add({ severity: 'error', code: 'stability-log-bad-path',
      message: 'logPath must be a non-empty string', phase: 'stability-log' });
    return { ok: false, diagnostics: bag.all() };
  }

  try {
    const line = formatRow(row) + '\n';
    appendFileSync(logPath, line, 'utf8');
    return { ok: true, diagnostics: bag.all() };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    bag.add({ severity: 'error', code: 'stability-log-write-failed',
      message, phase: 'stability-log', path: logPath });
    return { ok: false, diagnostics: bag.all() };
  }
}

/**
 * Read the stability log from disk.
 * ENOENT is benign (a missing log means no runs logged yet).
 * Other read errors produce one Diagnostic.
 *
 * @param {{ logPath: string }} opts
 * @returns {{ rows: Row[], malformed: number, gatePassCount: number, missing: boolean, diagnostics: Diagnostic[] }}
 */
export function readStabilityLog(opts) {
  const { logPath } = (opts !== null && typeof opts === 'object' ? opts : {});
  const bag = new DiagnosticBag();

  if (typeof logPath !== 'string' || logPath.length === 0) {
    bag.add({ severity: 'error', code: 'stability-log-bad-path',
      message: 'logPath must be a non-empty string', phase: 'stability-log' });
    return { rows: [], malformed: 0, gatePassCount: 0, missing: false, diagnostics: bag.all() };
  }

  let text;
  try {
    text = readFileSync(logPath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { rows: [], malformed: 0, gatePassCount: 0, missing: true, diagnostics: [] };
    }
    const message = err instanceof Error ? err.message : String(err);
    bag.add({ severity: 'warn', code: 'stability-log-unreadable',
      message, phase: 'stability-log', path: logPath });
    return { rows: [], malformed: 0, gatePassCount: 0, missing: false, diagnostics: bag.all() };
  }

  const { rows, malformed } = parseStabilityLog(text);
  const gatePassCount = countGatePass(rows);
  return { rows, malformed, gatePassCount, missing: false, diagnostics: bag.all() };
}
