/**
 * Cascade remove orchestrator (P4b.U4) — remove a target component AND every
 * component that transitively references it (Option A: dependents cascade).
 *
 * `cascadeRemove(opts)` is the user-facing entry for
 *   `remove <kind>:<name> --cascade [--force] [--apply]`
 *
 * Flow:
 *   1. Parse + validate the spec (reuses remove.mjs KIND_SPEC + validateSpec logic).
 *   2. Discover components from targetClaudeDir and build the component graph.
 *   3. Compute the cascade set (dependents BFS from the target).
 *   4. Build per-node delete ops (same per-kind logic as remove.mjs).
 *   5. Emit a mandatory PREVIEW (always returned in the result, even for --apply).
 *   6. DRY-RUN (default): return preview, call no write.
 *   7. --APPLY: --force gate (dependents non-empty → require force); then applyPlan
 *      (one snapshot, multi-op delete, reversible via rollback).
 *
 * SAFETY MODEL (docs/component-graph-design.md §5/§6):
 *   - DRY-RUN BY DEFAULT. Without `enableWrites` no fs mutation ever happens.
 *   - The --force gate ensures the user explicitly confirms deleting dependents.
 *   - A plain `remove --cascade` with NO dependents behaves like `remove` (no force
 *     required, the cascade set is empty = target only).
 *   - ONE applyPlan call = ONE snapshot = ONE rollback to undo everything.
 *   - The mandatory preview is ALWAYS returned so the CLI always shows what would
 *     have been removed, regardless of whether --apply succeeded.
 *   - Each node's delete op is path-reconstructed from kind+name+targetClaudeDir
 *     (same scheme as remove.mjs) — we never trust node.path for the write target.
 *   - Nodes that no longer lstat on disk are SKIPPED with a warn diagnostic rather
 *     than failing the whole cascade (they were discoverable but are now absent).
 *   - assertWritable is INJECTED + REQUIRED for the --apply path only (M2-safe;
 *     the dry-run path needs no gate).
 *
 * M2-SAFETY: imports ONLY discovery/components + lib/component-graph* + lib/plan +
 * lib/diagnostic + ops/apply + ops/remove. NEVER src/paths.mjs or
 * src/lib/reexport.mjs. assertWritable is injected, never imported.
 *
 * NEVER THROWS — whole body is wrapped; any unexpected error degrades to a
 * `cascade-unexpected-error` Diagnostic + a full-shape CascadeResult.
 *
 * Under 200 SLOC (lint ceiling). Zero npm dependencies.
 */

import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { emptyPlan, addOp } from '../lib/plan.mjs';
import { DiagnosticBag } from '../lib/diagnostic.mjs';
import { buildComponentGraph, extractEdges } from '../lib/component-graph.mjs';
import { cascadeSet, cascadePreview } from '../lib/component-graph-traverse.mjs';
import { discoverComponents } from '../discovery/components.mjs';
import { applyPlan } from './apply.mjs';

/** @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic */
/** @typedef {import('../lib/plan.mjs').Plan} Plan */
/** @typedef {import('./apply.mjs').ApplyResult} ApplyResult */
/** @typedef {import('../lib/component-graph-traverse.mjs').CascadePreviewResult} CascadePreviewResult */

const PHASE = 'cascade';

/**
 * Kind-spec table — identical to remove.mjs KIND_SPEC (single-sourced by copy
 * per the ops-layer constraint: sibling ops modules share no mutable state;
 * importing the private table from remove.mjs would couple internals). Kept in
 * sync by the P4b spec; a drift-guard test in cascade.test.mjs asserts the two
 * tables remain deepEqual so a future divergence fails the gate immediately.
 */
export const KIND_SPEC = Object.freeze({
  agent:   Object.freeze({ dir: 'agents',   isDir: false, opKind: 'delete' }),
  command: Object.freeze({ dir: 'commands', isDir: false, opKind: 'delete' }),
  skill:   Object.freeze({ dir: 'skills',   isDir: true,  opKind: 'delete-dir' }),
});

const NAME_RE = /^[A-Za-z0-9._-]+$/;

/**
 * @typedef {Object} CascadeResult
 * @property {boolean} ok
 * @property {boolean} refused      true when validation or --force gate refused
 * @property {boolean} dryRun       true for the preview path
 * @property {string|null} target   the targetId (kind:name)
 * @property {string[]} dependents  ids from the cascade set (excluding the target)
 * @property {CascadePreviewResult|null} preview  always populated after graph resolution
 * @property {Plan|null} plan       the multi-op delete plan (null on early refusal)
 * @property {ApplyResult|null} apply  the apply lifecycle result (--apply path only)
 * @property {Diagnostic[]} diagnostics
 */

/** Build a full-shape CascadeResult with defaults. */
function buildResult(fields, bag) {
  return {
    ok: false, refused: false, dryRun: false,
    target: null, dependents: [], preview: null, plan: null, apply: null,
    ...fields,
    diagnostics: bag.all(),
  };
}

/** Add an error diagnostic and return a refused CascadeResult. */
function refuse(bag, code, message, fields = {}) {
  bag.add({ severity: 'error', code, message, phase: PHASE });
  return buildResult({ refused: true, ...fields }, bag);
}

/**
 * Parse a `kind:name` spec against KIND_SPEC. Returns `{kind, base}` or
 * `{refusal: {code, message}}`. Mirrors remove.mjs validateSpec (validation
 * only, no lstat — the caller handles per-node lstat for the cascade set).
 */
function parseSpec(spec) {
  const fail = (code, message) => ({ refusal: { code, message } });
  if (typeof spec !== 'string' || spec.length === 0) {
    return fail('cascade-bad-spec', 'spec must be a non-empty "<kind>:<name>" string');
  }
  const idx = spec.indexOf(':');
  if (idx < 0) return fail('cascade-bad-spec', `spec must be "<kind>:<name>"; got "${spec}"`);
  const kind = spec.slice(0, idx);
  const rawName = spec.slice(idx + 1);
  if (kind.length === 0) return fail('cascade-bad-spec', 'spec must name a kind before the colon');
  if (!Object.prototype.hasOwnProperty.call(KIND_SPEC, kind)) {
    return fail('cascade-kind-unsupported',
      `cascade supports agent/command/skill; "${kind}" is not removable here`);
  }
  const kindSpec = KIND_SPEC[kind];
  const base = kindSpec.isDir ? rawName : rawName.replace(/\.md$/i, '');
  if (base.length === 0 || base === '.' || base === '..'
      || base.includes('/') || base.includes('\\') || !NAME_RE.test(base)) {
    return fail('cascade-name-invalid',
      `invalid component name "${rawName}"; must match ${NAME_RE}`);
  }
  return { kind, base };
}

/**
 * Reconstruct the absolute delete target for a graph node. Returns `{target,
 * opKind}` or null when the kind is unsupported or lstat fails (caller skips+warns).
 * @param {object} node
 * @param {string} targetClaudeDir
 * @param {Function} [lstatFn]  injectable seam for testing (defaults to lstatSync)
 */
function resolveNodeTarget(node, targetClaudeDir, lstatFn) {
  const stat = typeof lstatFn === 'function' ? lstatFn : lstatSync;
  const ks = Object.prototype.hasOwnProperty.call(KIND_SPEC, node.kind)
    ? KIND_SPEC[node.kind] : null;
  if (!ks) return null;
  const abs = ks.isDir
    ? join(targetClaudeDir, ks.dir, node.name)
    : join(targetClaudeDir, ks.dir, node.name + '.md');
  try {
    const st = stat(abs);
    if (st.isSymbolicLink()) return null; // skip symlinks conservatively
    if (ks.isDir && !st.isDirectory()) return null;
    if (!ks.isDir && !st.isFile()) return null;
  } catch {
    return null; // not found → caller skips with warn
  }
  return { target: abs, opKind: ks.opKind };
}

/**
 * Build the multi-op delete Plan for a cascade set. Skips nodes whose on-disk
 * target cannot be lstat'd (warn per skip). Returns `{plan, allIds}`.
 * Extracted to keep cascadeRemove under the 80-SLOC lint ceiling.
 * @param {{graph,targetId,setIds,targetClaudeDir,enableWrites,lstatFn,bag}} ctx
 */
function buildCascadePlan({ graph, targetId, setIds, targetClaudeDir, enableWrites, lstatFn, bag }) {
  const allIds = [targetId, ...setIds];
  const plan = emptyPlan(`cascade remove ${targetId}`, { apply: enableWrites });
  for (const id of allIds) {
    const node = graph.byId.get(id);
    if (!node) continue;
    const resolved = resolveNodeTarget(node, targetClaudeDir, lstatFn);
    if (!resolved) {
      bag.add({ severity: 'warn', code: 'cascade-node-skip', phase: PHASE,
        message: `skipping "${id}": target not found or is a symlink/wrong type on disk` });
      continue;
    }
    addOp(plan, { kind: resolved.opKind, target: resolved.target,
      summary: `cascade delete ${id}` });
  }
  return { plan, allIds };
}

/**
 * Cascade-remove a component and all its dependents in one atomic snapshot.
 *
 * @param {object} opts
 * @param {string} opts.spec                 "<kind>:<name>"
 * @param {string} opts.targetClaudeDir      absolute governed dir
 * @param {string} opts.mgrStateDir          absolute .mgr-state dir
 * @param {Function} [opts.assertWritable]   injected gate (required for --apply)
 * @param {boolean} [opts.enableWrites]      true = execute; false/absent = dry-run
 * @param {boolean} [opts.force]             required when dependents are non-empty
 * @param {string}  [opts.reason]            snapshot reason label
 * @param {number}  [opts.pid]               lock owner pid
 * @param {Function} [opts.now]              clock injection
 * @param {{applyFn?:Function, discoverFn?:Function, lstatFn?:Function}} [opts.seams]
 * @returns {Promise<CascadeResult>}
 */
export async function cascadeRemove(opts) {
  const bag = new DiagnosticBag();
  try {
    const o = opts && typeof opts === 'object' ? opts : {};
    const { spec, targetClaudeDir, mgrStateDir, assertWritable, reason, pid, now } = o;
    const enableWrites = o.enableWrites === true;
    const force = o.force === true;
    const seams = o.seams && typeof o.seams === 'object' ? o.seams : {};
    const applyFn   = typeof seams.applyFn   === 'function' ? seams.applyFn   : applyPlan;
    const discoverFn = typeof seams.discoverFn === 'function' ? seams.discoverFn : discoverComponents;
    const lstatFn   = typeof seams.lstatFn   === 'function' ? seams.lstatFn   : lstatSync;

    if (typeof targetClaudeDir !== 'string' || targetClaudeDir.length === 0) {
      return refuse(bag, 'cascade-bad-args', 'targetClaudeDir must be a non-empty string');
    }
    const parsed = parseSpec(spec);
    if ('refusal' in parsed) return refuse(bag, parsed.refusal.code, parsed.refusal.message);
    const { kind, base } = parsed;
    const targetId = `${kind}:${base}`;

    let discoveryResult;
    try { discoveryResult = discoverFn(targetClaudeDir); }
    catch (e) {
      return refuse(bag, 'cascade-discover-failed',
        `component discovery failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    const components = discoveryResult && Array.isArray(discoveryResult.components)
      ? discoveryResult.components : [];
    const graph = extractEdges(buildComponentGraph(components));

    if (!graph.byId.get(targetId)) {
      return refuse(bag, 'cascade-target-not-found',
        `component "${targetId}" not found in the governed dir; is the kind:name correct?`,
        { target: targetId });
    }

    const set = cascadeSet(graph, targetId, { direction: 'dependents' });
    const preview = cascadePreview(graph, targetId, { direction: 'dependents' });
    const { plan, allIds } = buildCascadePlan(
      { graph, targetId, setIds: set.ids, targetClaudeDir, enableWrites, lstatFn, bag });

    if (!enableWrites) {
      bag.add({ severity: 'info', code: 'cascade-dry-run', phase: PHASE,
        message: `would delete ${allIds.length} component(s) [${allIds.join(', ')}]; ` +
          're-run with --apply to execute' +
          (set.ids.length > 0 ? ' (--force also required to confirm deletion of dependents)' : '') });
      return buildResult({ ok: true, dryRun: true, target: targetId,
        dependents: set.ids.slice(), preview, plan }, bag);
    }

    if (typeof assertWritable !== 'function') {
      return refuse(bag, 'cascade-bad-args',
        'assertWritable (the governed-write gate) must be injected for --apply',
        { target: targetId, dependents: set.ids.slice(), preview, plan });
    }
    if (set.ids.length > 0 && !force) {
      return refuse(bag, 'cascade-needs-force',
        `--cascade would also delete ${set.ids.length} dependent(s): ` +
        `${set.ids.join(', ')}; re-run with --force to confirm`,
        { target: targetId, dependents: set.ids.slice(), preview, plan, refused: true });
    }

    const ar = await applyFn({
      plan, targetClaudeDir, mgrStateDir, assertWritable,
      reason: reason ?? `cascade remove ${targetId}`,
      pid, enableWrites: true, now,
    });
    for (const d of ar?.diagnostics ?? []) bag.add(d);
    return buildResult({ ok: ar?.ok === true, dryRun: false,
      target: targetId, dependents: set.ids.slice(), preview, plan, apply: ar ?? null }, bag);

  } catch (e) {
    bag.add({ severity: 'error', code: 'cascade-unexpected-error', phase: PHASE,
      message: `unexpected error during cascade: ${e instanceof Error ? e.message : String(e)}` });
    return buildResult({}, bag);
  }
}
