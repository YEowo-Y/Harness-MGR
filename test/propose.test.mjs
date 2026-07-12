/**
 * P5.U8 — propose.test.mjs (proposeSkill unit tests, hermetic, seam-injected).
 *
 * Drives proposeSkill with INJECTED recorder seams (atomicWriteFn / acquireLockFn /
 * releaseLockFn / mkdirFn / writeFileFn) so NO real lock / governed write / provenance
 * write ever runs, and real mkdtemp temp trees only for the on-disk skill + source
 * reads (validateAndRead's lstat/read). The assertions prove:
 *   - the §4 refusal matrix: each bad arg/name/source/skill refuses with the EXACT
 *     code AND the write/lock seams are NEVER called (dry-run + refusal write nothing);
 *   - dry-run (default) builds the unified diff against GOLDEN sha256 hexes + +/- lines,
 *     emits propose-dry-run, and calls NO write/lock seam;
 *   - no-change: dry-run → ok + propose-no-change warn; --apply → refused propose-no-change;
 *   - provenance shape (POSIX-relative paths, sha equality) + a throwing write seam →
 *     ok:true + propose-provenance-failed + provenanceWritten:false;
 *   - already-exists (lstat seam says the target exists) refuses, no write;
 *   - lock not acquired → propose-lock-failed, no write;
 *   - never-throws on null / throwing-getter opts / non-string name.
 *
 * GOLDEN sha256 hexes (precomputed; pin the engine's hashing + that the original is
 * read for sourceSha256 and --from for proposedSha256):
 *   ORIG bytes "---\nname: foo\n---\nline1\nline2\nline3\n"
 *     → c69df6f7fa3e74eb35b084a4b6f328fbc200cc1fc986e3457193612888ceffcb
 *   PROP bytes "---\nname: foo\n---\nline1\nline2-CHANGED\nline3\nline4-NEW\n"
 *     → 7b2accc7aea9027672ac65a2579c5f7be3f8cddb63fb16137bfca17de785f7a1
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { proposeSkill } from '../src/ops/propose.mjs';

const PASS = (p) => p; // passthrough write gate

const ORIG = '---\nname: foo\n---\nline1\nline2\nline3\n';
const PROP = '---\nname: foo\n---\nline1\nline2-CHANGED\nline3\nline4-NEW\n';
const ORIG_SHA = 'c69df6f7fa3e74eb35b084a4b6f328fbc200cc1fc986e3457193612888ceffcb';
const PROP_SHA = '7b2accc7aea9027672ac65a2579c5f7be3f8cddb63fb16137bfca17de785f7a1';

// A fixed clock so the proposal id is deterministic across runs.
const FIXED = new Date('2026-06-11T12:00:00.000Z');
const fixedNow = () => FIXED;
const PROPOSAL_ID = 'SKILL.proposed-2026-06-11T12-00-00Z.md';

/** Recording write seam (async). Records every call; returns ok by default. */
function makeWrite(result = {}) {
  const calls = [];
  const fn = (opts) => { calls.push(opts); return Promise.resolve({ ok: true, wrote: true, leftovers: { newPath: null, oldPath: null }, diagnostics: [], ...result }); };
  fn.calls = calls;
  return fn;
}
/** Recording acquireLock seam (sync). acquired:true by default. */
function makeAcquire(result = {}) {
  const calls = [];
  const fn = (opts) => { calls.push(opts); return { acquired: true, diagnostics: [], ...result }; };
  fn.calls = calls;
  return fn;
}
/** Recording releaseLock seam. */
function makeRelease() {
  const calls = [];
  const fn = (opts) => { calls.push(opts); return { released: true, diagnostics: [] }; };
  fn.calls = calls;
  return fn;
}
/** Recording mkdir + writeFile seams for provenance. */
function makeProvWriters() {
  const mk = []; const wf = [];
  const mkdirFn = (p) => { mk.push(p); };
  const writeFileFn = (p, c) => { wf.push({ p, c }); };
  mkdirFn.calls = mk; writeFileFn.calls = wf;
  return { mkdirFn, writeFileFn };
}

/** Make a fresh temp ~/.claude-like tree with skills/. */
function makeTree() {
  const tmp = mkdtempSync(join(tmpdir(), 'cmgr-propose-unit-'));
  mkdirSync(join(tmp, 'skills'), { recursive: true });
  return tmp;
}
/** Create skills/<name>/SKILL.md with content; return its path. */
function seedSkill(tmp, name, content) {
  mkdirSync(join(tmp, 'skills', name), { recursive: true });
  const p = join(tmp, 'skills', name, 'SKILL.md');
  writeFileSync(p, content);
  return p;
}
/** Write a --from source file in the tree; return its path. */
function seedFrom(tmp, content) {
  const p = join(tmp, 'proposed-input.md');
  writeFileSync(p, content);
  return p;
}
function codes(res) { return res.diagnostics.map((d) => d.code); }

/** Standard hermetic seam bundle: every write/lock path recorded, nothing real. */
function rec() {
  return {
    atomicWriteFn: makeWrite(),
    acquireLockFn: makeAcquire(),
    releaseLockFn: makeRelease(),
    ...makeProvWriters(),
  };
}
/** Assert NO governed write / lock / provenance happened (refusal + dry-run paths). */
function assertNoWrite(seams) {
  assert.equal(seams.atomicWriteFn.calls.length, 0, 'atomicWriteFn must not be called');
  assert.equal(seams.acquireLockFn.calls.length, 0, 'acquireLockFn must not be called');
  assert.equal(seams.writeFileFn.calls.length, 0, 'provenance writeFileFn must not be called');
}

// ── §4 refusal matrix — exact code, no write/lock ──────────────────────────────

test('refuse missing targetClaudeDir → propose-bad-args', async () => {
  const seams = rec();
  const res = await proposeSkill({ name: 'foo', fromPath: '/x', mgrStateDir: '/s', seams });
  assert.equal(res.ok, false);
  assert.equal(res.refused, true);
  assert.ok(codes(res).includes('propose-bad-args'), codes(res));
  assertNoWrite(seams);
});

test('refuse missing mgrStateDir → propose-bad-args', async () => {
  const seams = rec();
  const res = await proposeSkill({ name: 'foo', fromPath: '/x', targetClaudeDir: '/t', seams });
  assert.equal(res.ok, false);
  assert.ok(codes(res).includes('propose-bad-args'), codes(res));
  assertNoWrite(seams);
});

test('refuse invalid names (traversal/separator/dot/ADS/non-string) → propose-name-invalid', async () => {
  const tmp = makeTree();
  try {
    for (const name of ['../escape', 'a/b', 'a\\b', '.', '..', 'foo:bar', '', 'foo bar']) {
      const seams = rec();
      const res = await proposeSkill({ name, fromPath: '/x', targetClaudeDir: tmp, mgrStateDir: join(tmp, '.mgr-state'), seams });
      assert.equal(res.ok, false, JSON.stringify(name));
      assert.ok(codes(res).includes('propose-name-invalid'), `${JSON.stringify(name)}: ${codes(res)}`);
      assertNoWrite(seams);
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('refuse missing --from → propose-no-source', async () => {
  const tmp = makeTree();
  const seams = rec();
  try {
    const res = await proposeSkill({ name: 'foo', targetClaudeDir: tmp, mgrStateDir: join(tmp, '.mgr-state'), seams });
    assert.equal(res.ok, false);
    assert.ok(codes(res).includes('propose-no-source'), codes(res));
    assertNoWrite(seams);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('refuse unreadable --from (ENOENT) → propose-from-unreadable', async () => {
  const tmp = makeTree();
  const seams = rec();
  try {
    seedSkill(tmp, 'foo', ORIG);
    const res = await proposeSkill({ name: 'foo', fromPath: join(tmp, 'nope.md'), targetClaudeDir: tmp, mgrStateDir: join(tmp, '.mgr-state'), seams });
    assert.equal(res.ok, false);
    assert.ok(codes(res).includes('propose-from-unreadable'), codes(res));
    assertNoWrite(seams);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('refuse --from is a directory (EISDIR) → propose-from-unreadable', async () => {
  const tmp = makeTree();
  const seams = rec();
  try {
    seedSkill(tmp, 'foo', ORIG);
    const dir = join(tmp, 'a-dir');
    mkdirSync(dir, { recursive: true });
    const res = await proposeSkill({ name: 'foo', fromPath: dir, targetClaudeDir: tmp, mgrStateDir: join(tmp, '.mgr-state'), seams });
    assert.equal(res.ok, false);
    assert.ok(codes(res).includes('propose-from-unreadable'), codes(res));
    assertNoWrite(seams);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('refuse skills/<name>/SKILL.md absent → propose-skill-not-found', async () => {
  const tmp = makeTree();
  const seams = rec();
  try {
    const from = seedFrom(tmp, PROP); // valid source, but no skill
    const res = await proposeSkill({ name: 'ghost', fromPath: from, targetClaudeDir: tmp, mgrStateDir: join(tmp, '.mgr-state'), seams });
    assert.equal(res.ok, false);
    assert.ok(codes(res).includes('propose-skill-not-found'), codes(res));
    assertNoWrite(seams);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('refuse skill dir present but SKILL.md absent → propose-skill-not-found', async () => {
  const tmp = makeTree();
  const seams = rec();
  try {
    mkdirSync(join(tmp, 'skills', 'foo'), { recursive: true }); // dir but no SKILL.md
    const from = seedFrom(tmp, PROP);
    const res = await proposeSkill({ name: 'foo', fromPath: from, targetClaudeDir: tmp, mgrStateDir: join(tmp, '.mgr-state'), seams });
    assert.equal(res.ok, false);
    assert.ok(codes(res).includes('propose-skill-not-found'), codes(res));
    assertNoWrite(seams);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('refuse symlinked skill dir → propose-skill-is-symlink (lstat never follows)', async (t) => {
  const tmp = makeTree();
  const seams = rec();
  try {
    mkdirSync(join(tmp, 'skills', 'real-foo'), { recursive: true });
    writeFileSync(join(tmp, 'skills', 'real-foo', 'SKILL.md'), ORIG);
    try { symlinkSync(join(tmp, 'skills', 'real-foo'), join(tmp, 'skills', 'foo')); }
    catch (e) { t.skip(`symlink creation failed (${e.code ?? e.message})`); return; }
    const from = seedFrom(tmp, PROP);
    const res = await proposeSkill({ name: 'foo', fromPath: from, targetClaudeDir: tmp, mgrStateDir: join(tmp, '.mgr-state'), seams });
    assert.equal(res.ok, false);
    assert.ok(codes(res).includes('propose-skill-is-symlink'), codes(res));
    assertNoWrite(seams);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('refuse symlinked SKILL.md → propose-skill-is-symlink (lstat never follows)', async (t) => {
  const tmp = makeTree();
  const seams = rec();
  try {
    mkdirSync(join(tmp, 'skills', 'foo'), { recursive: true });
    writeFileSync(join(tmp, 'real-skill.md'), ORIG);
    try { symlinkSync(join(tmp, 'real-skill.md'), join(tmp, 'skills', 'foo', 'SKILL.md')); }
    catch (e) { t.skip(`symlink creation failed (${e.code ?? e.message})`); return; }
    const from = seedFrom(tmp, PROP);
    const res = await proposeSkill({ name: 'foo', fromPath: from, targetClaudeDir: tmp, mgrStateDir: join(tmp, '.mgr-state'), seams });
    assert.equal(res.ok, false);
    assert.ok(codes(res).includes('propose-skill-is-symlink'), codes(res));
    assertNoWrite(seams);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('refuse unreadable SKILL.md → propose-skill-unreadable (via throwing readFileFn for SKILL.md only)', async () => {
  const tmp = makeTree();
  try {
    const skillPath = seedSkill(tmp, 'foo', ORIG);
    const from = seedFrom(tmp, PROP);
    const seams = rec();
    // readFileFn throws only for the SKILL.md path; the --from read succeeds.
    seams.readFileFn = (p) => {
      if (p === skillPath || String(p).endsWith('SKILL.md')) { const e = new Error('EACCES'); e.code = 'EACCES'; throw e; }
      return Buffer.from(PROP);
    };
    const res = await proposeSkill({ name: 'foo', fromPath: from, targetClaudeDir: tmp, mgrStateDir: join(tmp, '.mgr-state'), seams });
    assert.equal(res.ok, false);
    assert.ok(codes(res).includes('propose-skill-unreadable'), codes(res));
    assertNoWrite(seams);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

// ── dry-run golden ─────────────────────────────────────────────────────────────

test('dry-run: golden sha256 + unified +/- lines + propose-dry-run, NO write/lock', async () => {
  const tmp = makeTree();
  const seams = rec();
  try {
    const skillPath = seedSkill(tmp, 'foo', ORIG);
    const from = seedFrom(tmp, PROP);
    const res = await proposeSkill({
      name: 'foo', fromPath: from, targetClaudeDir: tmp, mgrStateDir: join(tmp, '.mgr-state'),
      now: fixedNow, seams,
    });
    assert.equal(res.ok, true);
    assert.equal(res.dryRun, true);
    assert.equal(res.refused, false);
    assert.equal(res.changed, true);
    assert.equal(res.name, 'foo');
    assert.equal(res.skillPath, skillPath);
    assert.equal(res.proposalId, PROPOSAL_ID);
    assert.ok(res.target.endsWith(join('skills', 'foo', PROPOSAL_ID)), res.target);
    assert.equal(res.sourceSha256, ORIG_SHA);
    assert.equal(res.proposedSha256, PROP_SHA);
    assert.deepEqual(res.stats, { added: 2, deleted: 1, unchanged: 6 });
    assert.match(res.unified, /^--- skills\/foo\/SKILL\.md$/m);
    assert.match(res.unified, new RegExp('^\\+\\+\\+ ' + PROPOSAL_ID.replace(/\./g, '\\.') + '$', 'm'));
    assert.ok(res.unified.includes('\n-line2\n'), res.unified);
    assert.ok(res.unified.includes('\n+line2-CHANGED\n'), res.unified);
    assert.ok(res.unified.includes('\n+line4-NEW'), res.unified);
    assert.ok(codes(res).includes('propose-dry-run'), codes(res));
    assertNoWrite(seams);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('dry-run: a secret in the proposed SKILL.md is redacted in the unified diff (not leaked)', async () => {
  const tmp = makeTree();
  const seams = rec();
  const SECRET = 'hunter2SuperSecretPw';
  try {
    seedSkill(tmp, 'foo', '---\nname: foo\n---\nline1\n');
    const from = seedFrom(tmp, `---\nname: foo\n---\nline1\ndb: postgres://admin:${SECRET}@db.example.com/prod\n`);
    const res = await proposeSkill({
      name: 'foo', fromPath: from, targetClaudeDir: tmp, mgrStateDir: join(tmp, '.mgr-state'), now: fixedNow, seams,
    });
    assert.equal(res.ok, true);
    assert.equal(res.changed, true);
    assert.ok(!res.unified.includes(SECRET), `the proposed diff must not leak the secret, got:\n${res.unified}`);
    assert.ok(res.unified.includes('<redacted>'), `the proposed diff should show <redacted>, got:\n${res.unified}`);
    assertNoWrite(seams);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('dry-run: a secret-only rotation remains changed and never reports byte-identical', async () => {
  const tmp = makeTree();
  const seams = rec();
  const oldSecret = 'oldProposeSecret123';
  const newSecret = 'newProposeSecret456';
  try {
    seedSkill(tmp, 'foo', `---\nname: foo\n---\ndb: postgres://admin:${oldSecret}@db.example.com/prod\n`);
    const from = seedFrom(tmp, `---\nname: foo\n---\ndb: postgres://admin:${newSecret}@db.example.com/prod\n`);
    const res = await proposeSkill({
      name: 'foo', fromPath: from, targetClaudeDir: tmp, mgrStateDir: join(tmp, '.mgr-state'),
      now: fixedNow, seams,
    });
    assert.equal(res.ok, true);
    assert.equal(res.dryRun, true);
    assert.equal(res.changed, true);
    assert.notEqual(res.sourceSha256, res.proposedSha256);
    assert.deepEqual(res.stats, { added: 1, deleted: 1, unchanged: 4 });
    assert.ok(codes(res).includes('propose-dry-run'), codes(res));
    assert.ok(!codes(res).includes('propose-no-change'), codes(res));
    assert.ok(!res.unified.includes(oldSecret), res.unified);
    assert.ok(!res.unified.includes(newSecret), res.unified);
    assert.match(res.unified, /^-db: postgres:\/\/<redacted>@db\.example\.com\/prod$/m);
    assert.match(res.unified, /^\+db: postgres:\/\/<redacted>@db\.example\.com\/prod$/m);
    assertNoWrite(seams);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('dry-run: a line-ending-only byte change remains changed even when line stats are equal', async () => {
  const tmp = makeTree();
  const seams = rec();
  const lf = '---\nname: foo\n---\nbody\n';
  const crlf = lf.replace(/\n/g, '\r\n');
  try {
    seedSkill(tmp, 'foo', lf);
    const from = seedFrom(tmp, crlf);
    const res = await proposeSkill({
      name: 'foo', fromPath: from, targetClaudeDir: tmp, mgrStateDir: join(tmp, '.mgr-state'),
      now: fixedNow, seams,
    });
    assert.equal(res.ok, true);
    assert.equal(res.dryRun, true);
    assert.equal(res.changed, true);
    assert.notEqual(res.sourceSha256, res.proposedSha256);
    assert.deepEqual(res.stats, { added: 0, deleted: 0, unchanged: 5 });
    assert.ok(codes(res).includes('propose-dry-run'), codes(res));
    assert.ok(!codes(res).includes('propose-no-change'), codes(res));
    assertNoWrite(seams);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

// ── no-change ────────────────────────────────────────────────────────────────

test('no-change dry-run: ok:true + changed:false + propose-no-change warn, NO write', async () => {
  const tmp = makeTree();
  const seams = rec();
  try {
    seedSkill(tmp, 'foo', ORIG);
    const from = seedFrom(tmp, ORIG); // identical bytes
    const res = await proposeSkill({ name: 'foo', fromPath: from, targetClaudeDir: tmp, mgrStateDir: join(tmp, '.mgr-state'), now: fixedNow, seams });
    assert.equal(res.ok, true);
    assert.equal(res.dryRun, true);
    assert.equal(res.changed, false);
    assert.ok(codes(res).includes('propose-no-change'), codes(res));
    assertNoWrite(seams);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('no-change --apply: refused propose-no-change, the proposal write seam is NOT called', async () => {
  const tmp = makeTree();
  const seams = rec();
  try {
    seedSkill(tmp, 'foo', ORIG);
    const from = seedFrom(tmp, ORIG);
    const res = await proposeSkill({
      name: 'foo', fromPath: from, targetClaudeDir: tmp, mgrStateDir: join(tmp, '.mgr-state'),
      assertWritable: PASS, enableWrites: true, now: fixedNow, seams,
    });
    assert.equal(res.ok, false);
    assert.equal(res.refused, true);
    assert.ok(codes(res).includes('propose-no-change'), codes(res));
    // the lock WAS taken (re-read happens under the lock) but the proposal write never happened.
    assert.equal(seams.atomicWriteFn.calls.length, 0, 'no proposal write on no-change');
    assert.equal(seams.acquireLockFn.calls.length, 1, 'lock acquired before the apply-time re-check');
    assert.equal(seams.releaseLockFn.calls.length, 1, 'lock released in finally');
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

// ── apply success + provenance ─────────────────────────────────────────────────

test('--apply: writes the proposal via the gate context propose; provenance shape + sha equality', async () => {
  const tmp = makeTree();
  const seams = rec();
  try {
    seedSkill(tmp, 'foo', ORIG);
    const from = seedFrom(tmp, PROP);
    const res = await proposeSkill({
      name: 'foo', fromPath: from, targetClaudeDir: tmp, mgrStateDir: join(tmp, '.mgr-state'),
      assertWritable: PASS, enableWrites: true, reason: 'tighten wording', pid: 4242, now: fixedNow, seams,
    });
    assert.equal(res.ok, true);
    assert.equal(res.dryRun, false);
    assert.equal(res.refused, false);
    assert.equal(res.provenanceWritten, true);
    assert.ok(res.provenancePath.endsWith(join('proposals', 'foo-2026-06-11T12-00-00Z.json')), res.provenancePath);
    assert.deepEqual(res.lock, { acquired: true });
    // the ONE governed write: target = the .proposed leaf, content = PROP buffer, context 'propose'.
    assert.equal(seams.atomicWriteFn.calls.length, 1);
    const w = seams.atomicWriteFn.calls[0];
    assert.equal(w.context, 'propose');
    assert.equal(w.assertWritable, PASS);
    assert.ok(w.target.endsWith(join('skills', 'foo', PROPOSAL_ID)), w.target);
    assert.ok(Buffer.isBuffer(w.content), 'content must be a Buffer (binary-safe)');
    assert.equal(w.content.toString('utf8'), PROP);
    // lock with the supplied pid + released with the SAME pid.
    assert.equal(seams.acquireLockFn.calls[0].pid, 4242);
    assert.equal(seams.releaseLockFn.calls[0].pid, 4242);
    // provenance record: shape + POSIX-relative paths + sha equality.
    assert.equal(seams.writeFileFn.calls.length, 1);
    const rec0 = JSON.parse(seams.writeFileFn.calls[0].c);
    assert.equal(rec0.proposalVersion, 1);
    assert.equal(rec0.kind, 'skill');
    assert.equal(rec0.name, 'foo');
    assert.equal(rec0.proposalFile, PROPOSAL_ID);
    assert.equal(rec0.proposalPath, 'skills/foo/' + PROPOSAL_ID);
    assert.equal(rec0.sourcePath, 'skills/foo/SKILL.md');
    assert.equal(rec0.sourceSha256, ORIG_SHA);
    assert.equal(rec0.proposedSha256, PROP_SHA);
    assert.equal(rec0.reason, 'tighten wording');
    assert.equal(rec0.createdAt, FIXED.toISOString());
    // the result's sha matches the record (the diff was made vs the re-read original).
    assert.equal(res.sourceSha256, rec0.sourceSha256);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('--apply: provenance write seam throws → ok:true + propose-provenance-failed + provenanceWritten:false', async () => {
  const tmp = makeTree();
  const seams = rec();
  try {
    seedSkill(tmp, 'foo', ORIG);
    const from = seedFrom(tmp, PROP);
    seams.writeFileFn = (p) => { void p; throw new Error('disk full'); };
    seams.writeFileFn.calls = [];
    const res = await proposeSkill({
      name: 'foo', fromPath: from, targetClaudeDir: tmp, mgrStateDir: join(tmp, '.mgr-state'),
      assertWritable: PASS, enableWrites: true, now: fixedNow, seams,
    });
    assert.equal(res.ok, true, 'a provenance failure must NOT flip the landed proposal to failed');
    assert.equal(res.provenanceWritten, false);
    assert.ok(codes(res).includes('propose-provenance-failed'), codes(res));
    // the proposal itself WAS written.
    assert.equal(seams.atomicWriteFn.calls.length, 1);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

// ── already-exists / lock-failed / write-failed ─────────────────────────────────

test('--apply: target already exists (lstat seam) → propose-already-exists, NO write', async () => {
  const tmp = makeTree();
  const seams = rec();
  try {
    seedSkill(tmp, 'foo', ORIG);
    const from = seedFrom(tmp, PROP);
    // lstat: SKILL.md/skill-dir present (delegate to real), but the proposed target "exists" too.
    const realLstat = (await import('node:fs')).lstatSync;
    seams.lstatFn = (p) => {
      if (String(p).endsWith(PROPOSAL_ID)) return { isSymbolicLink: () => false, isFile: () => true, isDirectory: () => false };
      return realLstat(p);
    };
    const res = await proposeSkill({
      name: 'foo', fromPath: from, targetClaudeDir: tmp, mgrStateDir: join(tmp, '.mgr-state'),
      assertWritable: PASS, enableWrites: true, now: fixedNow, seams,
    });
    assert.equal(res.ok, false);
    assert.equal(res.refused, true);
    assert.ok(codes(res).includes('propose-already-exists'), codes(res));
    assert.equal(seams.atomicWriteFn.calls.length, 0, 'must never overwrite an existing proposal');
    assert.equal(seams.releaseLockFn.calls.length, 1, 'lock released in finally');
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('--apply: lock not acquired → propose-lock-failed, NO write', async () => {
  const tmp = makeTree();
  const seams = rec();
  try {
    seedSkill(tmp, 'foo', ORIG);
    const from = seedFrom(tmp, PROP);
    seams.acquireLockFn = makeAcquire({ acquired: false, reason: 'held' });
    const res = await proposeSkill({
      name: 'foo', fromPath: from, targetClaudeDir: tmp, mgrStateDir: join(tmp, '.mgr-state'),
      assertWritable: PASS, enableWrites: true, now: fixedNow, seams,
    });
    assert.equal(res.ok, false);
    assert.equal(res.refused, true);
    assert.ok(codes(res).includes('propose-lock-failed'), codes(res));
    assert.deepEqual(res.lock, { acquired: false, reason: 'held' });
    assert.equal(seams.atomicWriteFn.calls.length, 0, 'no write when the lock is held');
    assert.equal(seams.releaseLockFn.calls.length, 0, 'never release a lock we did not acquire');
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('--apply: atomic write fails → ok:false (surfaces the primitive diagnostics), lock released', async () => {
  const tmp = makeTree();
  const seams = rec();
  try {
    seedSkill(tmp, 'foo', ORIG);
    const from = seedFrom(tmp, PROP);
    seams.atomicWriteFn = makeWrite({ ok: false, wrote: false, diagnostics: [{ severity: 'error', code: 'apply-write-gate-denied', message: 'denied', phase: 'apply' }] });
    const res = await proposeSkill({
      name: 'foo', fromPath: from, targetClaudeDir: tmp, mgrStateDir: join(tmp, '.mgr-state'),
      assertWritable: PASS, enableWrites: true, now: fixedNow, seams,
    });
    assert.equal(res.ok, false);
    assert.ok(codes(res).includes('propose-write-failed'), codes(res));
    assert.ok(codes(res).includes('apply-write-gate-denied'), 'primitive diagnostics surfaced');
    assert.equal(seams.releaseLockFn.calls.length, 1, 'lock released in finally even on write failure');
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('--apply: missing assertWritable → refused propose-bad-args, NO lock/write', async () => {
  const tmp = makeTree();
  const seams = rec();
  try {
    seedSkill(tmp, 'foo', ORIG);
    const from = seedFrom(tmp, PROP);
    const res = await proposeSkill({
      name: 'foo', fromPath: from, targetClaudeDir: tmp, mgrStateDir: join(tmp, '.mgr-state'),
      enableWrites: true, now: fixedNow, seams, // no assertWritable
    });
    assert.equal(res.ok, false);
    assert.equal(res.refused, true);
    assert.ok(codes(res).includes('propose-bad-args'), codes(res));
    assert.equal(seams.acquireLockFn.calls.length, 0);
    assert.equal(seams.atomicWriteFn.calls.length, 0);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

// ── never-throws ────────────────────────────────────────────────────────────────

test('never-throws: proposeSkill(null) → full-shape ok:false', async () => {
  const res = await proposeSkill(null);
  assert.equal(typeof res, 'object');
  assert.equal(res.ok, false);
  assert.ok(Array.isArray(res.diagnostics));
  assert.equal(res.target, null);
  assert.equal(res.lock, null);
  assert.equal(res.provenanceWritten, false);
});

test('never-throws: proposeSkill(undefined) → full-shape ok:false', async () => {
  const res = await proposeSkill(undefined);
  assert.equal(res.ok, false);
  assert.ok(res.diagnostics.length > 0);
});

test('never-throws: throwing-getter opts → ok:false, no crash', async () => {
  const hostile = {};
  Object.defineProperty(hostile, 'name', { get() { throw new Error('boom'); } });
  const res = await proposeSkill(hostile);
  assert.equal(res.ok, false);
  assert.ok(Array.isArray(res.diagnostics));
  assert.ok(res.diagnostics.length > 0);
});

test('never-throws: non-string name (number/object) → propose-name-invalid (validated, not thrown)', async () => {
  const tmp = makeTree();
  try {
    for (const name of [42, {}, [], true]) {
      const seams = rec();
      const res = await proposeSkill({ name, fromPath: '/x', targetClaudeDir: tmp, mgrStateDir: join(tmp, '.mgr-state'), seams });
      assert.equal(res.ok, false, String(name));
      assert.ok(codes(res).includes('propose-name-invalid'), `${String(name)}: ${codes(res)}`);
      assertNoWrite(seams);
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
