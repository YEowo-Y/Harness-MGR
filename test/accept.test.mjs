/**
 * P5.U9 — accept.test.mjs (acceptProposal unit tests, hermetic, seam-injected).
 *
 * Drives acceptProposal with INJECTED recorder seams (snapshotFn / manifestCheckFn /
 * atomicWriteFn / atomicDeleteFn / acquireLockFn / releaseLockFn / unlinkFn) plus
 * real-fs reads (lstat/readdir/readFile) over mkdtemp temp trees, so NO real
 * snapshot / governed write / delete / lock ever runs. The assertions prove:
 *   - the §4 refusal matrix: each condition refuses with the EXACT code AND the
 *     write/lock/snapshot seams are NEVER called (refusal + dry-run write nothing);
 *   - selection: explicit id (full leaf + bare ts), absent+1, absent+0, absent+>1;
 *   - stale guard: matching sha proceeds; mismatch → accept-stale (apply) /
 *     preview stale:true (dry-run); missing provenance → accept-no-provenance (apply)
 *     unless --force;
 *   - apply happy path: snapshot → manifest check → atomicApplyWrite(context:'accept',
 *     the proposed buffer) → atomicApplyDelete(context:'accept') → provenance unlink;
 *   - snapshot fail / manifest-miss: atomicApplyWrite NEVER called;
 *   - cleanup best-effort: delete fail → ok stays true + warn;
 *   - lock not acquired → accept-lock-failed, no snapshot/write;
 *   - never-throws on null / throwing-getter opts / non-string name.
 *
 * GOLDEN sha256 hexes (pin the engine's hashing of SKILL.md + the proposal):
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
import { acceptProposal } from '../src/ops/accept.mjs';

const PASS = (p) => p; // passthrough write gate

const ORIG = '---\nname: foo\n---\nline1\nline2\nline3\n';
const PROP = '---\nname: foo\n---\nline1\nline2-CHANGED\nline3\nline4-NEW\n';
const ORIG_SHA = 'c69df6f7fa3e74eb35b084a4b6f328fbc200cc1fc986e3457193612888ceffcb';
const PROP_SHA = '7b2accc7aea9027672ac65a2579c5f7be3f8cddb63fb16137bfca17de785f7a1';

const TS = '2026-06-11T12-00-00Z';
const PROPOSAL_ID = 'SKILL.proposed-' + TS + '.md';
const TS2 = '2026-06-12T08-30-00Z';
const PROPOSAL_ID2 = 'SKILL.proposed-' + TS2 + '.md';

// ── recorder seams ──────────────────────────────────────────────────────────────

function makeSnapshot(result = {}) {
  const calls = [];
  const fn = (opts) => { calls.push(opts); return Promise.resolve({ ok: true, snapshotId: TS, manifestPath: '/snap/manifest.json', diagnostics: [], ...result }); };
  fn.calls = calls;
  return fn;
}
function makeManifestCheck(result = { ok: true }) {
  const calls = [];
  const fn = (plan, snap, dir, readFn, bag) => { calls.push({ plan, snap, dir }); return result; };
  fn.calls = calls;
  return fn;
}
function makeWrite(result = {}) {
  const calls = [];
  const fn = (opts) => { calls.push(opts); return Promise.resolve({ ok: true, wrote: true, leftovers: { newPath: null, oldPath: null }, diagnostics: [], ...result }); };
  fn.calls = calls;
  return fn;
}
function makeDelete(result = {}) {
  const calls = [];
  const fn = (opts) => { calls.push(opts); return Promise.resolve({ ok: true, deleted: true, leftovers: { oldPath: null }, diagnostics: [], ...result }); };
  fn.calls = calls;
  return fn;
}
function makeAcquire(result = {}) {
  const calls = [];
  const fn = (opts) => { calls.push(opts); return { acquired: true, diagnostics: [], ...result }; };
  fn.calls = calls;
  return fn;
}
function makeRelease() {
  const calls = [];
  const fn = (opts) => { calls.push(opts); return { released: true, diagnostics: [] }; };
  fn.calls = calls;
  return fn;
}
function makeUnlink(throws = false) {
  const calls = [];
  const fn = (p) => { calls.push(p); if (throws) throw new Error('unlink boom'); };
  fn.calls = calls;
  return fn;
}

/** Standard hermetic seam bundle: every write/lock/snapshot path recorded, nothing real. */
function rec() {
  return {
    snapshotFn: makeSnapshot(),
    manifestCheckFn: makeManifestCheck(),
    atomicWriteFn: makeWrite(),
    atomicDeleteFn: makeDelete(),
    acquireLockFn: makeAcquire(),
    releaseLockFn: makeRelease(),
    unlinkFn: makeUnlink(),
  };
}
function assertNoWrite(seams) {
  assert.equal(seams.snapshotFn.calls.length, 0, 'snapshotFn must not be called');
  assert.equal(seams.atomicWriteFn.calls.length, 0, 'atomicWriteFn must not be called');
  assert.equal(seams.atomicDeleteFn.calls.length, 0, 'atomicDeleteFn must not be called');
  assert.equal(seams.acquireLockFn.calls.length, 0, 'acquireLockFn must not be called');
}
function codes(res) { return res.diagnostics.map((d) => d.code); }

// ── temp tree helpers ─────────────────────────────────────────────────────────

function makeTree() {
  const tmp = mkdtempSync(join(tmpdir(), 'cmgr-accept-unit-'));
  mkdirSync(join(tmp, 'skills'), { recursive: true });
  return tmp;
}
function seedSkill(tmp, name, content) {
  mkdirSync(join(tmp, 'skills', name), { recursive: true });
  if (content !== null) writeFileSync(join(tmp, 'skills', name, 'SKILL.md'), content);
  return join(tmp, 'skills', name, 'SKILL.md');
}
function seedProposal(tmp, name, ts, content) {
  mkdirSync(join(tmp, 'skills', name), { recursive: true });
  const p = join(tmp, 'skills', name, 'SKILL.proposed-' + ts + '.md');
  writeFileSync(p, content);
  return p;
}
/** Write a provenance record at .mgr-state/proposals/<name>-<ts>.json. */
function seedProvenance(tmp, name, ts, sourceSha256) {
  const dir = join(tmp, '.mgr-state', 'proposals');
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name + '-' + ts + '.json');
  writeFileSync(p, JSON.stringify({ proposalVersion: 1, kind: 'skill', name, sourceSha256 }) + '\n');
  return p;
}
function mgrState(tmp) { return join(tmp, '.mgr-state'); }

// ══ §4 refusal matrix — exact code, no write/lock ══════════════════════════════

test('refuse missing targetClaudeDir → accept-bad-args', async () => {
  const seams = rec();
  const res = await acceptProposal({ name: 'foo', mgrStateDir: '/s', seams });
  assert.equal(res.ok, false);
  assert.equal(res.refused, true);
  assert.ok(codes(res).includes('accept-bad-args'), codes(res));
  assertNoWrite(seams);
});

test('refuse missing mgrStateDir → accept-bad-args', async () => {
  const seams = rec();
  const res = await acceptProposal({ name: 'foo', targetClaudeDir: '/t', seams });
  assert.equal(res.ok, false);
  assert.ok(codes(res).includes('accept-bad-args'), codes(res));
  assertNoWrite(seams);
});

test('refuse invalid names → accept-name-invalid, no write (both paths)', async () => {
  const tmp = makeTree();
  try {
    for (const name of ['../escape', 'a/b', 'a\\b', '.', '..', 'foo:bar', '', 'foo bar']) {
      const seams = rec();
      const res = await acceptProposal({ name, targetClaudeDir: tmp, mgrStateDir: mgrState(tmp), seams });
      assert.equal(res.ok, false, JSON.stringify(name));
      assert.ok(codes(res).includes('accept-name-invalid'), `${JSON.stringify(name)}: ${codes(res)}`);
      assertNoWrite(seams);
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('refuse no proposal present → accept-no-proposal (no id, zero proposals)', async () => {
  const tmp = makeTree();
  const seams = rec();
  try {
    seedSkill(tmp, 'foo', ORIG); // SKILL.md but no proposals
    const res = await acceptProposal({ name: 'foo', targetClaudeDir: tmp, mgrStateDir: mgrState(tmp), seams });
    assert.equal(res.ok, false);
    assert.ok(codes(res).includes('accept-no-proposal'), codes(res));
    assertNoWrite(seams);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('refuse missing skill dir → accept-no-proposal', async () => {
  const tmp = makeTree();
  const seams = rec();
  try {
    const res = await acceptProposal({ name: 'ghost', targetClaudeDir: tmp, mgrStateDir: mgrState(tmp), seams });
    assert.equal(res.ok, false);
    assert.ok(codes(res).includes('accept-no-proposal'), codes(res));
    assertNoWrite(seams);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('refuse ambiguous (>1 proposal, no id) → accept-ambiguous LISTING both ids, no write', async () => {
  const tmp = makeTree();
  const seams = rec();
  try {
    seedSkill(tmp, 'foo', ORIG);
    seedProposal(tmp, 'foo', TS, PROP);
    seedProposal(tmp, 'foo', TS2, PROP);
    const res = await acceptProposal({ name: 'foo', targetClaudeDir: tmp, mgrStateDir: mgrState(tmp), seams });
    assert.equal(res.ok, false);
    assert.ok(codes(res).includes('accept-ambiguous'), codes(res));
    const msg = res.diagnostics.find((d) => d.code === 'accept-ambiguous').message;
    assert.ok(msg.includes(PROPOSAL_ID), `message must list ${PROPOSAL_ID}: ${msg}`);
    assert.ok(msg.includes(PROPOSAL_ID2), `message must list ${PROPOSAL_ID2}: ${msg}`);
    assertNoWrite(seams);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('refuse explicit id resolves to a missing file → accept-proposal-not-found', async () => {
  const tmp = makeTree();
  const seams = rec();
  try {
    seedSkill(tmp, 'foo', ORIG); // no proposal seeded
    const res = await acceptProposal({ name: 'foo', proposalId: TS, targetClaudeDir: tmp, mgrStateDir: mgrState(tmp), seams });
    assert.equal(res.ok, false);
    assert.ok(codes(res).includes('accept-proposal-not-found'), codes(res));
    assertNoWrite(seams);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('refuse explicit id is not a recognizable proposal id → accept-proposal-not-found', async () => {
  const tmp = makeTree();
  const seams = rec();
  try {
    seedSkill(tmp, 'foo', ORIG);
    seedProposal(tmp, 'foo', TS, PROP);
    const res = await acceptProposal({ name: 'foo', proposalId: 'garbage', targetClaudeDir: tmp, mgrStateDir: mgrState(tmp), seams });
    assert.equal(res.ok, false);
    assert.ok(codes(res).includes('accept-proposal-not-found'), codes(res));
    assertNoWrite(seams);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('refuse proposal unreadable → accept-proposal-unreadable (throwing readFileFn for the proposal)', async () => {
  const tmp = makeTree();
  try {
    seedSkill(tmp, 'foo', ORIG);
    const propPath = seedProposal(tmp, 'foo', TS, PROP);
    const seams = rec();
    const { readFileSync: realRead } = await import('node:fs');
    seams.readFileFn = (p) => {
      if (p === propPath) { const e = new Error('EACCES'); e.code = 'EACCES'; throw e; }
      return realRead(p);
    };
    const res = await acceptProposal({ name: 'foo', proposalId: TS, targetClaudeDir: tmp, mgrStateDir: mgrState(tmp), seams });
    assert.equal(res.ok, false);
    assert.ok(codes(res).includes('accept-proposal-unreadable'), codes(res));
    assertNoWrite(seams);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('refuse symlinked skill dir → accept-skill-is-symlink (lstat never follows)', async (t) => {
  const tmp = makeTree();
  const seams = rec();
  try {
    mkdirSync(join(tmp, 'skills', 'real-foo'), { recursive: true });
    writeFileSync(join(tmp, 'skills', 'real-foo', 'SKILL.md'), ORIG);
    try { symlinkSync(join(tmp, 'skills', 'real-foo'), join(tmp, 'skills', 'foo')); }
    catch (e) { t.skip(`symlink creation failed (${e.code ?? e.message})`); return; }
    const res = await acceptProposal({ name: 'foo', targetClaudeDir: tmp, mgrStateDir: mgrState(tmp), seams });
    assert.equal(res.ok, false);
    assert.ok(codes(res).includes('accept-skill-is-symlink'), codes(res));
    assertNoWrite(seams);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('refuse symlinked SKILL.md → accept-skill-is-symlink', async (t) => {
  const tmp = makeTree();
  const seams = rec();
  try {
    mkdirSync(join(tmp, 'skills', 'foo'), { recursive: true });
    seedProposal(tmp, 'foo', TS, PROP);
    writeFileSync(join(tmp, 'real-skill.md'), ORIG);
    try { symlinkSync(join(tmp, 'real-skill.md'), join(tmp, 'skills', 'foo', 'SKILL.md')); }
    catch (e) { t.skip(`symlink creation failed (${e.code ?? e.message})`); return; }
    const res = await acceptProposal({ name: 'foo', proposalId: TS, targetClaudeDir: tmp, mgrStateDir: mgrState(tmp), seams });
    assert.equal(res.ok, false);
    assert.ok(codes(res).includes('accept-skill-is-symlink'), codes(res));
    assertNoWrite(seams);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('refuse symlinked proposal → accept-skill-is-symlink', async (t) => {
  const tmp = makeTree();
  const seams = rec();
  try {
    seedSkill(tmp, 'foo', ORIG);
    writeFileSync(join(tmp, 'real-prop.md'), PROP);
    try { symlinkSync(join(tmp, 'real-prop.md'), join(tmp, 'skills', 'foo', PROPOSAL_ID)); }
    catch (e) { t.skip(`symlink creation failed (${e.code ?? e.message})`); return; }
    const res = await acceptProposal({ name: 'foo', proposalId: TS, targetClaudeDir: tmp, mgrStateDir: mgrState(tmp), seams });
    assert.equal(res.ok, false);
    assert.ok(codes(res).includes('accept-skill-is-symlink'), codes(res));
    assertNoWrite(seams);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

// ══ selection ═══════════════════════════════════════════════════════════════════

test('selection: explicit FULL-LEAF id resolves; absent+1 fallback resolves; bare ts resolves', async () => {
  const tmp = makeTree();
  try {
    seedSkill(tmp, 'foo', ORIG);
    seedProposal(tmp, 'foo', TS, PROP);
    seedProvenance(tmp, 'foo', TS, ORIG_SHA);
    // full leaf
    let res = await acceptProposal({ name: 'foo', proposalId: PROPOSAL_ID, targetClaudeDir: tmp, mgrStateDir: mgrState(tmp), seams: rec() });
    assert.equal(res.ok, true, codes(res));
    assert.equal(res.proposalId, PROPOSAL_ID);
    assert.equal(res.stale, false);
    // bare ts
    res = await acceptProposal({ name: 'foo', proposalId: TS, targetClaudeDir: tmp, mgrStateDir: mgrState(tmp), seams: rec() });
    assert.equal(res.ok, true, codes(res));
    assert.equal(res.proposalId, PROPOSAL_ID);
    // absent + exactly one
    res = await acceptProposal({ name: 'foo', targetClaudeDir: tmp, mgrStateDir: mgrState(tmp), seams: rec() });
    assert.equal(res.ok, true, codes(res));
    assert.equal(res.proposalId, PROPOSAL_ID);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

// ══ stale guard ═════════════════════════════════════════════════════════════════

test('stale guard: matching sourceSha256 → dry-run ok, stale:false, provenanceFound:true', async () => {
  const tmp = makeTree();
  const seams = rec();
  try {
    seedSkill(tmp, 'foo', ORIG);
    seedProposal(tmp, 'foo', TS, PROP);
    seedProvenance(tmp, 'foo', TS, ORIG_SHA);
    const res = await acceptProposal({ name: 'foo', proposalId: TS, targetClaudeDir: tmp, mgrStateDir: mgrState(tmp), seams });
    assert.equal(res.ok, true);
    assert.equal(res.dryRun, true);
    assert.equal(res.stale, false);
    assert.equal(res.provenanceFound, true);
    assert.equal(res.sourceSha256, ORIG_SHA);
    assert.equal(res.proposedSha256, PROP_SHA);
    assert.ok(codes(res).includes('accept-dry-run'), codes(res));
    assertNoWrite(seams);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('stale guard: mismatch → dry-run PREVIEWS stale:true (does NOT refuse)', async () => {
  const tmp = makeTree();
  const seams = rec();
  try {
    seedSkill(tmp, 'foo', PROP); // SKILL.md drifted (now == PROP, not ORIG)
    seedProposal(tmp, 'foo', TS, PROP);
    seedProvenance(tmp, 'foo', TS, ORIG_SHA); // record says source was ORIG
    const res = await acceptProposal({ name: 'foo', proposalId: TS, targetClaudeDir: tmp, mgrStateDir: mgrState(tmp), seams });
    assert.equal(res.ok, true, 'dry-run must not refuse on stale');
    assert.equal(res.dryRun, true);
    assert.equal(res.stale, true);
    assert.equal(res.provenanceFound, true);
    assert.ok(codes(res).includes('accept-dry-run'), codes(res));
    assertNoWrite(seams);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('stale guard: mismatch → --apply WITHOUT --force refuses accept-stale, NOTHING written', async () => {
  const tmp = makeTree();
  const seams = rec();
  try {
    seedSkill(tmp, 'foo', PROP);
    seedProposal(tmp, 'foo', TS, PROP);
    seedProvenance(tmp, 'foo', TS, ORIG_SHA);
    const res = await acceptProposal({ name: 'foo', proposalId: TS, targetClaudeDir: tmp, mgrStateDir: mgrState(tmp),
      assertWritable: PASS, enableWrites: true, seams });
    assert.equal(res.ok, false);
    assert.equal(res.refused, true);
    assert.equal(res.stale, true);
    assert.ok(codes(res).includes('accept-stale'), codes(res));
    assertNoWrite(seams);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('stale guard: mismatch → --apply WITH --force proceeds (snapshot + write happen)', async () => {
  const tmp = makeTree();
  const seams = rec();
  try {
    seedSkill(tmp, 'foo', PROP);
    seedProposal(tmp, 'foo', TS, PROP);
    seedProvenance(tmp, 'foo', TS, ORIG_SHA);
    const res = await acceptProposal({ name: 'foo', proposalId: TS, targetClaudeDir: tmp, mgrStateDir: mgrState(tmp),
      assertWritable: PASS, enableWrites: true, force: true, seams });
    assert.equal(res.ok, true, codes(res));
    assert.equal(res.forced, true);
    assert.equal(res.overwritten, true);
    assert.equal(seams.snapshotFn.calls.length, 1);
    assert.equal(seams.atomicWriteFn.calls.length, 1);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('stale guard: missing provenance → --apply WITHOUT --force refuses accept-no-provenance', async () => {
  const tmp = makeTree();
  const seams = rec();
  try {
    seedSkill(tmp, 'foo', ORIG);
    seedProposal(tmp, 'foo', TS, PROP); // NO provenance seeded
    const res = await acceptProposal({ name: 'foo', proposalId: TS, targetClaudeDir: tmp, mgrStateDir: mgrState(tmp),
      assertWritable: PASS, enableWrites: true, seams });
    assert.equal(res.ok, false);
    assert.equal(res.provenanceFound, false);
    assert.ok(codes(res).includes('accept-no-provenance'), codes(res));
    assertNoWrite(seams);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('stale guard: missing provenance → --apply WITH --force proceeds', async () => {
  const tmp = makeTree();
  const seams = rec();
  try {
    seedSkill(tmp, 'foo', ORIG);
    seedProposal(tmp, 'foo', TS, PROP);
    const res = await acceptProposal({ name: 'foo', proposalId: TS, targetClaudeDir: tmp, mgrStateDir: mgrState(tmp),
      assertWritable: PASS, enableWrites: true, force: true, seams });
    assert.equal(res.ok, true, codes(res));
    assert.equal(res.overwritten, true);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

// ══ apply happy path ════════════════════════════════════════════════════════════

test('--apply happy path: snapshot → manifest check → write(accept,PROP) → delete(accept) → provenance unlink', async () => {
  const tmp = makeTree();
  const seams = rec();
  try {
    const skillPath = seedSkill(tmp, 'foo', ORIG);
    const propPath = seedProposal(tmp, 'foo', TS, PROP);
    const provPath = seedProvenance(tmp, 'foo', TS, ORIG_SHA);
    const res = await acceptProposal({ name: 'foo', proposalId: TS, targetClaudeDir: tmp, mgrStateDir: mgrState(tmp),
      assertWritable: PASS, enableWrites: true, pid: 4242, reason: 'land iteration', seams });
    assert.equal(res.ok, true, codes(res));
    assert.equal(res.dryRun, false);
    assert.equal(res.overwritten, true);
    assert.equal(res.proposalRemoved, true);
    assert.equal(res.provenanceRemoved, true);
    assert.equal(res.manifestChecked, true);
    assert.equal(res.snapshotId, TS);
    assert.deepEqual(res.lock, { acquired: true });
    // snapshot taken with skipSecretFilter + reason
    assert.equal(seams.snapshotFn.calls.length, 1);
    assert.equal(seams.snapshotFn.calls[0].skipSecretFilter, true);
    assert.equal(seams.snapshotFn.calls[0].reason, 'land iteration');
    // manifest check covered BOTH targets
    assert.equal(seams.manifestCheckFn.calls.length, 1);
    const ops = seams.manifestCheckFn.calls[0].plan.ops;
    assert.deepEqual(ops.map((o) => o.kind).sort(), ['delete', 'overwrite']);
    assert.ok(ops.some((o) => o.kind === 'overwrite' && o.target === skillPath));
    assert.ok(ops.some((o) => o.kind === 'delete' && o.target === propPath));
    // the overwrite: context 'accept', the PROP buffer, gate PASS
    assert.equal(seams.atomicWriteFn.calls.length, 1);
    const w = seams.atomicWriteFn.calls[0];
    assert.equal(w.context, 'accept');
    assert.equal(w.target, skillPath);
    assert.equal(w.assertWritable, PASS);
    assert.ok(Buffer.isBuffer(w.content), 'content must be a Buffer');
    assert.equal(w.content.toString('utf8'), PROP);
    // the delete: context 'accept', the proposal path
    assert.equal(seams.atomicDeleteFn.calls.length, 1);
    assert.equal(seams.atomicDeleteFn.calls[0].context, 'accept');
    assert.equal(seams.atomicDeleteFn.calls[0].target, propPath);
    // provenance unlink
    assert.ok(seams.unlinkFn.calls.includes(provPath), seams.unlinkFn.calls);
    // lock pid threading
    assert.equal(seams.acquireLockFn.calls[0].pid, 4242);
    assert.equal(seams.releaseLockFn.calls[0].pid, 4242);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

// ══ snapshot fail / manifest miss ═══════════════════════════════════════════════

test('--apply snapshot fail → accept-snapshot-failed, atomicWrite NEVER called, lock released', async () => {
  const tmp = makeTree();
  const seams = rec();
  seams.snapshotFn = makeSnapshot({ ok: false, snapshotId: null });
  try {
    seedSkill(tmp, 'foo', ORIG);
    seedProposal(tmp, 'foo', TS, PROP);
    seedProvenance(tmp, 'foo', TS, ORIG_SHA);
    const res = await acceptProposal({ name: 'foo', proposalId: TS, targetClaudeDir: tmp, mgrStateDir: mgrState(tmp),
      assertWritable: PASS, enableWrites: true, seams });
    assert.equal(res.ok, false);
    assert.ok(codes(res).includes('accept-snapshot-failed'), codes(res));
    assert.equal(seams.atomicWriteFn.calls.length, 0, 'no overwrite when the snapshot failed');
    assert.equal(seams.releaseLockFn.calls.length, 1, 'lock released in finally');
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('--apply manifest miss → accept-target-not-snapshotted, atomicWrite NEVER called', async () => {
  const tmp = makeTree();
  const seams = rec();
  seams.manifestCheckFn = makeManifestCheck({ ok: false, message: "op target 'skills/foo/SKILL.md' is not captured" });
  try {
    seedSkill(tmp, 'foo', ORIG);
    seedProposal(tmp, 'foo', TS, PROP);
    seedProvenance(tmp, 'foo', TS, ORIG_SHA);
    const res = await acceptProposal({ name: 'foo', proposalId: TS, targetClaudeDir: tmp, mgrStateDir: mgrState(tmp),
      assertWritable: PASS, enableWrites: true, seams });
    assert.equal(res.ok, false);
    assert.ok(codes(res).includes('accept-target-not-snapshotted'), codes(res));
    assert.equal(seams.snapshotFn.calls.length, 1, 'snapshot ran before the backstop');
    assert.equal(seams.atomicWriteFn.calls.length, 0, 'no overwrite when a target was not snapshotted');
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

// ══ write fail / cleanup best-effort ════════════════════════════════════════════

test('--apply write fails → ok:false (surfaces primitive diags) + accept-write-failed, lock released', async () => {
  const tmp = makeTree();
  const seams = rec();
  seams.atomicWriteFn = makeWrite({ ok: false, wrote: false,
    diagnostics: [{ severity: 'error', code: 'apply-write-staging-failed', message: 'no space', phase: 'apply' }] });
  try {
    seedSkill(tmp, 'foo', ORIG);
    seedProposal(tmp, 'foo', TS, PROP);
    seedProvenance(tmp, 'foo', TS, ORIG_SHA);
    const res = await acceptProposal({ name: 'foo', proposalId: TS, targetClaudeDir: tmp, mgrStateDir: mgrState(tmp),
      assertWritable: PASS, enableWrites: true, seams });
    assert.equal(res.ok, false);
    assert.equal(res.overwritten, false);
    assert.ok(codes(res).includes('accept-write-failed'), codes(res));
    assert.ok(codes(res).includes('apply-write-staging-failed'), 'primitive diagnostics surfaced');
    assert.equal(seams.atomicDeleteFn.calls.length, 0, 'no cleanup delete when the overwrite failed');
    assert.equal(seams.releaseLockFn.calls.length, 1, 'lock released in finally');
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('cleanup best-effort: proposal delete fails → ok stays true + accept-proposal-cleanup-failed warn', async () => {
  const tmp = makeTree();
  const seams = rec();
  seams.atomicDeleteFn = makeDelete({ ok: false, deleted: false,
    diagnostics: [{ severity: 'error', code: 'apply-delete-failed', message: 'busy', phase: 'apply' }] });
  try {
    seedSkill(tmp, 'foo', ORIG);
    seedProposal(tmp, 'foo', TS, PROP);
    seedProvenance(tmp, 'foo', TS, ORIG_SHA);
    const res = await acceptProposal({ name: 'foo', proposalId: TS, targetClaudeDir: tmp, mgrStateDir: mgrState(tmp),
      assertWritable: PASS, enableWrites: true, seams });
    assert.equal(res.ok, true, 'a cleanup failure must NOT flip the landed overwrite to failed');
    assert.equal(res.overwritten, true);
    assert.equal(res.proposalRemoved, false);
    assert.ok(codes(res).includes('accept-proposal-cleanup-failed'), codes(res));
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('cleanup best-effort: provenance unlink throws → ok stays true + accept-provenance-cleanup-failed warn', async () => {
  const tmp = makeTree();
  const seams = rec();
  seams.unlinkFn = makeUnlink(true); // throws (not ENOENT)
  try {
    seedSkill(tmp, 'foo', ORIG);
    seedProposal(tmp, 'foo', TS, PROP);
    seedProvenance(tmp, 'foo', TS, ORIG_SHA);
    const res = await acceptProposal({ name: 'foo', proposalId: TS, targetClaudeDir: tmp, mgrStateDir: mgrState(tmp),
      assertWritable: PASS, enableWrites: true, seams });
    assert.equal(res.ok, true);
    assert.equal(res.overwritten, true);
    assert.equal(res.provenanceRemoved, false);
    assert.ok(codes(res).includes('accept-provenance-cleanup-failed'), codes(res));
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

// ══ lock / gate ═════════════════════════════════════════════════════════════════

test('--apply lock not acquired → accept-lock-failed, no snapshot/write, never release', async () => {
  const tmp = makeTree();
  const seams = rec();
  seams.acquireLockFn = makeAcquire({ acquired: false, reason: 'held' });
  try {
    seedSkill(tmp, 'foo', ORIG);
    seedProposal(tmp, 'foo', TS, PROP);
    seedProvenance(tmp, 'foo', TS, ORIG_SHA);
    const res = await acceptProposal({ name: 'foo', proposalId: TS, targetClaudeDir: tmp, mgrStateDir: mgrState(tmp),
      assertWritable: PASS, enableWrites: true, seams });
    assert.equal(res.ok, false);
    assert.equal(res.refused, true);
    assert.ok(codes(res).includes('accept-lock-failed'), codes(res));
    assert.deepEqual(res.lock, { acquired: false, reason: 'held' });
    assert.equal(seams.snapshotFn.calls.length, 0, 'no snapshot when the lock is held');
    assert.equal(seams.atomicWriteFn.calls.length, 0);
    assert.equal(seams.releaseLockFn.calls.length, 0, 'never release a lock we did not acquire');
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('--apply missing assertWritable → accept-bad-args, NO lock/snapshot/write', async () => {
  const tmp = makeTree();
  const seams = rec();
  try {
    seedSkill(tmp, 'foo', ORIG);
    seedProposal(tmp, 'foo', TS, PROP);
    seedProvenance(tmp, 'foo', TS, ORIG_SHA);
    const res = await acceptProposal({ name: 'foo', proposalId: TS, targetClaudeDir: tmp, mgrStateDir: mgrState(tmp),
      enableWrites: true, seams }); // no assertWritable
    assert.equal(res.ok, false);
    assert.equal(res.refused, true);
    assert.ok(codes(res).includes('accept-bad-args'), codes(res));
    assertNoWrite(seams);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

// ══ never-throws ════════════════════════════════════════════════════════════════

test('never-throws: acceptProposal(null) → full-shape ok:false', async () => {
  const res = await acceptProposal(null);
  assert.equal(typeof res, 'object');
  assert.equal(res.ok, false);
  assert.ok(Array.isArray(res.diagnostics));
  assert.equal(res.proposalPath, null);
  assert.equal(res.lock, null);
  assert.equal(res.overwritten, false);
});

test('never-throws: acceptProposal(undefined) → full-shape ok:false', async () => {
  const res = await acceptProposal(undefined);
  assert.equal(res.ok, false);
  assert.ok(res.diagnostics.length > 0);
});

test('never-throws: throwing-getter opts → ok:false, no crash', async () => {
  const hostile = {};
  Object.defineProperty(hostile, 'name', { get() { throw new Error('boom'); } });
  const res = await acceptProposal(hostile);
  assert.equal(res.ok, false);
  assert.ok(Array.isArray(res.diagnostics));
  assert.ok(res.diagnostics.length > 0);
});

test('never-throws: non-string name → accept-name-invalid (validated, not thrown)', async () => {
  const tmp = makeTree();
  try {
    for (const name of [42, {}, [], true]) {
      const seams = rec();
      const res = await acceptProposal({ name, targetClaudeDir: tmp, mgrStateDir: mgrState(tmp), seams });
      assert.equal(res.ok, false, String(name));
      assert.ok(codes(res).includes('accept-name-invalid'), `${String(name)}: ${codes(res)}`);
      assertNoWrite(seams);
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
