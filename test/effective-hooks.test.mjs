/**
 * effective-hooks.test.mjs (P6.U4) — the target-aware hook source.
 *
 * gatherEffectiveHooks dispatches on descriptor.hookSource: 'settings-merge'
 * (Claude / default) reads the merged settings layers; 'json-file' (Codex) reads
 * a standalone hooks.json's `.hooks`. Oracles cover both kinds, the pre-merged
 * `effective` reuse path, the benign-missing / warn-on-malformed / ignore-sibling
 * cases, proto-safety, and never-throws.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { gatherEffectiveHooks } from '../src/cli/effective-hooks.mjs';
import { readSettingsLayers } from '../src/cli/settings-layers.mjs';
import { mergeSettings } from '../src/analysis/settings-merge.mjs';
import { claudeDescriptor } from '../src/targets/claude.mjs';
import { codexDescriptor } from '../src/targets/codex.mjs';

/** A fresh temp config dir; caller cleans up. */
function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'mgr-eff-hooks-'));
}

const CC_HOOKS = {
  PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node "$HOME/.claude/hooks/x.mjs"' }] }],
};
const CODEX_HOOKS = {
  SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'powershell.exe -File "C:\\h.ps1"' }] }],
};

// ── settings-merge source (Claude / default) ──────────────────────────────────

test('settings-merge: no descriptor reads settings.json hooks (default source)', () => {
  const dir = tmpDir();
  try {
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ hooks: CC_HOOKS }), 'utf8');
    const { hooks } = gatherEffectiveHooks({ configDir: dir });
    assert.ok(Array.isArray(hooks.PreToolUse), 'merged settings hooks returned');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('settings-merge: claude descriptor behaves identically to no descriptor', () => {
  const dir = tmpDir();
  try {
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ hooks: CC_HOOKS }), 'utf8');
    const a = gatherEffectiveHooks({ configDir: dir });
    const b = gatherEffectiveHooks({ configDir: dir, descriptor: claudeDescriptor });
    assert.deepEqual(a, b);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('settings-merge: pre-merged `effective` is reused (no re-read, no diagnostics)', () => {
  // configDir points NOWHERE meaningful — if effective were ignored and the dir
  // re-read, hooks would be {}. The reuse path must return effective.hooks.
  const { hooks, diagnostics } = gatherEffectiveHooks({
    configDir: join(tmpdir(), 'does-not-exist-xyz'),
    descriptor: claudeDescriptor,
    effective: { hooks: CC_HOOKS },
  });
  assert.ok(Array.isArray(hooks.PreToolUse), 'reused effective.hooks');
  assert.deepEqual(diagnostics, [], 'reuse path emits no diagnostics');
});

test('settings-merge: an unreadable settings.json surfaces the layer diagnostics', () => {
  const dir = tmpDir();
  try {
    // genuinely-invalid JSON → readSettingsLayers emits settings-unreadable, which
    // gatherEffectiveHooks must forward (byte-identical to the pre-U4 hooksCommand
    // `[...layers, ...merge]` diagnostics).
    writeFileSync(join(dir, 'settings.json'), '{ not valid json', 'utf8');
    const { diagnostics } = gatherEffectiveHooks({ configDir: dir });
    assert.ok(diagnostics.some((d) => d.code === 'settings-unreadable'), 'layer diagnostics surface on the settings-merge path');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('settings-merge: diagnostics are BYTE-IDENTICAL to the pre-U4 `[...layers, ...merge]` expression', () => {
  // Composition guard for the byte-identical claim (reviewer LOW): the settings-merge
  // path must return exactly the concatenation the pre-U4 hooksCommand computed.
  // (Order between layer-vs-merge diagnostics is unobservable here — mergeSettings
  // only emits a diagnostic on a non-array input, which readSettingsLayers never
  // produces — so this pins COMPOSITION: no diagnostic dropped, added, or duplicated.)
  const dir = tmpDir();
  try {
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ hooks: CC_HOOKS }), 'utf8');
    // an unreadable local layer makes layers.diagnostics non-empty (non-vacuous).
    writeFileSync(join(dir, 'settings.local.json'), '{ broken', 'utf8');
    const layers = readSettingsLayers(dir);
    const merged = mergeSettings(layers.layers);
    const expected = [...layers.diagnostics, ...merged.diagnostics];
    const { hooks, diagnostics } = gatherEffectiveHooks({ configDir: dir });
    assert.deepEqual(diagnostics, expected, 'diagnostics equal the recomputed pre-U4 concatenation');
    assert.ok(expected.length >= 1, 'the oracle is non-vacuous (a layer diagnostic is present)');
    assert.ok(Array.isArray(hooks.PreToolUse), 'the user-layer hooks still come through');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── json-file source (Codex) ──────────────────────────────────────────────────

test('json-file: codex descriptor reads hooks.json .hooks, ignoring the state sibling', () => {
  const dir = tmpDir();
  try {
    writeFileSync(join(dir, 'hooks.json'), JSON.stringify({ hooks: CODEX_HOOKS, state: { foo: { trusted_hash: 'x' } } }), 'utf8');
    const { hooks, diagnostics } = gatherEffectiveHooks({ configDir: dir, descriptor: codexDescriptor });
    assert.ok(Array.isArray(hooks.SessionStart), 'returned .hooks');
    assert.equal(hooks.state, undefined, 'the state sibling is NOT returned');
    assert.deepEqual(diagnostics, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('json-file: a MISSING hooks.json is benign — {} with no diagnostic', () => {
  const dir = tmpDir();
  try {
    const { hooks, diagnostics } = gatherEffectiveHooks({ configDir: dir, descriptor: codexDescriptor });
    assert.deepEqual(hooks, {});
    assert.deepEqual(diagnostics, [], 'no hooks configured is valid — no warn');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('json-file: a MALFORMED hooks.json surfaces ONE hooks-file-invalid warn + empty map', () => {
  const dir = tmpDir();
  try {
    writeFileSync(join(dir, 'hooks.json'), '{ this is : not json', 'utf8');
    const { hooks, diagnostics } = gatherEffectiveHooks({ configDir: dir, descriptor: codexDescriptor });
    assert.deepEqual(hooks, {});
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].code, 'hooks-file-invalid');
    assert.equal(diagnostics[0].severity, 'warn');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('json-file: a hooks.json with NO .hooks pointer (only state) → {}', () => {
  const dir = tmpDir();
  try {
    writeFileSync(join(dir, 'hooks.json'), JSON.stringify({ state: { foo: 1 } }), 'utf8');
    const { hooks, diagnostics } = gatherEffectiveHooks({ configDir: dir, descriptor: codexDescriptor });
    assert.deepEqual(hooks, {});
    assert.deepEqual(diagnostics, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('json-file: a __proto__ pointer key never pollutes (proto-safe)', () => {
  const dir = tmpDir();
  try {
    // The pointer is 'hooks' (proto-safe), and a literal __proto__ inside the file
    // is parsed by parseJsonc into an own key, not the prototype.
    writeFileSync(join(dir, 'hooks.json'), '{ "hooks": { "__proto__": { "polluted": true }, "Stop": [] } }', 'utf8');
    const { hooks } = gatherEffectiveHooks({ configDir: dir, descriptor: codexDescriptor });
    assert.equal(({}).polluted, undefined, 'Object.prototype must not be polluted');
    assert.ok(Array.isArray(hooks.Stop), 'real event key preserved');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── never-throws ──────────────────────────────────────────────────────────────

test('gatherEffectiveHooks never throws on junk input', () => {
  assert.doesNotThrow(() => gatherEffectiveHooks());
  assert.doesNotThrow(() => gatherEffectiveHooks(null));
  assert.doesNotThrow(() => gatherEffectiveHooks({}));
  assert.doesNotThrow(() => gatherEffectiveHooks({ configDir: 42, descriptor: codexDescriptor }));
  assert.doesNotThrow(() => gatherEffectiveHooks({ configDir: '/x', descriptor: { hookSource: 'garbage' } }));
});

test('a malformed descriptor.hookSource degrades to the settings-merge default (never a stray file read)', () => {
  const dir = tmpDir();
  try {
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ hooks: CC_HOOKS }), 'utf8');
    // hookSource.kind is json-file but `file` is missing → must NOT attempt a read;
    // falls back to settings-merge and returns the settings hooks.
    const { hooks } = gatherEffectiveHooks({ configDir: dir, descriptor: { hookSource: { kind: 'json-file' } } });
    assert.ok(Array.isArray(hooks.PreToolUse), 'degraded to settings-merge');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
