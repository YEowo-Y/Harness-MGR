/**
 * P6 config-edit unit — integration/config-edit-codex-roundtrip.test.mjs
 *
 * The end-to-end DoD oracle (and the BLOCKER-1 proof) for codex config.toml in-place
 * mutation, against a REAL temp ~/.codex tree, through the REAL codex gate + codex scope
 * + system tar:
 *   - `disable plugin` --apply takes an auto-snapshot (codex scope captures config.toml
 *     WHOLE) then splices `enabled = true` → `enabled = false` — proving the snapshot
 *     manifest lists config.toml so checkOpTargetsInManifest passes (the apply would
 *     otherwise refuse with apply-target-not-snapshotted);
 *   - a secret (mcp env) byte stays untouched;
 *   - a rollback restores config.toml BYTE-IDENTICAL (the pre-edit enabled=true);
 *   - disable→enable is independently byte-identical (the flip is its own inverse);
 *   - a dry-run writes nothing.
 *
 * GRACEFUL-SKIP when the system tar is unavailable (mirrors the sibling round-trips).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setComponentEnabled } from '../../src/ops/config-edit.mjs';
import { rollbackSnapshot } from '../../src/ops/rollback.mjs';
import { resolveTar } from '../../src/ops/snapshot-tar.mjs';
import { makeAssertWritable, MGR_STATE_DIRNAME } from '../../src/paths.mjs';
import { codexDescriptor } from '../../src/targets/codex.mjs';

const CONFIG = [
  'model = "gpt-5.5"',
  '',
  '[mcp_servers.context7]',
  'command = "npx"',
  '',
  '[mcp_servers.svc]',
  'command = "node"',
  '',
  '[mcp_servers.svc.env]',
  'SECRET = "sk-keep-me-safe-0123456789"',
  '',
  '[plugins."superpowers@openai-curated"]',
  'enabled = true',
  '',
  '[plugins."other@openai-curated"]',
  'enabled = false',
  '',
  '[[skills.config]]',
  'name = "ab-test-setup"',
  'enabled = false',
  '',
  '[[skills.config]]',
  'path = "C:/Users/alice/.codex/skills/ab-test-setup/SKILL.md"',
  'enabled = false',
  '',
].join('\n');

function put(base, rel, bytes) {
  const abs = join(base, ...rel.split('/'));
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, bytes);
}

/** A realistic temp ~/.codex with config.toml + the dirs the codex scope walks. */
function buildCodexTree() {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'cmgr-codex-cfgedit-')));
  mkdirSync(join(tmp, MGR_STATE_DIRNAME), { recursive: true });
  put(tmp, 'config.toml', Buffer.from(CONFIG, 'utf8'));
  put(tmp, 'AGENTS.md', Buffer.from('# AGENTS\n', 'utf8'));
  put(tmp, 'hooks.json', Buffer.from('{"hooks":{}}', 'utf8'));
  put(tmp, 'skills/myskill/SKILL.md', Buffer.from('# skill\n', 'utf8'));
  put(tmp, 'prompts/greet.md', Buffer.from('# greet\n', 'utf8'));
  return tmp;
}

const opts = (tmp) => ({
  targetClaudeDir: tmp,
  mgrStateDir: join(tmp, MGR_STATE_DIRNAME),
  configFile: 'config.toml',
  assertWritable: makeAssertWritable({ configDir: tmp, mgrStateDir: join(tmp, MGR_STATE_DIRNAME), surface: codexDescriptor.writeSurface }),
  scope: codexDescriptor.snapshotScope,
  enableWrites: true,
});

test('codex disable plugin: flips enabled then rolls back BYTE-IDENTICAL (BLOCKER-1 end-to-end)', async (t) => {
  const { tarPath } = resolveTar();
  if (!tarPath) { t.skip('system tar not found — skipping codex config-edit round-trip'); return; }

  const tmp = buildCodexTree();
  const cfg = join(tmp, 'config.toml');
  const before = readFileSync(cfg);
  try {
    const r = await setComponentEnabled({ ...opts(tmp), kind: 'plugin', name: 'superpowers@openai-curated', desired: false });
    assert.equal(r.ok, true, `disable failed: ${JSON.stringify(r.diagnostics)}`);
    assert.equal(r.apply.applied, true, 'a governed write landed');
    const snapshotId = r.apply.snapshotId;
    assert.ok(snapshotId, 'an auto-snapshot was taken (config.toml captured whole)');

    const after = readFileSync(cfg, 'utf8');
    assert.ok(after.includes('[plugins."superpowers@openai-curated"]\nenabled = false'), 'the plugin was disabled');
    assert.ok(after.includes('enabled = false\n\n[plugins."other@openai-curated"]\nenabled = false'), 'the other plugin is untouched');
    assert.ok(after.includes('SECRET = "sk-keep-me-safe-0123456789"'), 'the mcp env secret is byte-identical');

    // rollback restores the pre-edit config.toml byte-identical (proves reversibility).
    const rb = await rollbackSnapshot({
      mgrStateDir: join(tmp, MGR_STATE_DIRNAME), targetClaudeDir: tmp, snapshotId,
      assertWritable: opts(tmp).assertWritable, force: true, enableWrites: true, expectedTarget: tmp,
    });
    assert.equal(rb.status, 'restored', `rollback failed: ${JSON.stringify(rb.diagnostics)}`);
    assert.ok(Buffer.compare(readFileSync(cfg), before) === 0, 'config.toml restored byte-identical (enabled = true again)');
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

test('codex disable MCP: INSERTS enabled=false, secret intact, then rolls back BYTE-IDENTICAL', async (t) => {
  const { tarPath } = resolveTar();
  if (!tarPath) { t.skip('system tar not found — skipping codex mcp insert round-trip'); return; }

  const tmp = buildCodexTree();
  const cfg = join(tmp, 'config.toml');
  const before = readFileSync(cfg);
  try {
    const r = await setComponentEnabled({ ...opts(tmp), kind: 'mcp', name: 'context7', desired: false });
    assert.equal(r.ok, true, `mcp disable failed: ${JSON.stringify(r.diagnostics)}`);
    assert.equal(r.apply.applied, true);
    assert.ok(r.diagnostics.some((d) => d.code === 'config-edit-mcp-loader-unverified'), 'honest caveat surfaced on apply');
    const snapshotId = r.apply.snapshotId;

    const after = readFileSync(cfg, 'utf8');
    assert.ok(after.includes('[mcp_servers.context7]\nenabled = false\ncommand = "npx"'), 'enabled=false inserted as the first body line');
    assert.ok(after.includes('SECRET = "sk-keep-me-safe-0123456789"'), 'the mcp env secret is byte-identical');
    // the insert is structurally before the secret sub-table
    assert.ok(after.indexOf('enabled = false') < after.indexOf('[mcp_servers.svc.env]'));

    // a SECOND disable apply is a safe no-op (idempotent — no write, no snapshot)
    const again = await setComponentEnabled({ ...opts(tmp), kind: 'mcp', name: 'context7', desired: false });
    assert.equal(again.ok, true);
    assert.equal(again.alreadyInState, true);
    assert.equal(readFileSync(cfg, 'utf8'), after, 'second disable wrote nothing');

    // rollback removes the inserted line → config.toml byte-identical to the key-absent original
    const rb = await rollbackSnapshot({
      mgrStateDir: join(tmp, MGR_STATE_DIRNAME), targetClaudeDir: tmp, snapshotId,
      assertWritable: opts(tmp).assertWritable, force: true, enableWrites: true, expectedTarget: tmp,
    });
    assert.equal(rb.status, 'restored', `rollback failed: ${JSON.stringify(rb.diagnostics)}`);
    assert.ok(Buffer.compare(readFileSync(cfg), before) === 0, 'config.toml restored byte-identical (no enabled key)');
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

test('codex enable skill by NAME then by PATH: flips the selected element, secret intact, rolls back BYTE-IDENTICAL', async (t) => {
  const { tarPath } = resolveTar();
  if (!tarPath) { t.skip('system tar not found — skipping codex skill round-trip'); return; }

  const tmp = buildCodexTree();
  const cfg = join(tmp, 'config.toml');
  const before = readFileSync(cfg);
  try {
    // enable the NAME-keyed skill (false → true) — the path-keyed sibling for the same skill must stay disabled.
    const r = await setComponentEnabled({ ...opts(tmp), kind: 'skill', name: 'ab-test-setup', desired: true, now: () => new Date(1700000003000) });
    assert.equal(r.ok, true, `skill enable failed: ${JSON.stringify(r.diagnostics)}`);
    assert.equal(r.apply.applied, true);
    assert.equal(r.field, 'name');
    const snapshotId = r.apply.snapshotId;

    const after = readFileSync(cfg, 'utf8');
    assert.ok(after.includes('name = "ab-test-setup"\nenabled = true'), 'the name-keyed skill was enabled');
    assert.ok(after.includes('skills/ab-test-setup/SKILL.md"\nenabled = false'), 'the path-keyed sibling is untouched');
    assert.ok(after.includes('SECRET = "sk-keep-me-safe-0123456789"'), 'mcp env secret byte-identical');

    const rb = await rollbackSnapshot({
      mgrStateDir: join(tmp, MGR_STATE_DIRNAME), targetClaudeDir: tmp, snapshotId,
      assertWritable: opts(tmp).assertWritable, force: true, enableWrites: true, expectedTarget: tmp,
    });
    assert.equal(rb.status, 'restored', `rollback failed: ${JSON.stringify(rb.diagnostics)}`);
    assert.ok(Buffer.compare(readFileSync(cfg), before) === 0, 'config.toml restored byte-identical');

    // now enable the PATH-keyed sibling through the --path selector (false → true).
    const p = await setComponentEnabled({ ...opts(tmp), kind: 'skill', name: 'C:/Users/alice/.codex/skills/ab-test-setup/SKILL.md', selectorField: 'path', desired: true, now: () => new Date(1700000009000) });
    assert.equal(p.ok, true, `skill path enable failed: ${JSON.stringify(p.diagnostics)}`);
    assert.equal(p.field, 'path');
    const afterP = readFileSync(cfg, 'utf8');
    assert.ok(afterP.includes('skills/ab-test-setup/SKILL.md"\nenabled = true'), 'the path-keyed skill was enabled');
    assert.ok(afterP.includes('name = "ab-test-setup"\nenabled = false'), 'the name-keyed sibling stays disabled');
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

test('codex disable→enable round-trip is BYTE-IDENTICAL (the flip is its own inverse)', async (t) => {
  const { tarPath } = resolveTar();
  if (!tarPath) { t.skip('system tar not found — skipping codex config-edit inverse'); return; }

  const tmp = buildCodexTree();
  const cfg = join(tmp, 'config.toml');
  const before = readFileSync(cfg);
  try {
    const d = await setComponentEnabled({ ...opts(tmp), kind: 'plugin', name: 'superpowers@openai-curated', desired: false, now: () => new Date(1700000000000) });
    assert.equal(d.ok, true, `disable failed: ${JSON.stringify(d.diagnostics)}`);
    assert.ok(Buffer.compare(readFileSync(cfg), before) !== 0, 'disable changed the file');
    const e = await setComponentEnabled({ ...opts(tmp), kind: 'plugin', name: 'superpowers@openai-curated', desired: true, now: () => new Date(1700000005000) });
    assert.equal(e.ok, true, `enable failed: ${JSON.stringify(e.diagnostics)}`);
    assert.ok(Buffer.compare(readFileSync(cfg), before) === 0, 'disable then enable returns byte-identical');
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

test('codex disable dry-run previews + writes nothing (real fs)', async () => {
  const tmp = buildCodexTree();
  const cfg = join(tmp, 'config.toml');
  const before = readFileSync(cfg);
  try {
    const r = await setComponentEnabled({
      targetClaudeDir: tmp, mgrStateDir: join(tmp, MGR_STATE_DIRNAME), configFile: 'config.toml',
      kind: 'plugin', name: 'superpowers@openai-curated', desired: false, // no enableWrites → dry-run
    });
    assert.equal(r.ok, true);
    assert.equal(r.dryRun, true);
    assert.equal(r.diff.before, 'enabled = true');
    assert.equal(r.diff.after, 'enabled = false');
    assert.ok(Buffer.compare(readFileSync(cfg), before) === 0, 'dry-run wrote nothing');
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});
