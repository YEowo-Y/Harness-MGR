/**
 * P2.U5b-2 — probe-hooks.test.mjs
 *
 * Tests for gatherHookProbes: hook command resolution (file/external),
 * indeterminate status for unexpanded vars, proto-safety, and junk-input
 * tolerance. All cases must never throw.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gatherHookProbes } from '../src/discovery/probe-hooks.mjs';

/**
 * Build a minimal hooks object: one event, one matcher-group, one hook entry.
 * @param {string} event
 * @param {string} command
 * @param {string} [type]
 */
const mkHooks = (event, command, type = 'command') => ({
  [event]: [{ matcher: '*', hooks: [{ type, command }] }],
});

// ── 1. file found ────────────────────────────────────────────────────────────

test('file found: script exists in tmp, status found', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'mgr-probehooks-'));
  try {
    writeFileSync(join(tmp, 'hook.mjs'), '// hook', 'utf-8');
    const { hookFacts, diagnostics } = gatherHookProbes({
      hooks: mkHooks('PreToolUse', 'node "$H/hook.mjs"'),
      env: { H: tmp },
      platform: 'linux',
    });
    assert.equal(hookFacts.length, 1, `expected 1 fact, got ${hookFacts.length}`);
    const [f] = hookFacts;
    assert.equal(f.event, 'PreToolUse');
    assert.equal(f.kind, 'file');
    assert.equal(f.status, 'found');
    assert.ok(f.target.endsWith('hook.mjs'), `target should end with hook.mjs, got: ${f.target}`);
    assert.equal(diagnostics.length, 0);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── 2. file missing ──────────────────────────────────────────────────────────

test('file missing: script absent, status missing', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'mgr-probehooks-'));
  try {
    const { hookFacts } = gatherHookProbes({
      hooks: mkHooks('PreToolUse', 'node "$H/nope.mjs"'),
      env: { H: tmp },
      platform: 'linux',
    });
    assert.equal(hookFacts.length, 1);
    assert.equal(hookFacts[0].status, 'missing');
    assert.equal(hookFacts[0].kind, 'file');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── 3. indeterminate: unexpanded env var ─────────────────────────────────────

test('indeterminate: unresolvable env var, not missing', () => {
  const { hookFacts } = gatherHookProbes({
    hooks: mkHooks('PreToolUse', 'node "$UNSET/x.mjs"'),
    env: {},
    platform: 'linux',
  });
  assert.equal(hookFacts.length, 1);
  assert.equal(hookFacts[0].status, 'indeterminate');
  assert.notEqual(hookFacts[0].status, 'missing');
});

// ── 4. external found ────────────────────────────────────────────────────────

test('external found: bare command name on PATH', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'mgr-probehooks-'));
  try {
    // On Windows the temp dir contains a drive colon (C:\...) which is mangled
    // when PATH is split on ':' (the POSIX separator). Use the real host platform
    // so PATH is split correctly, and write a PATHEXT-compatible file on win32.
    const isWin = process.platform === 'win32';
    const filename = isWin ? 'mytool.cmd' : 'mytool';
    writeFileSync(join(tmp, filename), isWin ? '@echo hi' : '#!/bin/sh\necho hi', 'utf-8');
    if (!isWin) chmodSync(join(tmp, filename), 0o755); // an EXTERNAL command needs the exec bit to resolve (P2-3 X_OK)
    const env = isWin
      ? { PATH: tmp, PATHEXT: '.COM;.EXE;.BAT;.CMD' }
      : { PATH: tmp };
    const { hookFacts } = gatherHookProbes({
      hooks: mkHooks('PostToolUse', 'mytool --silent'),
      env,
      platform: process.platform,
    });
    assert.equal(hookFacts.length, 1);
    const [f] = hookFacts;
    assert.equal(f.kind, 'external');
    assert.equal(f.target, 'mytool');
    assert.equal(f.status, 'found');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── 5. external missing ──────────────────────────────────────────────────────

test('external missing: bare command not on PATH', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'mgr-probehooks-'));
  try {
    const { hookFacts } = gatherHookProbes({
      hooks: mkHooks('PostToolUse', 'nope-xyz apply'),
      env: { PATH: tmp },
      platform: 'linux',
    });
    assert.equal(hookFacts.length, 1);
    assert.equal(hookFacts[0].kind, 'external');
    assert.equal(hookFacts[0].status, 'missing');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── 6. bare-filename file resolved against cwd ───────────────────────────────

test('bare-filename file resolved against cwd, not PATH-searched', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'mgr-probehooks-'));
  try {
    writeFileSync(join(tmp, 'app.js'), '// app', 'utf-8');
    const { hookFacts } = gatherHookProbes({
      hooks: mkHooks('PreToolUse', 'node app.js'),
      env: {},
      cwd: tmp,
      platform: 'linux',
    });
    assert.equal(hookFacts.length, 1);
    assert.equal(hookFacts[0].kind, 'file');
    assert.equal(hookFacts[0].status, 'found');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── 7. multiple events / groups / entries ────────────────────────────────────

test('multiple events and entries: all facts collected with correct event names', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'mgr-probehooks-'));
  try {
    writeFileSync(join(tmp, 'a.mjs'), '// a', 'utf-8');
    writeFileSync(join(tmp, 'b.mjs'), '// b', 'utf-8');

    const hooks = {
      PreToolUse: [
        {
          matcher: '*',
          hooks: [
            { type: 'command', command: 'node "$H/a.mjs"' },
            { type: 'command', command: 'node "$H/b.mjs"' },
          ],
        },
      ],
      PostToolUse: [
        { matcher: '*', hooks: [{ type: 'command', command: 'node "$H/a.mjs"' }] },
      ],
    };

    const { hookFacts } = gatherHookProbes({ hooks, env: { H: tmp }, platform: 'linux' });
    assert.equal(hookFacts.length, 3, `expected 3 facts, got ${hookFacts.length}`);

    const pre = hookFacts.filter((f) => f.event === 'PreToolUse');
    const post = hookFacts.filter((f) => f.event === 'PostToolUse');
    assert.equal(pre.length, 2);
    assert.equal(post.length, 1);
    assert.ok(hookFacts.every((f) => f.status === 'found'));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── 8. non-command entry skipped ────────────────────────────────────────────

test('non-command entry (type:output) produces no fact', () => {
  const { hookFacts } = gatherHookProbes({
    hooks: mkHooks('PreToolUse', 'node x.mjs', 'output'),
    env: {},
    platform: 'linux',
  });
  assert.equal(hookFacts.length, 0);
});

// ── 9. eval command skipped (classify returns null) ──────────────────────────

test('eval command skipped: node -e returns null from classify', () => {
  const { hookFacts } = gatherHookProbes({
    hooks: mkHooks('PreToolUse', 'node -e "console.log(1)"'),
    env: {},
    platform: 'linux',
  });
  assert.equal(hookFacts.length, 0);
});

// ── 10. proto-safe: __proto__ event skipped ──────────────────────────────────

test('proto-safe: __proto__ event key is skipped, no fact emitted, no throw', () => {
  assert.doesNotThrow(() => {
    const hooks = JSON.parse('{"__proto__":[{"hooks":[{"type":"command","command":"node x"}]}]}');
    const { hookFacts } = gatherHookProbes({ hooks, env: {}, platform: 'linux' });
    assert.equal(hookFacts.length, 0, '__proto__ event must not produce a fact');
  });
});

// ── 11. junk opts never throw ────────────────────────────────────────────────

test('junk opts never throw and return empty hookFacts', () => {
  const junks = [
    null,
    undefined,
    42,
    { hooks: 'x' },
    { hooks: [] },
    { hooks: { E: 'notarray' } },
  ];
  for (const junk of junks) {
    assert.doesNotThrow(
      () => {
        const result = gatherHookProbes(/** @type {any} */ (junk));
        assert.deepEqual(
          result.hookFacts,
          [],
          `hookFacts should be empty for junk=${JSON.stringify(junk)}`,
        );
      },
      `gatherHookProbes(${JSON.stringify(junk)}) must not throw`,
    );
  }
});
