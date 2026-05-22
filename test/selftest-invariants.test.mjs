/**
 * P1.U16 — selftest-invariants.test.mjs
 *
 * Tests for src/selftest/invariants.mjs:
 *   - THE REAL FILES PASS (live invariant guard against the repo's actual sources)
 *   - synthetic violations: missing import, duplicate KIND_RULES, missing KIND_RULES
 *   - comment-tolerance: // KIND_RULES prose must NOT trigger duplicate-rules
 *   - never-throws on non-string inputs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import {
  checkLoadOrderSingleSource,
  checkInvariants,
} from '../src/selftest/invariants.mjs';

// ── helpers ──────────────────────────────────────────────────────────────────

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, '..', 'src');

/** Minimal valid conflicts.mjs stub: has all three required imports, no KIND_RULES. */
const VALID_CONFLICTS = `
import { resolutionKey, isLoadableComponent, rankComponents } from './load-order.mjs';
export function analyzeConflicts(components) { return { conflicts: [], diagnostics: [] }; }
`;

/** Minimal valid load-order.mjs stub: exports KIND_RULES. */
const VALID_LOAD_ORDER = `
export const KIND_RULES = Object.freeze({ skill: {}, command: {}, agent: {} });
export function resolutionKey(rec) { return ''; }
export function isLoadableComponent(rec) { return false; }
export function rankComponents(kind, members) { return []; }
`;

// ── A. THE REAL FILES PASS ────────────────────────────────────────────────────

test('real src/analysis files: checkInvariants returns zero diagnostics', () => {
  const { diagnostics } = checkInvariants(srcDir);
  assert.deepEqual(diagnostics, [],
    `live invariant violated — diagnostics: ${JSON.stringify(diagnostics, null, 2)}`);
});

// ── B. IMPORT MISSING ────────────────────────────────────────────────────────

test('missing all three imports → invariant-load-order-import-missing error', () => {
  const noImport = `export function analyzeConflicts() { return {}; }`;
  const diags = checkLoadOrderSingleSource(noImport, VALID_LOAD_ORDER);
  assert.equal(diags.length, 1);
  assert.equal(diags[0].code, 'invariant-load-order-import-missing');
  assert.equal(diags[0].severity, 'error');
  assert.equal(diags[0].phase, 'invariants');
  // message must name the missing identifiers
  assert.ok(diags[0].message.includes('resolutionKey'), 'message should mention resolutionKey');
  assert.ok(diags[0].message.includes('isLoadableComponent'), 'message should mention isLoadableComponent');
  assert.ok(diags[0].message.includes('rankComponents'), 'message should mention rankComponents');
});

test('imports only one of the three → missing the other two', () => {
  const partial = `import { resolutionKey } from './load-order.mjs';\n`;
  const diags = checkLoadOrderSingleSource(partial, VALID_LOAD_ORDER);
  assert.equal(diags.length, 1);
  assert.equal(diags[0].code, 'invariant-load-order-import-missing');
  assert.ok(!diags[0].message.includes('resolutionKey'), 'resolutionKey should NOT be listed as missing');
  assert.ok(diags[0].message.includes('isLoadableComponent'));
  assert.ok(diags[0].message.includes('rankComponents'));
});

test('imports from a different module (not load-order.mjs) → all three missing', () => {
  const wrongModule = `import { resolutionKey, isLoadableComponent, rankComponents } from './other.mjs';\n`;
  const diags = checkLoadOrderSingleSource(wrongModule, VALID_LOAD_ORDER);
  assert.equal(diags.length, 1);
  assert.equal(diags[0].code, 'invariant-load-order-import-missing');
});

// ── B2. MULTILINE DESTRUCTURED IMPORT ────────────────────────────────────────

test('multiline destructured import → zero diagnostics (detector handles newlines)', () => {
  const multiline = `
import {
  resolutionKey,
  isLoadableComponent,
  rankComponents,
} from './load-order.mjs';
export function analyzeConflicts(components) { return { conflicts: [], diagnostics: [] }; }
`;
  const diags = checkLoadOrderSingleSource(multiline, VALID_LOAD_ORDER);
  assert.deepEqual(diags, [],
    `multiline import should produce zero diagnostics, got: ${JSON.stringify(diags)}`);
});

// ── C. DUPLICATE KIND_RULES IN CONFLICTS ─────────────────────────────────────

test('conflicts.mjs with const KIND_RULES = → invariant-load-order-duplicate-rules', () => {
  const withDupe = VALID_CONFLICTS + `\nconst KIND_RULES = { skill: {} };\n`;
  const diags = checkLoadOrderSingleSource(withDupe, VALID_LOAD_ORDER);
  const dupe = diags.find((d) => d.code === 'invariant-load-order-duplicate-rules');
  assert.ok(dupe, 'expected duplicate-rules diagnostic');
  assert.equal(dupe.severity, 'error');
  assert.equal(dupe.phase, 'invariants');
});

test('conflicts.mjs with export const KIND_RULES = → invariant-load-order-duplicate-rules', () => {
  const withExportDupe = VALID_CONFLICTS + `\nexport const KIND_RULES = Object.freeze({});\n`;
  const diags = checkLoadOrderSingleSource(withExportDupe, VALID_LOAD_ORDER);
  const dupe = diags.find((d) => d.code === 'invariant-load-order-duplicate-rules');
  assert.ok(dupe, 'expected duplicate-rules diagnostic for export const KIND_RULES');
});

test('conflicts.mjs with let KIND_RULES = → invariant-load-order-duplicate-rules (widened check)', () => {
  const withLet = VALID_CONFLICTS + `\nlet KIND_RULES = { skill: {} };\n`;
  const diags = checkLoadOrderSingleSource(withLet, VALID_LOAD_ORDER);
  const dupe = diags.find((d) => d.code === 'invariant-load-order-duplicate-rules');
  assert.ok(dupe, 'let KIND_RULES must be caught by widened Invariant 2');
});

test('conflicts.mjs with var KIND_RULES = → invariant-load-order-duplicate-rules (widened check)', () => {
  const withVar = VALID_CONFLICTS + `\nvar KIND_RULES = { skill: {} };\n`;
  const diags = checkLoadOrderSingleSource(withVar, VALID_LOAD_ORDER);
  const dupe = diags.find((d) => d.code === 'invariant-load-order-duplicate-rules');
  assert.ok(dupe, 'var KIND_RULES must be caught by widened Invariant 2');
});

// ── D. COMMENT TOLERANCE ─────────────────────────────────────────────────────

test('line comment mentioning KIND_RULES does NOT trigger duplicate-rules', () => {
  const withComment = VALID_CONFLICTS
    + `\n// KIND_RULES lives in load-order.mjs (single source of truth)\n`;
  const diags = checkLoadOrderSingleSource(withComment, VALID_LOAD_ORDER);
  const dupe = diags.find((d) => d.code === 'invariant-load-order-duplicate-rules');
  assert.equal(dupe, undefined, 'prose comment should NOT trigger duplicate-rules');
});

test('block comment mentioning KIND_RULES does NOT trigger duplicate-rules', () => {
  const withBlock = VALID_CONFLICTS
    + `\n/* const KIND_RULES = {} — deliberately removed; see load-order.mjs */\n`;
  const diags = checkLoadOrderSingleSource(withBlock, VALID_LOAD_ORDER);
  const dupe = diags.find((d) => d.code === 'invariant-load-order-duplicate-rules');
  assert.equal(dupe, undefined, 'block comment should NOT trigger duplicate-rules');
});

// ── E. LOAD-ORDER SOURCE MISSING ─────────────────────────────────────────────

test('load-order.mjs without KIND_RULES → invariant-load-order-source-missing', () => {
  const noKindRules = `
export function resolutionKey(rec) { return ''; }
export function isLoadableComponent(rec) { return false; }
export function rankComponents(kind, members) { return []; }
`;
  const diags = checkLoadOrderSingleSource(VALID_CONFLICTS, noKindRules);
  const missing = diags.find((d) => d.code === 'invariant-load-order-source-missing');
  assert.ok(missing, 'expected source-missing diagnostic');
  assert.equal(missing.severity, 'error');
  assert.equal(missing.phase, 'invariants');
});

test('load-order.mjs with const KIND_RULES (no export) → invariant-load-order-source-missing (tightened check)', () => {
  // Invariant 3 requires `export const KIND_RULES =`; a private const is a violation
  // because callers cannot import it.
  const privateOnly = `
const KIND_RULES = Object.freeze({ skill: {}, command: {}, agent: {} });
export function resolutionKey(rec) { return ''; }
`;
  const diags = checkLoadOrderSingleSource(VALID_CONFLICTS, privateOnly);
  const missing = diags.find((d) => d.code === 'invariant-load-order-source-missing');
  assert.ok(missing, 'private const KIND_RULES (no export) must fail Invariant 3');
});

// ── F. CLEAN PASS ────────────────────────────────────────────────────────────

test('valid stubs → no diagnostics', () => {
  const diags = checkLoadOrderSingleSource(VALID_CONFLICTS, VALID_LOAD_ORDER);
  assert.deepEqual(diags, []);
});

// ── G. NEVER-THROWS ON NON-STRING INPUT ──────────────────────────────────────

test('non-string conflictsSource → invariant-read-failed, no throw', () => {
  let diags;
  assert.doesNotThrow(() => {
    diags = checkLoadOrderSingleSource(null, VALID_LOAD_ORDER);
  });
  assert.equal(diags.length, 1);
  assert.equal(diags[0].code, 'invariant-read-failed');
});

test('non-string loadOrderSource → invariant-read-failed, no throw', () => {
  let diags;
  assert.doesNotThrow(() => {
    diags = checkLoadOrderSingleSource(VALID_CONFLICTS, undefined);
  });
  assert.equal(diags.length, 1);
  assert.equal(diags[0].code, 'invariant-read-failed');
});

test('both inputs non-string → invariant-read-failed, no throw', () => {
  let diags;
  assert.doesNotThrow(() => {
    diags = checkLoadOrderSingleSource(42, {});
  });
  assert.equal(diags.length, 1);
  assert.equal(diags[0].code, 'invariant-read-failed');
});

test('checkInvariants with non-existent srcDir → invariant-read-failed diagnostics, no throw', () => {
  let result;
  assert.doesNotThrow(() => {
    result = checkInvariants('/nonexistent/path/that/does/not/exist');
  });
  assert.ok(Array.isArray(result.diagnostics));
  assert.ok(result.diagnostics.length > 0);
  assert.ok(result.diagnostics.every((d) => d.code === 'invariant-read-failed'));
});
