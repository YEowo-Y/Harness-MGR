/**
 * CLI handler for `lock [--break-lock] [--apply]` (P3.U22).
 *
 * Surfaces the apply lock (src/ops/lock.mjs) from the command line:
 *   • bare `lock`         → READ-ONLY status (present / holder / holder-alive) via
 *                           inspectLock; writes nothing, no gate.
 *   • `lock --break-lock` → DESTRUCTIVE force-remove of the apply lock via breakLock,
 *                           behind the two-factor write gate (`resolveWriteIntent`:
 *                           `--apply` AND `CLAUDE_MGR_ENABLE_WRITES=1`). Breaking a
 *                           lock can let a second apply/rollback run concurrently, so
 *                           it is gated exactly like the other write commands; a live
 *                           holder additionally raises a `lock-broke-live-holder` warn.
 *
 * SYNC: every lock op (inspectLock / breakLock) is synchronous, so this handler is
 * synchronous too (it returns a plain `{result, diagnostics, code}`, no Promise).
 *
 * `deps` is the injectable test seam: a fake `inspectFn` / `breakFn` / `env` make
 * both paths hermetic without a real lock file.
 *
 * Never throws — inspectLock/breakLock are ops-pure/never-throws.
 *
 * DEFERRED SAFETY (P3.U20-dependent, intentionally NOT implemented here): an
 * interactive "are you sure?" confirmation and an audit-log entry recording a break
 * both depend on the audit-log WRITE side (P3.U20). This is the minimal force-remove
 * + live-holder warning; richer break safeguards land with the audit log.
 *
 * Spec: plan claude-mgr-v5.md, P3.U22 (wire the write commands into the CLI).
 *
 * Zero npm dependencies. Node stdlib only.
 */

import { inspectLock, breakLock } from '../ops/lock.mjs';
import { resolveWriteIntent } from './write-gate.mjs';

/** @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic */
/** @typedef {import('./commands.mjs').CommandContext} CommandContext */
/** @typedef {import('./commands.mjs').CommandOutput} CommandOutput */

/**
 * Drive the apply lock from the CLI. A bare `lock` reports status read-only; `--break
 * -lock` force-removes the lock behind the two-factor write gate.
 *
 * @param {CommandContext} ctx  { configDir, mgrStateDir, args } (args may be null-proto)
 * @param {{inspectFn?: typeof inspectLock, breakFn?: typeof breakLock, env?: Record<string, string|undefined>}} [deps]
 * @returns {CommandOutput & {code: number}}
 */
export function lockCommand(ctx, deps = {}) {
  // Default ctx defensively (review LOW): a literally-null ctx must NOT throw —
  // uphold the never-throws header + match the rollback/recover sibling handlers.
  const c = ctx && typeof ctx === 'object' ? ctx : {};
  const args = c.args && typeof c.args === 'object' ? c.args : {};
  const breakIt = !!args['break-lock'];

  // READ-ONLY status (the default): inspectLock writes nothing, needs no gate.
  if (!breakIt) {
    const s = (deps.inspectFn ?? inspectLock)({ stateDir: c.mgrStateDir });
    return {
      result: { present: s.present, holder: s.holder, holderAlive: s.alive },
      diagnostics: s.diagnostics.slice(),
      code: 0,
    };
  }

  // DESTRUCTIVE force-remove → two-factor gate (mirrors the other write commands).
  const env = deps.env ?? process.env;
  const intent = resolveWriteIntent({ apply: !!(args && args.apply), env });
  if (intent.refusal) {
    return { result: { status: 'refused' }, diagnostics: [intent.refusal], code: intent.code };
  }
  if (!intent.enableWrites) {
    return {
      result: { status: 'needs-apply' },
      diagnostics: [{
        severity: 'error', code: 'lock-break-needs-apply', phase: 'cli',
        message: 'lock --break-lock force-removes the apply lock; it needs --apply and CLAUDE_MGR_ENABLE_WRITES=1',
      }],
      code: 3,
    };
  }

  const b = (deps.breakFn ?? breakLock)({ stateDir: c.mgrStateDir });
  const diags = b.diagnostics.slice();
  if (b.holderAlive === true) {
    diags.push({
      severity: 'warn', code: 'lock-broke-live-holder', phase: 'cli',
      message: `broke a lock whose holder pid ${b.holder && b.holder.pid} appears STILL ALIVE — confirm no apply/rollback is running`,
    });
  }
  return {
    result: { broken: !!b.broken, holder: b.holder, holderAlive: b.holderAlive },
    diagnostics: diags,
    code: b.broken ? 0 : 1,
  };
}
