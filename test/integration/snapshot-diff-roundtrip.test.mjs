/**
 * snapshot-diff-roundtrip — end-to-end `config diff <idA> <idB> [relpath]` over two
 * REAL snapshots, driven through run(argv) from src/cli.mjs.
 *
 * This is the acceptance oracle for the snapshot-to-snapshot diff feature: it uses
 * the REAL governed-write gate (src/paths.mjs::assertWritable, resolved via
 * CLAUDE_CONFIG_DIR) and the REAL system tar to CREATE two snapshots, then drives
 * the production `config diff` snapshot path (no injected seams) and asserts the
 * actual diff output. The hermetic ops/CLI unit tests inject seams and so never
 * exercise the real tar-extraction content path — THIS test does.
 *
 * Legs (all falsifiable — assert specific paths / lines, not just "code 0"):
 *   1. Create snapshot #1 of a small governed tree (CLAUDE.md + agents/a.md).
 *   2. Mutate CLAUDE.md (a.md left unchanged), create snapshot #2 (>1s later so the
 *      second-resolution ids are distinct).
 *   3. MANIFEST diff `config diff id1 id2` → mode 'manifest', CLAUDE.md in `modified`,
 *      agents/a.md NOT in modified, unchanged >= 1.
 *   4. CONTENT diff `config diff id1 id2 CLAUDE.md` → mode 'content', changed:true,
 *      the unified text shows -line2 / +LINE2-CHANGED / +line4-NEW.
 *   5. CONTENT diff of the UNCHANGED agents/a.md → changed:false.
 *
 * GRACEFUL-SKIP when the system tar is unavailable (mirrors the other Phase-3
 * acceptance oracles; the unconditional tar-available.test.mjs turns a tar-less
 * host's silent skips into a visible red). Saves + restores the two env vars.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveTar } from '../../src/ops/snapshot-tar.mjs';
import { run } from '../../src/cli.mjs';

/** Write a UTF-8 file at a POSIX-relative path under base, creating parent dirs. */
function put(base, rel, text) {
  const abs = join(base, ...rel.split('/'));
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, text, 'utf8');
}

/** Sorted snapshot id directory names under stateDir/snapshots ([] when absent). */
function snapshotIds(stateDir) {
  const d = join(stateDir, 'snapshots');
  if (!existsSync(d)) return [];
  return readdirSync(d, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/** Parse the JSON envelope from a run() stdout and return its `.result`. */
function resultOf(r) {
  return JSON.parse(r.stdout).result;
}

test('config diff snapshot roundtrip: manifest + content over two real snapshots', async (t) => {
  const { tarPath, diagnostics } = resolveTar();
  if (!tarPath) {
    t.skip(`system tar not found (${diagnostics.map((d) => d.code).join(',')}) — skipping snapshot-diff round-trip`);
    return;
  }

  const savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
  const savedEnable = process.env.CLAUDE_MGR_ENABLE_WRITES;
  const tmp = mkdtempSync(join(tmpdir(), 'cmgr-snapdiff-'));
  const stateDir = join(tmp, '.mgr-state');

  try {
    put(tmp, 'CLAUDE.md', 'line1\nline2\nline3\n');
    put(tmp, 'agents/a.md', '---\nname: a\n---\nbody\n');
    mkdirSync(stateDir, { recursive: true });

    // CLAUDE_CONFIG_DIR makes the REAL write gate resolve to our temp dir; the env
    // factor arms the two-factor write gate for `snapshot --apply`.
    process.env.CLAUDE_CONFIG_DIR = tmp;
    process.env.CLAUDE_MGR_ENABLE_WRITES = '1';

    // ── snapshot #1 ──────────────────────────────────────────────────────────────
    const s1 = await run(['snapshot', '--apply', '--reason', 's1', '--config-dir', tmp]);
    assert.equal(s1.code, 0, `snapshot #1 expected code 0; stdout: ${s1.stdout.slice(0, 400)}`);
    const after1 = snapshotIds(stateDir);
    assert.equal(after1.length, 1, 'exactly one snapshot after the first --apply');
    const id1 = after1[0];

    // Distinct second-resolution id for #2 (ids are YYYY-MM-DDTHH-MM-SSZ). A same-second
    // second snapshot would EEXIST-refuse → caught by the code/length asserts below.
    await new Promise((r) => setTimeout(r, 1100));

    // Mutate CLAUDE.md; leave agents/a.md unchanged.
    put(tmp, 'CLAUDE.md', 'line1\nLINE2-CHANGED\nline3\nline4-NEW\n');

    // ── snapshot #2 ──────────────────────────────────────────────────────────────
    const s2 = await run(['snapshot', '--apply', '--reason', 's2', '--config-dir', tmp]);
    assert.equal(s2.code, 0, `snapshot #2 expected code 0; stdout: ${s2.stdout.slice(0, 400)}`);
    const after2 = snapshotIds(stateDir);
    assert.equal(after2.length, 2, 'exactly two snapshots after the second --apply');
    const id2 = after2.find((x) => x !== id1);
    assert.ok(id2 && id2 !== id1, `distinct snapshot ids required (id1=${id1} id2=${id2})`);

    // ── LEG: MANIFEST diff ───────────────────────────────────────────────────────
    const mRes = await run(['config', 'diff', id1, id2, '--config-dir', tmp, '--format', 'json']);
    assert.equal(mRes.code, 0, `manifest diff expected code 0; stdout: ${mRes.stdout.slice(0, 400)}`);
    const m = resultOf(mRes);
    assert.equal(m.mode, 'manifest', `expected manifest mode, got ${m.mode}`);
    assert.ok(m.modified.includes('CLAUDE.md'),
      `CLAUDE.md must be in modified; modified=${JSON.stringify(m.modified)}`);
    assert.ok(!m.modified.includes('agents/a.md'),
      'agents/a.md was unchanged and must NOT be in modified');
    assert.ok(!m.added.includes('CLAUDE.md') && !m.removed.includes('CLAUDE.md'),
      'CLAUDE.md is a modification, not an add/remove');
    assert.ok(m.unchanged >= 1, `at least the unchanged agents/a.md must be counted; unchanged=${m.unchanged}`);

    // ── LEG: CONTENT diff of the modified file ───────────────────────────────────
    const cRes = await run(['config', 'diff', id1, id2, 'CLAUDE.md', '--config-dir', tmp, '--format', 'json']);
    assert.equal(cRes.code, 0, `content diff expected code 0; stdout: ${cRes.stdout.slice(0, 400)}`);
    const c = resultOf(cRes);
    assert.equal(c.mode, 'content', `expected content mode, got ${c.mode}`);
    assert.equal(c.changed, true, 'the modified file must report changed:true');
    assert.ok(c.stats.added >= 1 && c.stats.deleted >= 1,
      `expected both adds and deletes; stats=${JSON.stringify(c.stats)}`);
    assert.ok(c.unified.includes('-line2'), `unified must show the deleted line; unified=\n${c.unified}`);
    assert.ok(c.unified.includes('+LINE2-CHANGED'), 'unified must show the inserted LINE2-CHANGED');
    assert.ok(c.unified.includes('+line4-NEW'), 'unified must show the inserted line4-NEW');

    // ── LEG: CONTENT diff of an UNCHANGED file → changed:false ────────────────────
    const uRes = await run(['config', 'diff', id1, id2, 'agents/a.md', '--config-dir', tmp, '--format', 'json']);
    assert.equal(uRes.code, 0, `unchanged content diff expected code 0; stdout: ${uRes.stdout.slice(0, 400)}`);
    const u = resultOf(uRes);
    assert.equal(u.mode, 'content', `expected content mode, got ${u.mode}`);
    assert.equal(u.changed, false, 'an unchanged file must diff as changed:false');

    // No extraction temp-dir leak under tmpdir (the ops module cleans its os.tmpdir
    // dirs in a finally). The snapshot-diff temp prefix is cmgr-snapshot-diff-.
    const leaked = readdirSync(tmpdir(), { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith('cmgr-snapshot-diff-'))
      .map((e) => e.name);
    assert.deepEqual(leaked, [], `snapshot-diff must clean its extraction temp dirs; leaked: ${leaked.join(', ')}`);
  } finally {
    if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
    if (savedEnable === undefined) delete process.env.CLAUDE_MGR_ENABLE_WRITES;
    else process.env.CLAUDE_MGR_ENABLE_WRITES = savedEnable;
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});
