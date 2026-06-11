/**
 * P3.U3 — secrets-allowlist.test.mjs
 *
 * Tests for src/lib/secrets-allowlist.mjs (matchesSecret / isSecretFile) + the
 * src/config/secrets-allowlist.json data.
 *
 * Acceptance (DoD): EVERY configured pattern is covered by a representative
 * matching filename (data-driven below), matching is basename-scoped +
 * case-insensitive, and the matcher never throws on junk input. The basename
 * scoping is pinned by a falsifiable oracle: a legit nested file whose ancestor
 * directory contains a sensitive word is NOT dropped.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SECRETS_ALLOWLIST,
  matchesSecret,
  isSecretFile,
} from '../src/lib/secrets-allowlist.mjs';

// ── config shape ────────────────────────────────────────────────────────────

test('SECRETS_ALLOWLIST: loads from JSON with the three pattern arrays', () => {
  assert.equal(typeof SECRETS_ALLOWLIST, 'object');
  assert.ok(Array.isArray(SECRETS_ALLOWLIST.extensions));
  assert.ok(Array.isArray(SECRETS_ALLOWLIST.exactNames));
  assert.ok(Array.isArray(SECRETS_ALLOWLIST.globNames));
  assert.equal(SECRETS_ALLOWLIST.version, 1);
});

// ── every configured pattern is covered (DoD: "every pattern") ────────────────

// One representative matching basename per configured pattern + the kind it hits.
const PATTERN_CASES = [
  // extensions
  ['server.crt', 'extension'],
  ['ca.cer', 'extension'],
  ['tls.pem', 'extension'],
  ['private.key', 'extension'],
  ['store.p12', 'extension'],
  ['cert.pfx', 'extension'],
  ['msg.gpg', 'extension'],
  ['pub.asc', 'extension'],
  // exact names
  ['id_rsa', 'exact'],
  ['id_ed25519', 'exact'],
  ['id_ecdsa', 'exact'],
  ['id_dsa', 'exact'],
  ['credentials', 'exact'],
  ['.credentials.json', 'exact'],
  // auth.json: the P5.U7 Codex report's gap — ~/.codex/auth.json was not name-
  // matched (*oauth.json needs the literal "oauth.json" substring). Name leg
  // must not depend on the content sniffer (snapshot recall>precision policy).
  ['auth.json', 'exact'],
  ['.env', 'exact'],
  // globNames
  ['.env.local', 'glob'],
  ['github-token.json', 'glob'],   // *token.json (also *-token*)
  ['app-secret.json', 'glob'],     // *secret.json
  ['slack-oauth.json', 'glob'],    // *oauth.json
  ['aws-credentials-prod', 'glob'], // *-credentials*
  ['my-token-file', 'glob'],       // *-token*
  ['google-oauth-id', 'glob'],     // *-oauth*
  ['top-secret-data', 'glob'],     // *-secret*
];

test('matchesSecret: every configured pattern matches a representative file', () => {
  for (const [name, kind] of PATTERN_CASES) {
    const res = matchesSecret(name);
    assert.equal(res.match, true, `${name} should match (${kind})`);
    assert.equal(res.kind, kind, `${name} should match by ${kind}, got ${res.kind}`);
    assert.equal(typeof res.pattern, 'string');
  }
});

test('matchesSecret: covers every entry in each configured array', () => {
  // extensions: a `name.<ext>` must match by extension
  for (const ext of SECRETS_ALLOWLIST.extensions) {
    assert.equal(matchesSecret(`file.${ext}`).match, true, `*.${ext}`);
  }
  // exactNames: the exact basename must match
  for (const name of SECRETS_ALLOWLIST.exactNames) {
    assert.equal(matchesSecret(name).match, true, name);
  }
  // globNames: every entry MUST contain a wildcard (else it belongs in exactNames),
  // and a synthesized matching name must match via the glob path.
  for (const glob of SECRETS_ALLOWLIST.globNames) {
    assert.ok(glob.includes('*'), `globNames entry "${glob}" must contain '*' (else move to exactNames)`);
    const sample = glob.replace(/\*/g, 'x');
    const res = matchesSecret(sample);
    assert.equal(res.match, true, `${glob} via ${sample}`);
    assert.equal(res.kind, 'glob', `${glob} via ${sample} should match by glob`);
  }
});

// ── basename scoping + case-insensitivity ─────────────────────────────────────

test('matchesSecret: matches on basename across path separators', () => {
  assert.equal(matchesSecret('a/b/c/id_rsa').match, true);
  assert.equal(matchesSecret('C:\\Users\\x\\.ssh\\id_rsa').match, true);
  assert.equal(matchesSecret('deep/nested/server.pem').match, true);
});

test('matchesSecret: case-insensitive (catches ID_RSA / SERVER.PEM / .ENV)', () => {
  assert.equal(matchesSecret('ID_RSA').match, true);
  assert.equal(matchesSecret('SERVER.PEM').match, true);
  assert.equal(matchesSecret('.ENV').match, true);
});

test('matchesSecret: INVARIANT basename scoping — a sensitive ANCESTOR dir does NOT drop a clean file', () => {
  // A legit skill whose folder name contains "token" must still be captured:
  // only the basename (SKILL.md) is matched, not the path.
  assert.equal(matchesSecret('skills/api-tokens/SKILL.md').match, false);
  assert.equal(matchesSecret('skills/oauth-helpers/README.md').match, false);
  assert.equal(matchesSecret('agents/credentials-manager/agent.md').match, false);
});

// ── non-secret files are not flagged ──────────────────────────────────────────

test('matchesSecret: ordinary config/content files do NOT match', () => {
  for (const name of [
    'settings.json', 'SKILL.md', 'notes.txt', 'CLAUDE.md',
    'package.json', 'apikey', 'README', 'index.mjs', 'data.csv',
  ]) {
    assert.equal(matchesSecret(name).match, false, name);
  }
});

test('matchesSecret: a dotted non-secret JSON is not caught by the *.json globs', () => {
  // .json itself is not a secret extension; only *token/secret/oauth.json are.
  assert.equal(matchesSecret('inventory.json').match, false);
  assert.equal(matchesSecret('config.json').match, false);
});

// ── never-throws + injected allowlist ─────────────────────────────────────────

test('matchesSecret: never throws on junk; returns {match:false}', () => {
  for (const junk of [null, undefined, 42, '', {}, [], Symbol('x')]) {
    let res;
    assert.doesNotThrow(() => { res = matchesSecret(junk); });
    assert.equal(res.match, false);
  }
});

test('matchesSecret: honors an injected allowlist + tolerates a malformed one', () => {
  assert.equal(matchesSecret('x.foo', { extensions: ['foo'] }).match, true);
  assert.equal(matchesSecret('only-this', { exactNames: ['only-this'] }).kind, 'exact');
  assert.equal(matchesSecret('ab.log', { globNames: ['*.log'] }).kind, 'glob');
  // malformed shapes must not throw and must not match
  assert.equal(matchesSecret('id_rsa', { extensions: 'nope', exactNames: 5 }).match, false);
  assert.equal(matchesSecret('id_rsa', { globNames: [42, null] }).match, false);
});

test('isSecretFile: boolean convenience mirrors matchesSecret', () => {
  assert.equal(isSecretFile('id_rsa'), true);
  assert.equal(isSecretFile('server.pem'), true);
  assert.equal(isSecretFile('settings.json'), false);
  assert.doesNotThrow(() => isSecretFile(null));
  assert.equal(isSecretFile(null), false);
});
