/**
 * P6 write wave · unit 4 — integration/remove-codex-roundtrip.test.mjs
 *
 * The end-to-end DoD oracle for codex remove: removing each codex component kind
 * (command→prompts/*.md, agent→agents/*.toml, skill→skills/<dir>) against a REAL
 * temp ~/.codex tree, through the REAL codex gate + codex scope + system tar:
 *   - the auto-snapshot (keepAll, codex scope) captures the target so the delete is
 *     reversible (checkOpTargetsInManifest passes — esp. for prompts/, which a Claude
 *     scope would NOT capture);
 *   - the governed delete goes through the codex remove/remove-skill gate;
 *   - a rollback restores the deleted component byte-identical.
 *
 * GRACEFUL-SKIP when the system tar is unavailable (mirrors the sibling round-trips).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeComponent } from '../../src/ops/remove.mjs';
import { rollbackSnapshot } from '../../src/ops/rollback.mjs';
import { resolveTar } from '../../src/ops/snapshot-tar.mjs';
import { makeAssertWritable, MGR_STATE_DIRNAME } from '../../src/paths.mjs';
import { codexDescriptor } from '../../src/targets/codex.mjs';

function put(base, rel, bytes) {
  const abs = join(base, ...rel.split('/'));
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, bytes);
}

function buildCodexTree() {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'cmgr-codex-rm-')));
  mkdirSync(join(tmp, MGR_STATE_DIRNAME), { recursive: true });
  put(tmp, 'config.toml', Buffer.from('model = "gpt-5.5"\n', 'utf8'));
  put(tmp, 'AGENTS.md', Buffer.from('# AGENTS\n', 'utf8'));
  put(tmp, 'hooks.json', Buffer.from('{"hooks":{}}', 'utf8'));
  put(tmp, 'skills/myskill/SKILL.md', Buffer.from('# 技能\n', 'utf8'));
  put(tmp, 'prompts/greet.md', Buffer.from('# greet\nhello\n', 'utf8'));
  put(tmp, 'agents/architect.toml', Buffer.from('name = "architect"\n', 'utf8'));
  return tmp;
}

const codexRemoveOpts = (tmp) => ({
  targetClaudeDir: tmp,
  mgrStateDir: join(tmp, MGR_STATE_DIRNAME),
  assertWritable: makeAssertWritable({ configDir: tmp, mgrStateDir: join(tmp, MGR_STATE_DIRNAME), surface: codexDescriptor.writeSurface }),
  componentKinds: codexDescriptor.componentKinds,
  scope: codexDescriptor.snapshotScope,
  enableWrites: true,
});

test('codex remove: command (prompts/*.md) deletes then rolls back byte-identical', async (t) => {
  const { tarPath } = resolveTar();
  if (!tarPath) { t.skip('system tar not found — skipping codex remove round-trip'); return; }

  const tmp = buildCodexTree();
  const promptAbs = join(tmp, 'prompts', 'greet.md');
  const promptV1 = readFileSync(promptAbs);
  try {
    // remove command:greet --apply → auto-snapshot (codex scope captures prompts/) then delete.
    const r = await removeComponent({ ...codexRemoveOpts(tmp), spec: 'command:greet' });
    assert.equal(r.ok, true, `remove failed: ${JSON.stringify(r.diagnostics)}`);
    assert.equal(existsSync(promptAbs), false, 'prompts/greet.md deleted');
    const snapshotId = r.apply.snapshotId;
    assert.ok(snapshotId, 'an auto-snapshot was taken');

    // rollback --apply → prompts/greet.md restored byte-identical (proves the snapshot
    // captured it, i.e. the codex scope reached prompts/ which a Claude scope would miss).
    const rb = await rollbackSnapshot({
      mgrStateDir: join(tmp, MGR_STATE_DIRNAME), targetClaudeDir: tmp, snapshotId,
      assertWritable: codexRemoveOpts(tmp).assertWritable, force: true, enableWrites: true, expectedTarget: tmp,
    });
    assert.equal(rb.status, 'restored', `rollback failed: ${JSON.stringify(rb.diagnostics)}`);
    assert.equal(existsSync(promptAbs), true, 'prompts/greet.md restored');
    assert.ok(Buffer.compare(readFileSync(promptAbs), promptV1) === 0, 'restored byte-identical');
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

test('codex remove: agent (agents/*.toml) and skill (skills/<dir>) delete through the codex gate', async (t) => {
  const { tarPath } = resolveTar();
  if (!tarPath) { t.skip('system tar not found — skipping codex agent/skill remove'); return; }

  const tmp = buildCodexTree();
  try {
    // Distinct timestamps so the two auto-snapshots get distinct (second-resolution) ids.
    const agent = await removeComponent({ ...codexRemoveOpts(tmp), spec: 'agent:architect', now: () => new Date(1700000000000) });
    assert.equal(agent.ok, true, `agent remove failed: ${JSON.stringify(agent.diagnostics)}`);
    assert.equal(agent.target, join(tmp, 'agents', 'architect.toml'), 'agent resolved to the .toml leaf');
    assert.equal(existsSync(join(tmp, 'agents', 'architect.toml')), false, 'agent .toml deleted');

    const skill = await removeComponent({ ...codexRemoveOpts(tmp), spec: 'skill:myskill', now: () => new Date(1700000005000) });
    assert.equal(skill.ok, true, `skill remove failed: ${JSON.stringify(skill.diagnostics)}`);
    assert.equal(existsSync(join(tmp, 'skills', 'myskill')), false, 'skill dir deleted');
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

test('codex remove: dry-run (no enableWrites) previews + writes nothing', async () => {
  const tmp = buildCodexTree();
  try {
    const r = await removeComponent({
      targetClaudeDir: tmp, mgrStateDir: join(tmp, MGR_STATE_DIRNAME),
      componentKinds: codexDescriptor.componentKinds, scope: codexDescriptor.snapshotScope,
      spec: 'command:greet', // dry-run: no enableWrites, no assertWritable needed
    });
    assert.equal(r.ok, true);
    assert.equal(r.dryRun, true);
    assert.equal(r.target, join(tmp, 'prompts', 'greet.md'), 'dry-run resolves the codex prompts/ target');
    assert.equal(existsSync(join(tmp, 'prompts', 'greet.md')), true, 'dry-run deleted NOTHING');
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});
