/**
 * Hook explanation builder (P5.U4) — the "understand at a glance" layer.
 *
 * Turns the merged `effective.hooks` shape (settings-merge hooks-concat:
 * `{ [event]: [{ matcher?, hooks: [{type:'command', command}] }] }`) plus the
 * OPTIONAL probe facts (discovery/probe-hooks HookFact[]) into ONE deterministic
 * English sentence per hook entry, e.g.:
 *
 *   'On PreToolUse (before a tool call runs), for tools matching "Bash",
 *    runs the script "C:/x/hook.mjs" (file, found).'
 *
 * LANGUAGE DECISION: explanation text is ENGLISH, consistent with every other
 * tool message (diagnostics, doctor fixes, the advice pack); the TUI/agent
 * layer owns translation.
 *
 * EVENT VOCABULARY grounded in https://code.claude.com/docs/en/hooks (fetched
 * 2026-06-10): matchers on the five tool-matcher events (PreToolUse /
 * PostToolUse / PostToolUseFailure / PermissionRequest / PermissionDenied)
 * match TOOL NAMES; an omitted/''/'*' matcher matches ALL occurrences; other
 * events' matchers match event-specific values (session source, agent type, …)
 * and several events take no matcher at all. An UNKNOWN event gets the generic
 * fallback phrase 'when this event fires' — never dropped.
 *
 * JOIN CONTRACT: hookFacts are joined by exact (event, command) string
 * equality — the matcher is NOT part of the key (HookFact drops it). The same
 * command appearing twice under one event therefore shares one status —
 * harmless, since the probe would resolve both identically (first fact wins on
 * a duplicate key). Facts for commands not present in the walked hooks are
 * ignored. An entry with no matching fact gets status 'unprobed'.
 *
 * PURE: no I/O, no fs, no paths.mjs, no network. The only import is the pure
 * parser classifyHookCommand (src/lib/hook-command.mjs — string in,
 * classification out). `env` defaults to {} (NOT process.env) so this module
 * stays deterministic; the CLI layer passes process.env explicitly.
 * Never throws on junk input; inputs are never mutated.
 */

import { classifyHookCommand } from '../lib/hook-command.mjs';

/**
 * @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic
 *
 * @typedef {Object} HookExplanation
 * @property {string} event          hook event name as configured
 * @property {string|null} matcher   the group's raw matcher string ('' kept as-is), null when absent
 * @property {string} command        the raw command string
 * @property {'file'|'external'|'opaque'} kind  'opaque' = classifyHookCommand returned null
 * @property {string} target         script path (file) / command name (external) / raw command (opaque)
 * @property {string} status         'found'|'missing'|'indeterminate'|'unprobed' (from the joined fact)
 * @property {string} explanation    one deterministic English sentence
 */

/**
 * Known hook event → short human phrase ("when it fires"). Grounded verbatim
 * in the official hooks docs event table (see module header). Unknown events
 * fall back to the generic phrase — they are never dropped.
 */
export const HOOK_EVENT_PHRASES = Object.freeze({
  SessionStart: 'when a session starts or resumes',
  Setup: 'when Claude Code runs setup (--init/--maintenance)',
  UserPromptSubmit: 'when a prompt is submitted, before Claude processes it',
  UserPromptExpansion: 'when a typed command expands into a prompt',
  PreToolUse: 'before a tool call runs',
  PermissionRequest: 'when a permission dialog appears',
  PermissionDenied: 'when a tool call is auto-denied',
  PostToolUse: 'after a tool call completes',
  PostToolUseFailure: 'after a tool call fails',
  PostToolBatch: 'after a batch of parallel tool calls resolves',
  Notification: 'when Claude Code sends a notification',
  MessageDisplay: 'while assistant message text is displayed',
  SubagentStart: 'when a subagent is spawned',
  SubagentStop: 'when a subagent finishes',
  TaskCreated: 'when a task is created',
  TaskCompleted: 'when a task is marked completed',
  Stop: 'when Claude finishes responding',
  StopFailure: 'when the turn ends due to an API error',
  TeammateIdle: 'when a team teammate is about to go idle',
  InstructionsLoaded: 'when a CLAUDE.md or rules file is loaded into context',
  ConfigChange: 'when a configuration file changes during a session',
  CwdChanged: 'when the working directory changes',
  FileChanged: 'when a watched file changes on disk',
  WorktreeCreate: 'when a worktree is being created',
  WorktreeRemove: 'when a worktree is being removed',
  PreCompact: 'before context compaction',
  PostCompact: 'after context compaction completes',
  Elicitation: 'when an MCP server requests user input',
  ElicitationResult: 'after a user responds to an MCP elicitation',
  SessionEnd: 'when a session ends',
});

/**
 * The five events whose matcher matches TOOL NAMES (docs: PreToolUse /
 * PostToolUse / PostToolUseFailure / PermissionRequest / PermissionDenied).
 */
const TOOL_MATCHER_EVENTS = new Set([
  'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'PermissionDenied',
]);

/** Status → human rendering (the 'missing' cause is kind-dependent, see statusText). */
const STATUS_TEXT = Object.freeze({
  found: 'found',
  indeterminate: 'indeterminate — contains unexpanded runtime variables',
  unprobed: 'unprobed — not resolved this run',
});

/** Guard against prototype-polluting own keys from parsed JSON. @param {string} k */
function isSafeKey(k) { return k !== '__proto__' && k !== 'constructor' && k !== 'prototype'; }

/** True for a non-null, non-array object. @param {unknown} v */
function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

/** Known-event phrase or the generic fallback. @param {string} event @returns {string} */
function eventPhrase(event) {
  return Object.prototype.hasOwnProperty.call(HOOK_EVENT_PHRASES, event)
    ? HOOK_EVENT_PHRASES[event]
    : 'when this event fires';
}

/**
 * Matcher clause (with trailing ', ' when non-empty). Docs semantics: omitted,
 * '' and '*' all mean "match all" — rendered 'for all tool calls, ' on the five
 * tool-matcher events and OMITTED otherwise (a non-tool event without a matcher
 * needs no qualifier). A real matcher renders 'for tools matching "<m>", ' on
 * tool-matcher events and 'matching "<m>", ' otherwise.
 *
 * @param {string} event @param {string|null} matcher @returns {string}
 */
function matcherClause(event, matcher) {
  const isTool = TOOL_MATCHER_EVENTS.has(event);
  const m = typeof matcher === 'string' ? matcher : '';
  if (m === '' || m === '*') return isTool ? 'for all tool calls, ' : '';
  return isTool ? `for tools matching "${m}", ` : `matching "${m}", `;
}

/**
 * Human status text. 'missing' carries a kind-specific short cause; an
 * unrecognised status string (junk fact) renders as itself — deterministic,
 * never throws.
 * @param {string} status @param {string} kind @returns {string}
 */
function statusText(status, kind) {
  if (status === 'missing') {
    return kind === 'file' ? 'missing — file not found' : 'missing — not found on PATH';
  }
  return Object.prototype.hasOwnProperty.call(STATUS_TEXT, status) ? STATUS_TEXT[status] : String(status);
}

/**
 * The one-sentence X/Y/Z explanation for one entry (spec pattern: 'On X (when),
 * for Y, runs Z (kind, status).'). Opaque entries say the command form could
 * not be parsed.
 * @param {HookExplanation} entry @returns {string}
 */
function buildExplanation(entry) {
  const head = `On ${entry.event} (${eventPhrase(entry.event)}), ${matcherClause(entry.event, entry.matcher)}`;
  const st = statusText(entry.status, entry.kind);
  if (entry.kind === 'opaque') {
    return `${head}runs the command "${entry.target}" (opaque — the command form could not be parsed, ${st}).`;
  }
  const action = entry.kind === 'file'
    ? `runs the script "${entry.target}"`
    : `runs the external command "${entry.target}"`;
  return `${head}${action} (${entry.kind}, ${st}).`;
}

/**
 * Index hookFacts by `${event}\n${command}` → status (\n separator: the same
 * grep-safe convention as conflicts' groupKey; neither part can contain a
 * newline that came from JSON without being visible there too). First fact
 * wins on a duplicate key. Junk facts (non-object, non-string fields) are
 * skipped. @param {unknown} hookFacts @returns {Map<string,string>}
 */
function buildFactMap(hookFacts) {
  const map = new Map();
  if (!Array.isArray(hookFacts)) return map;
  for (const f of hookFacts) {
    if (!isObj(f)) continue;
    if (typeof f.event !== 'string' || typeof f.command !== 'string') continue;
    if (typeof f.status !== 'string' || f.status.length === 0) continue;
    const key = `${f.event}\n${f.command}`;
    if (!map.has(key)) map.set(key, f.status);
  }
  return map;
}

/**
 * Build one explained entry: classify, join the fact status, render the sentence.
 * @param {string} event @param {string|null} matcher @param {string} command
 * @param {object} env @param {Map<string,string>} factMap
 * @returns {HookExplanation}
 */
function buildEntry(event, matcher, command, env, factMap) {
  const cls = classifyHookCommand(command, env);
  const kind = cls === null ? 'opaque' : cls.kind;
  const target = cls === null ? command : cls.target;
  const status = factMap.get(`${event}\n${command}`) ?? 'unprobed';
  const entry = { event, matcher, command, kind, target, status, explanation: '' };
  entry.explanation = buildExplanation(entry);
  return entry;
}

/**
 * Walk the merged hooks shape (the same walk as probe-hooks, PLUS the matcher
 * which HookFact drops) and collect explained entries. Junk-tolerant: a
 * non-object group, non-array group.hooks, non-command entry, or empty command
 * is silently skipped, exactly like the probe.
 * @param {unknown} hooks @param {object} env @param {Map<string,string>} factMap
 * @returns {HookExplanation[]}
 */
function collectEntries(hooks, env, factMap) {
  /** @type {HookExplanation[]} */
  const entries = [];
  if (!isObj(hooks)) return entries;
  for (const event of Object.keys(hooks)) {
    if (!isSafeKey(event)) continue;
    const groups = hooks[event];
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!isObj(group)) continue;
      const matcher = typeof group.matcher === 'string' ? group.matcher : null;
      const list = group.hooks;
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        if (!isObj(item) || item.type !== 'command') continue;
        if (typeof item.command !== 'string' || item.command.length === 0) continue;
        entries.push(buildEntry(event, matcher, item.command, env, factMap));
      }
    }
  }
  return entries;
}

/** Deterministic entry order: (event, matcher ?? '', command), plain string <. */
function cmpEntries(a, b) {
  if (a.event !== b.event) return a.event < b.event ? -1 : 1;
  const am = a.matcher ?? '';
  const bm = b.matcher ?? '';
  if (am !== bm) return am < bm ? -1 : 1;
  if (a.command !== b.command) return a.command < b.command ? -1 : 1;
  return 0;
}

/** Fresh zeroed summary. */
function emptySummary() {
  return { total: 0, missing: 0, indeterminate: 0, byKind: { file: 0, external: 0, opaque: 0 } };
}

/**
 * Explain every configured hook in human English.
 *
 * @param {{ hooks?: unknown, hookFacts?: unknown, env?: object }} [opts]
 *   hooks      — merged effective.hooks (settings-merge shape); junk → no entries
 *   hookFacts  — optional probe-hooks HookFact[] supplying found/missing/
 *                indeterminate statuses (see JOIN CONTRACT in the header)
 *   env        — env map for variable expansion during classification;
 *                defaults to {} for determinism (CLI passes process.env)
 * @returns {{ entries: HookExplanation[], summary: {total:number, missing:number, indeterminate:number, byKind:{file:number, external:number, opaque:number}}, diagnostics: Diagnostic[] }}
 */
export function explainHooks(opts) {
  try {
    const o = isObj(opts) ? opts : {};
    const env = isObj(o.env) ? o.env : {};
    const factMap = buildFactMap(o.hookFacts);
    const entries = collectEntries(o.hooks, env, factMap).sort(cmpEntries);
    const summary = emptySummary();
    summary.total = entries.length;
    for (const e of entries) {
      if (e.status === 'missing') summary.missing += 1;
      if (e.status === 'indeterminate') summary.indeterminate += 1;
      if (Object.prototype.hasOwnProperty.call(summary.byKind, e.kind)) summary.byKind[e.kind] += 1;
    }
    return { entries, summary, diagnostics: [] };
  } catch {
    // never-throws backstop — junk input degrades to an honest empty result.
    return { entries: [], summary: emptySummary(), diagnostics: [] };
  }
}
