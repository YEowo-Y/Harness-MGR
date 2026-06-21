/**
 * Claude plugin-toggle — integration/plugin-toggle-claude-roundtrip.test.mjs
 *
 * The end-to-end DoD oracle for Claude settings.json enabledPlugins in-place mutation,
 * against a REAL temp ~/.claude tree, through the REAL Claude gate ('apply' context) +
 * the DEFAULT Claude snapshot scope + system tar:
 *   - `disable plugin` --apply auto-snapshots (the default claude scope captures settings.json
 *     WHOLE → checkOpTargetsInManifest passes, reversibility is free) then flips true→false;
 *   - the env block + the sibling plugin stay byte-identical;
 *   - a rollback restores settings.json BYTE-IDENTICAL;
 *   - enabling an ABSENT plugin INSERTS the member, then rollback removes it byte-identical;
 *   - disable→enable is its own inverse (byte-identical);
 *   - a dry-run writes nothing.
 *
 * GRACEFUL-SKIP when the system tar is unavailable (mirrors the sibling round-trips). Uses a
 * TEMP tree only — NEVER the real ~/.claude.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setPluginEnabledClaude } from '../../src/ops/plugin-toggle.mjs';
import { rollbackSnapshot } from '../../src/ops/rollback.mjs';
import { resolveTar } from '../../src/ops/snapshot-tar.mjs';
import { makeAssertWritable, MGR_STATE_DIRNAME } from '../../src/paths.mjs';

const SETTINGS = [
  '{',
  '  "model": "opus",',
  '  "enabledPlugins": {',
  '    "ecc@everything-claude-code": true,',
  '    "gsap@gsap-skills": false',
  '  },',
  '  "env": { "SECRET": "sk-keep-me-safe-0123456789" }',
  '}',
  '',
].join('\n');

function put(base, rel, bytes) {
  const abs = join(base, ...rel.split('/'));
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, bytes);
}

/** A realistic temp ~/.claude with settings.json + the dirs the default Claude scope walks. */
function buildClaudeTree() {
  const tmp = mkdtempSync(join(tmpdir(), 'cmgr-claude-plugtoggle-'));
  mkdirSync(join(tmp, MGR_STATE_DIRNAME), { recursive: true });
  put(tmp, 'settings.json', Buffer.from(SETTINGS, 'utf8'));
  put(tmp, 'CLAUDE.md', Buffer.from('# CLAUDE\n', 'utf8'));
  put(tmp, 'agents/foo.md', Buffer.from('# agent\n', 'utf8'));
  put(tmp, 'skills/x/SKILL.md', Buffer.from('# skill\n', 'utf8'));
  put(tmp, 'commands/y.md', Buffer.from('# command\n', 'utf8'));
  return tmp;
}

/** Engine opts bound to the temp tree + the default Claude gate ('apply' context). */
const opts = (tmp) => ({
  targetClaudeDir: tmp,
  mgrStateDir: join(tmp, MGR_STATE_DIRNAME),
  assertWritable: makeAssertWritable({ configDir: tmp, mgrStateDir: join(tmp, MGR_STATE_DIRNAME) }),
  // scope omitted → the default Claude snapshot scope (captures settings.json)
  enableWrites: true,
});

test('claude disable plugin: flips enabled then rolls back BYTE-IDENTICAL (reversibility end-to-end)', async (t) => {
  const { tarPath } = resolveTar();
  if (!tarPath) { t.skip('system tar not found — skipping claude plugin-toggle round-trip'); return; }

  const tmp = buildClaudeTree();
  const settings = join(tmp, 'settings.json');
  const before = readFileSync(settings);
  try {
    const r = await setPluginEnabledClaude({ ...opts(tmp), key: 'ecc@everything-claude-code', desired: false });
    assert.equal(r.ok, true, `disable failed: ${JSON.stringify(r.diagnostics)}`);
    assert.equal(r.apply.applied, true, 'a governed write landed');
    const snapshotId = r.apply.snapshotId;
    assert.ok(snapshotId, 'an auto-snapshot was taken (settings.json captured whole)');

    const after = readFileSync(settings, 'utf8');
    assert.ok(after.includes('"ecc@everything-claude-code": false'), 'the plugin was disabled');
    assert.ok(after.includes('"gsap@gsap-skills": false'), 'the sibling plugin is untouched');
    assert.ok(after.includes('sk-keep-me-safe-0123456789'), 'the env secret is byte-identical');

    const rb = await rollbackSnapshot({
      mgrStateDir: join(tmp, MGR_STATE_DIRNAME), targetClaudeDir: tmp, snapshotId,
      assertWritable: opts(tmp).assertWritable, force: true, enableWrites: true, expectedTarget: tmp,
    });
    assert.equal(rb.status, 'restored', `rollback failed: ${JSON.stringify(rb.diagnostics)}`);
    assert.ok(Buffer.compare(readFileSync(settings), before) === 0, 'settings.json restored byte-identical (enabled true again)');
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

test('claude enable an ABSENT plugin: INSERTS the member, then rolls back BYTE-IDENTICAL', async (t) => {
  const { tarPath } = resolveTar();
  if (!tarPath) { t.skip('system tar not found — skipping claude plugin insert round-trip'); return; }

  const tmp = buildClaudeTree();
  const settings = join(tmp, 'settings.json');
  const before = readFileSync(settings);
  try {
    const r = await setPluginEnabledClaude({ ...opts(tmp), key: 'fresh@mkt', desired: true });
    assert.equal(r.ok, true, `enable-insert failed: ${JSON.stringify(r.diagnostics)}`);
    assert.equal(r.apply.applied, true);
    const snapshotId = r.apply.snapshotId;

    const parsed = JSON.parse(readFileSync(settings, 'utf8'));
    assert.equal(parsed.enabledPlugins['fresh@mkt'], true, 'the new plugin was inserted enabled');
    assert.equal(parsed.enabledPlugins['ecc@everything-claude-code'], true, 'an existing plugin is intact');
    assert.equal(parsed.env.SECRET, 'sk-keep-me-safe-0123456789', 'env intact');

    const rb = await rollbackSnapshot({
      mgrStateDir: join(tmp, MGR_STATE_DIRNAME), targetClaudeDir: tmp, snapshotId,
      assertWritable: opts(tmp).assertWritable, force: true, enableWrites: true, expectedTarget: tmp,
    });
    assert.equal(rb.status, 'restored', `rollback failed: ${JSON.stringify(rb.diagnostics)}`);
    assert.ok(Buffer.compare(readFileSync(settings), before) === 0, 'settings.json restored byte-identical (no inserted member)');
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

test('claude disable→enable round-trip is BYTE-IDENTICAL (the flip is its own inverse)', async (t) => {
  const { tarPath } = resolveTar();
  if (!tarPath) { t.skip('system tar not found — skipping claude plugin-toggle inverse'); return; }

  const tmp = buildClaudeTree();
  const settings = join(tmp, 'settings.json');
  const before = readFileSync(settings);
  try {
    const d = await setPluginEnabledClaude({ ...opts(tmp), key: 'ecc@everything-claude-code', desired: false, now: () => new Date(1700000000000) });
    assert.equal(d.ok, true, `disable failed: ${JSON.stringify(d.diagnostics)}`);
    assert.ok(Buffer.compare(readFileSync(settings), before) !== 0, 'disable changed the file');
    const e = await setPluginEnabledClaude({ ...opts(tmp), key: 'ecc@everything-claude-code', desired: true, now: () => new Date(1700000005000) });
    assert.equal(e.ok, true, `enable failed: ${JSON.stringify(e.diagnostics)}`);
    assert.ok(Buffer.compare(readFileSync(settings), before) === 0, 'disable then enable returns byte-identical');
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

test('claude disable dry-run previews + writes nothing (real fs)', async () => {
  const tmp = buildClaudeTree();
  const settings = join(tmp, 'settings.json');
  const before = readFileSync(settings);
  try {
    const r = await setPluginEnabledClaude({
      targetClaudeDir: tmp, mgrStateDir: join(tmp, MGR_STATE_DIRNAME),
      key: 'ecc@everything-claude-code', desired: false, // no enableWrites → dry-run
    });
    assert.equal(r.ok, true);
    assert.equal(r.dryRun, true);
    assert.ok(r.diff.before.includes('true'));
    assert.ok(r.diff.after.includes('false'));
    assert.ok(Buffer.compare(readFileSync(settings), before) === 0, 'dry-run wrote nothing');
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});
