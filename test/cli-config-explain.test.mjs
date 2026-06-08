/**
 * CLI tests for `config show-effective --explain` (P4b / --explain wiring).
 *
 * Falsifiable oracles:
 *   1. --explain returns result.explain===true and keys with winner/perLayer.
 *   2. SECRET ORACLE: plaintext secret is ABSENT from the entire stdout even with
 *      --explain (provenance does not bypass the redaction layer).
 *   3. --explain with --key returns the enriched merge entry (winner present).
 *   4. --order is now an UNKNOWN flag → exit 2.
 *   5. Render: effectiveTable with explain data produces provenance lines and
 *      does not throw on missing/malformed fields.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { run } from '../src/cli.mjs';
import { renderTable } from '../src/cli/render.mjs';

/** Write user settings.json (and optionally local settings.json) into a temp dir. */
function makeTempConfig(userSettings, localSettings) {
  const dir = mkdtempSync(join(tmpdir(), 'mgr-explain-'));
  writeFileSync(join(dir, 'settings.json'), JSON.stringify(userSettings), 'utf8');
  if (localSettings) {
    writeFileSync(join(dir, 'settings.local.json'), JSON.stringify(localSettings), 'utf8');
  }
  return dir;
}

// ── 1. Basic --explain: explain:true, winner, perLayer ────────────────────────

test('config show-effective --explain --format json: result.explain===true, winner + perLayer present', async () => {
  const dir = makeTempConfig({ model: 'sonnet' }, { model: 'opus' });
  try {
    const out = await run(['config', 'show-effective', '--explain', '--config-dir', dir, '--format', 'json']);
    assert.equal(out.code, 0, `expected exit 0, got ${out.code}: ${out.stdout}`);
    const env = JSON.parse(out.stdout);
    assert.equal(env.result.explain, true, 'result.explain must be true');
    // keys map must be present
    assert.ok(env.result.keys && typeof env.result.keys === 'object', 'result.keys must be an object');
    const modelKm = env.result.keys.model;
    assert.ok(modelKm, 'model key must be present');
    // The local (higher) layer wins for scalar-highest
    assert.equal(modelKm.winner, 'local', `winner must be 'local', got: ${modelKm.winner}`);
    // perLayer covers both layers
    assert.ok(Array.isArray(modelKm.perLayer), 'perLayer must be an array');
    assert.equal(modelKm.perLayer.length, 2, 'perLayer must list both layers');
    assert.equal(modelKm.perLayer[0].name, 'user');
    assert.equal(modelKm.perLayer[1].name, 'local');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 2. SECRET ORACLE (headline) ───────────────────────────────────────────────

test('SECRET ORACLE: --explain does not leak env secret values in stdout', async () => {
  const SECRET = 'sk-ant-SECRETVALUE123-SENTINEL';
  const dir = makeTempConfig(
    { model: 'sonnet', env: { ANTHROPIC_API_KEY: SECRET, PLAIN: 'plainval' } },
    { model: 'opus' },
  );
  try {
    const out = await run(['config', 'show-effective', '--explain', '--config-dir', dir, '--format', 'json']);
    assert.equal(out.code, 0, `expected exit 0, got ${out.code}: ${out.stdout}`);

    // The ENTIRE stdout must not contain the secret plaintext.
    assert.ok(
      !out.stdout.includes(SECRET),
      `plaintext secret leaked in stdout: found '${SECRET}' in output`,
    );
    assert.ok(
      !out.stdout.includes('plainval'),
      'env PLAIN value leaked (whole env map is redacted)',
    );

    // Redaction sentinel must be present.
    assert.ok(out.stdout.includes('redacted'), 'expected {redacted} sentinel in output');
    assert.match(out.stdout, /"sha256":\s*"[0-9a-f]{64}"/, 'expected sha256 hex in redacted value');

    // Key NAMES stay visible.
    assert.ok(out.stdout.includes('ANTHROPIC_API_KEY'), 'env key name must remain visible');

    // env perLayer values must be redacted sentinels, NOT plaintext.
    const env = JSON.parse(out.stdout);
    const envKm = env.result.keys.env;
    assert.ok(envKm, 'env key must be present');
    assert.ok(Array.isArray(envKm.perLayer), 'env perLayer must be an array');
    for (const entry of envKm.perLayer) {
      if (entry && typeof entry.value === 'object' && entry.value !== null) {
        // perLayer value for 'env' is the raw per-layer env object — each sub-value
        // (the actual API key value) must be redacted.
        const serialized = JSON.stringify(entry.value);
        assert.ok(
          !serialized.includes(SECRET),
          `plaintext secret found in perLayer[].value for env layer '${entry.name}'`,
        );
        assert.ok(
          serialized.includes('redacted'),
          `perLayer[].value for env layer '${entry.name}' must carry {redacted} sentinel`,
        );
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 3. --explain with --key ────────────────────────────────────────────────────

test('config show-effective --key model --explain --format json: merge.winner present', async () => {
  const dir = makeTempConfig({ model: 'sonnet' }, { model: 'opus' });
  try {
    const out = await run(['config', 'show-effective', '--key', 'model', '--explain', '--config-dir', dir, '--format', 'json']);
    assert.equal(out.code, 0, `expected exit 0, got ${out.code}: ${out.stdout}`);
    const env = JSON.parse(out.stdout);
    assert.equal(env.result.key, 'model');
    // merge must carry winner (enriched via --explain)
    assert.ok(env.result.merge, 'merge must be present');
    assert.equal(env.result.merge.winner, 'local', `merge.winner must be 'local'`);
    assert.ok(Array.isArray(env.result.merge.perLayer), 'merge.perLayer must be an array');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 4. --order is now an UNKNOWN flag → exit 2 ────────────────────────────────

test('--order is an unknown flag → exit 2 (removed in --explain wiring)', async () => {
  const out = await run(['hooks', '--order', '--format', 'json']);
  assert.equal(out.code, 2, `--order must produce exit 2 (unknown flag), got ${out.code}`);
});

// ── 5. Render: effectiveTable with explain data ────────────────────────────────

test('effectiveTable with explain:true renders provenance lines and never throws', () => {
  const result = {
    explain: true,
    effective: { model: 'opus' },
    keys: {
      model: {
        key: 'model', strategy: 'scalar-highest', mergeConfidence: 'known',
        value: 'opus', winner: 'local',
        perLayer: [{ name: 'user', value: 'sonnet' }, { name: 'local', value: 'opus' }],
      },
      env: {
        key: 'env', strategy: 'object-merge', mergeConfidence: 'known',
        value: {}, winner: null,
        perLayer: [{ name: 'user', value: { A: '1' } }],
      },
    },
  };

  let table;
  assert.doesNotThrow(() => { table = renderTable('config:show-effective', result); });
  // Provenance lines: winner or merged-from annotation
  assert.match(table, /model.*winner.*local/i, 'model line must show winner: local');
  assert.match(table, /env.*merged from/i, 'env line must say merged from N layer(s)');
  // Layer names appear in brackets
  assert.ok(table.includes('[user, local]') || table.includes('user') && table.includes('local'),
    'layer names must appear in output');
});

test('effectiveTable with explain:true does not throw on missing winner/perLayer fields', () => {
  const result = {
    explain: true,
    effective: {},
    keys: {
      // Intentionally missing winner and perLayer
      model: { key: 'model', strategy: 'scalar-highest', mergeConfidence: 'known', value: 'opus' },
      // perLayer is not an array
      env: { key: 'env', strategy: 'object-merge', mergeConfidence: 'known', perLayer: null },
      // entire km is null
      hooks: null,
    },
  };

  let table;
  assert.doesNotThrow(() => { table = renderTable('config:show-effective', result); });
  assert.ok(typeof table === 'string', 'must return a string even with malformed entries');
});

test('effectiveTable without explain renders the standard mergeConfidence table', () => {
  const result = {
    keys: {
      model: { key: 'model', strategy: 'scalar-highest', mergeConfidence: 'known', value: 'opus' },
    },
  };

  let table;
  assert.doesNotThrow(() => { table = renderTable('config:show-effective', result); });
  assert.match(table, /mergeConfidence/, 'standard table must show mergeConfidence header');
  assert.match(table, /model/, 'standard table must show the model key');
  // Must NOT contain provenance-style output (winner/merged from)
  assert.ok(!table.includes('winner:') && !table.includes('merged from'),
    'standard table must not contain provenance annotations');
});
