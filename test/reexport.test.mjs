import test from 'node:test';
import assert from 'node:assert/strict';
import { homedir, tmpdir } from 'node:os';
import { join, normalize } from 'node:path';
import { readFileSync, rmSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

import {
  atomicWriteFileSync,
  getClaudeConfigDir,
  ensureDirSync,
  resolveHooksLibDir,
} from '../src/lib/reexport.mjs';

test('reexport resolves the real ~/.claude/hooks/lib dir by default', () => {
  const saved = process.env.CLAUDE_MGR_HOOKS_LIB_DIR;
  delete process.env.CLAUDE_MGR_HOOKS_LIB_DIR;
  try {
    assert.equal(resolveHooksLibDir(), join(homedir(), '.claude', 'hooks', 'lib'));
  } finally {
    if (saved !== undefined) process.env.CLAUDE_MGR_HOOKS_LIB_DIR = saved;
  }
});

test('reexport honors CLAUDE_MGR_HOOKS_LIB_DIR override', () => {
  const saved = process.env.CLAUDE_MGR_HOOKS_LIB_DIR;
  process.env.CLAUDE_MGR_HOOKS_LIB_DIR = 'C:\\some\\override\\lib';
  try {
    assert.equal(resolveHooksLibDir(), 'C:\\some\\override\\lib');
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_MGR_HOOKS_LIB_DIR;
    else process.env.CLAUDE_MGR_HOOKS_LIB_DIR = saved;
  }
});

test('reexport imports the REAL functions from hooks/lib (identity check)', async () => {
  // Point the identity check at the SAME dir the shim resolved at load time,
  // then compare references. The real dir is ~/.claude/hooks/lib by default.
  const libDir = resolveHooksLibDir();
  const realAtomic = await import(pathToFileURL(join(libDir, 'atomic-write.mjs')).href);
  const realConfig = await import(pathToFileURL(join(libDir, 'config-dir.mjs')).href);

  assert.equal(
    atomicWriteFileSync,
    realAtomic.atomicWriteFileSync,
    'reexported atomicWriteFileSync must be the SAME function object as the real one',
  );
  assert.equal(
    ensureDirSync,
    realAtomic.ensureDirSync,
    'reexported ensureDirSync must be the SAME function object as the real one',
  );
  assert.equal(
    getClaudeConfigDir,
    realConfig.getClaudeConfigDir,
    'reexported getClaudeConfigDir must be the SAME function object as the real one',
  );
});

test('reexported getClaudeConfigDir honors CLAUDE_CONFIG_DIR (delegation end to end)', () => {
  const saved = process.env.CLAUDE_CONFIG_DIR;
  const override = normalize(join(tmpdir(), 'cmgr-reexport-cfg'));
  process.env.CLAUDE_CONFIG_DIR = override;
  try {
    assert.equal(getClaudeConfigDir(), override);
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
  }
});

test('reexported atomicWriteFileSync round-trips a file into the sandbox temp', () => {
  const dir = join(tmpdir(), `cmgr-atomic-${randomUUID()}`);
  const file = join(dir, 'probe.txt');
  ensureDirSync(dir);
  try {
    atomicWriteFileSync(file, 'borrowed-and-working');
    assert.ok(existsSync(file));
    assert.equal(readFileSync(file, 'utf-8'), 'borrowed-and-working');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
