/**
 * Remove command-level builder/orchestrator (P4a.U1d + P4b.S3) — the user-facing
 * entry for `remove <kind>:<name>` (delete ONE user-level component).
 *
 * This is the THIN command layer that sits ABOVE the apply lifecycle (apply.mjs):
 * it parses + validates `<kind>:<name>`, resolves the absolute target, builds a
 * one-op Plan (kind:'delete' for agents/commands, kind:'delete-dir' for skills),
 * and (for the --apply path) hands it to applyPlan — which auto-snapshots first
 * (the undo), then deletes via the appropriate primitive under the correct gate
 * context. It has NO lifecycle logic of its own.
 *
 *   removeComponent(opts)
 *      ├─ validate spec + target (the §1 refusal matrix)  →  clean refusal, never
 *      │     calls applyPlan, never a crash
 *      ├─ enableWrites !== true (DEFAULT):  build the Plan, return a PREVIEW —
 *      │     writes NOTHING (no lock, no snapshot, no delete)
 *      └─ enableWrites === true:  build the Plan, call applyPlan({enableWrites:true})
 *            which snapshots then deletes; aggregate its result + diagnostics
 *
 * REFUSAL MATRIX (docs/phase-4a-design.md §1) — each is a clean refusal with a
 * clear error Diagnostic + `{ ok:false, refused:true }`; applyPlan is NEVER called:
 *   - no `:` / empty spec or kind                 → remove-bad-spec
 *   - kind ∉ {agent, command, skill}              → remove-kind-unsupported
 *   - invalid name (namespaced ns/name, traversal
 *     ../x, ADS foo:bar, separators, '.'/'..',
 *     spaces, unicode — anything ∉ /^[A-Za-z0-9._-]+$/) → remove-name-invalid
 *   - target does not exist                        → remove-target-not-found
 *   - target is a SYMLINK                          → remove-target-is-symlink
 *   - FILE kind: target is not a regular file      → remove-target-not-a-file
 *   - DIR kind: target is not a directory          → remove-target-not-a-dir
 *
 * SECURITY / SAFETY:
 *   - DRY-RUN BY DEFAULT. Without `enableWrites` it builds the Plan + previews and
 *     touches nothing — no lock, no snapshot, no applyPlan call.
 *   - The governed delete is performed ONLY by applyPlan (enableWrites:true), which
 *     gates the unlink through assertWritable(target,'remove') INTERNALLY. This
 *     module performs NO filesystem mutation of its own (it only lstats the target
 *     for the existence/symlink/file refusal checks — a read-only probe).
 *   - assertWritable is INJECTED and forwarded to applyPlan (REQUIRED only for the
 *     --apply path; a dry-run preview needs no gate). It is never imported here.
 *   - The target is constructed from a fully-validated leaf name (no separators,
 *     no traversal), so the path handed to applyPlan / the gate is a plain .md leaf
 *     directly in agents/ or commands/.
 *
 * M2-SAFETY: imports ONLY node:fs (lstatSync), node:path (join), ../lib/plan.mjs,
 * ../lib/diagnostic.mjs, and ./apply.mjs. NEVER src/paths.mjs or src/lib/reexport
 * .mjs (both carry a top-level await that would poison this ops module's M2-safe
 * graph). assertWritable is injected, never imported. apply.mjs is itself M2-safe.
 *
 * Ops-layer constraint: node:* stdlib + src/lib/** + sibling src/ops/* only. Zero
 * npm deps. NEVER THROWS — the whole body is wrapped; any unexpected error becomes
 * a Diagnostic + `{ ok:false }`. A RemoveResult ALWAYS carries the full shape so
 * callers / render never see undefined.
 *
 * Spec: docs/phase-4a-design.md §1/§3/§5/§7; plan claude-mgr-v5.md Phase 4a.
 */

import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { emptyPlan, addOp } from '../lib/plan.mjs';
import { DiagnosticBag } from '../lib/diagnostic.mjs';
import { applyPlan } from './apply.mjs';

/** @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic */
/** @typedef {import('../lib/plan.mjs').Plan} Plan */
/** @typedef {import('./apply.mjs').ApplyResult} ApplyResult */

/** Stable diagnostic phase tag for this module's own findings. */
const PHASE = 'remove';

/**
 * Kind-spec table: each kind → { dir, isDir, opKind }.
 *   isDir:false  → FILE kind (agents/commands): the target is a single .md file,
 *                  gate context 'remove', op kind 'delete'.
 *   isDir:true   → DIR kind (skills): the target is a directory, gate context
 *                  'remove-skill', op kind 'delete-dir'.
 * Proto-safe: accessed only via hasOwnProperty, never bare property lookup.
 */
export const KIND_SPEC = Object.freeze({
  agent:   Object.freeze({ dir: 'agents',   isDir: false, opKind: 'delete' }),
  command: Object.freeze({ dir: 'commands', isDir: false, opKind: 'delete' }),
  skill:   Object.freeze({ dir: 'skills',   isDir: true,  opKind: 'delete-dir' }),
});

/**
 * Derive the remove kind-spec table from a target's `componentKinds` (descriptor
 * DATA), so remove is target-agnostic without importing targets/ (M2). By layout:
 *   skill-md  → a skill DIRECTORY            { isDir:true,  opKind:'delete-dir' }
 *   flat-md   → a single .md FILE            { isDir:false, ext:'.md',   opKind:'delete' }
 *   flat-toml → a single .toml FILE          { isDir:false, ext:'.toml', opKind:'delete' }
 * Any OTHER (unknown/future) layout falls into the flat-md '.md' default — add it
 * explicitly here when introduced. This can never widen a delete: the gate's per-dir
 * leafRe (writeSurface.removeLeaves) independently refuses a wrong-dir/wrong-ext target.
 * For Claude this reproduces KIND_SPEC (+ a '.md' ext); for Codex it yields
 * agent→agents/*.toml, command→prompts/*.md, skill→skills/. Proto-safe (null-proto
 * map; entries keyed by the user-facing kind). Pure / never-throws.
 * @param {ReadonlyArray<{kind:string, dir:string, layout:string}>} componentKinds
 * @returns {Record<string, {dir:string, isDir:boolean, ext?:string, opKind:string}>}
 */
export function deriveKindSpec(componentKinds) {
  const table = Object.create(null);
  const kinds = Array.isArray(componentKinds) ? componentKinds : [];
  for (const ck of kinds) {
    if (!ck || typeof ck.kind !== 'string' || typeof ck.dir !== 'string') continue;
    table[ck.kind] = ck.layout === 'skill-md'
      ? Object.freeze({ dir: ck.dir, isDir: true, opKind: 'delete-dir' })
      : Object.freeze({ dir: ck.dir, isDir: false, ext: ck.layout === 'flat-toml' ? '.toml' : '.md', opKind: 'delete' });
  }
  return table;
}

/** Strip a trailing extension (case-insensitive) if present; else return as-is. */
function stripExt(name, ext) {
  return name.toLowerCase().endsWith(ext.toLowerCase()) ? name.slice(0, -ext.length) : name;
}

/** A valid component leaf base: no separators, no traversal, no ADS, no spaces. */
const NAME_RE = /^[A-Za-z0-9._-]+$/;

/**
 * @typedef {Object} RemoveResult
 * @property {boolean} ok          true on a clean dry-run preview or a successful apply.
 * @property {boolean} refused     true when validation refused (applyPlan NOT called).
 * @property {boolean} dryRun      true for the preview path; false for the apply path.
 * @property {string|null} kind    'agent' | 'command' (null on a refusal before kind parse).
 * @property {string|null} name    the validated leaf base (no `.md`), null on early refusal.
 * @property {string|null} target  the absolute target file, null on early refusal.
 * @property {Plan|null} plan       the one-op delete plan (null on a refusal before build).
 * @property {ApplyResult|null} apply  the apply lifecycle result (only on the --apply path).
 * @property {Diagnostic[]} diagnostics  this module's findings + any from applyPlan.
 */

/**
 * Build a RemoveResult, defaulting every field so callers always get the full
 * shape (no undefined). `diagnostics` is written LAST from the bag.
 * @param {Partial<RemoveResult>} fields
 * @param {DiagnosticBag} bag
 * @returns {RemoveResult}
 */
function buildResult(fields, bag) {
  const defaults = {
    ok: false, refused: false, dryRun: false,
    kind: null, name: null, target: null, plan: null, apply: null,
  };
  return { ...defaults, ...fields, diagnostics: bag.all() };
}

/**
 * Validate `<kind>:<name>` and resolve the absolute target (§1 refusal matrix).
 * Returns `{ kind, base, target, spec: kindSpec }` on success, or `{ refusal }`
 * on any refusal. Pure except for a read-only lstatSync probe of the target.
 * Never throws (the lstat is try/caught).
 * @param {unknown} spec
 * @param {string} targetClaudeDir
 * @param {Record<string, {dir:string, isDir:boolean, ext?:string, opKind:string}>} kindTable
 * @returns {{kind:string, base:string, target:string, spec:{dir:string,isDir:boolean,ext?:string,opKind:string}}|{refusal:{code:string,message:string}}}
 */
function validateSpec(spec, targetClaudeDir, kindTable) {
  const refuse = (code, message) => ({ refusal: { code, message } });

  // Parse <kind>:<name> on the FIRST colon. Reject a missing colon / empty parts.
  if (typeof spec !== 'string' || spec.length === 0) {
    return refuse('remove-bad-spec', 'spec must be a non-empty "<kind>:<name>" string');
  }
  const idx = spec.indexOf(':');
  if (idx < 0) {
    return refuse('remove-bad-spec', `spec must be "<kind>:<name>" with a colon; got "${spec}"`);
  }
  const kind = spec.slice(0, idx);
  const rawName = spec.slice(idx + 1);
  if (kind.length === 0) {
    return refuse('remove-bad-spec', 'spec must name a kind before the colon (e.g. "agent:foo")');
  }

  // Kind must be one of the known kinds. Plugins/marketplaces are out of scope.
  if (!Object.prototype.hasOwnProperty.call(kindTable, kind)) {
    return refuse('remove-kind-unsupported',
      `remove supports agent/command/skill; "${kind}" is not removable here ` +
      '(plugins/marketplaces are out of scope — deferred to Phase 4b)');
  }
  const kindSpec = kindTable[kind];

  // Name validation — behaviour differs by kind:
  //   FILE kinds (agent/command): strip the per-target trailing ext (Claude .md;
  //     Codex agents .toml / prompts .md), then validate NAME_RE.
  //   DIR  kinds (skill): NO ext strip; the name IS the directory base as-is.
  // In both cases: non-empty, no path separator, not '.'/'..', NAME_RE only.
  // This rejects namespaced ns/name, traversal ../x, ADS foo:bar, spaces, unicode.
  const ext = kindSpec.ext ?? '.md';
  const base = kindSpec.isDir ? rawName : stripExt(rawName, ext);
  if (base.length === 0 || base === '.' || base === '..'
      || base.includes('/') || base.includes('\\') || !NAME_RE.test(base)) {
    return refuse('remove-name-invalid',
      `invalid component name "${rawName}"; must be a plain leaf matching ${NAME_RE} (no path, traversal, or special chars)`);
  }

  // Resolve the absolute target (the FILE extension is per-target: Claude .md,
  // Codex agents .toml / prompts .md):
  //   FILE: <dir>/<base><ext>   DIR: <dir>/<base>  (the directory itself, no extension)
  const target = kindSpec.isDir
    ? join(targetClaudeDir, kindSpec.dir, base)
    : join(targetClaudeDir, kindSpec.dir, base + ext);

  // Existence / symlink / type refusals (read-only lstat probe).
  let st;
  try {
    st = lstatSync(target);
  } catch {
    return refuse('remove-target-not-found', `nothing to remove: ${target} does not exist`);
  }
  if (st.isSymbolicLink()) {
    return refuse('remove-target-is-symlink',
      `refusing to remove a symlinked component: ${target} is a symlink`);
  }
  if (kindSpec.isDir) {
    if (!st.isDirectory()) {
      return refuse('remove-target-not-a-dir',
        `refusing to remove ${target}: expected a directory for skill kind`);
    }
  } else {
    if (!st.isFile()) {
      return refuse('remove-target-not-a-file', `refusing to remove ${target}: not a regular file`);
    }
  }

  return { kind, base, target, spec: kindSpec };
}

/**
 * Build the one-op delete Plan for a validated target.
 * @param {string} kind       'agent' | 'command' | 'skill'
 * @param {string} base       validated leaf base (no `.md` for FILE; bare dir name for DIR)
 * @param {string} target     absolute target path
 * @param {string} opKind     'delete' (FILE) | 'delete-dir' (DIR)
 * @param {boolean} enableWrites
 * @returns {Plan}
 */
function buildDeletePlan(kind, base, target, opKind, enableWrites) {
  const label = 'remove ' + kind + ':' + base;
  const plan = emptyPlan(label, { apply: enableWrites === true });
  addOp(plan, { kind: opKind, target, summary: label });
  return plan;
}

/**
 * Remove ONE user-level single-file component (`remove <kind>:<name>`). Validates
 * the spec + target, builds a single-op delete Plan, and either previews it
 * (dry-run, the DEFAULT — writes nothing) or hands it to the apply lifecycle
 * (enableWrites — auto-snapshot then delete). NEVER throws; every failure is a
 * Diagnostic + a full-shape `{ ok:false }` RemoveResult.
 *
 * @param {object} opts
 * @param {string} opts.spec                            the "<kind>:<name>" string
 * @param {string} opts.targetClaudeDir                 absolute governed dir
 * @param {string} opts.mgrStateDir                     absolute .mgr-state dir
 * @param {(path:string, ctx:string)=>string} [opts.assertWritable]  governed-write
 *           gate; REQUIRED only for the --apply path, forwarded to applyPlan.
 * @param {ReadonlyArray<{kind:string,dir:string,layout:string}>} [opts.componentKinds]
 *           descriptor componentKinds → the remove kind table (Codex). Absent → Claude KIND_SPEC.
 * @param {import('./snapshot-walk.mjs').SnapshotScope} [opts.scope]  per-target snapshot
 *           scope forwarded to applyPlan's auto-snapshot (Codex). Absent → Claude scope.
 * @param {boolean} [opts.enableWrites]                 true = actually delete; false/
 *           absent = dry-run preview (writes NOTHING).
 * @param {string}  [opts.reason]                       snapshot reason (defaults to the command label).
 * @param {number}  [opts.pid]                          lock pid forwarded to applyPlan.
 * @param {() => Date} [opts.now]                       clock injection forwarded to applyPlan.
 * @param {{applyFn?:Function}} [opts.seams]            applyFn defaults to applyPlan.
 * @returns {Promise<RemoveResult>}
 */
export async function removeComponent(opts) {
  const bag = new DiagnosticBag();
  try {
    const o = opts && typeof opts === 'object' ? opts : {};
    const { spec, targetClaudeDir, mgrStateDir, assertWritable, reason, pid, now, componentKinds, scope } = o;
    const enableWrites = o.enableWrites === true;
    // The remove kind table is descriptor-driven: Codex passes componentKinds
    // (agent→agents/.toml, command→prompts/.md, skill→skills/); absent → Claude KIND_SPEC.
    const kindTable = componentKinds ? deriveKindSpec(componentKinds) : KIND_SPEC;
    const seams = o.seams && typeof o.seams === 'object' ? o.seams : {};
    const applyFn = typeof seams.applyFn === 'function' ? seams.applyFn : applyPlan;

    // 0. Basic arg shape (targetClaudeDir/mgrStateDir are passed through to apply).
    if (typeof targetClaudeDir !== 'string' || targetClaudeDir.length === 0) {
      return refuse(bag, 'remove-bad-args', 'targetClaudeDir must be a non-empty string', {});
    }

    // 1. Validate the spec + target (§1 refusal matrix). On ANY refusal, return
    //    WITHOUT calling applyFn — no lock, no snapshot, no write.
    const v = validateSpec(spec, targetClaudeDir, kindTable);
    if ('refusal' in v) {
      return refuse(bag, v.refusal.code, v.refusal.message, {});
    }
    const { kind, base, target, spec: kindSpec } = v;

    // 2. Build the single-op delete plan (shared by both the preview + apply paths).
    // opKind is 'delete' for FILE kinds, 'delete-dir' for DIR kinds (skill).
    const plan = buildDeletePlan(kind, base, target, kindSpec.opKind, enableWrites);

    // 3a. DRY-RUN (default): preview only — write NOTHING (no lock/snapshot/applyFn).
    if (!enableWrites) {
      bag.add({ severity: 'info', code: 'remove-dry-run', phase: PHASE,
        message: `would delete ${target} (an auto-snapshot would be taken first so a rollback can undo it); ` +
          're-run with --apply to execute' });
      return buildResult({ ok: true, dryRun: true, kind, name: base, target, plan }, bag);
    }

    // 3b. APPLY: require the gate, then hand the plan to the apply lifecycle.
    if (typeof assertWritable !== 'function') {
      return refuse(bag, 'remove-bad-args',
        'assertWritable (the governed-write gate) must be injected to --apply a remove', { kind, name: base, target, plan });
    }
    const ar = await applyFn({
      plan, targetClaudeDir, mgrStateDir, assertWritable, scope,
      reason: reason ?? plan.command, pid, enableWrites: true, now,
    });
    for (const d of ar?.diagnostics ?? []) bag.add(d);
    return buildResult({ ok: ar?.ok === true, dryRun: false, kind, name: base, target, plan, apply: ar ?? null }, bag);
  } catch (e) {
    // Absolute backstop: an unexpected error becomes a diagnostic, never a throw.
    bag.add({ severity: 'error', code: 'remove-unexpected-error', phase: PHASE,
      message: `unexpected error during remove: ${e instanceof Error ? e.message : String(e)}` });
    return buildResult({}, bag);
  }
}

/**
 * Add an error diagnostic and return a refused RemoveResult carrying any known
 * fields (kind/name/target/plan when already resolved). Shared refusal helper.
 * @param {DiagnosticBag} bag
 * @param {string} code @param {string} message @param {Partial<RemoveResult>} fields
 * @returns {RemoveResult}
 */
function refuse(bag, code, message, fields) {
  bag.add({ severity: 'error', code, message, phase: PHASE });
  return buildResult({ refused: true, ...fields }, bag);
}
