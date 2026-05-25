/**
 * Doctor access checks — #17 windows-file-locks.
 *
 * The PURE judgment layer for facts gathered by src/discovery/probe-access.mjs:
 *   #17 judges whether settings.json appears locked by another process
 *
 * A #24 insecure-permissions check (Windows ACL via icacls) will be appended
 * to ACCESS_CHECKS in a future work unit — leave room at the end of the array.
 *
 * No I/O, no clock; pure data in, Diagnostic[] out. Never throws.
 * Zero npm dependencies. Node stdlib only.
 */

/**
 * @typedef {import('./index.mjs').DoctorInput} DoctorInput
 * @typedef {import('../../lib/diagnostic.mjs').Diagnostic} Diagnostic
 */

/**
 * #17 windows-file-locks — flag when settings.json appears exclusively locked.
 *
 * A read-open probe detects only EXCLUSIVE locks (another process holding an
 * exclusive write lock). Shared locks held by other readers will not surface —
 * this is the honest limitation of a read-only, dry-run probe. Status 'locked'
 * → WARN. All other statuses ('free', 'absent', 'indeterminate') → no finding.
 * No fact (null or non-object) → no finding.
 *
 * @param {DoctorInput} input
 * @returns {Diagnostic[]}
 */
function checkWindowsFileLocks(input) {
  const fact = input.lock;
  if (!fact || typeof fact !== 'object') return [];
  if (fact.status !== 'locked') return [];
  return [{
    severity: 'warn',
    code: 'windows-file-locks',
    message: `settings.json appears to be locked by another process: ${typeof fact.path === 'string' ? fact.path : 'settings.json'}`,
    phase: 'doctor',
    path: typeof fact.path === 'string' ? fact.path : undefined,
    fix: 'close the process holding an exclusive lock on settings.json (e.g. another Claude Code instance) before modifying settings',
  }];
}

/**
 * The access checks, frozen in registry order. Imported by index.mjs and
 * spread into CHECKS after ...FS_CHECKS → registry becomes
 * [1,2,3,5,18,6,7,8,9,10,11,12,22,23,13,14,16,20,21,25,17].
 * A #24 entry will be appended here in a future work unit.
 * @type {ReadonlyArray<import('./index.mjs').DoctorCheck>}
 */
export const ACCESS_CHECKS = Object.freeze([
  Object.freeze({ id: 17, code: 'windows-file-locks', probeLevel: 'passive', run: checkWindowsFileLocks }),
]);
