/**
 * P3.U8 — snapshot.test.mjs (orchestrator unit tests).
 *
 * Drives createSnapshot with a REAL temp tree (so the U5 walker + U6 secrets
 * filter run against real files) but an INJECTED resolveFn + spawnFn, so NO real
 * tar process is spawned. The assertions prove the WIRING:
 *   - the kept/dropped partition flows from the secrets filter,
 *   - a planted secret is DROPPED and NEVER appears in the file list handed to
 *     the tar spawn (it can't enter the archive — the headline security property),
 *   - the manifest records carry the correct sha256 of the kept file bytes,
 *   - assertWritable is REQUIRED (absent → ok:false + diagnostic, no bypass),
 *   - a tar failure / manifest-write failure each → ok:false + the right code,
 *   - an unreadable kept file is skipped + warned, snapshot still succeeds,
 *   - never-throws on garbage input.
 *
 * The real create→extract→byte-compare oracle lives in
 * test/integration/snapshot-roundtrip.test.mjs.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync,
  unlinkSync, rmdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createSnapshot } from '../src/ops/snapshot.mjs';

const FIXED_NOW = () => new Date('2026-05-27T00:00:00.000Z');
const FIXED_ID = '2026-05-27T00-00-00Z';
const TARPATH = 'C:\\Windows\\System32\\tar.exe';
const PASS_GATE = (p) => p; // passthrough write gate (returns canonical = input)

/** sha256 hex over a Buffer (mirrors the module under test). */
function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/** A recording resolveTar seam returning a fixed tarPath + no diagnostics. */
function makeResolve(tarPath = TARPATH) {
  const calls = [];
  const fn = () => { calls.push(true); return { tarPath, diagnostics: [] }; };
  fn.calls = calls;
  return fn;
}

/** A recording createSnapshotTar spawn seam. Records the spec; resolves/rejects. */
function makeSpawn(outcome = {}) {
  const calls = [];
  const fn = (spec) => {
    calls.push(spec);
    if (outcome.throw) return Promise.reject(outcome.throw);
    return Promise.resolve({ stdout: outcome.stdout ?? '', stderr: outcome.stderr ?? '' });
  };
  fn.calls = calls;
  return fn;
}

/** Make a temp .claude-like tree + a sibling .mgr-state dir; returns paths + cleanup. */
function makeTree(plant) {
  const root = mkdtempSync(join(tmpdir(), 'cmgr-snap-orch-'));
  const claudeDir = join(root, '.claude');
  const stateDir = join(claudeDir, '.mgr-state');
  mkdirSync(claudeDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  if (typeof plant === 'function') plant(claudeDir);
  return {
    root, claudeDir, stateDir,
    cleanup() { try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } },
  };
}

/** Write a file at a POSIX-relative path under base, creating parent dirs. */
function put(base, rel, bytes) {
  const abs = join(base, ...rel.split('/'));
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, bytes);
}

// ── (1) happy-path wiring ───────────────────────────────────────────────────────

test('createSnapshot: wires walk→filter→hash→tar→manifest and returns success', async () => {
  const aBytes = Buffer.from('# agent a\n', 'utf8');
  const sBytes = Buffer.from('# skill s\n', 'utf8');
  const t = makeTree((cd) => {
    put(cd, 'agents/a.md', aBytes);
    put(cd, 'skills/s/SKILL.md', sBytes);
    put(cd, 'settings.json', Buffer.from('{"model":"opus"}\n', 'utf8'));
  });
  const resolveFn = makeResolve();
  const spawnFn = makeSpawn();
  try {
    const res = await createSnapshot({
      targetClaudeDir: t.claudeDir, mgrStateDir: t.stateDir, reason: 'unit',
      assertWritable: PASS_GATE, now: FIXED_NOW, seams: { resolveFn, spawnFn },
    });
    assert.equal(res.ok, true, JSON.stringify(res.diagnostics));
    assert.equal(res.snapshotId, FIXED_ID);
    assert.equal(res.snapshotDir, join(t.stateDir, 'snapshots', FIXED_ID));
    assert.equal(res.archivePath, join(res.snapshotDir, 'files.tar'));
    assert.equal(res.manifestPath, join(res.snapshotDir, 'manifest.json'));
    // kept includes the 3 non-secret files (sorted); dropped is empty.
    assert.deepEqual(res.kept, ['agents/a.md', 'settings.json', 'skills/s/SKILL.md']);
    assert.deepEqual(res.dropped, []);
    assert.equal(res.fileCount, 3);
    // tar was spawned exactly once, with the kept files as direct argv positionals.
    assert.equal(spawnFn.calls.length, 1);
    const args = spawnFn.calls[0].args;
    assert.deepEqual(args, ['-c', '-f', res.archivePath, '-C', t.claudeDir, 'agents/a.md', 'settings.json', 'skills/s/SKILL.md']);
    // the manifest landed on disk + is valid JSON with the right hashes.
    assert.ok(existsSync(res.manifestPath));
    const manifest = JSON.parse(readFileSync(res.manifestPath, 'utf8'));
    assert.equal(manifest.snapshotId, FIXED_ID);
    assert.equal(manifest.reason, 'unit');
    const byPath = Object.fromEntries(manifest.files.map((f) => [f.path, f]));
    assert.equal(byPath['agents/a.md'].preSha256, sha256Hex(aBytes));
    assert.equal(byPath['agents/a.md'].currentSha256, sha256Hex(aBytes));
    assert.equal(byPath['skills/s/SKILL.md'].preSha256, sha256Hex(sBytes));
  } finally { t.cleanup(); }
});

// ── (2) the security property: a secret is DROPPED + never reaches the archive ──

test('createSnapshot: a planted secret is dropped and absent from the tar file list', async () => {
  const t = makeTree((cd) => {
    put(cd, 'agents/a.md', Buffer.from('clean\n', 'utf8'));
    // id_rsa is an EXACT secret name → dropped by the name matcher (no content read needed).
    put(cd, 'hooks/id_rsa', Buffer.from('-----BEGIN OPENSSH PRIVATE KEY-----\nx\n', 'utf8'));
  });
  const resolveFn = makeResolve();
  const spawnFn = makeSpawn();
  try {
    const res = await createSnapshot({
      targetClaudeDir: t.claudeDir, mgrStateDir: t.stateDir,
      assertWritable: PASS_GATE, now: FIXED_NOW, seams: { resolveFn, spawnFn },
    });
    assert.equal(res.ok, true, JSON.stringify(res.diagnostics));
    // The secret is in `dropped`, NOT in `kept`.
    assert.ok(res.dropped.some((d) => d.path === 'hooks/id_rsa'), 'id_rsa must be dropped');
    assert.ok(!res.kept.includes('hooks/id_rsa'), 'id_rsa must not be kept');
    // CRITICAL: the secret never reaches tar's argv → cannot enter the archive.
    const args = spawnFn.calls[0].args;
    assert.ok(!args.includes('hooks/id_rsa'), 'secret must be absent from the tar file list');
    // And it is absent from the manifest files[].
    const manifest = JSON.parse(readFileSync(res.manifestPath, 'utf8'));
    assert.ok(!manifest.files.some((f) => f.path === 'hooks/id_rsa'), 'secret must be absent from the manifest');
    // A per-drop INFO diagnostic surfaces the exclusion.
    assert.ok(res.diagnostics.some((d) => d.code === 'snapshot-secret-excluded'));
  } finally { t.cleanup(); }
});

// ── (3) assertWritable is REQUIRED (fail-safe, no bypass) ───────────────────────

test('createSnapshot: a missing assertWritable refuses (ok:false + snapshot-bad-args)', async () => {
  const t = makeTree((cd) => put(cd, 'agents/a.md', Buffer.from('x\n', 'utf8')));
  try {
    const res = await createSnapshot({
      targetClaudeDir: t.claudeDir, mgrStateDir: t.stateDir,
      // assertWritable intentionally omitted.
      now: FIXED_NOW, seams: { resolveFn: makeResolve(), spawnFn: makeSpawn() },
    });
    assert.equal(res.ok, false);
    assert.equal(res.diagnostics[0].code, 'snapshot-bad-args');
    assert.match(res.diagnostics[0].message, /assertWritable/);
  } finally { t.cleanup(); }
});

// ── (4) bad args ────────────────────────────────────────────────────────────────

test('createSnapshot: empty targetClaudeDir / mgrStateDir → snapshot-bad-args', async () => {
  const a = await createSnapshot({ targetClaudeDir: '', mgrStateDir: 'x', assertWritable: PASS_GATE });
  assert.equal(a.ok, false);
  assert.equal(a.diagnostics[0].code, 'snapshot-bad-args');
  const b = await createSnapshot({ targetClaudeDir: 'x', mgrStateDir: '', assertWritable: PASS_GATE });
  assert.equal(b.ok, false);
  assert.equal(b.diagnostics[0].code, 'snapshot-bad-args');
});

// ── (5) tar unavailable / resolve throws ────────────────────────────────────────

test('createSnapshot: tar unavailable (resolveFn → null) → snapshot-tar-unavailable, no spawn', async () => {
  const t = makeTree((cd) => put(cd, 'agents/a.md', Buffer.from('x\n', 'utf8')));
  const spawnFn = makeSpawn();
  try {
    const res = await createSnapshot({
      targetClaudeDir: t.claudeDir, mgrStateDir: t.stateDir, assertWritable: PASS_GATE,
      now: FIXED_NOW, seams: { resolveFn: () => ({ tarPath: null, diagnostics: [{ severity: 'error', code: 'tar-not-found', message: 'x' }] }), spawnFn },
    });
    assert.equal(res.ok, false);
    // the resolve diagnostic is aggregated, plus our own unavailable error.
    assert.ok(res.diagnostics.some((d) => d.code === 'tar-not-found'));
    assert.ok(res.diagnostics.some((d) => d.code === 'snapshot-tar-unavailable'));
    assert.equal(spawnFn.calls.length, 0);
  } finally { t.cleanup(); }
});

test('createSnapshot: a throwing resolveFn degrades to snapshot-tar-resolve-failed (never throws)', async () => {
  const t = makeTree((cd) => put(cd, 'agents/a.md', Buffer.from('x\n', 'utf8')));
  try {
    const res = await createSnapshot({
      targetClaudeDir: t.claudeDir, mgrStateDir: t.stateDir, assertWritable: PASS_GATE,
      now: FIXED_NOW, seams: { resolveFn: () => { throw new Error('boom'); } },
    });
    assert.equal(res.ok, false);
    assert.equal(res.diagnostics[0].code, 'snapshot-tar-resolve-failed');
  } finally { t.cleanup(); }
});

// ── (6) tar failure → snapshot-archive-failed ───────────────────────────────────

test('createSnapshot: a tar spawn failure → ok:false + snapshot-archive-failed (with progress)', async () => {
  const t = makeTree((cd) => put(cd, 'agents/a.md', Buffer.from('x\n', 'utf8')));
  const spawnFn = makeSpawn({ throw: Object.assign(new Error('tar: exit 1'), { code: 1 }) });
  try {
    const res = await createSnapshot({
      targetClaudeDir: t.claudeDir, mgrStateDir: t.stateDir, assertWritable: PASS_GATE,
      now: FIXED_NOW, seams: { resolveFn: makeResolve(), spawnFn },
    });
    assert.equal(res.ok, false);
    assert.ok(res.diagnostics.some((d) => d.code === 'tar-create-failed'), 'aggregates the tar diagnostic');
    assert.ok(res.diagnostics.some((d) => d.code === 'snapshot-archive-failed'), 'own step error');
    // partial-progress result still surfaces the id + kept partition.
    assert.equal(res.snapshotId, FIXED_ID);
    assert.deepEqual(res.kept, ['agents/a.md']);
  } finally { t.cleanup(); }
});

// ── (7) manifest-write failure → snapshot-manifest-write-failed ─────────────────

test('createSnapshot: a manifest-write gate denial → snapshot-manifest-write-failed', async () => {
  const t = makeTree((cd) => put(cd, 'agents/a.md', Buffer.from('x\n', 'utf8')));
  // Gate allows the archive path but DENIES the manifest.json write.
  const gate = (p) => {
    if (String(p).endsWith('manifest.json')) throw new Error('manifest write forbidden');
    return p;
  };
  try {
    const res = await createSnapshot({
      targetClaudeDir: t.claudeDir, mgrStateDir: t.stateDir, assertWritable: gate,
      now: FIXED_NOW, seams: { resolveFn: makeResolve(), spawnFn: makeSpawn() },
    });
    assert.equal(res.ok, false);
    // writeManifest surfaces manifest-write-error; our step adds the rollup code.
    assert.ok(res.diagnostics.some((d) => d.code === 'manifest-write-error'));
    assert.ok(res.diagnostics.some((d) => d.code === 'snapshot-manifest-write-failed'));
  } finally { t.cleanup(); }
});

// ── (7b) D2 FAILURE CLEANUP: a failed --apply leaves NO snapshot dir on disk ─────

/** A spawn seam that actually CREATES the archive file (so cleanup has something to
 *  unlink), then resolves ok — simulating a real tar that wrote files.tar. */
function makeWritingSpawn() {
  const calls = [];
  const fn = (spec) => {
    calls.push(spec);
    // tar's args are ['-c','-f',<archive>,'-C',<base>, ...members]; write the archive.
    const archive = spec.args[2];
    try { writeFileSync(archive, Buffer.from('FAKE TAR BYTES')); } catch { /* ignore */ }
    return Promise.resolve({ stdout: '', stderr: '' });
  };
  fn.calls = calls;
  return fn;
}

/** Spy unlink/rmdir seams recording every path they were asked to remove. */
function makeRmSpies() {
  const unlinked = [];
  const rmdired = [];
  const unlinkFn = (p) => { unlinked.push(p); return unlinkSync(p); };
  const rmdirFn = (p) => { rmdired.push(p); return rmdirSync(p); };
  return { unlinked, rmdired, unlinkFn, rmdirFn };
}

test('createSnapshot D2: a tar failure removes the snapshot dir (no orphan) and only that dir', async () => {
  const t = makeTree((cd) => put(cd, 'agents/a.md', Buffer.from('x\n', 'utf8')));
  // mkdir really creates the dir; tar fails AFTER the dir exists.
  const spawnFn = makeSpawn({ throw: Object.assign(new Error('tar: exit 1'), { code: 1 }) });
  const spies = makeRmSpies();
  const snapDir = join(t.stateDir, 'snapshots', FIXED_ID);
  try {
    const res = await createSnapshot({
      targetClaudeDir: t.claudeDir, mgrStateDir: t.stateDir, assertWritable: PASS_GATE,
      now: FIXED_NOW, seams: { resolveFn: makeResolve(), spawnFn, unlinkFn: spies.unlinkFn, rmdirFn: spies.rmdirFn },
    });
    assert.equal(res.ok, false);
    assert.ok(res.diagnostics.some((d) => d.code === 'snapshot-archive-failed'));
    // The snapshot dir is GONE — no orphan left behind.
    assert.ok(!existsSync(snapDir), 'snapshot dir must be removed after a failed apply');
    // The cleanup rmdir'd EXACTLY the snapshots/<id> dir and nothing else.
    assert.deepEqual(spies.rmdired, [snapDir]);
    // The .mgr-state/snapshots parent dir is NOT removed (cleanup is bounded to <id>).
    assert.ok(existsSync(join(t.stateDir, 'snapshots')), 'the snapshots/ parent must survive');
    // Every unlink target is INSIDE the snapshot dir (never an outside path).
    for (const p of spies.unlinked) assert.ok(p.startsWith(snapDir), `unlink escaped snapshot dir: ${p}`);
  } finally { t.cleanup(); }
});

test('createSnapshot D2: a manifest-write failure removes the dir incl. the written files.tar', async () => {
  const t = makeTree((cd) => put(cd, 'agents/a.md', Buffer.from('x\n', 'utf8')));
  // tar SUCCEEDS and writes files.tar; the manifest write is then DENIED → cleanup
  // must remove BOTH files.tar and the now-empty dir.
  const spawnFn = makeWritingSpawn();
  const gate = (p) => { if (String(p).endsWith('manifest.json')) throw new Error('manifest write forbidden'); return p; };
  const spies = makeRmSpies();
  const snapDir = join(t.stateDir, 'snapshots', FIXED_ID);
  try {
    const res = await createSnapshot({
      targetClaudeDir: t.claudeDir, mgrStateDir: t.stateDir, assertWritable: gate,
      now: FIXED_NOW, seams: { resolveFn: makeResolve(), spawnFn, unlinkFn: spies.unlinkFn, rmdirFn: spies.rmdirFn },
    });
    assert.equal(res.ok, false);
    assert.ok(res.diagnostics.some((d) => d.code === 'snapshot-manifest-write-failed'));
    // The whole snapshot dir (incl. the real files.tar tar wrote) is gone.
    assert.ok(!existsSync(snapDir), 'snapshot dir must be removed after a manifest failure');
    assert.ok(!existsSync(join(snapDir, 'files.tar')), 'the partial files.tar must be unlinked');
    // files.tar was the unlinked archive; rmdir removed exactly the snapshot dir.
    assert.ok(spies.unlinked.includes(join(snapDir, 'files.tar')), 'files.tar must be the unlink target');
    assert.deepEqual(spies.rmdired, [snapDir]);
  } finally { t.cleanup(); }
});

test('createSnapshot D2: a cleanup failure degrades to a warn and does NOT mask the original error', async () => {
  const t = makeTree((cd) => put(cd, 'agents/a.md', Buffer.from('x\n', 'utf8')));
  const spawnFn = makeSpawn({ throw: Object.assign(new Error('tar: exit 1'), { code: 1 }) });
  // rmdir throws a NON-ENOENT error (e.g. dir busy) → must surface a warn, not throw,
  // and the original snapshot-archive-failed error stays the primary signal.
  const rmdirFn = () => { throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); };
  const unlinkFn = () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); };
  try {
    const res = await createSnapshot({
      targetClaudeDir: t.claudeDir, mgrStateDir: t.stateDir, assertWritable: PASS_GATE,
      now: FIXED_NOW, seams: { resolveFn: makeResolve(), spawnFn, unlinkFn, rmdirFn },
    });
    assert.equal(res.ok, false);
    // The ORIGINAL error is still present (not masked by the cleanup failure).
    assert.ok(res.diagnostics.some((d) => d.code === 'snapshot-archive-failed'), 'original error preserved');
    // The cleanup failures surface as warns (not errors, not throws).
    const cleanupWarns = res.diagnostics.filter((d) => d.code === 'snapshot-cleanup-failed');
    assert.ok(cleanupWarns.length >= 1, 'cleanup failure surfaced as a warn');
    assert.ok(cleanupWarns.every((d) => d.severity === 'warn'));
  } finally { t.cleanup(); }
});

test('createSnapshot D2: NO cleanup on a pre-mkdir failure (gate denial) — nothing to remove', async () => {
  const t = makeTree((cd) => put(cd, 'agents/a.md', Buffer.from('x\n', 'utf8')));
  const spies = makeRmSpies();
  // Gate denies the archive path BEFORE mkdir → cleanup must NOT run (no dir created).
  const gate = () => { throw new Error('outside governed region'); };
  try {
    const res = await createSnapshot({
      targetClaudeDir: t.claudeDir, mgrStateDir: t.stateDir, assertWritable: gate,
      now: FIXED_NOW, seams: { resolveFn: makeResolve(), spawnFn: makeSpawn(), unlinkFn: spies.unlinkFn, rmdirFn: spies.rmdirFn },
    });
    assert.equal(res.ok, false);
    assert.equal(res.diagnostics.find((d) => d.code.startsWith('snapshot-')).code, 'snapshot-write-denied');
    // No cleanup ran (the dir was never created).
    assert.deepEqual(spies.unlinked, []);
    assert.deepEqual(spies.rmdired, []);
  } finally { t.cleanup(); }
});

// ── (8) write-gate denial on the archive path → snapshot-write-denied ───────────

test('createSnapshot: a write-gate denial on the archive path → snapshot-write-denied, no spawn', async () => {
  const t = makeTree((cd) => put(cd, 'agents/a.md', Buffer.from('x\n', 'utf8')));
  const spawnFn = makeSpawn();
  const gate = () => { throw new Error('outside governed region'); };
  try {
    const res = await createSnapshot({
      targetClaudeDir: t.claudeDir, mgrStateDir: t.stateDir, assertWritable: gate,
      now: FIXED_NOW, seams: { resolveFn: makeResolve(), spawnFn },
    });
    assert.equal(res.ok, false);
    assert.equal(res.diagnostics.find((d) => d.code.startsWith('snapshot-')).code, 'snapshot-write-denied');
    assert.equal(spawnFn.calls.length, 0, 'no archive spawn after a gate denial');
  } finally { t.cleanup(); }
});

// ── (9) unreadable kept file → skipped + warned, snapshot still succeeds ─────────

test('createSnapshot: an unreadable kept file is skipped + warned (snapshot still ok)', async () => {
  const aBytes = Buffer.from('readable\n', 'utf8');
  const t = makeTree((cd) => {
    put(cd, 'agents/a.md', aBytes);
    put(cd, 'agents/b.md', Buffer.from('will-fail-to-read\n', 'utf8'));
  });
  // Inject a readFileFn that throws for b.md only (the hashing seam).
  const readFileFn = (p) => {
    if (String(p).endsWith('b.md')) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    return aBytes;
  };
  try {
    const res = await createSnapshot({
      targetClaudeDir: t.claudeDir, mgrStateDir: t.stateDir, assertWritable: PASS_GATE,
      now: FIXED_NOW, seams: { resolveFn: makeResolve(), spawnFn: makeSpawn(), readFileFn },
    });
    assert.equal(res.ok, true, JSON.stringify(res.diagnostics));
    // b.md is still KEPT (it passed the secrets filter) + still archived by tar,
    // but it is NOT in the manifest (its hash failed) and a warn is emitted.
    assert.ok(res.kept.includes('agents/b.md'));
    assert.equal(res.fileCount, 1, 'only a.md hashed into the manifest');
    assert.ok(res.diagnostics.some((d) => d.code === 'snapshot-file-unreadable' && d.path === 'agents/b.md'));
  } finally { t.cleanup(); }
});

// ── (10) never-throws on garbage input ──────────────────────────────────────────

test('createSnapshot: tolerates undefined / null opts without throwing', async () => {
  const a = await createSnapshot();
  assert.equal(a.ok, false);
  assert.equal(a.diagnostics[0].code, 'snapshot-bad-args');
  const b = await createSnapshot(null);
  assert.equal(b.ok, false);
  const c = await createSnapshot({});
  assert.equal(c.ok, false);
});

// ── (11) dry-run: walk+filter only, no write, no gate required ───────────────────

test('createSnapshot dryRun: previews kept/dropped, no archive/manifest, writes nothing', async () => {
  const t = makeTree((cd) => {
    put(cd, 'agents/a.md', Buffer.from('clean\n', 'utf8'));
    put(cd, 'skills/s/SKILL.md', Buffer.from('# skill\n', 'utf8'));
    put(cd, 'hooks/id_rsa', Buffer.from('-----BEGIN OPENSSH PRIVATE KEY-----\nx\n', 'utf8'));
  });
  const spawnFn = makeSpawn();
  // mkdirFn must NOT be called in dry-run — make it throw if it is.
  const mkdirFn = () => { throw new Error('dry-run must not mkdir'); };
  try {
    const res = await createSnapshot({
      targetClaudeDir: t.claudeDir, mgrStateDir: t.stateDir, reason: 'preview',
      // assertWritable intentionally OMITTED — dry-run needs no write gate.
      dryRun: true, now: FIXED_NOW, seams: { resolveFn: makeResolve(), spawnFn, mkdirFn },
    });
    assert.equal(res.ok, true, JSON.stringify(res.diagnostics));
    assert.equal(res.dryRun, true);
    assert.equal(res.snapshotId, FIXED_ID, 'preview id is the same shape an apply would use');
    // kept = the 2 clean files (sorted); the secret is dropped.
    assert.deepEqual(res.kept, ['agents/a.md', 'skills/s/SKILL.md']);
    assert.equal(res.fileCount, 2);
    assert.ok(res.dropped.some((d) => d.path === 'hooks/id_rsa'), 'secret dropped in preview');
    // No archive / manifest / dir paths in a preview.
    assert.equal(res.snapshotDir, null);
    assert.equal(res.archivePath, null);
    assert.equal(res.manifestPath, null);
    // CRITICAL: nothing was spawned (no tar) and nothing was written.
    assert.equal(spawnFn.calls.length, 0, 'dry-run never spawns tar');
    assert.ok(!existsSync(join(t.stateDir, 'snapshots')), 'dry-run never creates the snapshots dir');
  } finally { t.cleanup(); }
});

test('createSnapshot dryRun: a missing tar WARNS but still returns the preview', async () => {
  const t = makeTree((cd) => put(cd, 'agents/a.md', Buffer.from('x\n', 'utf8')));
  try {
    const res = await createSnapshot({
      targetClaudeDir: t.claudeDir, mgrStateDir: t.stateDir, dryRun: true, now: FIXED_NOW,
      seams: { resolveFn: () => ({ tarPath: null, diagnostics: [] }) },
    });
    // Preview still succeeds (the kept partition is the point of a dry-run).
    assert.equal(res.ok, true, JSON.stringify(res.diagnostics));
    assert.equal(res.dryRun, true);
    assert.deepEqual(res.kept, ['agents/a.md']);
    // ...but a WARN tells the user --apply would fail.
    assert.ok(res.diagnostics.some((d) => d.code === 'snapshot-tar-unavailable' && d.severity === 'warn'), JSON.stringify(res.diagnostics));
  } finally { t.cleanup(); }
});

test('createSnapshot dryRun: still validates targetClaudeDir / mgrStateDir', async () => {
  const a = await createSnapshot({ targetClaudeDir: '', mgrStateDir: 'x', dryRun: true });
  assert.equal(a.ok, false);
  assert.equal(a.diagnostics[0].code, 'snapshot-bad-args');
});
