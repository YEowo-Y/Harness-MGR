/**
 * Falsifiable oracle for redactMcpArgs — heuristic redaction of secret VALUES
 * embedded in MCP `args` (the deferred half of the #2 mcp-leak hardening).
 *
 * FAILS pre-fix: before this unit, trimMcpServer returned `args` VERBATIM, so a
 * credential embedded in argv (`--api-key sk-xxx`, `TOKEN=ghp_xxx`, a URL query
 * token) reached `inventory --type mcp` / `--detail` output in plaintext. This
 * proves BOTH redaction (the three secrets disappear) AND no-false-positive (the
 * benign package name / path / port / non-sensitive param survive) — at the unit
 * boundary AND end-to-end through `inventory --type mcp --format json`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { redactMcpArgs } from '../src/analysis/redact-mcp-args.mjs';
import { inventoryCommand } from '../src/cli/commands.mjs';
import { formatJson, formatNdjson } from '../src/output/json.mjs';

const SECRET_ONE = 'sk-SECRETONE'; // separate --api-key value
const SECRET_TWO = 'ghp_SECRETTWO'; // inline TOKEN=
const SECRET_THREE = 'SECRETTHREE'; // url query ?token=

/** The DoD oracle input: a mix of benign args and three structurally-signalled secrets. */
const ORACLE_ARGS = [
  '-y',
  '@scope/server-foo',
  '/data/path',
  '--api-key',
  SECRET_ONE,
  '--port',
  '8080',
  `TOKEN=${SECRET_TWO}`,
  '--mode=fast',
  `https://h.example/x?token=${SECRET_THREE}&mode=fast`,
];

test('redactMcpArgs — secrets redacted, benign args preserved (falsifiable oracle)', () => {
  const out = redactMcpArgs(ORACLE_ARGS);
  const wire = JSON.stringify(out);

  // All three structurally-signalled secrets are gone.
  assert.ok(!wire.includes(SECRET_ONE), 'separate --api-key value must be redacted');
  assert.ok(!wire.includes(SECRET_TWO), 'inline TOKEN= value must be redacted');
  assert.ok(!wire.includes(SECRET_THREE), 'url query token value must be redacted');

  // No false positives: benign args survive verbatim.
  assert.ok(wire.includes('@scope/server-foo'), 'package name must be kept');
  assert.ok(wire.includes('/data/path'), 'filesystem path must be kept');
  assert.ok(wire.includes('8080'), 'port value must be kept');
  assert.ok(wire.includes('mode=fast'), 'non-sensitive url query param must be kept');

  // Param NAMES are kept (only the value side is redacted).
  assert.ok(wire.includes('--api-key'), 'flag name --api-key must be kept');
  assert.ok(wire.includes('TOKEN='), 'inline name TOKEN= must be kept');
  assert.ok(wire.includes('token='), 'url query param name token= must be kept');
});

test('redactMcpArgs — never mutates the input array', () => {
  const input = ['--token', SECRET_ONE];
  const copy = input.slice();
  const out = redactMcpArgs(input);
  assert.notEqual(out, input, 'returns a NEW array');
  assert.deepEqual(input, copy, 'input array is left byte-identical');
  assert.equal(out[1], '<redacted>', 'the returned copy is redacted');
});

test('redactMcpArgs — sensitive flag at END of array redacts nothing, no throw', () => {
  const out = redactMcpArgs(['serve', '--api-key']);
  assert.deepEqual(out, ['serve', '--api-key'], 'trailing sensitive flag with no value is untouched');
});

test('redactMcpArgs — sensitive flag followed by another flag redacts nothing', () => {
  const out = redactMcpArgs(['--token', '--verbose', 'x']);
  assert.deepEqual(out, ['--token', '--verbose', 'x'], 'a following flag means no value to redact');
});

test('redactMcpArgs — non-sensitive inline name is untouched', () => {
  assert.deepEqual(redactMcpArgs(['--mode=fast', 'PORT=8080']), ['--mode=fast', 'PORT=8080']);
});

test('redactMcpArgs — bare value with no structural signal is never redacted', () => {
  const args = ['sk-looks-like-a-secret', 'ghp_bare', '@scope/pkg'];
  assert.deepEqual(redactMcpArgs(args), args, 'bare values lack a structural signal');
});

test('redactMcpArgs — url with only non-sensitive params is unchanged', () => {
  const args = ['https://h.example/x?mode=fast&page=2'];
  assert.deepEqual(redactMcpArgs(args), args, 'no sensitive param ⇒ url returned as-is');
});

test('redactMcpArgs — non-http(s) url-shaped arg is left alone', () => {
  const args = ['file:///etc/token?token=abc'];
  // Not http/https → rule (c) declines; no other signal (no leading dash, no `=` before name).
  assert.deepEqual(redactMcpArgs(args), args, 'non-http url is not query-redacted');
});

test('redactMcpArgs — never throws on non-array / non-string elements', () => {
  assert.equal(redactMcpArgs(undefined), undefined, 'non-array passes through');
  assert.equal(redactMcpArgs(null), null);
  assert.deepEqual(redactMcpArgs([42, null]), [42, null], 'non-string elements pass through unchanged');
  assert.deepEqual(redactMcpArgs([42, '--token', SECRET_ONE]), [42, '--token', '<redacted>']);
});

/**
 * End-to-end: write a `.mcp.json` whose stdio server's args embed the three
 * secrets, run `inventory --type mcp`, and assert the secrets vanish from both
 * formatJson and formatNdjson while the benign args survive. Cleans up the temp dir.
 * @returns {{result: any}}
 */
function runInventoryMcp() {
  const dir = mkdtempSync(join(tmpdir(), 'mgr-mcp-args-'));
  try {
    const mcp = { mcpServers: { 'stdio-svc': { command: 'node', args: ORACLE_ARGS } } };
    writeFileSync(join(dir, '.mcp.json'), JSON.stringify(mcp), 'utf8');
    return inventoryCommand({ configDir: dir, args: { type: 'mcp' } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('inventory --type mcp --format json/ndjson — args secrets redacted end-to-end', () => {
  const { result, diagnostics } = runInventoryMcp();
  assert.equal(result.type, 'mcp');
  assert.equal(result.items.length, 1, 'the planted server is discovered');

  for (const wire of [
    formatJson({ command: 'inventory', result, diagnostics }),
    formatNdjson({ command: 'inventory', result, diagnostics }),
  ]) {
    assert.ok(!wire.includes(SECRET_ONE), '--api-key value leaked into inventory output');
    assert.ok(!wire.includes(SECRET_TWO), 'TOKEN= value leaked into inventory output');
    assert.ok(!wire.includes(SECRET_THREE), 'url token value leaked into inventory output');

    assert.ok(wire.includes('@scope/server-foo'), 'package name must survive');
    assert.ok(wire.includes('/data/path'), 'path must survive');
    assert.ok(wire.includes('8080'), 'port must survive');
    assert.ok(wire.includes('mode=fast'), 'non-sensitive query param must survive');
  }
});

// ── HIGH-finding regression table: precise token/segment matcher ──────────────
// The matcher must NOT redact a benign arg whose NAME merely CONTAINS a sensitive
// substring. Each KEPT case below was a confirmed FALSE POSITIVE under the OLD
// bare-substring `isSensitivePointer`; each REDACTED case is a genuine secret.

const SENTINEL = 'VALUE-SENTINEL'; // a non-secret value used to detect over-redaction

/**
 * Benign NAMES that must NOT trigger redaction. Each is exercised in the three
 * structural forms where applicable: flag+value `["--name","val"]`, inline
 * `name=val`, and url query `?name=val`. The value must survive verbatim.
 * `wouldFailOld` marks cases that the OLD substring matcher wrongly redacted.
 */
const KEPT_NAMES = [
  { name: 'keychain', wouldFailOld: true },   // contains "key"
  { name: 'keyboard', wouldFailOld: true },   // contains "key"
  { name: 'keymap', wouldFailOld: true },     // contains "key"
  { name: 'monkey', wouldFailOld: true },     // contains "key"
  { name: 'keyword', wouldFailOld: true },    // contains "key"
  { name: 'donkey', wouldFailOld: true },     // contains "key"
  { name: 'turkey', wouldFailOld: true },     // contains "key"
  { name: 'author', wouldFailOld: true },     // contains "auth"
  { name: 'authenticate', wouldFailOld: true }, // contains "auth"
  { name: 'oauth', wouldFailOld: true },      // contains "auth"
  { name: 'public-key', wouldFailOld: true }, // benign-qualifier veto on "key"
  { name: 'pub-key', wouldFailOld: true },    // benign-qualifier veto on "key"
  { name: 'key-id', wouldFailOld: true },     // benign-qualifier veto on "key"
  { name: 'public_key', wouldFailOld: true }, // underscore variant
  { name: 'key_id', wouldFailOld: true },     // underscore variant
];

for (const { name } of KEPT_NAMES) {
  test(`redactMcpArgs — KEEPS benign name "${name}" (flag+value form)`, () => {
    const out = redactMcpArgs([`--${name}`, SENTINEL]);
    assert.deepEqual(out, [`--${name}`, SENTINEL], `--${name} value must not be redacted`);
  });

  test(`redactMcpArgs — KEEPS benign name "${name}" (inline = form)`, () => {
    const out = redactMcpArgs([`${name}=${SENTINEL}`]);
    assert.deepEqual(out, [`${name}=${SENTINEL}`], `${name}= value must not be redacted`);
  });

  test(`redactMcpArgs — KEEPS benign name "${name}" (url query form)`, () => {
    const arg = `https://h.example/x?${name}=${SENTINEL}&mode=fast`;
    assert.deepEqual(redactMcpArgs([arg]), [arg], `?${name}= value must not be redacted`);
  });
}

/**
 * Genuine secret NAMES that MUST trigger redaction of their value. Exercised in
 * flag+value, inline, and url-query forms. None of these were broken by the old
 * matcher (they all also contained the substring) — they pin that the precise
 * matcher did not OVER-correct into a false NEGATIVE.
 */
const REDACTED_NAMES = [
  'api-key', 'access-token', 'token', 'password',
  'secret', 'credential', 'auth-token', 'key', 'auth',
];

for (const name of REDACTED_NAMES) {
  test(`redactMcpArgs — REDACTS secret name "${name}" (flag+value form)`, () => {
    const out = redactMcpArgs([`--${name}`, SENTINEL]);
    assert.deepEqual(out, [`--${name}`, '<redacted>'], `--${name} value must be redacted`);
  });

  test(`redactMcpArgs — REDACTS secret name "${name}" (inline = form)`, () => {
    const out = redactMcpArgs([`${name}=${SENTINEL}`]);
    assert.deepEqual(out, [`${name}=<redacted>`], `${name}= value must be redacted`);
  });

  test(`redactMcpArgs — REDACTS secret name "${name}" (url query form)`, () => {
    const out = redactMcpArgs([`https://h.example/x?${name}=${SENTINEL}`]);
    const u = new URL(out[0]);
    assert.equal(u.searchParams.get(name), '<redacted>', `?${name}= value must be redacted`);
  });
}
