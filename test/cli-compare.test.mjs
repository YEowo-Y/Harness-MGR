/**
 * Command + wiring tests for `compare`.
 *
 * Covers what the pure analysis test (compare.test.mjs) cannot: the COMMANDS
 * registry entry, the never-throws handler contract, the SIBLING-dir resolution
 * (active config dir → other target found alongside it), the --detail flag, the
 * end-to-end run() json envelope, and the render body.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compareCommand, COMMANDS } from '../src/cli/commands.mjs';
import { run } from '../src/cli.mjs';
import { renderTable } from '../src/cli/render.mjs';
import { claudeDescriptor } from '../src/targets/claude.mjs';

/** Materialise skills/<name>/SKILL.md under a config root so discovery finds them. */
function writeSkill(root, name) {
  const dir = join(root, 'skills', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\n---\n# ${name}\n`, 'utf-8');
}

/** A sandbox with a .claude (skills: a, shared) + .codex (skills: b, shared) sibling pair. */
function buildDualSandbox() {
  const box = mkdtempSync(join(tmpdir(), 'cmp-'));
  const cc = join(box, '.claude');
  const cx = join(box, '.codex');
  writeSkill(cc, 'a'); writeSkill(cc, 'shared');
  writeSkill(cx, 'b'); writeSkill(cx, 'shared');
  return { box, claudeDir: cc };
}

// ── A. REGISTRY ───────────────────────────────────────────────────────────────

test('compare is registered in COMMANDS and re-exported', () => {
  assert.equal(typeof COMMANDS.compare, 'function');
  assert.equal(typeof compareCommand, 'function');
});

// ── B. NEVER-THROWS on a missing target ───────────────────────────────────────

test('never-throws: a non-existent config dir yields a sane report + target-absent', () => {
  let out;
  assert.doesNotThrow(() => {
    out = compareCommand({ configDir: join(tmpdir(), 'definitely-not-here-xyz', '.claude'), descriptor: claudeDescriptor, args: {} });
  });
  assert.ok('result' in out && Array.isArray(out.diagnostics));
  assert.ok(Array.isArray(out.result.targets) && Array.isArray(out.result.categories) && Array.isArray(out.result.items));
  assert.ok(out.diagnostics.some((d) => d.code === 'compare-target-absent'), 'absent dirs are surfaced so a zero count is not read as "empty"');
});

// ── C. SIBLING-DIR RESOLUTION (the golden path) ───────────────────────────────

test('sibling resolution: active .claude finds the .codex alongside it and diffs', () => {
  const { box, claudeDir } = buildDualSandbox();
  try {
    const { result, diagnostics } = compareCommand({ configDir: claudeDir, descriptor: claudeDescriptor, args: {} });
    const skill = result.categories.find((c) => c.category === 'skill');
    assert.equal(skill.both, 1, '"shared" is on both targets');
    assert.equal(skill.only.claude, 1, '"a" is claude-only');
    assert.equal(skill.only.codex, 1, '"b" is codex-only');

    const divergent = result.items.filter((i) => i.category === 'skill').map((i) => ({ name: i.name, presence: i.presence }));
    assert.deepEqual(divergent, [{ name: 'a', presence: 'claude-only' }, { name: 'b', presence: 'codex-only' }]);
    assert.ok(!diagnostics.some((d) => d.code === 'compare-target-absent'), 'both sibling dirs exist → no absent diagnostic');
    assert.ok(diagnostics.some((d) => d.code === 'compare-name-match-not-content'), 'the honesty caveat is carried through the command');
  } finally {
    rmSync(box, { recursive: true, force: true });
  }
});

test('--detail flips result.detail (controls only the human render, not items)', () => {
  const { box, claudeDir } = buildDualSandbox();
  try {
    const plain = compareCommand({ configDir: claudeDir, descriptor: claudeDescriptor, args: {} });
    const detailed = compareCommand({ configDir: claudeDir, descriptor: claudeDescriptor, args: { detail: true } });
    assert.equal(plain.result.detail, false);
    assert.equal(detailed.result.detail, true);
    assert.deepEqual(plain.result.items, detailed.result.items, 'items are complete regardless of --detail');
  } finally {
    rmSync(box, { recursive: true, force: true });
  }
});

// ── D. END-TO-END via run() ───────────────────────────────────────────────────

test('run(): compare --format json emits the versioned envelope, exit 0', async () => {
  const { box, claudeDir } = buildDualSandbox();
  try {
    const out = await run(['compare', '--config-dir', claudeDir, '--format', 'json']);
    assert.equal(out.code, 0, 'a pure report with only info/warn diagnostics exits 0');
    const env = JSON.parse(out.stdout);
    assert.equal(env.command, 'compare');
    assert.ok(Array.isArray(env.result.categories) && env.result.categories.length === 5);
  } finally {
    rmSync(box, { recursive: true, force: true });
  }
});

// ── E. RENDER BODY ────────────────────────────────────────────────────────────

test('render: compare table shows the counts header and a --detail hint', () => {
  const { box, claudeDir } = buildDualSandbox();
  try {
    const { result } = compareCommand({ configDir: claudeDir, descriptor: claudeDescriptor, args: {} });
    const body = renderTable('compare', result);
    assert.equal(typeof body, 'string');
    assert.match(body, /category/, 'has the counts table header');
    assert.match(body, /divergent item\(s\)/, 'without --detail, shows the count hint not the full list');

    const detailedBody = renderTable('compare', { ...result, detail: true });
    assert.match(detailedBody, /only in/, '--detail expands to the divergent-item table');
  } finally {
    rmSync(box, { recursive: true, force: true });
  }
});
