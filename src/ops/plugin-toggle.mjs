/**
 * plugin-toggle engine — setPluginEnabledClaude (Claude mainline plugin enable/disable).
 *
 * The Claude analog of setComponentEnabled (config-edit.mjs, which is codex/TOML-bound and
 * NOT reusable). It flips/inserts a plugin's boolean in settings.json's `enabledPlugins` map:
 * validate the plugin key, read settings.json, compute a fail-closed verified edit via
 * json-edit's applyVerifiedJsonEdit (so the DRY-RUN preview runs the SAME verify the apply
 * path re-runs → dry-run predicts apply), build a ONE-op 'json-edit' Plan, and either PREVIEW
 * it (dry-run, the DEFAULT — writes NOTHING) or hand it to applyPlan (enableWrites — auto-
 * snapshot first so rollback can undo it, then the gated write).
 *
 * Semantics (claude.mjs pluginEnableModel:'settings-map'): key present → flip; key absent +
 * enable → INSERT "key": true; key absent + disable → safe no-op (already not-enabled). An
 * already-in-state request is a safe no-op (no snapshot, no write). A missing enabledPlugins
 * map / a non-boolean value / a duplicate key is a clean refusal, never a wrong edit.
 *
 * Cross-layer honesty: settings.local.json (higher precedence) wins per key. If it also defines
 * the plugin, the write to settings.json may not change the effective state, so an honest WARN
 * is surfaced (the codex mcp loader-unverified caveat pattern). The MVP writes only settings.json.
 *
 * Deferred (documented): installed-plugin validation for an enable-insert. The enabledPlugins
 * map IS the authoritative enable signal, and doctor #7 (plugin-enabled-not-installed) already
 * flags a dangling key — a pre-check here would duplicate doctor AND pull the discovery layer
 * into ops/ (a layering violation). The dry-run diff shows the would-be insertion first.
 *
 * M2-safe (node:fs/path + src/lib/** + sibling apply.mjs). NEVER throws — every failure is a
 * Diagnostic + a full-shape { ok:false } result. Injectable readFn + applyFn seams. Zero npm deps.
 */

import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { DiagnosticBag } from '../lib/diagnostic.mjs';
import { emptyPlan, addOp } from '../lib/plan.mjs';
import { applyPlan } from './apply.mjs';
import { applyVerifiedJsonEdit } from '../lib/json-edit.mjs';
import { parseJsonc } from '../lib/jsonc-parser.mjs';

/** @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic */

const PHASE = 'plugin-toggle';

/** A Claude plugin key is namespaced `name@marketplace`. Accept the safe chars (mirrors the
 *  codex PLUGIN_NAME_RE); reject whitespace / quotes / brackets / path separators. */
const PLUGIN_NAME_RE = /^[A-Za-z0-9._@-]+$/;

/** Map an applyVerifiedJsonEdit error code to a user-facing refusal {code,message}. */
function refusalFor(errCode, key, target) {
  const sel = `plugin '${key}'`;
  switch (errCode) {
    case 'no-map':
      return { code: 'plugin-toggle-no-map', message: `${target} has no enabledPlugins object. Enable a plugin in Claude Code once (which creates the map), then retry; or add "enabledPlugins": {} by hand.` };
    case 'not-boolean':
      return { code: 'plugin-toggle-unsupported-shape', message: `${sel}'s enabledPlugins value is not a bare true/false — edit ${target} by hand. (dry-run default: nothing was written.)` };
    case 'ambiguous-map':
    case 'ambiguous-key':
      return { code: 'plugin-toggle-ambiguous', message: `${sel} is ambiguous in ${target} (a duplicate enabledPlugins map or member key) — edit ${target} by hand.` };
    case 'unparseable':
      return { code: 'plugin-toggle-unparseable', message: `${target} is not parseable as JSON around enabledPlugins — fix the file, then retry.` };
    default:
      return { code: 'plugin-toggle-verify-failed', message: `cannot toggle ${sel}: ${errCode}` };
  }
}

/** Read settings.local.json (if any) and report whether it ALSO defines `key` in enabledPlugins
 *  (higher precedence → would override a settings.json write). Never throws. */
function localOverrides(dir, localFile, key, readFn) {
  try {
    const text = readFn(join(dir, localFile));
    if (typeof text !== 'string') return false;
    const { value } = parseJsonc(text);
    const ep = value && typeof value === 'object' ? value.enabledPlugins : undefined;
    return ep && typeof ep === 'object' && typeof ep[key] === 'boolean';
  } catch { return false; }
}

/** Full-shape result builder (every field defaulted) — shape-compatible with config-edit's
 *  result so the shared CLI summarizer renders both engines. */
function result(fields, bag) {
  const defaults = { ok: false, refused: false, dryRun: false, kind: 'plugin', name: null, field: null,
    desired: null, target: null, diff: null, alreadyInState: false, plan: null, apply: null };
  return { ...defaults, ...fields, diagnostics: bag.all() };
}

/**
 * Enable/disable a Claude plugin in settings.json's enabledPlugins map. NEVER throws.
 * @param {object} opts
 * @param {string} opts.key                               plugin key `name@marketplace`
 * @param {boolean} opts.desired                          true = enable, false = disable
 * @param {string} opts.targetClaudeDir                   absolute governed dir
 * @param {string} opts.mgrStateDir                       absolute .mgr-state dir
 * @param {string} [opts.configFile='settings.json']      the settings file basename
 * @param {string} [opts.localConfigFile='settings.local.json']  higher-precedence layer (caveat only)
 * @param {(path:string, ctx:string)=>string} [opts.assertWritable]  gate; REQUIRED for --apply
 * @param {import('./snapshot-walk.mjs').SnapshotScope} [opts.scope]  snapshot scope (Claude default = undefined)
 * @param {boolean} [opts.enableWrites]                   true = apply; false/absent = dry-run preview
 * @param {string} [opts.reason]                          snapshot reason
 * @param {number} [opts.pid]                             lock pid forwarded to applyPlan
 * @param {() => Date} [opts.now]                         clock injection
 * @param {(p:string)=>string} [opts.readFn]             read seam (default utf8 readFileSync)
 * @param {{applyFn?:Function}} [opts.seams]
 * @returns {Promise<object>}
 */
export async function setPluginEnabledClaude(opts) {
  const bag = new DiagnosticBag();
  const refuse = (code, message, fields = {}) => {
    bag.add({ severity: 'error', code, message, phase: PHASE });
    return result({ ok: false, refused: true, ...fields }, bag);
  };
  try {
    const o = opts && typeof opts === 'object' ? opts : {};
    const { key, desired, targetClaudeDir, mgrStateDir, assertWritable, reason, pid, now, scope } = o;
    const enableWrites = o.enableWrites === true;
    const configFile = typeof o.configFile === 'string' && o.configFile.length ? o.configFile : 'settings.json';
    const localConfigFile = typeof o.localConfigFile === 'string' && o.localConfigFile.length ? o.localConfigFile : 'settings.local.json';
    const readFn = typeof o.readFn === 'function' ? o.readFn : ((p) => readFileSync(p, 'utf8'));
    const seams = o.seams && typeof o.seams === 'object' ? o.seams : {};
    const applyFn = typeof seams.applyFn === 'function' ? seams.applyFn : applyPlan;

    if (typeof targetClaudeDir !== 'string' || targetClaudeDir.length === 0) return refuse('plugin-toggle-bad-args', 'targetClaudeDir must be a non-empty string');
    if (typeof desired !== 'boolean') return refuse('plugin-toggle-bad-args', 'desired must be a boolean');
    if (typeof key !== 'string' || !PLUGIN_NAME_RE.test(key)) {
      return refuse('plugin-toggle-bad-name', `invalid plugin name '${key}'; expected a name like 'ecc@everything-claude-code'`, { name: typeof key === 'string' ? key : null, desired });
    }

    const target = join(targetClaudeDir, configFile);
    let text;
    try { text = readFn(target); } catch { return refuse('plugin-toggle-config-not-found', `cannot read ${target} (plugin-toggle needs settings.json)`, { name: key, desired, target }); }
    if (typeof text !== 'string') return refuse('plugin-toggle-config-not-found', `read of ${target} did not return text`, { name: key, desired, target });

    // Verified preview (the SAME verify the apply path re-runs → dry-run predicts apply).
    const v = applyVerifiedJsonEdit(text, key, desired);
    if (!v.ok) {
      const r = refusalFor(v.error ? v.error.code : 'unknown', key, target);
      return refuse(r.code, r.message, { name: key, desired, target });
    }
    const alreadyInState = v.diff === null; // noop-already or noop-absent-disable
    const diff = v.diff;

    // Cross-layer caveat: a higher-precedence settings.local.json entry overrides this write.
    if (localOverrides(targetClaudeDir, localConfigFile, key, readFn)) {
      bag.add({ severity: 'warn', code: 'plugin-toggle-overridden-by-local', phase: PHASE,
        message: `${localConfigFile} also sets plugin '${key}' and takes precedence over ${configFile}; this change is written to ${configFile} but the EFFECTIVE state may not change. Edit ${localConfigFile} to override.` });
    }

    const label = `${desired ? 'enable' : 'disable'} plugin:${key}`;
    const plan = emptyPlan(label, { apply: enableWrites });
    addOp(plan, { kind: 'json-edit', target, selector: { key }, desired, summary: label });

    // DRY-RUN (default): preview only — write NOTHING.
    if (!enableWrites) {
      bag.add({ severity: 'info', code: 'plugin-toggle-dry-run', phase: PHASE,
        message: alreadyInState
          ? `plugin '${key}' is already ${desired ? 'enabled' : 'disabled'}; --apply would be a safe no-op`
          : `would set plugin '${key}' enabled=${desired} in ${target} (auto-snapshot first → rollback can undo); re-run with --apply. Restart Claude Code to take effect.` });
      return result({ ok: true, dryRun: true, name: key, desired, target, diff, alreadyInState, plan }, bag);
    }

    // APPLY. An already-in-state request needs no snapshot/write.
    if (alreadyInState) {
      bag.add({ severity: 'info', code: 'plugin-toggle-noop', phase: PHASE, message: `plugin '${key}' is already ${desired ? 'enabled' : 'disabled'}; nothing applied` });
      return result({ ok: true, dryRun: false, name: key, desired, target, diff: null, alreadyInState: true, plan }, bag);
    }
    if (typeof assertWritable !== 'function') return refuse('plugin-toggle-bad-args', 'assertWritable (the governed-write gate) must be injected to --apply', { name: key, desired, target, plan });
    const ar = await applyFn({ plan, targetClaudeDir, mgrStateDir, assertWritable, scope, reason: reason ?? plan.command, pid, enableWrites: true, now });
    for (const d of ar?.diagnostics ?? []) bag.add(d);
    if (ar?.ok === true) bag.add({ severity: 'info', code: 'plugin-toggle-restart-needed', phase: PHASE, message: 'Restart Claude Code for the change to take effect.' });
    return result({ ok: ar?.ok === true, dryRun: false, name: key, desired, target, diff, alreadyInState, plan, apply: ar ?? null }, bag);
  } catch (e) {
    bag.add({ severity: 'error', code: 'plugin-toggle-unexpected-error', phase: PHASE, message: `unexpected error during plugin-toggle: ${e instanceof Error ? e.message : String(e)}` });
    return result({ ok: false }, bag);
  }
}
