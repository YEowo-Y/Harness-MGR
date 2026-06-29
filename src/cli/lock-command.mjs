/**
 * CLI handler for `lock [--break-lock] [--apply]` (P3.U22 + P4a.U2).
 *
 * Surfaces the apply lock (src/ops/lock.mjs) from the command line:
 *   • bare `lock`         → READ-ONLY status (present / holder / holder-alive) via
 *                           inspectLock; writes nothing, no gate.
 *   • `lock --break-lock` → dry-run: inspects the lock and reports an age-based
 *                           caution (live-holder WARN / dead-holder INFO / absent INFO)
 *                           then refuses with lock-break-needs-apply (exit 3).
 *   • `lock --break-lock --apply` + env → DESTRUCTIVE force-remove via breakLock
 *                           behind the two-factor write gate, followed by a BEST-EFFORT
 *                           audit-log entry. The break result is NEVER affected by audit
 *                           failures — a failing audit adds a lock-break-audit-unavailable
 *                           warn only.
 *
 * AGE-PROMPT: the dry-run branch computes ageSeconds from the holder's startTime vs
 * the injected `deps.now` clock so unit tests can drive a deterministic age without a
 * real lock file.
 *
 * AUDIT-ON-BREAK (P4a.U2): on a successful --apply break the handler appends a
 * metadata-only entry to audit.log via appendAuditEntry. assertWritable is resolved
 * with a DYNAMIC import of paths.mjs (M2-safe), so this handler is ASYNC on the
 * --apply path. The bare-status and dry-run paths remain synchronous (they return a
 * plain value; the cli.mjs await tolerates both).
 *
 * `deps` is the injectable test seam: inspectFn / breakFn / loadPaths / auditFn /
 * env / now allow every branch to be driven without real fs.
 *
 * Never throws — every failure path returns a diagnostic.
 *
 * Spec: plan harness-mgr-v5.md, P3.U22 (wire) + P4a.U2 (age-prompt + audit-on-break).
 *
 * Zero npm dependencies. Node stdlib only.
 */

import { inspectLock, breakLock } from '../ops/lock.mjs';
import { buildAuditEntry, appendAuditEntry } from '../ops/audit-writer.mjs';
import { resolveWriteIntent } from './write-gate.mjs';

/** @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic */
/** @typedef {import('./commands.mjs').CommandContext} CommandContext */
/** @typedef {import('./commands.mjs').CommandOutput} CommandOutput */

/**
 * Compute age in whole seconds from an ISO startTime string vs nowMs. Returns null
 * when startTime is absent, non-string, or does not parse to a finite number.
 * Always returns max(0, ...) — a future startTime degrades to 0 rather than negative.
 * @param {unknown} startTime  ISO string from the lock holder record
 * @param {number}  nowMs      current epoch milliseconds from the injected clock
 * @returns {number|null}
 */
function holderAgeSeconds(startTime, nowMs) {
  if (typeof startTime !== 'string' || startTime.length === 0) return null;
  const parsed = Date.parse(startTime);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.round((nowMs - parsed) / 1000));
}

/**
 * Build the age-prompt caution diagnostic for the dry-run --break-lock branch.
 * One diagnostic covering the three cases: live holder / dead holder / absent lock.
 * @param {{ present: boolean, holder: import('../ops/lock.mjs').LockHolder|null, alive: boolean|null }} s
 * @param {number} nowMs
 * @returns {Diagnostic}
 */
function buildCautionDiag(s, nowMs) {
  if (!s.present) {
    return { severity: 'info', code: 'lock-break-absent', phase: 'cli',
      message: 'no apply lock present; nothing to break' };
  }
  const pid = s.holder ? s.holder.pid : null;
  const st = s.holder ? s.holder.startTime : null;
  const age = s.holder ? holderAgeSeconds(s.holder.startTime, nowMs) : null;
  const agePart = age !== null ? ` (~${age}s ago)` : '';
  if (s.alive === true) {
    return { severity: 'warn', code: 'lock-break-live-holder-caution', phase: 'cli',
      message: `lock held by a LIVE pid ${pid} started ${st}${agePart}; ` +
        'breaking it may interrupt a running apply — proceed only if you are sure no apply/rollback is running' };
  }
  return { severity: 'info', code: 'lock-break-dead-holder', phase: 'cli',
    message: `lock holder pid ${pid} appears DEAD (started ${st}${agePart}); safe to break` };
}

/**
 * Drive the apply lock from the CLI. A bare `lock` reports status read-only;
 * `--break-lock` without the gate shows an age-prompt and exits 3; `--break-lock
 * --apply` (with env factor) force-removes and audits.
 *
 * @param {CommandContext} ctx  { configDir, mgrStateDir, args }
 * @param {{
 *   inspectFn?: typeof inspectLock,
 *   breakFn?:   typeof breakLock,
 *   loadPaths?: () => Promise<{assertWritable: Function}>,
 *   auditFn?:   typeof appendAuditEntry,
 *   env?:       Record<string, string|undefined>,
 *   now?:       () => number,
 * }} [deps]
 * @returns {CommandOutput & {code: number} | Promise<CommandOutput & {code: number}>}
 */
export async function lockCommand(ctx, deps = {}) {
  // Defensive defaults — a null/undefined ctx must NOT throw (review LOW; null-ctx test).
  const c = ctx && typeof ctx === 'object' ? ctx : {};
  const args = c.args && typeof c.args === 'object' ? c.args : {};
  const breakIt = !!args['break-lock'];

  // ── READ-ONLY status (the default) ─────────────────────────────────────────────
  // inspectLock writes nothing; no gate needed.
  if (!breakIt) {
    const s = (deps.inspectFn ?? inspectLock)({ stateDir: c.mgrStateDir });
    return {
      result: { present: s.present, holder: s.holder, holderAlive: s.alive },
      diagnostics: s.diagnostics.slice(),
      code: 0,
    };
  }

  // ── Two-factor gate ─────────────────────────────────────────────────────────────
  const env = deps.env ?? process.env;
  const intent = resolveWriteIntent({ apply: !!(args && args.apply), env });
  if (intent.refusal) {
    return { result: { status: 'refused' }, diagnostics: [intent.refusal], code: intent.code };
  }

  // ── DRY-RUN age-prompt ──────────────────────────────────────────────────────────
  // The gate is closed (--apply not given, or env not set). Inspect the lock and
  // emit a caution diagnostic so the user can make an informed decision, then refuse
  // with the canonical needs-apply error.
  if (!intent.enableWrites) {
    const nowFn = typeof deps.now === 'function' ? deps.now : () => Date.now();
    const nowMs = nowFn();
    const s = (deps.inspectFn ?? inspectLock)({ stateDir: c.mgrStateDir });
    const caution = buildCautionDiag({ present: s.present, holder: s.holder, alive: s.alive }, nowMs);
    const diags = [...s.diagnostics, caution];
    diags.push({ severity: 'error', code: 'lock-break-needs-apply', phase: 'cli',
      message: 'lock --break-lock force-removes the apply lock; it needs --apply' });
    return {
      result: { status: 'needs-apply', present: s.present, holder: s.holder,
        holderAlive: s.alive, ageSeconds: s.holder ? holderAgeSeconds(s.holder.startTime, nowMs) : null },
      diagnostics: diags,
      code: 3,
    };
  }

  // ── DESTRUCTIVE break ───────────────────────────────────────────────────────────
  const b = (deps.breakFn ?? breakLock)({ stateDir: c.mgrStateDir });
  const diags = b.diagnostics.slice();
  if (b.holderAlive === true) {
    diags.push({ severity: 'warn', code: 'lock-broke-live-holder', phase: 'cli',
      message: `broke a lock whose holder pid ${b.holder && b.holder.pid} appears STILL ALIVE — confirm no apply/rollback is running` });
  }

  // ── AUDIT-ON-BREAK (best-effort, P4a.U2) ───────────────────────────────────────
  // Only on a successful break. Any failure here MUST NOT flip the break result.
  if (b.broken) {
    try {
      const nowFn = typeof deps.now === 'function' ? deps.now : () => Date.now();
      const paths = await (deps.loadPaths ?? (() => import('../paths.mjs')))();
      const { assertWritable } = paths;
      const auditFn = deps.auditFn ?? appendAuditEntry;
      const entry = buildAuditEntry({ command: 'lock --break-lock', exitCode: 0,
        now: () => new Date(nowFn()) });
      const res = auditFn({ stateDir: c.mgrStateDir, entry, assertWritable });
      if (!res || res.written !== true) {
        const firstMsg = res && res.diagnostics && res.diagnostics[0] ? ': ' + res.diagnostics[0].message : '';
        diags.push({ severity: 'warn', code: 'lock-break-audit-unavailable', phase: 'cli',
          message: `audit entry for lock break could not be written${firstMsg}` });
      }
    } catch (err) {
      diags.push({ severity: 'warn', code: 'lock-break-audit-unavailable', phase: 'cli',
        message: `audit entry for lock break could not be written: ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  return {
    result: { broken: !!b.broken, holder: b.holder, holderAlive: b.holderAlive },
    diagnostics: diags,
    code: b.broken ? 0 : 1,
  };
}
