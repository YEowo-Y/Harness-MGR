/**
 * Schema-canary fingerprint compute + compare (P3 gate infrastructure).
 *
 * PURE: no fs/crypto/paths imports. All I/O lives in probe-schema.mjs.
 * Never throws — every code path is guarded.
 *
 * Exports:
 *   computeFingerprint(facts) → { fingerprint, dimensions, diagnostics }
 *   compareFingerprint({ current, baseline }) → { status, changes, summary, diagnostics }
 *
 * Fingerprint = sha256 over stableStringify(dimensions), exactly like probe-state.mjs.
 * Drift → a single WARN 'schema-drift-detected'. Code ALWAYS 0 (drift is advisory).
 *
 * @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic
 */

import { createHash } from 'node:crypto';
import { stableStringify } from '../output/json.mjs';

// ── types ─────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} SchemaFacts
 * @property {number|null} pluginSchemaVersion    numeric version from installed_plugins.json
 * @property {string[]} settingsKeys              top-level key names of settings.json
 * @property {string[]} topDirs                   top-level dir names under configDir
 * @property {string[]} hookEvents                hook lifecycle event names in settings.json
 * @property {number} mcpServerCount              total MCP server count
 * @property {string[]} mcpTransports             distinct transport types
 * @property {string[]} appKeys                   top-level key names of ~/.claude.json
 */

/**
 * @typedef {Object} SchemaDimensions
 * @property {number|null} pluginSchemaVersion
 * @property {string[]} settingsKeys
 * @property {string[]} topDirs
 * @property {string[]} hookEvents
 * @property {number} mcpServerCount
 * @property {string[]} mcpTransports
 * @property {string[]} appKeys
 */

/**
 * @typedef {'no-baseline'|'clean'|'drifted'} CanaryStatus
 */

/**
 * @typedef {Object} CanaryChange
 * @property {'added'|'removed'|'modified'} change
 * @property {string} dimension
 * @property {string} detail
 */

// ── helpers ───────────────────────────────────────────────────────────────────

const POISON = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * @param {unknown} v
 * @returns {boolean}
 */
function isPlainObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Sort a string array safely. Returns a new sorted array.
 * @param {unknown} arr
 * @returns {string[]}
 */
function safeStringArr(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.filter((x) => typeof x === 'string').sort();
}

/**
 * Sha256 hex over a Buffer.
 * @param {Buffer} buf
 * @returns {string}
 */
function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

// ── computeFingerprint ────────────────────────────────────────────────────────

/**
 * Build the names-only schema fingerprint from already-gathered facts.
 * The returned `dimensions` contains ONLY names/sets/counts — NEVER values.
 *
 * @param {SchemaFacts|unknown} facts
 * @returns {{ fingerprint: string, dimensions: SchemaDimensions, diagnostics: Diagnostic[] }}
 */
export function computeFingerprint(facts) {
  try {
    const f = isPlainObj(facts) ? /** @type {SchemaFacts} */ (facts) : {};

    const pluginSchemaVersion = (f.pluginSchemaVersion != null && typeof f.pluginSchemaVersion === 'number')
      ? f.pluginSchemaVersion : null;

    const settingsKeys = safeStringArr(f.settingsKeys);
    const topDirs = safeStringArr(f.topDirs);
    const hookEvents = safeStringArr(f.hookEvents);

    const mcpServerCount = (typeof f.mcpServerCount === 'number' && Number.isFinite(f.mcpServerCount))
      ? Math.floor(f.mcpServerCount) : 0;

    const mcpTransports = safeStringArr(f.mcpTransports);
    const appKeys = safeStringArr(f.appKeys);

    /** @type {SchemaDimensions} */
    const dimensions = {
      pluginSchemaVersion,
      settingsKeys,
      topDirs,
      hookEvents,
      mcpServerCount,
      mcpTransports,
      appKeys,
    };

    const fingerprint = sha256Hex(Buffer.from(stableStringify(dimensions)));
    return { fingerprint, dimensions, diagnostics: [] };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err ?? '');
    return {
      fingerprint: '',
      dimensions: {
        pluginSchemaVersion: null,
        settingsKeys: [],
        topDirs: [],
        hookEvents: [],
        mcpServerCount: 0,
        mcpTransports: [],
        appKeys: [],
      },
      diagnostics: [{ severity: 'error', code: 'schema-canary-compute-failed', message: msg, phase: 'schema-canary' }],
    };
  }
}

// ── compareFingerprint ────────────────────────────────────────────────────────

/**
 * Diff current vs baseline dimensions. Pure — no I/O.
 *
 * @param {{ current?: unknown, baseline?: unknown }} [input]
 * @returns {{ status: CanaryStatus, changes: CanaryChange[], summary: {added:number, removed:number, modified:number}, diagnostics: Diagnostic[] }}
 */
export function compareFingerprint(input) {
  const emptySummary = { added: 0, removed: 0, modified: 0 };
  try {
    const { current, baseline } = input ?? {};

    if (!isPlainObj(baseline) || !('fingerprint' in baseline) || !('dimensions' in baseline)) {
      return {
        status: 'no-baseline',
        changes: [],
        summary: emptySummary,
        diagnostics: [{ severity: 'info', code: 'schema-canary-no-baseline', message: 'no schema baseline committed yet; run selftest --schema-canary --update-baseline to create one', phase: 'schema-canary' }],
      };
    }

    if (!isPlainObj(current) || !('fingerprint' in current) || !('dimensions' in current)) {
      return {
        status: 'no-baseline',
        changes: [],
        summary: emptySummary,
        diagnostics: [{ severity: 'info', code: 'schema-canary-no-baseline', message: 'current fingerprint unavailable', phase: 'schema-canary' }],
      };
    }

    if (current.fingerprint === baseline.fingerprint) {
      return { status: 'clean', changes: [], summary: emptySummary, diagnostics: [] };
    }

    const changes = diffDimensions(baseline.dimensions, current.dimensions);
    const summary = { added: 0, removed: 0, modified: 0 };
    for (const c of changes) {
      const k = c.change;
      if (k === 'added' || k === 'removed' || k === 'modified') summary[k]++;
    }

    return {
      status: 'drifted',
      changes,
      summary,
      diagnostics: [{
        severity: 'warn',
        code: 'schema-drift-detected',
        message: `Claude Code schema surface changed since baseline: ${changes.length} change(s)`,
        phase: 'schema-canary',
        fix: 'run selftest --schema-canary to investigate; --update-baseline to accept if intentional',
      }],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err ?? '');
    return {
      status: 'no-baseline',
      changes: [],
      summary: emptySummary,
      diagnostics: [{ severity: 'error', code: 'schema-canary-compare-failed', message: msg, phase: 'schema-canary' }],
    };
  }
}

// ── dimension diffing ─────────────────────────────────────────────────────────

/**
 * Diff two dimension objects (baseline vs current). Returns sorted CanaryChange[].
 * @param {unknown} prev
 * @param {unknown} cur
 * @returns {CanaryChange[]}
 */
function diffDimensions(prev, cur) {
  const prevD = isPlainObj(prev) ? prev : {};
  const curD = isPlainObj(cur) ? cur : {};

  const allKeys = new Set();
  for (const k of Object.keys(prevD)) { if (!POISON.has(k)) allKeys.add(k); }
  for (const k of Object.keys(curD)) { if (!POISON.has(k)) allKeys.add(k); }

  /** @type {CanaryChange[]} */
  const changes = [];
  for (const dim of [...allKeys].sort()) {
    const inPrev = Object.prototype.hasOwnProperty.call(prevD, dim);
    const inCur = Object.prototype.hasOwnProperty.call(curD, dim);
    if (!inPrev && inCur) {
      changes.push({ change: 'added', dimension: dim, detail: `new dimension: ${dim}` });
    } else if (inPrev && !inCur) {
      changes.push({ change: 'removed', dimension: dim, detail: `dimension removed: ${dim}` });
    } else if (inPrev && inCur) {
      const pv = prevD[dim];
      const cv = curD[dim];
      const ps = safeSerialize(pv);
      const cs = safeSerialize(cv);
      if (ps !== cs) {
        changes.push({ change: 'modified', dimension: dim, detail: dimDetail(dim, pv, cv) });
      }
    }
  }
  return changes;
}

/**
 * Serialize a dimension value for comparison.
 * @param {unknown} v
 * @returns {string}
 */
function safeSerialize(v) {
  try { return stableStringify(v); } catch { return String(v); }
}

/**
 * Build a human-readable detail string for a modified dimension.
 * Arrays → show added/removed names. Numbers → show old→new. Null changes shown.
 * NAMES ONLY — values are never surfaced.
 * @param {string} dim
 * @param {unknown} prev
 * @param {unknown} cur
 * @returns {string}
 */
function dimDetail(dim, prev, cur) {
  if (Array.isArray(prev) && Array.isArray(cur)) {
    const ps = new Set(prev.filter((x) => typeof x === 'string'));
    const cs = new Set(cur.filter((x) => typeof x === 'string'));
    const added = [...cs].filter((x) => !ps.has(x)).sort();
    const removed = [...ps].filter((x) => !cs.has(x)).sort();
    const parts = [];
    if (added.length) parts.push(`+[${added.join(',')}]`);
    if (removed.length) parts.push(`-[${removed.join(',')}]`);
    return `${dim}: ${parts.join(' ') || 'changed'}`;
  }
  if (typeof prev === 'number' && typeof cur === 'number') {
    return `${dim}: ${prev} → ${cur}`;
  }
  return `${dim}: changed`;
}
