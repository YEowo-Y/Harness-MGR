/**
 * Tests for the doctor skill-fact check #29 (src/analysis/doctor/skill-checks.mjs).
 *
 * Pure oracle for checkSkillOverridesOrphaned via runDoctor: an override key with no
 * directory-backed skill → one warn; a key that matches skillDirs → silent; absent/empty/
 * non-object/codex({}) skillOverrides → []; dedup + sort; __proto__-safe; registered passive.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { runDoctor, CHECKS } from '../src/analysis/doctor/index.mjs';

const byCode = (diags, code) => diags.filter((d) => d && d.code === code);

test('#29: an override pointing at no directory-backed skill → one warn', () => {
  const r = runDoctor({ skillOverrides: { 'gone-skill': 'off' }, skillDirs: ['deep-research', 'tdd'] });
  const found = byCode(r.diagnostics, 'skill-overrides-orphaned');
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, 'warn');
  assert.ok(found[0].message.includes('gone-skill'));
});

test('#29: an override that matches a directory-backed skill → silent', () => {
  const r = runDoctor({ skillOverrides: { 'deep-research': 'off' }, skillDirs: ['deep-research', 'tdd'] });
  assert.equal(byCode(r.diagnostics, 'skill-overrides-orphaned').length, 0);
});

test('#29: mixed — only the orphaned keys fire, sorted by message', () => {
  const r = runDoctor({ skillOverrides: { zzz: 'off', aaa: 'on', tdd: 'name-only' }, skillDirs: ['tdd'] });
  const found = byCode(r.diagnostics, 'skill-overrides-orphaned');
  assert.equal(found.length, 2); // aaa + zzz orphaned; tdd is backed
  assert.ok(found[0].message < found[1].message, 'sorted ascending by message');
});

test('#29: absent skillOverrides → no finding (proves the gather gate / codex safety)', () => {
  const r = runDoctor({ skillDirs: ['tdd'] });
  assert.equal(byCode(r.diagnostics, 'skill-overrides-orphaned').length, 0);
});

test('#29: codex-style empty map ({}) → no finding', () => {
  const r = runDoctor({ skillOverrides: {}, skillDirs: ['tdd'] });
  assert.equal(byCode(r.diagnostics, 'skill-overrides-orphaned').length, 0);
});

test('#29: a non-object skillOverrides is ignored, no throw', () => {
  assert.doesNotThrow(() => runDoctor({ skillOverrides: 'nope', skillDirs: ['tdd'] }));
  assert.doesNotThrow(() => runDoctor({ skillOverrides: ['x'], skillDirs: ['tdd'] }));
});

test('#29: __proto__ override key does not pollute and is skipped', () => {
  const so = JSON.parse('{"__proto__":"off","real":"on"}'); // own __proto__ key
  const r = runDoctor({ skillOverrides: so, skillDirs: [] });
  const found = byCode(r.diagnostics, 'skill-overrides-orphaned');
  assert.ok(found.every((d) => !d.message.includes('__proto__')));
  assert.deepEqual({}.polluted, undefined);
});

test('#29: missing skillDirs treats every override as orphaned (defensive)', () => {
  const r = runDoctor({ skillOverrides: { a: 'off', b: 'on' } });
  assert.equal(byCode(r.diagnostics, 'skill-overrides-orphaned').length, 2);
});

test('#29 is a registered passive check', () => {
  const c = CHECKS.find((x) => x.id === 29);
  assert.ok(c, '#29 present in the registry');
  assert.equal(c.code, 'skill-overrides-orphaned');
  assert.equal(c.probeLevel, 'passive');
});
