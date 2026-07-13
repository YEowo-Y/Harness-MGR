/**
 * Unit oracle for the output secret-shape redactor (audit 2026-06-02, P1).
 * src/lib/redact-secrets-text.mjs
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
import { redactSecretsInString, redactSecretsDeep, redactSecretsLines } from '../src/lib/redact-secrets-text.mjs';

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

test('redacts quoted sensitive name=value; escaped source text fails closed', () => {
  const cases = [
    ['--token="OpaqueQuotedSecret123"', '--token="<redacted>"'],
    ["--password='OpaqueSingleQuotedSecret123'", "--password='<redacted>'"],
    [String.raw`{"command":"tool --token=\"OpaqueJsonSecret123\""}`,
      MARKER],
  ];
  for (const [input, expected] of cases) {
    assert.equal(redactSecretsInString(input), expected);
    assert.equal(redactSecretsLines(input), expected);
  }
});

test('generic name=value recognises config acronyms and plural sensitive keys', () => {
  assert.equal(redactSecretsInString('APIKey=OpaqueApiValue123'), 'APIKey=<redacted>');
  assert.equal(
    redactSecretsInString('credentials=OpaqueCredentialValue456'),
    'credentials=<redacted>',
  );
});

test('a nested escaped quote in a sensitive JSON command fails closed without suffix leakage', () => {
  const left = 'NESTED_SECRET_LEFT_123';
  const right = 'NESTED_SECRET_RIGHT_456';
  const input = JSON.stringify({ command: `tool --token="${left}\\"${right}"` });
  const out = redactSecretsLines(input);
  assert.equal(out, MARKER);
  assert.ok(!out.includes(left));
  assert.ok(!out.includes(right));
});

test('mixed and unclosed sensitive shell words never leak their suffix', () => {
  const suffix = 'OPAQUE_SUFFIX_SENTINEL_456';
  const cases = [
    `tool --token=OpaquePrefix\\${suffix}`,
    `--token=OpaquePrefix"${suffix}"`,
    `--password=OpaquePrefix'${suffix}'`,
    `--token="OpaquePrefix"${suffix}`,
    '--token="OPAQUE_UNCLOSED_DOUBLE_123',
    "--password='OPAQUE_UNCLOSED_SINGLE_123",
    '--credential=\\OPAQUE_BACKSLASH_VALUE_123',
    JSON.stringify({ command: `tool --token=OpaquePrefix\\"${suffix}` }),
  ];
  for (const input of cases) {
    const out = redactSecretsInString(input);
    assert.ok(out.includes(MARKER), `missing marker for ${input}`);
    assert.ok(!out.includes(suffix), `suffix leaked from ${input}: ${out}`);
    assert.ok(!out.includes('OPAQUE_UNCLOSED'), `unclosed value leaked from ${input}: ${out}`);
    assert.ok(!out.includes('OPAQUE_BACKSLASH'), `backslash value leaked from ${input}: ${out}`);
  }
});

test('ambiguous sensitive shell words with spaces fail closed as one display line', () => {
  const cases = [
    '--token="LEFT SECRET_SUFFIX_WITH_SPACE',
    String.raw`--token=LEFT\ SECRET_SUFFIX_ESCAPED_SPACE`,
    'tool --password=prefix"INNER SECRET_SUFFIX" --mode=safe',
  ];
  for (const input of cases) {
    assert.equal(redactSecretsLines(input), MARKER, input);
  }
});

test('nested and unicode-escaped JSON sensitive keys cannot bypass line redaction', () => {
  const cases = [
    '{"config":{"token":"NESTED_SECRET_SENTINEL"}}',
    String.raw`{"API\u004bey":"ESCAPED_KEY_SECRET_SENTINEL"}`,
  ];
  for (const input of cases) {
    const out = redactSecretsLines(input);
    assert.ok(out.includes(MARKER), `missing marker for ${input}`);
    assert.ok(!out.includes('SECRET_SENTINEL'), `secret leaked from ${input}: ${out}`);
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

test('bounded cost: dense sensitive assignments do not rescan the remaining shell word', () => {
  const dense = 'token=x,'.repeat(7680); // exactly 60 KiB, below INPUT_CAP
  const start = Date.now();
  const out = redactSecretsInString(dense);
  const elapsed = Date.now() - start;
  assert.ok(out.includes(MARKER), 'the sensitive word is redacted');
  assert.ok(elapsed < 2000, `dense assignment scan must remain linear; was ${elapsed}ms`);
});

test('bounded cost: malformed benign-key JSON does not trigger quadratic container matching', () => {
  const malformed = ('{"field":' + '"\\'.repeat(40 * 1024)).slice(0, 65520);
  const start = Date.now();
  const out = redactSecretsLines(malformed);
  const elapsed = Date.now() - start;
  assert.equal(out, malformed, 'a benign-key malformed line remains unchanged');
  assert.ok(elapsed < 2000, `malformed JSON scan must remain linear; was ${elapsed}ms`);
});

test('bounded cost: an early sensitive JSON key cannot reactivate quadratic tail scanning', () => {
  const prefix = '{"token":"safe","field":';
  const malformed = (prefix + '"\\'.repeat(40 * 1024)).slice(0, 65520);
  const start = Date.now();
  const out = redactSecretsLines(malformed);
  const elapsed = Date.now() - start;
  assert.ok(out.includes(MARKER), 'the sensitive scalar is redacted');
  assert.ok(elapsed < 2000, `sensitive malformed JSON scan must remain linear; was ${elapsed}ms`);
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

// ── redactSecretsLines — per-line wrapper for multi-line TEXT (diff surfaces) ────────

test('redactSecretsLines: redacts a single-line secret on any line, preserving line count', () => {
  const text = 'a\nb\ndb=postgres://u:s3cr3tPass@h/db\nc\nd';
  const out = redactSecretsLines(text);
  assert.ok(!out.includes('s3cr3tPass'), 'secret gone');
  assert.ok(out.includes('<redacted>'), 'marker present');
  assert.equal(out.split('\n').length, text.split('\n').length, 'line count preserved');
});

test('redactSecretsLines: a secret PAST 64 KiB is still redacted (per-line beats the whole-string cap)', () => {
  // The exact regression the config-diff review caught: redactSecretsInString returns a
  // >64 KiB string UNCHANGED, so redacting a whole large file leaks. Per-line does not.
  const filler = Array.from({ length: 1000 }, (_, i) => `line_${i}_${'x'.repeat(70)}`).join('\n'); // ~80 KiB
  const text = `${filler}\ntoken=ghp_${'a'.repeat(36)}`;
  assert.ok(text.length > 64 * 1024, 'precondition: over the cap');
  assert.equal(redactSecretsInString(text), text, 'whole-string redaction is a no-op past the cap');
  const out = redactSecretsLines(text);
  assert.ok(out.includes('<redacted>'), 'per-line still redacts the secret line past the cap');
  assert.ok(!out.includes(`ghp_${'a'.repeat(36)}`), 'the raw token is gone');
});

test('redactSecretsLines: an over-cap single line is replaced whole, never returned verbatim', () => {
  const secret = `ghp_${'A'.repeat(36)}`;
  const text = `{"padding":"${'x'.repeat(70 * 1024)}","token":"${secret}"}`;
  assert.ok(text.length > 64 * 1024, 'precondition: one physical line exceeds the cap');
  assert.equal(redactSecretsInString(text), text, 'the generic value redactor keeps its bounded-cost contract');
  assert.equal(redactSecretsLines(text), MARKER, 'the diff-surface wrapper fails closed');
});

test('redactSecretsLines: a complete CRLF PEM block is redacted line-for-line', () => {
  const text = [
    'alpha',
    '-----BEGIN PRIVATE KEY-----',
    'MIIOLDSECRETBODY111',
    'MIISECONDSECRETBODY222',
    '-----END PRIVATE KEY-----',
    'omega',
  ].join('\r\n');
  const expected = [
    'alpha',
    MARKER,
    MARKER,
    MARKER,
    MARKER,
    'omega',
  ].join('\r\n');
  const out = redactSecretsLines(text);
  assert.equal(out, expected);
  assert.equal(out.split('\r\n').length, text.split('\r\n').length, 'line count is preserved');
});

test('redactSecretsLines: an over-cap line with PEM BEGIN still redacts the following block', () => {
  const body = 'OPAQUE_BODY_SENTINEL';
  const text = `${'x'.repeat(70 * 1024)}-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\nafter`;
  const out = redactSecretsLines(text);
  assert.ok(!out.includes(body), 'PEM body after an oversized BEGIN line must not leak');
  assert.equal(out, '<redacted>\n<redacted>\n<redacted>\nafter');
});

test('redactSecretsLines: non-string / empty input passes through unchanged (never throws)', () => {
  assert.equal(redactSecretsLines(''), '');
  assert.equal(redactSecretsLines(null), null);
  assert.equal(redactSecretsLines(42), 42);
  assert.deepEqual(redactSecretsLines(['x']), ['x']);
});
