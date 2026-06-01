/**
 * Falsifiable oracle for the config:show-effective env-leak fix.
 *
 * This test FAILS against the pre-fix code (which returned `m.effective` verbatim
 * so every env value — e.g. ANTHROPIC_API_KEY — was serialized in plaintext) and
 * PASSES after redactEffective / redactKeyedValue redact sensitive VALUES to
 * {redacted:true, sha256} before configShowEffectiveCommand returns, making every
 * output format (json/ndjson/table/quiet) uniformly secret-safe.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { configShowEffectiveCommand } from '../src/cli/commands.mjs';
import { formatJson, formatNdjson } from '../src/output/json.mjs';
import { renderTable } from '../src/cli/render.mjs';
import { redactEffective, redactKeyedValue } from '../src/analysis/redact-effective.mjs';

const ENV_SECRET = 'sk-ant-SENTINEL-DO-NOT-LEAK';
const ENV_PLAIN = 'plainval-SENTINEL';
const HELPER_SECRET = 'secrethelper-SENTINEL';

/**
 * Write a settings.json with a secret-bearing env, a top-level non-env sensitive
 * key (apiKeyHelper), and a clearly non-sensitive key (model:'opus') into a temp
 * configDir, run the real command, and clean up.
 * @param {object} args  the ctx.args flags
 */
function runWithSettings(args) {
  const dir = mkdtempSync(join(tmpdir(), 'mgr-redact-'));
  try {
    const settings = {
      model: 'opus',
      apiKeyHelper: HELPER_SECRET,
      env: { ANTHROPIC_API_KEY: ENV_SECRET, PLAIN: ENV_PLAIN },
    };
    writeFileSync(join(dir, 'settings.json'), JSON.stringify(settings), 'utf8');
    return configShowEffectiveCommand({ configDir: dir, args });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('config:show-effective — zero-leak across formatJson + formatNdjson (falsifiable oracle)', () => {
  const { result, diagnostics } = runWithSettings({});

  for (const wire of [
    formatJson({ command: 'config:show-effective', result, diagnostics }),
    formatNdjson({ command: 'config:show-effective', result, diagnostics }),
  ]) {
    // Zero-leak: no sentinel plaintext appears anywhere in either serialization.
    assert.ok(!wire.includes(ENV_SECRET), 'ANTHROPIC_API_KEY value leaked');
    assert.ok(!wire.includes(ENV_PLAIN), 'env PLAIN value leaked (whole env map is redacted)');
    assert.ok(!wire.includes(HELPER_SECRET), 'apiKeyHelper value leaked');

    // Redaction shape present (one sha256 hex per redacted value).
    assert.ok(wire.includes('redacted'), 'expected {redacted} sentinels');
    assert.match(wire, /"sha256":\s*"[0-9a-f]{64}"/, 'expected sha256 hex for redacted values');

    // Key NAMES stay visible (governance value).
    assert.ok(wire.includes('ANTHROPIC_API_KEY'), 'env key name should remain');
    assert.ok(wire.includes('PLAIN'), 'env key name should remain');
    assert.ok(wire.includes('apiKeyHelper'), 'sensitive key name should remain');

    // No over-redaction: the non-sensitive value survives.
    assert.ok(wire.includes('opus'), 'non-sensitive model value should survive');
  }
});

test('config:show-effective --key env --format json path is also redacted', () => {
  const { result, diagnostics } = runWithSettings({ key: 'env' });
  const wire = formatJson({ command: 'config:show-effective', result, diagnostics });
  assert.ok(!wire.includes(ENV_SECRET), 'env value leaked via --key env');
  assert.ok(!wire.includes(ENV_PLAIN), 'env value leaked via --key env');
  assert.ok(wire.includes('redacted'), 'expected redaction sentinel for --key env');
  assert.match(wire, /"sha256":\s*"[0-9a-f]{64}"/, 'expected sha256 hex for --key env');
});

test('config:show-effective default table (no --key) still renders keys + mergeConfidence', () => {
  const { result } = runWithSettings({});
  const table = renderTable('config:show-effective', result);
  // The keys-map table path is unchanged: header + per-key mergeConfidence rows.
  assert.match(table, /mergeConfidence/);
  assert.match(table, /model/);
  assert.match(table, /apiKeyHelper/);
  assert.match(table, /env/);
});

test('redactEffective does not mutate its input (original effective stays byte-identical)', () => {
  const effective = {
    model: 'opus',
    apiKeyHelper: HELPER_SECRET,
    env: { ANTHROPIC_API_KEY: ENV_SECRET, PLAIN: ENV_PLAIN },
  };
  const before = JSON.stringify(effective);
  const out = redactEffective(effective);
  assert.equal(JSON.stringify(effective), before, 'input must not be mutated');
  // And the copy is genuinely redacted + distinct.
  assert.notEqual(out, effective);
  assert.equal(out.env.ANTHROPIC_API_KEY.redacted, true);
  assert.equal(out.model, 'opus');
});

test('redactEffective skips prototype-poisoning keys and deep-redacts nested sensitive values (proto-safe + deep branches)', () => {
  // JSON.parse yields OWN __proto__ keys (not the prototype), exercising the
  // isSafeKey skip in BOTH redactEnv and redactDeep, plus the non-sensitive
  // deep-recursion arm (a nested non-sensitive object value).
  const poisoned = JSON.parse(
    '{"env":{"__proto__":"sk-ENVPROTO","API_KEY":"sk-REAL"},' +
      '"permissions":{"__proto__":"sk-PERMPROTO","token":"sk-PERMTOK","nested":{"plain":"keepme-PLAIN"}}}',
  );
  const out = redactEffective(poisoned);
  const wire = JSON.stringify(out);
  assert.ok(!wire.includes('sk-ENVPROTO'), 'poisoned env __proto__ value must not leak');
  assert.ok(!wire.includes('sk-PERMPROTO'), 'poisoned nested __proto__ value must not leak');
  assert.ok(!wire.includes('sk-PERMTOK'), 'nested sensitive token must be redacted');
  assert.ok(!wire.includes('sk-REAL'), 'env value must be redacted');
  assert.ok(wire.includes('keepme-PLAIN'), 'non-sensitive nested value survives the deep copy');
  assert.ok(!Object.prototype.hasOwnProperty.call(out.env, '__proto__'), 'no own __proto__ in redacted env');
  assert.ok(!Object.prototype.hasOwnProperty.call(out.permissions, '__proto__'), 'no own __proto__ in redacted permissions');
});

test('redactKeyedValue never throws on malformed --key segments and still redacts nested secrets (defensive guards)', () => {
  // Non-array segments and an empty path both fall through to a deep redact.
  assert.doesNotThrow(() => redactKeyedValue(undefined, { token: 'sk-MALFORMED' }));
  assert.ok(
    !JSON.stringify(redactKeyedValue(undefined, { token: 'sk-MALFORMED' })).includes('sk-MALFORMED'),
    'nested sensitive key redacted even when segments is not an array',
  );
  assert.ok(
    !JSON.stringify(redactKeyedValue([], { password: 'sk-EMPTYPATH' })).includes('sk-EMPTYPATH'),
    'nested sensitive key redacted when the path is empty',
  );
});
