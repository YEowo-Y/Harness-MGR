/**
 * Doctor active checks — #4 hook-node-syntax (P2.U7a).
 *
 * The PURE judgment layer for facts gathered by the active discovery probes.
 * These checks are dispatched ONLY when the caller opts in via `--active-probes`;
 * the index.mjs dispatcher enforces this invariant.
 *
 * No I/O, no clock; pure data in, Diagnostic[] out. Never throws.
 * Zero npm dependencies. Node stdlib only.
 *
 * Future active checks (#15 claude-cli-resolvable, #19 loader-probe) will be
 * added to ACTIVE_CHECKS in subsequent units (P2.U7b, P2.U7c).
 */

/**
 * @typedef {import('./index.mjs').DoctorInput} DoctorInput
 * @typedef {import('../../lib/diagnostic.mjs').Diagnostic} Diagnostic
 * @typedef {import('../../discovery/probe-hook-syntax.mjs').HookSyntaxFact} HookSyntaxFact
 */

/**
 * #4 hook-node-syntax — a HookSyntaxFact with status 'syntax-error' means
 * `node --check` parsed the script and found a syntax error → ERROR.
 *
 * 'ok' and 'indeterminate' yield nothing: 'indeterminate' means node could not
 * be run (e.g. path issue), which is not a confirmed defect and must NOT be
 * flagged to avoid false positives.
 *
 * Sorted by message for deterministic ordering.
 *
 * @param {DoctorInput} input
 * @returns {Diagnostic[]}
 */
function checkHookNodeSyntax(input) {
  const facts = Array.isArray(input.hookSyntax) ? input.hookSyntax : [];

  /** @type {Diagnostic[]} */
  const out = [];

  for (const f of facts) {
    if (!f || typeof f !== 'object' || f.status !== 'syntax-error') continue;

    const event = typeof f.event === 'string' && f.event.length > 0 ? f.event : '(unknown)';
    const path = typeof f.path === 'string' && f.path.length > 0 ? f.path : '(unknown)';
    const detail = typeof f.detail === 'string' && f.detail.length > 0 ? ` — ${f.detail}` : '';

    out.push({
      severity: 'error',
      code: 'hook-node-syntax',
      message: `hook for "${event}" has a Node.js syntax error: ${path}${detail}`,
      phase: 'doctor',
      path,
      fix: 'fix the syntax error in the hook script (run: node --check <file>)',
    });
  }

  out.sort((a, b) => (a.message < b.message ? -1 : a.message > b.message ? 1 : 0));

  return out;
}

/**
 * Active checks, frozen in registry order. Spread LAST into index.mjs CHECKS
 * (active checks group at the end of the registry).
 * @type {ReadonlyArray<import('./index.mjs').DoctorCheck>}
 */
export const ACTIVE_CHECKS = Object.freeze([
  Object.freeze({ id: 4, code: 'hook-node-syntax', probeLevel: 'active', run: checkHookNodeSyntax }),
]);
