/**
 * probe-codex-config.test.mjs (P6 codex doctor #26/#27).
 *
 * gatherCodexConfig over temp config.toml fixtures: trusted-project extraction,
 * malformed-TOML → tomlError (never throws), and the benign missing-file case.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { gatherCodexConfig } from '../src/discovery/probe-codex-config.mjs';

/** Make a temp codex config dir; return its path. */
function makeDir() {
  return mkdtempSync(join(tmpdir(), 'mgr-codex-cfg-'));
}

test('(i) trust_level="trusted" projects are extracted; untrusted/absent are NOT collected', () => {
  const dir = makeDir();
  try {
    const toml = [
      '[projects."C:\\\\Users\\\\me"]',
      'trust_level = "trusted"',
      '',
      '[projects."C:\\\\Users\\\\me\\\\untrusted"]',
      'trust_level = "untrusted"',
      '',
      '[projects."C:\\\\Users\\\\me\\\\noflag"]',
      'some_other_key = true',
    ].join('\n');
    writeFileSync(join(dir, 'config.toml'), toml, 'utf8');

    const { codexConfig, diagnostics } = gatherCodexConfig({ configDir: dir, homeDir: 'C:\\Users\\me' });
    assert.equal(codexConfig.tomlError, null);
    assert.equal(codexConfig.homeDir, 'C:\\Users\\me', 'homeDir passes through');
    assert.deepEqual(codexConfig.trustedProjects, ['C:\\Users\\me'], 'only the trusted project is collected');
    assert.equal(diagnostics.length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('(ii) malformed config.toml → tomlError set, never throws, trustedProjects []', () => {
  const dir = makeDir();
  try {
    // an unterminated table header is a clean parse error
    writeFileSync(join(dir, 'config.toml'), '[projects."broken"\ntrust_level = "trusted"\n', 'utf8');
    let res;
    assert.doesNotThrow(() => { res = gatherCodexConfig({ configDir: dir, homeDir: 'C:\\Users\\me' }); });
    assert.equal(typeof res.codexConfig.tomlError, 'string');
    assert.ok(res.codexConfig.tomlError.length > 0, 'a non-empty error reason is recorded');
    assert.deepEqual(res.codexConfig.trustedProjects, [], 'no parsed table → no trusted projects');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('(iii) missing config.toml → tomlError null + trustedProjects []', () => {
  const dir = makeDir(); // empty dir, no config.toml
  try {
    const { codexConfig } = gatherCodexConfig({ configDir: dir, homeDir: 'C:\\Users\\me' });
    assert.equal(codexConfig.tomlError, null, 'a missing file is benign');
    assert.deepEqual(codexConfig.trustedProjects, []);
    assert.equal(codexConfig.homeDir, 'C:\\Users\\me');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('never throws on a hostile/absent configDir', () => {
  assert.doesNotThrow(() => gatherCodexConfig({}));
  assert.doesNotThrow(() => gatherCodexConfig({ configDir: null, homeDir: null }));
  // literal null / undefined opts must ALSO degrade safely (the `|| {}` guard, not a
  // destructuring default which only catches undefined) — honors the never-throws contract.
  assert.doesNotThrow(() => gatherCodexConfig(null));
  assert.doesNotThrow(() => gatherCodexConfig(undefined));
  assert.doesNotThrow(() => gatherCodexConfig());
  const { codexConfig } = gatherCodexConfig({ configDir: undefined, homeDir: undefined });
  assert.deepEqual(codexConfig.trustedProjects, []);
  assert.equal(codexConfig.homeDir, '');
});

test('a [projects] key named __proto__ is ignored (proto-safe), trusted ones still collected', () => {
  const dir = makeDir();
  try {
    const toml = [
      '[projects."__proto__"]',
      'trust_level = "trusted"',
      '',
      '[projects."C:\\\\real"]',
      'trust_level = "trusted"',
    ].join('\n');
    writeFileSync(join(dir, 'config.toml'), toml, 'utf8');
    const { codexConfig } = gatherCodexConfig({ configDir: dir, homeDir: 'C:\\real' });
    assert.deepEqual(codexConfig.trustedProjects, ['C:\\real'], '__proto__ key skipped');
    assert.equal(({}).hasOwnProperty('__proto__'), false, 'no prototype pollution leaked');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
