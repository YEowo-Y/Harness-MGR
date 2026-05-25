/**
 * P2.U9 — drift.test.mjs
 *
 * Pure unit tests for analyzeDrift() in src/analysis/drift.mjs.
 * No I/O — all inputs are synthetic in-memory objects.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeDrift } from '../src/analysis/drift.mjs';

// ---------------------------------------------------------------------------
// (a) previous null/undefined/non-object → 'no-baseline' + drift-no-baseline
// ---------------------------------------------------------------------------

test('no-baseline: previous is null', () => {
  const r = analyzeDrift({ current: {}, previous: null });
  assert.equal(r.status, 'no-baseline');
  assert.equal(r.changes.length, 0);
  assert.deepEqual(r.summary, { added: 0, removed: 0, modified: 0 });
  assert.equal(r.diagnostics.length, 1);
  assert.equal(r.diagnostics[0].code, 'drift-no-baseline');
  assert.equal(r.diagnostics[0].severity, 'info');
});

test('no-baseline: previous is undefined', () => {
  const r = analyzeDrift({ current: {}, previous: undefined });
  assert.equal(r.status, 'no-baseline');
  assert.equal(r.diagnostics[0].code, 'drift-no-baseline');
});

test('no-baseline: previous is a string', () => {
  const r = analyzeDrift({ current: {}, previous: 'not-an-object' });
  assert.equal(r.status, 'no-baseline');
  assert.equal(r.diagnostics[0].code, 'drift-no-baseline');
});

test('no-baseline: previous is an array', () => {
  const r = analyzeDrift({ current: {}, previous: [] });
  assert.equal(r.status, 'no-baseline');
  assert.equal(r.diagnostics[0].code, 'drift-no-baseline');
});

test('no-baseline: previous is a number', () => {
  const r = analyzeDrift({ current: {}, previous: 42 });
  assert.equal(r.status, 'no-baseline');
  assert.equal(r.diagnostics[0].code, 'drift-no-baseline');
});

// ---------------------------------------------------------------------------
// (b) differing non-empty targetClaudeDir → 'no-baseline' + drift-baseline-foreign
// ---------------------------------------------------------------------------

test('no-baseline: differing non-empty targetClaudeDir', () => {
  const r = analyzeDrift({
    current: { targetClaudeDir: '/home/alice/.claude', files: {} },
    previous: { targetClaudeDir: '/home/bob/.claude', files: {} },
  });
  assert.equal(r.status, 'no-baseline');
  assert.equal(r.diagnostics.length, 1);
  assert.equal(r.diagnostics[0].code, 'drift-baseline-foreign');
  assert.equal(r.diagnostics[0].severity, 'info');
  assert.ok(r.diagnostics[0].message.includes('/home/bob/.claude'));
});

test('no-baseline: foreign baseline message contains previous dir', () => {
  const r = analyzeDrift({
    current: { targetClaudeDir: '/x', files: {} },
    previous: { targetClaudeDir: '/y', files: {} },
  });
  assert.ok(r.diagnostics[0].message.includes('/y'));
});

// Same non-empty dir → NOT foreign (should proceed to compare).
test('same targetClaudeDir is not treated as foreign', () => {
  const r = analyzeDrift({
    current: { targetClaudeDir: '/same', files: {} },
    previous: { targetClaudeDir: '/same', files: {} },
  });
  assert.equal(r.status, 'clean');
});

// Empty dirs in both → NOT treated as foreign (at least one empty → skip foreign check).
test('empty targetClaudeDir in both is not foreign', () => {
  const r = analyzeDrift({
    current: { targetClaudeDir: '', files: {} },
    previous: { targetClaudeDir: '', files: {} },
  });
  assert.equal(r.status, 'clean');
});

// ---------------------------------------------------------------------------
// (c) identical files → 'clean', no diagnostics, summary all zero
// ---------------------------------------------------------------------------

test('clean: identical files maps', () => {
  const files = { 'CLAUDE.md': 'abc123', 'settings.json': 'def456' };
  const r = analyzeDrift({
    current: { targetClaudeDir: '/c', files },
    previous: { targetClaudeDir: '/c', files },
  });
  assert.equal(r.status, 'clean');
  assert.equal(r.changes.length, 0);
  assert.deepEqual(r.summary, { added: 0, removed: 0, modified: 0 });
  assert.equal(r.diagnostics.length, 0);
});

test('clean: both files maps empty', () => {
  const r = analyzeDrift({ current: { files: {} }, previous: { files: {} } });
  assert.equal(r.status, 'clean');
  assert.equal(r.diagnostics.length, 0);
});

// ---------------------------------------------------------------------------
// (d) single added file → 'drifted', changes=[{path,'added'}], summary.added=1
// ---------------------------------------------------------------------------

test('drifted: single added file', () => {
  const r = analyzeDrift({
    previous: { files: {} },
    current: { files: { 'skills/new.md': 'hash1' } },
  });
  assert.equal(r.status, 'drifted');
  assert.equal(r.changes.length, 1);
  assert.deepEqual(r.changes[0], { path: 'skills/new.md', change: 'added' });
  assert.equal(r.summary.added, 1);
  assert.equal(r.summary.removed, 0);
  assert.equal(r.summary.modified, 0);
  assert.equal(r.diagnostics.length, 1);
  assert.equal(r.diagnostics[0].code, 'drift-detected');
  assert.equal(r.diagnostics[0].severity, 'warn');
  assert.ok(typeof r.diagnostics[0].fix === 'string' && r.diagnostics[0].fix.length > 0);
});

// ---------------------------------------------------------------------------
// (e) removed file
// ---------------------------------------------------------------------------

test('drifted: single removed file', () => {
  const r = analyzeDrift({
    previous: { files: { 'agents/bar.md': 'hashA' } },
    current: { files: {} },
  });
  assert.equal(r.status, 'drifted');
  assert.equal(r.changes.length, 1);
  assert.deepEqual(r.changes[0], { path: 'agents/bar.md', change: 'removed' });
  assert.equal(r.summary.removed, 1);
  assert.equal(r.summary.added, 0);
  assert.equal(r.summary.modified, 0);
});

// ---------------------------------------------------------------------------
// (f) modified file (same key, different hash)
// ---------------------------------------------------------------------------

test('drifted: single modified file', () => {
  const r = analyzeDrift({
    previous: { files: { 'CLAUDE.md': 'oldHash' } },
    current: { files: { 'CLAUDE.md': 'newHash' } },
  });
  assert.equal(r.status, 'drifted');
  assert.equal(r.changes.length, 1);
  assert.deepEqual(r.changes[0], { path: 'CLAUDE.md', change: 'modified' });
  assert.equal(r.summary.modified, 1);
});

// Same key, same hash → clean (not modified).
test('clean: same key same hash is not modified', () => {
  const r = analyzeDrift({
    previous: { files: { 'CLAUDE.md': 'sameHash' } },
    current: { files: { 'CLAUDE.md': 'sameHash' } },
  });
  assert.equal(r.status, 'clean');
});

// ---------------------------------------------------------------------------
// (g) combined add + remove + modify → changes sorted by path + correct summary
// ---------------------------------------------------------------------------

test('drifted: combined add+remove+modify sorted by path', () => {
  const r = analyzeDrift({
    previous: { files: { 'agents/bar.md': 'h1', 'CLAUDE.md': 'h2' } },
    current: { files: { 'CLAUDE.md': 'h2-modified', 'commands/new.md': 'h3' } },
  });
  assert.equal(r.status, 'drifted');
  // Expected sorted changes: CLAUDE.md (modified), agents/bar.md (removed), commands/new.md (added)
  assert.equal(r.changes.length, 3);
  const byPath = Object.fromEntries(r.changes.map((c) => [c.path, c.change]));
  assert.equal(byPath['CLAUDE.md'], 'modified');
  assert.equal(byPath['agents/bar.md'], 'removed');
  assert.equal(byPath['commands/new.md'], 'added');
  // Verify path-sorted order.
  const paths = r.changes.map((c) => c.path);
  assert.deepEqual(paths, [...paths].sort());
  assert.equal(r.summary.added, 1);
  assert.equal(r.summary.removed, 1);
  assert.equal(r.summary.modified, 1);
  assert.equal(r.diagnostics.length, 1);
  assert.equal(r.diagnostics[0].code, 'drift-detected');
  // Message should mention counts.
  assert.ok(r.diagnostics[0].message.includes('1 modified'));
  assert.ok(r.diagnostics[0].message.includes('1 added'));
  assert.ok(r.diagnostics[0].message.includes('1 removed'));
});

// ---------------------------------------------------------------------------
// (h) never throws on junk inputs
// ---------------------------------------------------------------------------

test('never throws: analyzeDrift() with no args', () => {
  assert.doesNotThrow(() => analyzeDrift());
});

test('never throws: analyzeDrift(null)', () => {
  assert.doesNotThrow(() => analyzeDrift(null));
  const r = analyzeDrift(null);
  assert.equal(r.status, 'no-baseline');
});

test('never throws: analyzeDrift({current:42, previous:"x"})', () => {
  assert.doesNotThrow(() => analyzeDrift({ current: 42, previous: 'x' }));
});

test('never throws: previous is plain object but files is missing', () => {
  // previous is a plain object (passes isPlainObj), files missing → filesOf returns {}
  const r = analyzeDrift({ current: {}, previous: {} });
  assert.ok(['clean', 'drifted', 'no-baseline'].includes(r.status));
  assert.doesNotThrow(() => analyzeDrift({ current: {}, previous: {} }));
});

test('never throws: previous.files is an array', () => {
  const r = analyzeDrift({ current: {}, previous: { files: ['not', 'an', 'object'] } });
  // filesOf rejects arrays → {}; should not throw
  assert.doesNotThrow(() => analyzeDrift({ current: {}, previous: { files: ['not', 'an', 'object'] } }));
  assert.equal(r.status, 'clean');
});

test('never throws: current.files is an array', () => {
  assert.doesNotThrow(() => analyzeDrift({ current: { files: [] }, previous: { files: {} } }));
});

// ---------------------------------------------------------------------------
// (i) __proto__ key in files is ignored (no prototype poisoning, not a change)
// ---------------------------------------------------------------------------

test('__proto__ key in files is ignored — not reported as a change', () => {
  // Build files objects with own __proto__ keys via Object.defineProperty.
  const prevFiles = Object.create(null);
  Object.defineProperty(prevFiles, '__proto__', { value: 'poisonPrev', enumerable: true, configurable: true, writable: true });
  prevFiles['CLAUDE.md'] = 'hash1';

  const curFiles = Object.create(null);
  Object.defineProperty(curFiles, '__proto__', { value: 'poisonCur', enumerable: true, configurable: true, writable: true });
  curFiles['CLAUDE.md'] = 'hash1';

  const r = analyzeDrift({ previous: { files: prevFiles }, current: { files: curFiles } });
  // __proto__ must not appear in changes.
  const protoChange = r.changes.find((c) => c.path === '__proto__');
  assert.equal(protoChange, undefined, '__proto__ must not be reported as a change');
  // CLAUDE.md same hash → clean.
  assert.equal(r.status, 'clean');
});

test('constructor and prototype keys in files are ignored', () => {
  const prevFiles = { constructor: 'h1', prototype: 'h2', 'real.md': 'h3' };
  const curFiles = { constructor: 'h1-changed', prototype: 'h2-changed', 'real.md': 'h3' };
  const r = analyzeDrift({ previous: { files: prevFiles }, current: { files: curFiles } });
  const poisonChanges = r.changes.filter((c) => c.path === 'constructor' || c.path === 'prototype');
  assert.equal(poisonChanges.length, 0, 'constructor/prototype keys must not be reported');
  // real.md unchanged → clean.
  assert.equal(r.status, 'clean');
});
