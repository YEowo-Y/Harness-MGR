/**
 * Tests for `inventory --type skill` visibility enrichment (src/cli/commands.mjs).
 *
 * Against a REAL temp ~/.claude tree (settings.json skillOverrides + skills/<name> dirs):
 * each narrowed skill item carries `visibility` = its skillOverrides state, or 'default' when
 * none. CLAUDE-only (an absent descriptor is the claude default); a codex target omits the field.
 * The map is read via the U1 single read point (mergeSettings(...).effective.skillOverrides).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { inventoryCommand } from '../src/cli/commands.mjs';
import { claudeDescriptor } from '../src/targets/claude.mjs';
import { codexDescriptor } from '../src/targets/codex.mjs';

function buildTree(settings) {
  const dir = mkdtempSync(join(tmpdir(), 'cmgr-inv-vis-'));
  writeFileSync(join(dir, 'settings.json'), settings);
  for (const name of ['alpha', 'beta']) {
    mkdirSync(join(dir, 'skills', name), { recursive: true });
    writeFileSync(join(dir, 'skills', name, 'SKILL.md'), `---\nname: ${name}\n---\n# ${name}\n`);
  }
  return dir;
}

const SETTINGS = JSON.stringify({ model: 'opus', skillOverrides: { alpha: 'off' } }, null, 2) + '\n';

function skillItems(result) {
  return Array.isArray(result.items) ? result.items : [];
}

test('inventory --type skill: overridden skill shows its state, others show default', () => {
  const dir = buildTree(SETTINGS);
  try {
    const { result } = inventoryCommand({ configDir: dir, args: { type: 'skill' }, descriptor: claudeDescriptor });
    const byName = Object.create(null);
    for (const it of skillItems(result)) byName[it.name] = it.visibility;
    assert.equal(byName.alpha, 'off', 'the overridden skill carries its state');
    assert.equal(byName.beta, 'default', 'a non-overridden skill is default');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('inventory --type skill: an absent descriptor is the claude default (field present)', () => {
  const dir = buildTree(SETTINGS);
  try {
    const { result } = inventoryCommand({ configDir: dir, args: { type: 'skill' } });
    assert.ok(skillItems(result).every((it) => typeof it.visibility === 'string'));
    assert.ok(skillItems(result).some((it) => it.name === 'alpha' && it.visibility === 'off'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('inventory --type skill: a codex target OMITS the visibility field', () => {
  const dir = buildTree(SETTINGS);
  try {
    const { result } = inventoryCommand({ configDir: dir, args: { type: 'skill' }, descriptor: codexDescriptor });
    // codex scans skills/ too (same component layout), but skillOverrides is Claude-only → no field.
    assert.ok(skillItems(result).every((it) => !('visibility' in it)), 'codex items carry no visibility');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('inventory --type skill: settings.json without skillOverrides → all default', () => {
  const dir = buildTree(JSON.stringify({ model: 'opus' }) + '\n');
  try {
    const { result } = inventoryCommand({ configDir: dir, args: { type: 'skill' }, descriptor: claudeDescriptor });
    assert.ok(skillItems(result).length >= 2);
    assert.ok(skillItems(result).every((it) => it.visibility === 'default'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('inventory --type agent: visibility enrichment does NOT touch non-skill narrowing', () => {
  const dir = buildTree(SETTINGS);
  try {
    const { result } = inventoryCommand({ configDir: dir, args: { type: 'agent' }, descriptor: claudeDescriptor });
    assert.ok(skillItems(result).every((it) => !('visibility' in it)), 'agents carry no visibility field');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
