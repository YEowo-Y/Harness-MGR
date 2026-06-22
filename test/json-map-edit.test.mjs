/**
 * U1 oracle for json-map-edit.mjs — setStringMember + applyVerifiedMapEdit + findStringMemberSpan.
 *
 * Falsifiable: pins flip/insert/CREATE-MAP/noop/error outcomes, byte-preservation outside the
 * edited span, round-trip identity, that the verify accepts a clean edit and the result re-parses
 * to the desired skillOverrides value, and that a non-string value is refused by TYPE (never bytes).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setStringMember, applyVerifiedMapEdit, findStringMemberSpan } from '../src/lib/json-map-edit.mjs';
import { parseJsonc } from '../src/lib/jsonc-parser.mjs';

const MAP = 'skillOverrides';

// settings.json WITH an existing skillOverrides map.
const WITH_MAP = `{
  "model": "opus",
  "skillOverrides": {
    "deep-research": "off",
    "tdd": "name-only"
  },
  "env": { "SECRET_TOKEN": "sk-must-not-be-touched" }
}
`;

// settings.json WITHOUT skillOverrides — the common first case (create the map).
const NO_MAP = `{
  "model": "opus",
  "env": { "SECRET_TOKEN": "sk-must-not-be-touched" }
}
`;

// ── setStringMember: flip / insert / create / noop ───────────────────────────────

test('flip: changing an existing member rewrites ONLY the one string token', () => {
  const r = setStringMember(WITH_MAP, MAP, 'deep-research', 'on');
  assert.equal(r.changed, true);
  assert.equal(r.reason, 'flipped');
  assert.ok(r.before.includes('off'));
  assert.ok(r.after.includes('on'));
  assert.equal(r.text, WITH_MAP.replace('"deep-research": "off"', '"deep-research": "on"'));
  assert.ok(r.text.includes('sk-must-not-be-touched'));
});

test('noop-already: setting a member to its current value writes nothing', () => {
  const r = setStringMember(WITH_MAP, MAP, 'tdd', 'name-only');
  assert.equal(r.changed, false);
  assert.equal(r.reason, 'noop-already');
  assert.equal(r.text, WITH_MAP);
});

test('insert: a member absent from an existing map is added, valid JSON, env untouched', () => {
  const r = setStringMember(WITH_MAP, MAP, 'avoid-ai-writing', 'user-invocable-only');
  assert.equal(r.changed, true);
  assert.equal(r.reason, 'inserted');
  const parsed = parseJsonc(r.text);
  assert.equal(parsed.errors.length, 0);
  assert.equal(parsed.value.skillOverrides['avoid-ai-writing'], 'user-invocable-only');
  assert.equal(parsed.value.skillOverrides['deep-research'], 'off'); // sibling intact
  assert.equal(parsed.value.env.SECRET_TOKEN, 'sk-must-not-be-touched'); // env intact
});

test('create: an ABSENT map is created as a new top-level member, env intact', () => {
  const r = setStringMember(NO_MAP, MAP, 'deep-research', 'off');
  assert.equal(r.changed, true);
  assert.equal(r.reason, 'created');
  const parsed = parseJsonc(r.text);
  assert.equal(parsed.errors.length, 0);
  assert.equal(parsed.value.skillOverrides['deep-research'], 'off');
  assert.equal(parsed.value.model, 'opus'); // sibling intact
  assert.equal(parsed.value.env.SECRET_TOKEN, 'sk-must-not-be-touched'); // env intact
});

test('create into an empty root object yields valid JSON', () => {
  const r = setStringMember('{}', MAP, 'x', 'off');
  assert.equal(r.changed, true);
  assert.equal(r.reason, 'created');
  assert.equal(parseJsonc(r.text).value.skillOverrides.x, 'off');
});

test('insert into an empty existing map yields valid JSON', () => {
  const r = setStringMember('{"skillOverrides":{}}', MAP, 'x', 'off');
  assert.equal(r.changed, true);
  assert.equal(r.reason, 'inserted');
  assert.equal(parseJsonc(r.text).value.skillOverrides.x, 'off');
});

// ── errors ───────────────────────────────────────────────────────────────────────

test('error: a non-string member value is refused by TYPE (never its bytes)', () => {
  const r = setStringMember('{"skillOverrides":{"x":"sk-secret-leak-here"}}'.replace('"sk-secret-leak-here"', '123'), MAP, 'x', 'off');
  assert.equal(r.changed, false);
  assert.equal(r.error.code, 'not-string');
  assert.ok(r.error.message.includes('a number'));
});

test('error: value must be a string', () => {
  const r = setStringMember(WITH_MAP, MAP, 'deep-research', 5);
  assert.equal(r.changed, false);
  assert.equal(r.error.code, 'value-not-string');
});

test('error: text must be a string', () => {
  const r = setStringMember(42, MAP, 'x', 'off');
  assert.equal(r.changed, false);
  assert.equal(r.error.code, 'input-not-string');
});

test('error: ambiguous duplicate member key is refused', () => {
  const r = setStringMember('{"skillOverrides":{"x":"on","x":"off"}}', MAP, 'x', 'off');
  assert.equal(r.changed, false);
  assert.equal(r.error.code, 'ambiguous-key');
});

test('error: ambiguous duplicate map is refused', () => {
  const r = setStringMember('{"skillOverrides":{},"skillOverrides":{}}', MAP, 'x', 'off');
  assert.equal(r.changed, false);
  assert.equal(r.error.code, 'ambiguous-map');
});

test('error: skillOverrides present but not an object is refused (no accidental create)', () => {
  const r = setStringMember('{"skillOverrides":"nope"}', MAP, 'x', 'off');
  assert.equal(r.changed, false);
  assert.equal(r.error.code, 'map-not-object');
});

// ── applyVerifiedMapEdit ───────────────────────────────────────────────────────────

test('verify: a clean flip is accepted and re-parses to the desired value', () => {
  const v = applyVerifiedMapEdit(WITH_MAP, MAP, 'deep-research', 'on');
  assert.equal(v.ok, true);
  assert.equal(v.reason, 'flipped');
  assert.equal(parseJsonc(v.text).value.skillOverrides['deep-research'], 'on');
  assert.equal(v.text, WITH_MAP.replace('"deep-research": "off"', '"deep-research": "on"'));
});

test('verify: a clean insert is accepted and re-parses, env intact', () => {
  const v = applyVerifiedMapEdit(WITH_MAP, MAP, 'fresh-skill', 'off');
  assert.equal(v.ok, true);
  assert.equal(v.reason, 'inserted');
  assert.equal(parseJsonc(v.text).value.skillOverrides['fresh-skill'], 'off');
  assert.equal(parseJsonc(v.text).value.env.SECRET_TOKEN, 'sk-must-not-be-touched');
});

test('verify: a clean CREATE is accepted and re-parses, siblings intact', () => {
  const v = applyVerifiedMapEdit(NO_MAP, MAP, 'deep-research', 'off');
  assert.equal(v.ok, true);
  assert.equal(v.reason, 'created');
  assert.equal(parseJsonc(v.text).value.skillOverrides['deep-research'], 'off');
  assert.equal(parseJsonc(v.text).value.model, 'opus');
});

test('verify: a no-op is ok with text unchanged and diff null', () => {
  const v = applyVerifiedMapEdit(WITH_MAP, MAP, 'tdd', 'name-only');
  assert.equal(v.ok, true);
  assert.equal(v.reason, 'noop-already');
  assert.equal(v.text, WITH_MAP);
  assert.equal(v.diff, null);
});

test('verify: an error result fails closed with the original text', () => {
  const v = applyVerifiedMapEdit('{"skillOverrides":"nope"}', MAP, 'x', 'off');
  assert.equal(v.ok, false);
  assert.equal(v.error.code, 'map-not-object');
  assert.equal(v.text, '{"skillOverrides":"nope"}');
});

test('round-trip: flip then flip back is byte-identical to the original', () => {
  const off = applyVerifiedMapEdit(WITH_MAP, MAP, 'deep-research', 'on');
  const back = applyVerifiedMapEdit(off.text, MAP, 'deep-research', 'off');
  assert.equal(back.ok, true);
  assert.equal(back.text, WITH_MAP);
});

test('JSONC comments inside skillOverrides survive a flip', () => {
  const text = '{\n  "skillOverrides": {\n    // pinned\n    "x": "off"\n  }\n}\n';
  const v = applyVerifiedMapEdit(text, MAP, 'x', 'on');
  assert.equal(v.ok, true);
  assert.ok(v.text.includes('// pinned'));
  assert.ok(v.text.includes('"x": "on"'));
});

test('create then flip resolves to the final value', () => {
  const created = applyVerifiedMapEdit(NO_MAP, MAP, 'x', 'off');
  const flipped = applyVerifiedMapEdit(created.text, MAP, 'x', 'on');
  assert.equal(flipped.ok, true);
  assert.equal(parseJsonc(flipped.text).value.skillOverrides.x, 'on');
});

test('the diff NEVER echoes a co-located secret on a minified file (leak-proof by construction)', () => {
  const minified = '{ "env": {"SECRET":"sk-LIVE-must-not-leak"}, "skillOverrides": { "x": "off" } }';
  const r = setStringMember(minified, MAP, 'x', 'on');
  assert.equal(r.changed, true);
  assert.ok(r.text.includes('sk-LIVE-must-not-leak')); // the secret byte survives (V2)
  assert.equal(r.before, '"x": "off"');               // diff synthesized from key+value
  assert.equal(r.after, '"x": "on"');
  const v = applyVerifiedMapEdit(minified, MAP, 'x', 'on');
  assert.ok(!JSON.stringify(v.diff).includes('sk-LIVE'));
});

// ── findStringMemberSpan (locator discriminants) ───────────────────────────────────

test('locator: create branch reports the root insertion point for an absent map', () => {
  const s = findStringMemberSpan(NO_MAP, MAP, 'x');
  assert.equal(s.found, false);
  assert.equal(s.create, true);
  assert.ok(s.memberCount >= 1);
});

test('locator: absent branch reports the map body insertion point for an absent member', () => {
  const s = findStringMemberSpan(WITH_MAP, MAP, 'not-there');
  assert.equal(s.found, false);
  assert.equal(s.absent, true);
});

test('locator: flip branch decodes the current value', () => {
  const s = findStringMemberSpan(WITH_MAP, MAP, 'deep-research');
  assert.equal(s.found, true);
  assert.equal(s.mode, 'flip');
  assert.equal(s.current, 'off');
});
