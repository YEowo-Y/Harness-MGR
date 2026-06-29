/**
 * Snapshot pin command handlers (P3.U21) — `snapshot pin <id>` + `snapshot unpin <id>`.
 *
 * Pinning a snapshot writes a `.pin` marker (`<mgrStateDir>/snapshots/<id>/.pin`)
 * so `snapshot gc` force-retains it regardless of `--keep` / `--older-than`.
 * Unpinning removes that marker.
 *
 * Extracted into its own file (mirroring snapshot-store-command.mjs) so that module
 * stays under the 200-SLOC lint ceiling and the pin/unpin surface is grouped here.
 *
 * Both handlers honour the never-throws + pure-result contract from commands.mjs:
 * they return `{ result, diagnostics }` and never call process.exit / write stdout.
 *
 * SECURITY POSTURE — DRY-RUN BY DEFAULT + the two-factor write gate (P3.U22):
 *   • A bare `snapshot pin <id>` / `snapshot unpin <id>` PREVIEWS the action and
 *     writes NOTHING (mode 'dry-run'); paths.mjs is never loaded.
 *   • `--apply` enables the write (`resolveWriteIntent`); set `CLAUDE_MGR_ENABLE_WRITES=0`
 *     as an explicit opt-out lock. A closed gate REFUSES (code 3 +
 *     `writes-disabled-env`) before any write — and, for pin, before paths.mjs is
 *     loaded, so no marker is written.
 *
 * `pinSnapshot` is a CREATE → it REQUIRES the governed-write gate `assertWritable`
 * (fail-safe), which lives in paths.mjs. paths.mjs is imported DYNAMICALLY (via
 * `deps.loadPaths`) ONLY on the pin --apply path so that (a) it stays OUT of the
 * static graph that `selftest --invariants` enforces and (b) if its load ever fails
 * the command degrades instead of crashing — defence-in-depth. (Historically
 * paths.mjs -> reexport.mjs top-level-awaited and rejected when `~/.claude/hooks/lib`
 * was absent; the resolver is first-party now, so that specific reject is gone.) An
 * import failure degrades gracefully to a `snapshot-pin-unavailable` warn (mirrors
 * snapshotCommand).
 *
 * `unpinSnapshot` is a bounded DELETE → no gate, no paths.mjs (mirrors releaseLock /
 * gcSnapshots): the id is validated and the path RECONSTRUCTED, so the unlink is
 * bounded to `<mgrStateDir>/snapshots/<id>/.pin`.
 *
 * `deps` is the injectable test seam: a fake `loadPaths` / `pinFn` / `unpinFn` / `env`
 * make both paths unit-testable without a real gate or `.mgr-state`.
 *
 * Zero npm dependencies. Node stdlib only. Never throws.
 */

import { pinSnapshot, unpinSnapshot } from '../ops/snapshot-pin.mjs';
import { resolveWriteIntent } from './write-gate.mjs';

/** @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic */
/** @typedef {import('./commands.mjs').CommandContext} CommandContext */
/** @typedef {import('./commands.mjs').CommandOutput} CommandOutput */

/**
 * Read the `<id>` positional from ctx, or null when absent/empty. Defensive — a
 * null ctx / missing positionals yields null rather than throwing.
 * @param {CommandContext} ctx
 * @returns {string|null}
 */
function readId(ctx) {
  const positionals = ctx && ctx.args && ctx.args.positionals;
  const id = Array.isArray(positionals) ? positionals[0] : undefined;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

// ── snapshot pin ────────────────────────────────────────────────────────────────

/**
 * Pin a snapshot so `gc` retains it. DRY-RUN BY DEFAULT; the pin WRITE (a CREATE)
 * is behind the two-factor write gate and the dynamic paths.mjs import that keeps
 * this module's static graph paths.mjs-free (enforced by the boundary self-check).
 *
 * @param {CommandContext} ctx  { configDir, mgrStateDir, args } (args may be null-proto)
 * @param {{loadPaths?: () => Promise<{assertWritable: Function}>, pinFn?: typeof pinSnapshot, existsFn?: Function, env?: Record<string, string|undefined>}} [deps]
 * @returns {Promise<CommandOutput & {code?: number}>}
 */
export async function snapshotPinCommand(ctx, deps = {}) {
  const id = readId(ctx);
  if (id === null) {
    return {
      result: { mode: 'error' },
      diagnostics: [{ severity: 'error', code: 'snapshot-pin-id-missing', phase: 'cli',
        message: 'snapshot pin requires a snapshot id' }],
      code: 2,
    };
  }

  const apply = !!(ctx.args && ctx.args.apply);

  // DRY-RUN (default): never load paths.mjs, write nothing — just preview.
  if (!apply) {
    return {
      result: { mode: 'dry-run', id, wouldPin: true },
      diagnostics: [{ severity: 'info', code: 'snapshot-pin-dry-run', phase: 'cli',
        message: `would pin ${id} (re-run with --apply to persist)` }],
    };
  }

  // Two-factor gate: --apply is necessary but NOT sufficient. A closed gate REFUSES
  // here (code 3) — paths.mjs is never loaded and pinFn is never called.
  const intent = resolveWriteIntent({ apply: true, env: deps.env ?? process.env });
  if (intent.refusal) {
    return {
      result: { mode: 'applied', id, pinned: false },
      diagnostics: [intent.refusal],
      code: intent.code,
    };
  }

  let paths;
  try {
    paths = await (deps.loadPaths ?? (() => import('../paths.mjs')))();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err ?? '');
    return {
      result: { mode: 'applied', id, pinned: false },
      diagnostics: [{ severity: 'warn', code: 'snapshot-pin-unavailable',
        message: `the write gate is unloadable; snapshot pin --apply needs it: ${message}`, phase: 'cli' }],
    };
  }

  const pinFn = deps.pinFn ?? pinSnapshot;
  const r = pinFn({ mgrStateDir: ctx.mgrStateDir, snapshotId: id, assertWritable: paths.assertWritable });
  return { result: { mode: 'applied', id, pinned: !!r.pinned }, diagnostics: r.diagnostics.slice() };
}

// ── snapshot unpin ──────────────────────────────────────────────────────────────

/**
 * Unpin a snapshot (remove its `.pin` marker). DRY-RUN BY DEFAULT; the unpin WRITE
 * (a bounded DELETE) is behind the two-factor write gate. No paths.mjs — unpin is a
 * bounded delete (mirrors releaseLock / gcSnapshots).
 *
 * @param {CommandContext} ctx  { configDir, mgrStateDir, args } (args may be null-proto)
 * @param {{unpinFn?: typeof unpinSnapshot, env?: Record<string, string|undefined>}} [deps]
 * @returns {Promise<CommandOutput & {code?: number}>}
 */
export async function snapshotUnpinCommand(ctx, deps = {}) {
  const id = readId(ctx);
  if (id === null) {
    return {
      result: { mode: 'error' },
      diagnostics: [{ severity: 'error', code: 'snapshot-unpin-id-missing', phase: 'cli',
        message: 'snapshot unpin requires a snapshot id' }],
      code: 2,
    };
  }

  const apply = !!(ctx.args && ctx.args.apply);

  // DRY-RUN (default): write nothing — just preview.
  if (!apply) {
    return {
      result: { mode: 'dry-run', id, wouldUnpin: true },
      diagnostics: [{ severity: 'info', code: 'snapshot-unpin-dry-run', phase: 'cli',
        message: `would unpin ${id} (re-run with --apply to persist)` }],
    };
  }

  // Two-factor gate (same as pin). A bounded delete still passes governed-write
  // intent through the uniform gate so a fat-fingered --apply can't unpin silently.
  const intent = resolveWriteIntent({ apply: true, env: deps.env ?? process.env });
  if (intent.refusal) {
    return {
      result: { mode: 'applied', id, unpinned: false },
      diagnostics: [intent.refusal],
      code: intent.code,
    };
  }

  const unpinFn = deps.unpinFn ?? unpinSnapshot;
  const r = unpinFn({ mgrStateDir: ctx.mgrStateDir, snapshotId: id });
  return { result: { mode: 'applied', id, unpinned: !!r.unpinned }, diagnostics: r.diagnostics.slice() };
}
