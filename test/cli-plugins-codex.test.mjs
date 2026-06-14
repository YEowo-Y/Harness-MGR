/**
 * P6 TOML wave, unit 4 — end-to-end codex plugin inventory through run().
 *
 * `inventory --type plugin --target codex` reads the config.toml `plugins` table
 * (previously 0). Covers the narrowed list, the counts summary, the --detail
 * trimmed array, and a CC-unchanged leg (installed_plugins.json, no config.toml,
 * auto-detects claude).
 *
 * NOTE: run() is ASYNC — every call is awaited.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { run } from '../src/cli.mjs';

const CODEX_PLUGINS = `
[plugins."superpowers@openai-curated"]
enabled = true

[plugins."sentry@openai-curated"]
enabled = false
`;

/** A codex dir with a plugins table + the superpowers cache dir (versionless). */
async function withCodexDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'mgr-cli-plug-codex-'));
  try {
    writeFileSync(join(dir, 'config.toml'), CODEX_PLUGINS);
    mkdirSync(join(dir, 'plugins', 'cache', 'openai-curated', 'superpowers', 'h'), { recursive: true });
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 1. inventory --type plugin --target codex --format json
// ---------------------------------------------------------------------------

test('inventory --type plugin --target codex lists the config.toml plugins', async () => {
  await withCodexDir(async (dir) => {
    const out = await run(['inventory', '--type', 'plugin', '--target', 'codex', '--config-dir', dir, '--format', 'json']);
    assert.equal(out.code, 0);
    const env = JSON.parse(out.stdout);
    assert.equal(env.command, 'inventory');
    assert.equal(env.result.type, 'plugin');
    assert.equal(env.result.items.length, 2);

    const sp = env.result.items.find((p) => p.key === 'superpowers@openai-curated');
    const sentry = env.result.items.find((p) => p.key === 'sentry@openai-curated');
    assert.ok(sp, 'expected the superpowers plugin present');
    assert.equal(sp.enabled, true);
    assert.equal(sp.cachePresent, true, 'cached plugin → cachePresent (versionless)');
    assert.equal(sentry.enabled, false);
    assert.equal(sentry.cachePresent, false);
  });
});

// ---------------------------------------------------------------------------
// 2. counts summary reflects the entry count
// ---------------------------------------------------------------------------

test('inventory --target codex counts.plugins equals the entry count', async () => {
  await withCodexDir(async (dir) => {
    const out = await run(['inventory', '--target', 'codex', '--config-dir', dir, '--format', 'json']);
    assert.equal(out.code, 0);
    const env = JSON.parse(out.stdout);
    assert.equal(env.result.counts.plugins, 2);
  });
});

// ---------------------------------------------------------------------------
// 3. --detail → result.plugins trimmed array
// ---------------------------------------------------------------------------

test('inventory --detail --target codex exposes the trimmed plugins array', async () => {
  await withCodexDir(async (dir) => {
    const out = await run(['inventory', '--detail', '--target', 'codex', '--config-dir', dir, '--format', 'json']);
    assert.equal(out.code, 0);
    const env = JSON.parse(out.stdout);
    assert.ok(Array.isArray(env.result.plugins), 'expected a plugins array');
    assert.equal(env.result.plugins.length, 2);
    for (const p of env.result.plugins) {
      assert.deepEqual(
        Object.keys(p).sort(),
        ['cachePresent', 'enabled', 'key', 'marketplace', 'name', 'version'],
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 4. CC-UNCHANGED leg — installed_plugins.json, no config.toml, auto-detect claude
// ---------------------------------------------------------------------------

test('CC inventory (no --target, no config.toml) lists the installed_plugins.json plugin', async () => {
  const ccDir = mkdtempSync(join(tmpdir(), 'mgr-cli-plug-cc-'));
  try {
    mkdirSync(join(ccDir, 'plugins'), { recursive: true });
    writeFileSync(
      join(ccDir, 'plugins', 'installed_plugins.json'),
      JSON.stringify({
        version: 2,
        plugins: { 'ccplug@mk': [{ name: 'ccplug', marketplace: 'mk', version: '1.0.0', enabled: true }] },
      }),
    );
    const out = await run(['inventory', '--type', 'plugin', '--config-dir', ccDir, '--format', 'json']);
    assert.equal(out.code, 0);
    const env = JSON.parse(out.stdout);
    assert.equal(env.result.type, 'plugin');
    assert.equal(env.result.items.length, 1);
    assert.equal(env.result.items[0].key, 'ccplug@mk');
    assert.equal(env.result.items[0].version, '1.0.0');
  } finally {
    rmSync(ccDir, { recursive: true, force: true });
  }
});
