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
import { snapshotListCommand, snapshotGcCommand } from '../src/cli/snapshot-store-command.mjs';

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
      // env factor present so the two-factor gate opens and the real apply path runs.
      { loadPaths, createFn, env: { HARNESS_MGR_ENABLE_WRITES: '1' } },
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
      // env factor present → the gate opens, so loadPaths IS reached (and rejects → degrade).
      { loadPaths, createFn, env: { HARNESS_MGR_ENABLE_WRITES: '1' } },
    );
    assert.equal(out.result.mode, 'applied');
    assert.equal(out.result.status, 'write-unavailable');
    assert.ok(out.diagnostics.some((d) => d.code === 'snapshot-write-unavailable' && d.severity === 'warn'), JSON.stringify(out.diagnostics));
  } finally { t.cleanup(); }
});

// ── (c2) TWO-FACTOR GATE: --apply with the env factor CLOSED → refuse, no write ────

test('snapshotCommand: --apply + env=0 CLOSED → code 3 writes-disabled-env, createFn + loadPaths NEVER called', async () => {
  // The load-bearing new oracle: HARNESS_MGR_ENABLE_WRITES=0 is the explicit opt-out
  // lock. With it set to '0', --apply must REFUSE up front — the write gate is
  // never loaded and no snapshot is created.
  const loadPathsCalls = [];
  const loadPaths = () => { loadPathsCalls.push(1); return Promise.resolve({ assertWritable: (p) => p }); };
  const createFn = () => { throw new Error('createFn must NOT run when the env gate is closed'); };
  const out = await snapshotCommand(
    { configDir: '/cfg', mgrStateDir: '/cfg/.mgr-state', args: { apply: true } },
    { loadPaths, createFn, env: { HARNESS_MGR_ENABLE_WRITES: '0' } }, // explicit opt-out lock
  );
  assert.equal(out.code, 3, 'a closed gate refuses with code 3');
  assert.equal(out.result.mode, 'applied');
  assert.equal(out.result.status, 'writes-disabled-env');
  assert.ok(
    out.diagnostics.some((d) => d.code === 'writes-disabled-env' && d.severity === 'error'),
    JSON.stringify(out.diagnostics),
  );
  assert.equal(loadPathsCalls.length, 0, 'paths.mjs must NOT be loaded when the gate is closed');
});

test('snapshotCommand: dry-run (no --apply) is UNAFFECTED by a closed env gate', async () => {
  // No --apply → the env factor is irrelevant; the dry-run preview still runs and
  // never refuses, even with the env gate explicitly closed.
  const calls = [];
  const createFn = (o) => { calls.push(o); return Promise.resolve({ ok: true, dryRun: true, snapshotId: 'id', kept: [], dropped: [], fileCount: 0, diagnostics: [] }); };
  const out = await snapshotCommand(
    { configDir: '/cfg', mgrStateDir: '/cfg/.mgr-state', args: {} }, // no apply
    { createFn, env: {} },
  );
  assert.equal(out.result.mode, 'dry-run');
  assert.equal(calls.length, 1, 'the dry-run createFn still runs with a closed env gate');
  assert.equal(calls[0].dryRun, true);
  assert.ok(!out.diagnostics.some((d) => d.code === 'writes-disabled-env'), 'no env refusal on a dry-run');
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

// ── (g) D3 OUTPUT HONESTY: a FAILED --apply must NOT surface archive/manifest paths ─

test('snapshotCommand D3: a failed --apply result nulls archivePath + manifestPath', async () => {
  // createSnapshot returns ok:false but (defensively) still carries the partial-progress
  // archivePath. summarizeSnapshot must NOT echo a path for a file that was never written
  // (or was cleaned up by D2) — both paths must come back null.
  const loadPaths = () => Promise.resolve({ assertWritable: (p) => p });
  const createFn = () => Promise.resolve({
    ok: false,
    snapshotId: '2026-05-27T00-00-00Z',
    snapshotDir: 'C:\\state\\snapshots\\2026-05-27T00-00-00Z',
    archivePath: 'C:\\state\\snapshots\\2026-05-27T00-00-00Z\\files.tar',
    manifestPath: 'C:\\state\\snapshots\\2026-05-27T00-00-00Z\\manifest.json',
    kept: ['agents/a.md'], dropped: [], fileCount: 1,
    diagnostics: [{ severity: 'error', code: 'snapshot-archive-failed', message: 'x', phase: 'snapshot' }],
  });
  const out = await snapshotCommand(
    { configDir: '/cfg', mgrStateDir: '/cfg/.mgr-state', args: { apply: true } },
    // env factor present so the gate opens and createFn (returning ok:false) is reached.
    { loadPaths, createFn, env: { HARNESS_MGR_ENABLE_WRITES: '1' } },
  );
  const r = out.result;
  assert.equal(r.mode, 'applied');
  assert.equal(r.ok, false);
  // The lie-guard: NO archive/manifest path on a failed apply, even though the result carried them.
  assert.equal(r.archivePath, null, 'no archivePath surfaced for a failed apply');
  assert.equal(r.manifestPath, null, 'no manifestPath surfaced for a failed apply');
  // The honest fields (id + counts) are still reported.
  assert.equal(r.snapshotId, '2026-05-27T00-00-00Z');
  assert.equal(r.keptCount, 1);
});

test('snapshotCommand D3: a SUCCESSFUL --apply still surfaces both paths', async () => {
  // Guardrail: the null-on-failure logic must not strip paths from a successful apply.
  const loadPaths = () => Promise.resolve({ assertWritable: (p) => p });
  const createFn = () => Promise.resolve({
    ok: true,
    snapshotId: '2026-05-27T00-00-00Z',
    archivePath: 'C:\\state\\snapshots\\id\\files.tar',
    manifestPath: 'C:\\state\\snapshots\\id\\manifest.json',
    kept: ['agents/a.md'], dropped: [], fileCount: 1, diagnostics: [],
  });
  const out = await snapshotCommand(
    { configDir: '/cfg', mgrStateDir: '/cfg/.mgr-state', args: { apply: true } },
    // env factor present so the gate opens and the successful createFn is reached.
    { loadPaths, createFn, env: { HARNESS_MGR_ENABLE_WRITES: '1' } },
  );
  assert.equal(out.result.ok, true);
  assert.ok(out.result.archivePath.endsWith('files.tar'));
  assert.ok(out.result.manifestPath.endsWith('manifest.json'));
});

// ── snapshotListCommand (read-only) ───────────────────────────────────────────────

test('snapshotListCommand: surfaces the store list + count (via injected listFn)', () => {
  const listFn = ({ mgrStateDir }) => {
    assert.equal(mgrStateDir, '/cfg/.mgr-state', 'mgrStateDir threaded to the store');
    return {
      snapshots: [
        { id: '2026-05-25T10-00-00Z', createdAt: 'c2', reason: 'r2', fileCount: 5, complete: true },
        { id: '2026-05-20T10-00-00Z', complete: false },
      ],
      diagnostics: [],
    };
  };
  const out = snapshotListCommand({ mgrStateDir: '/cfg/.mgr-state', args: {} }, { listFn });
  assert.equal(out.result.count, 2);
  assert.equal(out.result.snapshots[0].id, '2026-05-25T10-00-00Z');
  assert.equal(out.result.snapshots[1].complete, false);
  assert.deepEqual(out.diagnostics, []);
});

test('snapshotListCommand: passes store diagnostics through; never throws on a junk ctx', () => {
  const listFn = () => ({ snapshots: [], diagnostics: [{ severity: 'warn', code: 'snapshot-list-unreadable', message: 'x', phase: 'snapshot' }] });
  const out = snapshotListCommand({}, { listFn });
  assert.equal(out.result.count, 0);
  assert.ok(out.diagnostics.some((d) => d.code === 'snapshot-list-unreadable'));
});

// ── snapshotGcCommand: dry-run vs --apply via the injected gcFn ───────────────────

test('snapshotGcCommand: dry-run (default) → mode dry-run, wouldDelete surfaced, apply=false to store', () => {
  const calls = [];
  const gcFn = (o) => {
    calls.push(o);
    return { deleted: [], wouldDelete: ['2026-05-20T10-00-00Z'], retained: ['2026-05-25T10-00-00Z'], diagnostics: [] };
  };
  const out = snapshotGcCommand({ mgrStateDir: '/cfg/.mgr-state', args: { keep: '1' } }, { gcFn });
  assert.equal(out.result.mode, 'dry-run');
  assert.deepEqual(out.result.wouldDelete, ['2026-05-20T10-00-00Z']);
  assert.deepEqual(out.result.deleted, []);
  assert.equal(out.result.wouldDeleteCount, 1);
  assert.equal(out.result.retainedCount, 1);
  // store received apply:false + the coerced keep:1.
  assert.equal(calls[0].apply, false);
  assert.equal(calls[0].keep, 1);
  assert.equal(calls[0].mgrStateDir, '/cfg/.mgr-state');
});

test('snapshotGcCommand: --apply → mode applied, deleted surfaced, apply=true to store', () => {
  const calls = [];
  const gcFn = (o) => {
    calls.push(o);
    return { deleted: ['2026-05-20T10-00-00Z'], wouldDelete: [], retained: ['2026-05-25T10-00-00Z'], diagnostics: [] };
  };
  // env factor present so the two-factor gate opens and gcFn (the real delete) runs.
  const out = snapshotGcCommand(
    { mgrStateDir: '/cfg/.mgr-state', args: { keep: '1', apply: true } },
    { gcFn, env: { HARNESS_MGR_ENABLE_WRITES: '1' } },
  );
  assert.equal(out.result.mode, 'applied');
  assert.deepEqual(out.result.deleted, ['2026-05-20T10-00-00Z']);
  assert.equal(out.result.deletedCount, 1);
  assert.equal(calls[0].apply, true);
});

test('snapshotGcCommand: --apply + env=0 CLOSED → code 3 writes-disabled-env, gcFn NEVER called', () => {
  // The load-bearing new oracle for gc: env=0 is the explicit opt-out lock.
  // With it set to '0', the BOUNDED delete (gcFn) must never run.
  const calls = [];
  const gcFn = (o) => { calls.push(o); return { deleted: ['x'], wouldDelete: [], retained: [], diagnostics: [] }; };
  const out = snapshotGcCommand(
    { mgrStateDir: '/cfg/.mgr-state', args: { keep: '1', apply: true } },
    { gcFn, env: { HARNESS_MGR_ENABLE_WRITES: '0' } }, // explicit opt-out lock
  );
  assert.equal(out.code, 3, 'a closed gate refuses with code 3');
  assert.equal(out.result.mode, 'applied');
  assert.deepEqual(out.result.deleted, [], 'nothing deleted when the gate is closed');
  assert.equal(out.result.deletedCount, 0);
  assert.ok(
    out.diagnostics.some((d) => d.code === 'writes-disabled-env' && d.severity === 'error'),
    JSON.stringify(out.diagnostics),
  );
  assert.equal(calls.length, 0, 'gcFn must NOT run when the env gate is closed');
});

test('snapshotGcCommand: --apply + env=0 CLOSED still surfaces a keep/older-than coercion warn', () => {
  // The env refusal must NOT swallow a flag-coercion warn (preDiags are preserved).
  const gcFn = () => { throw new Error('gcFn must NOT run when the env gate is closed'); };
  const out = snapshotGcCommand(
    { mgrStateDir: '/s', args: { keep: 'abc', apply: true } }, // invalid --keep + closed gate
    { gcFn, env: { HARNESS_MGR_ENABLE_WRITES: '0' } },
  );
  assert.equal(out.code, 3);
  assert.ok(out.diagnostics.some((d) => d.code === 'gc-keep-invalid' && d.severity === 'warn'), 'the coercion warn survives the refusal');
  assert.ok(out.diagnostics.some((d) => d.code === 'writes-disabled-env' && d.severity === 'error'));
});

test('snapshotGcCommand: dry-run (no --apply) is UNAFFECTED by a closed env gate', () => {
  // No --apply → the env factor is irrelevant; the dry-run preview still runs.
  const calls = [];
  const gcFn = (o) => { calls.push(o); return { deleted: [], wouldDelete: ['2026-05-20T10-00-00Z'], retained: [], diagnostics: [] }; };
  const out = snapshotGcCommand(
    { mgrStateDir: '/s', args: { keep: '1' } }, // no apply
    { gcFn, env: {} },
  );
  assert.equal(out.result.mode, 'dry-run');
  assert.equal(calls.length, 1, 'the dry-run gc still runs with a closed env gate');
  assert.equal(calls[0].apply, false);
  assert.ok(!out.diagnostics.some((d) => d.code === 'writes-disabled-env'), 'no env refusal on a dry-run');
});

test('snapshotGcCommand: --older-than is parsed via parseSince into olderThanMs', () => {
  const calls = [];
  const gcFn = (o) => { calls.push(o); return { deleted: [], wouldDelete: [], retained: [], diagnostics: [] }; };
  snapshotGcCommand({ mgrStateDir: '/s', args: { 'older-than': '2d' } }, { gcFn });
  assert.equal(calls[0].olderThanMs, 2 * 86400000); // 2 days in ms
  assert.equal(calls[0].keep, undefined); // no --keep given
});

test('snapshotGcCommand: an invalid --older-than → gc-older-than-invalid warn, criterion dropped', () => {
  const calls = [];
  const gcFn = (o) => { calls.push(o); return { deleted: [], wouldDelete: [], retained: [], diagnostics: [] }; };
  const out = snapshotGcCommand({ mgrStateDir: '/s', args: { 'older-than': 'nope' } }, { gcFn });
  assert.ok(out.diagnostics.some((d) => d.code === 'gc-older-than-invalid' && d.severity === 'warn'));
  assert.equal(calls[0].olderThanMs, undefined); // invalid → not passed
});

test('snapshotGcCommand: an invalid --keep → gc-keep-invalid warn, criterion dropped', () => {
  const calls = [];
  const gcFn = (o) => { calls.push(o); return { deleted: [], wouldDelete: [], retained: [], diagnostics: [] }; };
  const out = snapshotGcCommand({ mgrStateDir: '/s', args: { keep: '-3' } }, { gcFn });
  assert.ok(out.diagnostics.some((d) => d.code === 'gc-keep-invalid' && d.severity === 'warn'));
  assert.equal(calls[0].keep, undefined);
});

test('snapshotGcCommand: both --keep and --older-than reach the store (intersection is the store\'s job)', () => {
  const calls = [];
  const gcFn = (o) => { calls.push(o); return { deleted: [], wouldDelete: [], retained: [], diagnostics: [] }; };
  snapshotGcCommand({ mgrStateDir: '/s', args: { keep: '3', 'older-than': '1w' } }, { gcFn });
  assert.equal(calls[0].keep, 3);
  assert.equal(calls[0].olderThanMs, 7 * 86400000);
});

test('snapshotGcCommand: never throws on a missing args object', () => {
  const gcFn = () => ({ deleted: [], wouldDelete: [], retained: [], diagnostics: [{ severity: 'warn', code: 'gc-no-criterion', message: 'x', phase: 'snapshot' }] });
  assert.doesNotThrow(() => {
    const out = snapshotGcCommand({ mgrStateDir: '/s' }, { gcFn });
    assert.equal(out.result.mode, 'dry-run');
  });
});
