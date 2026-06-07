/**
 * Tests for src/lib/resolve-claude-exe.mjs (P4b.U5 prerequisite).
 *
 * Covers:
 *  - isSpawnable: win32 + .exe/.com → true; win32 shims → false; POSIX → true; edge cases.
 *  - DRIFT-GUARD: isSpawnable must return identical results to probe-cli.mjs::isSpawnable.
 *  - resolveClaudeExe: native exe, POSIX native, win32 shim→package-bin, missing pkg bin,
 *    unresolved, never-throws on a throwing resolveFn.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';

import { isSpawnable, resolveClaudeExe } from '../src/lib/resolve-claude-exe.mjs';
import { isSpawnable as probeIsSpawnable } from '../src/discovery/probe-cli.mjs';

// ---------------------------------------------------------------------------
// isSpawnable
// ---------------------------------------------------------------------------

describe('isSpawnable', () => {
  it('win32 + .exe → true', () => {
    assert.equal(isSpawnable('C:\\tools\\claude.exe', 'win32'), true);
  });

  it('win32 + .EXE (uppercase) → true', () => {
    assert.equal(isSpawnable('C:\\tools\\CLAUDE.EXE', 'win32'), true);
  });

  it('win32 + .com → true', () => {
    assert.equal(isSpawnable('C:\\tools\\run.com', 'win32'), true);
  });

  it('win32 + .cmd → false', () => {
    assert.equal(isSpawnable('C:\\npm\\claude.cmd', 'win32'), false);
  });

  it('win32 + .ps1 → false', () => {
    assert.equal(isSpawnable('C:\\npm\\claude.ps1', 'win32'), false);
  });

  it('win32 + .bat → false', () => {
    assert.equal(isSpawnable('C:\\npm\\claude.bat', 'win32'), false);
  });

  it('win32 + extensionless → false', () => {
    assert.equal(isSpawnable('C:\\npm\\claude', 'win32'), false);
  });

  it('linux + any path → true', () => {
    assert.equal(isSpawnable('/usr/local/bin/claude', 'linux'), true);
  });

  it('darwin + any path → true', () => {
    assert.equal(isSpawnable('/usr/bin/claude', 'darwin'), true);
  });

  it('non-string → false', () => {
    assert.equal(isSpawnable(null, 'win32'), false);
    assert.equal(isSpawnable(42, 'linux'), false);
  });

  it('empty string → false', () => {
    assert.equal(isSpawnable('', 'win32'), false);
    assert.equal(isSpawnable('', 'linux'), false);
  });
});

// ---------------------------------------------------------------------------
// DRIFT-GUARD: local isSpawnable must agree with probe-cli.mjs isSpawnable
// ---------------------------------------------------------------------------

describe('isSpawnable drift-guard vs probe-cli.mjs', () => {
  const battery = [
    ['C:\\tools\\claude.exe', 'win32'],
    ['C:\\tools\\run.com', 'win32'],
    ['C:\\tools\\CLAUDE.EXE', 'win32'],
    ['C:\\npm\\claude', 'win32'],
    ['C:\\npm\\claude.cmd', 'win32'],
    ['C:\\npm\\claude.ps1', 'win32'],
    ['/usr/local/bin/claude', 'linux'],
    ['/usr/bin/claude', 'darwin'],
    ['', 'win32'],
    ['', 'linux'],
    [null, 'win32'],
  ];

  for (const [path, platform] of battery) {
    it(`isSpawnable(${JSON.stringify(path)}, ${platform}) matches probe-cli`, () => {
      assert.equal(
        isSpawnable(path, platform),
        probeIsSpawnable(path, platform),
        `Drift detected for (${JSON.stringify(path)}, ${platform})`,
      );
    });
  }
});

// ---------------------------------------------------------------------------
// resolveClaudeExe
// ---------------------------------------------------------------------------

describe('resolveClaudeExe', () => {
  it('native exe on win32: resolveFn returns a .exe path → kind native', () => {
    const result = resolveClaudeExe({
      platform: 'win32',
      resolveFn: () => ({ resolved: true, path: 'C:\\tools\\claude.exe' }),
      existsFn: () => false,
    });
    assert.equal(result.exe, 'C:\\tools\\claude.exe');
    assert.equal(result.kind, 'native');
    assert.deepEqual(result.diagnostics, []);
  });

  it('native on linux: platform linux, resolveFn returns posix path → kind native', () => {
    const result = resolveClaudeExe({
      platform: 'linux',
      resolveFn: () => ({ resolved: true, path: '/usr/local/bin/claude' }),
      existsFn: () => false,
    });
    assert.equal(result.exe, '/usr/local/bin/claude');
    assert.equal(result.kind, 'native');
    assert.deepEqual(result.diagnostics, []);
  });

  it('native on darwin: any path is spawnable → kind native', () => {
    const result = resolveClaudeExe({
      platform: 'darwin',
      resolveFn: () => ({ resolved: true, path: '/usr/local/bin/claude' }),
      existsFn: () => false,
    });
    assert.equal(result.kind, 'native');
  });

  it('win32 shim → package bin: existsFn returns true for derived path → kind package-bin', () => {
    const shimPath = 'C:\\Users\\me\\AppData\\Roaming\\npm\\claude';
    const expectedPkgBin = join(
      dirname(shimPath),
      'node_modules',
      '@anthropic-ai',
      'claude-code',
      'bin',
      'claude.exe',
    );

    const result = resolveClaudeExe({
      platform: 'win32',
      resolveFn: () => ({ resolved: true, path: shimPath }),
      existsFn: (p) => p === expectedPkgBin,
    });

    assert.equal(result.exe, expectedPkgBin);
    assert.equal(result.kind, 'package-bin');
    assert.deepEqual(result.diagnostics, []);
  });

  it('win32 shim + package bin MISSING → exe null + claude-exe-unresolved diagnostic', () => {
    const shimPath = 'C:\\Users\\me\\AppData\\Roaming\\npm\\claude';

    const result = resolveClaudeExe({
      platform: 'win32',
      resolveFn: () => ({ resolved: true, path: shimPath }),
      existsFn: () => false,
    });

    assert.equal(result.exe, null);
    assert.equal(result.kind, null);
    assert.equal(result.diagnostics.length, 1);
    assert.equal(result.diagnostics[0].code, 'claude-exe-unresolved');
    assert.equal(result.diagnostics[0].severity, 'info');
    assert.equal(result.diagnostics[0].phase, 'update');
  });

  it('unresolved (resolveFn returns resolved:false) → exe null + unresolved diagnostic', () => {
    const result = resolveClaudeExe({
      platform: 'win32',
      resolveFn: () => ({ resolved: false, path: null }),
      existsFn: () => false,
    });

    assert.equal(result.exe, null);
    assert.equal(result.kind, null);
    assert.equal(result.diagnostics.length, 1);
    assert.equal(result.diagnostics[0].code, 'claude-exe-unresolved');
  });

  it('unresolved on linux (resolved:false) → exe null + unresolved diagnostic', () => {
    const result = resolveClaudeExe({
      platform: 'linux',
      resolveFn: () => ({ resolved: false, path: null }),
      existsFn: () => false,
    });

    assert.equal(result.exe, null);
    assert.equal(result.kind, null);
    assert.equal(result.diagnostics.length, 1);
    assert.equal(result.diagnostics[0].code, 'claude-exe-unresolved');
  });

  it('never-throws: a resolveFn that throws → returns exe:null + claude-exe-resolve-error diagnostic', () => {
    let threw = false;
    try {
      const result = resolveClaudeExe({
        platform: 'win32',
        resolveFn: () => { throw new Error('simulated resolver crash'); },
        existsFn: () => false,
      });

      assert.equal(result.exe, null);
      assert.equal(result.kind, null);
      assert.equal(result.diagnostics.length, 1);
      assert.equal(result.diagnostics[0].code, 'claude-exe-resolve-error');
      assert.equal(result.diagnostics[0].severity, 'error');
      assert.ok(result.diagnostics[0].message.includes('simulated resolver crash'));
    } catch {
      threw = true;
    }
    assert.equal(threw, false, 'resolveClaudeExe must never throw');
  });

  it('never-throws: an existsFn that throws → returns exe:null + claude-exe-resolve-error', () => {
    let threw = false;
    try {
      const result = resolveClaudeExe({
        platform: 'win32',
        resolveFn: () => ({ resolved: true, path: 'C:\\npm\\claude' }),
        existsFn: () => { throw new Error('simulated existsFn crash'); },
      });

      assert.equal(result.exe, null);
      assert.equal(result.kind, null);
      assert.equal(result.diagnostics.length, 1);
      assert.equal(result.diagnostics[0].code, 'claude-exe-resolve-error');
    } catch {
      threw = true;
    }
    assert.equal(threw, false, 'resolveClaudeExe must never throw even when existsFn throws');
  });

  it('called with no arguments uses process defaults without throwing', () => {
    // We cannot predict the outcome on this machine, but it must not throw
    // and must return the correct shape.
    let result;
    let threw = false;
    try {
      result = resolveClaudeExe();
    } catch {
      threw = true;
    }
    assert.equal(threw, false, 'resolveClaudeExe() with no args must not throw');
    assert.ok(result !== undefined && result !== null);
    assert.ok('exe' in result);
    assert.ok('kind' in result);
    assert.ok(Array.isArray(result.diagnostics));
  });
});
