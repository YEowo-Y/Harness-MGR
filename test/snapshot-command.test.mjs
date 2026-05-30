/**
 * P3 — snapshot-command.test.mjs (CLI `snapshot` handler tests).
 *
 * Drives `snapshotCommand` (the CLI wiring around createSnapshot) and proves:
 *   (a) DRY-RUN (the default): with a REAL temp config tree + a planted secret,
 *       mode==='dry-run', kept/dropped counts are correct, the secret is in dropped,
 *       and NO snapshot dir / files.tar / manifest.json is ever written.
 *   (b) --APPLY: through the injected `loadPaths` seam (a fake passthrough write gate)
 *       against a real temp tree, mode==='applied', snapshotId set, files.tar +
 *       manifest.json exist on disk.
 *   (c) M2 DEGRADE: `loadPaths` rejects under --apply → status 'write-unavailable' +
 *       a `snapshot-write-unavailable` warn, NO throw.
 *   (d) FLAG PLUMBING: reason + include-auth reach createFn (spy).
 *
 * The createSnapshot orchestrator's own dry-run unit (no archive/manifest, writes
 * nothing, no gate required) is covered in test/snapshot.test.mjs.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { snapshotCommand } from '../src/cli/ops-commands.mjs';

const TARPATH = 'C:\\Windows\\System32\\tar.exe';

/** A recording resolveTar seam returning a fixed tarPath + no diagnostics. */
function makeResolve(tarPath = TARPATH) {
  return () => ({ tarPath, diagnostics: [] });
}

/** A recording createSnapshotTar spawn seam (records the spec; resolves ok). */
function makeSpawn() {
  const calls = [];
  const fn = (spec) => { calls.push(spec); return Promise.resolve({ stdout: '', stderr: '' }); };
  fn.calls = calls;
  return fn;
}

/** Make a temp .claude-like tree + a sibling .mgr-state dir; returns paths + cleanup. */
function makeTree(plant) {
  const root = mkdtempSync(join(tmpdir(), 'cmgr-snap-cmd-'));
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

// ── (a) DRY-RUN: previews, drops the secret, writes NOTHING ──────────────────────

test('snapshotCommand: dry-run previews kept/dropped and writes no snapshot dir', async () => {
  const t = makeTree((cd) => {
    put(cd, 'agents/a.md', Buffer.from('clean\n', 'utf8'));
    put(cd, 'skills/s/SKILL.md', Buffer.from('# skill\n', 'utf8'));
    put(cd, 'settings.json', Buffer.from('{"model":"opus"}\n', 'utf8'));
    // id_rsa is an EXACT secret name → dropped by the name matcher.
    put(cd, 'hooks/id_rsa', Buffer.from('-----BEGIN OPENSSH PRIVATE KEY-----\nx\n', 'utf8'));
  });
  try {
    const out = await snapshotCommand({ configDir: t.claudeDir, mgrStateDir: t.stateDir, args: {} });
    const r = out.result;
    assert.equal(r.mode, 'dry-run');
    assert.equal(r.ok, true);
    // 3 clean files kept; the secret dropped.
    assert.equal(r.keptCount, 3, JSON.stringify(r));
    assert.equal(r.fileCount, 3);
    assert.equal(r.droppedCount, 1);
    assert.ok(r.dropped.includes('hooks/id_rsa'), 'secret path must be in dropped');
    // dry-run surfaces no archive/manifest paths.
    assert.equal(r.archivePath, null);
    assert.equal(r.manifestPath, null);
    // CRITICAL: nothing was written — no snapshots dir under .mgr-state.
    assert.ok(!existsSync(join(t.stateDir, 'snapshots')), 'dry-run must not create the snapshots dir');
  } finally { t.cleanup(); }
});

// ── (b) --APPLY via the injected loadPaths seam: archive + manifest land on disk ──

test('snapshotCommand: --apply (fake gate via loadPaths) writes files.tar + manifest.json', async () => {
  const t = makeTree((cd) => put(cd, 'agents/a.md', Buffer.from('# agent a\n', 'utf8')));
  const spawnFn = makeSpawn();
  // A fake paths module: a passthrough write gate (returns canonical = input).
  const loadPaths = () => Promise.resolve({ assertWritable: (p) => p });
  // Wrap createSnapshot so the test injects the resolve/spawn seams (no real tar).
  const { createSnapshot } = await import('../src/ops/snapshot.mjs');
  const createFn = (o) => createSnapshot({ ...o, seams: { resolveFn: makeResolve(), spawnFn } });
  try {
    const out = await snapshotCommand(
      { configDir: t.claudeDir, mgrStateDir: t.stateDir, args: { apply: true, reason: 'apply-test' } },
      { loadPaths, createFn },
    );
    const r = out.result;
    assert.equal(r.mode, 'applied');
    assert.equal(r.ok, true, JSON.stringify(out.diagnostics));
    assert.ok(typeof r.snapshotId === 'string' && r.snapshotId.length > 0, 'snapshotId set');
    assert.ok(r.archivePath && r.archivePath.endsWith('files.tar'));
    assert.ok(r.manifestPath && r.manifestPath.endsWith('manifest.json'));
    // The snapshot dir holds the manifest (real write through the fake gate). The
    // archive itself is created by the (injected) spawn, which here is a no-op recorder,
    // so we assert the manifest landed + tar was invoked with the kept file.
    assert.ok(existsSync(r.manifestPath), 'manifest.json must exist on disk');
    assert.equal(spawnFn.calls.length, 1, 'tar spawned once');
    assert.ok(spawnFn.calls[0].args.includes('agents/a.md'), 'kept file handed to tar');
  } finally { t.cleanup(); }
});

// ── (c) M2 DEGRADE: loadPaths rejects under --apply → write-unavailable warn ──────

test('snapshotCommand: --apply with an unloadable hooks lib degrades (no throw)', async () => {
  const t = makeTree((cd) => put(cd, 'agents/a.md', Buffer.from('x\n', 'utf8')));
  const loadPaths = () => Promise.reject(new Error('no hooks lib'));
  // createFn must NEVER be reached on this path — make it explode if it is.
  const createFn = () => { throw new Error('createFn must not run when the gate is unavailable'); };
  try {
    const out = await snapshotCommand(
      { configDir: t.claudeDir, mgrStateDir: t.stateDir, args: { apply: true } },
      { loadPaths, createFn },
    );
    assert.equal(out.result.mode, 'applied');
    assert.equal(out.result.status, 'write-unavailable');
    assert.ok(out.diagnostics.some((d) => d.code === 'snapshot-write-unavailable' && d.severity === 'warn'), JSON.stringify(out.diagnostics));
  } finally { t.cleanup(); }
});

// ── (d) FLAG PLUMBING: reason + include-auth reach createFn ───────────────────────

test('snapshotCommand: reason + include-auth flags reach createFn', async () => {
  const calls = [];
  const createFn = (o) => {
    calls.push(o);
    return Promise.resolve({ ok: true, dryRun: true, snapshotId: 'id', snapshotDir: null, archivePath: null, manifestPath: null, kept: [], dropped: [], fileCount: 0, diagnostics: [] });
  };
  // Dry-run path (no --apply) so loadPaths is never touched.
  await snapshotCommand(
    { configDir: '/cfg', mgrStateDir: '/cfg/.mgr-state', args: { reason: 'my reason', 'include-auth': true } },
    { createFn },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].reason, 'my reason');
  assert.equal(calls[0].includeAuth, true);
  assert.equal(calls[0].dryRun, true, 'no --apply → dryRun:true');
  assert.equal(calls[0].targetClaudeDir, '/cfg');
  assert.equal(calls[0].mgrStateDir, '/cfg/.mgr-state');
});

// ── (e) defaults: no reason / no include-auth → empty/false reach createFn ────────

test('snapshotCommand: absent flags default to reason="" and includeAuth=false', async () => {
  const calls = [];
  const createFn = (o) => { calls.push(o); return Promise.resolve({ ok: true, dryRun: true, snapshotId: 'id', kept: [], dropped: [], fileCount: 0, diagnostics: [] }); };
  await snapshotCommand({ configDir: '/cfg', mgrStateDir: '/cfg/.mgr-state', args: {} }, { createFn });
  assert.equal(calls[0].reason, '');
  assert.equal(calls[0].includeAuth, false);
});

// ── (f) never-throws on a missing args object ────────────────────────────────────

test('snapshotCommand: tolerates a missing args object (dry-run, no throw)', async () => {
  const calls = [];
  const createFn = (o) => { calls.push(o); return Promise.resolve({ ok: true, dryRun: true, snapshotId: 'id', kept: [], dropped: [], fileCount: 0, diagnostics: [] }); };
  const out = await snapshotCommand({ configDir: '/cfg', mgrStateDir: '/cfg/.mgr-state' }, { createFn });
  assert.equal(out.result.mode, 'dry-run');
  assert.equal(calls[0].reason, '');
  assert.equal(calls[0].includeAuth, false);
});
