/**
 * Audit-log reader (P2.U10) — READ-ONLY viewer for .mgr-state/audit.log.
 *
 * Reads and optionally filters the metadata-only JSONL audit log produced by
 * the write side (P3.U20). Entries are opaque objects; only `timestamp` is
 * examined for filtering/sorting.
 *
 * NOTE: large-entry pointer resolution (audit-large/<uuid>.json), following the
 * P3.U20 writer format, is intentionally NOT handled here — every line is read
 * as an inline JSONL entry.
 *
 * NOTE: `readAuditLog` with `since` undefined returns ALL entries; the CLI layer
 * may apply a default window later.
 *
 * Ops-layer constraint: imports only node:* stdlib and src/lib/**. Never throws.
 * Zero npm dependencies.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DiagnosticBag } from '../lib/diagnostic.mjs';

/** @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic */

/** JSONL filename inside stateDir. */
const AUDIT_LOG_NAME = 'audit.log';

/** Duration unit -> milliseconds. */
const UNIT_MS = { s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 };

/** Matches e.g. '7d', '24h', '30m', '2w' (no interior space). Case-insensitive. */
const SINCE_RE = /^(\d+)([smhdw])$/i;

/**
 * @typedef {Object} AuditSummary
 * @property {number} total              well-formed entries seen BEFORE the --since filter
 * @property {number} returned           entries returned AFTER the filter (total ≥ returned)
 * @property {number} skippedMalformed   lines skipped due to parse/type errors
 * @property {string|null} oldest        ISO of oldest epoch among RETURNED entries, or null
 * @property {string|null} newest        ISO of newest epoch among RETURNED entries, or null
 */

/**
 * Parse a --since duration string (e.g. '7d', '24h', '30m') into milliseconds.
 * Returns null on any invalid input.
 * @param {unknown} since
 * @returns {number | null}
 */
export function parseSince(since) {
  if (typeof since !== 'string' || since.length === 0) return null;
  const trimmed = since.trim();
  const m = SINCE_RE.exec(trimmed);
  if (!m) return null;
  const ms = Number(m[1]) * UNIT_MS[m[2].toLowerCase()];
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Convert a timestamp value (ISO string or epoch-ms number) to epoch milliseconds.
 * Returns null for unrecognised types, non-finite numbers, or unparseable strings.
 * @param {unknown} timestamp
 * @returns {number | null}
 */
export function toEpochMs(timestamp) {
  if (typeof timestamp === 'number') {
    return Number.isFinite(timestamp) ? timestamp : null;
  }
  if (typeof timestamp === 'string') {
    const t = Date.parse(timestamp);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

/**
 * Build an empty summary object.
 * @returns {AuditSummary}
 */
function emptySummary() {
  return { total: 0, returned: 0, skippedMalformed: 0, oldest: null, newest: null };
}

/**
 * Parse the JSONL text and return kept entries (with their epoch) plus a
 * count of malformed lines. Extracted so readAuditLog stays under 80 SLOC.
 *
 * @param {string} text      raw file contents
 * @param {number|null} cutoff  epoch-ms lower bound, or null to keep all
 * @returns {{ kept: Array<{ entry: object, epoch: number|null }>, skippedMalformed: number, total: number }}
 */
function collectEntries(text, cutoff) {
  const lines = text.split(/\r?\n/);
  /** @type {Array<{ entry: object, epoch: number|null }>} */
  const kept = [];
  let skippedMalformed = 0;
  let total = 0; // well-formed entries seen, counted BEFORE the --since cutoff

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      skippedMalformed++;
      continue;
    }

    // Must be a plain object (not null, not array)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      skippedMalformed++;
      continue;
    }
    total++; // a well-formed entry (counted before the --since cutoff drops some)

    const epoch = toEpochMs(parsed.timestamp);

    if (cutoff !== null) {
      // Drop entries with no/invalid timestamp while filtering
      if (epoch === null || epoch < cutoff) continue;
    }

    kept.push({ entry: parsed, epoch });
  }

  return { kept, skippedMalformed, total };
}

/**
 * Read and optionally filter the audit log.
 *
 * @param {object} [opts]
 * @param {string} [opts.stateDir]         path to the .mgr-state directory
 * @param {string} [opts.since]            duration string e.g. '7d'; undefined = all
 * @param {() => number} [opts.now]        clock injection (defaults to Date.now)
 * @param {(path: string) => string} [opts.readFn]  injectable reader for tests
 * @returns {{ entries: object[], diagnostics: Diagnostic[], summary: AuditSummary }}
 */
export function readAuditLog(opts) {
  const { stateDir, since, now = () => Date.now(), readFn } = opts ?? {};
  const bag = new DiagnosticBag();

  if (typeof stateDir !== 'string' || stateDir.length === 0) {
    bag.add({ severity: 'error', code: 'audit-bad-state-dir',
      message: 'stateDir must be a non-empty string', phase: 'audit' });
    return { entries: [], diagnostics: bag.all(), summary: emptySummary() };
  }

  const path = join(stateDir, AUDIT_LOG_NAME);
  let text;
  try {
    text = readFn ? readFn(path) : readFileSync(path, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      // Benign: no audit log written yet
      return { entries: [], diagnostics: bag.all(), summary: emptySummary() };
    }
    const msg = err instanceof Error ? err.message : String(err);
    bag.add({ severity: 'warn', code: 'audit-log-unreadable', message: msg,
      path, phase: 'audit' });
    return { entries: [], diagnostics: bag.all(), summary: emptySummary() };
  }

  // Resolve --since cutoff
  let cutoff = null;
  if (since !== undefined && since !== null) {
    const ms = parseSince(since);
    if (ms === null) {
      bag.add({ severity: 'warn', code: 'audit-since-invalid',
        message: `ignoring invalid --since '${since}'; showing all entries`,
        phase: 'audit' });
    } else {
      cutoff = now() - ms;
    }
  }

  const { kept, skippedMalformed, total } = collectEntries(text, cutoff);

  // Sort newest-first; null epochs sort last
  kept.sort((a, b) => (b.epoch ?? -Infinity) - (a.epoch ?? -Infinity));

  const entries = kept.map((k) => k.entry);

  // Compute oldest/newest from non-null epochs among kept
  let oldest = null;
  let newest = null;
  for (const { epoch } of kept) {
    if (epoch === null) continue;
    if (oldest === null || epoch < oldest) oldest = epoch;
    if (newest === null || epoch > newest) newest = epoch;
  }

  /** @type {AuditSummary} */
  const summary = {
    total,
    returned: entries.length,
    skippedMalformed,
    oldest: oldest !== null ? new Date(oldest).toISOString() : null,
    newest: newest !== null ? new Date(newest).toISOString() : null,
  };

  return { entries, diagnostics: bag.all(), summary };
}
