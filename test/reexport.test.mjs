import test from 'node:test';
import assert from 'node:assert/strict';
import { homedir, tmpdir } from 'node:os';
import { join, normalize, sep } from 'node:path';

import { getClaudeConfigDir } from '../src/lib/reexport.mjs';

// reexport.mjs is now a SYNCHRONOUS first-party re-export of lib/config-dir.mjs (no
// runtime borrow from ~/.claude/hooks/lib). These tests pin getClaudeConfigDir's
// branches so the portability fix can never silently regress.

/** Run `fn` with CLAUDE_CONFIG_DIR set to `value` (or unset when undefined), restored after. */
function withConfigDir(value, fn) {
  const saved = process.env.CLAUDE_CONFIG_DIR;
  if (value === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = value;
  try {
    fn();
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
  }
}

test('reexport surfaces getClaudeConfigDir as a function', () => {
  assert.equal(typeof getClaudeConfigDir, 'function');
});

test('getClaudeConfigDir defaults to <home>/.claude when CLAUDE_CONFIG_DIR is unset', () => {
  withConfigDir(undefined, () => {
    assert.equal(getClaudeConfigDir(), normalize(join(homedir(), '.claude')));
  });
});

test('getClaudeConfigDir expands a bare ~ to the home dir', () => {
  withConfigDir('~', () => {
    assert.equal(getClaudeConfigDir(), normalize(homedir()));
  });
});

test('getClaudeConfigDir expands ~<sep>sub to <home>/sub', () => {
  withConfigDir(`~${sep}cfgsub`, () => {
    assert.equal(getClaudeConfigDir(), normalize(join(homedir(), 'cfgsub')));
  });
});

test('getClaudeConfigDir uses an absolute override verbatim (normalized)', () => {
  const override = normalize(join(tmpdir(), 'cmgr-reexport-cfg'));
  withConfigDir(override, () => {
    assert.equal(getClaudeConfigDir(), override);
  });
});

test('getClaudeConfigDir strips a single trailing separator (but not a root)', () => {
  const base = normalize(join(tmpdir(), 'cmgr-trail'));
  withConfigDir(base + sep, () => {
    assert.equal(getClaudeConfigDir(), base);
  });
});
