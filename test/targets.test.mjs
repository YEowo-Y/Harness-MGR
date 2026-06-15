/**
 * P6.U1 — targets.test.mjs
 *
 * Falsifiable oracles (golden literals + same-reference checks) for the
 * src/targets/ foundation: the claude single-source drift-guard, the codex
 * known-tables golden + pattern falsifiability, the resolveTarget selection
 * matrix (incl. proto-safety), frozen-ness, and never-throws.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { TARGETS, resolveTarget } from '../src/targets/descriptor.mjs';
import { claudeDescriptor } from '../src/targets/claude.mjs';
import { codexDescriptor, CODEX_STATE_TMP_RE } from '../src/targets/codex.mjs';

// The LIVE consts the claude descriptor must single-source.
import { KNOWN_TOP_DIRS } from '../src/discovery/settings.mjs';
import {
  KNOWN_TOP_FILES,
  KNOWN_TOP_FILE_PATTERNS,
  KNOWN_ECOSYSTEM_TOP_DIRS,
} from '../src/discovery/orphan-detector.mjs';

// ---------------------------------------------------------------------------
// claude single-source drift-guard
// ---------------------------------------------------------------------------

test('claude descriptor single-sources knownTopFiles by REFERENCE', () => {
  assert.equal(claudeDescriptor.knownTopFiles, KNOWN_TOP_FILES);
});

test('claude descriptor single-sources knownTopFilePatterns by REFERENCE', () => {
  assert.equal(claudeDescriptor.knownTopFilePatterns, KNOWN_TOP_FILE_PATTERNS);
});

test('claude descriptor knownTopDirs is the orphan-detector union', () => {
  assert.deepEqual(
    claudeDescriptor.knownTopDirs,
    [...KNOWN_TOP_DIRS, ...KNOWN_ECOSYSTEM_TOP_DIRS],
  );
});

test('claude descriptor identity + component kinds golden', () => {
  assert.equal(claudeDescriptor.id, 'claude');
  assert.equal(claudeDescriptor.label, 'Claude Code');
  assert.equal(claudeDescriptor.defaultHomeSubdir, '.claude');
  assert.equal(claudeDescriptor.signatureFile, 'settings.json');
  assert.deepEqual(claudeDescriptor.componentKinds, [
    { kind: 'skill', dir: 'skills', layout: 'skill-md' },
    { kind: 'agent', dir: 'agents', layout: 'flat-md' },
    { kind: 'command', dir: 'commands', layout: 'flat-md' },
  ]);
  assert.deepEqual(claudeDescriptor.governedConfigFiles, [
    'settings.json', 'settings.local.json', '.mcp.json', 'CLAUDE.md',
  ]);
});

// ---------------------------------------------------------------------------
// codex golden literals
// ---------------------------------------------------------------------------

const CODEX_TOP_DIRS = [
  '.codex', '.omx', '.sandbox', '.sandbox-bin', '.sandbox-secrets', '.tmp',
  'agents', 'ambient-suggestions', 'archived_sessions', 'cache', 'computer-use',
  'computer-use-turn-ended', 'generated_images', 'harness', 'hooks', 'log',
  'memories', 'node_repl', 'pets', 'plugins', 'process_manager', 'prompts',
  'rules', 'sessions', 'skills', 'sqlite', 'tmp', 'vendor_imports', 'worktrees',
];

const CODEX_TOP_FILES = [
  'config.toml', 'AGENTS.md', 'hooks.json', 'auth.json', '.credentials.json',
  '.codex-global-state.json', '.codex-global-state.json.bak', '.personality_migration',
  'cap_sid', 'chrome-native-hosts.json', 'chrome-native-hosts-v2.json',
  'history.jsonl', 'installation_id', 'models_cache.json', 'sandbox.log',
  'session_index.jsonl', 'version.json',
];

test('codex knownTopDirs golden (29 elements)', () => {
  assert.equal(CODEX_TOP_DIRS.length, 29);
  assert.deepEqual(codexDescriptor.knownTopDirs, CODEX_TOP_DIRS);
});

test('codex knownTopFiles golden (17 elements)', () => {
  assert.equal(CODEX_TOP_FILES.length, 17);
  assert.deepEqual(codexDescriptor.knownTopFiles, CODEX_TOP_FILES);
});

test('codex componentKinds golden (3 kinds, prompts=command, agents=flat-toml)', () => {
  assert.deepEqual(codexDescriptor.componentKinds, [
    { kind: 'skill', dir: 'skills', layout: 'skill-md' },
    { kind: 'command', dir: 'prompts', layout: 'flat-md' },
    { kind: 'agent', dir: 'agents', layout: 'flat-toml' },
  ]);
});

test('codex governedConfigFiles golden (3 files)', () => {
  assert.deepEqual(codexDescriptor.governedConfigFiles, [
    'config.toml', 'AGENTS.md', 'hooks.json',
  ]);
});

test('codex identity golden', () => {
  assert.equal(codexDescriptor.id, 'codex');
  assert.equal(codexDescriptor.label, 'OpenAI Codex');
  assert.equal(codexDescriptor.defaultHomeSubdir, '.codex');
  assert.equal(codexDescriptor.signatureFile, 'config.toml');
});

// ---------------------------------------------------------------------------
// hookSource golden (P6.U4) — where each target's effective hooks live
// ---------------------------------------------------------------------------

test('claude hookSource = settings-merge', () => {
  assert.deepEqual(claudeDescriptor.hookSource, { kind: 'settings-merge' });
});

test('codex hookSource = hooks.json json-file under the `hooks` pointer', () => {
  assert.deepEqual(codexDescriptor.hookSource, { kind: 'json-file', file: 'hooks.json', pointer: 'hooks' });
});

test('both descriptors\' hookSource is frozen', () => {
  assert.equal(Object.isFrozen(claudeDescriptor.hookSource), true);
  assert.equal(Object.isFrozen(codexDescriptor.hookSource), true);
});

test('claude configSource = settings-merge', () => {
  assert.deepEqual(claudeDescriptor.configSource, { kind: 'settings-merge' });
});

test('codex configSource = config.toml toml-file', () => {
  assert.deepEqual(codexDescriptor.configSource, { kind: 'toml-file', file: 'config.toml' });
});

test('both descriptors\' configSource is frozen', () => {
  assert.equal(Object.isFrozen(claudeDescriptor.configSource), true);
  assert.equal(Object.isFrozen(codexDescriptor.configSource), true);
});

// ---------------------------------------------------------------------------
// mcpSource golden (P6 TOML wave) — where each target's MCP servers live
// ---------------------------------------------------------------------------

test('claude mcpSource = json-files', () => {
  assert.deepEqual(claudeDescriptor.mcpSource, { kind: 'json-files' });
});

test('codex mcpSource = config.toml mcp_servers toml-table', () => {
  assert.deepEqual(codexDescriptor.mcpSource, { kind: 'toml-table', file: 'config.toml', pointer: 'mcp_servers' });
});

test('both descriptors\' mcpSource is frozen', () => {
  assert.equal(Object.isFrozen(claudeDescriptor.mcpSource), true);
  assert.equal(Object.isFrozen(codexDescriptor.mcpSource), true);
});

// ---------------------------------------------------------------------------
// pluginSource golden (P6 TOML wave) — where each target's plugins live
// ---------------------------------------------------------------------------

test('claude pluginSource = json-file', () => {
  assert.deepEqual(claudeDescriptor.pluginSource, { kind: 'json-file' });
});

test('codex pluginSource = config.toml plugins toml-table', () => {
  assert.deepEqual(codexDescriptor.pluginSource, { kind: 'toml-table', file: 'config.toml', pointer: 'plugins' });
});

test('both descriptors\' pluginSource is frozen', () => {
  assert.equal(Object.isFrozen(claudeDescriptor.pluginSource), true);
  assert.equal(Object.isFrozen(codexDescriptor.pluginSource), true);
});

// ---------------------------------------------------------------------------
// codex pattern falsifiability
// ---------------------------------------------------------------------------

test('codex leftover-bloat pattern matches a real tmp leftover only', () => {
  const [, leftover] = codexDescriptor.knownTopFilePatterns;
  assert.equal(leftover.test('..codex-global-state.json.tmp-1777105478404-x'), true);
  assert.equal(leftover.test('config.toml'), false);
  // the LIVE state file is NOT a tmp leftover (single leading dot, no .tmp- suffix)
  assert.equal(leftover.test('.codex-global-state.json'), false);
});

test('codex leftover pattern is SINGLE-SOURCED: knownTopFilePatterns contains the exact CODEX_STATE_TMP_RE', () => {
  // The orphan detector recognizes these as KNOWN via knownTopFilePatterns, and doctor
  // #28 counts the same files via this same regex (probe-codex-config imports it). Pinning
  // SAME-REFERENCE guarantees the two can never drift into a "known-but-uncounted" /
  // "counted-but-orphan" split.
  assert.ok(codexDescriptor.knownTopFilePatterns.includes(CODEX_STATE_TMP_RE), 'descriptor uses the exported const');
});

test('codex sqlite pattern matches the heavy-runtime family only', () => {
  const [sqlite] = codexDescriptor.knownTopFilePatterns;
  assert.equal(sqlite.test('goals_1.sqlite'), true);
  assert.equal(sqlite.test('logs_2.sqlite-wal'), true);
  assert.equal(sqlite.test('config.toml'), false);
});

test('codex knownTopFilePatterns golden by .source (pins count + order, not just positional probes)', () => {
  assert.equal(codexDescriptor.knownTopFilePatterns.length, 2);
  assert.deepEqual(
    codexDescriptor.knownTopFilePatterns.map((re) => re.source),
    ['^[a-z0-9_]+\\.sqlite(-shm|-wal)?$', '^\\.\\.codex-global-state\\.json\\.tmp-.+$'],
  );
});

// ---------------------------------------------------------------------------
// resolveTarget selection matrix
// ---------------------------------------------------------------------------

test('resolveTarget selection matrix', () => {
  assert.equal(resolveTarget({ target: 'codex' }), codexDescriptor);
  assert.equal(resolveTarget({ target: 'claude' }), claudeDescriptor);
  // absent / empty / no opts → default claude
  assert.equal(resolveTarget({}), claudeDescriptor);
  assert.equal(resolveTarget(undefined), claudeDescriptor);
  assert.equal(resolveTarget(null), claudeDescriptor);
  assert.equal(resolveTarget({ target: '' }), claudeDescriptor);
  // unknown non-empty target → undefined (NOT silently claude)
  assert.equal(resolveTarget({ target: 'bogus' }), undefined);
});

test('resolveTarget is proto-safe: inherited keys never resolve to a function', () => {
  assert.equal(resolveTarget({ target: 'constructor' }), undefined);
  assert.equal(resolveTarget({ target: '__proto__' }), undefined);
  assert.equal(resolveTarget({ target: 'prototype' }), undefined);
  assert.equal(resolveTarget({ target: 'hasOwnProperty' }), undefined);
});

// ---------------------------------------------------------------------------
// frozen
// ---------------------------------------------------------------------------

test('descriptors + registry + each componentKinds entry are frozen', () => {
  assert.equal(Object.isFrozen(claudeDescriptor), true);
  assert.equal(Object.isFrozen(codexDescriptor), true);
  assert.equal(Object.isFrozen(TARGETS), true);
  for (const desc of [claudeDescriptor, codexDescriptor]) {
    assert.equal(Object.isFrozen(desc.componentKinds), true);
    for (const spec of desc.componentKinds) assert.equal(Object.isFrozen(spec), true);
  }
});

// ---------------------------------------------------------------------------
// never-throws
// ---------------------------------------------------------------------------

test('resolveTarget never throws on hostile input', () => {
  assert.doesNotThrow(() => resolveTarget(null));
  assert.doesNotThrow(() => resolveTarget(undefined));
  assert.doesNotThrow(() => resolveTarget(123));
  assert.doesNotThrow(() => resolveTarget('codex'));
  assert.doesNotThrow(() => resolveTarget({ target: 42 }));
  assert.doesNotThrow(() => resolveTarget([]));
});
