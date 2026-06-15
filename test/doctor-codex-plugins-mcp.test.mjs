/**
 * doctor-codex-plugins-mcp.test.mjs (P6 doctor wave) — end-to-end gather + runDoctor
 * oracles proving the doctor SEES codex's config.toml plugins + MCP servers once
 * gatherDoctorInput threads the descriptor, and judges them with the correct
 * target-aware enable model.
 *
 * Headline falsifiable oracles (hermetic — temp config.toml, mirroring the codex
 * hook tests in doctor-facts.test.mjs):
 *   - record-flag enable model: #8 plugin-installed-not-enabled fires for the DISABLED
 *     plugin only (mutation oracle — would be 2 if the enable model regressed to the
 *     empty settings map); #7 plugin-enabled-not-installed is structurally 0.
 *   - mcp visibility: a config.toml stdio server is probed by #2 mcp-server-resolvable
 *     (RED if scan() were descriptor-free → mcpServers empty → #2 = 0).
 *   - #11 duplicate-component-shadowing is structurally empty for codex (one dir per
 *     kind → no same-(kind,key) collision, even when a skill and an agent share a name).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { gatherDoctorInput } from '../src/cli/doctor-facts.mjs';
import { runDoctor } from '../src/analysis/doctor/index.mjs';
import { codexDescriptor } from '../src/targets/codex.mjs';

const byCode = (diags, code) => diags.filter((d) => d.code === code);

test('codex: record-flag enable model → #8 fires for the disabled plugin only, #7 = 0 (mutation oracle)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mgr-codex-doctor-'));
  try {
    writeFileSync(join(dir, 'config.toml'), [
      '[plugins."alpha@mkt"]',
      'enabled = true',
      '[plugins."beta@mkt"]',
      'enabled = false',
      '',
    ].join('\n'), 'utf8');

    const { input } = await gatherDoctorInput({ configDir: dir, mgrStateDir: join(dir, '.mgr-state'), descriptor: codexDescriptor });

    // installedPlugins = the two config.toml entries; enabledPlugins synthesized from each record's flag.
    const keys = input.installedPlugins.map((p) => p.key).sort();
    assert.deepEqual(keys, ['alpha@mkt', 'beta@mkt']);
    assert.equal(input.enabledPlugins['alpha@mkt'], true);
    assert.equal(input.enabledPlugins['beta@mkt'], false);

    const r = runDoctor(input);
    const notEnabled = byCode(r.diagnostics, 'plugin-installed-not-enabled');
    // HEADLINE MUTATION ORACLE: exactly ONE #8 (beta), naming beta — NOT alpha. If the
    // enable model regressed to the empty settings map, BOTH would flag → length 2.
    assert.equal(notEnabled.length, 1, 'exactly one dormant-plugin finding');
    assert.match(notEnabled[0].message, /beta@mkt/);
    assert.ok(notEnabled.every((d) => !/alpha@mkt/.test(d.message)), 'alpha (enabled) is not flagged');
    // #7 plugin-enabled-not-installed is structurally 0 for codex (every key is also installed).
    assert.equal(byCode(r.diagnostics, 'plugin-enabled-not-installed').length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('codex: scan(descriptor) surfaces config.toml MCP servers → #2 probes an unresolvable stdio command', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mgr-codex-mcp-'));
  try {
    writeFileSync(join(dir, 'config.toml'), [
      '[mcp_servers.ghost]',
      'command = "__mgr_definitely_not_on_path_zzz__"',
      '',
    ].join('\n'), 'utf8');

    const { input } = await gatherDoctorInput({ configDir: dir, mgrStateDir: join(dir, '.mgr-state'), descriptor: codexDescriptor });
    const ghost = (input.mcpResolution || []).find((m) => m.command === '__mgr_definitely_not_on_path_zzz__');
    assert.ok(ghost, 'the codex config.toml MCP server is visible to the probe (RED if scan() were descriptor-free)');
    assert.equal(ghost.resolved, false);

    const r = runDoctor(input);
    const resolvable = byCode(r.diagnostics, 'mcp-server-resolvable');
    assert.ok(resolvable.some((d) => /__mgr_definitely_not_on_path_zzz__/.test(d.message)), '#2 warns the unresolvable codex command');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('codex: #11 duplicate-component-shadowing is structurally empty (one dir per kind)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mgr-codex-shadow-'));
  try {
    // Two distinct skills + an agent toml sharing a NAME with a skill — different KINDS,
    // so analyzeConflicts groups by (kind, key) and produces no cluster.
    mkdirSync(join(dir, 'skills', 'one'), { recursive: true });
    writeFileSync(join(dir, 'skills', 'one', 'SKILL.md'), '---\nname: one\n---\nbody', 'utf8');
    mkdirSync(join(dir, 'skills', 'two'), { recursive: true });
    writeFileSync(join(dir, 'skills', 'two', 'SKILL.md'), '---\nname: two\n---\nbody', 'utf8');
    mkdirSync(join(dir, 'agents'), { recursive: true });
    writeFileSync(join(dir, 'agents', 'one.toml'), 'name = "one"\n', 'utf8');

    const { input } = await gatherDoctorInput({ configDir: dir, mgrStateDir: join(dir, '.mgr-state'), descriptor: codexDescriptor });
    assert.equal(input.conflicts.length, 0, 'no same-(kind,key) clusters in codex single-dir layout');
    const r = runDoctor(input);
    assert.equal(byCode(r.diagnostics, 'duplicate-component-shadowing').length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
