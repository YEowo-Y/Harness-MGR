/**
 * Snapshot management command handlers (P3/P4a) — `snapshot list` + `snapshot gc`.
 *
 * Extracted into its own file (mirroring ops-commands.mjs / settings-layers.mjs)
 * so ops-commands.mjs stays under the 200-SLOC lint ceiling and the read/gc
 * management surface is grouped together.
 *
 * Both handlers honour the never-throws + pure-result contract from commands.mjs:
 * they return `{ result, diagnostics }` and never call process.exit / write stdout.
 * `listSnapshots` / `gcSnapshots` are ops-pure and never throw; `parseSince`
 * (reused from audit.mjs) converts the `--older-than` window to milliseconds.
 *
 * SECURITY POSTURE: `snapshot gc` is DRY-RUN BY DEFAULT — a bare `snapshot gc`
 * previews `wouldDelete[]` and removes nothing; only `--apply` performs the
 * BOUNDED delete (bounded inside gcSnapshots by the SNAPSHOT_ID_RE + snapshotDir
 * construction, never rm-rf). No paths.mjs / assertWritable: list/gc are pure
 * `.mgr-state` I/O (no governed-config write).
 *
 * Zero npm dependencies. Node stdlib only.
 */

import { listSnapshots, gcSnapshots } from '../ops/snapshot-store.mjs';
import { gcExtras } from '../ops/gc-extras.mjs';
import { parseSince } from '../ops/audit.mjs';
import { resolveWriteIntent } from './write-gate.mjs';

/** @typedef {import('./commands.mjs').CommandHandler} CommandHandler */

// ── snapshot list ──────────────────────────────────────────────────────────────

/**
 * Read-only snapshot listing. Surfaces every snapshot under `.mgr-state/snapshots/`
 * newest-first: each as `{ id, createdAt, reason, fileCount, complete, pinned }`.
 * An incomplete dir (no/invalid manifest) is listed with `complete:false`. A
 * missing snapshots dir is benign (empty list). Never throws.
 *
 * RETENTION PREVIEW: when `--keep` or `--older-than` is present, a DRY-RUN
 * gcSnapshots is run and each snapshot is annotated with `wouldPrune:boolean`.
 * A pinned snapshot is ALWAYS `wouldPrune:false` regardless of what gc returns.
 * A `summary` is always included: `{ total, pinnedCount, wouldPruneCount,
 * keptCount }` — `wouldPruneCount`/`keptCount` are omitted when no criterion.
 *
 * `seams` is an injectable test seam: fake `listFn` / `gcFn` enable unit testing
 * without a real `.mgr-state` on disk.
 *
 * @param {import('./commands.mjs').CommandContext} ctx
 * @param {{ listFn?: typeof listSnapshots, gcFn?: typeof gcSnapshots }} [seams]
 * @returns {import('./commands.mjs').CommandOutput}
 */
export function snapshotListCommand(ctx, seams = {}) {
  const listFn = seams.listFn ?? listSnapshots;
  const gcFn   = seams.gcFn   ?? gcSnapshots;
  const mgrStateDir = ctx && ctx.mgrStateDir;
  const args = (ctx && ctx.args) || {};

  /** @type {{severity:string,code:string,message:string,phase:string}[]} */
  const extraDiags = [];
  const keep       = coerceKeep(args.keep, extraDiags);
  const olderThanMs = coerceOlderThan(args['older-than'], extraDiags);
  const hasCriterion = keep !== undefined || olderThanMs !== undefined;

  const { snapshots: raw, diagnostics: listDiags } = listFn({ mgrStateDir });
  const snapshots = Array.isArray(raw) ? raw : [];

  // Compute per-snapshot wouldPrune annotation when a criterion is present.
  /** @type {Set<string>} */
  let wouldDeleteSet = new Set();
  if (hasCriterion) {
    const gc = gcFn({ mgrStateDir, keep, olderThanMs, apply: false });
    const wd = Array.isArray(gc.wouldDelete) ? gc.wouldDelete : [];
    wouldDeleteSet = new Set(wd);
    for (const d of (gc.diagnostics ?? [])) extraDiags.push(d);
  }

  // Annotate each snapshot; build summary counts.
  const annotated = snapshots.map((s) => {
    if (!s || typeof s !== 'object') return s;
    if (!hasCriterion) return s;
    // A pinned snapshot is ALWAYS wouldPrune:false — gc force-retains pins.
    const wouldPrune = s.pinned ? false : wouldDeleteSet.has(s.id);
    return { ...s, wouldPrune };
  });

  const pinnedCount = snapshots.filter((s) => s && s.pinned).length;
  /** @type {Record<string, number>} */
  const summary = { total: snapshots.length, pinnedCount };
  if (hasCriterion) {
    const pruneCount = annotated.filter((s) => s && s.wouldPrune).length;
    summary.wouldPruneCount = pruneCount;
    summary.keptCount = snapshots.length - pruneCount;
  }

  return {
    result: { snapshots: annotated, count: snapshots.length, summary },
    diagnostics: [...listDiags, ...extraDiags],
  };
}

// ── snapshot gc ────────────────────────────────────────────────────────────────

/**
 * Garbage-collect (prune) old snapshots per a retention policy. DRY-RUN BY DEFAULT.
 *
 * Flags:
 *   `args.keep`          (string|number) retain the N newest snapshots.
 *   `args['older-than']` (string, e.g. '30d', '24h') retain snapshots newer than
 *                        that window — i.e. PRUNE ones older than it. Invalid →
 *                        a `gc-older-than-invalid` warn (that criterion is dropped).
 *   `args.apply`         (boolean) actually perform the BOUNDED delete. WITHOUT it
 *                        (the default) the command previews `wouldDelete[]` and
 *                        removes nothing (mode 'dry-run').
 *
 * REQUIRING a criterion is enforced inside `gcSnapshots` (no `keep`/`older-than`
 * → a `gc-no-criterion` warn + nothing deleted), so a bare `snapshot gc` is safe.
 * The criterion requirement governs the SNAPSHOT category only; the THREE extra
 * cleanup categories (audit-large orphans / orphan apply-lock / leftover sidecars,
 * via `gcExtras`) always run — each is itself bounded + age/liveness-guarded.
 *
 * WRITE GATE (P3.U22): `--apply` enables the write; set `HARNESS_MGR_ENABLE_WRITES=0`
 * as an explicit opt-out lock. A closed gate (env `=0`) REFUSES (code 3 +
 * `writes-disabled-env`) BEFORE `gcFn`/`extrasFn` run, so NOTHING is deleted in any
 * category. A dry-run gc (no `--apply`) is unaffected — the env factor is irrelevant
 * there, and both `gcFn` and `extrasFn` preview (`wouldDelete`/`wouldReap`).
 *
 * `seams` is an injectable test seam: a fake `gcFn` / `extrasFn` makes dry-run-vs-
 * apply and the flag plumbing unit-testable without touching the filesystem (a fake
 * `env` makes the gate hermetic). Never throws.
 *
 * @param {import('./commands.mjs').CommandContext} ctx
 * @param {{ gcFn?: typeof gcSnapshots, extrasFn?: typeof gcExtras, env?: Record<string, string|undefined>, now?: () => number }} [seams]
 * @returns {import('./commands.mjs').CommandOutput}
 */
export function snapshotGcCommand(ctx, seams = {}) {
  const gcFn = seams.gcFn ?? gcSnapshots;
  const extrasFn = seams.extrasFn ?? gcExtras;
  const mgrStateDir = ctx && ctx.mgrStateDir;
  const args = (ctx && ctx.args) || {};
  const apply = !!args.apply;

  /** @type {{severity:string,code:string,message:string,phase:string}[]} */
  const preDiags = [];
  const keep = coerceKeep(args.keep, preDiags);
  const olderThanMs = coerceOlderThan(args['older-than'], preDiags);

  // Two-factor gate (apply path only): a closed gate refuses before gcFn/extrasFn
  // run, so nothing is deleted in ANY category. preDiags (any keep/older-than
  // coercion warns) are kept so a typo isn't swallowed by the refusal.
  if (apply) {
    const intent = resolveWriteIntent({ apply: true, env: seams.env ?? process.env });
    if (intent.refusal) {
      return {
        result: emptyGcResult('applied'),
        diagnostics: [...preDiags, intent.refusal],
        code: intent.code,
      };
    }
  }

  // After the gate (or in dry-run) run BOTH the snapshot prune AND the 3 extra
  // cleanup categories with the same apply flag.
  const gc = gcFn({ mgrStateDir, keep, olderThanMs, apply });
  const extras = extrasFn({ mgrStateDir, apply, now: seams.now });

  return {
    result: mergeGcResult(apply, gc, extras),
    diagnostics: [...preDiags, ...gc.diagnostics, ...arr(extras && extras.diagnostics)],
  };
}

/** An empty gc result shape (used for the gate-refused path). @returns {object} */
function emptyGcResult(mode) {
  return {
    mode, deleted: [], wouldDelete: [], retained: [],
    deletedCount: 0, wouldDeleteCount: 0, retainedCount: 0,
    auditLarge: { deleted: 0, wouldDelete: 0 },
    lock: { reaped: 0, wouldReap: 0 },
    leftovers: { deleted: 0, wouldDelete: 0 },
    extrasDeletedCount: 0,
  };
}

/**
 * Merge the snapshot-prune result and the gcExtras result into the command's flat
 * result payload. Keeps every existing snapshot field, ADDS the three extra-category
 * counts and a combined `extrasDeletedCount` (audit-large + leftovers deletes plus
 * the lock reap as 1). Defensive — missing fields/arrays read as 0. Pure.
 * @param {boolean} apply
 * @param {{deleted?:string[], wouldDelete?:string[], retained?:string[]}} gc
 * @param {{auditLarge?:object, lock?:object, leftovers?:object}} extras  gcExtras() result
 * @returns {object}
 */
function mergeGcResult(apply, gc, extras) {
  const x = extras && typeof extras === 'object' ? extras : {};
  const al = x.auditLarge && typeof x.auditLarge === 'object' ? x.auditLarge : {};
  const lk = x.lock && typeof x.lock === 'object' ? x.lock : {};
  const lo = x.leftovers && typeof x.leftovers === 'object' ? x.leftovers : {};
  const auditLargeDeleted = arr(al.deleted).length;
  const leftoversDeleted = arr(lo.deleted).length;
  const lockReaped = lk.reaped === true ? 1 : 0;
  return {
    mode: apply ? 'applied' : 'dry-run',
    deleted: arr(gc.deleted),
    wouldDelete: arr(gc.wouldDelete),
    retained: arr(gc.retained),
    deletedCount: arr(gc.deleted).length,
    wouldDeleteCount: arr(gc.wouldDelete).length,
    retainedCount: arr(gc.retained).length,
    auditLarge: { deleted: auditLargeDeleted, wouldDelete: arr(al.wouldDelete).length },
    lock: { reaped: lockReaped, wouldReap: lk.wouldReap === true ? 1 : 0 },
    leftovers: { deleted: leftoversDeleted, wouldDelete: arr(lo.wouldDelete).length },
    extrasDeletedCount: auditLargeDeleted + leftoversDeleted + lockReaped,
  };
}

/** Coerce a value to an array (non-arrays → []). @param {unknown} v @returns {unknown[]} */
function arr(v) {
  return Array.isArray(v) ? v : [];
}

/**
 * Coerce the `--keep` flag (a string from argv, or a number) into a non-negative
 * integer, or undefined when absent/invalid. A present-but-invalid value emits a
 * warn so a typo isn't silently treated as "no keep criterion".
 * @param {unknown} raw
 * @param {Array} diags
 * @returns {number|undefined}
 */
function coerceKeep(raw, diags) {
  if (raw === undefined || raw === null) return undefined;
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isInteger(n) || n < 0) {
    diags.push({ severity: 'warn', code: 'gc-keep-invalid', phase: 'cli',
      message: `ignoring invalid --keep '${raw}'; expected a non-negative integer` });
    return undefined;
  }
  return n;
}

/**
 * Coerce the `--older-than` flag (a duration string like '30d') into milliseconds
 * via parseSince, or undefined when absent/invalid. A present-but-invalid value
 * emits a warn so a typo doesn't silently drop the criterion.
 * @param {unknown} raw
 * @param {Array} diags
 * @returns {number|undefined}
 */
function coerceOlderThan(raw, diags) {
  if (raw === undefined || raw === null) return undefined;
  const ms = parseSince(raw);
  if (ms === null) {
    diags.push({ severity: 'warn', code: 'gc-older-than-invalid', phase: 'cli',
      message: `ignoring invalid --older-than '${raw}'; expected e.g. '30d', '24h', '2w'` });
    return undefined;
  }
  return ms;
}
