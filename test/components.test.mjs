/**
 * P1.U7 — components.test.mjs
 *
 * Golden discovery assertions for discoverComponents against the minimal/,
 * broken/, and unicode-paths/ fixtures (the stated U7 acceptance corpus). The
 * through-line is the never-throw contract: bad input becomes a Diagnostic, the
 * scan keeps going, and counts stay honest. (Pure-parser tests live in
 * frontmatter.test.mjs.)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverComponents } from '../src/discovery/components.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fix = (rel) => join(here, 'fixtures', rel);

/** @param {import('../src/discovery/components.mjs').ComponentRecord[]} comps */
const find = (comps, kind, name) => comps.find((c) => c.kind === kind && c.name === name);
const bySeverity = (diags, sev) => diags.filter((d) => d.severity === sev);

// ── minimal/ (the happy path) ───────────────────────────────────────────────

test('minimal: discovers exactly one skill, one agent, one command', () => {
  const { components, diagnostics } = discoverComponents(fix('minimal'));
  assert.equal(components.length, 3);
  assert.equal(bySeverity(diagnostics, 'error').length, 0);
  assert.equal(bySeverity(diagnostics, 'warn').length, 0);

  const skill = find(components, 'skill', 'hello');
  assert.ok(skill, 'hello skill found');
  assert.equal(skill.frontmatter.model, 'haiku');
  assert.equal(skill.source.tier, 'user');
  assert.match(skill.path, /hello[\\/]SKILL\.md$/);

  assert.ok(find(components, 'agent', 'helper'), 'helper agent found (name from frontmatter)');
  assert.ok(find(components, 'command', 'greet'), 'greet command found (name from basename)');
});

test('minimal: output is sorted deterministically by (kind, name, path)', () => {
  const { components } = discoverComponents(fix('minimal'));
  const sorted = [...components].sort((a, b) =>
    a.kind !== b.kind ? (a.kind < b.kind ? -1 : 1) : a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  assert.deepEqual(components.map((c) => `${c.kind}/${c.name}`), sorted.map((c) => `${c.kind}/${c.name}`));
});

test('minimal: a provenance override flows onto every record', () => {
  const { components } = discoverComponents(fix('minimal'), { tier: 'plugin', plugin: 'demo', marketplace: 'mk' });
  assert.ok(components.length > 0);
  for (const c of components) {
    assert.equal(c.source.tier, 'plugin');
    assert.equal(c.source.plugin, 'demo');
  }
});

// ── broken/ (degrade, never throw) ──────────────────────────────────────────

test('broken: malformed frontmatter yields a record + a warn diagnostic, never throws', () => {
  let result;
  assert.doesNotThrow(() => {
    result = discoverComponents(fix('broken'));
  });
  const { components, diagnostics } = result;

  // The skill still exists; its identity is the directory name, not frontmatter.
  assert.equal(components.length, 1);
  const skill = components[0];
  assert.equal(skill.kind, 'skill');
  assert.equal(skill.name, 'bad-frontmatter');
  assert.equal('name' in skill.frontmatter, false, 'unparseable name key dropped');
  assert.match(skill.frontmatter.description, /malformed/, 'good keys still parsed');

  const invalid = diagnostics.filter((d) => d.code === 'frontmatter-invalid');
  assert.equal(invalid.length, 1);
  assert.equal(invalid[0].severity, 'warn');
  assert.equal(invalid[0].path, skill.path);
  assert.equal(bySeverity(diagnostics, 'error').length, 0, 'malformed frontmatter is not a tool error');
});

// ── unicode-paths/ (UTF-8 integrity) ────────────────────────────────────────

test('unicode-paths: non-ASCII skill and agent names are preserved', () => {
  const { components, diagnostics } = discoverComponents(fix('unicode-paths'));
  assert.equal(bySeverity(diagnostics, 'error').length, 0);
  assert.equal(components.length, 2);

  const skill = find(components, 'skill', 'café-assistant');
  assert.ok(skill, 'café-assistant skill found with Unicode name intact');
  assert.equal(skill.frontmatter.name, 'café-assistant');

  const agent = find(components, 'agent', 'répondeur');
  assert.ok(agent, 'répondeur agent found (Unicode name from frontmatter)');
});

// ── input edge cases ────────────────────────────────────────────────────────

test('bogus root path returns empty with no diagnostics (absent dirs = no components)', () => {
  const { components, diagnostics } = discoverComponents(fix('this-dir-does-not-exist'));
  assert.deepEqual(components, []);
  assert.deepEqual(diagnostics, []);
});

test('non-string root emits a discover-bad-root error and never throws', () => {
  let result;
  assert.doesNotThrow(() => {
    result = discoverComponents(/** @type {any} */ (undefined));
  });
  assert.deepEqual(result.components, []);
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0].code, 'discover-bad-root');
  assert.equal(result.diagnostics[0].severity, 'error');
});
