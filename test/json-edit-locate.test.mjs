/**
 * U1 oracle for findEnabledPluginSpan (src/lib/json-edit-locate.mjs) — the
 * byte-offset-retaining JSON locator for settings.json's enabledPlugins map.
 *
 * Falsifiable: each case pins the discriminated outcome AND, for a flip, that splicing
 * the token range produces the flipped boolean while every other byte is preserved.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findEnabledPluginSpan } from '../src/lib/json-edit-locate.mjs';

/** Splice the located flip token to `desired` and return the new text. */
function flip(text, span, desired) {
  return text.slice(0, span.tokenStart) + String(desired) + text.slice(span.tokenEnd);
}

const SETTINGS = `{
  "model": "opus",
  "enabledPlugins": {
    "ecc@everything-claude-code": true,
    "gsap-skills@gsap-skills": false
  },
  "env": { "SECRET_TOKEN": "sk-must-not-be-touched" }
}
`;

test('flip: locates a true boolean and the token range flips it cleanly', () => {
  const span = findEnabledPluginSpan(SETTINGS, 'ecc@everything-claude-code');
  assert.equal(span.found, true);
  assert.equal(span.mode, 'flip');
  assert.equal(span.current, true);
  assert.equal(SETTINGS.slice(span.tokenStart, span.tokenEnd), 'true');
  const out = flip(SETTINGS, span, false);
  assert.ok(out.includes('"ecc@everything-claude-code": false'));
  assert.ok(out.includes('"gsap-skills@gsap-skills": false')); // sibling untouched
  assert.ok(out.includes('sk-must-not-be-touched')); // env never touched
  // every byte outside the token is identical
  assert.equal(out.slice(0, span.tokenStart), SETTINGS.slice(0, span.tokenStart));
  assert.equal(out.slice(span.tokenStart + 'false'.length), SETTINGS.slice(span.tokenEnd));
});

test('flip: locates a false boolean (current=false)', () => {
  const span = findEnabledPluginSpan(SETTINGS, 'gsap-skills@gsap-skills');
  assert.equal(span.found, true);
  assert.equal(span.current, false);
  assert.equal(SETTINGS.slice(span.tokenStart, span.tokenEnd), 'false');
});

test('absent: key not in an existing map → absent with an insertion point', () => {
  const span = findEnabledPluginSpan(SETTINGS, 'new-plugin@mkt');
  assert.equal(span.found, false);
  assert.equal(span.absent, true);
  assert.equal(typeof span.insertAt, 'number');
  assert.equal(span.memberCount, 2);
  // insertAt is just inside the enabledPlugins object body
  assert.equal(SETTINGS[span.insertAt - 1], '{');
});

test('no-map: settings without an enabledPlugins object', () => {
  const span = findEnabledPluginSpan('{"model":"opus"}', 'x@m');
  assert.equal(span.found, false);
  assert.equal(span.error.code, 'no-map');
});

test('no-map: enabledPlugins present but not an object (array)', () => {
  const span = findEnabledPluginSpan('{"enabledPlugins":["x@m"]}', 'x@m');
  assert.equal(span.found, false);
  assert.equal(span.error.code, 'no-map');
});

test('not-boolean: a string value is refused, never spliced', () => {
  const span = findEnabledPluginSpan('{"enabledPlugins":{"x@m":"true"}}', 'x@m');
  assert.equal(span.found, false);
  assert.equal(span.error.code, 'not-boolean');
});

test('not-boolean: a numeric value is refused', () => {
  const span = findEnabledPluginSpan('{"enabledPlugins":{"x@m":1}}', 'x@m');
  assert.equal(span.found, false);
  assert.equal(span.error.code, 'not-boolean');
});

test('ambiguous: a duplicate top-level enabledPlugins is refused', () => {
  const span = findEnabledPluginSpan('{"enabledPlugins":{"x@m":true},"enabledPlugins":{"x@m":false}}', 'x@m');
  assert.equal(span.found, false);
  assert.equal(span.ambiguous, true);
  assert.equal(span.error.code, 'ambiguous-map');
});

test('ambiguous: a duplicate member key is refused', () => {
  const span = findEnabledPluginSpan('{"enabledPlugins":{"x@m":true,"x@m":false}}', 'x@m');
  assert.equal(span.found, false);
  assert.equal(span.ambiguous, true);
  assert.equal(span.error.code, 'ambiguous-key');
});

test('only the TOP-LEVEL enabledPlugins is considered (a nested same-name key never matches)', () => {
  // a top-level key whose value object contains a nested "enabledPlugins" must not match
  const text = '{"other":{"enabledPlugins":{"x@m":true}},"model":"opus"}';
  const span = findEnabledPluginSpan(text, 'x@m');
  assert.equal(span.found, false);
  assert.equal(span.error.code, 'no-map');
});

test('malformed: an unterminated object → unparseable error (never throws)', () => {
  const span = findEnabledPluginSpan('{"enabledPlugins":{"x@m":true', 'x@m');
  assert.equal(span.found, false);
  assert.equal(span.error.code, 'unparseable');
});

test('JSONC: a // comment inside the map does not break location and is preserved on flip', () => {
  const text = '{\n  "enabledPlugins": {\n    // keep this\n    "x@m": true\n  }\n}\n';
  const span = findEnabledPluginSpan(text, 'x@m');
  assert.equal(span.found, true);
  assert.equal(span.current, true);
  const out = flip(text, span, false);
  assert.ok(out.includes('// keep this'));
  assert.ok(out.includes('"x@m": false'));
});

test('a key with @ . - chars (name@marketplace) is matched literally', () => {
  const text = '{"enabledPlugins":{"a.b-c@my-market.place":false}}';
  const span = findEnabledPluginSpan(text, 'a.b-c@my-market.place');
  assert.equal(span.found, true);
  assert.equal(span.current, false);
});

test('a string value containing a brace/comment-looking payload does not confuse the scanner', () => {
  const text = '{"a":"}//[{","enabledPlugins":{"x@m":true}}';
  const span = findEnabledPluginSpan(text, 'x@m');
  assert.equal(span.found, true);
  assert.equal(span.current, true);
});

test('input guards: non-string text and empty key', () => {
  assert.equal(findEnabledPluginSpan(42, 'x@m').error.code, 'input-not-string');
  assert.equal(findEnabledPluginSpan('{}', '').error.code, 'invalid-key');
});

test('a leading UTF-8 BOM is tolerated', () => {
  const span = findEnabledPluginSpan('﻿{"enabledPlugins":{"x@m":true}}', 'x@m');
  assert.equal(span.found, true);
  assert.equal(span.current, true);
});

test('a __proto__-shaped plugin key is ordinary data, located normally', () => {
  const text = '{"enabledPlugins":{"__proto__@m":false}}';
  const span = findEnabledPluginSpan(text, '__proto__@m');
  assert.equal(span.found, true);
  assert.equal(span.current, false);
});
