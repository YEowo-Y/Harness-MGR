/**
 * Prune-config remove engine (P6 prune-config wave · U3) — `remove skill:<name>
 * --target codex --prune-config [--apply]`.
 *
 * The codex-specific sibling of removeComponent (remove.mjs): it deletes ONE codex
 * skill directory AND prunes every now-orphaned `[[skills.config]]` entry that
 * referenced it (by `name` OR by `path` pointing inside the skill's dir), in ONE
 * plan → ONE auto-snapshot, so a single `rollback` undoes BOTH the dir delete and the
 * config edits (design docs/phase-6-codex-prune-config-design.md §5/§6).
 *
 *   pruneConfigRemove(opts)
 *      ├─ kind must be 'skill' (only skills have config entries)  → prune-config-kind-unsupported
 *      ├─ validateSpec (shared with remove.mjs) resolves + checks the skill dir
 *      ├─ read config.toml, resolveOrphanConfigOps → the N config-block-delete ops
 *      ├─ build ONE plan = [delete-dir skills/<name>, ...N config-block-delete]
 *      ├─ enableWrites !== true (DEFAULT): PREVIEW only — writes NOTHING
 *      └─ enableWrites === true: applyPlan (snapshot → dir delete + block deletes)
 *
 * resolveOrphanConfigOps is the PURE judgment (no I/O): it parses the config text to
 * ENUMERATE orphan blocks (read each element's name/path) but validates each one's
 * DELETABILITY + uniqueness via the SAME findBlockSpan the real delete uses — so a
 * dry-run preview exactly predicts --apply (it never promises a prune apply would
 * no-op or refuse). A non-unique selector, an inline-array shape, or an unparseable
 * file is refused (never a half-prune); the skill dir is then NOT deleted either
 * (atomic: both or neither).
 *
 * Multi-block byte safety: apply runs each config-block-delete by re-reading config.toml
 * and re-locating its block by SELECTOR (value-keyed, not byte-offset), so the deletes
 * are ORDER-INDEPENDENT — there is no stale-offset class, and emitting ops in element
 * order is safe.
 *
 * Reversibility is FREE: ONE applyPlan with the codex snapshot scope captures BOTH
 * `skills/` (walkDirs) and `config.toml` (topFiles), so checkOpTargetsInManifest passes
 * for both targets and one rollback restores both. The codex write surface authorizes
 * the skill delete-dir AND the 'config-edit' context under ONE assertWritable.
 *
 * M2-SAFETY: imports ONLY node:fs/path + src/lib/** + sibling src/ops/{apply,remove}.mjs.
 * NEVER src/paths.mjs or src/lib/reexport.mjs. assertWritable is injected, never imported.
 * NEVER THROWS — the whole body is wrapped; any unexpected error becomes a Diagnostic +
 * a full-shape { ok:false } result. Injectable readConfigFn + applyFn seams for hermetic
 * tests. Zero npm dependencies.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { emptyPlan, addOp } from '../lib/plan.mjs';
import { DiagnosticBag } from '../lib/diagnostic.mjs';
import { parseToml } from '../lib/toml-parser.mjs';
import { findBlockSpan } from '../lib/toml-edit-locate.mjs';
import { applyPlan } from './apply.mjs';
import { validateSpec, deriveKindSpec, KIND_SPEC } from './remove.mjs';

/** @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic */
/** @typedef {import('../lib/plan.mjs').Plan} Plan */
/** @typedef {import('./apply.mjs').ApplyResult} ApplyResult */
/** @typedef {import('../lib/toml-edit-locate.mjs').EnableSelector} EnableSelector */

const PHASE = 'prune-config';

/** Normalize path separators to '/' (string-only; never fs-resolved — same stance as the
 *  skill config-edit selector). @param {string} p */
function normSep(p) { return p.replace(/\\/g, '/'); }

/**
 * True when `rawPath` (a `[[skills.config]]` `path` value) points INSIDE the absolute skill
 * directory being removed — i.e. its separator-normalized form starts with the normalized
 * skill dir + '/'. Anchored to the ABSOLUTE home dir (not a bare `skills/<name>/` substring)
 * so a coexisting user-scope `~/.agents/skills/<name>/SKILL.md` (a DIFFERENT skill that
 * shares the name) is never a false-positive orphan. Case-sensitive — the SAME exactness the
 * path selector deletes with, so detection and deletion always agree. Pure.
 * @param {string} rawPath @param {string} skillDirAbs
 */
function pathInsideSkillDir(rawPath, skillDirAbs) {
  if (typeof rawPath !== 'string' || typeof skillDirAbs !== 'string' || skillDirAbs.length === 0) return false;
  return normSep(rawPath).startsWith(normSep(skillDirAbs) + '/');
}

/**
 * @typedef {Object} OrphanResolveResult
 * @property {boolean} ok       false when the config is unparseable or any orphan is not a
 *                              UNIQUE deletable block (ambiguous / inline-array / multi-line) —
 *                              the caller then refuses the WHOLE prune (no half-delete).
 * @property {string} [code]    refusal code when ok:false.
 * @property {string} [message] refusal message when ok:false.
 * @property {import('../lib/plan.mjs').PlanOp[]} ops   one config-block-delete op per orphan.
 * @property {Array<{field:'name'|'path', value:string}>} pruned  the blocks the ops remove.
 */

/**
 * Resolve the orphaned `[[skills.config]]` blocks for a removed skill into config-block-delete
 * ops. PURE / never-throws (no I/O — `configText` is read by the caller). Enumerates orphans
 * from the parsed value (to read each block's name/path) and validates each one's deletability
 * + uniqueness via findBlockSpan (the EXACT check the real delete runs) so dry-run predicts apply.
 *
 * @param {object} a
 * @param {string} a.configText    the config.toml content
 * @param {string} a.configTarget  absolute config.toml path (the op target)
 * @param {string} a.skillName     the removed skill's leaf name (name-keyed match)
 * @param {string} a.skillDirAbs   absolute removed-skill dir (path-keyed match anchor)
 * @returns {OrphanResolveResult}
 */
export function resolveOrphanConfigOps(a) {
  const o = a && typeof a === 'object' ? a : {};
  const { configText, configTarget, skillName, skillDirAbs } = o;
  if (typeof configText !== 'string') {
    return { ok: false, code: 'prune-config-config-unreadable', message: 'config text is not a string', ops: [], pruned: [] };
  }

  const parsed = parseToml(configText);
  if (parsed.errors.length !== 0) {
    const e = parsed.errors[0];
    return { ok: false, code: 'prune-config-config-unparseable',
      message: `config.toml does not parse (${e ? `${e.message} at ${e.line}:${e.column}` : 'unknown'}); refusing to prune — fix the file or run without --prune-config`, ops: [], pruned: [] };
  }

  // Enumerate orphan blocks from the parsed value. Each `[[skills.config]]` element carries
  // EITHER a `name` OR a `path` key (51% of live entries are path-keyed); a name match keys by
  // the skill name, a path match by the path pointing inside the skill dir. name takes
  // precedence so an element keyed by both is emitted once.
  const arr = parsed.value && Array.isArray(parsed.value.skills && parsed.value.skills.config)
    ? parsed.value.skills.config : [];
  /** @type {Array<{field:'name'|'path', value:string}>} */
  const orphans = [];
  const seen = new Set();
  for (const el of arr) {
    if (!el || typeof el !== 'object') continue;
    let field = null; let value = null;
    if (typeof el.name === 'string' && el.name === skillName) { field = 'name'; value = el.name; }
    else if (typeof el.path === 'string' && pathInsideSkillDir(el.path, skillDirAbs)) { field = 'path'; value = el.path; }
    if (field === null) continue;
    const key = `${field} ${value}`;
    if (seen.has(key)) continue; // distinct selectors only; a duplicate is caught as ambiguous below
    seen.add(key);
    orphans.push({ field, value });
  }

  // No config entries reference this skill — a clean prune-nothing (the dir delete still runs).
  if (orphans.length === 0) return { ok: true, ops: [], pruned: [] };

  // Validate each orphan is a UNIQUE, deletable header block via the SAME locator the real
  // delete uses. A non-found selector (ambiguous / inline-array / unparseable-multiline) refuses
  // the WHOLE prune — never a half-delete, never a dry-run that mispredicts --apply.
  /** @type {import('../lib/plan.mjs').PlanOp[]} */
  const ops = [];
  /** @type {Array<{field:'name'|'path', value:string}>} */
  const pruned = [];
  for (const { field, value } of orphans) {
    /** @type {EnableSelector} */
    const selector = { kind: 'skill', match: { field, value } };
    const span = findBlockSpan(configText, selector);
    if (span.found) {
      ops.push({ kind: 'config-block-delete', target: configTarget, selector,
        summary: `prune orphaned [[skills.config]] (${field} = "${value}")` });
      pruned.push({ field, value });
      continue;
    }
    if (span.ambiguous) {
      return { ok: false, code: 'prune-config-ambiguous',
        message: `more than one [[skills.config]] entry matches ${field} = "${value}"; refusing to guess — fix config.toml by hand`, ops: [], pruned: [] };
    }
    if (span.error && span.error.code === 'unparseable-multiline') {
      return { ok: false, code: 'prune-config-unsupported-shape',
        message: `config.toml has an unterminated or multi-line TOML construct the block-locator cannot safely navigate; edit it by hand`, ops: [], pruned: [] };
    }
    // span.absent here means the value parser saw the element but no `[[skills.config]]` HEADER
    // block matches it — e.g. an inline `skills.config = [ {...} ]` array. The in-place locator
    // can only splice header blocks.
    return { ok: false, code: 'prune-config-unsupported-shape',
      message: `the [[skills.config]] entry for ${field} = "${value}" is not a deletable header block (it appears inline); edit config.toml by hand`, ops: [], pruned: [] };
  }
  return { ok: true, ops, pruned };
}

/**
 * @typedef {Object} PruneConfigResult
 * @property {boolean} ok          clean dry-run preview or successful apply.
 * @property {boolean} refused     validation/resolver refused (applyPlan NOT called).
 * @property {boolean} dryRun      true for the preview path; false for apply.
 * @property {string|null} kind    'skill' (null on a refusal before kind parse).
 * @property {string|null} name    the validated skill leaf, null on early refusal.
 * @property {string|null} target  the absolute skill dir, null on early refusal.
 * @property {Array<{field:'name'|'path', value:string}>} pruned  orphan blocks the plan removes.
 * @property {number} prunedCount  pruned.length.
 * @property {Plan|null} plan       the combined delete-dir + config-block-delete plan.
 * @property {ApplyResult|null} apply  the apply lifecycle result (apply path only).
 * @property {Diagnostic[]} diagnostics
 */

/** Build a full-shape PruneConfigResult with defaults. */
function buildResult(fields, bag) {
  return {
    ok: false, refused: false, dryRun: false,
    kind: null, name: null, target: null, pruned: [], prunedCount: 0, plan: null, apply: null,
    ...fields, diagnostics: bag.all(),
  };
}

/** Add an error diagnostic and return a refused PruneConfigResult. */
function refuse(bag, code, message, fields = {}) {
  bag.add({ severity: 'error', code, message, phase: PHASE });
  return buildResult({ refused: true, ...fields }, bag);
}

/**
 * Parse just the kind from a `<kind>:<name>` spec (before the existence probe), so a
 * `--prune-config` on a non-skill kind refuses cleanly regardless of whether the target
 * exists. Returns the kind string, or null when the spec is malformed (validateSpec then
 * produces the precise bad-spec refusal). Pure. @param {unknown} spec
 */
function kindOf(spec) {
  if (typeof spec !== 'string') return null;
  const idx = spec.indexOf(':');
  return idx > 0 ? spec.slice(0, idx) : null;
}

/**
 * Remove a codex skill AND prune its orphaned config entries in ONE reversible plan.
 * NEVER throws; every failure is a Diagnostic + a full-shape { ok:false } result.
 *
 * @param {object} opts
 * @param {string} opts.spec                            "skill:<name>"
 * @param {string} opts.targetClaudeDir                 absolute governed dir (~/.codex)
 * @param {string} opts.mgrStateDir                     absolute .mgr-state dir
 * @param {string} [opts.configFile='config.toml']      config basename (descriptor configEditFiles[0])
 * @param {ReadonlyArray<{kind:string,dir:string,layout:string}>} [opts.componentKinds]  codex remove kind table
 * @param {import('./snapshot-walk.mjs').SnapshotScope} [opts.scope]  codex snapshot scope
 * @param {(path:string, ctx:string)=>string} [opts.assertWritable]  gate; REQUIRED for --apply
 * @param {boolean} [opts.enableWrites]                 true = apply; false/absent = dry-run preview
 * @param {string}  [opts.reason]                       snapshot reason
 * @param {number}  [opts.pid]                          lock pid forwarded to applyPlan
 * @param {() => Date} [opts.now]                       clock injection
 * @param {(p:string)=>string} [opts.readConfigFn]      config read seam (default utf8 readFileSync)
 * @param {{applyFn?:Function}} [opts.seams]            applyFn defaults to applyPlan
 * @returns {Promise<PruneConfigResult>}
 */
export async function pruneConfigRemove(opts) {
  const bag = new DiagnosticBag();
  try {
    const o = opts && typeof opts === 'object' ? opts : {};
    const { spec, targetClaudeDir, mgrStateDir, assertWritable, reason, pid, now, componentKinds, scope } = o;
    const enableWrites = o.enableWrites === true;
    const configFile = typeof o.configFile === 'string' && o.configFile.length ? o.configFile : 'config.toml';
    const readConfigFn = typeof o.readConfigFn === 'function' ? o.readConfigFn : ((p) => readFileSync(p, 'utf8'));
    const seams = o.seams && typeof o.seams === 'object' ? o.seams : {};
    const applyFn = typeof seams.applyFn === 'function' ? seams.applyFn : applyPlan;
    const kindTable = componentKinds ? deriveKindSpec(componentKinds) : KIND_SPEC;

    if (typeof targetClaudeDir !== 'string' || targetClaudeDir.length === 0) {
      return refuse(bag, 'prune-config-bad-args', 'targetClaudeDir must be a non-empty string');
    }

    // 0. prune-config is SKILL-ONLY (only skills carry config entries). Check the kind BEFORE the
    //    existence probe so a non-skill spec refuses regardless of whether its target exists.
    const kind = kindOf(spec);
    if (kind !== null && kind !== 'skill') {
      return refuse(bag, 'prune-config-kind-unsupported',
        `--prune-config only applies to skills (only [[skills.config]] entries reference a component); "${kind}" has no config entries`);
    }

    // 1. Validate the skill spec + dir (SHARED with remove.mjs — the §1 refusal matrix). On any
    //    refusal, return WITHOUT reading config / building a plan / calling applyFn.
    const v = validateSpec(spec, targetClaudeDir, kindTable);
    if ('refusal' in v) return refuse(bag, v.refusal.code, v.refusal.message);
    const { base, target } = v; // target === the absolute skill dir (skills/<base>)

    // 2. Read config.toml + resolve the orphaned config blocks (the PURE judgment).
    const configTarget = join(targetClaudeDir, configFile);
    let configText;
    try { configText = readConfigFn(configTarget); }
    catch (e) {
      return refuse(bag, 'prune-config-config-not-found',
        `cannot read ${configTarget} (--prune-config needs the codex config file): ${e instanceof Error ? e.message : String(e)}`,
        { kind: 'skill', name: base, target });
    }
    const orph = resolveOrphanConfigOps({ configText, configTarget, skillName: base, skillDirAbs: target });
    if (!orph.ok) return refuse(bag, orph.code, orph.message, { kind: 'skill', name: base, target });

    // 3. Build the ONE combined plan: delete-dir skills/<name> + N config-block-delete.
    const label = `remove skill:${base} --prune-config`;
    const plan = emptyPlan(label, { apply: enableWrites });
    addOp(plan, { kind: 'delete-dir', target, summary: `remove skill:${base}` });
    for (const op of orph.ops) addOp(plan, op);
    const pruned = orph.pruned;
    const prunedCount = pruned.length;

    // 3a. DRY-RUN (default): preview only — write NOTHING.
    if (!enableWrites) {
      const detail = prunedCount > 0
        ? ` + ${prunedCount} orphaned config ${prunedCount === 1 ? 'entry' : 'entries'} [${pruned.map((p) => `${p.field}="${p.value}"`).join(', ')}]`
        : ' (no orphaned config entries reference it)';
      bag.add({ severity: 'info', code: 'prune-config-dry-run', phase: PHASE,
        message: `would delete ${target}${detail}; ONE auto-snapshot would be taken first so a single rollback undoes BOTH. Re-run with --apply to execute.` });
      return buildResult({ ok: true, dryRun: true, kind: 'skill', name: base, target, pruned, prunedCount, plan }, bag);
    }

    // 3b. APPLY: require the gate, then hand the combined plan to the apply lifecycle (one
    //     snapshot, multi-op, reversible via one rollback).
    if (typeof assertWritable !== 'function') {
      return refuse(bag, 'prune-config-bad-args',
        'assertWritable (the governed-write gate) must be injected to --apply a prune-config remove',
        { kind: 'skill', name: base, target, pruned, prunedCount, plan });
    }
    const ar = await applyFn({
      plan, targetClaudeDir, mgrStateDir, assertWritable, scope,
      reason: reason ?? plan.command, pid, enableWrites: true, now,
    });
    for (const d of ar?.diagnostics ?? []) bag.add(d);
    return buildResult({ ok: ar?.ok === true, dryRun: false, kind: 'skill', name: base, target, pruned, prunedCount, plan, apply: ar ?? null }, bag);
  } catch (e) {
    bag.add({ severity: 'error', code: 'prune-config-unexpected-error', phase: PHASE,
      message: `unexpected error during prune-config remove: ${e instanceof Error ? e.message : String(e)}` });
    return buildResult({}, bag);
  }
}
