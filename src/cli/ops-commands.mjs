/**
 * Audit and drift command handlers (P2.U11).
 *
 * Extracted from commands.mjs to keep that module under the 200-SLOC lint ceiling
 * (mirroring the settings-layers.mjs extraction done in P2.U8).
 *
 * Both handlers honour the never-throws and pure-result contract defined in
 * commands.mjs: they return `{ result, diagnostics }` and never call process.exit
 * or write to stdout. `analyzeDrift` is statically imported (pure). `probe-state.mjs`
 * is DYNAMICALLY imported inside `driftCommand` because it statically imports
 * `src/paths.mjs`, which top-level-awaits and rejects when `~/.claude/hooks/lib`
 * is absent (the M2 constraint).
 *
 * Zero npm dependencies. Node stdlib only.
 */

import { readAuditLog } from '../ops/audit.mjs';
import { analyzeDrift } from '../analysis/drift.mjs';

/** @typedef {import('./commands.mjs').CommandHandler} CommandHandler */

// ── audit ────────────────────────────────────────────────────────────────────────

/**
 * Read-only audit log viewer. Reads `.mgr-state/audit.log` (JSONL) and returns
 * the parsed entries, newest-first. A MISSING log is benign (0 entries, 0 diags).
 *
 * Flags:
 *   `args.since`  (optional string, e.g. '7d', '24h', '30m') filters to entries
 *                 newer than that window. An invalid value emits a warn and shows all.
 *
 * The audit-log WRITE side (P3.U20) is not implemented here. Until then the log is
 * always absent and this command returns an empty entries list.
 *
 * Never throws — readAuditLog is ops-pure and never-throws.
 * @type {CommandHandler}
 */
export function auditCommand(ctx) {
  const since = ctx.args && typeof ctx.args.since === 'string' ? ctx.args.since : undefined;
  const { entries, diagnostics, summary } = readAuditLog({ stateDir: ctx.mgrStateDir, since });
  return { result: { entries, summary }, diagnostics: diagnostics.slice() };
}

// ── drift ────────────────────────────────────────────────────────────────────────

/**
 * Config-surface drift detection. Gathers the current tracked state (a sha256
 * fingerprint of the governed config surface: CLAUDE.md, settings, skills, agents,
 * commands, hooks) and compares it to the persisted lockfile baseline.
 *
 * Read-only by default — DRY-RUN-BY-DEFAULT. With `--update` it RE-WRITES the
 * baseline lockfile into the REAL governed `.mgr-state` via `assertWritable`, so
 * using `--config-dir` to point at a fixture will emit a `lockfile-write-failed`
 * or `write-outside-target` warn (the write is correctly rejected) while status
 * reporting still works. The real write is validated by dogfooding, not fixtures.
 *
 * Flags:
 *   `args.update`  (optional boolean) re-writes the lockfile to lock in the current
 *                  state as the new drift baseline.
 *
 * `probe-state.mjs` is DYNAMICALLY imported (never statically) because it statically
 * imports `src/paths.mjs`, which top-level-awaits and rejects when
 * `~/.claude/hooks/lib` is absent (the M2 constraint). On import failure the command
 * degrades gracefully: `{status:'unavailable'}` + a `drift-unavailable` warn.
 *
 * Never throws — every code path is guarded or wrapped.
 * @type {CommandHandler}
 */
export async function driftCommand(ctx) {
  let probeState;
  try {
    probeState = await import('../discovery/probe-state.mjs');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err ?? '');
    return {
      result: { status: 'unavailable' },
      diagnostics: [{ severity: 'warn', code: 'drift-unavailable', message, phase: 'cli' }],
    };
  }

  const mgrStateDir = ctx.mgrStateDir ?? '';
  const { state, diagnostics: gatherDiags } = probeState.gatherTrackedState({ configDir: ctx.configDir });
  const { lockfile, diagnostics: readDiags } = probeState.readLockfile(mgrStateDir);
  const analysis = analyzeDrift({ current: state, previous: lockfile });
  const diagnostics = [...gatherDiags, ...readDiags, ...analysis.diagnostics];

  // DRY-RUN-BY-DEFAULT: only --update writes/refreshes the baseline lockfile.
  if (ctx.args && ctx.args.update) {
    const w = probeState.writeLockfile(mgrStateDir, state);
    for (const d of w.diagnostics) diagnostics.push(d);
    // Add one info noting the baseline was (re)written, unless a write error occurred.
    if (!w.diagnostics.some((d) => d.severity === 'error' || d.severity === 'warn')) {
      diagnostics.push({ severity: 'info', code: 'drift-baseline-updated', message: `drift baseline written to ${w.path}`, phase: 'cli' });
    }
  }

  return {
    result: { status: analysis.status, changes: analysis.changes, summary: analysis.summary },
    diagnostics,
  };
}
