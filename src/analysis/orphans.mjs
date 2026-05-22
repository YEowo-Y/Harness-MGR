/**
 * Orphan analysis (P1.U12).
 *
 * A thin presentation transform over the discovery layer's `detectOrphans`
 * (orphan-detector.mjs). Discovery produces RAW FACTS split into two arrays —
 * `hard` and `soft` — because the two categories are detected by different
 * walks. The CLI `orphans` command (a later unit) wants a SINGLE CLI-ready
 * view: one unified, already-ordered list plus summary counts. This module is
 * that transform.
 *
 * The layer separation mirrors how conflicts.mjs (analysis) consumes the
 * discovered `components`: discovery walks the filesystem and reports facts;
 * analysis reshapes those facts for a consumer WITHOUT re-walking anything.
 *
 * --- Deliberately NOT a judge ---
 * This module adds NO judgment and NO re-classification. Orphans are facts;
 * the info-severity `orphan-files` doctor check (P2.U6 #12) is the place that
 * decides whether a given orphan warrants user attention. We only flatten and
 * count.
 *
 * --- Pure module, by design ---
 * Consumes an OrphanResult object explicitly; depends only on the Diagnostic
 * typedef + DiagnosticBag. No filesystem, no async, never throws.
 *
 * Zero npm dependencies. Node stdlib only. Never throws.
 */

import { DiagnosticBag } from '../lib/diagnostic.mjs';

/**
 * @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic
 * @typedef {import('../discovery/orphan-detector.mjs').OrphanRecord} OrphanRecord
 * @typedef {import('../discovery/orphan-detector.mjs').OrphanResult} OrphanResult
 */

/**
 * Summary counts for a unified orphan view. `total` is always `hard + soft`.
 *
 * @typedef {Object} OrphanSummary
 * @property {number} hard
 * @property {number} soft
 * @property {number} total
 */

/**
 * The CLI-ready orphan view: a single ordered list (hard first, then soft),
 * the counts, and the authoritative diagnostic set.
 *
 * @typedef {Object} OrphanAnalysis
 * @property {OrphanRecord[]} orphans   hard records first, then soft; each array's order preserved
 * @property {OrphanSummary} summary
 * @property {Diagnostic[]} diagnostics
 */

/**
 * Flatten a discovered OrphanResult into a single CLI-ready view.
 *
 * @param {OrphanResult} orphanResult   the output of detectOrphans()
 * @returns {OrphanAnalysis}
 */
export function analyzeOrphans(orphanResult) {
  const bag = new DiagnosticBag();

  if (!orphanResult || typeof orphanResult !== 'object') {
    bag.add({ severity: 'error', code: 'orphans-bad-input', message: 'orphanResult must be an object', phase: 'orphans' });
    return { orphans: [], summary: emptySummary(), diagnostics: bag.all() };
  }

  // Tolerant coercion: a partial/malformed object must degrade to empties, never throw.
  const hard = Array.isArray(orphanResult.hard) ? orphanResult.hard : [];
  const soft = Array.isArray(orphanResult.soft) ? orphanResult.soft : [];
  const inputDiags = Array.isArray(orphanResult.diagnostics) ? orphanResult.diagnostics : [];

  // detectOrphans already sorts hard and soft; preserve each array's order, hard first.
  const orphans = [...hard, ...soft];
  const summary = { hard: hard.length, soft: soft.length, total: hard.length + soft.length };

  // Pass the discovery diagnostics through, normalized via the bag. We add NO new
  // diagnostics beyond the bad-input one above: the CLI treats THIS as the
  // authoritative orphan-analysis diagnostic set, so it must not also union the
  // discovery result's diagnostics separately (double-count risk — same caveat as
  // scan.mjs).
  for (const d of inputDiags) bag.add(d);

  return { orphans, summary, diagnostics: bag.all() };
}

/**
 * The zero-count summary returned for bad input.
 * @returns {OrphanSummary}
 */
function emptySummary() {
  return { hard: 0, soft: 0, total: 0 };
}
