/**
 * Doctor config-fact checks — #12 orphan-files, #22 claude-config-schema-version,
 * #23 permissions-overbroad.
 *
 * The PURE judgment layer for facts already gathered by discovery/analysis:
 *   #12 judges OrphanRecord[] facts from discovery/orphan-detector.mjs
 *       (flattened by analysis/orphans.mjs).
 *   #22 escalates the plugin-schema-version-unknown discovery fact
 *       (discovery/plugins.mjs) into a doctor finding — mirrors how #6
 *       settings-json-valid escalates settings-discovery facts.
 *   #23 judges the merged effective.permissions.allow array
 *       (analysis/settings-merge.mjs) for overbroad wildcard entries.
 *
 * No I/O, no clock; pure data in, Diagnostic[] out. Never throws.
 * Zero npm dependencies. Node stdlib only.
 */

/**
 * @typedef {import('./index.mjs').DoctorInput} DoctorInput
 * @typedef {import('../../lib/diagnostic.mjs').Diagnostic} Diagnostic
 * @typedef {import('../../discovery/orphan-detector.mjs').OrphanRecord} OrphanRecord
 */

import { strOr } from './util.mjs';
import { findOverbroadAllow } from '../../analysis/permissions.mjs';

/**
 * #12 orphan-files — surface each discovered orphan as an INFO finding. Orphans
 * are facts (an unexpected top-level entry, or a stray file inside a component
 * dir); the doctor restates them as info so the user can decide. Sorted by message.
 * @param {DoctorInput} input
 * @returns {Diagnostic[]}
 */
function checkOrphanFiles(input) {
  const orphans = Array.isArray(input.orphans) ? input.orphans : [];
  /** @type {Diagnostic[]} */
  const out = [];
  for (const o of orphans) {
    if (!o || typeof o !== 'object') continue;
    if (typeof o.path !== 'string' || o.path.length === 0) continue;
    const category = o.category === 'hard' || o.category === 'soft' ? o.category : 'unknown';
    const reason = strOr(o.reason, 'unexpected entry');
    out.push({
      severity: 'info',
      code: 'orphan-files',
      message: `${category} orphan: ${o.path} — ${reason}`,
      phase: 'doctor',
      path: o.path,
      fix: 'remove it if unintended, or move it under a recognized location (a soft orphan inside skills/agents/commands is usually misplaced)',
    });
  }
  out.sort((a, b) => (a.message < b.message ? -1 : a.message > b.message ? 1 : 0));
  return out;
}

/**
 * #22 claude-config-schema-version — escalate the plugin-schema-version-unknown
 * discovery fact (emitted by discovery/plugins.mjs when installed_plugins.json
 * carries a version this build does not recognize) into a doctor WARN under the
 * canonical check code. Mirrors #6: the discovery layer reports the raw fact; the
 * doctor restates it as a health finding. Filters by code, so feeding the whole
 * aggregated scan diagnostic set is safe.
 * @param {DoctorInput} input
 * @returns {Diagnostic[]}
 */
function checkClaudeConfigSchemaVersion(input) {
  const facts = Array.isArray(input.pluginDiagnostics) ? input.pluginDiagnostics : [];
  /** @type {Diagnostic[]} */
  const out = [];
  // The filter code below MUST stay in sync with the code discovery/plugins.mjs
  // emits for an unrecognized installed_plugins.json schema version. If that code
  // is ever renamed, update it here too (the test pins the exact string).
  for (const f of facts) {
    if (!f || typeof f !== 'object' || f.code !== 'plugin-schema-version-unknown') continue;
    /** @type {Diagnostic} */
    const d = {
      severity: 'warn',
      code: 'claude-config-schema-version',
      message: strOr(f.message, 'installed_plugins.json has an unrecognized schema version'),
      phase: 'doctor',
      fix: 'upgrade harness-mgr if Claude Code changed the config schema; the read was best-effort and may be partial',
    };
    if (typeof f.path === 'string') d.path = f.path;
    out.push(d);
  }
  return out;
}

/**
 * #23 permissions-overbroad — flag wildcard entries in the merged
 * permissions.allow list (e.g. "mcp__*", "Bash(*)"). An overbroad ALLOW grants
 * more than likely intended, so it is a WARN. Only `allow` is judged: a broad
 * `deny` is safe and a broad `ask` only prompts. One finding per offending entry
 * (deduped), sorted by message.
 * @param {DoctorInput} input
 * @returns {Diagnostic[]}
 */
function checkPermissionsOverbroad(input) {
  const perms = input.permissions && typeof input.permissions === 'object' ? input.permissions : {};
  /** @type {Diagnostic[]} */
  const out = findOverbroadAllow(perms.allow).map((entry) => ({
    severity: 'warn',
    code: 'permissions-overbroad',
    message: `permissions.allow contains a wildcard rule: "${entry}"`,
    phase: 'doctor',
    fix: `replace "${entry}" with specific rules, or move it to permissions.ask so it prompts instead of auto-allowing`,
  }));
  out.sort((a, b) => (a.message < b.message ? -1 : a.message > b.message ? 1 : 0));
  return out;
}

/**
 * The three pure config-fact checks, frozen in registry order. Imported by
 * index.mjs and spread into CHECKS after #11 → registry becomes
 * [1,2,3,5,6,7,8,9,10,11,12,22,23].
 * @type {ReadonlyArray<import('./index.mjs').DoctorCheck>}
 */
export const CONFIG_CHECKS = Object.freeze([
  Object.freeze({ id: 12, code: 'orphan-files', probeLevel: 'passive', run: checkOrphanFiles }),
  Object.freeze({ id: 22, code: 'claude-config-schema-version', probeLevel: 'passive', run: checkClaudeConfigSchemaVersion }),
  Object.freeze({ id: 23, code: 'permissions-overbroad', probeLevel: 'passive', run: checkPermissionsOverbroad }),
]);
