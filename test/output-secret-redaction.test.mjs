/**
 * SECURITY regression (audit 2026-06-02, P1) — output-secret-redaction.test.mjs
 *
 * Falsifiable oracle for the output-surface secret leak: a credential embedded in
 * a hook `command`, the statusLine `command`, or a value under a NON-sensitive key
 * name flowed verbatim to `inventory` / `hooks` / `config show-effective`
 * json+ndjson — i.e. straight onto the TUI/Web UI display surface. The existing
 * redact-effective.mjs only redacted by KEY NAME, so these escaped.
 *
 * PRE-FIX these FAIL (the secret prints raw, no <redacted> marker). POST-FIX the
 * secret SUBSTRING is replaced with <redacted> while the surrounding command/URL
 * text survives (surgical, no over-redaction).
 *
 * Fakes are REALISTIC LENGTH so the high-confidence shape rules fire (a too-short
 * fake like `sk-HOOKSECRET` matches no real shape — by design).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { inventoryCommand, hooksCommand, configShowEffectiveCommand, permissionsCommand } from '../src/cli/commands.mjs';
import { formatJson, formatNdjson } from '../src/output/json.mjs';

const GHP = `ghp_${'A'.repeat(36)}`;                              // github classic token shape
const SKK = `sk-${'B'.repeat(40)}`;                               // openai key shape
const URL_SECRET = 'postgres://dbuser:s3cretPassXYZ@db.internal/app'; // URL userinfo
const BEARER_TOK = 'C'.repeat(40);                                // opaque bearer token

/** Write a settings.json into a temp configDir, run fn(dir), always clean up. */
function withSettings(settings, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'mgr-outredact-'));
  try {
    writeFileSync(join(dir, 'settings.json'), JSON.stringify(settings), 'utf8');
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Both wire serializations (json + ndjson) for one command output. */
function wires(command, out) {
  return [
    formatJson({ command, result: out.result, diagnostics: out.diagnostics }),
    formatNdjson({ command, result: out.result, diagnostics: out.diagnostics }),
  ];
}

test('inventory: a token in statusLine.command does NOT leak (json/ndjson)', () => {
  withSettings({ statusLine: { type: 'command', command: `node statusline.mjs --token=${GHP}` } }, (dir) => {
    const out = inventoryCommand({ configDir: dir, args: {} });
    for (const wire of wires('inventory', out)) {
      assert.ok(!wire.includes(GHP), 'statusLine token must not leak');
      assert.ok(wire.includes('<redacted>'), 'expected redaction marker');
      assert.ok(wire.includes('statusline.mjs'), 'benign command text preserved');
    }
  });
});

test('hooks: a bearer token in a hook command does NOT leak (json/ndjson)', async () => {
  const settings = {
    hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: `curl -H "Authorization: Bearer ${BEARER_TOK}" https://x` }] }] },
  };
  // hooksCommand is async since P5.U4 (probe-enriched explanations) — inline
  // try/finally instead of the sync withSettings helper so cleanup waits.
  const dir = mkdtempSync(join(tmpdir(), 'mgr-outredact-'));
  try {
    writeFileSync(join(dir, 'settings.json'), JSON.stringify(settings), 'utf8');
    const out = await hooksCommand({ configDir: dir, args: {} });
    for (const wire of wires('hooks', out)) {
      assert.ok(!wire.includes(BEARER_TOK), 'hook bearer token must not leak (hooks NOR explanations)');
      assert.ok(wire.includes('<redacted>'), 'expected redaction marker');
      assert.ok(wire.includes('curl'), 'benign command text preserved');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('config show-effective: hook + statusLine token + URL-userinfo value do NOT leak', () => {
  const settings = {
    statusLine: { type: 'command', command: `s.mjs --token=${GHP}` },
    hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: `x ${SKK}` }] }] },
    myDatabaseUrl: URL_SECRET, // secret VALUE under a NON-sensitive key name
    model: 'opus',
  };
  withSettings(settings, (dir) => {
    const out = configShowEffectiveCommand({ configDir: dir, args: {} });
    for (const wire of wires('config:show-effective', out)) {
      assert.ok(!wire.includes(GHP), 'statusLine token leaked');
      assert.ok(!wire.includes(SKK), 'hook token leaked');
      assert.ok(!wire.includes('s3cretPassXYZ'), 'URL userinfo password leaked under non-sensitive key');
      assert.ok(wire.includes('<redacted>'), 'expected redaction marker');
      assert.ok(wire.includes('opus'), 'non-sensitive value preserved (no over-redaction)');
      assert.ok(wire.includes('db.internal'), 'URL host preserved (surgical redaction)');
    }
  });
});

test('permissions: a credential in a permission rule does NOT leak (plain + --audit, json/ndjson)', () => {
  const settings = { permissions: { allow: ['WebFetch(https://user:s3cretPWvalue@host)'], ask: [], deny: [] } };
  withSettings(settings, (dir) => {
    for (const args of [{}, { audit: true }]) {
      const out = permissionsCommand({ configDir: dir, args });
      for (const wire of wires('permissions', out)) {
        assert.ok(!wire.includes('s3cretPWvalue'), 'permission-rule secret leaked');
        assert.ok(wire.includes('<redacted>'), 'expected redaction marker');
        assert.ok(wire.includes('host'), 'rest of the rule preserved');
      }
    }
  });
});

test('inventory --detail: a token in a component description does NOT leak (json/ndjson)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mgr-outredact-'));
  try {
    mkdirSync(join(dir, 'skills', 'demo'), { recursive: true });
    writeFileSync(join(dir, 'skills', 'demo', 'SKILL.md'), `---\nname: demo\ndescription: use ${GHP} to call the api\n---\nbody\n`, 'utf8');
    const out = inventoryCommand({ configDir: dir, args: { detail: true } });
    for (const wire of wires('inventory', out)) {
      assert.ok(!wire.includes(GHP), 'description token leaked');
      assert.ok(wire.includes('<redacted>'), 'expected redaction marker');
      assert.ok(wire.includes('demo'), 'component still listed (no over-redaction of the name)');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
