/**
 * Doctor active checks — #4 hook-node-syntax (P2.U7a), #15 claude-cli-resolvable
 * (P2.U7b), #19 loader-probe (P2.U7c-2). U7 now complete.
 *
 * The PURE judgment layer for facts gathered by the active discovery probes.
 * These checks are dispatched ONLY when the caller opts in via `--active-probes`;
 * the index.mjs dispatcher enforces this invariant.
 *
 * No I/O, no clock; pure data in, Diagnostic[] out. Never throws.
 * Zero npm dependencies. Node stdlib only.
 */

import { loaderConfidence } from '../load-order.mjs';

/**
 * @typedef {import('./index.mjs').DoctorInput} DoctorInput
 * @typedef {import('../../lib/diagnostic.mjs').Diagnostic} Diagnostic
 * @typedef {import('../../discovery/probe-hook-syntax.mjs').HookSyntaxFact} HookSyntaxFact
 * @typedef {import('../../discovery/probe-cli.mjs').CliFact} CliFact
 * @typedef {import('../../discovery/probe-loader.mjs').LoaderProbeFact} LoaderProbeFact
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
 * #15 claude-cli-resolvable — judge the CliFact gathered by probe-cli.
 *
 * Only 'unresolved' and 'unresponsive' are findings:
 *   unresolved   → WARN: claude was not found on PATH at all (high-value signal)
 *   unresponsive → WARN: resolved to a native exe but `--version` failed
 *
 * 'ok', 'resolved', and 'indeterminate' yield nothing:
 *   'resolved' means claude IS present as a shim — that is not a defect.
 *   'indeterminate' means resolution itself failed — not a confirmed absence.
 * This avoids any false positive on the standard Windows npm-shim install.
 *
 * @param {DoctorInput} input
 * @returns {Diagnostic[]}
 */
function checkClaudeCliResolvable(input) {
  const fact = input.cli;
  if (!fact || typeof fact !== 'object') return [];

  if (fact.status === 'unresolved') {
    return [{
      severity: 'warn',
      code: 'claude-cli-resolvable',
      message: 'the claude CLI was not found on PATH',
      phase: 'doctor',
      fix: 'install the Claude Code CLI or add it to PATH (the doctor probes `claude --version`)',
    }];
  }

  if (fact.status === 'unresponsive') {
    const p = typeof fact.resolvedPath === 'string' && fact.resolvedPath.length > 0
      ? fact.resolvedPath : 'claude';
    return [{
      severity: 'warn',
      code: 'claude-cli-resolvable',
      message: `the claude CLI at ${p} did not respond to --version`,
      phase: 'doctor',
      path: p,
      fix: 'verify the Claude Code CLI runs (try: claude --version)',
    }];
  }

  return [];
}

/**
 * #19 loader-probe — judge the LoaderProbeFact gathered by probe-loader.
 *
 *   cleanedUp === false              → WARN: a probe file was left in agents/;
 *                                      the passive #20 probe-residue check also flags it
 *   wrote === true && observed false → WARN: wrote a probe agent but discovery
 *                                      missed it → component discovery may be misconfigured
 *   wrote === true && cleanedUp ok  → surface loader precedence confidence ONLY when
 *                                      NOT 'verified' (verified → silent, the healthy case).
 *                                      Confidence derived from ccVersion via loaderConfidence.
 *
 * @param {DoctorInput} input
 * @returns {Diagnostic[]}
 */
function checkLoaderProbe(input) {
  const fact = input.loader;
  if (!fact || typeof fact !== 'object') return [];
  /** @type {Diagnostic[]} */
  const out = [];
  const probeName = typeof fact.probeName === 'string' && fact.probeName.length > 0 ? fact.probeName : '__mgr-probe-*';
  if (fact.cleanedUp === false) {
    out.push({ severity: 'warn', code: 'loader-probe', message: `loader probe left a residue file in agents/: ${probeName}.md`, phase: 'doctor', fix: 'remove the leftover __mgr-probe-*.md file (the passive probe-residue check also reports it)' });
  }
  if (fact.wrote === true && fact.observed === false) {
    out.push({ severity: 'warn', code: 'loader-probe', message: 'loader probe wrote a probe agent but discovery did not detect it; component discovery may be misconfigured', phase: 'doctor', fix: 'verify the agents/ path is being scanned correctly' });
  }
  if (fact.wrote === true && fact.cleanedUp !== false) {
    const ver = typeof fact.ccVersion === 'string' && fact.ccVersion.length > 0 ? fact.ccVersion : null;
    const { confidence } = loaderConfidence(ver ?? undefined);
    if (confidence !== 'verified') {
      out.push({ severity: 'info', code: 'loader-probe', message: `loader precedence is best-effort (${confidence}); claude version ${ver ?? 'unknown'} not confirmed in the verified 2.1.x line`, phase: 'doctor', fix: '(informational) precedence may differ outside Claude Code 2.1.x' });
    }
  }
  return out;
}

/**
 * Active checks, frozen in registry order. Spread LAST into index.mjs CHECKS
 * (active checks group at the end of the registry).
 * @type {ReadonlyArray<import('./index.mjs').DoctorCheck>}
 */
export const ACTIVE_CHECKS = Object.freeze([
  Object.freeze({ id: 4, code: 'hook-node-syntax', probeLevel: 'active', run: checkHookNodeSyntax }),
  Object.freeze({ id: 15, code: 'claude-cli-resolvable', probeLevel: 'active', run: checkClaudeCliResolvable }),
  Object.freeze({ id: 19, code: 'loader-probe', probeLevel: 'active', run: checkLoaderProbe }),
]);
