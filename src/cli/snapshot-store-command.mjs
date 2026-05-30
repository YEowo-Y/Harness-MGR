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
import { parseSince } from '../ops/audit.mjs';

/** @typedef {import('./commands.mjs').CommandHandler} CommandHandler */

// ── snapshot list ──────────────────────────────────────────────────────────────

/**
 * Read-only snapshot listing. Surfaces every snapshot under `.mgr-state/snapshots/`
 * newest-first: each as `{ id, createdAt, reason, fileCount, complete }`. An
 * incomplete dir (no/invalid manifest) is listed with `complete:false`. A missing
 * snapshots dir is benign (empty list). Never throws.
 *
 * `seams` is an injectable test seam: a fake `listFn` lets the command be unit-
 * tested without a real `.mgr-state` on disk.
 *
 * @param {import('./commands.mjs').CommandContext} ctx
 * @param {{ listFn?: typeof listSnapshots }} [seams]
 * @returns {import('./commands.mjs').CommandOutput}
 */
export function snapshotListCommand(ctx, seams = {}) {
  const listFn = seams.listFn ?? listSnapshots;
  const { snapshots, diagnostics } = listFn({ mgrStateDir: ctx && ctx.mgrStateDir });
  return {
    result: { snapshots, count: Array.isArray(snapshots) ? snapshots.length : 0 },
    diagnostics: diagnostics.slice(),
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
 *
 * `seams` is an injectable test seam: a fake `gcFn` makes dry-run-vs-apply and the
 * flag plumbing unit-testable without touching the filesystem. Never throws.
 *
 * @param {import('./commands.mjs').CommandContext} ctx
 * @param {{ gcFn?: typeof gcSnapshots }} [seams]
 * @returns {import('./commands.mjs').CommandOutput}
 */
export function snapshotGcCommand(ctx, seams = {}) {
  const gcFn = seams.gcFn ?? gcSnapshots;
  const args = (ctx && ctx.args) || {};
  const apply = !!args.apply;

  /** @type {{severity:string,code:string,message:string,phase:string}[]} */
  const preDiags = [];
  const keep = coerceKeep(args.keep, preDiags);
  const olderThanMs = coerceOlderThan(args['older-than'], preDiags);

  const gc = gcFn({ mgrStateDir: ctx && ctx.mgrStateDir, keep, olderThanMs, apply });

  return {
    result: {
      mode: apply ? 'applied' : 'dry-run',
      deleted: Array.isArray(gc.deleted) ? gc.deleted : [],
      wouldDelete: Array.isArray(gc.wouldDelete) ? gc.wouldDelete : [],
      retained: Array.isArray(gc.retained) ? gc.retained : [],
      deletedCount: Array.isArray(gc.deleted) ? gc.deleted.length : 0,
      wouldDeleteCount: Array.isArray(gc.wouldDelete) ? gc.wouldDelete.length : 0,
      retainedCount: Array.isArray(gc.retained) ? gc.retained.length : 0,
    },
    diagnostics: [...preDiags, ...gc.diagnostics],
  };
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
