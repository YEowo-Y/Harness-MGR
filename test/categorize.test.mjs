/**
 * Unit oracle for the purpose categorizer (src/analysis/categorize.mjs).
 *
 * Pins: representative name→category for every bucket; the ORDER-sensitive cases
 * (self-iteration beats the broad development catch-all; domain beats self-iteration
 * + development); description-based fallback; uncategorized + its info diagnostic;
 * the full-vocabulary grouped output; determinism; never-throws / proto-safety.
 *
 * Heuristic note: this is a DISPLAY aid (keyword matching), so these tests pin the
 * INTENDED taxonomy decisions, not an exhaustive truth table — the dogfood refines
 * the rules. Each asserted case is a deliberate taxonomy choice.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { categorizeComponent, categorizeComponents, CATEGORIES } from '../src/analysis/categorize.mjs';

const C = (name, description) => ({ name, kind: 'skill', frontmatter: description ? { description } : {} });

test('representative name → category for each bucket', () => {
  const cases = [
    ['article-writing', 'writing'],
    ['python-testing', 'development'],
    ['rust-reviewer', 'development'],
    ['skill-creator', 'self-iteration'],
    ['hookify', 'self-iteration'],
    ['deep-research', 'research'],
    ['canvas-design', 'design'],
    ['docker-patterns', 'ops'],          // 'docker' (ops) precedes 'patterns' (dev) in rule order
    ['dashboard-builder', 'data'],
    ['marketing-agent', 'business'],
    ['healthcare-cdss-patterns', 'domain'],
    ['some-totally-unknown-thing', 'uncategorized'],
  ];
  for (const [name, expected] of cases) {
    assert.equal(categorizeComponent(C(name)), expected, `${name} → ${expected}`);
  }
});

test('ORDER: self-iteration beats the broad development catch-all', () => {
  // skill-creator / agent-eval contain dev-ish words but are META (about the tooling).
  assert.equal(categorizeComponent(C('skill-creator')), 'self-iteration');
  assert.equal(categorizeComponent(C('agent-eval')), 'self-iteration');
  assert.equal(categorizeComponent(C('harness-optimizer')), 'self-iteration');
});

test('ORDER: domain beats self-iteration and development', () => {
  // a healthcare eval harness is a DOMAIN vertical, not meta-tooling.
  assert.equal(categorizeComponent(C('healthcare-eval-harness')), 'domain');
  assert.equal(categorizeComponent(C('springboot-security')), 'development'); // no domain word → dev
});

test('description fallback classifies when the name is ambiguous', () => {
  assert.equal(categorizeComponent(C('helper', 'Write blog posts and articles in a brand voice')), 'writing');
  assert.equal(categorizeComponent(C('thing', 'Deploy via a CI/CD pipeline to docker')), 'ops');
  assert.equal(categorizeComponent(C('zzz', 'no recognizable purpose here at all')), 'uncategorized');
});

test('categorizeComponents returns the FULL category vocabulary (empty buckets included)', () => {
  const { byCategory, summary } = categorizeComponents([C('article-writing'), C('rust-reviewer')]);
  for (const cat of CATEGORIES) {
    assert.ok(Array.isArray(byCategory[cat]), `byCategory has ${cat}`);
    assert.equal(typeof summary[cat], 'number', `summary has ${cat}`);
  }
  assert.deepEqual(byCategory.writing, ['article-writing']);
  assert.deepEqual(byCategory.development, ['rust-reviewer']);
  assert.equal(summary.writing, 1);
  assert.equal(summary.development, 1);
  assert.equal(summary.uncategorized, 0);
});

test('byCategory lists are sorted (deterministic output)', () => {
  const { byCategory } = categorizeComponents([C('zebra-reviewer'), C('alpha-test'), C('mango-build')]);
  assert.deepEqual(byCategory.development, ['alpha-test', 'mango-build', 'zebra-reviewer']);
});

test('uncategorized emits exactly one info diagnostic with the count', () => {
  const { diagnostics, summary } = categorizeComponents([C('mystery-x'), C('mystery-y'), C('article-writing')]);
  assert.equal(summary.uncategorized, 2);
  const info = diagnostics.filter((d) => d.code === 'categorize-uncategorized');
  assert.equal(info.length, 1);
  assert.equal(info[0].severity, 'info');
  assert.match(info[0].message, /2 component/);
});

test('no uncategorized → no diagnostic', () => {
  const { diagnostics } = categorizeComponents([C('article-writing'), C('rust-reviewer')]);
  assert.deepEqual(diagnostics, []);
});

test('never throws on junk / malformed components; proto-safe', () => {
  for (const junk of [null, undefined, 42, 'str', {}, { name: 123 }, { name: null }]) {
    assert.doesNotThrow(() => categorizeComponent(junk));
    assert.equal(categorizeComponent(junk), 'uncategorized');
  }
  // A component literally named __proto__ must not pollute the grouped output.
  const { byCategory, summary } = categorizeComponents([{ name: '__proto__', kind: 'skill', frontmatter: {} }]);
  assert.doesNotThrow(() => categorizeComponents(undefined));
  assert.equal({}.polluted, undefined, 'Object.prototype not polluted');
  // __proto__ is a value pushed into an array (uncategorized), never used as a key.
  assert.ok(summary.uncategorized >= 1);
  assert.ok(byCategory.uncategorized.includes('__proto__'));
});

test('categorizeComponents(non-array) is benign', () => {
  const { items, summary } = categorizeComponents(undefined);
  assert.deepEqual(items, []);
  assert.equal(summary.uncategorized, 0);
});

test('pathological description does NOT backtrack catastrophically (ReDoS guard)', () => {
  // Repeated self-iteration trigger word, no period, no second-group word → the
  // worst case for the `[^.]{0,300}` gap. Pre-fix (unbounded `[^.]*`, uncapped input)
  // this was ~1500ms (quadratic); the input cap + bounded gap keep it ~linear.
  const evil = 'skill '.repeat(20000); // ~120 KB
  const t0 = process.hrtime.bigint();
  const cat = categorizeComponent({ name: 'x', frontmatter: { description: evil } });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.equal(typeof cat, 'string');
  assert.ok(ms < 100, `categorize must be bounded (pre-fix ~1500ms); took ${ms}ms`);
});
