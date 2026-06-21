/**
 * P6 prune-config wave · U3 — test/prune-config.test.mjs
 *
 * Unit tests for the pruneConfigRemove orchestrator (src/ops/prune-config.mjs). The skill
 * dir is a REAL temp dir (validateSpec lstats it); the config read + apply lifecycle are
 * injected seams (readConfigFn / applyFn), so the engine is otherwise hermetic.
 *
 * Proves: dry-run builds the ONE combined plan (delete-dir FIRST, then N config-block-delete)
 * and calls applyFn NEVER; a non-skill kind refuses BEFORE the existence probe; a missing
 * skill / gateless --apply / unreadable config are clean refusals; --apply forwards the combined
 * plan + codex scope to applyFn; never-throws.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pruneConfigRemove } from '../src/ops/prune-config.mjs';
import { codexDescriptor } from '../src/targets/codex.mjs';

/** A temp ~/.codex with skills/<name>/SKILL.md so validateSpec's lstat passes. */
function tree(skill = 'ab-test-setup') {
  const tmp = mkdtempSync(join(tmpdir(), 'cmgr-prune-'));
  mkdirSync(join(tmp, 'skills', skill), { recursive: true });
  writeFileSync(join(tmp, 'skills', skill, 'SKILL.md'), '# skill\n');
  return tmp;
}

/** A config.toml referencing the skill by BOTH name and path (the abs path under tmp). */
function cfgFor(tmp, skill = 'ab-test-setup') {
  const p = join(tmp, 'skills', skill, 'SKILL.md').replace(/\\/g, '/');
  return [
    'model = "gpt-5.5"', '',
    '[[skills.config]]', `name = "${skill}"`, 'enabled = false', '',
    '[[skills.config]]', `path = "${p}"`, 'enabled = false', '',
    '[[skills.config]]', 'name = "keep-me"', 'enabled = true', '',
  ].join('\n');
}

const baseOpts = (tmp) => ({
  targetClaudeDir: tmp,
  mgrStateDir: join(tmp, '.mgr-state'),
  componentKinds: codexDescriptor.componentKinds,
  scope: codexDescriptor.snapshotScope,
  configFile: 'config.toml',
});

test('dry-run: builds the combined plan (delete-dir + 2 block-deletes), applyFn NOT called', async () => {
  const tmp = tree();
  let called = 0;
  try {
    const r = await pruneConfigRemove({
      ...baseOpts(tmp), spec: 'skill:ab-test-setup',
      readConfigFn: () => cfgFor(tmp), seams: { applyFn: async () => { called += 1; return { ok: true }; } },
    });
    assert.equal(r.ok, true);
    assert.equal(r.dryRun, true);
    assert.equal(r.refused, false);
    assert.equal(r.prunedCount, 2);
    assert.equal(called, 0, 'dry-run must not call applyFn');
    // delete-dir is FIRST, then the two config-block-delete ops.
    assert.equal(r.plan.ops.length, 3);
    assert.equal(r.plan.ops[0].kind, 'delete-dir');
    assert.equal(r.plan.ops[0].target, join(tmp, 'skills', 'ab-test-setup'));
    assert.equal(r.plan.ops[1].kind, 'config-block-delete');
    assert.equal(r.plan.ops[2].kind, 'config-block-delete');
    assert.equal(r.plan.apply, false, 'dry-run plan is not marked apply');
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('dry-run with NO orphan entries → just the delete-dir op + a clear note', async () => {
  const tmp = tree();
  try {
    const r = await pruneConfigRemove({
      ...baseOpts(tmp), spec: 'skill:ab-test-setup',
      readConfigFn: () => 'model = "gpt-5.5"\n',
    });
    assert.equal(r.ok, true);
    assert.equal(r.prunedCount, 0);
    assert.equal(r.plan.ops.length, 1);
    assert.equal(r.plan.ops[0].kind, 'delete-dir');
    assert.ok(r.diagnostics.some((d) => d.code === 'prune-config-dry-run'));
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('non-skill kind refuses prune-config-kind-unsupported BEFORE any existence probe', async () => {
  // No tree needed: the kind check short-circuits before validateSpec lstats anything.
  const r = await pruneConfigRemove({
    targetClaudeDir: 'C:/nope', mgrStateDir: 'C:/nope/.mgr-state',
    componentKinds: codexDescriptor.componentKinds, spec: 'agent:architect',
    readConfigFn: () => { throw new Error('must not read config'); },
  });
  assert.equal(r.refused, true);
  assert.equal(r.diagnostics[0].code, 'prune-config-kind-unsupported');
});

test('missing skill dir → refused (shared remove validation, no apply)', async () => {
  const tmp = tree();
  try {
    const r = await pruneConfigRemove({
      ...baseOpts(tmp), spec: 'skill:does-not-exist', readConfigFn: () => cfgFor(tmp),
    });
    assert.equal(r.refused, true);
    assert.equal(r.diagnostics.some((d) => d.code === 'remove-target-not-found'), true);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('unreadable config → refused prune-config-config-not-found (skill dir NOT deleted)', async () => {
  const tmp = tree();
  try {
    const r = await pruneConfigRemove({
      ...baseOpts(tmp), spec: 'skill:ab-test-setup',
      readConfigFn: () => { throw new Error('ENOENT'); },
    });
    assert.equal(r.refused, true);
    assert.equal(r.diagnostics.some((d) => d.code === 'prune-config-config-not-found'), true);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('--apply without a gate → refused prune-config-bad-args (plan built, never applied)', async () => {
  const tmp = tree();
  let called = 0;
  try {
    const r = await pruneConfigRemove({
      ...baseOpts(tmp), spec: 'skill:ab-test-setup', enableWrites: true,
      readConfigFn: () => cfgFor(tmp), seams: { applyFn: async () => { called += 1; return { ok: true }; } },
    });
    assert.equal(r.refused, true);
    assert.equal(r.diagnostics.some((d) => d.code === 'prune-config-bad-args'), true);
    assert.equal(called, 0);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('--apply forwards the combined plan + codex scope to applyFn and reports ok', async () => {
  const tmp = tree();
  let seen = null;
  try {
    const r = await pruneConfigRemove({
      ...baseOpts(tmp), spec: 'skill:ab-test-setup', enableWrites: true, assertWritable: () => 'ok',
      readConfigFn: () => cfgFor(tmp),
      seams: { applyFn: async (a) => { seen = a; return { ok: true, applied: true, snapshotId: 'snap-1', diagnostics: [] }; } },
    });
    assert.equal(r.ok, true);
    assert.equal(r.dryRun, false);
    assert.equal(seen.enableWrites, true);
    assert.equal(seen.scope, codexDescriptor.snapshotScope, 'codex scope forwarded so the snapshot captures skills/ + config.toml');
    assert.equal(seen.plan.ops.length, 3, 'the combined delete-dir + 2 block-deletes plan reached applyFn');
    assert.equal(seen.plan.ops[0].kind, 'delete-dir');
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('never-throws on junk opts', async () => {
  for (const junk of [undefined, null, {}, { spec: 42 }]) {
    const r = await pruneConfigRemove(junk);
    assert.equal(typeof r, 'object');
    assert.equal(r.ok, false);
  }
});
