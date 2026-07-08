/**
 * apple-metadata.test.mjs — the shared `isAppleMetadata` predicate
 * (src/lib/apple-metadata.mjs), the single source the three walkers filter on.
 *
 * Falsifiable table oracle: the three filtered classes (.DS_Store, .AppleDouble,
 * ._* AppleDouble sidecars) are true; ordinary config names + look-alike dotfiles
 * that are NOT apple metadata are false; junk inputs never throw.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { isAppleMetadata, APPLE_METADATA_NAMES, APPLE_DOUBLE_PREFIX } from '../src/lib/apple-metadata.mjs';

test('isAppleMetadata: true for .DS_Store, .AppleDouble, and any ._* AppleDouble sidecar', () => {
  for (const name of ['.DS_Store', '.AppleDouble', '._SKILL.md', '._foo', '._', '._.DS_Store']) {
    assert.equal(isAppleMetadata(name), true, `${name} must be apple metadata`);
  }
});

test('isAppleMetadata: false for ordinary config names + non-apple dotfiles (case-sensitive by design)', () => {
  for (const name of ['SKILL.md', 'agent.md', 'settings.json', '.gitignore', '.env', '.mcp.json',
    'DS_Store', '.ds_store', 'a._b', 'foo._', '.appledouble']) {
    assert.equal(isAppleMetadata(name), false, `${name} must NOT be apple metadata`);
  }
});

test('isAppleMetadata: never throws on junk input; false for non-string / empty', () => {
  for (const junk of [null, undefined, 42, {}, [], '', true]) {
    assert.doesNotThrow(() => assert.equal(isAppleMetadata(junk), false));
  }
});

test('exported constants: frozen with the expected conservative members', () => {
  assert.ok(Object.isFrozen(APPLE_METADATA_NAMES), 'APPLE_METADATA_NAMES must be frozen');
  assert.deepEqual([...APPLE_METADATA_NAMES], ['.DS_Store', '.AppleDouble']);
  assert.equal(APPLE_DOUBLE_PREFIX, '._');
});
