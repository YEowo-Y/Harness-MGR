/**
 * Claude skill-visibility — integration/skill-visibility-claude-roundtrip.test.mjs
 *
 * The end-to-end DoD oracle for Claude settings.json skillOverrides in-place mutation, against a
 * REAL temp ~/.claude tree, through the REAL Claude gate ('apply' context) + the DEFAULT Claude
 * snapshot scope + system tar:
 *   - CREATE (the common first case): skillOverrides is ABSENT → --apply auto-snapshots (the default
 *     claude scope captures settings.json WHOLE → checkOpTargetsInManifest passes, reversibility is
 *     free) then CREATES the map; a rollback removes it BYTE-IDENTICAL;
 *   - FLIP: an existing member's state changes, env + sibling stay byte-identical, rollback restores;
 *   - create→flip→rollback chains back to the created state byte-identical;
 *   - a dry-run writes nothing.
 *
 * GRACEFUL-SKIP when the system tar is unavailable (mirrors the sibling round-trips). Uses a TEMP
 * tree only — NEVER the real ~/.claude.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setSkillVisibility } from '../../src/ops/skill-visibility.mjs';
import { rollbackSnapshot } from '../../src/ops/rollback.mjs';
import { resolveTar } from '../../src/ops/snapshot-tar.mjs';
import { makeAssertWritable, MGR_STATE_DIRNAME } from '../../src/paths.mjs';

const NO_MAP = [
  '{',
  '  "model": "opus",',
  '  "env": { "SECRET": "sk-keep-me-safe-0123456789" }',
  '}',
  '',
].join('\n');

const WITH_MAP = [
  '{',
  '  "model": "opus",',
  '  "skillOverrides": {',
  '    "x": "off",',
  '    "y": "name-only"',
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

/** A realistic temp ~/.claude with the given settings.json + the dirs the default Claude scope
 *  walks, plus a directory-backed skill `x` so the advisory WARN does not fire for name 'x'. */
function buildClaudeTree(settings) {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'cmgr-claude-skillvis-')));
  mkdirSync(join(tmp, MGR_STATE_DIRNAME), { recursive: true });
  put(tmp, 'settings.json', Buffer.from(settings, 'utf8'));
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
  enableWrites: true,
});

test('claude skill visibility CREATE: builds the absent skillOverrides map then rolls back BYTE-IDENTICAL', async (t) => {
  const { tarPath } = resolveTar();
  if (!tarPath) { t.skip('system tar not found — skipping skill-visibility create round-trip'); return; }

  const tmp = buildClaudeTree(NO_MAP);
  const settings = join(tmp, 'settings.json');
  const before = readFileSync(settings);
  try {
    const r = await setSkillVisibility({ ...opts(tmp), name: 'x', state: 'off' });
    assert.equal(r.ok, true, `create failed: ${JSON.stringify(r.diagnostics)}`);
    assert.equal(r.apply.applied, true, 'a governed write landed');
    const snapshotId = r.apply.snapshotId;
    assert.ok(snapshotId, 'an auto-snapshot was taken (settings.json captured whole)');

    const parsed = JSON.parse(readFileSync(settings, 'utf8'));
    assert.equal(parsed.skillOverrides.x, 'off', 'the map was created with the member');
    assert.equal(parsed.model, 'opus', 'a sibling key is intact');
    assert.equal(parsed.env.SECRET, 'sk-keep-me-safe-0123456789', 'env intact');

    const rb = await rollbackSnapshot({
      mgrStateDir: join(tmp, MGR_STATE_DIRNAME), targetClaudeDir: tmp, snapshotId,
      assertWritable: opts(tmp).assertWritable, force: true, enableWrites: true, expectedTarget: tmp,
    });
    assert.equal(rb.status, 'restored', `rollback failed: ${JSON.stringify(rb.diagnostics)}`);
    assert.ok(Buffer.compare(readFileSync(settings), before) === 0, 'settings.json restored byte-identical (no skillOverrides map)');
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

test('claude skill visibility FLIP: changes a member then rolls back BYTE-IDENTICAL', async (t) => {
  const { tarPath } = resolveTar();
  if (!tarPath) { t.skip('system tar not found — skipping skill-visibility flip round-trip'); return; }

  const tmp = buildClaudeTree(WITH_MAP);
  const settings = join(tmp, 'settings.json');
  const before = readFileSync(settings);
  try {
    const r = await setSkillVisibility({ ...opts(tmp), name: 'x', state: 'on' });
    assert.equal(r.ok, true, `flip failed: ${JSON.stringify(r.diagnostics)}`);
    const snapshotId = r.apply.snapshotId;

    const after = readFileSync(settings, 'utf8');
    assert.ok(after.includes('"x": "on"'), 'the member flipped to on');
    assert.ok(after.includes('"y": "name-only"'), 'the sibling member is untouched');
    assert.ok(after.includes('sk-keep-me-safe-0123456789'), 'the env secret is byte-identical');

    const rb = await rollbackSnapshot({
      mgrStateDir: join(tmp, MGR_STATE_DIRNAME), targetClaudeDir: tmp, snapshotId,
      assertWritable: opts(tmp).assertWritable, force: true, enableWrites: true, expectedTarget: tmp,
    });
    assert.equal(rb.status, 'restored', `rollback failed: ${JSON.stringify(rb.diagnostics)}`);
    assert.ok(Buffer.compare(readFileSync(settings), before) === 0, 'settings.json restored byte-identical (member back to off)');
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

test('claude skill visibility create→flip is the inverse back to the created state (byte-identical)', async (t) => {
  const { tarPath } = resolveTar();
  if (!tarPath) { t.skip('system tar not found — skipping skill-visibility create→flip inverse'); return; }

  const tmp = buildClaudeTree(NO_MAP);
  const settings = join(tmp, 'settings.json');
  try {
    const c = await setSkillVisibility({ ...opts(tmp), name: 'x', state: 'off', now: () => new Date(1700000000000) });
    assert.equal(c.ok, true, `create failed: ${JSON.stringify(c.diagnostics)}`);
    const created = readFileSync(settings);
    assert.ok(JSON.parse(created.toString('utf8')).skillOverrides.x === 'off');

    const up = await setSkillVisibility({ ...opts(tmp), name: 'x', state: 'on', now: () => new Date(1700000005000) });
    assert.equal(up.ok, true, `flip-on failed: ${JSON.stringify(up.diagnostics)}`);
    assert.ok(Buffer.compare(readFileSync(settings), created) !== 0, 'flip-on changed the file');

    const back = await setSkillVisibility({ ...opts(tmp), name: 'x', state: 'off', now: () => new Date(1700000010000) });
    assert.equal(back.ok, true, `flip-back failed: ${JSON.stringify(back.diagnostics)}`);
    assert.ok(Buffer.compare(readFileSync(settings), created) === 0, 'flip on then off returns byte-identical to the created state');
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

test('claude skill visibility dry-run previews + writes nothing (real fs)', async () => {
  const tmp = buildClaudeTree(NO_MAP);
  const settings = join(tmp, 'settings.json');
  const before = readFileSync(settings);
  try {
    const r = await setSkillVisibility({
      targetClaudeDir: tmp, mgrStateDir: join(tmp, MGR_STATE_DIRNAME),
      name: 'x', state: 'off', // no enableWrites → dry-run
    });
    assert.equal(r.ok, true);
    assert.equal(r.dryRun, true);
    assert.ok(r.diff && r.diff.after.includes('skillOverrides'), 'preview shows the would-be map creation');
    assert.ok(Buffer.compare(readFileSync(settings), before) === 0, 'dry-run wrote nothing');
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});
