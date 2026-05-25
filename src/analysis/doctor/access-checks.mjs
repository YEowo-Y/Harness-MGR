/**
 * Doctor access checks — #17 windows-file-locks, #24 insecure-permissions.
 *
 * The PURE judgment layer for facts gathered by src/discovery/probe-access.mjs:
 *   #17 judges whether settings.json appears locked by another process
 *   #24 judges whether .mgr-state/ has a broad (non-owner-only) Windows ACL
 *
 * No I/O, no clock; pure data in, Diagnostic[] out. Never throws.
 * Zero npm dependencies. Node stdlib only.
 */

/**
 * @typedef {import('./index.mjs').DoctorInput} DoctorInput
 * @typedef {import('../../lib/diagnostic.mjs').Diagnostic} Diagnostic
 * @typedef {import('../../discovery/probe-access.mjs').AclFact} AclFact
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
 * #24 insecure-permissions — flag when .mgr-state/ has a broad Windows ACL.
 *
 * Judges the AclFact gathered by probe-access.mjs::gatherAclProbe. Only status
 * 'broad' produces a finding (WARN). All other statuses — owner-only, absent,
 * unsupported (non-Windows), indeterminate — yield no finding: absent is benign
 * (.mgr-state may not exist yet), unsupported means icacls is unavailable, and
 * indeterminate means we could not determine the ACL (fail-safe: no false positive).
 * No fact (null or non-object) → no finding.
 *
 * The fix message uses a literal icacls command so the user can copy-paste it.
 *
 * @param {DoctorInput} input
 * @returns {Diagnostic[]}
 */
function checkInsecurePermissions(input) {
  const fact = /** @type {AclFact|undefined} */ (input.acl);
  if (!fact || typeof fact !== 'object') return [];
  if (fact.status !== 'broad') return [];
  const principals = Array.isArray(fact.broadPrincipals) ? fact.broadPrincipals.join(', ') : '';
  const path = typeof fact.path === 'string' ? fact.path : undefined;
  return [{
    severity: 'warn',
    code: 'insecure-permissions',
    message: `.mgr-state grants access to: ${principals}`,
    phase: 'doctor',
    path,
    fix: 'restrict it to owner-only (run in Command Prompt): icacls .mgr-state /inheritance:r /grant:r "%USERNAME%:(OI)(CI)F"',
  }];
}

/**
 * The access checks, frozen in registry order. Imported by index.mjs and
 * spread into CHECKS after ...FS_CHECKS → registry becomes
 * [1,2,3,5,18,6,7,8,9,10,11,12,22,23,13,14,16,20,21,25,17,24].
 * @type {ReadonlyArray<import('./index.mjs').DoctorCheck>}
 */
export const ACCESS_CHECKS = Object.freeze([
  Object.freeze({ id: 17, code: 'windows-file-locks', probeLevel: 'passive', run: checkWindowsFileLocks }),
  Object.freeze({ id: 24, code: 'insecure-permissions', probeLevel: 'passive', run: checkInsecurePermissions }),
]);
