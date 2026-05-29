/**
 * Hermetic unit tests for src/discovery/probe-schema.mjs
 *
 * Uses mkdtempSync temp dirs — no real ~/.claude read.
 * Tests: synthetic configDir with settings.json (JSONC-tolerant), installed_plugins.json,
 * .mcp.json, and appFile; verifies the 6 dimensions as exact sorted sets/counts.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gatherSchemaFacts } from '../src/discovery/probe-schema.mjs';

/** Make a unique temp dir. */
function mkTemp(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Write a file, creating parent dirs as needed. */
function writeFile(dir, relPath, content) {
  const abs = join(dir, relPath);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, typeof content === 'string' ? content : JSON.stringify(content, null, 2), 'utf8');
}

// ── full synthetic configDir fixture ─────────────────────────────────────────

describe('gatherSchemaFacts', () => {

  it('gathers all 6 dimensions from a synthetic configDir', async () => {
    const dir = mkTemp('mgr-probe-schema-full-');
    const appFile = join(dir, 'app.json');
    try {
      // Create sub-dirs (topDirs)
      mkdirSync(join(dir, 'skills'), { recursive: true });
      mkdirSync(join(dir, 'agents'), { recursive: true });
      mkdirSync(join(dir, 'hooks'), { recursive: true });

      // settings.json with JSONC comments + trailing comma + duplicate key
      writeFileSync(join(dir, 'settings.json'), `{
  // this is a comment
  "model": "claude-sonnet",
  "permissions": { "allow": [] },
  "hooks": {
    "PreToolUse": [],
    "PostToolUse": [],
  },
  "model": "claude-opus"
}`, 'utf8');

      // installed_plugins.json
      mkdirSync(join(dir, 'plugins'), { recursive: true });
      writeFileSync(join(dir, 'plugins', 'installed_plugins.json'),
        JSON.stringify({ version: 2, plugins: {} }), 'utf8');

      // .mcp.json with 2 servers: stdio + http
      writeFileSync(join(dir, '.mcp.json'), JSON.stringify({
        mcpServers: {
          server1: { command: 'node', args: ['s.mjs'] },   // stdio (no url)
          server2: { url: 'https://example.com/mcp' },     // http
        },
      }), 'utf8');

      // appFile with 3 keys
      writeFileSync(appFile, JSON.stringify({ userID: 'x', autoUpdates: true, projects: {} }), 'utf8');

      const { scan } = await import('../src/discovery/scan.mjs');
      const scanResult = scan({ targetClaudeDir: dir, appFile, kinds: ['settings', 'mcp'] });

      const { facts, diagnostics } = gatherSchemaFacts({ configDir: dir, appFile, scanResult });

      assert.equal(facts.pluginSchemaVersion, 2);
      assert.deepEqual(facts.settingsKeys, ['hooks', 'model', 'permissions']); // sorted, deduped names
      assert.deepEqual(facts.hookEvents, ['PostToolUse', 'PreToolUse']); // sorted
      assert.deepEqual(facts.topDirs.sort(), ['agents', 'hooks', 'plugins', 'skills']); // sorted (includes plugins)
      assert.equal(facts.mcpServerCount, 2);
      // transport set from actual scan — stdio and http present
      assert.ok(facts.mcpTransports.length > 0, 'at least one transport');
      assert.deepEqual(facts.appKeys, ['autoUpdates', 'projects', 'userID']); // sorted
      // No errors in diagnostics from a valid fixture
      const errors = diagnostics.filter((d) => d.severity === 'error');
      assert.equal(errors.length, 0, `unexpected errors: ${JSON.stringify(errors)}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('missing settings.json → benign empty settingsKeys + hookEvents', () => {
    const dir = mkTemp('mgr-probe-schema-nosettings-');
    try {
      const { facts, diagnostics } = gatherSchemaFacts({ configDir: dir });
      assert.deepEqual(facts.settingsKeys, []);
      assert.deepEqual(facts.hookEvents, []);
      assert.equal(diagnostics.filter((d) => d.severity === 'error').length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('missing installed_plugins.json → pluginSchemaVersion null', () => {
    const dir = mkTemp('mgr-probe-schema-noplugins-');
    try {
      const { facts } = gatherSchemaFacts({ configDir: dir });
      assert.equal(facts.pluginSchemaVersion, null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('missing appFile → appKeys empty array', () => {
    const dir = mkTemp('mgr-probe-schema-noapp-');
    const appFile = join(dir, 'does-not-exist.json');
    try {
      const { facts } = gatherSchemaFacts({ configDir: dir, appFile });
      assert.deepEqual(facts.appKeys, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('bad configDir (empty string) → discover-bad-root error + empty facts', () => {
    const { facts, diagnostics } = gatherSchemaFacts({ configDir: '' });
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].code, 'discover-bad-root');
    assert.equal(diagnostics[0].severity, 'error');
    assert.deepEqual(facts.settingsKeys, []);
    assert.equal(facts.mcpServerCount, 0);
  });

  it('bad configDir (non-string) → discover-bad-root, never throws', () => {
    assert.doesNotThrow(() => gatherSchemaFacts({ configDir: null }));
    const { diagnostics } = gatherSchemaFacts({ configDir: 42 });
    assert.ok(diagnostics.some((d) => d.code === 'discover-bad-root'));
  });

  it('no opts at all → discover-bad-root, never throws', () => {
    assert.doesNotThrow(() => gatherSchemaFacts());
    assert.doesNotThrow(() => gatherSchemaFacts(null));
  });

  it('__proto__ and constructor keys in settings JSON are dropped from settingsKeys', () => {
    const dir = mkTemp('mgr-probe-schema-proto-');
    try {
      // JSON.parse can produce an own __proto__ key — simulate via readJsoncFn seam
      const poisonedSettings = {
        __proto__: 'evil',
        constructor: 'evil2',
        model: 'sonnet',
        hooks: { PreToolUse: [] },
      };
      // Use injectable seam to return the poisoned object
      const readJsoncFn = () => ({ value: poisonedSettings, error: null, missing: false, duplicateKeys: [] });
      const readJsonFn = () => ({ value: null, error: null, missing: true });
      const { facts } = gatherSchemaFacts({ configDir: dir, readJsonFn, readJsoncFn });
      assert.ok(!facts.settingsKeys.includes('__proto__'), '__proto__ dropped');
      assert.ok(!facts.settingsKeys.includes('constructor'), 'constructor dropped');
      assert.ok(facts.settingsKeys.includes('model'), 'legitimate key retained');
      assert.ok(facts.hookEvents.includes('PreToolUse'), 'hook event retained');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('__proto__ key in appFile JSON is dropped from appKeys', () => {
    const dir = mkTemp('mgr-probe-schema-appproto-');
    const appFile = join(dir, 'app.json');
    try {
      const poisonedApp = { __proto__: 'evil', userID: 'x', projects: {} };
      const readJsonFn = (p) => {
        if (p === appFile) return { value: poisonedApp, error: null, missing: false };
        return { value: null, error: null, missing: true };
      };
      const readJsoncFn = () => ({ value: null, error: null, missing: true, duplicateKeys: [] });
      const { facts } = gatherSchemaFacts({ configDir: dir, appFile, readJsonFn, readJsoncFn });
      assert.ok(!facts.appKeys.includes('__proto__'), '__proto__ dropped from appKeys');
      assert.ok(facts.appKeys.includes('userID'), 'legitimate key retained');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('no-scanResult path: falls back to fs readdir for topDirs', () => {
    const dir = mkTemp('mgr-probe-schema-notopdir-');
    try {
      mkdirSync(join(dir, 'skills'), { recursive: true });
      mkdirSync(join(dir, 'agents'), { recursive: true });
      // No scanResult passed → reads dirs from fs
      const { facts } = gatherSchemaFacts({ configDir: dir });
      assert.ok(facts.topDirs.includes('skills'), 'skills present via fs fallback');
      assert.ok(facts.topDirs.includes('agents'), 'agents present via fs fallback');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('NAMES-ONLY: settings values never appear in facts', () => {
    const dir = mkTemp('mgr-probe-schema-names-');
    const appFile = join(dir, 'app.json');
    try {
      // settings with secret-looking VALUES (only key names should be captured)
      const settingsObj = { apiKey: 'sk-secret-123', token: 'my-token-value', model: 'sonnet' };
      const appObj = { clientSecret: 'do-not-leak', userID: 'usr_abc' };
      const readJsoncFn = () => ({ value: settingsObj, error: null, missing: false, duplicateKeys: [] });
      const readJsonFn = (p) => {
        if (p === appFile) return { value: appObj, error: null, missing: false };
        return { value: null, error: null, missing: true };
      };
      const { facts } = gatherSchemaFacts({ configDir: dir, appFile, readJsonFn, readJsoncFn });
      const serialized = JSON.stringify(facts);
      // Key NAMES must appear
      assert.ok(serialized.includes('apiKey'), 'key name apiKey appears');
      assert.ok(serialized.includes('clientSecret'), 'key name clientSecret appears');
      // Values must NOT appear
      assert.ok(!serialized.includes('sk-secret-123'), 'secret value not in facts');
      assert.ok(!serialized.includes('my-token-value'), 'token value not in facts');
      assert.ok(!serialized.includes('do-not-leak'), 'secret value not in facts');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

});
