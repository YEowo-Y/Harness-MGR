/**
 * P6 prune-config wave · U3 — integration/prune-config-codex-roundtrip.test.mjs
 *
 * The end-to-end DoD oracle for `remove skill:<name> --prune-config` against a REAL temp
 * ~/.codex tree, through the REAL codex gate + codex scope + system tar:
 *   - removing skill `ab-test-setup --prune-config --apply` deletes skills/ab-test-setup/
 *     AND prunes BOTH the name-keyed and the path-keyed [[skills.config]] entries that
 *     reference it, under ONE auto-snapshot;
 *   - a sibling skill's config entry AND the mcp env secret stay byte-untouched;
 *   - ONE rollback restores BOTH the skill dir and config.toml BYTE-IDENTICAL (proving the
 *     codex scope captured skills/ + config.toml so checkOpTargetsInManifest passed for both);
 *   - a dry-run previews + writes nothing.
 *
 * GRACEFUL-SKIP when the system tar is unavailable (mirrors the sibling round-trips).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pruneConfigRemove } from '../../src/ops/prune-config.mjs';
import { rollbackSnapshot } from '../../src/ops/rollback.mjs';
import { resolveTar } from '../../src/ops/snapshot-tar.mjs';
import { makeAssertWritable, MGR_STATE_DIRNAME } from '../../src/paths.mjs';
import { codexDescriptor } from '../../src/targets/codex.mjs';

function put(base, rel, bytes) {
  const abs = join(base, ...rel.split('/'));
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, bytes);
}

/** A realistic temp ~/.codex: config.toml references `ab-test-setup` by BOTH name and path
 *  (the path absolute under THIS tree, so the resolver's home-dir anchor matches), plus a
 *  sibling skill entry + an mcp secret that must survive. */
function buildCodexTree() {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'cmgr-codex-prune-')));
  const skillPath = join(tmp, 'skills', 'ab-test-setup', 'SKILL.md').replace(/\\/g, '/');
  const config = [
    'model = "gpt-5.5"', '',
    '[mcp_servers.svc]', 'command = "node"', '',
    '[mcp_servers.svc.env]', 'SECRET = "sk-keep-me-safe-0123456789"', '',
    '[[skills.config]]', 'name = "ab-test-setup"', 'enabled = false', '',
    '[[skills.config]]', `path = "${skillPath}"`, 'enabled = false', '',
    '[[skills.config]]', 'name = "keep-me"', 'enabled = true', '',
  ].join('\n');
  mkdirSync(join(tmp, MGR_STATE_DIRNAME), { recursive: true });
  put(tmp, 'config.toml', Buffer.from(config, 'utf8'));
  put(tmp, 'AGENTS.md', Buffer.from('# AGENTS\n', 'utf8'));
  put(tmp, 'hooks.json', Buffer.from('{"hooks":{}}', 'utf8'));
  put(tmp, 'skills/ab-test-setup/SKILL.md', Buffer.from('# ab-test-setup\n', 'utf8'));
  put(tmp, 'skills/keep-me/SKILL.md', Buffer.from('# keep-me\n', 'utf8'));
  put(tmp, 'prompts/greet.md', Buffer.from('# greet\n', 'utf8'));
  return tmp;
}

const opts = (tmp) => ({
  targetClaudeDir: tmp,
  mgrStateDir: join(tmp, MGR_STATE_DIRNAME),
  configFile: 'config.toml',
  componentKinds: codexDescriptor.componentKinds,
  scope: codexDescriptor.snapshotScope,
  assertWritable: makeAssertWritable({ configDir: tmp, mgrStateDir: join(tmp, MGR_STATE_DIRNAME), surface: codexDescriptor.writeSurface }),
  enableWrites: true,
});

test('prune-config --apply: deletes skill + BOTH config entries, then ONE rollback restores both BYTE-IDENTICAL', async (t) => {
  const { tarPath } = resolveTar();
  if (!tarPath) { t.skip('system tar not found — skipping codex prune-config round-trip'); return; }

  const tmp = buildCodexTree();
  const cfg = join(tmp, 'config.toml');
  const skillDir = join(tmp, 'skills', 'ab-test-setup');
  const configBefore = readFileSync(cfg);
  const skillBefore = readFileSync(join(skillDir, 'SKILL.md'));
  try {
    const r = await pruneConfigRemove({ ...opts(tmp), spec: 'skill:ab-test-setup' });
    assert.equal(r.ok, true, `prune failed: ${JSON.stringify(r.diagnostics)}`);
    assert.equal(r.apply.applied, true, 'a governed write landed');
    assert.equal(r.prunedCount, 2, 'both the name and path entries were pruned');
    const snapshotId = r.apply.snapshotId;
    assert.ok(snapshotId, 'one auto-snapshot captured skills/ + config.toml');

    // the skill dir is gone
    assert.equal(existsSync(skillDir), false, 'skills/ab-test-setup deleted');
    // both ab-test-setup config blocks are gone; the sibling + secret survive
    const after = readFileSync(cfg, 'utf8');
    assert.ok(!after.includes('name = "ab-test-setup"'), 'name entry pruned');
    assert.ok(!after.includes('skills/ab-test-setup/SKILL.md'), 'path entry pruned');
    assert.ok(after.includes('name = "keep-me"'), 'the sibling skill entry survives');
    assert.ok(after.includes('SECRET = "sk-keep-me-safe-0123456789"'), 'the mcp env secret is byte-identical');

    // ONE rollback restores BOTH the skill dir and config.toml byte-identical.
    const rb = await rollbackSnapshot({
      mgrStateDir: join(tmp, MGR_STATE_DIRNAME), targetClaudeDir: tmp, snapshotId,
      assertWritable: opts(tmp).assertWritable, force: true, enableWrites: true, expectedTarget: tmp,
    });
    assert.equal(rb.status, 'restored', `rollback failed: ${JSON.stringify(rb.diagnostics)}`);
    assert.ok(Buffer.compare(readFileSync(cfg), configBefore) === 0, 'config.toml restored byte-identical (both entries back)');
    assert.equal(existsSync(join(skillDir, 'SKILL.md')), true, 'skill dir restored');
    assert.ok(Buffer.compare(readFileSync(join(skillDir, 'SKILL.md')), skillBefore) === 0, 'skill file restored byte-identical');
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

test('prune-config dry-run previews 2 entries + writes nothing (real fs)', async () => {
  const tmp = buildCodexTree();
  const cfg = join(tmp, 'config.toml');
  const before = readFileSync(cfg);
  try {
    const r = await pruneConfigRemove({
      targetClaudeDir: tmp, mgrStateDir: join(tmp, MGR_STATE_DIRNAME), configFile: 'config.toml',
      componentKinds: codexDescriptor.componentKinds, scope: codexDescriptor.snapshotScope,
      spec: 'skill:ab-test-setup', // no enableWrites → dry-run
    });
    assert.equal(r.ok, true);
    assert.equal(r.dryRun, true);
    assert.equal(r.prunedCount, 2);
    assert.equal(existsSync(join(tmp, 'skills', 'ab-test-setup')), true, 'dry-run deleted NOTHING');
    assert.ok(Buffer.compare(readFileSync(cfg), before) === 0, 'dry-run wrote nothing to config.toml');
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});
