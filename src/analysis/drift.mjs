/**
 * Drift analysis (P2.U9) — PURE comparison of TrackedState snapshots.
 *
 * Compares a freshly-gathered TrackedState against the previously-persisted
 * lockfile to detect external mutation of the governed config surface.
 *
 * PURE: no fs, crypto, paths, or DiagnosticBag imports. All I/O lives in
 * src/discovery/probe-state.mjs (per [[feedback-pure-analysis-split]]).
 * Diagnostics are built as plain objects inline, exactly like the doctor checks.
 *
 * Never throws — every code path is guarded.
 *
 * @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic
 */

/**
 * @typedef {'no-baseline'|'clean'|'drifted'} DriftStatus
 */

/**
 * @typedef {Object} DriftChange
 * @property {string} path
 * @property {'added'|'removed'|'modified'} change
 */

/**
 * @typedef {Object} DriftResult
 * @property {DriftStatus} status
 * @property {DriftChange[]} changes
 * @property {{ added: number, removed: number, modified: number }} summary
 * @property {Diagnostic[]} diagnostics
 */

/**
 * Extract the files map from a state object, returning {} on any malformed input.
 * @param {unknown} state
 * @returns {Record<string, string>}
 */
function filesOf(state) {
  if (
    state &&
    typeof state === 'object' &&
    !Array.isArray(state) &&
    state.files &&
    typeof state.files === 'object' &&
    !Array.isArray(state.files)
  ) {
    return /** @type {Record<string, string>} */ (state.files);
  }
  return {};
}

/**
 * True for a non-null, non-array plain object.
 * @param {unknown} v
 * @returns {boolean}
 */
function isPlainObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Diff two files maps (prev → cur). Returns an array of DriftChange sorted by path.
 * Uses Object.prototype.hasOwnProperty.call to avoid prototype-poisoning reads.
 * Skips prototype-poisoning key names.
 *
 * @param {Record<string, string>} prevFiles
 * @param {Record<string, string>} curFiles
 * @returns {DriftChange[]}
 */
function diffFiles(prevFiles, curFiles) {
  const poison = new Set(['__proto__', 'constructor', 'prototype']);
  const allKeys = new Set();
  for (const k of Object.keys(prevFiles)) { if (!poison.has(k)) allKeys.add(k); }
  for (const k of Object.keys(curFiles)) { if (!poison.has(k)) allKeys.add(k); }

  const sorted = [...allKeys].sort();
  /** @type {DriftChange[]} */
  const changes = [];
  for (const key of sorted) {
    const inPrev = Object.prototype.hasOwnProperty.call(prevFiles, key);
    const inCur = Object.prototype.hasOwnProperty.call(curFiles, key);
    if (!inPrev && inCur) {
      changes.push({ path: key, change: 'added' });
    } else if (inPrev && !inCur) {
      changes.push({ path: key, change: 'removed' });
    } else if (inPrev && inCur && prevFiles[key] !== curFiles[key]) {
      changes.push({ path: key, change: 'modified' });
    }
    // identical: skip
  }
  return changes;
}

/**
 * Analyze drift between the current state and a previously-persisted lockfile.
 *
 * @param {{ current?: unknown, previous?: unknown }} [input]
 * @returns {DriftResult}
 */
export function analyzeDrift(input) {
  const { current, previous } = input ?? {};
  const emptySummary = { added: 0, removed: 0, modified: 0 };

  // No baseline: previous is absent or not a plain object.
  if (!isPlainObj(previous)) {
    return {
      status: 'no-baseline',
      changes: [],
      summary: emptySummary,
      diagnostics: [{ severity: 'info', code: 'drift-no-baseline', message: 'no drift baseline recorded yet; write a lockfile to establish one', phase: 'drift' }],
    };
  }

  // Foreign baseline: recorded for a different config dir.
  // previous is already known to be a plain object here (early-returned above).
  const prevDir = typeof previous.targetClaudeDir === 'string' ? previous.targetClaudeDir : '';
  const curDir = isPlainObj(current) && typeof current.targetClaudeDir === 'string' ? current.targetClaudeDir : '';
  if (prevDir.length > 0 && curDir.length > 0 && prevDir !== curDir) {
    return {
      status: 'no-baseline',
      changes: [],
      summary: emptySummary,
      diagnostics: [{ severity: 'info', code: 'drift-baseline-foreign', message: `drift baseline was recorded for a different config dir (${previous.targetClaudeDir}); ignoring it`, phase: 'drift' }],
    };
  }

  // Compare files.
  const changes = diffFiles(filesOf(previous), filesOf(current));
  const summary = { added: 0, removed: 0, modified: 0 };
  for (const c of changes) summary[c.change]++;

  if (changes.length === 0) {
    return { status: 'clean', changes: [], summary, diagnostics: [] };
  }

  return {
    status: 'drifted',
    changes,
    summary,
    diagnostics: [{
      severity: 'warn',
      code: 'drift-detected',
      message: `config drift detected: ${summary.modified} modified, ${summary.added} added, ${summary.removed} removed`,
      phase: 'drift',
      fix: 're-baseline with the drift command once the changes are intentional',
    }],
  };
}
