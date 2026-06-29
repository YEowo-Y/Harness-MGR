/**
 * Shell tab-completion (P4b.U9) — `completion bash|powershell` emits a static
 * completion script with the command/sub-verb/flag word lists baked in.
 *
 * PURE, READ-ONLY, gate-safe: NO write gate, NO paths.mjs, NO snapshot, NO
 * governed writes — everything here is string building.
 *
 * M2-SAFE + cycle-free: this module imports ONLY './flags.mjs' (a pure leaf) and
 * node stdlib. It deliberately does NOT import './commands.mjs' — that would make
 * a commands↔completion cycle. Instead the canonical command keys are passed IN
 * via the `deps.commandKeys` seam at call time (commands.mjs passes
 * `Object.keys(COMMANDS)` from inside the registry, by which point COMMANDS is
 * fully built).
 *
 * Zero npm dependencies. Node stdlib only. Never throws.
 */

import { VALUE_FLAGS, BOOLEAN_FLAGS } from './flags.mjs';

/**
 * @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic
 */

/**
 * @typedef {Object} CompletionModel
 * @property {string[]} commands       unique sorted top-level command names
 * @property {Record<string,string[]>} subcommands  top → sorted sub-verbs (only tops with sub-verbs)
 * @property {string[]} flags          unique sorted [...valueFlags, ...booleanFlags]
 * @property {string[]} shells         the valid args to `completion` itself
 */

/** Proto-pollution guard for object keys used as map indices. */
const UNSAFE_KEYS = Object.freeze(['__proto__', 'constructor', 'prototype']);

/** @param {unknown} k @returns {boolean} */
function isSafeKey(k) {
  return typeof k === 'string' && !UNSAFE_KEYS.includes(k);
}

/** Coerce to an array of non-empty strings. @param {unknown} v @returns {string[]} */
function toStringList(v) {
  if (!Array.isArray(v)) return [];
  return v.filter((x) => typeof x === 'string' && x.length > 0);
}

/** Unique + sorted (ascending) copy. @param {string[]} list @returns {string[]} */
function uniqueSorted(list) {
  return [...new Set(list)].sort();
}

/**
 * Build the completion model from the command vocabulary + flag lists. PURE and
 * never-throws — non-array inputs coerce to []. A canonical key splits on ':' into
 * a top-level command (segment 0) and an optional sub-verb (segment 1). A top with
 * a sub-verb appears BOTH in `commands` (it may be runnable bare, e.g. `snapshot`)
 * AND in `subcommands`. Everything is deduped + sorted for deterministic output.
 *
 * @param {string[]} commandKeys   canonical COMMANDS keys (e.g. 'snapshot:list')
 * @param {string[]} [valueFlags]  defaults to the imported VALUE_FLAGS
 * @param {string[]} [booleanFlags] defaults to the imported BOOLEAN_FLAGS
 * @returns {CompletionModel}
 */
export function buildCompletionModel(commandKeys, valueFlags = VALUE_FLAGS, booleanFlags = BOOLEAN_FLAGS) {
  const keys = toStringList(commandKeys);
  const tops = [];
  /** @type {Record<string, string[]>} */
  const subs = Object.create(null);

  for (const key of keys) {
    const seg = key.split(':');
    const top = seg[0];
    if (!isSafeKey(top) || top.length === 0) continue;
    tops.push(top);
    const verb = seg[1];
    if (typeof verb === 'string' && verb.length > 0) {
      if (!Array.isArray(subs[top])) subs[top] = [];
      subs[top].push(verb);
    }
  }

  /** @type {Record<string, string[]>} */
  const subcommands = Object.create(null);
  for (const top of Object.keys(subs)) subcommands[top] = uniqueSorted(subs[top]);

  return {
    commands: uniqueSorted(tops),
    subcommands,
    flags: uniqueSorted([...toStringList(valueFlags), ...toStringList(booleanFlags)]),
    shells: ['bash', 'powershell'],
  };
}

/**
 * Coerce an arbitrary value to a well-formed (possibly empty) model so the render
 * functions never throw on junk input.
 * @param {unknown} model
 * @returns {CompletionModel}
 */
function coerceModel(model) {
  const m = model && typeof model === 'object' ? model : {};
  const subcommands = Object.create(null);
  const rawSubs = m.subcommands && typeof m.subcommands === 'object' ? m.subcommands : {};
  for (const top of Object.keys(rawSubs)) {
    if (isSafeKey(top)) subcommands[top] = toStringList(rawSubs[top]);
  }
  return {
    commands: toStringList(m.commands),
    subcommands,
    flags: toStringList(m.flags),
    shells: Array.isArray(m.shells) && m.shells.length ? toStringList(m.shells) : ['bash', 'powershell'],
  };
}

/**
 * Render the bash completion script (a string). The per-command sub-verb `case`
 * arms are GENERATED from `model.subcommands` so a future command change regenerates
 * them; the `completion) … shells` arm comes from `model.shells`.
 * PURE, never-throws.
 * @param {CompletionModel} model
 * @returns {string}
 */
export function renderBashCompletion(model) {
  const m = coerceModel(model);
  const commands = m.commands.join(' ');
  const flags = m.flags.join(' ');
  const subArms = Object.keys(m.subcommands).sort()
    .map((top) => `      ${top}) if [[ $COMP_CWORD -eq 2 ]]; then COMPREPLY=( $(compgen -W "${m.subcommands[top].join(' ')}" -- "$cur") ); return; fi ;;`);
  subArms.push(`      completion) if [[ $COMP_CWORD -eq 2 ]]; then COMPREPLY=( $(compgen -W "${m.shells.join(' ')}" -- "$cur") ); return; fi ;;`);

  return `# harness-mgr bash completion (generated by \`harness-mgr completion bash\`).
# Install (one-time): source <(harness-mgr completion bash)
# or append the output to ~/.bashrc.
_harness_mgr_complete() {
  local cur="\${COMP_WORDS[COMP_CWORD]}"
  local cmd="\${COMP_WORDS[1]}"
  local commands="${commands}"
  local flags="${flags}"
  # A --flag prefix always completes to flags (checked FIRST, so it wins even at a
  # sub-verb position — keeps bash in parity with the PowerShell completer).
  if [[ "$cur" == -* ]]; then COMPREPLY=( $(compgen -W "$flags" -- "$cur") ); return; fi
  if [[ $COMP_CWORD -ge 2 ]]; then
    case "$cmd" in
${subArms.join('\n')}
    esac
  fi
  if [[ $COMP_CWORD -eq 1 ]]; then COMPREPLY=( $(compgen -W "$commands" -- "$cur") ); return; fi
  COMPREPLY=( $(compgen -W "$flags" -- "$cur") )
}
complete -F _harness_mgr_complete harness-mgr
`;
}

/** Quote a word for a PowerShell single-quoted string array element. @param {string} w */
function pwshQuote(w) {
  return `'${String(w).replace(/'/g, "''")}'`;
}

/** Render an @('a','b') PowerShell array literal. @param {string[]} list */
function pwshArray(list) {
  return `@(${list.map(pwshQuote).join(',')})`;
}

/**
 * Render the PowerShell completion script (a string). The `switch` arms are
 * GENERATED from `model.subcommands`; the literal `'completion'` arm is appended
 * once from `model.shells`. PURE, never-throws.
 * @param {CompletionModel} model
 * @returns {string}
 */
export function renderPwshCompletion(model) {
  const m = coerceModel(model);
  const switchArms = Object.keys(m.subcommands).sort()
    .map((top) => `      ${pwshQuote(top)} { $cands = ${pwshArray(m.subcommands[top])} }`);
  switchArms.push(`      'completion' { $cands = ${pwshArray(m.shells)} }`);

  return `# harness-mgr PowerShell completion (generated by \`harness-mgr completion powershell\`).
# Install (one-time): harness-mgr completion powershell | Out-String | Invoke-Expression
# or append the output to $PROFILE.
Register-ArgumentCompleter -Native -CommandName 'harness-mgr','harness-mgr.ps1' -ScriptBlock {
  param($wordToComplete, $commandAst, $cursorPosition)
  $commands = ${pwshArray(m.commands)}
  $flags = ${pwshArray(m.flags)}
  $els = @($commandAst.CommandElements | ForEach-Object { $_.ToString() })
  $cmd = if ($els.Count -ge 2) { $els[1] } else { '' }
  $idx = if ($wordToComplete) { $els.Count - 1 } else { $els.Count }
  $cands = @()
  if ($wordToComplete -like '-*') { $cands = $flags }
  elseif ($idx -le 1) { $cands = $commands }
  elseif ($idx -eq 2) {
    switch ($cmd) {
${switchArms.join('\n')}
      default { $cands = $flags }
    }
  }
  else { $cands = $flags }
  $cands | Where-Object { $_ -like "$wordToComplete*" } | Sort-Object | ForEach-Object {
    [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
  }
}
`;
}

/**
 * The `completion` CLI handler. Emits a shell completion script for the requested
 * shell (read from `ctx.args.positionals[0]`). On SUCCESS it emits ZERO diagnostics
 * (the script is meant to be sourced — any diagnostic would corrupt it as a footer
 * line). Never throws (the body is wrapped → a `completion-error` diagnostic + code 1).
 *
 * @param {{ args?: { positionals?: string[] } }} ctx
 * @param {{ commandKeys?: string[], valueFlags?: string[], booleanFlags?: string[] }} [deps]
 *   `commandKeys` is the command vocabulary (commands.mjs passes Object.keys(COMMANDS));
 *   absent/empty falls back to [] (the model still builds, just sparse). `valueFlags`/
 *   `booleanFlags` default to the imported VALUE_FLAGS/BOOLEAN_FLAGS.
 * @returns {{ result: Object, diagnostics: Diagnostic[], code: number }}
 */
export function completionCommand(ctx, deps = {}) {
  try {
    const commandKeys = Array.isArray(deps.commandKeys) ? deps.commandKeys : [];
    const valueFlags = Array.isArray(deps.valueFlags) ? deps.valueFlags : VALUE_FLAGS;
    const booleanFlags = Array.isArray(deps.booleanFlags) ? deps.booleanFlags : BOOLEAN_FLAGS;
    const model = buildCompletionModel(commandKeys, valueFlags, booleanFlags);

    const args = (ctx && ctx.args) || {};
    const shell = args.positionals && args.positionals[0];

    if (shell === 'bash') {
      return { result: { shell: 'bash', script: renderBashCompletion(model) }, diagnostics: [], code: 0 };
    }
    if (shell === 'powershell' || shell === 'pwsh' || shell === 'ps') {
      return { result: { shell: 'powershell', script: renderPwshCompletion(model) }, diagnostics: [], code: 0 };
    }
    return {
      result: { status: 'no-shell', shells: model.shells },
      diagnostics: [{
        severity: 'error', code: 'completion-no-shell', phase: 'cli',
        message: 'completion requires a shell: completion bash|powershell',
      }],
      code: 2,
    };
  } catch (err) {
    return {
      result: { status: 'error' },
      diagnostics: [{
        severity: 'error', code: 'completion-error', phase: 'cli',
        message: err instanceof Error ? err.message : String(err),
      }],
      code: 1,
    };
  }
}
