/**
 * P6 TOML wave, unit 4 — unit oracle for discoverPluginsForTarget /
 * discoverPluginsToml (src/discovery/plugins-target.mjs).
 *
 * Falsifiable oracles over a real temp config.toml `[plugins."<name>@<mk>"]`
 * table: the codex read (key/name/marketplace split on the LAST `@`,
 * version:'' = no codex version, enabled bool), the headline VERSIONLESS
 * cachePresent check (plugins/cache/<mk>/<name>/ existence), benign-missing,
 * malformed-entry + malformed-TOML + bad-root diagnostics, and the dispatcher /
 * fallback legs (claude + no-descriptor + a usable-pluginSource-missing fallback
 * never read config.toml / never throw).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { discoverPluginsForTarget } from '../src/discovery/plugins-target.mjs';
import { scan } from '../src/discovery/scan.mjs';
import { codexDescriptor } from '../src/targets/codex.mjs';
import { claudeDescriptor } from '../src/targets/claude.mjs';

/** Run `fn(dir)` against a throwaway temp dir, always cleaning up. */
function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'mgr-plugins-toml-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const CODEX_PLUGINS = `
[plugins."superpowers@openai-curated"]
enabled = true

[plugins."sentry@openai-curated"]
enabled = false
`;

/** A schema-v2 installed_plugins.json with one plugin under `key`. */
function installedV2(key, name, marketplace) {
  return JSON.stringify({
    version: 2,
    plugins: { [key]: [{ name, marketplace, version: '1.0.0', enabled: true }] },
  });
}

// ---------------------------------------------------------------------------
// 1. codex plugins table — split, version:'' , enabled, VERSIONLESS cachePresent
// ---------------------------------------------------------------------------

test('codex config.toml plugins table → records (sorted, split, versionless cachePresent)', () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, 'config.toml'), CODEX_PLUGINS);
    // superpowers IS cached (versionless: plugins/cache/<mk>/<name>/<hash>/), sentry is NOT.
    mkdirSync(join(dir, 'plugins', 'cache', 'openai-curated', 'superpowers', 'somehash'), { recursive: true });

    const { plugins, diagnostics } = discoverPluginsForTarget({ rootDir: dir, descriptor: codexDescriptor });
    assert.equal(diagnostics.length, 0);
    assert.equal(plugins.length, 2);

    // sorted by key: sentry@... < superpowers@...
    assert.deepEqual(plugins.map((p) => p.key), ['sentry@openai-curated', 'superpowers@openai-curated']);

    const sentry = plugins.find((p) => p.name === 'sentry');
    const sp = plugins.find((p) => p.name === 'superpowers');

    // name/marketplace split on the LAST `@`; codex carries NO version.
    assert.deepEqual(
      { key: sp.key, name: sp.name, marketplace: sp.marketplace, version: sp.version },
      { key: 'superpowers@openai-curated', name: 'superpowers', marketplace: 'openai-curated', version: '' },
    );
    assert.deepEqual(
      { key: sentry.key, name: sentry.name, marketplace: sentry.marketplace, version: sentry.version },
      { key: 'sentry@openai-curated', name: 'sentry', marketplace: 'openai-curated', version: '' },
    );

    // enabled tracks the table bool.
    assert.equal(sp.enabled, true);
    assert.equal(sentry.enabled, false);

    // HEADLINE falsifiable oracle: versionless cache check.
    assert.equal(sp.cachePresent, true, 'superpowers cache dir exists → cachePresent');
    assert.equal(sentry.cachePresent, false, 'no sentry cache dir → !cachePresent');
  });
});

// ---------------------------------------------------------------------------
// 2. missing config.toml is benign
// ---------------------------------------------------------------------------

test('missing config.toml → { plugins: [], diagnostics: [] }', () => {
  withTempDir((dir) => {
    const r = discoverPluginsForTarget({ rootDir: dir, descriptor: codexDescriptor });
    assert.deepEqual(r.plugins, []);
    assert.deepEqual(r.diagnostics, []);
  });
});

// ---------------------------------------------------------------------------
// 3. non-table plugin entry → one plugin-entry-malformed warn, sibling kept
// ---------------------------------------------------------------------------

test('non-table plugin entry → plugin-entry-malformed warn; real sub-table kept', () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, 'config.toml'), '[plugins]\nbad = "x"\n\n[plugins."good@mk"]\nenabled = true\n');
    const { plugins, diagnostics } = discoverPluginsForTarget({ rootDir: dir, descriptor: codexDescriptor });

    assert.equal(plugins.length, 1);
    assert.equal(plugins[0].key, 'good@mk');
    assert.equal(plugins[0].name, 'good');
    assert.equal(plugins[0].marketplace, 'mk');

    const malformed = diagnostics.filter((d) => d.code === 'plugin-entry-malformed');
    assert.equal(malformed.length, 1);
    assert.equal(malformed[0].severity, 'warn');
  });
});

// ---------------------------------------------------------------------------
// 4. malformed TOML → one plugins-toml-invalid warn, zero plugins, never throws
// ---------------------------------------------------------------------------

test('malformed TOML → plugins-toml-invalid warn, zero plugins, never throws', () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, 'config.toml'), 'b = @nope\n');
    let r;
    assert.doesNotThrow(() => {
      r = discoverPluginsForTarget({ rootDir: dir, descriptor: codexDescriptor });
    });
    assert.deepEqual(r.plugins, []);
    const invalid = r.diagnostics.filter((d) => d.code === 'plugins-toml-invalid');
    assert.equal(invalid.length, 1);
    assert.equal(invalid[0].severity, 'warn');
  });
});

// ---------------------------------------------------------------------------
// 5. bad rootDir → one discover-bad-root diagnostic, zero plugins
// ---------------------------------------------------------------------------

test('empty rootDir → discover-bad-root, zero plugins', () => {
  const { plugins, diagnostics } = discoverPluginsForTarget({ rootDir: '', descriptor: codexDescriptor });
  assert.deepEqual(plugins, []);
  const bad = diagnostics.filter((d) => d.code === 'discover-bad-root');
  assert.equal(bad.length, 1);
  assert.equal(bad[0].severity, 'error');
});

// ---------------------------------------------------------------------------
// 6. DISPATCHER — claude (and no-descriptor) take the JSON path, never the TOML
// ---------------------------------------------------------------------------

test('claude descriptor reads installed_plugins.json, never config.toml', () => {
  withTempDir((dir) => {
    // BOTH sources present; the json path must win and the toml table be ignored.
    mkdirSync(join(dir, 'plugins'), { recursive: true });
    writeFileSync(join(dir, 'plugins', 'installed_plugins.json'), installedV2('jsonplug@mk', 'jsonplug', 'mk'));
    writeFileSync(join(dir, 'config.toml'), CODEX_PLUGINS);

    const claudeRun = discoverPluginsForTarget({ rootDir: dir, descriptor: claudeDescriptor });
    assert.equal(claudeRun.plugins.length, 1);
    assert.equal(claudeRun.plugins[0].key, 'jsonplug@mk');
    // proves it never read the codex config.toml entries
    assert.equal(claudeRun.plugins.some((p) => p.name === 'superpowers'), false);

    const noDescRun = discoverPluginsForTarget({ rootDir: dir });
    assert.deepEqual(noDescRun.plugins, claudeRun.plugins);
  });
});

// ---------------------------------------------------------------------------
// 7. SCAN DRIFT-GUARD — no-descriptor === claudeDescriptor (CC path unchanged)
// ---------------------------------------------------------------------------

test('scan plugins: no-descriptor === claudeDescriptor (CC path byte-identical)', () => {
  withTempDir((dir) => {
    mkdirSync(join(dir, 'plugins'), { recursive: true });
    writeFileSync(join(dir, 'plugins', 'installed_plugins.json'), installedV2('ccplug@mk', 'ccplug', 'mk'));

    assert.deepStrictEqual(
      scan({ targetClaudeDir: dir }).plugins,
      scan({ targetClaudeDir: dir, descriptor: claudeDescriptor }).plugins,
    );
  });
});

// ---------------------------------------------------------------------------
// 8. FALLBACK GUARD — a toml-table source missing file/pointer falls back to json
// ---------------------------------------------------------------------------

test('toml-table pluginSource missing file/pointer → falls back to json, never throws', () => {
  withTempDir((dir) => {
    mkdirSync(join(dir, 'plugins'), { recursive: true });
    writeFileSync(join(dir, 'plugins', 'installed_plugins.json'), installedV2('fb@mk', 'fb', 'mk'));

    const broken = { ...codexDescriptor, pluginSource: { kind: 'toml-table' } };
    let r;
    assert.doesNotThrow(() => {
      r = discoverPluginsForTarget({ rootDir: dir, descriptor: broken });
    });
    assert.equal(r.plugins.length, 1);
    assert.equal(r.plugins[0].key, 'fb@mk');
  });
});
