/**
 * U2 oracle for json-edit.mjs — setPluginEnabled + applyVerifiedJsonEdit.
 *
 * Falsifiable: pins flip/insert/noop/error outcomes, byte-preservation outside the edited
 * span, round-trip identity, and that applyVerifiedJsonEdit's fail-closed verify accepts a
 * clean edit and the result re-parses to the desired enabledPlugins value.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setPluginEnabled, applyVerifiedJsonEdit } from '../src/lib/json-edit.mjs';
import { parseJsonc } from '../src/lib/jsonc-parser.mjs';

const SETTINGS = `{
  "model": "opus",
  "enabledPlugins": {
    "ecc@everything-claude-code": true,
    "gsap-skills@gsap-skills": false
  },
  "env": { "SECRET_TOKEN": "sk-must-not-be-touched" }
}
`;

test('flip true→false: surgical, only the one token changes', () => {
  const r = setPluginEnabled(SETTINGS, 'ecc@everything-claude-code', false);
  assert.equal(r.changed, true);
  assert.equal(r.reason, 'flipped');
  assert.ok(r.before.includes('true'));
  assert.ok(r.after.includes('false'));
  // exactly the expected one-token change
  assert.equal(r.text, SETTINGS.replace('"ecc@everything-claude-code": true', '"ecc@everything-claude-code": false'));
  assert.ok(r.text.includes('sk-must-not-be-touched'));
});

test('flip false→true', () => {
  const r = setPluginEnabled(SETTINGS, 'gsap-skills@gsap-skills', true);
  assert.equal(r.changed, true);
  assert.equal(r.text, SETTINGS.replace('"gsap-skills@gsap-skills": false', '"gsap-skills@gsap-skills": true'));
});

test('noop-already: enabling an already-true plugin writes nothing', () => {
  const r = setPluginEnabled(SETTINGS, 'ecc@everything-claude-code', true);
  assert.equal(r.changed, false);
  assert.equal(r.reason, 'noop-already');
  assert.equal(r.text, SETTINGS);
});

test('insert: enabling an absent key adds a member, valid JSON, env untouched', () => {
  const r = setPluginEnabled(SETTINGS, 'new-plugin@mkt', true);
  assert.equal(r.changed, true);
  assert.equal(r.reason, 'inserted');
  const parsed = parseJsonc(r.text);
  assert.equal(parsed.errors.length, 0);
  assert.equal(parsed.value.enabledPlugins['new-plugin@mkt'], true);
  assert.equal(parsed.value.enabledPlugins['ecc@everything-claude-code'], true); // sibling intact
  assert.equal(parsed.value.env.SECRET_TOKEN, 'sk-must-not-be-touched'); // env intact
});

test('noop-absent-disable: disabling an absent key writes nothing (already not-enabled)', () => {
  const r = setPluginEnabled(SETTINGS, 'new-plugin@mkt', false);
  assert.equal(r.changed, false);
  assert.equal(r.reason, 'noop-absent-disable');
  assert.equal(r.text, SETTINGS);
});

test('error: no enabledPlugins map', () => {
  const r = setPluginEnabled('{"model":"opus"}', 'x@m', true);
  assert.equal(r.changed, false);
  assert.equal(r.error.code, 'no-map');
});

test('error: non-boolean value is refused', () => {
  const r = setPluginEnabled('{"enabledPlugins":{"x@m":"true"}}', 'x@m', false);
  assert.equal(r.changed, false);
  assert.equal(r.error.code, 'not-boolean');
});

test('error: ambiguous duplicate key is refused', () => {
  const r = setPluginEnabled('{"enabledPlugins":{"x@m":true,"x@m":false}}', 'x@m', false);
  assert.equal(r.changed, false);
  assert.equal(r.error.code, 'ambiguous-key');
});

test('error: desired must be a boolean', () => {
  const r = setPluginEnabled(SETTINGS, 'ecc@everything-claude-code', 'false');
  assert.equal(r.changed, false);
  assert.equal(r.error.code, 'desired-not-boolean');
});

// ── applyVerifiedJsonEdit ────────────────────────────────────────────────────────

test('verify: a clean flip is accepted and re-parses to the desired value', () => {
  const v = applyVerifiedJsonEdit(SETTINGS, 'ecc@everything-claude-code', false);
  assert.equal(v.ok, true);
  assert.equal(v.reason, 'flipped');
  assert.ok(v.diff && v.diff.after.includes('false'));
  assert.equal(parseJsonc(v.text).value.enabledPlugins['ecc@everything-claude-code'], false);
  // bytes outside the token are identical
  assert.equal(v.text, SETTINGS.replace('"ecc@everything-claude-code": true', '"ecc@everything-claude-code": false'));
});

test('verify: a clean insert is accepted and re-parses to enabled=true', () => {
  const v = applyVerifiedJsonEdit(SETTINGS, 'fresh@mkt', true);
  assert.equal(v.ok, true);
  assert.equal(v.reason, 'inserted');
  assert.equal(parseJsonc(v.text).value.enabledPlugins['fresh@mkt'], true);
  assert.equal(parseJsonc(v.text).value.env.SECRET_TOKEN, 'sk-must-not-be-touched');
});

test('verify: a no-op (already in state) is ok with text unchanged and diff null', () => {
  const v = applyVerifiedJsonEdit(SETTINGS, 'gsap-skills@gsap-skills', false);
  assert.equal(v.ok, true);
  assert.equal(v.reason, 'noop-already');
  assert.equal(v.text, SETTINGS);
  assert.equal(v.diff, null);
});

test('verify: an error result fails closed with the original text', () => {
  const v = applyVerifiedJsonEdit('{"model":"opus"}', 'x@m', true);
  assert.equal(v.ok, false);
  assert.equal(v.error.code, 'no-map');
  assert.equal(v.text, '{"model":"opus"}');
});

test('round-trip: flip then flip back is byte-identical to the original', () => {
  const off = applyVerifiedJsonEdit(SETTINGS, 'ecc@everything-claude-code', false);
  const back = applyVerifiedJsonEdit(off.text, 'ecc@everything-claude-code', true);
  assert.equal(back.ok, true);
  assert.equal(back.text, SETTINGS);
});

test('JSONC comments inside enabledPlugins survive a flip', () => {
  const text = '{\n  "enabledPlugins": {\n    // pinned\n    "x@m": true\n  }\n}\n';
  const v = applyVerifiedJsonEdit(text, 'x@m', false);
  assert.equal(v.ok, true);
  assert.ok(v.text.includes('// pinned'));
  assert.ok(v.text.includes('"x@m": false'));
});

test('insert into an empty enabledPlugins object yields valid JSON', () => {
  const v = applyVerifiedJsonEdit('{"enabledPlugins":{}}', 'x@m', true);
  assert.equal(v.ok, true);
  assert.equal(parseJsonc(v.text).value.enabledPlugins['x@m'], true);
});

test('the diff NEVER echoes a co-located secret on a minified file (leak-proof by construction)', () => {
  // a hand-minified settings.json with an env secret and the plugin on the SAME physical line.
  const minified = '{ "env": {"SECRET":"sk-LIVE-must-not-leak"}, "enabledPlugins": { "ecc@m": true } }';
  const r = setPluginEnabled(minified, 'ecc@m', false);
  assert.equal(r.changed, true);
  // the written file still flips correctly + preserves the secret byte (V2 guarantees this)
  assert.ok(r.text.includes('sk-LIVE-must-not-leak'));
  // but the DIFF (echoed to stdout) is synthesized from the key+bool — never the physical line
  assert.equal(r.before, '"ecc@m": true');
  assert.equal(r.after, '"ecc@m": false');
  assert.ok(!r.before.includes('sk-LIVE'));
  assert.ok(!r.after.includes('sk-LIVE'));
  // applyVerifiedJsonEdit's diff carries the same leak-proof member strings
  const v = applyVerifiedJsonEdit(minified, 'ecc@m', false);
  assert.ok(!JSON.stringify(v.diff).includes('sk-LIVE'));
});

test('the not-boolean refusal reports a TYPE, never the value bytes', () => {
  const r = setPluginEnabled('{"enabledPlugins":{"x@m":"sk-secret-value-here"}}', 'x@m', false);
  assert.equal(r.error.code, 'not-boolean');
  assert.ok(r.error.message.includes('a string'));
  assert.ok(!r.error.message.includes('sk-secret'));
});
