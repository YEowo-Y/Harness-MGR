/**
 * P2.U5b — probe-mcp.test.mjs
 *
 * Tests for gatherMcpProbes: auth-cache reading (golden + edge cases) and
 * stdio command resolution. All cases must never throw; degrade to diagnostics.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gatherMcpProbes } from '../src/discovery/probe-mcp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fix = (rel) => join(here, 'fixtures', rel);

// ── 1. auth cache golden ─────────────────────────────────────────────────────

test('auth cache golden: 3 valid entries, 2 malformed warns, no __proto__ leak', () => {
  const { mcpAuth, diagnostics } = gatherMcpProbes({ configDir: fix('mcp-auth-cache') });

  // Exactly the 3 valid timestamp entries
  assert.equal(mcpAuth.length, 3, `expected 3 facts, got ${mcpAuth.length}`);

  const byName = Object.fromEntries(mcpAuth.map((f) => [f.name, f]));
  assert.equal(byName['fresh-server'].timestamp, 1799136000000);
  assert.equal(byName['warn-server'].timestamp, 1796112000000);
  assert.equal(byName['error-server'].timestamp, 1789632000000);

  // __proto__ must never appear in output (prototype-pollution guard)
  const names = mcpAuth.map((f) => f.name);
  assert.ok(!names.includes('__proto__'), '__proto__ key must not reach mcpAuth');

  // Exactly 2 mcp-auth-entry-malformed warns (no-timestamp + not-an-object)
  const malformed = diagnostics.filter((d) => d.code === 'mcp-auth-entry-malformed');
  assert.equal(malformed.length, 2, `expected 2 malformed warns, got ${malformed.length}`);
  assert.ok(malformed.every((d) => d.severity === 'warn'));
});

// ── 2. missing cache file ────────────────────────────────────────────────────

test('missing cache file: empty mcpAuth, zero diagnostics', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'mgr-probemcp-'));
  try {
    const { mcpAuth, diagnostics } = gatherMcpProbes({ configDir: tmp });
    assert.deepEqual(mcpAuth, []);
    // Only the discover-bad-root error would appear if configDir were bad,
    // but it is a valid dir — so 0 diagnostics expected.
    assert.equal(diagnostics.length, 0);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── 3. unreadable (bad JSON) cache ───────────────────────────────────────────

test('unreadable cache (bad JSON): empty mcpAuth + mcp-auth-cache-unreadable warn', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'mgr-probemcp-'));
  try {
    writeFileSync(join(tmp, 'mcp-needs-auth-cache.json'), '{ bad json', 'utf-8');
    const { mcpAuth, diagnostics } = gatherMcpProbes({ configDir: tmp });
    assert.deepEqual(mcpAuth, []);
    const warn = diagnostics.find((d) => d.code === 'mcp-auth-cache-unreadable');
    assert.ok(warn, 'expected mcp-auth-cache-unreadable diagnostic');
    assert.equal(warn.severity, 'warn');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── 4. non-object (array) cache ──────────────────────────────────────────────

test('non-object cache (array): empty mcpAuth + mcp-auth-cache-malformed warn', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'mgr-probemcp-'));
  try {
    writeFileSync(join(tmp, 'mcp-needs-auth-cache.json'), '[]', 'utf-8');
    const { mcpAuth, diagnostics } = gatherMcpProbes({ configDir: tmp });
    assert.deepEqual(mcpAuth, []);
    const warn = diagnostics.find((d) => d.code === 'mcp-auth-cache-malformed');
    assert.ok(warn, 'expected mcp-auth-cache-malformed diagnostic');
    assert.equal(warn.severity, 'warn');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── 5. resolution: stdio resolved/unresolved, http skipped ───────────────────

test('resolution: good resolves, bad does not, http skipped', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'mgr-probemcp-'));
  try {
    // Write a file named 'mytool' (no extension) so linux PATH resolution finds it
    writeFileSync(join(tmp, 'mytool'), '#!/bin/sh\necho hi', 'utf-8');

    const { mcpResolution, diagnostics } = gatherMcpProbes({
      configDir: tmp,
      mcpServers: [
        { name: 'good', transport: 'stdio', command: 'mytool' },
        { name: 'bad', transport: 'stdio', command: 'nope-xyz-not-real' },
        { name: 'web', transport: 'http', url: 'https://x' },
      ],
      env: { PATH: tmp },
      platform: 'linux',
    });

    // http server must not appear
    assert.equal(mcpResolution.length, 2, `expected 2 resolution facts, got ${mcpResolution.length}`);

    const good = mcpResolution.find((f) => f.name === 'good');
    const bad = mcpResolution.find((f) => f.name === 'bad');
    assert.ok(good, 'good server fact missing');
    assert.equal(good.resolved, true, 'good server should resolve');
    assert.equal(good.command, 'mytool');

    assert.ok(bad, 'bad server fact missing');
    assert.equal(bad.resolved, false, 'bad server should not resolve');
    assert.equal(bad.command, 'nope-xyz-not-real');

    // No resolution diagnostics expected
    assert.ok(!diagnostics.find((d) => d.code === 'discover-bad-root'), 'no discover-bad-root expected when configDir is valid');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── 6. bad configDir: error diagnostic + resolution still runs ───────────────

test('missing configDir: discover-bad-root error AND resolution still runs', () => {
  const { mcpAuth, mcpResolution, diagnostics } = gatherMcpProbes({
    mcpServers: [{ name: 'x', transport: 'stdio', command: 'nope' }],
  });

  // Auth empty
  assert.deepEqual(mcpAuth, []);

  // discover-bad-root error present
  const err = diagnostics.find((d) => d.code === 'discover-bad-root');
  assert.ok(err, 'expected discover-bad-root diagnostic');
  assert.equal(err.severity, 'error');

  // Resolution still ran (command 'nope' won't resolve, but the fact is emitted)
  assert.equal(mcpResolution.length, 1, 'resolution should still run with 1 server');
  assert.equal(mcpResolution[0].name, 'x');
  assert.equal(mcpResolution[0].command, 'nope');
  assert.equal(mcpResolution[0].resolved, false);
});

// ── 7. junk opts never throw ─────────────────────────────────────────────────

test('junk opts never throw and return empty facts + discover-bad-root', () => {
  for (const junk of [null, undefined, 42, 'x']) {
    assert.doesNotThrow(
      () => {
        const result = gatherMcpProbes(/** @type {any} */ (junk));
        assert.deepEqual(result.mcpAuth, [], `mcpAuth should be empty for junk=${JSON.stringify(junk)}`);
        assert.deepEqual(result.mcpResolution, [], `mcpResolution should be empty for junk=${JSON.stringify(junk)}`);
        const err = result.diagnostics.find((d) => d.code === 'discover-bad-root');
        assert.ok(err, `expected discover-bad-root for junk=${JSON.stringify(junk)}`);
      },
      `gatherMcpProbes(${JSON.stringify(junk)}) must not throw`,
    );
  }
});
