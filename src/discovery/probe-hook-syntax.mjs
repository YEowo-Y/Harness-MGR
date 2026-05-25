/**
 * Hook-syntax active probe gatherer (P2.U7a).
 *
 * Performs the `node --check` I/O behind doctor check #4 (hook-node-syntax),
 * keeping the doctor itself pure (no I/O) by gathering facts here in the
 * discovery layer.
 *
 * CRITICAL INVARIANT: this probe NEVER executes hook command strings from
 * settings. It only runs `node --check <FILE_PATH>` on the script file path,
 * which parses the file for syntax errors but does NOT execute it.
 *
 * Consumes the passive hookFacts from gatherHookProbes so there is no second
 * filesystem walk. Only kind:'file', status:'found', Node.js-extension targets
 * are checked — missing files are #3's job; indeterminate targets are skipped
 * to avoid false positives.
 *
 * Never throws. Returns empty facts on bad/missing input. Zero npm dependencies.
 * Node stdlib only.
 */

import { resolve, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { safeSpawn } from '../lib/safe-spawn.mjs';

/**
 * @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic
 */

/**
 * @typedef {Object} HookSyntaxFact
 * @property {string} event    the hook event name
 * @property {string} path     absolute path of the script that was node-checked
 * @property {'ok'|'syntax-error'|'indeterminate'} status
 * @property {string} detail   a short detail string ('' when none)
 */

/**
 * Absolute-path positional pattern for the safeSpawn schema.
 * Matches an absolute path (drive-letter or leading slash/backslash) ending in
 * a Node.js extension. Defense-in-depth at the spawn gate: only valid node
 * script paths are accepted as positionals.
 */
const NODE_PATH_RE = /^(?:[A-Za-z]:[\\/]|[\\/]).+\.(?:mjs|cjs|js)$/i;

/**
 * Node.js-checkable extensions (lowercased for comparison).
 * @type {ReadonlySet<string>}
 */
const NODE_EXTS = new Set(['.mjs', '.cjs', '.js']);

/**
 * Returns true if the target looks like a Node.js script (by extension).
 * Extension comparison is case-insensitive.
 * @param {unknown} target
 * @returns {boolean}
 */
export function isNodeScript(target) {
  if (typeof target !== 'string' || target.length === 0) return false;
  const dot = target.lastIndexOf('.');
  if (dot < 0) return false;
  return NODE_EXTS.has(target.slice(dot).toLowerCase());
}

/**
 * Default runner — invokes `node --check <absPath>` via safeSpawn.
 * Tests inject `runNodeCheck` so they never spawn a real process.
 *
 * safeSpawn rejects when node exits non-zero; on non-zero exit, err.code is a
 * NUMBER and err.message includes the full stderr (containing the SyntaxError
 * line). When the validation itself fails (bad path, spawn failure), err.code
 * is a STRING.
 *
 * @param {string} absPath  absolute path to the Node.js script to check
 * @returns {Promise<{status:'ok'|'syntax-error'|'indeterminate', detail:string}>}
 */
async function defaultRunNodeCheck(absPath) {
  try {
    await safeSpawn({
      exe: process.execPath,
      args: ['--check', absPath],
      cwd: tmpdir(),
      allowedCwds: [tmpdir()],
      // allowSlashPositionals: on POSIX the script path is `/abs/...`; opt out of
      // the slash-flag gate so it is validated by NODE_PATH_RE (a positional),
      // not rejected as a flag. On Windows the path is `C:\...` so this is a no-op.
      schema: { allowedFlags: ['--check'], positionalPattern: NODE_PATH_RE, allowSlashPositionals: true, maxArgs: 2 },
      timeoutMs: 10000,
    });
    return { status: 'ok', detail: '' };
  } catch (err) {
    const code = err && typeof err === 'object' ? /** @type {any} */ (err).code : undefined;
    if (typeof code === 'number') {
      // A numeric exit code means node actually ran. Only a stderr that contains
      // a real SyntaxError is a syntax defect; any OTHER non-zero exit (e.g. the
      // file was deleted between the passive probe finding it and now →
      // "Cannot find module") is demoted to indeterminate rather than
      // mislabelling a vanished file as a syntax error (concurrent edits are in
      // scope for this tool — see the concurrent-sessions stance).
      const msg = err && typeof /** @type {any} */ (err).message === 'string'
        ? /** @type {any} */ (err).message : '';
      const m = msg.match(/SyntaxError:[^\r\n]*/);
      if (m) return { status: 'syntax-error', detail: m[0] };
      return { status: 'indeterminate', detail: 'node --check could not be run' };
    }
    // Validation failure or spawn error (code is a string, e.g. 'ENOENT') →
    // indeterminate (cannot determine syntax status without running the checker).
    return { status: 'indeterminate', detail: 'node --check could not be run' };
  }
}

/**
 * Gather node --check facts for the doctor active layer (#4).
 *
 * Consumes the passive hookFacts (from gatherHookProbes) so there is no second
 * tree-walk: only kind:'file', status:'found', node-script targets are checked.
 * Missing files are #3's job; indeterminate (unexpanded var) targets are skipped.
 *
 * @param {{ hookFacts?: object[], cwd?: string, runNodeCheck?: (absPath: string) => Promise<{status: string, detail: string}> }} [opts]
 * @returns {Promise<{ hookSyntax: HookSyntaxFact[], diagnostics: Diagnostic[] }>}
 */
export async function gatherHookSyntaxProbes(opts) {
  const { hookFacts, cwd, runNodeCheck = defaultRunNodeCheck } = opts ?? {};
  const facts = Array.isArray(hookFacts) ? hookFacts : [];
  const baseCwd = typeof cwd === 'string' && cwd.length > 0 ? cwd : process.cwd();

  /** @type {HookSyntaxFact[]} */
  const hookSyntax = [];

  for (const f of facts) {
    if (!f || typeof f !== 'object') continue;
    if (f.kind !== 'file' || f.status !== 'found') continue;
    if (typeof f.target !== 'string' || !isNodeScript(f.target)) continue;

    const abs = isAbsolute(f.target) ? f.target : resolve(baseCwd, f.target);

    let res;
    try {
      res = await runNodeCheck(abs);
    } catch {
      res = { status: 'indeterminate', detail: 'node --check could not be run' };
    }

    const status = res && (res.status === 'ok' || res.status === 'syntax-error' || res.status === 'indeterminate')
      ? res.status : 'indeterminate';
    const detail = res && typeof res.detail === 'string' ? res.detail : '';
    const event = typeof f.event === 'string' ? f.event : '';

    hookSyntax.push({ event, path: abs, status, detail });
  }

  return { hookSyntax, diagnostics: [] };
}
