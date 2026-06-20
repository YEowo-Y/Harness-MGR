/**
 * config-edit engine — setComponentEnabled (P6 config-edit unit).
 *
 * The analog of removeComponent (remove.mjs) for the in-place enable/disable of a
 * config-file component. Validates the (kind, name), locates the `enabled` boolean in
 * the live config file, builds a ONE-op 'config-edit' Plan, and either PREVIEWS it
 * (dry-run — the DEFAULT, writes NOTHING) or hands it to applyPlan (enableWrites —
 * auto-snapshot first so rollback can undo it, then the gated single-token splice).
 *
 * MVP scope: PLUGIN only. mcp (insert-not-flip + loader-honor unverified) and skill
 * (name/path selector duality — 51% of live entries are path-keyed) are their own
 * later units; an unsupported kind is a clean refusal, never a wrong edit.
 *
 * An already-in-the-desired-state request is a safe no-op: dry-run says so, and
 * --apply returns ok WITHOUT taking a snapshot or writing.
 *
 * M2-safe (node:fs/path + src/lib/** + sibling apply.mjs). NEVER throws — every
 * failure is a Diagnostic + a full-shape { ok:false } result. Injectable readFn +
 * applyFn seams for hermetic tests. Zero npm deps.
 */

import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { DiagnosticBag } from '../lib/diagnostic.mjs';
import { emptyPlan, addOp } from '../lib/plan.mjs';
import { applyPlan } from './apply.mjs';
import { findEnableSpan } from '../lib/toml-edit-locate.mjs';
import { setEnabled } from '../lib/toml-edit.mjs';

/** @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic */

const PHASE = 'config-edit';

/** Component kinds supported for in-place enable/disable. MVP = plugin only. */
const SUPPORTED_KINDS = Object.freeze(['plugin']);

/** A plugin name is namespaced `name@marketplace`; accept its safe chars (NOT the
 *  remove NAME_RE, which forbids '@'). Rejects whitespace / quotes / brackets / path
 *  separators that would break the TOML header match or smell like traversal. */
const PLUGIN_NAME_RE = /^[A-Za-z0-9._@-]+$/;

/** Build the EnableSelector for a (kind, name). MVP: plugin. */
function selectorFor(kind, name) {
  return kind === 'plugin' ? { kind: 'plugin', name } : null;
}

/** Full-shape result builder (every field defaulted). */
function result(fields, bag) {
  const defaults = { ok: false, refused: false, dryRun: false, kind: null, name: null,
    desired: null, target: null, diff: null, alreadyInState: false, plan: null, apply: null };
  return { ...defaults, ...fields, diagnostics: bag.all() };
}

/**
 * Enable/disable a config-file component in place. NEVER throws.
 * @param {object} opts
 * @param {string} opts.kind                              'plugin' (MVP)
 * @param {string} opts.name                              the component name (plugin: name@marketplace)
 * @param {boolean} opts.desired                          true = enable, false = disable
 * @param {string} opts.targetClaudeDir                   absolute governed dir
 * @param {string} opts.mgrStateDir                       absolute .mgr-state dir
 * @param {string} [opts.configFile='config.toml']        the config file basename (descriptor configEditFiles[0])
 * @param {(path:string, ctx:string)=>string} [opts.assertWritable]  gate; REQUIRED for --apply
 * @param {import('./snapshot-walk.mjs').SnapshotScope} [opts.scope]  per-target snapshot scope
 * @param {boolean} [opts.enableWrites]                   true = apply; false/absent = dry-run preview
 * @param {string} [opts.reason]                          snapshot reason
 * @param {number} [opts.pid]                             lock pid forwarded to applyPlan
 * @param {() => Date} [opts.now]                         clock injection
 * @param {(p:string)=>string} [opts.readFn]             read seam (default utf8 readFileSync)
 * @param {{applyFn?:Function}} [opts.seams]
 * @returns {Promise<object>}
 */
export async function setComponentEnabled(opts) {
  const bag = new DiagnosticBag();
  const refuse = (code, message, fields = {}) => {
    bag.add({ severity: 'error', code, message, phase: PHASE });
    return result({ ok: false, refused: true, ...fields }, bag);
  };
  try {
    const o = opts && typeof opts === 'object' ? opts : {};
    const { kind, name, desired, targetClaudeDir, mgrStateDir, assertWritable, reason, pid, now, scope } = o;
    const enableWrites = o.enableWrites === true;
    const configFile = typeof o.configFile === 'string' && o.configFile.length ? o.configFile : 'config.toml';
    const readFn = typeof o.readFn === 'function' ? o.readFn : ((p) => readFileSync(p, 'utf8'));
    const seams = o.seams && typeof o.seams === 'object' ? o.seams : {};
    const applyFn = typeof seams.applyFn === 'function' ? seams.applyFn : applyPlan;

    if (typeof targetClaudeDir !== 'string' || targetClaudeDir.length === 0) return refuse('config-edit-bad-args', 'targetClaudeDir must be a non-empty string');
    if (typeof desired !== 'boolean') return refuse('config-edit-bad-args', 'desired must be a boolean');
    if (!SUPPORTED_KINDS.includes(kind)) return refuse('config-edit-unsupported-kind', `enable/disable supports only ${SUPPORTED_KINDS.join('/')} (got '${kind}'); mcp and skill are not yet supported`);
    if (typeof name !== 'string' || !PLUGIN_NAME_RE.test(name)) return refuse('config-edit-bad-name', `invalid ${kind} name '${name}'; expected a name like 'superpowers@openai-curated'`);

    const selector = selectorFor(kind, name);
    const target = join(targetClaudeDir, configFile);

    let text;
    try { text = readFn(target); } catch { return refuse('config-edit-config-not-found', `cannot read ${target} (in-place config-edit needs the config file)`, { kind, name, target }); }
    if (typeof text !== 'string') return refuse('config-edit-config-not-found', `read of ${target} did not return text`, { kind, name, target });

    const span = findEnableSpan(text, selector);
    if (span.error) return refuse(span.ambiguous ? 'config-edit-ambiguous' : 'config-edit-locate-error', `cannot locate ${kind} '${name}' in ${target}: ${span.error.message}`, { kind, name, target });
    if (span.absent) return refuse('config-edit-target-not-found', `${kind} '${name}' not found in ${target}`, { kind, name, target });
    if (span.mode === 'insert') return refuse('config-edit-no-enabled-key', `${kind} '${name}' has no 'enabled' key to flip (key-insert is not supported for this kind yet)`, { kind, name, target });

    const preview = setEnabled(text, selector, desired);
    if (preview.error) return refuse('config-edit-locate-error', `cannot edit ${kind} '${name}': ${preview.error.message}`, { kind, name, target });
    const alreadyInState = !preview.changed && preview.reason === 'noop-already';
    const diff = preview.changed && preview.before != null ? { line: preview.line, before: preview.before, after: preview.after } : null;

    const label = `${desired ? 'enable' : 'disable'} ${kind}:${name}`;
    const plan = emptyPlan(label, { apply: enableWrites });
    addOp(plan, { kind: 'config-edit', target, selector, desired, summary: label });

    // DRY-RUN (default): preview only — write NOTHING.
    if (!enableWrites) {
      bag.add({ severity: 'info', code: 'config-edit-dry-run', phase: PHASE,
        message: alreadyInState
          ? `${kind} '${name}' is already ${desired ? 'enabled' : 'disabled'}; --apply would be a safe no-op`
          : `would set ${kind} '${name}' enabled=${desired} in ${target} (auto-snapshot first → rollback can undo); re-run with --apply. Restart Codex to take effect.` });
      return result({ ok: true, dryRun: true, kind, name, desired, target, diff, alreadyInState, plan }, bag);
    }

    // APPLY. An already-in-state request needs no snapshot/write.
    if (alreadyInState) {
      bag.add({ severity: 'info', code: 'config-edit-noop', phase: PHASE, message: `${kind} '${name}' is already ${desired ? 'enabled' : 'disabled'}; nothing applied` });
      return result({ ok: true, dryRun: false, kind, name, desired, target, diff: null, alreadyInState: true, plan }, bag);
    }
    if (typeof assertWritable !== 'function') return refuse('config-edit-bad-args', 'assertWritable (the governed-write gate) must be injected to --apply', { kind, name, target, plan });
    const ar = await applyFn({ plan, targetClaudeDir, mgrStateDir, assertWritable, scope, reason: reason ?? plan.command, pid, enableWrites: true, now });
    for (const d of ar?.diagnostics ?? []) bag.add(d);
    if (ar?.ok === true) bag.add({ severity: 'info', code: 'config-edit-restart-needed', phase: PHASE, message: 'Restart Codex for the change to take effect.' });
    return result({ ok: ar?.ok === true, dryRun: false, kind, name, desired, target, diff, alreadyInState, plan, apply: ar ?? null }, bag);
  } catch (e) {
    bag.add({ severity: 'error', code: 'config-edit-unexpected-error', phase: PHASE, message: `unexpected error during config-edit: ${e instanceof Error ? e.message : String(e)}` });
    return result({ ok: false }, bag);
  }
}
