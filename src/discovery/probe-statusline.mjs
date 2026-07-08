/**
 * StatusLine passive probe gatherer (P2.U6b-2).
 *
 * Performs the read-only I/O behind one doctor check — keeping the doctor
 * itself pure (no I/O) by gathering facts here in the discovery layer:
 *
 *   #18 statusline-resolvable  — check that the statusLine.command target exists
 *                                on disk (file) or PATH (external command)
 *
 * The PURE classification (file vs external, var-expansion) is handled by
 * src/lib/hook-command.mjs; this probe does the actual filesystem/PATH
 * resolution using resolveCommand (statSync only, never spawns).
 *
 * The statusLineCommand string comes from the effective settings
 * (mergeSettings(...).effective.statusLine?.command). The caller is
 * responsible for extracting it before calling this probe.
 *
 * Never throws. Returns { statusline: null, diagnostics: [] } when no
 * statusLine is configured (benign — most users don't configure one).
 *
 * Zero npm dependencies. Node stdlib only.
 */

import { statSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import { resolveCommand } from '../lib/resolve-command.mjs';
import { classifyHookCommand } from '../lib/hook-command.mjs';

/**
 * @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic
 */

/**
 * @typedef {Object} StatuslineFact
 * @property {string} command  the raw statusLine command string from settings
 * @property {'file'|'external'} kind
 * @property {string} target   script path (file) or command name (external)
 * @property {'found'|'missing'|'indeterminate'} status
 */

/**
 * Determine the resolution status of a classified statusLine command.
 *
 * Returns 'indeterminate' when a variable (e.g. $CLAUDE_PROJECT_DIR) could not
 * be expanded at probe time — claiming 'missing' would be a false positive.
 * For 'file' kind, forces the path-like branch in resolveCommand by computing
 * an absolute path first (resolves bare filenames against cwd rather than PATH).
 * For 'external' kind, lets resolveCommand PATH-search the bare command name.
 *
 * @param {{ kind: 'file'|'external', target: string, fullyExpanded: boolean }} cls
 * @param {{ env?: object, platform?: string, cwd?: string }} opts
 * @returns {'found'|'missing'|'indeterminate'}
 */
function resolveStatus(cls, opts) {
  if (!cls.fullyExpanded) return 'indeterminate';

  if (cls.kind === 'file') {
    const baseCwd = typeof opts.cwd === 'string' ? opts.cwd : process.cwd();
    const abs = isAbsolute(cls.target) ? cls.target : resolve(baseCwd, cls.target);
    // #18 (like #3) checks that the target FILE EXISTS — a statusLine script run via
    // an interpreter (node hooks/statusline.mjs) is a data file that needs no execute
    // bit, so require EXISTENCE only. resolveCommand's P2-3 X_OK gate (correct for an
    // EXTERNAL executable) would false-flag a non-chmod-+x script as missing on POSIX.
    return existsAsFile(abs) ? 'found' : 'missing';
  }

  // 'external': bare command name, PATH-searched (X_OK-gated — must be launchable).
  const { resolved } = resolveCommand(cls.target, opts);
  return resolved ? 'found' : 'missing';
}

/** True when `p` is an existing regular file — EXISTENCE only, no execute-bit
 *  requirement (unlike resolveCommand's X_OK). Never throws. Mirrors the identical
 *  helper in probe-hooks.mjs (TODO: hoist the shared file/external resolveStatus into
 *  one module so the two probes cannot drift again — this is why #18 lagged the #3 fix). */
function existsAsFile(p) {
  try { return statSync(p).isFile(); } catch { return false; }
}

/**
 * Gather the passive statusLine probe fact for the doctor layer.
 *
 * @param {{ statusLineCommand?: unknown, env?: object, platform?: string, cwd?: string }} opts
 * @returns {{ statusline: StatuslineFact | null, diagnostics: Diagnostic[] }}
 */
export function gatherStatuslineProbe({ statusLineCommand, env, platform, cwd } = {}) {
  if (typeof statusLineCommand !== 'string' || statusLineCommand.length === 0) {
    return { statusline: null, diagnostics: [] };
  }

  const cls = classifyHookCommand(statusLineCommand, env);
  if (cls === null) return { statusline: null, diagnostics: [] };

  const status = resolveStatus(cls, { env, platform, cwd });

  return {
    statusline: { command: statusLineCommand, kind: cls.kind, target: cls.target, status },
    diagnostics: [],
  };
}
