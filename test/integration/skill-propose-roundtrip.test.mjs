/**
 * P5.U8 (sub-unit C) — test/integration/skill-propose-roundtrip.test.mjs
 *
 * THE HEADLINE ORACLE (docs/viewpoint-review-2026-06-02.md §5 line 224, design §1
 * core invariant): dry-run → unified diff → `--apply` writes ONLY the `.proposed`
 * file → the original `SKILL.md` is BYTE-IDENTICAL before and after.
 *
 * End-to-end CLI integration test driven through run(argv) from src/cli.mjs with NO
 * injected seams — the REAL governed-write gate (src/paths.mjs::assertWritable,
 * resolved via CLAUDE_CONFIG_DIR) and the REAL atomic write. (No system tar needed —
 * propose takes NO auto-snapshot, design §5 #5.)
 *
 * Four legs:
 *   (a) DRY-RUN: run(['skill','propose','foo','--from',f,'--format','json'])
 *       → code 0; result.unified shows the expected -/+ lines; the WHOLE config tree
 *         (incl. .mgr-state) is byte-identical before/after (walk+hash → zero writes).
 *   (b) APPLY (env HARNESS_MGR_ENABLE_WRITES deleted): run([...,'--apply'])
 *       → code 0; EXACTLY one new file skills/foo/SKILL.proposed-<ts>.md whose bytes
 *         === the proposed bytes; SKILL.md byte-identical to before (THE invariant);
 *         provenance .mgr-state/proposals/foo-<ts>.json exists with sourceSha256 ===
 *         sha256(original) and proposedSha256 === sha256(proposed); zero *.mgr-new /
 *         *.mgr-old residue anywhere.
 *   (c) APPLY no-change (--from identical to SKILL.md) → exit 2, propose-no-change,
 *       nothing new on disk.
 *   (d) GATE-LOCKED apply (env='0') → exit 3, nothing written.
 *
 * All assertions are falsifiable fs reads + Buffer.compare (not just "code 0").
 * Sets process.env.CLAUDE_CONFIG_DIR; saves + restores CLAUDE_CONFIG_DIR and
 * HARNESS_MGR_ENABLE_WRITES in a finally block.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { run } from '../../src/cli.mjs';

function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/** Write a file at a POSIX-relative path under base, creating parent dirs. */
function put(base, rel, bytes) {
  const abs = join(base, ...rel.split('/'));
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, bytes);
}

/** Recursive map relpath → sha256 of every file under dir (for the zero-write oracle). */
function hashTree(dir) {
  /** @type {Record<string,string>} */
  const out = Object.create(null);
  const walk = (d, prefix) => {
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      const abs = join(d, ent.name);
      const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
      if (ent.isDirectory()) walk(abs, rel);
      else out[rel] = sha256Hex(readFileSync(abs));
    }
  };
  walk(dir, '');
  return out;
}

/** Every absolute file path under dir (for the residue scan). */
function allFilePaths(dir) {
  /** @type {string[]} */
  const out = [];
  const walk = (d) => {
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      const abs = join(d, ent.name);
      if (ent.isDirectory()) walk(abs);
      else out.push(abs);
    }
  };
  walk(dir);
  return out;
}

test('skill propose CLI roundtrip: dry-run → apply (only .proposed written, SKILL.md untouched) → no-change → gate-locked', async () => {
  const savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
  const savedEnableWrites = process.env.HARNESS_MGR_ENABLE_WRITES;
  const tmp = mkdtempSync(join(tmpdir(), 'cmgr-propose-cli-'));
  const stateDir = join(tmp, '.mgr-state');
  // A --from source OUTSIDE the config dir (design §1: content comes from the user).
  const fromFile = join(mkdtempSync(join(tmpdir(), 'cmgr-propose-src-')), 'proposed.md');

  try {
    // ── BUILD the live tree ────────────────────────────────────────────────────
    const originalBytes = Buffer.from('# skill foo\nline2\nline3\nline4\nline5\nline6\nline7\n', 'utf8');
    const proposedBytes = Buffer.from('# skill foo\nline2-CHANGED\nline3\nline4-NEW\nline4\nline5\nline6\nline7\n', 'utf8');

    put(tmp, 'skills/foo/SKILL.md', originalBytes);
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(fromFile, proposedBytes);

    const originalSha = sha256Hex(originalBytes);
    const proposedSha = sha256Hex(proposedBytes);

    process.env.CLAUDE_CONFIG_DIR = tmp;

    // ── LEG (a): DRY-RUN — writes NOTHING ─────────────────────────────────────
    delete process.env.HARNESS_MGR_ENABLE_WRITES;
    const treeBefore = hashTree(tmp);

    const dry = await run(['skill', 'propose', 'foo', '--from', fromFile, '--format', 'json', '--config-dir', tmp]);
    assert.equal(dry.code, 0, `dry-run expected code 0, got ${dry.code}; stdout: ${dry.stdout.slice(0, 400)}`);
    const dryJson = JSON.parse(dry.stdout);
    assert.equal(dryJson.command, 'skill:propose');
    assert.equal(dryJson.result.status, 'dry-run');
    assert.equal(dryJson.result.changed, true);
    assert.ok(dryJson.result.unified.includes('-line2'), 'unified must show the removed line2');
    assert.ok(dryJson.result.unified.includes('+line2-CHANGED'), 'unified must show the added line2-CHANGED');
    assert.ok(dryJson.result.unified.includes('+line4-NEW'), 'unified must show the inserted line4-NEW');

    // The WHOLE tree (incl. .mgr-state) is byte-identical — dry-run wrote nothing.
    assert.deepEqual(hashTree(tmp), treeBefore, 'dry-run must write NOTHING under the config tree');

    // ── LEG (b): APPLY — writes ONLY the .proposed file ───────────────────────
    // The off-ramp relaxed the gate: --apply alone enables (env deleted = not locked).
    delete process.env.HARNESS_MGR_ENABLE_WRITES;

    const apply = await run(['skill', 'propose', 'foo', '--from', fromFile, '--apply', '--format', 'json', '--config-dir', tmp]);
    assert.equal(apply.code, 0, `apply expected code 0, got ${apply.code}; stdout: ${apply.stdout.slice(0, 400)}`);
    const applyJson = JSON.parse(apply.stdout);
    assert.equal(applyJson.result.status, 'proposed');
    const proposalId = applyJson.result.proposalId;
    assert.match(proposalId, /^SKILL\.proposed-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\.md$/, 'proposalId must be the SKILL.proposed-<ts>.md shape');

    // THE INVARIANT: the original SKILL.md is byte-identical to before.
    assert.ok(
      Buffer.compare(readFileSync(join(tmp, 'skills', 'foo', 'SKILL.md')), originalBytes) === 0,
      'SKILL.md must be byte-identical before and after --apply',
    );

    // EXACTLY one new file under skills/foo/: the .proposed file with the proposed bytes.
    const skillDirEntries = readdirSync(join(tmp, 'skills', 'foo')).sort();
    assert.deepEqual(skillDirEntries, ['SKILL.md', proposalId].sort(),
      `skills/foo must contain exactly SKILL.md + the proposal, got: ${skillDirEntries.join(', ')}`);
    assert.ok(
      Buffer.compare(readFileSync(join(tmp, 'skills', 'foo', proposalId)), proposedBytes) === 0,
      'the .proposed file bytes must equal the --from proposed bytes',
    );

    // Provenance record exists with the right shas.
    const ts = proposalId.replace(/^SKILL\.proposed-/, '').replace(/\.md$/, '');
    const provPath = join(stateDir, 'proposals', `foo-${ts}.json`);
    assert.ok(existsSync(provPath), `provenance record must exist at ${provPath}`);
    const prov = JSON.parse(readFileSync(provPath, 'utf8'));
    assert.equal(prov.sourceSha256, originalSha, 'provenance.sourceSha256 must equal sha256(original SKILL.md)');
    assert.equal(prov.proposedSha256, proposedSha, 'provenance.proposedSha256 must equal sha256(proposed bytes)');
    assert.equal(prov.name, 'foo');
    assert.equal(prov.kind, 'skill');

    // No atomic-write sidecar residue anywhere.
    const residue = allFilePaths(tmp).filter((p) => /\.mgr-(new|old)$/.test(p));
    assert.deepEqual(residue, [], `no .mgr-new/.mgr-old residue expected, found: ${residue.join(', ')}`);

    // ── LEG (c): APPLY no-change (--from == SKILL.md) → exit 2, nothing new ────
    const identicalFrom = join(mkdtempSync(join(tmpdir(), 'cmgr-propose-id-')), 'same.md');
    writeFileSync(identicalFrom, originalBytes);
    const beforeNoChange = allFilePaths(tmp).sort();
    const noChange = await run(['skill', 'propose', 'foo', '--from', identicalFrom, '--apply', '--format', 'json', '--config-dir', tmp]);
    assert.equal(noChange.code, 2, `no-change apply expected code 2, got ${noChange.code}; stdout: ${noChange.stdout.slice(0, 400)}`);
    const noChangeJson = JSON.parse(noChange.stdout);
    assert.ok(noChangeJson.diagnostics.some((d) => d.code === 'propose-no-change'), 'expected propose-no-change');
    assert.deepEqual(allFilePaths(tmp).sort(), beforeNoChange, 'no-change apply must add nothing on disk');

    // ── LEG (d): GATE-LOCKED apply (env=0) → exit 3, nothing written ──────────
    process.env.HARNESS_MGR_ENABLE_WRITES = '0';
    const beforeLocked = allFilePaths(tmp).sort();
    const locked = await run(['skill', 'propose', 'foo', '--from', fromFile, '--apply', '--format', 'json', '--config-dir', tmp]);
    assert.equal(locked.code, 3, `gate-locked apply expected code 3, got ${locked.code}; stdout: ${locked.stdout.slice(0, 400)}`);
    const lockedJson = JSON.parse(locked.stdout);
    assert.ok(lockedJson.diagnostics.some((d) => d.code === 'writes-disabled-env'), 'expected writes-disabled-env');
    assert.deepEqual(allFilePaths(tmp).sort(), beforeLocked, 'gate-locked apply must write nothing');
  } finally {
    if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
    if (savedEnableWrites === undefined) delete process.env.HARNESS_MGR_ENABLE_WRITES;
    else process.env.HARNESS_MGR_ENABLE_WRITES = savedEnableWrites;
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
    try { rmSync(join(fromFile, '..'), { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});
