/**
 * P6 prune-config wave · U3 — test/prune-config-resolver.test.mjs
 *
 * Oracles for the PURE orphan resolver (src/ops/prune-config.mjs::resolveOrphanConfigOps).
 * No I/O — the config text is passed in. Proves the §5 resolution rule: a `[[skills.config]]`
 * block is an orphan of skill x when name==x OR its path points INSIDE the absolute skill
 * dir; each orphan becomes one config-block-delete op carrying the right (name|path) selector
 * and NO content/desired (so invalidOpReason accepts it). The hard cases: a user-scope
 * same-name skill (different abs dir) is NOT pruned; a duplicate name is refused as ambiguous;
 * an unparseable config refuses; no-orphan / non-skill blocks yield zero ops; never-throws.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveOrphanConfigOps } from '../src/ops/prune-config.mjs';
import { invalidOpReason } from '../src/ops/apply-op-kinds.mjs';

const TARGET = 'C:/Users/me/.codex/config.toml';
const DIR = 'C:/Users/me/.codex/skills/ab-test-setup';

/** Build a config.toml body from `[[skills.config]]` blocks (each {field,value,enabled}). */
function cfg(blocks, lead = 'model = "gpt-5.5"\n\n') {
  return lead + blocks.map((b) =>
    `[[skills.config]]\n${b.field} = "${b.value}"\nenabled = ${b.enabled ?? true}\n`).join('\n');
}

const call = (text, extra = {}) => resolveOrphanConfigOps({
  configText: text, configTarget: TARGET, skillName: 'ab-test-setup', skillDirAbs: DIR, ...extra,
});

test('name-keyed orphan → ONE config-block-delete op with a name selector', () => {
  const r = call(cfg([{ field: 'name', value: 'ab-test-setup' }, { field: 'name', value: 'keep-me' }]));
  assert.equal(r.ok, true);
  assert.equal(r.ops.length, 1);
  const op = r.ops[0];
  assert.equal(op.kind, 'config-block-delete');
  assert.equal(op.target, TARGET);
  assert.deepEqual(op.selector, { kind: 'skill', match: { field: 'name', value: 'ab-test-setup' } });
  assert.equal(op.content, undefined, 'a block-delete carries no content');
  assert.equal(op.desired, undefined, 'a block-delete carries no desired');
  assert.equal(invalidOpReason(op), null, 'the op is valid per apply-op-kinds');
  assert.deepEqual(r.pruned, [{ field: 'name', value: 'ab-test-setup' }]);
});

test('path-keyed orphan → ONE op with a path selector carrying the EXACT path value', () => {
  const p = `${DIR}/SKILL.md`;
  const r = call(cfg([{ field: 'path', value: p }]));
  assert.equal(r.ok, true);
  assert.equal(r.ops.length, 1);
  assert.deepEqual(r.ops[0].selector, { kind: 'skill', match: { field: 'path', value: p } });
});

test('a skill with BOTH a name block AND a path block → TWO ops (both pruned)', () => {
  const p = `${DIR}/SKILL.md`;
  const r = call(cfg([
    { field: 'name', value: 'ab-test-setup' },
    { field: 'name', value: 'other' },
    { field: 'path', value: p },
  ]));
  assert.equal(r.ok, true);
  assert.equal(r.ops.length, 2);
  const fields = r.ops.map((o) => o.selector.match.field).sort();
  assert.deepEqual(fields, ['name', 'path']);
});

test('non-matching blocks are left alone (different name, path in a DIFFERENT skill dir)', () => {
  const r = call(cfg([
    { field: 'name', value: 'unrelated' },
    { field: 'path', value: 'C:/Users/me/.codex/skills/other-skill/SKILL.md' },
  ]));
  assert.equal(r.ok, true);
  assert.equal(r.ops.length, 0);
});

test('user-scope same-name skill is NOT a false-positive orphan (anchored to the absolute home dir)', () => {
  // A coexisting ~/.agents/skills/ab-test-setup/ is a DIFFERENT skill that shares the name.
  const r = call(cfg([{ field: 'path', value: 'C:/Users/me/.agents/skills/ab-test-setup/SKILL.md' }]));
  assert.equal(r.ok, true);
  assert.equal(r.ops.length, 0, 'the user-scope path must not be pruned when removing the home skill');
});

test('a path AT the dir (no trailing file) is NOT inside it → not pruned', () => {
  const r = call(cfg([{ field: 'path', value: DIR }]));
  assert.equal(r.ok, true);
  assert.equal(r.ops.length, 0);
});

test('no [[skills.config]] blocks → ok with zero ops (the dir delete still runs)', () => {
  const r = call('model = "gpt-5.5"\n');
  assert.equal(r.ok, true);
  assert.deepEqual(r.ops, []);
  assert.deepEqual(r.pruned, []);
});

test('duplicate name blocks → REFUSED prune-config-ambiguous (never guess which to delete)', () => {
  const r = call(cfg([
    { field: 'name', value: 'ab-test-setup' },
    { field: 'name', value: 'ab-test-setup' },
  ]));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'prune-config-ambiguous');
  assert.deepEqual(r.ops, []);
});

test('unparseable config → REFUSED prune-config-config-unparseable (no half-prune)', () => {
  const r = call('[[skills.config]\nname = "ab-test-setup"\n'); // missing the second ]
  assert.equal(r.ok, false);
  assert.equal(r.code, 'prune-config-config-unparseable');
});

test('separator normalization: a backslash path value still matches the home dir', () => {
  const r = call(cfg([{ field: 'path', value: 'C:/Users/me/.codex/skills/ab-test-setup/SKILL.md' }]),
    { skillDirAbs: 'C:\\Users\\me\\.codex\\skills\\ab-test-setup' });
  assert.equal(r.ok, true);
  assert.equal(r.ops.length, 1);
});

test('never-throws on junk input', () => {
  for (const junk of [null, undefined, {}, { configText: 42 }, { configText: '' }]) {
    assert.doesNotThrow(() => resolveOrphanConfigOps(junk));
  }
  assert.equal(resolveOrphanConfigOps({ configText: 123 }).ok, false);
});

test('source hygiene: the prune-config modules carry NO raw control bytes', () => {
  // Regression guard for the [[windows-json-unicode-escape-control-bytes]] gotcha — a
  // space typed in a Write param once decoded to a raw 0x00 in the dedup-key separator.
  // These source files have no reason for any control byte (no ANSI/ESC like table.mjs),
  // so any byte in 0x00-0x08/0x0B/0x0C/0x0E-0x1F is a smuggled control byte → fail.
  for (const rel of ['../src/ops/prune-config.mjs', '../src/cli/prune-config-command.mjs']) {
    const buf = readFileSync(new URL(rel, import.meta.url));
    const bad = [];
    for (let i = 0; i < buf.length; i += 1) {
      const b = buf[i];
      if (b < 0x09 || b === 0x0b || b === 0x0c || (b >= 0x0e && b <= 0x1f)) bad.push(`0x${b.toString(16)}@${i}`);
    }
    assert.deepEqual(bad, [], `${rel} has control byte(s): ${bad.join(', ')}`);
  }
});
