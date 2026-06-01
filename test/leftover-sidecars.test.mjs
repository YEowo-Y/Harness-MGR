/**
 * Unit tests for src/lib/leftover-sidecars.mjs — the single source for the
 * `.mgr-new` / `.mgr-old` atomic-write recovery-sidecar predicate.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { isLeftoverSidecar, LEFTOVER_SUFFIXES } from '../src/lib/leftover-sidecars.mjs';

test('isLeftoverSidecar: a .mgr-old basename is a sidecar', () => {
  assert.equal(isLeftoverSidecar('x.mgr-old'), true);
});

test('isLeftoverSidecar: a .mgr-new basename is a sidecar', () => {
  assert.equal(isLeftoverSidecar('x.mgr-new'), true);
});

test('isLeftoverSidecar: a normal .md file is NOT a sidecar', () => {
  assert.equal(isLeftoverSidecar('x.md'), false);
});

test('isLeftoverSidecar: a non-string input is NOT a sidecar (never throws)', () => {
  assert.equal(isLeftoverSidecar(123), false);
});

test('isLeftoverSidecar: an empty string is NOT a sidecar', () => {
  assert.equal(isLeftoverSidecar(''), false);
});

test('isLeftoverSidecar: null is NOT a sidecar (never throws)', () => {
  assert.equal(isLeftoverSidecar(null), false);
});

test('isLeftoverSidecar: undefined is NOT a sidecar (never throws)', () => {
  assert.equal(isLeftoverSidecar(undefined), false);
});

test('LEFTOVER_SUFFIXES is the frozen [.mgr-new, .mgr-old] set', () => {
  assert.deepEqual([...LEFTOVER_SUFFIXES].sort(), ['.mgr-new', '.mgr-old']);
  assert.equal(Object.isFrozen(LEFTOVER_SUFFIXES), true);
});
