/**
 * P3.U4 skeleton + P3.U6 filter tests — snapshot-secrets.test.mjs
 *
 * The U4 skeleton (kept below) confirms:
 *   1. the synthetic secrets fixture corpus exists on disk (incl. the .env files
 *      that the repo .gitignore would otherwise drop — a committed fixture must
 *      survive a fresh clone), and
 *   2. the P3.U3 matcher (isSecretFile) classifies each fixture as expected —
 *      secret files flagged, legit files (incl. a "token"-named ANCESTOR dir)
 *      kept.
 *
 * The P3.U6 block (added below the skeleton) drives the actual FILTER
 * (filterSnapshotSecrets) over the WHOLE corpus and pins the falsifiable golden
 * oracles: every expected secret is dropped (proving BOTH name-kinds AND
 * content), the line-22 oracle (`disguised/config.json` dropped `by:'content'`
 * + legit basename-scoped files kept), one INFO Diagnostic per drop, and the
 * lockfile-guard + never-throws edges.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isSecretFile } from '../src/lib/secrets-allowlist.mjs';
import { filterSnapshotSecrets } from '../src/ops/snapshot-secrets-filter.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SECRETS_DIR = join(HERE, 'fixtures', 'secrets');
const LOCKED_DIR = join(HERE, 'fixtures', 'windows-locked');

// Fixtures that MUST be treated as secrets (excluded from a snapshot).
const EXPECTED_SECRETS = [
  'id_rsa', 'id_ed25519', 'id_ecdsa', 'id_dsa',
  '.env', '.env.local', '.credentials.json', 'credentials', 'auth.json',
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

// ===========================================================================
// P3.U6 — filterSnapshotSecrets over the WHOLE corpus (falsifiable goldens)
// ===========================================================================

// The benign-name-but-secret-content fixture, caught ONLY by content-sniff.
const DISGUISED = join('disguised', 'config.json');

// The full corpus rel-path list the U5 walker would hand the filter (POSIX rel).
const CORPUS_FILES = [
  ...EXPECTED_SECRETS,
  ...EXPECTED_LEGIT,
  LEGIT_NESTED.split('\\').join('/'),
  DISGUISED.split('\\').join('/'),
];

/** Run the real filter over the on-disk corpus (default readFileFn/existsFn). */
function runCorpusFilter() {
  return filterSnapshotSecrets({ baseDir: SECRETS_DIR, files: CORPUS_FILES });
}

test('U6 filter drops EVERY expected secret (mix of name- and content-kinds)', () => {
  const { dropped } = runCorpusFilter();
  const droppedPaths = new Set(dropped.map((d) => d.path));
  for (const name of EXPECTED_SECRETS) {
    assert.ok(droppedPaths.has(name), `${name} must be dropped`);
  }
  // disguised has a BENIGN name, so it proves content-sniff is wired.
  assert.ok(droppedPaths.has(DISGUISED.split('\\').join('/')), 'disguised/config.json dropped');
});

test('U6 line-22 oracle: disguised dropped by:content, legit kept by basename-scope', () => {
  const { kept, dropped } = runCorpusFilter();
  const disguisedRel = DISGUISED.split('\\').join('/');

  // (a) content-sniff is genuinely wired: benign NAME, secret CONTENT → by:'content'.
  const disRec = dropped.find((d) => d.path === disguisedRel);
  assert.ok(disRec, 'disguised present in dropped');
  assert.equal(disRec.by, 'content', 'disguised dropped by content, not name');
  assert.equal(disRec.kind, 'pem', 'disguised content kind is pem');

  // (b) basename-scoped legit retention — none weakens the matcher.
  const keptSet = new Set(kept);
  assert.ok(keptSet.has('settings.json'), 'settings.json kept');
  assert.ok(keptSet.has('notes.md'), 'notes.md kept');
  assert.ok(keptSet.has(LEGIT_NESTED.split('\\').join('/')), 'nested SKILL.md kept (token-named ancestor dir)');
});

test('U6 the glob-named-but-benign-content files are dropped by:name', () => {
  const { dropped } = runCorpusFilter();
  for (const name of ['github-token.json', 'app-secret.json', 'google-oauth.json']) {
    const rec = dropped.find((d) => d.path === name);
    assert.ok(rec, `${name} dropped`);
    assert.equal(rec.by, 'name', `${name} dropped by name (its content is benign)`);
    assert.equal(rec.kind, 'glob', `${name} name kind is glob`);
  }
});

test('U6 kept + dropped partition the corpus exactly, both sorted', () => {
  const { kept, dropped } = runCorpusFilter();
  // Every input is either kept or dropped, no overlap, no loss.
  const droppedPaths = dropped.map((d) => d.path);
  const union = [...kept, ...droppedPaths].sort();
  const expected = [...CORPUS_FILES].sort();
  assert.deepStrictEqual(union, expected, 'kept ∪ dropped === corpus (no overlap/loss)');
  // Exactly the 3 legit files are kept (2 flat + 1 nested).
  assert.deepStrictEqual(
    kept,
    ['legit-skill/api-tokens/SKILL.md', 'notes.md', 'settings.json'],
    'kept is exactly the 3 legit files, sorted',
  );
  // Sorted-output contract.
  assert.deepStrictEqual(kept, [...kept].sort(), 'kept sorted');
  assert.deepStrictEqual(droppedPaths, [...droppedPaths].sort(), 'dropped sorted by path');
});

test('U6 emits exactly one snapshot-secret-excluded INFO per drop', () => {
  const { dropped, diagnostics } = runCorpusFilter();
  const excl = diagnostics.filter((d) => d.code === 'snapshot-secret-excluded');
  assert.equal(excl.length, dropped.length, 'one excluded-diagnostic per drop');
  for (const d of excl) {
    assert.equal(d.severity, 'info', 'drop diagnostics are info severity');
    assert.equal(d.phase, 'snapshot-secrets', 'phase tagged');
    assert.equal(typeof d.path, 'string', 'diagnostic carries the dropped path');
  }
});

test('U6 lockfile guard: a package-lock.json with sha512 integrity is KEPT', () => {
  // sha512-<base64> integrity hashes flag as entropy; the lockfile guard must
  // skip the content sniff so the lockfile is kept, not false-dropped.
  const lockContent = JSON.stringify({
    name: 'x', lockfileVersion: 3,
    packages: { '': { dependencies: { a: '^1' } },
      'node_modules/a': { integrity: 'sha512-ABCDEFghijklmnopqrstuvwxyz0123456789ABCDEFghijklmnopqrstuvwxyz0123456789ABCDEFghij1234==' } },
  });
  const files = ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'npm-shrinkwrap.json'];
  const res = filterSnapshotSecrets({
    baseDir: '/virtual',
    files,
    readFileFn: () => lockContent, // every read returns the entropy-laden lock body
  });
  assert.deepStrictEqual(res.kept, files.slice().sort(), 'all lockfiles kept');
  assert.deepStrictEqual(res.dropped, [], 'no lockfile dropped');
});

test('U6 a non-lockfile config WITH the same integrity hash IS dropped by content', () => {
  // Falsifiable counterpart to the guard: the SAME entropy body in a non-lockfile
  // name is content-sniffed and dropped, proving the guard is name-scoped (not a
  // blanket entropy bypass).
  const body = 'token = sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdef';
  const res = filterSnapshotSecrets({
    baseDir: '/virtual',
    files: ['config.json'],
    readFileFn: () => body,
  });
  assert.deepStrictEqual(res.kept, [], 'config.json not kept');
  assert.equal(res.dropped.length, 1);
  assert.equal(res.dropped[0].by, 'content', 'dropped by content');
});

// ---------------------------------------------------------------------------
// follow-up #10 — prose (.md/.markdown) entropy exemption
// ---------------------------------------------------------------------------

// A 43-char high-entropy base64 run that the entropy leg WOULD flag by default.
// Deterministic (no Math.random) so the oracle is reproducible.
const ENTROPY_RUN = (() => {
  let s = 0xdeadbeef >>> 0;
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) { s = (Math.imul(1664525, s) + 1013904223) >>> 0; bytes[i] = s & 0xff; }
  return Buffer.from(bytes).toString('base64');
})();
// Prose body carrying the entropy run as an inline base64 example (the real-world
// false-positive shape: a high-entropy run embedded in Markdown prose).
const PROSE_WITH_ENTROPY = `# Example\n\nA base64 token example: \`${ENTROPY_RUN}\`\n\nSee the docs.`;
// A real PEM pasted into a prose file — MUST still be caught by the PEM leg.
const PROSE_WITH_PEM = `# Notes\n\nPaste your key:\n-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEA\n-----END OPENSSH PRIVATE KEY-----\n`;

test('U6/#10 a PROSE .md with a high-entropy run is KEPT (entropy leg skipped)', () => {
  const res = filterSnapshotSecrets({
    baseDir: '/virtual',
    files: ['skills/foo/SKILL.md'],
    readFileFn: () => PROSE_WITH_ENTROPY,
  });
  assert.deepStrictEqual(res.kept, ['skills/foo/SKILL.md'], 'prose .md with entropy run kept');
  assert.deepStrictEqual(res.dropped, [], 'nothing dropped — entropy suppressed for prose');
});

test('U6/#10 a .markdown file with a high-entropy run is also KEPT', () => {
  const res = filterSnapshotSecrets({
    baseDir: '/virtual',
    files: ['skills/foo/GUIDE.markdown'],
    readFileFn: () => PROSE_WITH_ENTROPY,
  });
  assert.deepStrictEqual(res.kept, ['skills/foo/GUIDE.markdown'], '.markdown with entropy run kept');
  assert.deepStrictEqual(res.dropped, [], 'nothing dropped for .markdown prose');
});

test('U6/#10 a PROSE .md with a real PEM is STILL DROPPED (by:content, kind:pem)', () => {
  const res = filterSnapshotSecrets({
    baseDir: '/virtual',
    files: ['skills/foo/leaked.md'],
    readFileFn: () => PROSE_WITH_PEM,
  });
  assert.deepStrictEqual(res.kept, [], 'leaked.md not kept');
  assert.equal(res.dropped.length, 1, 'exactly one drop');
  assert.equal(res.dropped[0].path, 'skills/foo/leaked.md');
  assert.equal(res.dropped[0].by, 'content', 'PEM in prose dropped by content');
  assert.equal(res.dropped[0].kind, 'pem', 'PEM leg still fires for prose');
});

test('U6/#10 a NON-prose config.json with the SAME entropy run STILL DROPS (by:content, kind:entropy)', () => {
  // Falsifiable counterpart: the entropy exemption is prose-scoped, NOT a blanket
  // bypass. The identical run in a .json file is content-sniffed and dropped.
  const res = filterSnapshotSecrets({
    baseDir: '/virtual',
    files: ['config.json'],
    readFileFn: () => `{"key":"${ENTROPY_RUN}"}`,
  });
  assert.deepStrictEqual(res.kept, [], 'config.json not kept');
  assert.equal(res.dropped.length, 1, 'config.json dropped');
  assert.equal(res.dropped[0].by, 'content', 'dropped by content');
  assert.equal(res.dropped[0].kind, 'entropy', 'entropy leg still applies to non-prose');
});

test('U6/#10 a prose .md whose BASENAME matches a secret glob is STILL dropped by:name', () => {
  // The prose exemption only suppresses the ENTROPY leg, not the name matcher.
  // A `*-token*` basename still drops even with benign prose content.
  const res = filterSnapshotSecrets({
    baseDir: '/virtual',
    files: ['skills/foo/refresh-token.md'],
    readFileFn: () => PROSE_WITH_ENTROPY, // benign-by-content prose
  });
  assert.deepStrictEqual(res.kept, [], 'token-named .md not kept');
  assert.equal(res.dropped.length, 1, 'token-named .md dropped');
  assert.equal(res.dropped[0].by, 'name', 'dropped by name matcher, not entropy');
});

test('U6 a per-file read error keeps the file AND warns (never throws)', () => {
  // A benign-named file whose read throws must be KEPT (name matcher said keep,
  // content unavailable) — not dropped, not thrown — AND made visible via a warn
  // so an unreadable-but-archived file is no longer a silent signal.
  const res = filterSnapshotSecrets({
    baseDir: '/virtual',
    files: ['notes.md'],
    readFileFn: () => { throw new Error('EACCES'); },
  });
  assert.deepStrictEqual(res.kept, ['notes.md'], 'unreadable benign file kept');
  assert.deepStrictEqual(res.dropped, [], 'nothing dropped on read error');
  // Falsifiable: pre-fix there was NO such warn. Now exactly one names the file.
  const warns = res.diagnostics.filter((d) => d.code === 'snapshot-file-unreadable');
  assert.equal(warns.length, 1, 'exactly one unreadable warn');
  assert.equal(warns[0].severity, 'warn', 'unreadable diagnostic is warn severity');
  assert.equal(warns[0].path, 'notes.md', 'warn names the unreadable file');
  assert.equal(warns[0].phase, 'snapshot-secrets', 'warn phase tagged');
});

test('U6 a normal readable file emits NO unreadable warn', () => {
  // Counterpart oracle: the warn fires ONLY on a read failure, not on every file.
  const res = filterSnapshotSecrets({
    baseDir: '/virtual',
    files: ['notes.md'],
    readFileFn: () => 'just some benign prose, nothing secret here',
  });
  assert.deepStrictEqual(res.kept, ['notes.md'], 'readable benign file kept');
  const warns = res.diagnostics.filter((d) => d.code === 'snapshot-file-unreadable');
  assert.equal(warns.length, 0, 'no unreadable warn for a readable file');
});

test('U6 one unreadable warn per failing file, none for the readable ones', () => {
  // Two files throw, one reads fine → exactly two warns naming the two failures.
  const res = filterSnapshotSecrets({
    baseDir: '/virtual',
    files: ['a.md', 'b.md', 'c.md'],
    readFileFn: (p) => {
      if (p.endsWith('c.md')) return 'benign prose';
      throw new Error('EACCES');
    },
  });
  assert.deepStrictEqual(res.kept, ['a.md', 'b.md', 'c.md'], 'all three kept');
  const warned = res.diagnostics
    .filter((d) => d.code === 'snapshot-file-unreadable')
    .map((d) => d.path)
    .sort();
  assert.deepStrictEqual(warned, ['a.md', 'b.md'], 'only the two unreadable files warned');
});

test('U6 never throws on bad/empty input', () => {
  assert.deepStrictEqual(
    filterSnapshotSecrets({ baseDir: '/x', files: [] }),
    { kept: [], dropped: [], diagnostics: [] },
    'empty files → empty result',
  );
  // Missing opts entirely.
  const r1 = filterSnapshotSecrets();
  assert.deepStrictEqual(r1.kept, []);
  assert.deepStrictEqual(r1.dropped, []);
  // Junk entries in files are skipped, not thrown on.
  const r2 = filterSnapshotSecrets({ baseDir: '/x', files: ['', null, 42, 'notes.md'], readFileFn: () => '' });
  assert.deepStrictEqual(r2.kept, ['notes.md'], 'only the valid string entry survives');
});
