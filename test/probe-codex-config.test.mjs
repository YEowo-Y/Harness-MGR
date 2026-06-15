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
  assert.deepEqual(codexConfig.leftoverStateTmp, { count: 0, sample: [] }, 'leftover scan degrades safely');
});

// ── #28 leftover-state-tmp scan ────────────────────────────────────────────────

test('(iv) leftover ..codex-global-state.json.tmp-* files are counted (sorted sample, capped at 3)', () => {
  const dir = makeDir();
  try {
    const names = [
      '..codex-global-state.json.tmp-5', '..codex-global-state.json.tmp-1',
      '..codex-global-state.json.tmp-3', '..codex-global-state.json.tmp-2',
      '..codex-global-state.json.tmp-4',
    ];
    for (const n of names) writeFileSync(join(dir, n), '', 'utf8');
    // decoys that must NOT match: the live state file + a .bak (one leading dot, no .tmp-).
    writeFileSync(join(dir, '.codex-global-state.json'), '{}', 'utf8');
    writeFileSync(join(dir, '.codex-global-state.json.bak'), '{}', 'utf8');

    const { codexConfig } = gatherCodexConfig({ configDir: dir, homeDir: 'C:\\Users\\me' });
    assert.equal(codexConfig.leftoverStateTmp.count, 5, 'exactly the 5 tmp files (decoys excluded)');
    assert.deepEqual(codexConfig.leftoverStateTmp.sample, [
      '..codex-global-state.json.tmp-1', '..codex-global-state.json.tmp-2', '..codex-global-state.json.tmp-3',
    ], 'sorted, first 3');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('(v) no leftover tmp files → count 0, sample []', () => {
  const dir = makeDir();
  try {
    writeFileSync(join(dir, '.codex-global-state.json'), '{}', 'utf8');
    const { codexConfig } = gatherCodexConfig({ configDir: dir, homeDir: 'C:\\Users\\me' });
    assert.deepEqual(codexConfig.leftoverStateTmp, { count: 0, sample: [] });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('(vi) leftover scan is independent of config.toml validity (malformed config still counts tmp)', () => {
  const dir = makeDir();
  try {
    writeFileSync(join(dir, 'config.toml'), '[projects."broken"\n', 'utf8'); // parse error
    writeFileSync(join(dir, '..codex-global-state.json.tmp-x'), '', 'utf8');
    const { codexConfig } = gatherCodexConfig({ configDir: dir, homeDir: 'C:\\Users\\me' });
    assert.equal(typeof codexConfig.tomlError, 'string', 'config.toml is invalid');
    assert.equal(codexConfig.leftoverStateTmp.count, 1, 'tmp count is still gathered despite the parse error');
  } finally { rmSync(dir, { recursive: true, force: true }); }
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
