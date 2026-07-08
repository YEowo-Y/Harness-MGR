/**
 * Unit tests for src/lib/name-identity.mjs — the derived-identity seam used for
 * component grouping/dedup/comparison (NFC + optional case folding).
 *
 * These assert exact before/after strings and are deterministic on any host
 * (platform / caseInsensitive are explicit arguments, never read from the host).
 *
 * NFD is derived at RUNTIME via normalize('NFD') rather than pasted as a literal,
 * so the tests do not depend on how this source file happens to be saved on disk.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { toNfc, isCaseInsensitiveFs, identityKey } from '../src/lib/name-identity.mjs';

const NFC_CAFE = 'café';                    // precomposed 'é' (NFC)
const NFD_CAFE = NFC_CAFE.normalize('NFD'); // 'e' + combining acute (decomposed), built at runtime

// ── toNfc ─────────────────────────────────────────────────────────────────────

test('toNfc: NFD input folds to NFC (e + combining acute → precomposed)', () => {
  assert.equal(NFD_CAFE.length, NFC_CAFE.length + 1, 'NFD has one extra code unit (the combining mark)');
  assert.notEqual(NFD_CAFE, NFC_CAFE, 'the two forms are code-unit-distinct before normalization');
  assert.equal(toNfc(NFD_CAFE), NFC_CAFE, 'NFD normalizes to the composed NFC form');
  assert.equal(toNfc(NFC_CAFE), NFC_CAFE, 'already-NFC is unchanged');
});

test('toNfc: non-strings pass through unchanged', () => {
  for (const v of [null, undefined, 42, {}, []]) {
    assert.equal(toNfc(v), v);
  }
});

// ── isCaseInsensitiveFs ───────────────────────────────────────────────────────

test('isCaseInsensitiveFs: win32 and darwin are case-insensitive; linux is not', () => {
  assert.equal(isCaseInsensitiveFs('win32'), true);
  assert.equal(isCaseInsensitiveFs('darwin'), true);
  assert.equal(isCaseInsensitiveFs('linux'), false);
  assert.equal(isCaseInsensitiveFs('freebsd'), false);
});

// ── identityKey ───────────────────────────────────────────────────────────────

test('identityKey: NFC is applied on every platform (case-sensitive and not)', () => {
  assert.equal(identityKey(NFD_CAFE, false), NFC_CAFE, 'NFC applied even when case-sensitive');
  assert.equal(identityKey(NFD_CAFE, true), NFC_CAFE, 'NFC applied when case-insensitive too (already lowercase)');
});

test('identityKey: case folding ONLY when caseInsensitive', () => {
  assert.equal(identityKey('MySkill', false), 'MySkill', 'case-sensitive: case preserved');
  assert.equal(identityKey('MySkill', true), 'myskill', 'case-insensitive: folded to lower');
});

test('identityKey: MySkill and myskill share identity iff case-insensitive', () => {
  assert.equal(identityKey('MySkill', true), identityKey('myskill', true), 'same identity on a case-insensitive FS');
  assert.notEqual(identityKey('MySkill', false), identityKey('myskill', false), 'distinct identity on a case-sensitive FS');
});

test('identityKey: NFD name and NFC name collapse to one identity on a case-insensitive FS', () => {
  // A macOS readdir NFD name and a Windows/Linux NFC name for the same accented
  // component must land on ONE identity when the volume is case-insensitive.
  assert.equal(identityKey(NFD_CAFE, true), identityKey(NFC_CAFE, true));
});

test('identityKey: non-string input yields empty string (safe as a Map/Set key)', () => {
  for (const v of [null, undefined, 42, {}]) {
    assert.equal(identityKey(v, true), '');
    assert.equal(identityKey(v, false), '');
  }
});
