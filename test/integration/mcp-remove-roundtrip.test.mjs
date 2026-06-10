/**
 * P4b.U6 — integration/mcp-remove-roundtrip.test.mjs
 *
 * The docs/phase-4b-mcp-design.md §6 mcp-remove-roundtrip DoD oracle: proves the
 * `mcp remove <name> --scope project --apply` delegation path end-to-end against a
 * REAL temp `~/.claude`-like tree, using the REAL governed-write gate (src/paths.mjs::
 * assertWritable, resolved via CLAUDE_CONFIG_DIR) and the REAL system tar inside
 * createSnapshot — but with a FAKE spawn so the real `claude` binary is NEVER run.
 *
 * It proves:
 *   - HAPPY ROUNDTRIP (--apply): the auto-snapshot of the governed surface runs
 *     FIRST (the undo point) — a real snapshot dir with files.tar + manifest.json,
 *     whose manifest records `.mcp.json` with a preSha256 == the ON-DISK bytes
 *     (→ a faithful undo point) — THEN the delegated remove is handed to the (fake)
 *     spawn with the EXACT argv ['mcp','remove','foo','--scope','project'];
 *   - DRY-RUN (no enableWrites): previews only — no snapshot, no spawn.
 *
 * Uses the REAL gate (CLAUDE_CONFIG_DIR=temp, restored in a finally) because the
 * whole point is to exercise the actual 'apply' snapshot-write decision against the
 * real gate, end-to-end from the command-level mcpRemove. The spawn is the ONLY
 * faked seam (delegating to the real `claude` would mutate the real config); the
 * resolveClaudeFn is also faked so the test never depends on a real claude install.
 *
 * GRACEFUL-SKIP when the system tar is unavailable (mirrors update-roundtrip).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { mcpRemove } from '../../src/ops/mcp-write.mjs';
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

/** A FAKE resolveClaudeExe seam: returns process.execPath (absolute + exists). */
function fakeResolveClaude() {
  return () => ({ exe: process.execPath, kind: 'native', diagnostics: [] });
}

/** A FAKE spawnFn that RECORDS the spec and resolves cleanly — real `claude` never runs. */
function makeFakeSpawn() {
  const rec = { calls: [] };
  const spawnFn = async (spec) => { rec.calls.push(spec); return { stdout: '', stderr: '' }; };
  return { spawnFn, rec };
}

/** Build a temp governed ~/.claude tree with a `.mcp.json` server + unrelated files. */
function makeTree() {
  const tmp = mkdtempSync(join(tmpdir(), 'mgr-mcp-'));
  const stateDir = join(tmp, '.mgr-state');
  mkdirSync(stateDir, { recursive: true });

  const mcp = { mcpServers: { foo: { command: 'node', args: ['x'] } } };
  const mcpBytes = Buffer.from(JSON.stringify(mcp, null, 2) + '\n', 'utf8');
  put(tmp, '.mcp.json', mcpBytes);
  put(tmp, 'agents/keep.md', Buffer.from('---\nname: keep\n---\n# agent keep\n', 'utf8'));
  put(tmp, 'settings.json', Buffer.from('{}\n', 'utf8'));

  return { tmp, stateDir, mcpSha: sha256Hex(mcpBytes) };
}

test('mcp-remove-roundtrip: --apply snapshots .mcp.json then delegates the exact argv', async (t) => {
  const { tarPath, diagnostics } = resolveTar();
  if (!tarPath) {
    t.skip(`system tar not found (${diagnostics.map((d) => d.code).join(',')}) — skipping mcp remove round-trip`);
    return;
  }

  const saved = process.env.CLAUDE_CONFIG_DIR;
  const { tmp, stateDir, mcpSha } = makeTree();
  process.env.CLAUDE_CONFIG_DIR = tmp;
  const { spawnFn, rec } = makeFakeSpawn();

  try {
    const r = await mcpRemove({
      name: 'foo', scope: 'project', targetClaudeDir: tmp, mgrStateDir: stateDir,
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

    // The manifest records .mcp.json with preSha256 == on-disk bytes (faithful undo).
    const manifest = JSON.parse(readFileSync(join(snapDir, 'manifest.json'), 'utf8'));
    const entry = manifest.files.find((f) => f.path === '.mcp.json');
    assert.ok(entry, 'manifest must record .mcp.json');
    assert.equal(entry.preSha256, mcpSha, 'snapshot must have captured the on-disk .mcp.json bytes');

    // The fake spawn was called EXACTLY once with the exact delegated argv + fake exe.
    assert.equal(rec.calls.length, 1, 'the delegated spawn must be called exactly once');
    assert.deepEqual(rec.calls[0].args, ['mcp', 'remove', 'foo', '--scope', 'project'],
      'delegated argv must be [mcp, remove, foo, --scope, project]');
    assert.equal(rec.calls[0].exe, process.execPath, 'spawn must use the resolved fake exe');

    // The result mirrors the delegated command + carries the snapshot id.
    assert.deepEqual(r.command, ['mcp', 'remove', 'foo', '--scope', 'project']);
    assert.equal(r.snapshotId, snapIds[0], 'result snapshotId must match the on-disk snapshot');
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

test('mcp-remove-roundtrip: .mcp.json with token-shaped content is captured (skipSecretFilter)', async (t) => {
  // HEADLINE RED→GREEN oracle for the 2026-06-10 audit follow-up:
  // .mcp.json containing a ghp_-shaped token value was SILENTLY DROPPED by the
  // secret filter before skipSecretFilter:true was added — making the mcp-remove
  // delegation irreversible.  This test proves the manifest CAPTURES the file even
  // when its content triggers the content-sniff leg.
  //
  // RED pre-fix: with skipSecretFilter omitted, the manifest entry is absent.
  // GREEN post-fix: skipSecretFilter:true means the file is always captured.
  const { tarPath } = resolveTar();
  if (!tarPath) { t.skip('system tar not found — skipping'); return; }

  const saved = process.env.CLAUDE_CONFIG_DIR;
  const tmp = mkdtempSync(join(tmpdir(), 'mgr-mcp-secret-'));
  const stateDir = join(tmp, '.mgr-state');
  mkdirSync(stateDir, { recursive: true });

  // A token-shaped value (ghp_ + exactly 36 alphanum chars) inside .mcp.json —
  // triggers the content-sniff 'github-token' pattern.
  // Without skipSecretFilter:true the file would be DROPPED from the manifest.
  const TOKEN = 'ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'; // ghp_ + 36 A's
  const mcp = {
    mcpServers: {
      foo: { command: 'node', args: ['x'], env: { MCP_TOKEN: TOKEN } },
    },
  };
  const mcpBytes = Buffer.from(JSON.stringify(mcp, null, 2) + '\n', 'utf8');
  put(tmp, '.mcp.json', mcpBytes);
  put(tmp, 'agents/keep.md', Buffer.from('---\nname: keep\n---\n# agent keep\n', 'utf8'));
  put(tmp, 'settings.json', Buffer.from('{}\n', 'utf8'));
  process.env.CLAUDE_CONFIG_DIR = tmp;
  const { spawnFn, rec } = makeFakeSpawn();

  try {
    const r = await mcpRemove({
      name: 'foo', scope: 'project', targetClaudeDir: tmp, mgrStateDir: stateDir,
      assertWritable, enableWrites: true,
      seams: { spawnFn, resolveClaudeFn: fakeResolveClaude() },
    });

    assert.equal(r.ok, true, `--apply failed: ${JSON.stringify(r.diagnostics)}`);
    assert.equal(r.spawned, true, 'spawn must have been called');

    // The manifest MUST contain the token-content file — skipSecretFilter:true.
    const snapsDir = join(stateDir, 'snapshots');
    const snapIds = readdirSync(snapsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory()).map((e) => e.name);
    assert.equal(snapIds.length, 1, 'exactly one snapshot expected');
    const manifest = JSON.parse(readFileSync(join(snapsDir, snapIds[0], 'manifest.json'), 'utf8'));
    const entry = manifest.files.find((f) => f.path === '.mcp.json');
    assert.ok(
      entry,
      'manifest MUST capture .mcp.json even when it contains a token-shaped value ' +
      '(requires skipSecretFilter:true — this is the reversibility fix oracle)',
    );
    assert.equal(
      entry.preSha256,
      sha256Hex(mcpBytes),
      'captured preSha256 must match the on-disk bytes',
    );
    // spawn MUST still be called (not refused by cross-check)
    assert.equal(rec.calls.length, 1, 'spawn must be called exactly once');
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

test('mcp-remove-roundtrip: dry-run (no enableWrites) writes nothing, never spawns', async (t) => {
  const { tarPath } = resolveTar();
  if (!tarPath) { t.skip('system tar not found — skipping'); return; }

  const saved = process.env.CLAUDE_CONFIG_DIR;
  const { tmp, stateDir } = makeTree();
  process.env.CLAUDE_CONFIG_DIR = tmp;
  const { spawnFn, rec } = makeFakeSpawn();

  try {
    const before = snapshotCount(stateDir);
    const r = await mcpRemove({
      name: 'foo', scope: 'project', targetClaudeDir: tmp, mgrStateDir: stateDir,
      seams: { spawnFn, resolveClaudeFn: fakeResolveClaude() },
    });

    assert.equal(r.ok, true, `dry-run failed: ${JSON.stringify(r.diagnostics)}`);
    assert.equal(r.dryRun, true, 'no enableWrites → dry-run');
    assert.equal(rec.calls.length, 0, 'dry-run must NEVER spawn');
    assert.equal(snapshotCount(stateDir), before, 'dry-run must NOT create a snapshot');
    assert.ok(!existsSync(join(stateDir, 'snapshots')), 'dry-run must NOT create a snapshots dir');
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});
