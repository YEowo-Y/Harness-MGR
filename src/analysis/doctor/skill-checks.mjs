/**
 * Doctor skill-fact checks — #29 skill-overrides-orphaned.
 *
 * The PURE judgment layer for the Claude skillOverrides facts gathered in
 * doctor-facts.mjs (input.skillOverrides — the merged visibility map — and
 * input.skillDirs — the directory-backed skill names the scan found):
 *   #29 flags each skillOverrides entry whose key does NOT match a directory-backed
 *       skill. That means the override is INEFFECTIVE — either the skill was
 *       removed/renamed, or it is a plugin skill (skillOverrides governs only
 *       directory-backed user/project skills, never plugin skills).
 *
 * CLAUDE-GUARDED at the GATHER boundary: skillOverridesForTarget returns {} for a
 * codex target, so this check reads an empty map and returns [] on a codex (or
 * no-override) run — it contributes nothing there. The check is pure (data in,
 * Diagnostic[] out), reads only DoctorInput (no I/O — the scan already enumerated
 * the skills), and never throws. One finding per offending key, deduped + sorted
 * by message for determinism.
 *
 * Zero npm dependencies. Node stdlib only.
 */

/**
 * @typedef {import('./index.mjs').DoctorInput} DoctorInput
 * @typedef {import('../../lib/diagnostic.mjs').Diagnostic} Diagnostic
 */

import { identityKey } from '../../lib/name-identity.mjs';

/** Reject prototype keys when iterating a user/config-authored map (pollution-safe). */
function isSafeKey(key) {
  return key !== '__proto__' && key !== 'constructor' && key !== 'prototype';
}

/**
 * #29 skill-overrides-orphaned — a skillOverrides[name] entry whose `name` is not a
 * directory-backed skill (input.skillDirs). Such an override has no effect: the skill
 * was removed/renamed, or it is a plugin skill (skillOverrides cannot affect plugins).
 * WARN, one per key, sorted. Empty/malformed skillOverrides (incl. codex → {}) → [].
 * @param {DoctorInput} input
 * @returns {Diagnostic[]}
 */
function checkSkillOverridesOrphaned(input) {
  const overrides = input && input.skillOverrides;
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) return [];
  // Compare override keys to directory-backed skill names by DERIVED identity
  // (NFC + case fold on a case-insensitive volume), so skillOverrides['myskill']
  // is NOT falsely flagged as orphaned when the on-disk dir is 'MySkill' on
  // Windows/macOS — while a Linux (case-sensitive) volume keeps the exact match.
  const ci = input.caseInsensitive === true;
  const dirs = new Set(
    (Array.isArray(input.skillDirs) ? input.skillDirs.filter((n) => typeof n === 'string') : [])
      .map((n) => identityKey(n, ci)),
  );
  /** @type {Diagnostic[]} */
  const out = [];
  const seen = new Set();
  for (const name of Object.keys(overrides)) {
    if (!isSafeKey(name)) continue;
    const id = identityKey(name, ci);
    if (seen.has(id) || dirs.has(id)) continue;
    seen.add(id);
    out.push({
      severity: 'warn',
      code: 'skill-overrides-orphaned',
      message: `skillOverrides has an entry for '${name}', but no directory-backed skill of that name exists — the override has no effect (the skill was removed/renamed, or it is a plugin skill, which skillOverrides cannot affect)`,
      phase: 'doctor',
      fix: `remove the '${name}' entry from settings.json skillOverrides, or use \`skill visibility ${name} on\` once the skill exists (for a plugin skill use /plugin instead)`,
    });
  }
  out.sort((a, b) => (a.message < b.message ? -1 : a.message > b.message ? 1 : 0));
  return out;
}

/**
 * The pure skill-fact checks, frozen in registry order. Spread into index.mjs CHECKS
 * after ...CODEX_CHECKS and BEFORE ...ACTIVE_CHECKS (passive checks stay grouped; active
 * checks remain last).
 * @type {ReadonlyArray<import('./index.mjs').DoctorCheck>}
 */
export const SKILL_CHECKS = Object.freeze([
  Object.freeze({ id: 29, code: 'skill-overrides-orphaned', probeLevel: 'passive', run: checkSkillOverridesOrphaned }),
]);
