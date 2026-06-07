/**
 * P4b.U5 — integration/update-roundtrip.test.mjs
 *
 * The docs/phase-4b-update-design.md §9 update-roundtrip DoD oracle: proves the
 * `update <plugin> --apply` delegation path end-to-end against a REAL temp
 * `~/.claude`-like tree, using the REAL governed-write gate (src/paths.mjs::
 * assertWritable, resolved via CLAUDE_CONFIG_DIR) and the REAL system tar inside
 * createSnapshot — but with a FAKE spawn so the real `claude` binary is NEVER run.
 *
 * It proves:
 *   - HAPPY ROUNDTRIP (--apply): the auto-snapshot of the governed surface runs
 *     FIRST (the undo point) — a real snapshot dir with files.tar + manifest.json,
 *     whose manifest records plugins/installed_plugins.json with a preSha256 ==
 *     the ON-DISK bytes (→ a faithful undo point) — THEN the delegated update is
 *     handed to the (fake) spawn with the EXACT argv ['plugin','update', <key>]
 *     and the resolved fake exe;
 *   - NOT-FOUND: an unknown spec is a clean refusal — no snapshot, no spawn;
 *   - DRY-RUN (no enableWrites): previews only — no snapshot, no spawn.
 *
 * Uses the REAL gate (CLAUDE_CONFIG_DIR=temp, restored in a finally) because the
 * whole point is to exercise the actual 'apply' snapshot-write decision against the
 * real gate, end-to-end from the command-level updatePlugin. The spawn is the ONLY
 * faked seam (delegating to the real `claude` would touch the network + git); the
 * resolveClaudeFn is also faked so the test never depends on a real claude install.
 *
 * GRACEFUL-SKIP when the system tar is unavailable (mirrors remove-roundtrip).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { updatePlugin } from '../../src/ops/update.mjs';
import { resolveTar } from '../../src/ops/snapshot-tar.mjs';
import { assertWritable } from '../../src/paths.mjs';

function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/** Write a file at a POSIX-relative path under base, creating parent dirs. */
function put(base, rel, bytes) {
  const abs = join(base, ...rel.split('/'));
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, bytes);
}

/** Count the snapshot directories under <stateDir>/snapshots (0 when absent). */
function snapshotCount(stateDir) {
  const dir = join(stateDir, 'snapshots');
  if (!existsSync(dir)) return 0;
  return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).length;
}

/** A FAKE resolveClaudeExe seam: returns process.execPath (absolute + exists) as
 *  the spawnable exe, so even a real spawnability check would pass. */
function fakeResolveClaude() {
  return () => ({ exe: process.execPath, kind: 'native', diagnostics: [] });
}

/** A FAKE spawnFn that RECORDS the spec it was called with and resolves cleanly —
 *  the real `claude` is NEVER run. */
function makeFakeSpawn() {
  /** @type {{calls: any[]}} */
  const rec = { calls: [] };
  const spawnFn = async (spec) => {
    rec.calls.push(spec);
    return { stdout: '', stderr: '' };
  };
  return { spawnFn, rec };
}

/** Build a temp governed ~/.claude tree with a fixture installed_plugins.json plus
 *  a couple of unrelated governed files so the snapshot has real content. Returns
 *  the dir paths + the on-disk sha of installed_plugins.json. */
function makeTree() {
  const tmp = mkdtempSync(join(tmpdir(), 'mgr-update-'));
  const stateDir = join(tmp, '.mgr-state');
  mkdirSync(stateDir, { recursive: true });

  const installed = {
    version: 2,
    plugins: {
      'demo-plugin@demo-mkt': [
        { name: 'demo-plugin', marketplace: 'demo-mkt', version: '1.0.0', scope: 'user' },
      ],
    },
  };
  const installedBytes = Buffer.from(JSON.stringify(installed, null, 2) + '\n', 'utf8');
  put(tmp, 'plugins/installed_plugins.json', installedBytes);
  put(tmp, 'agents/keep.md', Buffer.from('---\nname: keep\n---\n# agent keep\n', 'utf8'));
  put(tmp, 'settings.json', Buffer.from('{}\n', 'utf8'));

  return { tmp, stateDir, installedSha: sha256Hex(installedBytes) };
}

test('update-roundtrip: --apply snapshots installed_plugins.json then delegates the exact argv', async (t) => {
  const { tarPath, diagnostics } = resolveTar();
  if (!tarPath) {
    t.skip(`system tar not found (${diagnostics.map((d) => d.code).join(',')}) — skipping update round-trip`);
    return;
  }

  const saved = process.env.CLAUDE_CONFIG_DIR;
  const { tmp, stateDir, installedSha } = makeTree();
  // The REAL gate resolves the governed dir from CLAUDE_CONFIG_DIR (read at call time).
  process.env.CLAUDE_CONFIG_DIR = tmp;
  const { spawnFn, rec } = makeFakeSpawn();

  try {
    const r = await updatePlugin({
      spec: 'demo-plugin@demo-mkt', targetClaudeDir: tmp, mgrStateDir: stateDir,
      assertWritable, enableWrites: true,
      seams: { spawnFn, resolveClaudeFn: fakeResolveClaude() },
    });

    // The delegation succeeded (real snapshot + fake spawn), not a dry-run.
    assert.equal(r.ok, true, `--apply failed: ${JSON.stringify(r.diagnostics)}`);
    assert.equal(r.spawned, true);
    assert.equal(r.dryRun, false);

    // A REAL snapshot exists: exactly one snapshot dir with files.tar + manifest.json.
    const snapsDir = join(stateDir, 'snapshots');
    assert.ok(existsSync(snapsDir), 'snapshots/ dir must exist after --apply');
    const snapIds = readdirSync(snapsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory()).map((e) => e.name);
    assert.equal(snapIds.length, 1, `exactly one snapshot expected, found: ${snapIds.join(', ')}`);
    const snapDir = join(snapsDir, snapIds[0]);
    assert.ok(existsSync(join(snapDir, 'files.tar')), 'files.tar must exist');
    assert.ok(existsSync(join(snapDir, 'manifest.json')), 'manifest.json must exist');

    // The manifest records installed_plugins.json with preSha256 == on-disk bytes
    // (→ a faithful undo point).
    const manifest = JSON.parse(readFileSync(join(snapDir, 'manifest.json'), 'utf8'));
    const entry = manifest.files.find((f) => f.path === 'plugins/installed_plugins.json');
    assert.ok(entry, 'manifest must record plugins/installed_plugins.json');
    assert.equal(entry.preSha256, installedSha,
      'snapshot must have captured the on-disk installed_plugins.json bytes');

    // The fake spawn was called EXACTLY once with the exact delegated argv + fake exe.
    assert.equal(rec.calls.length, 1, 'the delegated spawn must be called exactly once');
    assert.deepEqual(rec.calls[0].args, ['plugin', 'update', 'demo-plugin@demo-mkt'],
      'delegated argv must be [plugin, update, <key>]');
    assert.equal(rec.calls[0].exe, process.execPath, 'spawn must use the resolved fake exe');

    // The result mirrors the delegated command + carries the snapshot id.
    assert.deepEqual(r.command, ['plugin', 'update', 'demo-plugin@demo-mkt']);
    assert.equal(r.snapshotId, snapIds[0], 'result snapshotId must match the on-disk snapshot');
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

test('update-roundtrip: unknown plugin → refuse, no snapshot, no spawn', async (t) => {
  const { tarPath } = resolveTar();
  if (!tarPath) { t.skip('system tar not found — skipping'); return; }

  const saved = process.env.CLAUDE_CONFIG_DIR;
  const { tmp, stateDir } = makeTree();
  process.env.CLAUDE_CONFIG_DIR = tmp;
  const { spawnFn, rec } = makeFakeSpawn();

  try {
    const before = snapshotCount(stateDir);
    const r = await updatePlugin({
      spec: 'does-not-exist', targetClaudeDir: tmp, mgrStateDir: stateDir,
      assertWritable, enableWrites: true,
      seams: { spawnFn, resolveClaudeFn: fakeResolveClaude() },
    });

    assert.equal(r.refused, true, 'unknown plugin must be refused');
    assert.ok(r.diagnostics.some((d) => d.code === 'update-plugin-not-found'),
      `expected update-plugin-not-found, got: ${JSON.stringify(r.diagnostics.map((d) => d.code))}`);
    assert.equal(rec.calls.length, 0, 'spawn must NEVER be called on a not-found refusal');
    // No new snapshot dir was created by this refused call.
    assert.equal(snapshotCount(stateDir), before, 'a refused update must NOT create a snapshot');
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

test('update-roundtrip: dry-run (no enableWrites) writes nothing, never spawns', async (t) => {
  const { tarPath } = resolveTar();
  if (!tarPath) { t.skip('system tar not found — skipping'); return; }

  const saved = process.env.CLAUDE_CONFIG_DIR;
  const { tmp, stateDir } = makeTree();
  process.env.CLAUDE_CONFIG_DIR = tmp;
  const { spawnFn, rec } = makeFakeSpawn();

  try {
    const r = await updatePlugin({
      spec: 'demo-plugin@demo-mkt', targetClaudeDir: tmp, mgrStateDir: stateDir,
      seams: { spawnFn, resolveClaudeFn: fakeResolveClaude() },
    });

    assert.equal(r.ok, true, `dry-run failed: ${JSON.stringify(r.diagnostics)}`);
    assert.equal(r.dryRun, true, 'no enableWrites → dry-run');
    assert.equal(rec.calls.length, 0, 'dry-run must NEVER spawn');
    // dry-run created no snapshot under .mgr-state.
    assert.ok(!existsSync(join(stateDir, 'snapshots')), 'dry-run must NOT create a snapshot');
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});
