/**
 * P1.U7 — frontmatter.test.mjs
 *
 * Pure-parser unit tests for parseFrontmatter (no filesystem). The through-line
 * is the never-throw contract plus a few hard-won decisions: quoting disables
 * the flow check (YAML literal semantics), unbalanced flow values are rejected,
 * and file-controlled keys (e.g. __proto__) can never pollute a prototype.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFrontmatter } from '../src/discovery/frontmatter.mjs';

test('parseFrontmatter: simple scalar block', () => {
  const r = parseFrontmatter('---\nname: hello\ndescription: A skill.\nmodel: haiku\n---\n# body\n');
  assert.equal(r.hasFrontmatter, true);
  assert.equal(r.error, null);
  assert.deepEqual({ ...r.data }, { name: 'hello', description: 'A skill.', model: 'haiku' });
});

test('parseFrontmatter: folded multi-line value joins with a single space', () => {
  const r = parseFrontmatter('---\ndescription: first line\n  second line\n  third line\n---\n');
  assert.equal(r.data.description, 'first line second line third line');
});

test('parseFrontmatter: unbalanced flow value is rejected, other keys survive', () => {
  const r = parseFrontmatter('---\nname: [unclosed bracket\ndescription: kept\n---\n');
  assert.equal(r.hasFrontmatter, true);
  assert.match(r.error, /malformed flow value/);
  assert.match(r.error, /'name'/);
  assert.equal('name' in r.data, false, 'malformed key dropped');
  assert.equal(r.data.description, 'kept', 'good keys survive');
});

test('parseFrontmatter: balanced inline flow value is kept as an opaque string', () => {
  const r = parseFrontmatter('---\ntags: [a, b, c]\n---\n');
  assert.equal(r.error, null);
  assert.equal(r.data.tags, '[a, b, c]');
});

test('parseFrontmatter: a quoted bracket is a literal string, not a flow error', () => {
  // YAML: a quoted scalar is a literal, so the bracket is data, not a sequence.
  const r = parseFrontmatter('---\nname: "[literal]"\n---\n');
  assert.equal(r.error, null);
  assert.equal(r.data.name, '[literal]');
});

test('parseFrontmatter: no opening --- means no frontmatter (not an error)', () => {
  const r = parseFrontmatter('# Just a heading\n\nSome prose.\n');
  assert.equal(r.hasFrontmatter, false);
  assert.equal(r.error, null);
  assert.equal(Object.keys(r.data).length, 0);
});

test('parseFrontmatter: opened-but-never-closed block is flagged', () => {
  const r = parseFrontmatter('---\nname: hello\n# body never closes the block\n');
  assert.equal(r.hasFrontmatter, true);
  assert.match(r.error, /never closed/);
});

test('parseFrontmatter: CRLF line endings parse identically to LF', () => {
  const r = parseFrontmatter('---\r\nname: hello\r\nmodel: haiku\r\n---\r\n');
  assert.deepEqual({ ...r.data }, { name: 'hello', model: 'haiku' });
  assert.equal(r.error, null);
});

test('parseFrontmatter: a leading UTF-8 BOM is tolerated', () => {
  const r = parseFrontmatter('﻿---\nname: hello\n---\n');
  assert.equal(r.data.name, 'hello');
});

test('parseFrontmatter: surrounding quotes are stripped', () => {
  const r = parseFrontmatter('---\nname: "quoted"\ndescription: \'single\'\n---\n');
  assert.equal(r.data.name, 'quoted');
  assert.equal(r.data.description, 'single');
});

test('parseFrontmatter: a __proto__ key never pollutes Object.prototype', () => {
  const r = parseFrontmatter('---\n__proto__: injected\nname: ok\n---\n');
  assert.equal(/** @type {any} */ ({}).injected, undefined, 'no global prototype pollution');
  assert.equal(r.data.name, 'ok', 'sibling keys still parse');
  assert.equal(r.error, null);
});

test('parseFrontmatter: non-string input returns empty and never throws', () => {
  for (const bad of [undefined, null, 42, {}, []]) {
    const r = parseFrontmatter(/** @type {any} */ (bad));
    assert.equal(r.hasFrontmatter, false);
    assert.equal(r.error, null);
    assert.equal(Object.keys(r.data).length, 0);
  }
});
