/**
 * Tests for src/lib/resolve-command.mjs (P2.U5b).
 *
 * Cross-platform safety rules applied throughout:
 *   - When simulating a platform via platform:'win32' or platform:'linux', use a
 *     single-directory PATH so no delimiter ambiguity with Windows drive-letter colons.
 *   - Multi-dir PATH tests use the HOST delimiter (process.platform check) and do NOT
 *     pass an explicit platform, so the host's real path.join/isAbsolute/statSync applies.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveCommand } from '../src/lib/resolve-command.mjs';

/** Create a fresh temp dir for a test, auto-cleaned in finally. */
function makeTmp() {
  return mkdtempSync(join(tmpdir(), 'mgr-rc-'));
}

// ── 1. posix bare name resolves ───────────────────────────────────────────────
// On Windows, tmp contains 'C:\...' which has ':' — the linux PATH delimiter.
// So we use the HOST platform here (no explicit platform) and single-dir PATH
// to avoid any delimiter split. The module uses host path.join/statSync regardless.

test('bare name resolves when file exists in single-dir PATH', () => {
  const tmp = makeTmp();
  try {
    const name = process.platform === 'win32' ? 'tool.cmd' : 'tool';
    writeFileSync(join(tmp, name), '#!/bin/sh\necho hi');
    // Use the host platform so the PATH delimiter matches the host.
    const env = process.platform === 'win32'
      ? { PATH: tmp, PATHEXT: '.CMD' }
      : { PATH: tmp };
    const r = resolveCommand(process.platform === 'win32' ? 'tool' : name, { env });
    assert.equal(r.resolved, true);
    assert.ok(r.path.toLowerCase().endsWith(name.toLowerCase()),
      `expected resolved path to end with '${name}', got: ${r.path}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── 2. bare name not found ────────────────────────────────────────────────────

test('bare name not found returns resolved:false, path:null', () => {
  const tmp = makeTmp();
  try {
    // Use host platform to avoid ':' delimiter issue on Windows with linux platform.
    const r = resolveCommand('nope', { env: { PATH: tmp } });
    assert.equal(r.resolved, false);
    assert.equal(r.path, null);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── 3. win PATHEXT tries extensions ──────────────────────────────────────────

test('win PATHEXT: resolves bare name by appending .CMD extension', () => {
  const tmp = makeTmp();
  try {
    writeFileSync(join(tmp, 'tool.cmd'), '@echo off');
    const r = resolveCommand('tool', { env: { PATH: tmp, PATHEXT: '.EXE;.CMD' }, platform: 'win32' });
    assert.equal(r.resolved, true);
    // Windows may uppercase the extension via PATHEXT; compare case-insensitively.
    assert.ok(r.path.toLowerCase().endsWith('tool.cmd'), `expected path ending with tool.cmd (any case), got: ${r.path}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── 4. win as-is with extension already present ───────────────────────────────

test('win: resolves command with extension already present (foo.exe)', () => {
  const tmp = makeTmp();
  try {
    writeFileSync(join(tmp, 'foo.exe'), 'MZ');
    const r = resolveCommand('foo.exe', { env: { PATH: tmp, PATHEXT: '.EXE' }, platform: 'win32' });
    assert.equal(r.resolved, true);
    assert.ok(r.path.endsWith('foo.exe'), `expected foo.exe, got: ${r.path}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── 5. absolute path ──────────────────────────────────────────────────────────

test('absolute path to existing file resolves', () => {
  const tmp = makeTmp();
  try {
    const file = join(tmp, 'mything');
    writeFileSync(file, 'x');
    const r = resolveCommand(file, { platform: 'linux' });
    assert.equal(r.resolved, true);
    assert.equal(r.path, file);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('absolute path to non-existent file returns resolved:false', () => {
  const tmp = makeTmp();
  try {
    const r = resolveCommand(join(tmp, 'does-not-exist'), { platform: 'linux' });
    assert.equal(r.resolved, false);
    assert.equal(r.path, null);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── 6. directory is NOT a match ───────────────────────────────────────────────

test('directory with matching name is NOT resolved (isFile rejects directories)', () => {
  const tmp = makeTmp();
  try {
    mkdirSync(join(tmp, 'tool'));
    const r = resolveCommand('tool', { env: { PATH: tmp }, platform: 'linux' });
    assert.equal(r.resolved, false);
    assert.equal(r.path, null);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── 7. multi-dir PATH (host platform) ────────────────────────────────────────

test('multi-dir PATH: resolves from second dir when not in first', () => {
  const tmp = makeTmp();
  try {
    const dirA = join(tmp, 'a');
    const dirB = join(tmp, 'b');
    mkdirSync(dirA);
    mkdirSync(dirB);

    const DELIM = process.platform === 'win32' ? ';' : ':';
    // On Windows create tool.cmd with a PATHEXT that includes .CMD so the bare
    // lookup on the host succeeds; on posix just create tool with no extension.
    let cmdName;
    if (process.platform === 'win32') {
      cmdName = 'tool';
      writeFileSync(join(dirB, 'tool.cmd'), '@echo off');
      const pathExt = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').toUpperCase();
      const r = resolveCommand(cmdName, {
        env: { PATH: dirA + DELIM + dirB, PATHEXT: pathExt },
      });
      assert.equal(r.resolved, true);
      assert.ok(r.path.startsWith(dirB), `expected from dirB, got: ${r.path}`);
    } else {
      cmdName = 'tool';
      writeFileSync(join(dirB, 'tool'), '#!/bin/sh');
      const r = resolveCommand(cmdName, {
        env: { PATH: dirA + DELIM + dirB },
      });
      assert.equal(r.resolved, true);
      assert.ok(r.path.startsWith(dirB), `expected from dirB, got: ${r.path}`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── 8. junk inputs never throw ────────────────────────────────────────────────

for (const junk of [null, undefined, '', '   ', 42, {}, []]) {
  test(`junk input ${JSON.stringify(junk)} never throws and returns resolved:false`, () => {
    assert.doesNotThrow(() => {
      const r = resolveCommand(junk);
      assert.equal(r.resolved, false);
      assert.equal(r.path, null);
    });
  });
}

// ── 9. empty PATH ─────────────────────────────────────────────────────────────

test('empty PATH returns resolved:false without throwing', () => {
  assert.doesNotThrow(() => {
    const r = resolveCommand('tool', { env: { PATH: '' }, platform: 'linux' });
    assert.equal(r.resolved, false);
    assert.equal(r.path, null);
  });
});
