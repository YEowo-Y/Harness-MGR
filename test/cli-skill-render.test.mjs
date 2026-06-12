/**
 * Unit oracles for the skill:propose table renderer (P5.U8 sub-unit C).
 *
 * The happy-path roundtrip (test/integration/skill-propose-roundtrip.test.mjs)
 * only ever feeds skillProposeTable a COMPLETE result object, so it never
 * exercises the renderer's defensive fallback branches: a non-object argument,
 * an absent `provenanceWritten`, an empty `unified`, and scalar()'s object /
 * cyclic-object (JSON.stringify-throws) arms. These tests drive each branch with
 * a crafted input and assert the exact rendered text — falsifiable oracles that
 * pin the renderer's never-throws contract and keep its branch coverage honest.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { skillProposeTable } from '../src/cli/skill-render.mjs';

test('skillProposeTable: full apply result renders summary + provenance + unified', () => {
  const out = skillProposeTable({
    status: 'proposed',
    name: 'my-skill',
    proposalId: 'SKILL.proposed-2026-01-01T00-00-00Z.md',
    target: '/c/.claude/skills/my-skill/SKILL.proposed-2026-01-01T00-00-00Z.md',
    changed: true,
    provenanceWritten: true,
    unified: '--- a\n+++ b\n-old\n+new',
  });
  assert.match(out, /^status: proposed$/m);
  assert.match(out, /^name: my-skill$/m);
  assert.match(out, /^proposal: SKILL\.proposed-2026-01-01T00-00-00Z\.md$/m);
  assert.match(out, /^changed: true$/m);
  assert.match(out, /^provenanceWritten: true$/m);
  // The raw unified diff block is appended verbatim after a blank line.
  assert.ok(out.includes('\n\n--- a\n+++ b\n-old\n+new'), 'unified block appended verbatim');
});

test('skillProposeTable: provenanceWritten:false is still rendered (the === false arm)', () => {
  const out = skillProposeTable({ status: 'failed', provenanceWritten: false });
  assert.match(out, /^provenanceWritten: false$/m);
});

test('skillProposeTable: dry-run (no provenance, no unified) omits both optional blocks', () => {
  const out = skillProposeTable({
    status: 'dry-run', name: 'foo', proposalId: 'SKILL.proposed-x.md',
    target: '/t', changed: true,
    // provenanceWritten ABSENT (dry-run never writes); unified ABSENT.
  });
  assert.doesNotMatch(out, /provenanceWritten/);
  // No trailing blank-line + diff block when unified is absent.
  assert.ok(!out.includes('\n\n'), 'no unified block when unified is absent');
  assert.match(out, /^status: dry-run$/m);
});

test('skillProposeTable: empty-string unified is treated as absent (length 0 branch)', () => {
  const out = skillProposeTable({ status: 'proposed', unified: '' });
  assert.ok(!out.includes('\n\n'), 'empty unified does not append a block');
});

test('skillProposeTable: non-object argument falls back to an all-empty summary', () => {
  for (const bad of [null, undefined, 42, 'nope', ['a'], true]) {
    const out = skillProposeTable(bad);
    // isObj() false → {} → every scalar() is '' → fixed five-line empty summary.
    assert.equal(out, 'status: \nname: \nproposal: \ntarget: \nchanged: ',
      `non-object ${JSON.stringify(bad)} → empty summary`);
  }
});

test('skillProposeTable: a plain-object field is JSON-stringified by scalar()', () => {
  const out = skillProposeTable({ status: { code: 7 }, name: 'x' });
  assert.match(out, /^status: \{"code":7\}$/m);
});

test('skillProposeTable: a cyclic-object field hits scalar() catch → String() fallback, never throws', () => {
  const cyclic = {};
  cyclic.self = cyclic; // JSON.stringify throws on this
  let out;
  assert.doesNotThrow(() => { out = skillProposeTable({ status: cyclic, name: 'x' }); });
  assert.match(out, /^status: \[object Object\]$/m);
  assert.match(out, /^name: x$/m);
});

test('skillProposeTable: scalar() renders booleans/numbers and blanks null/undefined fields', () => {
  const out = skillProposeTable({ status: 0, name: null, proposalId: undefined, changed: false });
  assert.match(out, /^status: 0$/m);
  assert.match(out, /^name: $/m);
  assert.match(out, /^proposal: $/m);
  assert.match(out, /^changed: false$/m);
});
