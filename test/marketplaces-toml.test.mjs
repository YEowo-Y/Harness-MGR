/**
 * marketplaces-toml.test.mjs (P6 — codex marketplaces).
 *
 * Falsifiable oracles for discoverMarketplacesForTarget (src/discovery/marketplaces-target.mjs):
 *   - CODEX: the UNION of the config.toml `[marketplaces]` table (declared, with a
 *     `source` -> installLocation) AND the plugins/cache/<name>/ dirs (on-disk). A scalar
 *     table setting (max_depth) is skipped silently; a cached-but-undeclared marketplace
 *     surfaces; onDisk = the cache dir exists.
 *   - BACK-COMPAT: claude / no-descriptor === the existing discoverMarketplaces (drift-guard).
 *
 * Temp trees via mkdtempSync(tmpdir()), cleaned in finally.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverMarketplacesForTarget } from '../src/discovery/marketplaces-target.mjs';
import { discoverMarketplaces } from '../src/discovery/marketplaces.mjs';
import { claudeDescriptor } from '../src/targets/claude.mjs';
import { codexDescriptor } from '../src/targets/codex.mjs';

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'mgr-mkt-'));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

const mkCacheDir = (dir, name) => mkdirSync(join(dir, 'plugins', 'cache', name), { recursive: true });

// ── CODEX union golden ─────────────────────────────────────────────────────────

test('codex: config.toml [marketplaces] table ∪ plugins/cache dirs (max_depth skipped, union, onDisk)', () => {
  withTempDir((dir) => {
    // A [marketplaces] table mixing a scalar setting (max_depth) with two declared marketplaces.
    writeFileSync(join(dir, 'config.toml'),
      '[marketplaces]\nmax_depth = 2\n\n[marketplaces.alpha]\nsource = "/p/alpha"\n\n[marketplaces.beta]\nsource = "/p/beta"\n', 'utf8');
    mkCacheDir(dir, 'alpha');  // declared + cached → installLocation + onDisk:true
    mkCacheDir(dir, 'gamma');  // NOT declared + cached → cache-only, onDisk:true
    // beta is declared but has NO cache dir → onDisk:false

    const { marketplaces, diagnostics } = discoverMarketplacesForTarget({ rootDir: dir, descriptor: codexDescriptor });
    assert.equal(diagnostics.filter((d) => d.severity === 'error').length, 0);
    // exactly 3 marketplaces, sorted by name; max_depth is NOT a marketplace.
    assert.deepEqual(marketplaces, [
      { name: 'alpha', onDisk: true, installLocation: '/p/alpha' },
      { name: 'beta', onDisk: false, installLocation: '/p/beta' },
      { name: 'gamma', onDisk: true },
    ]);
    assert.equal(marketplaces.some((m) => m.name === 'max_depth'), false, 'a scalar table setting must not become a marketplace');
  });
});

test('codex: a missing config.toml is benign — only the cache dirs surface', () => {
  withTempDir((dir) => {
    mkCacheDir(dir, 'openai-curated');
    const { marketplaces, diagnostics } = discoverMarketplacesForTarget({ rootDir: dir, descriptor: codexDescriptor });
    assert.equal(diagnostics.filter((d) => d.severity === 'error').length, 0);
    assert.deepEqual(marketplaces, [{ name: 'openai-curated', onDisk: true }]);
  });
});

test('codex: an invalid config.toml → marketplaces-toml-invalid warn, cache dirs still scan', () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, 'config.toml'), '[marketplaces\nbroken', 'utf8'); // unterminated table header
    mkCacheDir(dir, 'openai-bundled');
    const { marketplaces, diagnostics } = discoverMarketplacesForTarget({ rootDir: dir, descriptor: codexDescriptor });
    assert.equal(diagnostics.some((d) => d.code === 'marketplaces-toml-invalid'), true);
    assert.deepEqual(marketplaces.map((m) => m.name), ['openai-bundled'], 'cache dirs still scanned after a parse error');
  });
});

test('codex: no config.toml AND no cache → empty (never throws)', () => {
  withTempDir((dir) => {
    const r = discoverMarketplacesForTarget({ rootDir: dir, descriptor: codexDescriptor });
    assert.deepEqual(r.marketplaces, []);
    assert.equal(r.diagnostics.filter((d) => d.severity === 'error').length, 0);
  });
});

test('bad root → discover-bad-root, never throws', () => {
  const r = discoverMarketplacesForTarget({ rootDir: '', descriptor: codexDescriptor });
  assert.deepEqual(r.marketplaces, []);
  assert.equal(r.diagnostics.some((d) => d.code === 'discover-bad-root'), true);
});

// ── BACK-COMPAT drift-guard ──────────────────────────────────────────────────────

test('back-compat: claude / no-descriptor === the existing discoverMarketplaces (deepEqual)', () => {
  withTempDir((dir) => {
    // a known_marketplaces.json (the claude source) + a marketplaces clone on disk
    mkdirSync(join(dir, 'plugins', 'marketplaces', 'mkt-a'), { recursive: true });
    writeFileSync(join(dir, 'plugins', 'known_marketplaces.json'),
      JSON.stringify({ 'mkt-a': { source: { source: 'github', repo: 'o/r' }, installLocation: '/abs/x' } }), 'utf8');

    const direct = discoverMarketplaces(dir);
    assert.deepEqual(discoverMarketplacesForTarget({ rootDir: dir }), direct);
    assert.deepEqual(discoverMarketplacesForTarget({ rootDir: dir, descriptor: claudeDescriptor }), direct);
    // codex's plugins/cache is NOT consulted on the claude path (sanity)
    assert.ok(direct.marketplaces.some((m) => m.name === 'mkt-a' && m.onDisk === true));
  });
});
