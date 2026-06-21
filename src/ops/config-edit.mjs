/**
 * config-edit engine — setComponentEnabled (P6 config-edit unit).
 *
 * The analog of removeComponent (remove.mjs) for the in-place enable/disable of a
 * config-file component. Validates the (kind, name), locates the `enabled` boolean in
 * the live config file, builds a ONE-op 'config-edit' Plan, and either PREVIEWS it
 * (dry-run — the DEFAULT, writes NOTHING) or hands it to applyPlan (enableWrites —
 * auto-snapshot first so rollback can undo it, then the gated single-token splice).
 *
 * Scope: PLUGIN (flip an existing enabled token) + MCP (an mcp server has NO enabled key
 * → disable INSERTS `enabled = false` as the first body line, structurally before any
 * [..env] secret sub-table; enable on a key-absent server is a default-enabled no-op) +
 * SKILL (flip a `[[skills.config]]` element's enabled, selected by name OR by path —
 * 51% of live entries are path-keyed, so a bare name that matches >1 entry is refused as
 * ambiguous with a "use --path" hint; skills always carry an explicit enabled, so an
 * absent key is a refusal, never an insert). The mcp loader-honor is UNVERIFIED on this
 * machine, so a disable carries an honest caveat. An unsupported kind is a clean refusal,
 * never a wrong edit.
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
import { parseToml } from '../lib/toml-parser.mjs';
import { spanMask } from '../lib/toml-edit-mask.mjs';

/** @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic */

const PHASE = 'config-edit';

/** Component kinds supported for in-place enable/disable (plugin = flip; mcp = insert;
 *  skill = flip a `[[skills.config]]` element selected by name OR path). */
const SUPPORTED_KINDS = Object.freeze(['plugin', 'mcp', 'skill']);

/** Kinds whose disable may INSERT `enabled = false` when the key is absent. mcp servers
 *  have no enabled key (enabled-by-default), so disabling one ADDS the key; plugin/skill
 *  always carry an explicit enabled, so an absent key there is a refusal, not a guessed insert. */
const INSERT_KINDS = Object.freeze(['mcp']);

/** A plugin name is namespaced `name@marketplace`; accept its safe chars (NOT the
 *  remove NAME_RE, which forbids '@'). Rejects whitespace / quotes / brackets / path
 *  separators that would break the TOML header match or smell like traversal. */
const PLUGIN_NAME_RE = /^[A-Za-z0-9._@-]+$/;

/** An mcp server name is a bare config.toml table key (`[mcp_servers.<name>]`) — no '@',
 *  no quotes/brackets/whitespace/separators. Tighter than the plugin RE (least authority). */
const MCP_NAME_RE = /^[A-Za-z0-9._-]+$/;

/** A skill NAME is a leaf component name (real codex names are kebab `[a-z0-9-]`; allow the
 *  broader bare-key set for forward-compat). No '/' / '@' / quotes / whitespace. */
const SKILL_NAME_RE = /^[A-Za-z0-9._-]+$/;

/** A skill PATH selector value is only ever matched as a LITERAL string against the decoded
 *  TOML `path = "..."` value — never spliced into the file, never used as a filesystem path —
 *  so it is permissive: 1..1024 printable chars, rejecting only control characters. Real paths
 *  are absolute (`C:/Users/.../SKILL.md`) and legitimately carry ':' '/' '.' and spaces. */
const SKILL_PATH_RE = /^[^\x00-\x1f\x7f]{1,1024}$/;

/** Build the EnableSelector for a (kind, value). For skill, `field` picks name vs path. */
function selectorFor(kind, value, field) {
  if (kind === 'plugin') return { kind: 'plugin', name: value };
  if (kind === 'mcp') return { kind: 'mcp', name: value };
  if (kind === 'skill') return { kind: 'skill', match: { field: field === 'path' ? 'path' : 'name', value } };
  return null;
}

/** Kind+field-aware selector-value validation.
 *  @param {string} kind @param {'name'|'path'|null} field @param {unknown} value */
function validValue(kind, field, value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (kind === 'mcp') return MCP_NAME_RE.test(value);
  if (kind === 'plugin') return PLUGIN_NAME_RE.test(value);
  return field === 'path' ? SKILL_PATH_RE.test(value) : SKILL_NAME_RE.test(value); // skill
}

/** Escape a string so it can be matched as a LITERAL inside a RegExp. The selector value is
 *  already charset-validated, but real plugin names carry '.'/'-' (regex-significant). */
function reEscape(s) { return s.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&'); }

/** Heuristic: is `selector`'s component DEFINED as an inline table/array — a TOML shape the
 *  header-based locator can't flip, so `findEnableSpan` reports it `absent` even though it IS
 *  present? plugin/mcp → a `<table>.<name> = {` dotted inline-table line; skill → a
 *  `skills.config = [` inline array (individual entries are unreachable inside it). Scans
 *  physical lines, skipping comments and masked (multi-line-string / inline-table interior)
 *  regions so a `plugins.x = {` that is really string content never false-matches. Pure;
 *  never throws. @param {string} text @param {import('../lib/toml-edit-locate.mjs').EnableSelector} selector */
function definedInline(text, selector) {
  if (typeof text !== 'string' || !selector) return false;
  let pattern;
  if (selector.kind === 'plugin' || selector.kind === 'mcp') {
    const table = selector.kind === 'plugin' ? 'plugins' : 'mcp_servers';
    const n = reEscape(typeof selector.name === 'string' ? selector.name : '');
    pattern = new RegExp(`^\\s*${table}\\.(?:${n}|"${n}"|'${n}')\\s*=\\s*\\{`);
  } else if (selector.kind === 'skill') {
    pattern = /^\s*skills\.config\s*=\s*\[/;
  } else {
    return false;
  }
  let mask;
  try { mask = spanMask(text); } catch { mask = { skip: () => false, malformed: false }; }
  let i = 0;
  const len = text.length;
  while (i < len) {
    const nl = text.indexOf('\n', i);
    const end = nl === -1 ? len : nl;
    if (!mask.skip(i)) {
      const line = text.slice(i, end);
      if (line.replace(/^[ \t]+/, '')[0] !== '#' && pattern.test(line)) return true;
    }
    i = end + 1;
  }
  return false;
}

/** Build the shared "unsupported config shape" refusal message: a specific `reason` clause +
 *  the actionable hand-edit guidance + the dry-run-default reassurance (nothing was written).
 *  @param {{kind:string,name:string,field:'name'|'path'|null,target:string}} id @param {string} reason */
function unsupportedShapeMessage(id, reason) {
  const sel = `${id.kind} ${id.field === 'path' ? 'path ' : ''}'${id.name}'`;
  return `${sel}: ${reason}. This in-place editor only flips a bare \`enabled = true|false\` token in a \`[header]\` region — edit ${id.target} by hand to change it. (dry-run default: nothing was written.)`;
}

/** Classify a findEnableSpan result into a refusal `{code,message}` or null (clean → proceed).
 *  Covers ambiguity, the unsupported multi-line/unterminated shape, a generic locate error, an
 *  inline-defined component (present but unreachable → unsupported-shape, not the misleading
 *  not-found), and a genuinely-absent component. Pure; never throws.
 *  @param {object} span @param {string} text @param {import('../lib/toml-edit-locate.mjs').EnableSelector} selector
 *  @param {{kind:string,name:string,field:'name'|'path'|null,target:string}} id */
function classifySpan(span, text, selector, id) {
  if (span.error) {
    if (span.ambiguous) {
      const hint = id.kind === 'skill' && id.field === 'name'
        ? ` — more than one [[skills.config]] entry is named '${id.name}'; re-run with --path "<path>" to pick exactly one`
        : '';
      return { code: 'config-edit-ambiguous', message: `${id.kind} selector '${id.name}' is ambiguous in ${id.target}${hint}` };
    }
    if (span.error.code === 'unparseable-multiline') {
      return { code: 'config-edit-unsupported-shape', message: unsupportedShapeMessage(id,
        'config.toml has an unterminated or multi-line TOML construct (a """/\'\'\' string or an inline table) the editor cannot safely navigate') };
    }
    return { code: 'config-edit-locate-error', message: `cannot locate ${id.kind} '${id.name}' in ${id.target}: ${span.error.message}` };
  }
  if (span.absent) {
    if (definedInline(text, selector)) {
      return { code: 'config-edit-unsupported-shape', message: unsupportedShapeMessage(id,
        'it appears to be defined as an inline table/array, a shape the in-place editor cannot reach') };
    }
    return { code: 'config-edit-target-not-found', message: `${id.kind} ${id.field === 'path' ? 'path' : ''}'${id.name}' not found in ${id.target}` };
  }
  return null;
}

/** Classify a setEnabled preview into a refusal `{code,message}` or null (clean → proceed).
 *  Covers a non-boolean `enabled`, a generic edit error, and a flip/insert that would yield TOML
 *  apply's V1 reparse rejects — caught NOW so dry-run predicts --apply instead of letting it fail
 *  later with a cryptic verify-reparse-failed. Pure; never throws.
 *  @param {object} preview @param {{kind:string,name:string,field:'name'|'path'|null,target:string}} id */
function classifyPreview(preview, id) {
  if (preview.error) {
    if (preview.error.code === 'enabled-not-boolean') {
      return { code: 'config-edit-unsupported-shape', message: unsupportedShapeMessage(id,
        `its 'enabled' value is not a bare boolean (${preview.error.message})`) };
    }
    return { code: 'config-edit-locate-error', message: `cannot edit ${id.kind} '${id.name}': ${preview.error.message}` };
  }
  if (preview.changed === true && parseToml(preview.text).errors.length > 0) {
    return { code: 'config-edit-unsupported-shape', message: unsupportedShapeMessage(id,
      "editing it would produce TOML this tool's verifier rejects (the file uses a multi-line string or inline table)") };
  }
  return null;
}

/** Full-shape result builder (every field defaulted). `field` is the skill selector mode
 *  ('name'|'path') or null for plugin/mcp. */
function result(fields, bag) {
  const defaults = { ok: false, refused: false, dryRun: false, kind: null, name: null, field: null,
    desired: null, target: null, diff: null, alreadyInState: false, plan: null, apply: null };
  return { ...defaults, ...fields, diagnostics: bag.all() };
}

/**
 * Enable/disable a config-file component in place. NEVER throws.
 * @param {object} opts
 * @param {string} opts.kind                              'plugin' | 'mcp' | 'skill'
 * @param {string} opts.name                              the selector VALUE — plugin: name@marketplace; mcp: server name; skill: the name OR the path string (per selectorField)
 * @param {'name'|'path'} [opts.selectorField]            skill ONLY: select by 'name' (default) or by 'path' (51% of live entries are path-keyed); ignored for plugin/mcp
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

    // skill selects by name (default) OR path; null for plugin/mcp (which select by table key).
    const field = kind === 'skill' ? (o.selectorField === 'path' ? 'path' : 'name') : null;

    if (typeof targetClaudeDir !== 'string' || targetClaudeDir.length === 0) return refuse('config-edit-bad-args', 'targetClaudeDir must be a non-empty string');
    if (typeof desired !== 'boolean') return refuse('config-edit-bad-args', 'desired must be a boolean');
    if (!SUPPORTED_KINDS.includes(kind)) return refuse('config-edit-unsupported-kind', `enable/disable supports only ${SUPPORTED_KINDS.join('/')} (got '${kind}')`);
    if (!validValue(kind, field, name)) {
      const expect = kind === 'mcp' ? "a server name like 'context7'"
        : kind === 'plugin' ? "a name like 'superpowers@openai-curated'"
          : field === 'path' ? "a path like 'C:/Users/you/.codex/skills/foo/SKILL.md'"
            : "a skill name like 'adversarial-reviewer'";
      return refuse('config-edit-bad-name', `invalid ${kind} ${field === 'path' ? 'path' : 'name'} '${name}'; expected ${expect}`, { kind, name, field });
    }

    const selector = selectorFor(kind, name, field);
    const target = join(targetClaudeDir, configFile);

    let text;
    try { text = readFn(target); } catch { return refuse('config-edit-config-not-found', `cannot read ${target} (in-place config-edit needs the config file)`, { kind, name, field, target }); }
    if (typeof text !== 'string') return refuse('config-edit-config-not-found', `read of ${target} did not return text`, { kind, name, field, target });

    // Identity bundle shared by every post-locate refusal (keeps helpers ≤5 params).
    const id = { kind, name, field, target };
    const span = findEnableSpan(text, selector);
    const spanRefusal = classifySpan(span, text, selector, id);
    if (spanRefusal) return refuse(spanRefusal.code, spanRefusal.message, id);
    // An absent `enabled` key: insert is allowed ONLY for INSERT_KINDS (mcp); for other kinds it's a refusal.
    if (span.mode === 'insert' && !INSERT_KINDS.includes(kind)) return refuse('config-edit-no-enabled-key', `${kind} '${name}' has no 'enabled' key to flip (key-insert is not supported for ${kind})`, id);

    const preview = setEnabled(text, selector, desired);
    const previewRefusal = classifyPreview(preview, id);
    if (previewRefusal) return refuse(previewRefusal.code, previewRefusal.message, id);
    // alreadyInState covers an explicit same-value (noop-already) AND an mcp enable on a
    // default-enabled (key-absent) server (noop-default-enabled) — both are safe no-ops.
    const alreadyInState = !preview.changed && (preview.reason === 'noop-already' || preview.reason === 'noop-default-enabled');
    const diff = preview.changed && preview.before != null ? { line: preview.line, before: preview.before, after: preview.after } : null;

    // mcp disable INSERTS `enabled = false` (structurally before the server's secret regions).
    // Codex docs say the loader honors it, but no live disabled instance confirms it on this
    // machine — surface an honest caveat in BOTH dry-run and apply so the user verifies.
    if (kind === 'mcp' && desired === false && preview.reason === 'inserted') {
      bag.add({ severity: 'warn', code: 'config-edit-mcp-loader-unverified', phase: PHASE,
        message: `inserting 'enabled = false' for mcp server '${name}'. Codex docs say this disables it, but it is UNVERIFIED on this machine (no live disabled instance). After --apply, restart Codex and confirm '${name}' is gone; if it still loads, run rollback to undo. Re-enabling later leaves an explicit 'enabled = true' line, not the original key-absent form.` });
    }

    const label = `${desired ? 'enable' : 'disable'} ${kind}:${name}`;
    const plan = emptyPlan(label, { apply: enableWrites });
    addOp(plan, { kind: 'config-edit', target, selector, desired, summary: label });

    // A default-enabled (key-absent) mcp server asked to ENABLE: clarify there is no key to write.
    const defaultEnabled = preview.reason === 'noop-default-enabled';

    // DRY-RUN (default): preview only — write NOTHING.
    if (!enableWrites) {
      bag.add({ severity: 'info', code: 'config-edit-dry-run', phase: PHASE,
        message: defaultEnabled
          ? `mcp server '${name}' has no explicit 'enabled' key; Codex defaults to enabled, so it is already enabled. --apply would be a safe no-op (no key is written).`
          : alreadyInState
            ? `${kind} '${name}' is already ${desired ? 'enabled' : 'disabled'}; --apply would be a safe no-op`
            : `would set ${kind} '${name}' enabled=${desired} in ${target} (auto-snapshot first → rollback can undo); re-run with --apply. Restart Codex to take effect.` });
      return result({ ok: true, dryRun: true, kind, name, field, desired, target, diff, alreadyInState, plan }, bag);
    }

    // APPLY. An already-in-state request needs no snapshot/write.
    if (alreadyInState) {
      bag.add({ severity: 'info', code: 'config-edit-noop', phase: PHASE,
        message: defaultEnabled
          ? `mcp server '${name}' is already enabled (no explicit key; Codex defaults to enabled); nothing applied`
          : `${kind} '${name}' is already ${desired ? 'enabled' : 'disabled'}; nothing applied` });
      return result({ ok: true, dryRun: false, kind, name, field, desired, target, diff: null, alreadyInState: true, plan }, bag);
    }
    if (typeof assertWritable !== 'function') return refuse('config-edit-bad-args', 'assertWritable (the governed-write gate) must be injected to --apply', { kind, name, field, target, plan });
    const ar = await applyFn({ plan, targetClaudeDir, mgrStateDir, assertWritable, scope, reason: reason ?? plan.command, pid, enableWrites: true, now });
    for (const d of ar?.diagnostics ?? []) bag.add(d);
    if (ar?.ok === true) bag.add({ severity: 'info', code: 'config-edit-restart-needed', phase: PHASE, message: 'Restart Codex for the change to take effect.' });
    return result({ ok: ar?.ok === true, dryRun: false, kind, name, field, desired, target, diff, alreadyInState, plan, apply: ar ?? null }, bag);
  } catch (e) {
    bag.add({ severity: 'error', code: 'config-edit-unexpected-error', phase: PHASE, message: `unexpected error during config-edit: ${e instanceof Error ? e.message : String(e)}` });
    return result({ ok: false }, bag);
  }
}
