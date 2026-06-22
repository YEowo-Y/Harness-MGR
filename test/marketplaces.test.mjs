/**
 * P1.U8 — marketplaces.test.mjs
 *
 * Golden assertions for discoverMarketplaces against plugins-groundtruth/ (4
 * marketplaces, 2 with on-disk clones), plus a redaction guard proving the
 * fixture leaks no real user path, and synthetic temp dirs for the
 * malformed-JSON path.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverMarketplaces } from '../src/discovery/marketplaces.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fix = (rel) => join(here, 'fixtures', rel);
const bySeverity = (diags, sev) => diags.filter((d) => d.severity === sev);

/** Run `fn` against a throwaway config dir holding plugins/<filename>. */
function withTempMarketplacesFile(content, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'mgr-u8-mk-'));
  try {
    mkdirSync(join(dir, 'plugins'), { recursive: true });
    writeFileSync(join(dir, 'plugins', 'known_marketplaces.json'), content, 'utf-8');
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── plugins-groundtruth/ ────────────────────────────────────────────────────

test('plugins-groundtruth: 4 marketplaces, exactly 2 on disk', () => {
  const { marketplaces, diagnostics } = discoverMarketplaces(fix('plugins-groundtruth'));
  assert.equal(bySeverity(diagnostics, 'error').length, 0);
  assert.equal(marketplaces.length, 4);

  const onDisk = marketplaces.filter((m) => m.onDisk).map((m) => m.name).sort();
  assert.deepEqual(onDisk, ['claude-plugins-official', 'thedotmack']);

  const cpo = marketplaces.find((m) => m.name === 'claude-plugins-official');
  assert.equal(cpo.sourceRepo, 'anthropics/claude-plugins-official');
  assert.ok(cpo.installLocation, 'installLocation recorded verbatim');
});

test('plugins-groundtruth: output is sorted deterministically by name', () => {
  const { marketplaces } = discoverMarketplaces(fix('plugins-groundtruth'));
  const names = marketplaces.map((m) => m.name);
  assert.deepEqual(names, [...names].sort());
});

test('REDACTION: no marketplace installLocation leaks a real user path', () => {
  const REAL_USER = userInfo().username || '';
  const { marketplaces } = discoverMarketplaces(fix('plugins-groundtruth'));
  for (const m of marketplaces) {
    const loc = m.installLocation || '';
    assert.ok(!/[A-Za-z]:[\\/]Users/.test(loc), `no Windows user path in ${m.name}`);
    if (REAL_USER.length >= 3) assert.ok(!loc.includes(REAL_USER), `no real username in ${m.name}`);
  }
});

// ── malformed JSON + input edge cases ───────────────────────────────────────

test('malformed JSON: error diagnostic, no records, never throws', () => {
  withTempMarketplacesFile('{ "x": { not valid }, }', (dir) => {
    let result;
    assert.doesNotThrow(() => {
      result = discoverMarketplaces(dir);
    });
    assert.equal(result.marketplaces.length, 0);
    const err = result.diagnostics.find((d) => d.code === 'known-marketplaces-unreadable');
    assert.ok(err);
    assert.equal(err.severity, 'error');
  });
});

test('a non-object marketplace entry is skipped with a warn', () => {
  const content = JSON.stringify({
    good: { source: { source: 'github', repo: 'a/b' } },
    bad: 'not-an-object',
  });
  withTempMarketplacesFile(content, (dir) => {
    const { marketplaces, diagnostics } = discoverMarketplaces(dir);
    assert.equal(marketplaces.length, 1);
    assert.equal(marketplaces[0].name, 'good');
    assert.ok(diagnostics.find((d) => d.code === 'marketplace-entry-malformed'));
  });
});

test('minimal: no known_marketplaces.json → empty, no diagnostics', () => {
  const { marketplaces, diagnostics } = discoverMarketplaces(fix('minimal'));
  assert.deepEqual(marketplaces, []);
  assert.deepEqual(diagnostics, []);
});

test('non-string root emits discover-bad-root and never throws', () => {
  let result;
  assert.doesNotThrow(() => {
    result = discoverMarketplaces(/** @type {any} */ (undefined));
  });
  assert.deepEqual(result.marketplaces, []);
  assert.equal(result.diagnostics[0].code, 'discover-bad-root');
  assert.equal(result.diagnostics[0].severity, 'error');
});
