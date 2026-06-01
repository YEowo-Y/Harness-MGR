/**
 * P3.U14 — integration/recover-roundtrip.test.mjs
 *
 * A REAL-fs round-trip for recover --mark-failed. No tar is needed: recover touches
 * ONLY the apply-journal.json. We build a real `<stateDir>/snapshots/<id>/` whose
 * journal is in state 'snapshotted' (via the REAL apply-journal-writer primitives),
 * plant sentinel files (a snapshot-dir artifact AND a governed-config file), then
 * run recover and prove:
 *   - ok:true and the journal RE-READ FROM DISK is now in state 'failed',
 *   - the planted sentinels are byte-identical (recover only rewrote the journal),
 *   - a real-fs traversal id is refused with recover-bad-id and creates NOTHING
 *     outside <stateDir>/snapshots/.
 *
 * assertWritable is injected as a passthrough so the test does not depend on real
 * ~/.claude path resolution (the real gate is exercised by selftest --boundary).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recover } from '../../src/ops/recover.mjs';
import {
  createJournal, transition, writeJournal, readJournal,
} from '../../src/ops/apply-journal-writer.mjs';

const PASS_GATE = (p) => p; // passthrough write gate
const VALID_ID = '2026-05-30T12-34-56Z';

/** Seed a real snapshot dir with a journal in state 'snapshotted'. */
function seedSnapshottedJournal(stateDir, snapshotId, targetClaudeDir) {
  const plan = { planVersion: 1, command: 'config set', ops: [] };
  const created = createJournal({ snapshotId, targetClaudeDir, plan });
  assert.ok(created.journal, 'createJournal should produce a planned journal');
  const t = transition(created.journal, 'snapshotted', {});
  assert.ok(t.ok, 'planned → snapshotted should be legal');
  const w = writeJournal({ stateDir, snapshotId, journal: t.journal, assertWritable: PASS_GATE });
  assert.ok(w.written, `seed writeJournal failed: ${JSON.stringify(w.diagnostics)}`);
  return w.path;
}

test('recover-roundtrip: marks the on-disk journal failed and touches NOTHING else', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cmgr-recover-rt-'));
  const claudeDir = join(root, '.claude');
  const stateDir = join(claudeDir, '.mgr-state');
  const snapDir = join(stateDir, 'snapshots', VALID_ID);
  mkdirSync(snapDir, { recursive: true });

  try {
    // Seed a real journal at 'snapshotted'.
    seedSnapshottedJournal(stateDir, VALID_ID, claudeDir);

    // Plant a snapshot-dir sentinel (e.g. the tar) + a governed-config sentinel.
    const tarBytes = Buffer.from([0, 1, 2, 3, 255, 254, 7, 8]);
    const tarPath = join(snapDir, 'files.tar');
    writeFileSync(tarPath, tarBytes);
    const governedPath = join(claudeDir, 'settings.json');
    const governedBytes = Buffer.from('{\n  "model": "sonnet"\n}\n', 'utf8');
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(governedPath, governedBytes);

    // Sanity: journal is 'snapshotted' before recovery.
    const pre = readJournal({ stateDir, snapshotId: VALID_ID });
    assert.equal(pre.journal && pre.journal.state, 'snapshotted');

    const res = await recover({
      snapshotId: VALID_ID, mgrStateDir: stateDir, mode: 'mark-failed', assertWritable: PASS_GATE,
    });

    assert.equal(res.ok, true, `recover failed: ${JSON.stringify(res.diagnostics)}`);
    assert.equal(res.state, 'failed');
    assert.equal(res.snapshotId, VALID_ID);
    assert.equal(res.journalPath, join(snapDir, 'apply-journal.json'));
    assert.ok(res.diagnostics.some((d) => d.code === 'recover-marked-failed'));

    // The journal RE-READ FROM DISK is now 'failed'.
    const post = readJournal({ stateDir, snapshotId: VALID_ID });
    assert.equal(post.journal && post.journal.state, 'failed', 'on-disk journal must be failed');

    // The planted sentinels are byte-identical — recover only rewrote the journal.
    assert.deepEqual(readFileSync(tarPath), tarBytes, 'snapshot tar must be untouched');
    assert.deepEqual(readFileSync(governedPath), governedBytes, 'governed settings.json must be untouched');

    // No new file appeared in the snapshot dir beyond the journal + planted tar.
    assert.deepEqual(
      readdirSync(snapDir).sort(),
      ['apply-journal.json', 'files.tar'],
      'recover must not create extra files in the snapshot dir',
    );
  } finally {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

test('recover-roundtrip: a traversal id is refused and creates NOTHING outside snapshots/', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cmgr-recover-rt-esc-'));
  const stateDir = join(root, '.mgr-state');
  mkdirSync(join(stateDir, 'snapshots'), { recursive: true });

  try {
    // Snapshot a directory listing of the whole temp root BEFORE.
    const beforeRoot = readdirSync(root).sort();
    const beforeSnapshots = readdirSync(join(stateDir, 'snapshots')).sort();

    const res = await recover({
      snapshotId: '../../evil', mgrStateDir: stateDir, mode: 'mark-failed', assertWritable: PASS_GATE,
    });

    assert.equal(res.ok, false);
    assert.ok(
      res.diagnostics.some((d) => d.code === 'recover-bad-id' || d.code === 'recover-path-escape'),
      `expected recover-bad-id/recover-path-escape, got ${JSON.stringify(res.diagnostics)}`,
    );
    assert.equal(res.state, null);
    assert.equal(res.journalPath, null);

    // No file was created anywhere — the temp root + snapshots dir are unchanged,
    // and no `evil` artifact appeared one or two levels up.
    assert.deepEqual(readdirSync(root).sort(), beforeRoot, 'temp root must be unchanged');
    assert.deepEqual(readdirSync(join(stateDir, 'snapshots')).sort(), beforeSnapshots,
      'snapshots dir must be unchanged');
    assert.ok(!existsSync(join(root, 'evil')), 'no evil artifact one level up');
    assert.ok(!existsSync(join(root, '..', 'evil')), 'no evil artifact two levels up');
  } finally {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});
