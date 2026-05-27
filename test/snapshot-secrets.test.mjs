/**
 * P3.U4 — snapshot-secrets.test.mjs (SKELETON)
 *
 * Seeds the assertion surface for the P3.U6 secrets FILTER. For now it confirms:
 *   1. the synthetic secrets fixture corpus exists on disk (incl. the .env files
 *      that the repo .gitignore would otherwise drop — a committed fixture must
 *      survive a fresh clone), and
 *   2. the P3.U3 matcher (isSecretFile) classifies each fixture as expected —
 *      secret files flagged, legit files (incl. a "token"-named ANCESTOR dir)
 *      kept.
 *
 * FULL filter behaviour (walk → exclude → --include-auth gate → per-drop
 * Diagnostic → proving legit *token* skills are captured) lands in P3.U6, which
 * extends this file. Skeleton only here.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isSecretFile } from '../src/lib/secrets-allowlist.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SECRETS_DIR = join(HERE, 'fixtures', 'secrets');
const LOCKED_DIR = join(HERE, 'fixtures', 'windows-locked');

// Fixtures that MUST be treated as secrets (excluded from a snapshot).
const EXPECTED_SECRETS = [
  'id_rsa', 'id_ed25519', 'id_ecdsa', 'id_dsa',
  '.env', '.env.local', '.credentials.json', 'credentials',
  'server.pem', 'signing.key', 'backup.gpg',
  'test.crt', 'test.cer', 'test.p12', 'test.pfx', 'test.asc',
  'github-token.json', 'app-secret.json', 'google-oauth.json', 'aws-credentials-old',
];
// Fixtures that MUST be kept (not secrets).
const EXPECTED_LEGIT = ['settings.json', 'notes.md'];
// A legit skill whose ANCESTOR dir name contains "token" — kept via basename scoping.
const LEGIT_NESTED = join('legit-skill', 'api-tokens', 'SKILL.md');

test('secrets fixture corpus exists on disk (incl. .gitignore-negated .env files)', () => {
  assert.ok(existsSync(SECRETS_DIR), 'secrets fixture dir present');
  for (const name of [...EXPECTED_SECRETS, ...EXPECTED_LEGIT]) {
    assert.ok(existsSync(join(SECRETS_DIR, name)), `fixture ${name} present`);
  }
  assert.ok(existsSync(join(SECRETS_DIR, LEGIT_NESTED)), 'nested legit skill present');
});

test('U3 matcher flags every secret fixture', () => {
  for (const name of EXPECTED_SECRETS) {
    assert.equal(isSecretFile(name), true, `${name} should be a secret`);
  }
});

test('U3 matcher keeps legit fixtures, incl. a token-named ancestor dir', () => {
  for (const name of EXPECTED_LEGIT) {
    assert.equal(isSecretFile(name), false, `${name} should be kept`);
  }
  // basename is SKILL.md — "token" lives only in the ancestor dir, so it's kept.
  assert.equal(isSecretFile(LEGIT_NESTED), false, 'nested SKILL.md kept despite token-named dir');
});

test('windows-locked fixture seed exists', () => {
  assert.ok(existsSync(join(LOCKED_DIR, 'locked-target.txt')), 'lock-target fixture present');
});
