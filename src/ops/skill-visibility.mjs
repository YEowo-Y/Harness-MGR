/**
 * skill-visibility engine — setSkillVisibility (Claude per-skill visibility override).
 *
 * The string-map analog of setPluginEnabledClaude (plugin-toggle.mjs). It sets one member of
 * settings.json's `skillOverrides` map to a VISIBILITY state — a 4-state enum, NOT a boolean:
 *   on                  — fully visible (the default; the MVP writes it explicitly rather than
 *                         deleting the override — simplest + honest)
 *   name-only           — name shows, body hidden
 *   user-invocable-only — invocable via `/`, hidden from model auto-selection
 *   off                 — hidden from listing AND the `/` menu
 *
 * Flow (mirrors plugin-toggle): validate the skill name + the state enum, read settings.json,
 * compute a fail-closed verified edit via json-map-edit's applyVerifiedMapEdit (so the DRY-RUN
 * preview runs the SAME verify the apply path re-runs → dry-run predicts apply), build a ONE-op
 * 'json-map-set' Plan, and either PREVIEW it (dry-run, the DEFAULT — writes NOTHING) or hand it
 * to applyPlan (enableWrites — auto-snapshot first so rollback can undo it, then the gated write).
 *
 * `skillOverrides` is ABSENT from settings.json until the first override is set, so the COMMON
 * first case is map CREATION (json-map-edit's `created` reason) — unlike the plugin map, which
 * already exists. An already-in-state request is a safe no-op (no snapshot, no write).
 *
 * DOCUMENTED LIMITATION (loader-honored fact): "Plugin skills are not affected by skillOverrides"
 * — this command governs ONLY directory-backed user/project skills. We surface it with an advisory
 * WARN when `<name>` is NOT found as a user-scope directory-backed skill (a lightweight
 * `<configDir>/skills/<name>` probe — NOT a discovery-layer import, mirroring how plugin-toggle
 * reads settings.local.json directly). The WARN is non-blocking: the override is still written.
 *
 * M2-safe (node:fs/path + src/lib/** + sibling apply.mjs). NEVER throws — every failure is a
 * Diagnostic + a full-shape { ok:false } result. Injectable readFn + skillExistsFn + applyFn seams.
 * Zero npm deps.
 */

import { join } from 'node:path';
import { readFileSync, statSync } from 'node:fs';
import { DiagnosticBag } from '../lib/diagnostic.mjs';
import { emptyPlan, addOp } from '../lib/plan.mjs';
import { applyPlan } from './apply.mjs';
import { applyVerifiedMapEdit } from '../lib/json-map-edit.mjs';

/** @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic */

const PHASE = 'skill-visibility';

/** The top-level settings.json map this command governs. */
const MAP_KEY = 'skillOverrides';

/** A directory-backed skill name (mirrors config-edit's SKILL_NAME_RE): safe chars only,
 *  no whitespace / quotes / path separators. */
const SKILL_NAME_RE = /^[A-Za-z0-9._-]+$/;

/** The four visibility states the Claude loader honors for a skillOverrides entry. */
export const VISIBILITY_STATES = Object.freeze(['on', 'name-only', 'user-invocable-only', 'off']);

/** Map an applyVerifiedMapEdit error code to a user-facing refusal {code,message}. */
function refusalFor(errCode, name, target) {
  const sel = `skill '${name}'`;
  switch (errCode) {
    case 'map-not-object':
      return { code: 'skill-visibility-unsupported-shape', message: `${target}'s skillOverrides is not a JSON object — edit ${target} by hand. (dry-run default: nothing was written.)` };
    case 'not-string':
      return { code: 'skill-visibility-unsupported-shape', message: `${sel}'s existing skillOverrides value is not a string — edit ${target} by hand. (dry-run default: nothing was written.)` };
    case 'ambiguous-map':
    case 'ambiguous-key':
      return { code: 'skill-visibility-ambiguous', message: `${sel} is ambiguous in ${target} (a duplicate skillOverrides map or member key) — edit ${target} by hand.` };
    case 'unparseable':
      return { code: 'skill-visibility-unparseable', message: `${target} is not parseable as JSON around skillOverrides — fix the file, then retry.` };
    default:
      return { code: 'skill-visibility-verify-failed', message: `cannot set ${sel}: ${errCode}` };
  }
}

/** True when `<configDir>/skills/<name>` exists as a directory (a user-scope directory-backed
 *  skill). Never throws. A targeted probe — NOT a discovery import (the plugin-toggle precedent
 *  for reading a sibling file directly). @param {string} dir @param {string} name @param {Function} statFn */
function userSkillDirExists(dir, name, statFn) {
  try {
    const st = statFn(join(dir, 'skills', name));
    return !!st && typeof st.isDirectory === 'function' && st.isDirectory();
  } catch { return false; }
}

/** Full-shape result builder (every field defaulted) — shaped for the skill-visibility summarizer. */
function result(fields, bag) {
  const defaults = { ok: false, refused: false, dryRun: false, kind: 'skill', field: 'visibility',
    name: null, state: null, target: null, diff: null, alreadyInState: false, plan: null, apply: null };
  return { ...defaults, ...fields, diagnostics: bag.all() };
}

/**
 * Set a Claude skill's visibility override in settings.json's skillOverrides map. NEVER throws.
 * @param {object} opts
 * @param {string} opts.name                               directory-backed skill name
 * @param {string} opts.state                              one of VISIBILITY_STATES
 * @param {string} opts.targetClaudeDir                    absolute governed dir
 * @param {string} opts.mgrStateDir                        absolute .mgr-state dir
 * @param {string} [opts.configFile='settings.json']       the settings file basename
 * @param {(path:string, ctx:string)=>string} [opts.assertWritable]  gate; REQUIRED for --apply
 * @param {import('./snapshot-walk.mjs').SnapshotScope} [opts.scope]  snapshot scope (Claude default = undefined)
 * @param {boolean} [opts.enableWrites]                    true = apply; false/absent = dry-run preview
 * @param {string} [opts.reason]                           snapshot reason
 * @param {number} [opts.pid]                              lock pid forwarded to applyPlan
 * @param {() => Date} [opts.now]                          clock injection
 * @param {(p:string)=>string} [opts.readFn]              read seam (default utf8 readFileSync)
 * @param {(p:string)=>import('node:fs').Stats} [opts.skillExistsFn]  stat seam (default statSync)
 * @param {{applyFn?:Function}} [opts.seams]
 * @returns {Promise<object>}
 */
export async function setSkillVisibility(opts) {
  const bag = new DiagnosticBag();
  const refuse = (code, message, fields = {}) => {
    bag.add({ severity: 'error', code, message, phase: PHASE });
    return result({ ok: false, refused: true, ...fields }, bag);
  };
  try {
    const o = opts && typeof opts === 'object' ? opts : {};
    const { name, state, targetClaudeDir, mgrStateDir, assertWritable, reason, pid, now, scope } = o;
    const enableWrites = o.enableWrites === true;
    const configFile = typeof o.configFile === 'string' && o.configFile.length ? o.configFile : 'settings.json';
    const readFn = typeof o.readFn === 'function' ? o.readFn : ((p) => readFileSync(p, 'utf8'));
    const statFn = typeof o.skillExistsFn === 'function' ? o.skillExistsFn : ((p) => statSync(p));
    const seams = o.seams && typeof o.seams === 'object' ? o.seams : {};
    const applyFn = typeof seams.applyFn === 'function' ? seams.applyFn : applyPlan;

    if (typeof targetClaudeDir !== 'string' || targetClaudeDir.length === 0) return refuse('skill-visibility-bad-args', 'targetClaudeDir must be a non-empty string');
    if (typeof name !== 'string' || !SKILL_NAME_RE.test(name)) {
      return refuse('skill-visibility-bad-name', `invalid skill name '${name}'; expected a directory-backed skill name like 'deep-research'`, { name: typeof name === 'string' ? name : null, state: typeof state === 'string' ? state : null });
    }
    if (typeof state !== 'string' || !VISIBILITY_STATES.includes(state)) {
      return refuse('skill-visibility-bad-state', `invalid state '${state}'; expected one of: ${VISIBILITY_STATES.join(', ')}`, { name, state: typeof state === 'string' ? state : null });
    }

    const target = join(targetClaudeDir, configFile);
    let text;
    try { text = readFn(target); } catch { return refuse('skill-visibility-config-not-found', `cannot read ${target} (skill-visibility needs settings.json)`, { name, state, target }); }
    if (typeof text !== 'string') return refuse('skill-visibility-config-not-found', `read of ${target} did not return text`, { name, state, target });

    // Verified preview (the SAME verify the apply path re-runs → dry-run predicts apply).
    const v = applyVerifiedMapEdit(text, MAP_KEY, name, state);
    if (!v.ok) {
      const r = refusalFor(v.error ? v.error.code : 'unknown', name, target);
      return refuse(r.code, r.message, { name, state, target });
    }
    const alreadyInState = v.diff === null; // noop-already
    const diff = v.diff;

    // Loader-honored limitation: skillOverrides does NOT affect plugin skills. If `name` is not a
    // user-scope directory-backed skill, surface an advisory WARN (still write the override).
    if (!userSkillDirExists(targetClaudeDir, name, statFn)) {
      bag.add({ severity: 'warn', code: 'skill-visibility-not-directory-backed', phase: PHASE,
        message: `no directory-backed skill named '${name}' found under ${join(targetClaudeDir, 'skills')}; skillOverrides governs ONLY directory-backed user/project skills. If '${name}' is a plugin skill, this override will NOT change its visibility — use /plugin instead.` });
    }

    const label = `skill visibility ${name} ${state}`;
    const plan = emptyPlan(label, { apply: enableWrites });
    addOp(plan, { kind: 'json-map-set', target, selector: { mapKey: MAP_KEY, memberKey: name }, value: state, summary: label });

    // DRY-RUN (default): preview only — write NOTHING.
    if (!enableWrites) {
      bag.add({ severity: 'info', code: 'skill-visibility-dry-run', phase: PHASE,
        message: alreadyInState
          ? `skill '${name}' visibility is already '${state}'; --apply would be a safe no-op`
          : `would set skill '${name}' visibility='${state}' in ${target} (auto-snapshot first → rollback can undo); re-run with --apply. Restart Claude Code to take effect.` });
      return result({ ok: true, dryRun: true, name, state, target, diff, alreadyInState, plan }, bag);
    }

    // APPLY. An already-in-state request needs no snapshot/write.
    if (alreadyInState) {
      bag.add({ severity: 'info', code: 'skill-visibility-noop', phase: PHASE, message: `skill '${name}' visibility is already '${state}'; nothing applied` });
      return result({ ok: true, dryRun: false, name, state, target, diff: null, alreadyInState: true, plan }, bag);
    }
    if (typeof assertWritable !== 'function') return refuse('skill-visibility-bad-args', 'assertWritable (the governed-write gate) must be injected to --apply', { name, state, target, plan });
    const ar = await applyFn({ plan, targetClaudeDir, mgrStateDir, assertWritable, scope, reason: reason ?? plan.command, pid, enableWrites: true, now });
    for (const d of ar?.diagnostics ?? []) bag.add(d);
    if (ar?.ok === true) bag.add({ severity: 'info', code: 'skill-visibility-restart-needed', phase: PHASE, message: 'Restart Claude Code for the change to take effect.' });
    return result({ ok: ar?.ok === true, dryRun: false, name, state, target, diff, alreadyInState, plan, apply: ar ?? null }, bag);
  } catch (e) {
    bag.add({ severity: 'error', code: 'skill-visibility-unexpected-error', phase: PHASE, message: `unexpected error during skill-visibility: ${e instanceof Error ? e.message : String(e)}` });
    return result({ ok: false }, bag);
  }
}
