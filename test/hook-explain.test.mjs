/**
 * hook-explain.test.mjs (P5.U4) — oracles for src/analysis/hook-explain.mjs.
 *
 * HEADLINE (DoD acceptance): a LITERAL golden — a fixed synthetic hooks set
 * (6 events incl. one unknown × matcher variants 'Bash'/'WebFetch'/'*'/absent
 * × kinds file/external/opaque × statuses found/missing/indeterminate/unprobed
 * via injected hookFacts) deepEquals the ENTIRE { entries, summary } against a
 * hand-written literal with FIXED explanation STRINGS. If any sentence, field,
 * sort order, or summary count drifts, this goes red.
 *
 * Plus: matcher-variant legs, opaque classification, the (event, command)
 * join contract, unknown-fact tolerance, determinism, frozen input, env
 * passthrough, and a never-throws junk battery.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { explainHooks, HOOK_EVENT_PHRASES } from '../src/analysis/hook-explain.mjs';

// ── golden fixture ────────────────────────────────────────────────────────────

const GOLDEN_HOOKS = {
  PreToolUse: [
    { matcher: 'Bash', hooks: [{ type: 'command', command: 'node /abs/hooks/pre.mjs' }] },
    { matcher: '*', hooks: [{ type: 'command', command: 'guard-tool check' }] },
  ],
  PostToolUse: [
    { hooks: [{ type: 'command', command: 'node $CLAUDE_PROJECT_DIR/post.mjs' }] },
  ],
  // PermissionRequest is one of the five tool-matcher events (docs) — its
  // tool-name matcher must render the tool-aware 'for tools matching "<m>"'.
  PermissionRequest: [
    { matcher: 'WebFetch', hooks: [{ type: 'command', command: 'perm-tool check' }] },
  ],
  SessionStart: [
    { matcher: 'startup', hooks: [{ type: 'command', command: 'any-buddy apply --silent' }] },
  ],
  Stop: [
    { hooks: [{ type: 'command', command: 'node -e "console.log(1)"' }] },
  ],
  MyCustomEvent: [
    { hooks: [{ type: 'command', command: 'custom-tool run' }] },
  ],
};

const GOLDEN_FACTS = [
  { event: 'PreToolUse', command: 'node /abs/hooks/pre.mjs', kind: 'file', target: '/abs/hooks/pre.mjs', status: 'found' },
  { event: 'PreToolUse', command: 'guard-tool check', kind: 'external', target: 'guard-tool', status: 'missing' },
  { event: 'PostToolUse', command: 'node $CLAUDE_PROJECT_DIR/post.mjs', kind: 'file', target: '$CLAUDE_PROJECT_DIR/post.mjs', status: 'indeterminate' },
  { event: 'SessionStart', command: 'any-buddy apply --silent', kind: 'external', target: 'any-buddy', status: 'missing' },
  // deliberately NO fact for Stop (the probe skips null classifications) and
  // NO fact for MyCustomEvent → both must read 'unprobed'.
];

// Hand-written literal — the acceptance criterion ("fixed hook set → fixed
// explanation text"). Entries sorted (event, matcher ?? '', command).
const GOLDEN_EXPECTED = {
  entries: [
    {
      event: 'MyCustomEvent', matcher: null, command: 'custom-tool run',
      kind: 'external', target: 'custom-tool', status: 'unprobed',
      explanation: 'On MyCustomEvent (when this event fires), runs the external command "custom-tool" (external, unprobed — not resolved this run).',
    },
    {
      event: 'PermissionRequest', matcher: 'WebFetch', command: 'perm-tool check',
      kind: 'external', target: 'perm-tool', status: 'unprobed',
      explanation: 'On PermissionRequest (when a permission dialog appears), for tools matching "WebFetch", runs the external command "perm-tool" (external, unprobed — not resolved this run).',
    },
    {
      event: 'PostToolUse', matcher: null, command: 'node $CLAUDE_PROJECT_DIR/post.mjs',
      kind: 'file', target: '$CLAUDE_PROJECT_DIR/post.mjs', status: 'indeterminate',
      explanation: 'On PostToolUse (after a tool call completes), for all tool calls, runs the script "$CLAUDE_PROJECT_DIR/post.mjs" (file, indeterminate — contains unexpanded runtime variables).',
    },
    {
      event: 'PreToolUse', matcher: '*', command: 'guard-tool check',
      kind: 'external', target: 'guard-tool', status: 'missing',
      explanation: 'On PreToolUse (before a tool call runs), for all tool calls, runs the external command "guard-tool" (external, missing — not found on PATH).',
    },
    {
      event: 'PreToolUse', matcher: 'Bash', command: 'node /abs/hooks/pre.mjs',
      kind: 'file', target: '/abs/hooks/pre.mjs', status: 'found',
      explanation: 'On PreToolUse (before a tool call runs), for tools matching "Bash", runs the script "/abs/hooks/pre.mjs" (file, found).',
    },
    {
      event: 'SessionStart', matcher: 'startup', command: 'any-buddy apply --silent',
      kind: 'external', target: 'any-buddy', status: 'missing',
      explanation: 'On SessionStart (when a session starts or resumes), matching "startup", runs the external command "any-buddy" (external, missing — not found on PATH).',
    },
    {
      event: 'Stop', matcher: null, command: 'node -e "console.log(1)"',
      kind: 'opaque', target: 'node -e "console.log(1)"', status: 'unprobed',
      explanation: 'On Stop (when Claude finishes responding), runs the command "node -e "console.log(1)"" (opaque — the command form could not be parsed, unprobed — not resolved this run).',
    },
  ],
  summary: { total: 7, missing: 2, indeterminate: 1, byKind: { file: 2, external: 4, opaque: 1 } },
};

// ── 1. THE GOLDEN ─────────────────────────────────────────────────────────────

test('GOLDEN: fixed hook set + facts → the exact literal entries + summary', () => {
  const out = explainHooks({ hooks: GOLDEN_HOOKS, hookFacts: GOLDEN_FACTS, env: {} });
  assert.deepEqual({ entries: out.entries, summary: out.summary }, GOLDEN_EXPECTED);
  assert.deepEqual(out.diagnostics, []);
});

test('determinism: two identical calls produce deepEqual output', () => {
  const a = explainHooks({ hooks: GOLDEN_HOOKS, hookFacts: GOLDEN_FACTS, env: {} });
  const b = explainHooks({ hooks: GOLDEN_HOOKS, hookFacts: GOLDEN_FACTS, env: {} });
  assert.deepEqual(a, b);
});

test('frozen input: deep-frozen hooks + facts are read-only safe (no throw, same golden)', () => {
  const hooks = structuredClone(GOLDEN_HOOKS);
  const facts = structuredClone(GOLDEN_FACTS);
  deepFreeze(hooks);
  deepFreeze(facts);
  const out = explainHooks({ hooks, hookFacts: facts, env: Object.freeze({}) });
  assert.deepEqual({ entries: out.entries, summary: out.summary }, GOLDEN_EXPECTED);
});

function deepFreeze(v) {
  if (v !== null && typeof v === 'object') {
    for (const k of Object.keys(v)) deepFreeze(v[k]);
    Object.freeze(v);
  }
  return v;
}

// ── 2. matcher variants ───────────────────────────────────────────────────────

test('matcher \'\' on a ToolUse event renders "for all tool calls" (docs: \'\' matches all)', () => {
  const out = explainHooks({
    hooks: { PreToolUse: [{ matcher: '', hooks: [{ type: 'command', command: 'tool-a run' }] }] },
    env: {},
  });
  assert.equal(out.entries.length, 1);
  assert.equal(out.entries[0].matcher, '');
  assert.match(out.entries[0].explanation, /for all tool calls, runs the external command "tool-a"/);
});

test('matcher \'*\' on PostToolUseFailure (a tool-matcher event) renders "for all tool calls"', () => {
  const out = explainHooks({
    hooks: { PostToolUseFailure: [{ matcher: '*', hooks: [{ type: 'command', command: 'tool-d run' }] }] },
    env: {},
  });
  assert.equal(
    out.entries[0].explanation,
    'On PostToolUseFailure (after a tool call fails), for all tool calls, runs the external command "tool-d" (external, unprobed — not resolved this run).',
  );
});

test('matcher \'*\' on a NON-tool-matcher event is omitted from the sentence', () => {
  const out = explainHooks({
    hooks: { Notification: [{ matcher: '*', hooks: [{ type: 'command', command: 'tool-b run' }] }] },
    env: {},
  });
  assert.equal(
    out.entries[0].explanation,
    'On Notification (when Claude Code sends a notification), runs the external command "tool-b" (external, unprobed — not resolved this run).',
  );
});

test('non-empty matcher on a NON-ToolUse event renders matching "<m>"', () => {
  const out = explainHooks({
    hooks: { SubagentStop: [{ matcher: 'Explore', hooks: [{ type: 'command', command: 'tool-c run' }] }] },
    env: {},
  });
  assert.match(out.entries[0].explanation, /^On SubagentStop \(when a subagent finishes\), matching "Explore", /);
});

// ── 3. unknown event → generic phrase, never dropped ──────────────────────────

test('unknown event gets the generic fallback phrase and is kept', () => {
  const out = explainHooks({
    hooks: { TotallyNewEvent: [{ hooks: [{ type: 'command', command: 'x-tool go' }] }] },
    env: {},
  });
  assert.equal(out.entries.length, 1);
  assert.match(out.entries[0].explanation, /^On TotallyNewEvent \(when this event fires\), /);
});

// ── 4. join contract ──────────────────────────────────────────────────────────

test('join is by (event, command): a fact under a DIFFERENT event does not bleed', () => {
  const out = explainHooks({
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'shared-cmd run' }] }] },
    hookFacts: [{ event: 'PreToolUse', command: 'shared-cmd run', kind: 'external', target: 'shared-cmd', status: 'found' }],
    env: {},
  });
  assert.equal(out.entries[0].status, 'unprobed');
});

test('facts for commands not present in hooks are ignored (no phantom entries)', () => {
  const out = explainHooks({
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'real-cmd run' }] }] },
    hookFacts: [
      { event: 'Stop', command: 'real-cmd run', kind: 'external', target: 'real-cmd', status: 'found' },
      { event: 'Stop', command: 'ghost-cmd run', kind: 'external', target: 'ghost-cmd', status: 'missing' },
    ],
    env: {},
  });
  assert.equal(out.entries.length, 1);
  assert.equal(out.entries[0].status, 'found');
  assert.equal(out.summary.missing, 0);
});

test('duplicate command under one event shares one status; first fact wins on a dup key', () => {
  const out = explainHooks({
    hooks: {
      Stop: [
        { hooks: [{ type: 'command', command: 'dup-cmd run' }] },
        { hooks: [{ type: 'command', command: 'dup-cmd run' }] },
      ],
    },
    hookFacts: [
      { event: 'Stop', command: 'dup-cmd run', kind: 'external', target: 'dup-cmd', status: 'found' },
      { event: 'Stop', command: 'dup-cmd run', kind: 'external', target: 'dup-cmd', status: 'missing' },
    ],
    env: {},
  });
  assert.equal(out.entries.length, 2);
  assert.equal(out.entries[0].status, 'found');
  assert.equal(out.entries[1].status, 'found');
});

// ── 5. env passthrough ────────────────────────────────────────────────────────

test('env is passed to classification: $VAR expands when env provides it', () => {
  const out = explainHooks({
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node $H/x.mjs' }] }] },
    env: { H: '/home/u' },
  });
  assert.equal(out.entries[0].kind, 'file');
  assert.equal(out.entries[0].target, '/home/u/x.mjs');
});

// ── 6. never-throws battery ───────────────────────────────────────────────────

test('never-throws: junk top-level inputs → honest empty result', () => {
  const empty = { entries: [], summary: { total: 0, missing: 0, indeterminate: 0, byKind: { file: 0, external: 0, opaque: 0 } }, diagnostics: [] };
  for (const junk of [undefined, null, 42, 'x', [], { hooks: null }, { hooks: 'nope' }, { hooks: [] }, { hooks: 7, hookFacts: 'junk' }]) {
    assert.deepEqual(explainHooks(junk), empty, `junk input: ${JSON.stringify(junk)}`);
  }
});

test('never-throws: __proto__ event key skipped, junk groups/entries skipped', () => {
  const hooks = JSON.parse('{"__proto__": [{"hooks":[{"type":"command","command":"evil run"}]}], "Stop": [null, 42, "x", {"matcher": 5, "hooks": "nope"}, {"hooks": [null, {"type":"other"}, {"type":"command"}, {"type":"command","command":""}, {"type":"command","command":7}, {"type":"command","command":"ok-tool run"}]}]}');
  const out = explainHooks({ hooks, hookFacts: [null, {}, { event: 1, command: 'c', status: 'found' }, { event: 'Stop', command: 'ok-tool run', status: '' }], env: {} });
  assert.equal(out.entries.length, 1, 'only the well-formed entry survives');
  assert.equal(out.entries[0].command, 'ok-tool run');
  assert.equal(out.entries[0].status, 'unprobed', 'empty-string fact status is junk → unprobed');
});

test('junk fact status string renders deterministically (never throws)', () => {
  const out = explainHooks({
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'weird-tool run' }] }] },
    hookFacts: [{ event: 'Stop', command: 'weird-tool run', status: 'banana' }],
    env: {},
  });
  assert.equal(out.entries[0].status, 'banana');
  assert.match(out.entries[0].explanation, /\(external, banana\)\.$/);
});

// ── 7. phrase table ───────────────────────────────────────────────────────────

test('HOOK_EVENT_PHRASES is frozen and grounds the documented core events', () => {
  assert.ok(Object.isFrozen(HOOK_EVENT_PHRASES));
  assert.equal(HOOK_EVENT_PHRASES.PreToolUse, 'before a tool call runs');
  assert.equal(HOOK_EVENT_PHRASES.PostToolUse, 'after a tool call completes');
  assert.equal(HOOK_EVENT_PHRASES.SessionStart, 'when a session starts or resumes');
  assert.equal(HOOK_EVENT_PHRASES.Stop, 'when Claude finishes responding');
  // a representative spread of the docs event table is present
  for (const ev of ['UserPromptSubmit', 'SubagentStop', 'PreCompact', 'SessionEnd', 'Notification']) {
    assert.equal(typeof HOOK_EVENT_PHRASES[ev], 'string', `phrase for ${ev}`);
  }
});
