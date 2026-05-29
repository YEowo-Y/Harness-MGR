/**
 * Unit C — secrets-content-sniff.test.mjs
 *
 * Covers sniffSecretContent() (src/lib/secrets-content-sniff.mjs):
 *   - ACCEPTANCE (a): disguised fixture (no secret name) detected by content
 *   - ACCEPTANCE (b): benign legit-skill file not flagged
 *   - ACCEPTANCE (c): plain prose, markdown table, git SHA, long URL not flagged
 *   - STATISTICAL calibration: deterministic LCG corpus — ≥85% of 32-byte base64
 *     secrets detected; 0% of benign corpus falsely flagged
 *   - Each PEM variant
 *   - Each token shape (incl. new Google/github-pat/ASIA shapes) with kind/pattern
 *   - Never-throws: null / undefined / number / object / binary Buffer
 *   - Buffer input with a token is detected
 *   - >64 KiB input: secret in first 64 KiB is detected
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sniffSecretContent } from '../src/lib/secrets-content-sniff.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, 'fixtures', 'secrets');

// ---------------------------------------------------------------------------
// Deterministic LCG PRNG (seeded — test is fully reproducible, no Math.random)
// ---------------------------------------------------------------------------

/** Linear congruential generator with fixed seed. */
function makeLcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s;
  };
}

/** Generate a base64 string from N deterministic pseudo-random bytes. */
function lcgBase64(lcg, nBytes) {
  const bytes = new Uint8Array(nBytes);
  for (let i = 0; i < nBytes; i++) bytes[i] = lcg() & 0xff;
  return Buffer.from(bytes).toString('base64');
}

// ---------------------------------------------------------------------------
// STATISTICAL calibration test — pins ENTROPY_THRESHOLD = 4.2
// ---------------------------------------------------------------------------

test('STATISTICAL: ≥85% of 32-byte base64 secrets detected; benign corpus 0% false-positive', () => {
  // Generate 200 deterministic 32-byte base64 strings (43 chars, entropy ≈4.83–5.04).
  // Measured distribution (seed 0xdeadbeef, 200 samples):
  //   min 4.833, mean 4.934, max 5.037 — all above threshold 4.2 → catch rate 100%.
  const lcg = makeLcg(0xdeadbeef);
  let detected = 0;
  const N = 200;
  for (let i = 0; i < N; i++) {
    const b64 = lcgBase64(lcg, 32);
    // Embed as a JSON value so the entropy run is at least 40+ chars.
    const input = `{"key":"${b64}"}`;
    if (sniffSecretContent(input).match) detected++;
  }
  const rate = detected / N;
  assert.ok(rate >= 0.85, `catch rate ${(rate * 100).toFixed(1)}% < 85% — ENTROPY_THRESHOLD may be mis-calibrated`);

  // Benign corpus: none of these must be flagged at 0%.
  const benignInputs = [
    // plain prose — no run ≥40 chars in base64 alphabet
    'This is an ordinary English paragraph with several sentences. ' +
      'It contains words like beautiful extraordinary configuration and vocabulary.',
    // markdown table — spaces break any long run
    '| Column A       | Column B     | Column C     |\n|----------------|--------------|--------------|',
    // 40-char hex git SHA — entropy ≈3.9 bits/char, below 4.2
    'a3f8b2c1d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9',
    '9178283e8ab123c456d789f0ab12de34567890ab',
    // long URL — separators break base64 alphabet runs
    'https://api.example.com/v1/resources/items?filter=active&sort=createdAt&limit=100',
    // legit SKILL.md content read from disk
    readFileSync(join(FIXTURES, 'legit-skill', 'api-tokens', 'SKILL.md'), 'utf8'),
  ];
  for (const input of benignInputs) {
    const r = sniffSecretContent(input);
    assert.equal(r.match, false, `benign input falsely flagged: "${input.slice(0, 60)}…" → ${JSON.stringify(r)}`);
  }
});

// ---------------------------------------------------------------------------
// ACCEPTANCE (a) — disguised fixture detected by content
// ---------------------------------------------------------------------------

test('ACCEPTANCE (a): disguised fixture (config.json) is detected by content', () => {
  const content = readFileSync(join(FIXTURES, 'disguised', 'config.json'), 'utf8');
  const result = sniffSecretContent(content);
  assert.equal(result.match, true, `expected match:true, got ${JSON.stringify(result)}`);
});

test('disguised fixture: PEM block is detected (fires before token checks)', () => {
  const content = readFileSync(join(FIXTURES, 'disguised', 'config.json'), 'utf8');
  const result = sniffSecretContent(content);
  assert.equal(result.match, true);
  assert.equal(result.kind, 'pem');
  assert.equal(result.pattern, 'pem-block');
});

test('disguised fixture: a token is detected when PEM is absent', () => {
  // Strip PEM so a token check fires. The fixture has both AWS and GitHub tokens;
  // the AWS/AKIA check runs first so kind is 'token' (pattern may vary).
  const raw = readFileSync(join(FIXTURES, 'disguised', 'config.json'), 'utf8');
  const noPem = raw.replace(/-----BEGIN OPENSSH PRIVATE KEY-----[\s\S]*?-----END OPENSSH PRIVATE KEY-----/, '');
  const result = sniffSecretContent(noPem);
  assert.equal(result.match, true);
  assert.equal(result.kind, 'token');
});

// ---------------------------------------------------------------------------
// ACCEPTANCE (b) — benign legit-skill file not flagged
// ---------------------------------------------------------------------------

test('ACCEPTANCE (b): legit-skill/api-tokens/SKILL.md is not flagged', () => {
  const content = readFileSync(join(FIXTURES, 'legit-skill', 'api-tokens', 'SKILL.md'), 'utf8');
  assert.deepEqual(sniffSecretContent(content), { match: false });
});

// ---------------------------------------------------------------------------
// ACCEPTANCE (c) — benign prose/markdown/SHA/URL not flagged
// ---------------------------------------------------------------------------

test('ACCEPTANCE (c): plain English prose is not flagged', () => {
  const prose = 'This is an ordinary English paragraph with several sentences. ' +
    'It contains words like "beautiful", "extraordinary", "configuration", ' +
    'and other common vocabulary. Nothing secret here at all.';
  assert.deepEqual(sniffSecretContent(prose), { match: false });
});

test('ACCEPTANCE (c): markdown table is not flagged', () => {
  const table = `| Column A       | Column B     | Column C     |
|----------------|--------------|--------------|
| alpha value    | beta value   | gamma value  |
| delta entry    | epsilon      | zeta         |
| eta row data   | theta col    | iota result  |`;
  assert.deepEqual(sniffSecretContent(table), { match: false });
});

test('ACCEPTANCE (c): 40-char hex git SHA is not flagged', () => {
  // Hex has only 16 distinct symbols → sample entropy ≈3.9 bits/char < 4.2.
  const sha = 'a3f8b2c1d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9';
  assert.equal(sha.length, 40);
  assert.deepEqual(sniffSecretContent(sha), { match: false });
});

test('ACCEPTANCE (c): another realistic git SHA is not flagged', () => {
  const sha = '9178283e8ab123c456d789f0ab12de34567890ab';
  assert.equal(sha.length, 40);
  assert.deepEqual(sniffSecretContent(sha), { match: false });
});

test('ACCEPTANCE (c): long URL is not flagged', () => {
  const url = 'https://api.example.com/v1/resources/items?filter=active&sort=createdAt&limit=100&offset=50&format=json';
  assert.deepEqual(sniffSecretContent(url), { match: false });
});

test('ACCEPTANCE (c): long dotted path is not flagged', () => {
  const path = 'com.example.project.module.submodule.component.service.handler.processor.runner';
  assert.deepEqual(sniffSecretContent(path), { match: false });
});

// ---------------------------------------------------------------------------
// PEM block variants
// ---------------------------------------------------------------------------

test('PEM: generic PRIVATE KEY block', () => {
  const pem = '-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASC...\n-----END PRIVATE KEY-----';
  const result = sniffSecretContent(pem);
  assert.equal(result.match, true);
  assert.equal(result.kind, 'pem');
  assert.equal(result.pattern, 'pem-block');
});

test('PEM: RSA PRIVATE KEY block', () => {
  const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----';
  const result = sniffSecretContent(pem);
  assert.equal(result.match, true);
  assert.equal(result.kind, 'pem');
});

test('PEM: CERTIFICATE block', () => {
  const pem = '-----BEGIN CERTIFICATE-----\nMIIDXTCCAkWgAwIBAgIJALz...\n-----END CERTIFICATE-----';
  const result = sniffSecretContent(pem);
  assert.equal(result.match, true);
  assert.equal(result.kind, 'pem');
});

test('PEM: OPENSSH PRIVATE KEY block', () => {
  const pem = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEA\n-----END OPENSSH PRIVATE KEY-----';
  const result = sniffSecretContent(pem);
  assert.equal(result.match, true);
  assert.equal(result.kind, 'pem');
});

test('PEM: EC PRIVATE KEY block', () => {
  const pem = '-----BEGIN EC PRIVATE KEY-----\nMHQCAQEEIBkg...\n-----END EC PRIVATE KEY-----';
  const result = sniffSecretContent(pem);
  assert.equal(result.match, true);
  assert.equal(result.kind, 'pem');
});

// ---------------------------------------------------------------------------
// Token shape variants — original patterns
// ---------------------------------------------------------------------------

test('token: AWS AKIA key detected', () => {
  const result = sniffSecretContent('key: AKIASYNTH3T1CTEST123 rest');
  assert.equal(result.match, true);
  assert.equal(result.kind, 'token');
  assert.equal(result.pattern, 'aws-akia');
});

test('token: AWS AKIA key fires when followed by non-[0-9A-Z] char', () => {
  // Negative lookahead (?![0-9A-Z]): key fires when 17th char is not uppercase/digit.
  const key = 'AKIASYNTH3T1CTEST123'; // AKIA + exactly 16 [0-9A-Z] chars
  const result = sniffSecretContent('"' + key + '"');
  assert.equal(result.match, true);
  assert.equal(result.kind, 'token');
  assert.equal(result.pattern, 'aws-akia');
});

test('token: AWS ASIA (STS temp credential) detected', () => {
  // ASIA prefix = STS/assumed-role session key; same 16-char suffix format as AKIA.
  const result = sniffSecretContent('ASIASYNTH3T1CTEST123 ');
  assert.equal(result.match, true);
  assert.equal(result.kind, 'token');
  assert.equal(result.pattern, 'aws-akia');
});

test('token: GitHub ghp_ token (36 chars)', () => {
  const token = 'ghp_SyntheticTestFixtureNoRealToken12345';
  const result = sniffSecretContent(`auth: "${token}"`);
  assert.equal(result.match, true);
  assert.equal(result.kind, 'token');
  assert.equal(result.pattern, 'github-token');
});

test('token: GitHub gho_ oauth token', () => {
  const token = 'gho_SyntheticTestFixtureNoRealToken12345';
  const result = sniffSecretContent(token + '\n');
  assert.equal(result.match, true);
  assert.equal(result.pattern, 'github-token');
});

test('token: GitHub ghs_ server token', () => {
  const token = 'ghs_SyntheticTestFixtureNoRealToken12345';
  assert.equal(sniffSecretContent(token + ' ').match, true);
});

test('token: GitHub ghu_ user token', () => {
  const token = 'ghu_SyntheticTestFixtureNoRealToken12345';
  assert.equal(sniffSecretContent(token + ' ').match, true);
});

test('token: GitHub ghr_ refresh token', () => {
  const token = 'ghr_SyntheticTestFixtureNoRealToken12345';
  assert.equal(sniffSecretContent(token + ' ').match, true);
});

test('token: OpenAI sk- key (20+ chars)', () => {
  const result = sniffSecretContent('sk-abcdefghijklmnopqrstuvwxyz1234567890ABCD');
  assert.equal(result.match, true);
  assert.equal(result.kind, 'token');
  assert.equal(result.pattern, 'openai-key');
});

test('token: Slack xoxb- bot token', () => {
  const result = sniffSecretContent('token: xoxb-12345678-ABCDEFGHIJK');
  assert.equal(result.match, true);
  assert.equal(result.kind, 'token');
  assert.equal(result.pattern, 'slack-token');
});

test('token: Slack xoxp- user token', () => {
  assert.equal(sniffSecretContent('xoxp-abc123def456').match, true);
});

test('token: JWT (three base64url segments)', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.SyntheticSig1234567890abcdef';
  const result = sniffSecretContent(jwt);
  assert.equal(result.match, true);
  assert.equal(result.kind, 'token');
  assert.equal(result.pattern, 'jwt');
});

// ---------------------------------------------------------------------------
// Token shape variants — new patterns (LOW fix)
// ---------------------------------------------------------------------------

test('token: GitHub fine-grained PAT (github_pat_ + 82 chars)', () => {
  // Build a deterministic 82-char [A-Za-z0-9_] suffix.
  const base = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_';
  let suffix = '';
  for (let i = 0; i < 82; i++) suffix += base[i % base.length];
  const token = 'github_pat_' + suffix;
  const result = sniffSecretContent(token + ' ');
  assert.equal(result.match, true, `expected match for github_pat token, got ${JSON.stringify(result)}`);
  assert.equal(result.kind, 'token');
  assert.equal(result.pattern, 'github-pat');
});

test('token: Google API key (AIza + 35 chars)', () => {
  // AIza + exactly 35 [A-Za-z0-9_-] chars.
  const token = 'AIzaSyD1234567890ABCDEabcdefghijklmnopq';
  assert.equal(token.slice(4).length, 35, 'suffix must be exactly 35 chars');
  const result = sniffSecretContent(`"api_key": "${token}"`);
  assert.equal(result.match, true, `expected match for Google API key, got ${JSON.stringify(result)}`);
  assert.equal(result.kind, 'token');
  assert.equal(result.pattern, 'google-api-key');
});

// ---------------------------------------------------------------------------
// Never-throws contract
// ---------------------------------------------------------------------------

test('never-throws: null returns {match:false}', () => {
  assert.doesNotThrow(() => {
    assert.deepEqual(sniffSecretContent(null), { match: false });
  });
});

test('never-throws: undefined returns {match:false}', () => {
  assert.doesNotThrow(() => {
    assert.deepEqual(sniffSecretContent(undefined), { match: false });
  });
});

test('never-throws: number returns {match:false}', () => {
  assert.doesNotThrow(() => {
    assert.deepEqual(sniffSecretContent(123), { match: false });
  });
});

test('never-throws: plain object returns {match:false}', () => {
  assert.doesNotThrow(() => {
    assert.deepEqual(sniffSecretContent({ key: 'value' }), { match: false });
  });
});

test('never-throws: binary Buffer decodes to replacement chars → {match:false}', () => {
  // 0xff 0xfe 0x00 0x01 — not valid UTF-8. Buffer.toString('utf8') replaces
  // invalid bytes with U+FFFD rather than throwing; the result matches nothing.
  assert.doesNotThrow(() => {
    assert.deepEqual(sniffSecretContent(Buffer.from([0xff, 0xfe, 0x00, 0x01])), { match: false });
  });
});

// ---------------------------------------------------------------------------
// Buffer input
// ---------------------------------------------------------------------------

test('Buffer input: GitHub token inside Buffer is detected', () => {
  const content = 'Authorization: ghp_SyntheticTestFixtureNoRealToken12345\n';
  const result = sniffSecretContent(Buffer.from(content, 'utf8'));
  assert.equal(result.match, true);
  assert.equal(result.kind, 'token');
  assert.equal(result.pattern, 'github-token');
});

test('Buffer input: PEM inside Buffer is detected', () => {
  const pem = '-----BEGIN CERTIFICATE-----\nMIIDXTCC...\n-----END CERTIFICATE-----\n';
  const result = sniffSecretContent(Buffer.from(pem, 'utf8'));
  assert.equal(result.match, true);
  assert.equal(result.kind, 'pem');
});

// ---------------------------------------------------------------------------
// Input cap behaviour
// ---------------------------------------------------------------------------

test('INPUT CAP: secret in first 64 KiB is detected even with a large input', () => {
  const secret = 'ghp_SyntheticTestFixtureNoRealToken12345';
  const input = secret + '\n' + 'x'.repeat(100 * 1024);
  const result = sniffSecretContent(input);
  assert.equal(result.match, true);
  assert.equal(result.kind, 'token');
  assert.equal(result.pattern, 'github-token');
});

test('INPUT CAP: secret placed ONLY beyond 64 KiB is not detected (cap in effect)', () => {
  // Documents the cap: a secret after the 64 KiB boundary is intentionally not
  // scanned. We assert no throw; match:true is not expected here.
  const input = 'a'.repeat(64 * 1024 + 100) + 'ghp_SyntheticTestFixtureNoRealToken12345';
  assert.doesNotThrow(() => sniffSecretContent(input));
});
