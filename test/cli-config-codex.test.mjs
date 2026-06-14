/**
 * cli-config-codex.test.mjs (P6 TOML wave, unit 2) — `config show-effective
 * --target codex` end-to-end through run().
 *
 * Drives the full stack: cli.mjs → resolve-target (--target codex) →
 * config-effective-command (descriptor.configSource = toml-file) → readTomlFile →
 * parseToml → redactEffective. Oracles: the single-source shape (no `keys`),
 * --key navigation (top-level + nested), the SECRET oracle (a sensitive-named
 * field AND a token-shaped string are redacted, plaintext absent), a malformed
 * config.toml → a config-toml-invalid warn (not a crash), and the Claude default
 * path is unchanged (still carries `keys`).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { run } from '../src/cli.mjs';

const GHP = `ghp_${'Z'.repeat(36)}`;
const SK = `sk-${'A'.repeat(40)}`;

/** A codex config dir whose config.toml carries realistic content + two secrets. */
function makeCodexDir() {
  const dir = mkdtempSync(join(tmpdir(), 'mgr-config-codex-'));
  const toml = [
    'model = "gpt-5.5"',
    'model_context_window = 250000',
    'sandbox_mode = "workspace-write"',
    `api_key = "${SK}"`,                 // sensitive key NAME ('key') → redacted
    '',
    '[mcp_servers.pencil]',
    'command = "npx"',
    'args = [ "--app", "code" ]',
    '',
    '[mcp_servers.deployer]',
    `command = "deploy --token=${GHP}"`, // token SHAPE in a string value → redacted
    '',
    '[[skills.config]]',
    'name = "ab-test-setup"',
    'enabled = false',
  ].join('\n');
  writeFileSync(join(dir, 'config.toml'), toml, 'utf8');
  return dir;
}

// ── shape + navigation ──────────────────────────────────────────────────────────

test('config show-effective --target codex: single-source shape (effective, no keys)', async () => {
  const dir = makeCodexDir();
  try {
    const out = await run(['config', 'show-effective', '--target', 'codex', '--config-dir', dir, '--format', 'json']);
    assert.equal(out.code, 0, out.stdout);
    const env = JSON.parse(out.stdout);
    assert.equal(env.command, 'config:show-effective');
    assert.equal(env.result.effective.model, 'gpt-5.5');
    assert.equal(env.result.effective.model_context_window, 250000);
    assert.equal(env.result.keys, undefined, 'codex is a single source — no merge keys map');
    assert.ok(Array.isArray(env.result.effective.skills.config), 'arrays-of-tables flow through');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('config show-effective --target codex --key: top-level + nested navigation', async () => {
  const dir = makeCodexDir();
  try {
    const top = JSON.parse((await run(['config', 'show-effective', '--target', 'codex', '--config-dir', dir, '--key', 'model', '--format', 'json'])).stdout);
    assert.equal(top.result.key, 'model');
    assert.equal(top.result.value, 'gpt-5.5');

    const nested = JSON.parse((await run(['config', 'show-effective', '--target', 'codex', '--config-dir', dir, '--key', 'mcp_servers.pencil.command', '--format', 'json'])).stdout);
    assert.equal(nested.result.value, 'npx');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── SECRET oracle ─────────────────────────────────────────────────────────────

test('config show-effective --target codex: secrets are redacted (key-name + token-shape)', async () => {
  const dir = makeCodexDir();
  try {
    const out = await run(['config', 'show-effective', '--target', 'codex', '--config-dir', dir, '--format', 'json']);
    // neither the sk- value (under a 'key'-named field) nor the ghp_ token (embedded
    // in a command string) may appear anywhere in stdout.
    assert.ok(!out.stdout.includes(SK), 'sk- secret plaintext must be absent');
    assert.ok(!out.stdout.includes(GHP), 'ghp_ token plaintext must be absent');
    assert.ok(out.stdout.includes('redacted'), 'a redaction sentinel is present');
    // also via --key into the sensitive field.
    const keyed = JSON.parse((await run(['config', 'show-effective', '--target', 'codex', '--config-dir', dir, '--key', 'api_key', '--format', 'json'])).stdout);
    assert.equal(keyed.result.value.redacted, true);
    assert.ok(!JSON.stringify(keyed).includes(SK));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('config show-effective --target codex: a NESTED mcp_servers.<x>.env secret is wholesale-redacted', async () => {
  // codex's idiomatic nested-env pattern: a benign-named, non-token-shaped value
  // under mcp_servers.x.env must NOT leak (the P6 U2 any-depth env hardening).
  const dir = mkdtempSync(join(tmpdir(), 'mgr-config-codex-env-'));
  const NESTED = 'rawsecret-NESTED-no-keyword-no-shape-99';
  try {
    writeFileSync(join(dir, 'config.toml'), [
      '[mcp_servers.deployer.env]',
      `CONNECTION = "${NESTED}"`,
      'LOG_LEVEL = "info"',
    ].join('\n'), 'utf8');
    const out = await run(['config', 'show-effective', '--target', 'codex', '--config-dir', dir, '--format', 'json']);
    assert.ok(!out.stdout.includes(NESTED), 'a nested-env value must not leak in the full effective dump');
    const env = JSON.parse(out.stdout);
    assert.equal(env.result.effective.mcp_servers.deployer.env.CONNECTION.redacted, true);
    // and via --key into the nested env leaf
    const keyed = JSON.parse((await run(['config', 'show-effective', '--target', 'codex', '--config-dir', dir, '--key', 'mcp_servers.deployer.env.CONNECTION', '--format', 'json'])).stdout);
    assert.equal(keyed.result.value.redacted, true);
    assert.ok(!JSON.stringify(keyed).includes(NESTED));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── robustness ─────────────────────────────────────────────────────────────────

test('config show-effective --target codex: a malformed config.toml → warn, not a crash', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mgr-config-codex-bad-'));
  try {
    writeFileSync(join(dir, 'config.toml'), 'a = 1\nb = @nope\n', 'utf8');
    const out = await run(['config', 'show-effective', '--target', 'codex', '--config-dir', dir, '--format', 'json']);
    const env = JSON.parse(out.stdout);
    assert.ok(env.diagnostics.some((d) => d.code === 'config-toml-invalid'), 'parse error surfaces as a warn');
    assert.deepEqual(env.result.effective, {}, 'a parse error yields an empty effective');
    assert.equal(out.code, 0, 'a warn (not error) keeps exit 0');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('config show-effective --target codex: a missing config.toml is benign', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mgr-config-codex-empty-'));
  try {
    const out = await run(['config', 'show-effective', '--target', 'codex', '--config-dir', dir, '--format', 'json']);
    const env = JSON.parse(out.stdout);
    assert.deepEqual(env.result.effective, {});
    assert.deepEqual(env.diagnostics, [], 'a missing config.toml is benign — no diagnostic');
    assert.equal(out.code, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── claude default unchanged ─────────────────────────────────────────────────

test('config show-effective (claude default) still carries the merge keys map', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mgr-config-cc-'));
  try {
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ model: 'opus' }), 'utf8');
    const env = JSON.parse((await run(['config', 'show-effective', '--config-dir', dir, '--format', 'json'])).stdout);
    assert.ok(env.result.effective && typeof env.result.effective === 'object');
    assert.ok(env.result.keys && typeof env.result.keys === 'object', 'the CC path keeps the per-key merge map');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
