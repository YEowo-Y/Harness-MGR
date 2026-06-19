/**
 * Codex remove kind-table derivation (P6 write wave · unit 4).
 *
 * deriveKindSpec turns a target's descriptor componentKinds into the remove
 * {dir,isDir,ext,opKind} table. This pins: (1) the Claude drift-guard — deriving
 * from claudeDescriptor.componentKinds is behaviorally equivalent to the historical
 * KIND_SPEC; (2) the codex table maps agent→agents/.toml, command→prompts/.md,
 * skill→skills/ (dir). See docs/phase-6-codex-remove-design.md.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveKindSpec, KIND_SPEC } from '../src/ops/remove.mjs';
import { claudeDescriptor } from '../src/targets/claude.mjs';
import { codexDescriptor } from '../src/targets/codex.mjs';

test('drift-guard: deriveKindSpec(claude componentKinds) is behaviorally equivalent to KIND_SPEC', () => {
  const derived = deriveKindSpec(claudeDescriptor.componentKinds);
  // Same kinds, same dir/isDir/opKind. The derived table adds ext:'.md' for file kinds,
  // which validateSpec also defaults to ('.md') for KIND_SPEC's ext-less entries.
  for (const kind of ['agent', 'command', 'skill']) {
    assert.equal(derived[kind].dir, KIND_SPEC[kind].dir, `${kind} dir`);
    assert.equal(derived[kind].isDir, KIND_SPEC[kind].isDir, `${kind} isDir`);
    assert.equal(derived[kind].opKind, KIND_SPEC[kind].opKind, `${kind} opKind`);
  }
  // File kinds carry the explicit '.md' ext; the skill dir carries none.
  assert.equal(derived.agent.ext, '.md');
  assert.equal(derived.command.ext, '.md');
  assert.equal(derived.skill.ext, undefined);
});

test('codex: deriveKindSpec maps agent→agents/.toml, command→prompts/.md, skill→skills/ (dir)', () => {
  const t = deriveKindSpec(codexDescriptor.componentKinds);
  assert.deepEqual(t.agent, { dir: 'agents', isDir: false, ext: '.toml', opKind: 'delete' });
  assert.deepEqual(t.command, { dir: 'prompts', isDir: false, ext: '.md', opKind: 'delete' });
  assert.deepEqual(t.skill, { dir: 'skills', isDir: true, opKind: 'delete-dir' });
});

test('deriveKindSpec is proto-safe + never-throws on junk', () => {
  const t = deriveKindSpec(codexDescriptor.componentKinds);
  // null-proto map: inherited keys never resolve.
  assert.equal(Object.getPrototypeOf(t), null);
  assert.equal(t.constructor, undefined);
  // junk inputs → empty table, no throw.
  assert.deepEqual(deriveKindSpec(undefined), Object.create(null));
  assert.deepEqual(deriveKindSpec([{ bad: true }, null, 'x']), Object.create(null));
});
