/**
 * Hook passive probe gatherer (P2.U5b-2).
 *
 * Performs the read-only I/O behind two doctor checks — keeping the doctor
 * itself pure (no I/O) by gathering facts here in the discovery layer:
 *
 *   #3 hook-file-exists       — for each hook that references a script file,
 *                               check whether the file exists on disk.
 *
 *   #5 hook-external-command  — for each hook that calls a bare external
 *                               command, check whether it resolves on PATH.
 *
 * The PURE classification (file vs external, var-expansion) is handled by
 * src/lib/hook-command.mjs; this probe does the actual filesystem/PATH
 * resolution using resolveCommand (statSync only, never spawns).
 *
 * The hooks object comes from mergeSettings(...).effective.hooks — the caller
 * is responsible for merging settings before calling this probe.
 *
 * Never throws. Returns empty facts on bad/missing input (benign — no hooks
 * configured is a valid config). diagnostics[] is always [] (probe-level I/O
 * errors cannot occur here; resolution failures surface as status:'missing').
 *
 * Zero npm dependencies. Node stdlib only.
 */

import { resolve, isAbsolute } from 'node:path';
import { isJsonObject } from './read-json.mjs';
import { resolveCommand } from '../lib/resolve-command.mjs';
import { classifyHookCommand } from '../lib/hook-command.mjs';

/**
 * @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic
 */

/**
 * @typedef {Object} HookFact
 * @property {string} event    hook event name (e.g. 'PreToolUse')
 * @property {string} command  the raw command string
 * @property {'file'|'external'} kind
 * @property {string} target   resolved target: script path (file) or command name (external)
 * @property {'found'|'missing'|'indeterminate'} status
 */

/**
 * Guard against prototype-polluting keys that JSON.parse can produce as own
 * enumerable keys when the JSON literally contains "__proto__".
 * @param {string} key
 * @returns {boolean}
 */
function isSafeKey(key) {
  return key !== '__proto__' && key !== 'constructor' && key !== 'prototype';
}

/**
 * Determine the resolution status of a classified hook command.
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
    const { resolved } = resolveCommand(abs, opts);
    return resolved ? 'found' : 'missing';
  }

  // 'external': bare command name, PATH-searched
  const { resolved } = resolveCommand(cls.target, opts);
  return resolved ? 'found' : 'missing';
}

/**
 * Gather passive hook probe facts for the doctor layer.
 *
 * Walks effective.hooks (event → matcher-groups → hook entries) and resolves
 * each command-type entry into a HookFact. Non-command entries, eval-inline
 * commands, and unclassifiable commands are silently skipped.
 *
 * @param {{ hooks?: object, env?: object, platform?: string, cwd?: string }} opts
 * @returns {{ hookFacts: HookFact[], diagnostics: Diagnostic[] }}
 */
export function gatherHookProbes(opts) {
  const { hooks, env, platform, cwd } = opts ?? {};

  if (!isJsonObject(hooks)) return { hookFacts: [], diagnostics: [] };

  /** @type {HookFact[]} */
  const hookFacts = [];
  const resolveOpts = { env, platform, cwd };

  for (const event of Object.keys(hooks)) {
    if (!isSafeKey(event)) continue;

    const groups = hooks[event];
    if (!Array.isArray(groups)) continue;

    for (const group of groups) {
      if (!isJsonObject(group)) continue;
      const entries = group.hooks;
      if (!Array.isArray(entries)) continue;

      for (const entry of entries) {
        if (!isJsonObject(entry)) continue;
        if (entry.type !== 'command') continue;
        const command = entry.command;
        if (typeof command !== 'string' || command.length === 0) continue;

        const cls = classifyHookCommand(command, env);
        if (cls === null) continue;

        const status = resolveStatus(cls, resolveOpts);
        hookFacts.push({ event, command, kind: cls.kind, target: cls.target, status });
      }
    }
  }

  return { hookFacts, diagnostics: [] };
}
