/**
 * P1.U8 — plugins.test.mjs
 *
 * Golden assertions for discoverPlugins. The headline oracle is the committed
 * plugins-groundtruth/ fixture, which mirrors the real harness counts
 * (13 installed / 11 missing-cache) so the plan's acceptance is falsifiable and
 * deterministic. Synthetic temp dirs cover the schema-version and malformed-JSON
 * paths that no committed fixture exercises.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverPlugins } from '../src/discovery/plugins.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fix = (rel) => join(here, 'fixtures', rel);
const bySeverity = (diags, sev) => diags.filter((d) => d.severity === sev);

/** Run `fn` against a throwaway config dir holding plugins/<filename>. */
function withTempPluginsFile(filename, content, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'mgr-u8-'));
  try {
    mkdirSync(join(dir, 'plugins'), { recursive: true });
    writeFileSync(join(dir, 'plugins', filename), content, 'utf-8');
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── plugins-groundtruth/ (the headline oracle) ──────────────────────────────

test('plugins-groundtruth: 13 installed, 13 enabled, 2 cached, 11 missing-cache', () => {
  const { plugins, diagnostics } = discoverPlugins(fix('plugins-groundtruth'));
  assert.equal(bySeverity(diagnostics, 'error').length, 0);
  assert.equal(plugins.length, 13);
  assert.equal(plugins.filter((p) => p.enabled).length, 13);

  const cached = plugins.filter((p) => p.cachePresent);
  assert.deepEqual(cached.map((p) => p.name).sort(), ['claude-mem', 'typescript-lsp']);
  assert.equal(plugins.filter((p) => p.enabled && !p.cachePresent).length, 11);
});

test('plugins-groundtruth: cached records carry the right marketplace + version', () => {
  const { plugins } = discoverPlugins(fix('plugins-groundtruth'));
  const ts = plugins.find((p) => p.name === 'typescript-lsp');
  assert.equal(ts.cachePresent, true);
  assert.equal(ts.marketplace, 'claude-plugins-official');
  assert.equal(ts.version, '1.0.0');

  const mem = plugins.find((p) => p.name === 'claude-mem');
  assert.equal(mem.cachePresent, true);
  assert.equal(mem.marketplace, 'thedotmack');
  assert.equal(mem.version, '11.0.1');
});

test('plugins-groundtruth: output is sorted deterministically by key', () => {
  const { plugins } = discoverPlugins(fix('plugins-groundtruth'));
  const keys = plugins.map((p) => p.key);
  assert.deepEqual(keys, [...keys].sort());
});

// ── conflict/ and broken/ (existing fixtures) ───────────────────────────────

test('conflict: a single plugin whose cache dir is present', () => {
  const { plugins, diagnostics } = discoverPlugins(fix('conflict'));
  assert.equal(plugins.length, 1);
  assert.equal(plugins[0].key, 'oh-my-claudecode@claude-plugins-official');
  assert.equal(plugins[0].cachePresent, true);
  assert.equal(bySeverity(diagnostics, 'error').length, 0);
});

test('broken: two enabled plugins, both missing their cache dirs', () => {
  const { plugins, diagnostics } = discoverPlugins(fix('broken'));
  assert.equal(plugins.length, 2);
  assert.equal(plugins.filter((p) => p.enabled).length, 2);
  assert.equal(plugins.filter((p) => p.cachePresent).length, 0);
  assert.equal(bySeverity(diagnostics, 'error').length, 0, 'valid JSON, just missing caches');
});

// ── schema version + malformed JSON (synthetic) ─────────────────────────────

test('unknown schema version: warns but still parses best-effort', () => {
  const content = JSON.stringify({
    version: 3,
    plugins: { 'x@y': [{ name: 'x', marketplace: 'y', version: '1.0.0', enabled: true }] },
  });
  withTempPluginsFile('installed_plugins.json', content, (dir) => {
    const { plugins, diagnostics } = discoverPlugins(dir);
    const warn = diagnostics.find((d) => d.code === 'plugin-schema-version-unknown');
    assert.ok(warn, 'unknown-version warning emitted');
    assert.equal(warn.severity, 'warn');
    assert.equal(plugins.length, 1, 'best-effort parse still yields the entry');
  });
});

test('malformed JSON: error diagnostic, no records, never throws', () => {
  withTempPluginsFile('installed_plugins.json', '{ not valid json,, }', (dir) => {
    let result;
    assert.doesNotThrow(() => {
      result = discoverPlugins(dir);
    });
    assert.equal(result.plugins.length, 0);
    const err = result.diagnostics.find((d) => d.code === 'installed-plugins-unreadable');
    assert.ok(err);
    assert.equal(err.severity, 'error');
  });
});

test('installed_plugins.json is not a JSON object → installed-plugins-malformed warn, no records', () => {
  // a top-level JSON array (valid JSON, wrong shape) hits the non-object guard
  withTempPluginsFile('installed_plugins.json', '[1, 2, 3]', (dir) => {
    let result;
    assert.doesNotThrow(() => {
      result = discoverPlugins(dir);
    });
    assert.equal(result.plugins.length, 0);
    const warn = result.diagnostics.find((d) => d.code === 'installed-plugins-malformed');
    assert.ok(warn, 'a non-object installed_plugins.json warns');
    assert.equal(warn.severity, 'warn');
  });
});

test('a non-object plugin entry → plugin-entry-malformed warn, sibling entries still parsed', () => {
  const content = JSON.stringify({
    version: 2,
    plugins: {
      'bad@m': ['not-an-object'], // entry is a string, not an object
      'good@m': [{ name: 'good', marketplace: 'm', version: '1.0.0', enabled: true }],
    },
  });
  withTempPluginsFile('installed_plugins.json', content, (dir) => {
    const { plugins, diagnostics } = discoverPlugins(dir);
    assert.deepEqual(plugins.map((p) => p.name), ['good']);
    const warn = diagnostics.find((d) => d.code === 'plugin-entry-malformed');
    assert.ok(warn, 'a non-object entry warns');
    assert.equal(warn.severity, 'warn');
    assert.match(warn.message, /'bad@m'/);
  });
});

test('enabled is a strict boolean: false and non-true values are not enabled', () => {
  const content = JSON.stringify({
    version: 2,
    plugins: {
      'on@m': [{ name: 'on', marketplace: 'm', version: '1.0.0', enabled: true }],
      'off@m': [{ name: 'off', marketplace: 'm', version: '1.0.0', enabled: false }],
      'truthy@m': [{ name: 'truthy', marketplace: 'm', version: '1.0.0', enabled: 1 }],
    },
  });
  withTempPluginsFile('installed_plugins.json', content, (dir) => {
    const { plugins } = discoverPlugins(dir);
    const byName = Object.fromEntries(plugins.map((p) => [p.name, p]));
    assert.equal(byName.on.enabled, true);
    assert.equal(byName.off.enabled, false);
    assert.equal(byName.truthy.enabled, false, 'a truthy non-true value is not "enabled"');
  });
});

// ── input edge cases ────────────────────────────────────────────────────────

test('minimal: no installed_plugins.json → empty, no diagnostics', () => {
  const { plugins, diagnostics } = discoverPlugins(fix('minimal'));
  assert.deepEqual(plugins, []);
  assert.deepEqual(diagnostics, []);
});

test('non-string root emits discover-bad-root and never throws', () => {
  let result;
  assert.doesNotThrow(() => {
    result = discoverPlugins(/** @type {any} */ (undefined));
  });
  assert.deepEqual(result.plugins, []);
  assert.equal(result.diagnostics[0].code, 'discover-bad-root');
  assert.equal(result.diagnostics[0].severity, 'error');
});
