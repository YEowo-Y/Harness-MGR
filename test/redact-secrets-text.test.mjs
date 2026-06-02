/**
 * Unit oracle for the output secret-shape redactor (audit 2026-06-02, P1).
 * src/analysis/redact-secrets-text.mjs
 *
 * Two contracts:
 *   1. REDACTS every high-confidence secret shape (PEM, token prefixes, URL
 *      userinfo, Bearer/Basic, sensitive name=value) — substring-surgical.
 *   2. NEVER over-redacts a benign string (commands, paths, package names, ports,
 *      non-sensitive flags, public-key/key-id, plain URLs, git SHAs, SSH remotes).
 *      This is the load-bearing "low false-positive" guarantee.
 * Plus: pure / never-throws / never-mutates / proto-safe for the deep walker.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { redactSecretsInString, redactSecretsDeep } from '../src/analysis/redact-secrets-text.mjs';

const MARKER = '<redacted>';

// Realistic-length fakes that satisfy each shape's length rule.
const GHP = `ghp_${'A'.repeat(36)}`;
const GH_PAT = `github_pat_${'B'.repeat(82)}`;
const AKIA = `AKIA${'ABCDEFGHIJKLMNOP'}`;        // 16 uppercase alnum
const AIZA = `AIza${'C'.repeat(35)}`;
const SKK = `sk-${'D'.repeat(40)}`;
const XOXB = 'xoxb-123456789012-abcdefABCDEF';
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
const BEARER_TOK = 'E'.repeat(40);

test('redacts each high-confidence token shape', () => {
  for (const secret of [GHP, GH_PAT, AKIA, AIZA, SKK, XOXB, JWT]) {
    const out = redactSecretsInString(`prefix ${secret} suffix`);
    assert.ok(!out.includes(secret), `secret ${secret.slice(0, 10)}… must be redacted`);
    assert.ok(out.includes(MARKER), 'marker present');
    assert.ok(out.startsWith('prefix ') && out.endsWith(' suffix'), 'surrounding text preserved');
  }
});

test('redacts a full PEM block', () => {
  const pem = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAA\n-----END OPENSSH PRIVATE KEY-----';
  const out = redactSecretsInString(`key=${pem}`);
  assert.ok(!out.includes('b3BlbnNzaC'), 'PEM body must be gone');
  assert.ok(out.includes(MARKER));
});

test('redacts URL userinfo but preserves scheme/host/path', () => {
  const out = redactSecretsInString('postgres://dbuser:s3cretPassXYZ@db.internal/app');
  assert.ok(!out.includes('s3cretPassXYZ'), 'password gone');
  assert.equal(out, 'postgres://<redacted>@db.internal/app');
});

test('redacts URL userinfo even when the password contains a raw @', () => {
  const out = redactSecretsInString('postgres://user:p@ss@db.internal/app');
  assert.ok(!out.includes('p@ss'), 'raw-@ password gone');
  assert.equal(out, 'postgres://<redacted>@db.internal/app');
});

test('redacts a Bearer/Basic auth token, preserving the scheme word', () => {
  const out = redactSecretsInString(`curl -H "Authorization: Bearer ${BEARER_TOK}" https://x`);
  assert.ok(!out.includes(BEARER_TOK), 'bearer token gone');
  assert.ok(out.includes('Bearer <redacted>'), 'scheme kept, token redacted');
  assert.ok(out.includes('curl') && out.includes('https://x'), 'rest of command preserved');
});

test('redacts an inline sensitive name=value (opaque value, no known shape)', () => {
  for (const s of ['--api-key=plainOpaqueValue123', 'TOKEN=plainOpaqueValue123', 'password=hunter2hunter2']) {
    const out = redactSecretsInString(s);
    assert.ok(!out.includes('plainOpaqueValue123') && !out.includes('hunter2hunter2'), `value redacted in ${s}`);
    assert.ok(out.includes(MARKER));
  }
});

// ── NO over-redaction: benign strings pass through UNCHANGED ──

test('does NOT over-redact benign command strings / paths / package names', () => {
  const benign = [
    'node "$HOME/.claude/hooks/keyword-detector.mjs"',
    'any-buddy apply --silent',
    'C:\\Users\\alice\\.claude\\agents\\analyst.md',
    'npx -y @modelcontextprotocol/server-filesystem /tmp',
    '--mode=fast',
    '--model=opus',
    'PORT=8080',
    'width=1920',
    'https://github.com/owner/repo',          // URL, no userinfo
    'git@github.com:owner/repo.git',          // SSH remote (no scheme://)
    'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0', // 40-hex git SHA (no shape; entropy excluded)
    'Bearer tokens are short words',          // "Bearer" + <16 token chars → not matched
  ];
  for (const s of benign) {
    assert.equal(redactSecretsInString(s), s, `benign string must be unchanged: ${s}`);
  }
});

test('does NOT over-redact ambiguous-but-benign name=value (public-key/key-id/keychain)', () => {
  for (const s of ['--public-key=/path/to/id.pub', 'key-id=ABC123', '--keychain=login', 'monkey=banana']) {
    assert.equal(redactSecretsInString(s), s, `must be unchanged: ${s}`);
  }
});

// ── pure / never-throws / pass-through ──

test('non-string and empty inputs pass through unchanged; never throws', () => {
  for (const v of [42, true, null, undefined, {}, [], NaN]) {
    assert.equal(redactSecretsInString(v), v);
  }
  assert.equal(redactSecretsInString(''), '');
});

// ── redactSecretsDeep ──

test('redactSecretsDeep redacts string leaves at any depth, preserves structure', () => {
  const input = {
    statusLine: { type: 'command', command: `s.mjs --token=${GHP}` },
    hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: `x ${SKK}` }] }] },
    count: 3,
    flag: true,
    nothing: null,
  };
  const out = redactSecretsDeep(input);
  const wire = JSON.stringify(out);
  assert.ok(!wire.includes(GHP) && !wire.includes(SKK), 'nested secrets redacted');
  assert.equal(out.statusLine.type, 'command', 'non-secret string preserved');
  assert.equal(out.count, 3);
  assert.equal(out.flag, true);
  assert.equal(out.nothing, null);
});

test('redactSecretsDeep does NOT mutate its input', () => {
  const input = { command: `run ${GHP}` };
  const before = JSON.stringify(input);
  redactSecretsDeep(input);
  assert.equal(JSON.stringify(input), before, 'input unchanged');
});

test('redactSecretsDeep is prototype-poisoning safe', () => {
  const poisoned = JSON.parse(`{"__proto__":{"command":"x ${GHP}"},"ok":"keepme"}`);
  const out = redactSecretsDeep(poisoned);
  assert.ok(!Object.prototype.hasOwnProperty.call(out, '__proto__'), 'no own __proto__ in output');
  assert.equal({}.command, undefined, 'Object.prototype not polluted');
  assert.equal(out.ok, 'keepme');
});

test('redactSecretsDeep never throws on junk / primitives', () => {
  for (const v of [null, undefined, 5, 'plain', true]) {
    assert.doesNotThrow(() => redactSecretsDeep(v));
  }
});

// ── bounded cost (DoS guard) — pre-fix the unbounded URL scheme was O(n^2) ──

test('bounded cost: a sub-cap large no-@ string scans linearly (was O(n^2), ~2.8s pre-fix at 60KB)', () => {
  const big = 'a'.repeat(60 * 1024); // < INPUT_CAP → actually scanned; bounded scheme keeps it linear
  const start = Date.now();
  const out = redactSecretsInString(big);
  const elapsed = Date.now() - start;
  assert.equal(out, big, 'benign string unchanged');
  assert.ok(elapsed < 2000, `sub-cap scan must be linear (pre-fix ~2.8s); was ${elapsed}ms`);
});

test('bounded cost: an over-cap string is returned unchanged instantly (INPUT_CAP backstop)', () => {
  const huge = `${'a'.repeat(200 * 1024)} trailing`; // > INPUT_CAP (64 KiB)
  const start = Date.now();
  const out = redactSecretsInString(huge);
  assert.equal(out, huge, 'over-cap string returned unchanged');
  assert.ok(Date.now() - start < 500, 'over-cap path is O(1)');
});

test('bare key=/auth= in a command string is redacted BY DESIGN (documented over-redaction)', () => {
  // Consistent with redact-mcp-args isSensitiveArgName; display-only, recall>precision.
  assert.ok(redactSecretsInString('jq ".key=1" file.json').includes('<redacted>'), 'bare key= is intentionally redacted');
});

test('Bearer scheme match is case-insensitive and preserves the original casing', () => {
  const tok = 'Z'.repeat(40);
  assert.equal(redactSecretsInString(`authorization: bearer ${tok}`), 'authorization: bearer <redacted>');
});
