/**
 * Doctor filesystem checks — #13 claude-md-backup-bloat, #14 snapshot-retention,
 * #20 probe-residue, #21 apply-leftover-files, #25 config-rules-stale.
 *
 * The PURE judgment layer for facts gathered by src/discovery/probe-fs.mjs:
 *   #13 judges claudeMdBackups count against a threshold
 *   #14 judges snapshot mtime against a staleness threshold (needs input.now)
 *   #20 judges leftover loader-probe temp files (one warn each)
 *   #21 judges leftover atomic-write staging files (one warn each)
 *   #25 judges mtime of docs/effective-config-rules.md (needs input.now)
 *
 * No I/O, no clock; pure data in, Diagnostic[] out. Never throws.
 * Zero npm dependencies. Node stdlib only.
 */

/**
 * @typedef {import('./index.mjs').DoctorInput} DoctorInput
 * @typedef {import('../../lib/diagnostic.mjs').Diagnostic} Diagnostic
 */

import { numOr } from './util.mjs';

const MAX_CLAUDE_MD_BACKUPS = 3;
const STALE_AGE_MS = 90 * 24 * 60 * 60 * 1000; // 90 days
const DISK_BUDGET_BYTES = 5 * 1024 * 1024 * 1024; // 5 GiB

/**
 * Defensive accessor for input.fsFacts. Returns {} when absent or not an object.
 * @param {DoctorInput} input
 * @returns {object}
 */
function getFacts(input) {
  return input.fsFacts && typeof input.fsFacts === 'object' ? input.fsFacts : {};
}

/**
 * #13 claude-md-backup-bloat — flag when the number of CLAUDE.md.backup.* files
 * in configDir exceeds MAX_CLAUDE_MD_BACKUPS. ONE info finding total (not one per
 * file), so the user knows to prune without being flooded.
 * @param {DoctorInput} input
 * @returns {Diagnostic[]}
 */
function checkClaudeMdBackupBloat(input) {
  const facts = getFacts(input);
  const b = facts.claudeMdBackups;
  const count = numOr(b && b.count, 0);
  if (count <= MAX_CLAUDE_MD_BACKUPS) return [];
  return [{
    severity: 'info',
    code: 'claude-md-backup-bloat',
    message: `found ${count} CLAUDE.md backups (more than ${MAX_CLAUDE_MD_BACKUPS}) — consider pruning`,
    phase: 'doctor',
    fix: 'delete old CLAUDE.md.backup.* files, keep only the most recent you need',
  }];
}

/**
 * #14 snapshot-retention — flag each snapshot older than 90 days. Returns [] when
 * input.now is absent or <= 0 (purity: no clock call; no finding without a reference
 * time). ONE info per stale snapshot.
 * @param {DoctorInput} input
 * @returns {Diagnostic[]}
 */
function checkSnapshotRetention(input) {
  const now = numOr(input.now, 0);
  if (now <= 0) return [];
  const facts = getFacts(input);
  const snapshots = Array.isArray(facts.snapshots) ? facts.snapshots : [];
  /** @type {Diagnostic[]} */
  const out = [];
  for (const snap of snapshots) {
    if (!snap || typeof snap !== 'object') continue;
    const mtimeMs = numOr(snap.mtimeMs, 0);
    if (mtimeMs <= 0) continue;
    if (now - mtimeMs <= STALE_AGE_MS) continue;
    const path = typeof snap.path === 'string' ? snap.path : '';
    out.push({
      severity: 'info',
      code: 'snapshot-retention',
      message: `snapshot is older than 90 days: ${path}`,
      phase: 'doctor',
      path: path || undefined,
      fix: 'prune snapshots you no longer need for rollback',
    });
  }
  return out;
}

/**
 * #16 disk-budget — flag when .mgr-state/ exceeds 5 GiB. ONE warn total.
 * bytes === 0 when the dir is absent — that is benign, skip it.
 * @param {DoctorInput} input
 * @returns {Diagnostic[]}
 */
function checkDiskBudget(input) {
  const facts = getFacts(input);
  const du = facts.diskUsage;
  if (!du || typeof du !== 'object') return [];
  const bytes = numOr(du.bytes, 0);
  if (bytes <= DISK_BUDGET_BYTES) return [];
  return [{
    severity: 'warn',
    code: 'disk-budget',
    message: `state dir is ${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB — over the 5 GB budget`,
    phase: 'doctor',
    path: typeof du.path === 'string' ? du.path : undefined,
    fix: 'prune old snapshots to reclaim space',
  }];
}

/**
 * #20 probe-residue — one WARN per leftover __mgr-probe-* temp file. These are
 * created by the (not-yet-built) loader probe #19 and should be cleaned up
 * automatically; their presence means a probe crashed before it could clean up.
 * @param {DoctorInput} input
 * @returns {Diagnostic[]}
 */
function checkProbeResidue(input) {
  const facts = getFacts(input);
  const residue = Array.isArray(facts.probeResidue) ? facts.probeResidue : [];
  /** @type {Diagnostic[]} */
  const out = [];
  for (const path of residue) {
    if (typeof path !== 'string' || path.length === 0) continue;
    out.push({
      severity: 'warn',
      code: 'probe-residue',
      message: `leftover loader-probe file: ${path}`,
      phase: 'doctor',
      path,
      fix: 'safe to delete — left by an interrupted loader probe',
    });
  }
  return out;
}

/**
 * #21 apply-leftover-files — one WARN per leftover *.mgr-new / *.mgr-old staging
 * file. These are created by an atomic-write operation and should be cleaned up on
 * completion; their presence means a write was interrupted.
 * @param {DoctorInput} input
 * @returns {Diagnostic[]}
 */
function checkApplyLeftoverFiles(input) {
  const facts = getFacts(input);
  const leftovers = Array.isArray(facts.applyLeftovers) ? facts.applyLeftovers : [];
  /** @type {Diagnostic[]} */
  const out = [];
  for (const path of leftovers) {
    if (typeof path !== 'string' || path.length === 0) continue;
    out.push({
      severity: 'warn',
      code: 'apply-leftover-files',
      message: `leftover atomic-write file: ${path}`,
      phase: 'doctor',
      path,
      fix: 'a write was interrupted; verify the target file is intact, then delete the .mgr-new/.mgr-old leftover',
    });
  }
  return out;
}

/**
 * #25 config-rules-stale — flag when docs/effective-config-rules.md is older than
 * 90 days. Returns [] when input.now is absent or <= 0, or when configRulesDoc fact
 * is missing (rulesDocPath was not provided to probe-fs, or the file was not found).
 * ONE info finding.
 * @param {DoctorInput} input
 * @returns {Diagnostic[]}
 */
function checkConfigRulesStale(input) {
  const now = numOr(input.now, 0);
  if (now <= 0) return [];
  const facts = getFacts(input);
  const doc = facts.configRulesDoc;
  if (!doc || typeof doc !== 'object') return [];
  const mtimeMs = numOr(doc.mtimeMs, 0);
  if (mtimeMs <= 0) return [];
  if (now - mtimeMs <= STALE_AGE_MS) return [];
  const path = typeof doc.path === 'string' ? doc.path : '';
  return [{
    severity: 'info',
    code: 'config-rules-stale',
    message: "effective-config-rules.md is older than 90 days — verify it still matches Claude Code's loader behavior",
    phase: 'doctor',
    path: path || undefined,
    fix: 'review and refresh docs/effective-config-rules.md',
  }];
}

/**
 * The six pure filesystem checks, frozen in registry order. Imported by
 * index.mjs and spread into CHECKS after ...CONFIG_CHECKS → registry becomes
 * [1,2,3,5,18,6,7,8,9,10,11,12,22,23,13,14,16,20,21,25].
 * @type {ReadonlyArray<import('./index.mjs').DoctorCheck>}
 */
export const FS_CHECKS = Object.freeze([
  Object.freeze({ id: 13, code: 'claude-md-backup-bloat', probeLevel: 'passive', run: checkClaudeMdBackupBloat }),
  Object.freeze({ id: 14, code: 'snapshot-retention', probeLevel: 'passive', run: checkSnapshotRetention }),
  Object.freeze({ id: 16, code: 'disk-budget', probeLevel: 'passive', run: checkDiskBudget }),
  Object.freeze({ id: 20, code: 'probe-residue', probeLevel: 'passive', run: checkProbeResidue }),
  Object.freeze({ id: 21, code: 'apply-leftover-files', probeLevel: 'passive', run: checkApplyLeftoverFiles }),
  Object.freeze({ id: 25, code: 'config-rules-stale', probeLevel: 'passive', run: checkConfigRulesStale }),
]);
