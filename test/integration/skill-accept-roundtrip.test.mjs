/**
 * P5.U9 (sub-unit C) — test/integration/skill-accept-roundtrip.test.mjs
 *
 * THE HEADLINE ORACLE (design §7): propose → accept round-trip end-to-end through
 * run(argv) from src/cli.mjs with NO injected seams — the REAL governed-write gate
 * (src/paths.mjs::assertWritable, resolved via CLAUDE_CONFIG_DIR), the REAL atomic
 * write/delete, and the REAL system tar (the snapshot). The propose step exercises
 * U8 too (it creates a REAL proposal + provenance).
 *
 * Legs:
 *   (a) DRY-RUN accept → exit 0, result.stale:false, WHOLE tree byte-identical
 *       before/after (zero writes).
 *   (b) APPLY accept → exit 0; SKILL.md bytes now === the proposed bytes; the
 *       accepted SKILL.proposed-<ts>.md GONE; its provenance .mgr-state/proposals/
 *       foo-<ts>.json GONE; a snapshot exists whose manifest preSha256 for
 *       skills/foo/SKILL.md === the ORIGINAL bytes (the undo point); then
 *       rollback <id> --apply restores SKILL.md to ORIGINAL byte-identical AND
 *       re-creates the deleted proposal byte-identical; zero .mgr-new/.mgr-old residue.
 *   (c) STALE: propose again, MUTATE SKILL.md on disk, accept --apply WITHOUT --force
 *       → exit 2 accept-stale, nothing written; WITH --force → applied.
 *   (d) AMBIGUOUS: two proposals present, accept with NO id → exit 2 accept-ambiguous,
 *       message lists both, nothing written. The second proposal is created BY HAND
 *       (the propose engine names proposals by wall-clock ts, so two run()-driven
 *       proposes in one second collide — design §7(d) sanctioned simulation).
 *
 * All assertions are falsifiable fs reads + Buffer.compare. tar-gated: skips cleanly
 * if the system tar is absent (so a tar-less CI host stays green).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { run } from '../../src/cli.mjs';
import { resolveTar } from '../../src/ops/snapshot-tar.mjs';

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

/** Every absolute file path under dir (for the residue scan + nothing-written checks). */
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

/** Wait past a wall-clock second boundary so the NEXT createSnapshot gets a distinct
 *  second-resolution id. snapshot ids are UTC-second-resolution (makeSnapshotId), so
 *  two `accept --apply` snapshots in the same second collide → snapshot-id-collision
 *  (the CORRECT production refusal — never overwrite a prior snapshot). Waiting >1000ms
 *  guarantees floor(seconds) advances by ≥1, so the ids differ. */
async function tickPastSecond() {
  await new Promise((r) => setTimeout(r, 1100));
}

/** Drive a propose --apply and return its resolved proposalId. */
async function proposeApply(tmp, fromFile) {
  const r = await run(['skill', 'propose', 'foo', '--from', fromFile, '--apply', '--format', 'json', '--config-dir', tmp]);
  assert.equal(r.code, 0, `propose --apply expected code 0, got ${r.code}; stdout: ${r.stdout.slice(0, 400)}`);
  const j = JSON.parse(r.stdout);
  assert.equal(j.result.status, 'proposed', `propose status should be 'proposed': ${r.stdout.slice(0, 400)}`);
  return j.result.proposalId;
}

const tarAvailable = (() => {
  try { return !!resolveTar().tarPath; } catch { return false; }
})();

test('skill accept CLI roundtrip: dry-run → apply (overwrite + reversible) → stale → ambiguous', { skip: tarAvailable ? false : 'system tar not available' }, async () => {
  const savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
  const savedEnableWrites = process.env.HARNESS_MGR_ENABLE_WRITES;
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'cmgr-accept-cli-')));
  const stateDir = join(tmp, '.mgr-state');
  const srcDir = mkdtempSync(join(tmpdir(), 'cmgr-accept-src-'));
  const fromFile = join(srcDir, 'proposed.md');

  try {
    // ── BUILD the live tree ────────────────────────────────────────────────────
    const originalBytes = Buffer.from('# skill foo\nline2\nline3\nline4\nline5\n', 'utf8');
    const proposedBytes = Buffer.from('# skill foo\nline2-CHANGED\nline3\nline4-NEW\nline4\nline5\n', 'utf8');
    put(tmp, 'skills/foo/SKILL.md', originalBytes);
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(fromFile, proposedBytes);
    const originalSha = sha256Hex(originalBytes);

    process.env.CLAUDE_CONFIG_DIR = tmp;
    delete process.env.HARNESS_MGR_ENABLE_WRITES; // relaxed gate: --apply alone enables.

    // Create the REAL proposal (exercises U8) the accept will land.
    const proposalId = await proposeApply(tmp, fromFile);
    const proposalPath = join(tmp, 'skills', 'foo', proposalId);
    assert.ok(existsSync(proposalPath), 'the proposal file must exist after propose --apply');
    const ts = proposalId.replace(/^SKILL\.proposed-/, '').replace(/\.md$/, '');
    const provPath = join(stateDir, 'proposals', `foo-${ts}.json`);
    assert.ok(existsSync(provPath), 'provenance must exist after propose --apply');

    // ── LEG (a): DRY-RUN accept — writes NOTHING ──────────────────────────────
    const treeBeforeDry = hashTree(tmp);
    const dry = await run(['skill', 'accept', 'foo', '--format', 'json', '--config-dir', tmp]);
    assert.equal(dry.code, 0, `dry-run accept expected code 0, got ${dry.code}; stdout: ${dry.stdout.slice(0, 400)}`);
    const dryJson = JSON.parse(dry.stdout);
    assert.equal(dryJson.command, 'skill:accept');
    assert.equal(dryJson.result.status, 'dry-run');
    assert.equal(dryJson.result.stale, false, 'dry-run accept must report stale:false (SKILL.md unchanged since propose)');
    assert.equal(dryJson.result.proposalId, proposalId, 'dry-run must select the only proposal');
    assert.deepEqual(hashTree(tmp), treeBeforeDry, 'dry-run accept must write NOTHING under the config tree');

    // ── LEG (b): APPLY accept — overwrite SKILL.md + reversible ────────────────
    const apply = await run(['skill', 'accept', 'foo', '--apply', '--format', 'json', '--config-dir', tmp]);
    assert.equal(apply.code, 0, `apply accept expected code 0, got ${apply.code}; stdout: ${apply.stdout.slice(0, 500)}`);
    const applyJson = JSON.parse(apply.stdout);
    assert.equal(applyJson.result.status, 'accepted');
    assert.equal(applyJson.result.overwritten, true);
    const snapshotId = applyJson.result.snapshotId;
    assert.match(snapshotId, /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/, 'snapshotId must be a snapshot-id shape');

    // SKILL.md now holds the PROPOSED bytes.
    assert.ok(
      Buffer.compare(readFileSync(join(tmp, 'skills', 'foo', 'SKILL.md')), proposedBytes) === 0,
      'SKILL.md must now equal the proposed bytes',
    );
    // The accepted proposal is GONE; its provenance is GONE.
    assert.ok(!existsSync(proposalPath), 'the accepted .proposed file must be deleted');
    assert.ok(!existsSync(provPath), 'the accepted proposal provenance record must be deleted');

    // The snapshot manifest captured the ORIGINAL SKILL.md bytes (the undo point).
    const manifestPath = join(stateDir, 'snapshots', snapshotId, 'manifest.json');
    assert.ok(existsSync(manifestPath), `snapshot manifest must exist at ${manifestPath}`);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const skillEntry = manifest.files.find((f) => f.path === 'skills/foo/SKILL.md');
    assert.ok(skillEntry, 'manifest must capture skills/foo/SKILL.md');
    assert.equal(skillEntry.preSha256, originalSha, 'manifest preSha256 for SKILL.md must equal the ORIGINAL bytes (undo point)');

    // No atomic-write sidecar residue anywhere.
    const residueB = allFilePaths(tmp).filter((p) => /\.mgr-(new|old)$/.test(p));
    assert.deepEqual(residueB, [], `no .mgr-new/.mgr-old residue expected after apply, found: ${residueB.join(', ')}`);

    // ── reversibility: rollback restores SKILL.md AND re-creates the proposal ──
    const rb = await run(['rollback', snapshotId, '--apply', '--force', '--format', 'json', '--config-dir', tmp]);
    assert.equal(rb.code, 0, `rollback --apply expected code 0, got ${rb.code}; stdout: ${rb.stdout.slice(0, 500)}`);
    assert.ok(
      Buffer.compare(readFileSync(join(tmp, 'skills', 'foo', 'SKILL.md')), originalBytes) === 0,
      'rollback must restore SKILL.md to the ORIGINAL bytes byte-identical',
    );
    assert.ok(existsSync(proposalPath), 'rollback must re-create the deleted proposal file');
    assert.ok(
      Buffer.compare(readFileSync(proposalPath), proposedBytes) === 0,
      'the rolled-back proposal must be byte-identical to the proposed bytes',
    );
    const residueRb = allFilePaths(tmp).filter((p) => /\.mgr-(new|old)$/.test(p));
    assert.deepEqual(residueRb, [], `no .mgr-new/.mgr-old residue expected after rollback, found: ${residueRb.join(', ')}`);

    // ── LEG (c): STALE — mutate SKILL.md after proposing, accept without --force ─
    // After the rollback, SKILL.md == original and the proposal is back. Re-create
    // a provenance record (propose again identically would collide on ts; instead
    // re-run propose with a DIFFERENT proposed file so provenance for the CURRENT
    // SKILL.md exists). Simplest: re-propose against the live (original) SKILL.md.
    // Then MUTATE SKILL.md so it drifts from the recorded source.
    rmSync(join(tmp, 'skills', 'foo', proposalId), { force: true }); // clear the prior proposal for a clean single-proposal state
    const stale2Id = await proposeApply(tmp, fromFile);
    const stale2Ts = stale2Id.replace(/^SKILL\.proposed-/, '').replace(/\.md$/, '');
    const stale2Prov = join(stateDir, 'proposals', `foo-${stale2Ts}.json`);
    assert.ok(existsSync(stale2Prov), 'provenance for the stale-leg proposal must exist');
    // MUTATE SKILL.md on disk so it drifts from the recorded sourceSha256.
    writeFileSync(join(tmp, 'skills', 'foo', 'SKILL.md'), Buffer.from('# skill foo MUTATED ON DISK\n', 'utf8'));
    const beforeStale = allFilePaths(tmp).sort();
    const stale = await run(['skill', 'accept', 'foo', '--apply', '--format', 'json', '--config-dir', tmp]);
    assert.equal(stale.code, 2, `stale accept (no --force) expected code 2, got ${stale.code}; stdout: ${stale.stdout.slice(0, 400)}`);
    const staleJson = JSON.parse(stale.stdout);
    assert.ok(staleJson.diagnostics.some((d) => d.code === 'accept-stale'), 'expected accept-stale');
    assert.deepEqual(allFilePaths(tmp).sort(), beforeStale, 'stale accept (no --force) must write nothing new on disk');

    // WITH --force → applied (overwrites the MUTATED SKILL.md with the proposed bytes).
    // Space past a second boundary so this snapshot gets a distinct id from leg (b)'s.
    await tickPastSecond();
    const forced = await run(['skill', 'accept', 'foo', '--force', '--apply', '--format', 'json', '--config-dir', tmp]);
    assert.equal(forced.code, 0, `forced stale accept expected code 0, got ${forced.code}; stdout: ${forced.stdout.slice(0, 500)}`);
    const forcedJson = JSON.parse(forced.stdout);
    assert.equal(forcedJson.result.status, 'accepted');
    assert.ok(
      Buffer.compare(readFileSync(join(tmp, 'skills', 'foo', 'SKILL.md')), proposedBytes) === 0,
      'forced accept must overwrite the mutated SKILL.md with the proposed bytes',
    );

    // ── LEG (d): AMBIGUOUS — two proposals, accept with NO id ──────────────────
    // After the forced accept, the stale-leg proposal was consumed. Create TWO
    // hand-made proposals (the propose engine names by wall-clock ts → two run()
    // proposes in one second collide; design §7(d) sanctioned by-hand simulation).
    const id1 = 'SKILL.proposed-2026-02-02T01-01-01Z.md';
    const id2 = 'SKILL.proposed-2026-02-02T02-02-02Z.md';
    writeFileSync(join(tmp, 'skills', 'foo', id1), proposedBytes);
    writeFileSync(join(tmp, 'skills', 'foo', id2), proposedBytes);
    const beforeAmbig = allFilePaths(tmp).sort();
    const ambig = await run(['skill', 'accept', 'foo', '--apply', '--format', 'json', '--config-dir', tmp]);
    assert.equal(ambig.code, 2, `ambiguous accept expected code 2, got ${ambig.code}; stdout: ${ambig.stdout.slice(0, 400)}`);
    const ambigJson = JSON.parse(ambig.stdout);
    const ambigDiag = ambigJson.diagnostics.find((d) => d.code === 'accept-ambiguous');
    assert.ok(ambigDiag, 'expected accept-ambiguous');
    assert.ok(ambigDiag.message.includes(id1) && ambigDiag.message.includes(id2),
      `ambiguous message must list BOTH proposals, got: ${ambigDiag.message}`);
    assert.deepEqual(allFilePaths(tmp).sort(), beforeAmbig, 'ambiguous accept must write nothing');

    // ── LEG (e): SIBLING SURVIVAL (user decision Q2: delete accepted + provenance,
    //    KEEP siblings) ─────────────────────────────────────────────────────────
    // Reset to a clean state with TWO real-shaped proposals, EACH with a matching
    // (non-stale) provenance record, then accept ONE by explicit id under --apply and
    // assert the OTHER proposal + its provenance survive byte-identical.
    rmSync(join(tmp, 'skills', 'foo', id1), { force: true });
    rmSync(join(tmp, 'skills', 'foo', id2), { force: true });
    const curBytes = Buffer.from('# skill foo current\nalpha\nbeta\n', 'utf8');
    writeFileSync(join(tmp, 'skills', 'foo', 'SKILL.md'), curBytes);
    const curSha = sha256Hex(curBytes);
    const acceptTs = '2026-03-03T03-03-03Z';
    const siblingTs = '2026-03-03T04-04-04Z';
    const acceptLeaf = `SKILL.proposed-${acceptTs}.md`;
    const siblingLeaf = `SKILL.proposed-${siblingTs}.md`;
    const acceptBytes = Buffer.from('# skill foo ACCEPTED\nalpha-2\nbeta\n', 'utf8');
    const siblingBytes = Buffer.from('# skill foo SIBLING\nalpha\nbeta-2\n', 'utf8');
    writeFileSync(join(tmp, 'skills', 'foo', acceptLeaf), acceptBytes);
    writeFileSync(join(tmp, 'skills', 'foo', siblingLeaf), siblingBytes);
    mkdirSync(join(stateDir, 'proposals'), { recursive: true });
    const acceptProv = join(stateDir, 'proposals', `foo-${acceptTs}.json`);
    const siblingProv = join(stateDir, 'proposals', `foo-${siblingTs}.json`);
    // Provenance sourceSha256 === sha(current SKILL.md) so neither is stale.
    const provBytes = (sha) => Buffer.from(JSON.stringify({ proposalVersion: 1, kind: 'skill', name: 'foo', sourceSha256: sha }), 'utf8');
    writeFileSync(acceptProv, provBytes(curSha));
    writeFileSync(siblingProv, provBytes(curSha));
    const siblingProvBefore = readFileSync(siblingProv); // capture for the byte-identical survival check

    // Space past a second boundary so this snapshot gets a distinct id from leg (c)'s.
    await tickPastSecond();
    const sib = await run(['skill', 'accept', 'foo', acceptTs, '--apply', '--format', 'json', '--config-dir', tmp]);
    assert.equal(sib.code, 0, `sibling-leg accept expected code 0, got ${sib.code}; stdout: ${sib.stdout.slice(0, 500)}`);
    const sibJson = JSON.parse(sib.stdout);
    assert.equal(sibJson.result.status, 'accepted');
    assert.equal(sibJson.result.proposalId, acceptLeaf, 'must accept the EXPLICITLY-named proposal, not the sibling');
    // SKILL.md now holds the ACCEPTED proposal's bytes.
    assert.ok(Buffer.compare(readFileSync(join(tmp, 'skills', 'foo', 'SKILL.md')), acceptBytes) === 0,
      'SKILL.md must equal the accepted proposal bytes');
    // The accepted proposal + its provenance are GONE.
    assert.ok(!existsSync(join(tmp, 'skills', 'foo', acceptLeaf)), 'the accepted proposal must be deleted');
    assert.ok(!existsSync(acceptProv), 'the accepted proposal provenance must be deleted');
    // The SIBLING proposal + its provenance SURVIVE byte-identical (the Q2 decision).
    assert.ok(existsSync(join(tmp, 'skills', 'foo', siblingLeaf)), 'the sibling proposal must SURVIVE');
    assert.ok(Buffer.compare(readFileSync(join(tmp, 'skills', 'foo', siblingLeaf)), siblingBytes) === 0,
      'the surviving sibling proposal must be byte-identical');
    assert.ok(existsSync(siblingProv), 'the sibling provenance must SURVIVE');
    assert.ok(Buffer.compare(readFileSync(siblingProv), siblingProvBefore) === 0,
      'the surviving sibling provenance must be byte-identical');
  } finally {
    if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
    if (savedEnableWrites === undefined) delete process.env.HARNESS_MGR_ENABLE_WRITES;
    else process.env.HARNESS_MGR_ENABLE_WRITES = savedEnableWrites;
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
    try { rmSync(srcDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});
