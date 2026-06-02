/**
 * Unit oracle for the MCP purpose categorizer (src/analysis/categorize-mcp.mjs).
 *
 * Pins representative service-name → bucket for each category, the order-sensitive
 * cases, uncategorized + its info diagnostic, the full-vocabulary grouped output,
 * determinism, never-throws, and proto-safety. Like the component categorizer this
 * is a DISPLAY heuristic over the SHARED CATEGORIES vocab — these assert the
 * intended taxonomy choices, refined by dogfood.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { categorizeMcpServer, categorizeMcp } from '../src/analysis/categorize-mcp.mjs';
import { CATEGORIES } from '../src/analysis/categorize.mjs';

const S = (name) => ({ name });

test('representative MCP service name → category', () => {
  const cases = [
    ['github', 'development'],
    ['playwright', 'development'],
    ['exa', 'research'],
    ['context7', 'research'],
    ['pencil', 'design'],
    ['memory', 'self-iteration'],
    ['sequential-thinking', 'self-iteration'],
    ['postgres', 'data'],
    ['computer-use', 'ops'],
    ['slack', 'ops'],
    ['stripe', 'business'],
    ['some-unknown-service', 'uncategorized'],
  ];
  for (const [name, expected] of cases) {
    assert.equal(categorizeMcpServer(S(name)), expected, `${name} → ${expected}`);
  }
});

test('categorizeMcp returns the FULL category vocabulary + groups servers', () => {
  const { byCategory, summary } = categorizeMcp([S('github'), S('exa'), S('pencil'), S('memory')]);
  for (const cat of CATEGORIES) {
    assert.ok(Array.isArray(byCategory[cat]), `byCategory has ${cat}`);
    assert.equal(typeof summary[cat], 'number', `summary has ${cat}`);
  }
  assert.deepEqual(byCategory.development, ['github']);
  assert.deepEqual(byCategory.research, ['exa']);
  assert.deepEqual(byCategory.design, ['pencil']);
  assert.deepEqual(byCategory['self-iteration'], ['memory']);
  assert.equal(summary.uncategorized, 0);
});

test('byCategory lists are sorted (deterministic)', () => {
  const { byCategory } = categorizeMcp([S('zebra-db'), S('postgres'), S('mysql')]);
  assert.deepEqual(byCategory.data, ['mysql', 'postgres', 'zebra-db']);
});

test('uncategorized emits exactly one info diagnostic with the count', () => {
  const { diagnostics, summary } = categorizeMcp([S('mystery-a'), S('mystery-b'), S('github')]);
  assert.equal(summary.uncategorized, 2);
  const info = diagnostics.filter((d) => d.code === 'categorize-mcp-uncategorized');
  assert.equal(info.length, 1);
  assert.equal(info[0].severity, 'info');
  assert.match(info[0].message, /2 MCP server/);
});

test('no uncategorized → no diagnostic', () => {
  const { diagnostics } = categorizeMcp([S('github'), S('exa')]);
  assert.deepEqual(diagnostics, []);
});

test('never throws on junk / malformed servers; proto-safe', () => {
  for (const junk of [null, undefined, 42, 'str', {}, { name: 123 }, { name: null }]) {
    assert.doesNotThrow(() => categorizeMcpServer(junk));
    assert.equal(categorizeMcpServer(junk), 'uncategorized');
  }
  const { byCategory, summary } = categorizeMcp([{ name: '__proto__' }]);
  assert.doesNotThrow(() => categorizeMcp(undefined));
  assert.equal({}.polluted, undefined, 'Object.prototype not polluted');
  assert.ok(summary.uncategorized >= 1);
  assert.ok(byCategory.uncategorized.includes('__proto__'));
});

test('categorizeMcp(non-array) is benign', () => {
  const { summary } = categorizeMcp(undefined);
  assert.equal(summary.uncategorized, 0);
});
