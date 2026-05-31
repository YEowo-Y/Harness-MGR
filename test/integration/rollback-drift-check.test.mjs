/**
 * P3.U15 — integration/rollback-drift-check.test.mjs
 *
 * A REAL-fs round-trip for checkRollbackDrift. We build a real
 * `<stateDir>/snapshots/<id>/manifest.json` (via the REAL buildManifest +
 * writeManifest primitives, with a passthrough write gate) whose targetClaudeDir is
 * a temp `.claude` holding a few governed files; each file's currentSha256 is the
 * REAL sha256 of its bytes. Then we prove:
 *   - CLEAN: an untouched tree → ok:true, clean:true.
 *   - MODIFIED: editing one governed file → ok:true, clean:false, a 'modified' change.
 *   - DELETED: removing one governed file → a 'deleted' change.
 *   - The check WROTE NOTHING — a {relpath → sha256} fingerprint of the ENTIRE temp
 *     tree is captured before/after each run and asserted deepEqual.
 *
 * assertWritable is injected as a passthrough for the SEED only (manifest write);
 * checkRollbackDrift itself takes no gate (it never writes). The real gate is
 * exercised by selftest --boundary.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, statSync, unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { checkRollbackDrift } from '../../src/ops/rollback-drift-check.mjs';
import { buildManifest } from '../../src/ops/snapshot-manifest.mjs';
import { writeManifest } from '../../src/ops/snapshot-manifest-io.mjs';

const PASS_GATE = (p) => p; // passthrough write gate (seed only)
const VALID_ID = '2026-05-30T12-34-56Z';

/** sha256 hex over a file's bytes. */
function sha256File(abs) {
  return createHash('sha256').update(readFileSync(abs)).digest('hex');
}

/** Recursively fingerprint a tree → sorted { posixRel → sha256 } for before/after. */
function fingerprint(root) {
  /** @type {Record<string,string>} */
  const out = {};
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name);
      const st = statSync(abs);
      if (st.isDirectory()) walk(abs);
      else out[relative(root, abs).split(sep).join('/')] = sha256File(abs);
    }
  };
  walk(root);
  return out;
}

/** Seed a temp tree: governed files + a real snapshot manifest over them. */
function seed() {
  const root = mkdtempSync(join(tmpdir(), 'cmgr-drift-int-'));
  const claudeDir = join(root, '.claude');
  const stateDir = join(claudeDir, '.mgr-state');
  mkdirSync(join(claudeDir, 'agents'), { recursive: true });
  mkdirSync(join(claudeDir, 'commands'), { recursive: true });

  // Governed files (one binary, to prove binary-safe hashing).
  const files = {
    'settings.json': Buffer.from('{\n  "model": "sonnet"\n}\n', 'utf8'),
    'agents/a.md': Buffer.from('# agent A\n', 'utf8'),
    'commands/bin.dat': Buffer.from([0, 1, 2, 3, 255, 254, 7, 8, 0, 9]),
  };
  for (const [rel, bytes] of Object.entries(files)) {
    writeFileSync(join(claudeDir, ...rel.split('/')), bytes);
  }

  // Real manifest: currentSha256 = the real on-disk hash of each file.
  const records = Object.keys(files).map((rel) => ({
    path: rel, sha256: sha256File(join(claudeDir, ...rel.split('/'))),
  }));
  const built = buildManifest({ snapshotId: VALID_ID, targetClaudeDir: claudeDir, files: records, reason: 'integration' });
  assert.ok(built.manifest, `buildManifest failed: ${JSON.stringify(built.diagnostics)}`);
  const wm = writeManifest({ stateDir, snapshotId: VALID_ID, manifest: built.manifest, assertWritable: PASS_GATE });
  assert.ok(wm.written, `seed writeManifest failed: ${JSON.stringify(wm.diagnostics)}`);

  return { root, claudeDir, stateDir };
}

test('rollback-drift-check (real fs): CLEAN tree → ok:true, clean:true, writes nothing', () => {
  const { root, claudeDir, stateDir } = seed();
  try {
    const before = fingerprint(root);
    const res = checkRollbackDrift({ mgrStateDir: stateDir, snapshotId: VALID_ID });
    assert.equal(res.ok, true, JSON.stringify(res.diagnostics));
    assert.equal(res.clean, true);
    assert.deepEqual(res.changes, []);
    assert.equal(res.targetClaudeDir, claudeDir);
    // WROTE NOTHING.
    assert.deepEqual(fingerprint(root), before, 'drift check must not modify the tree');
  } finally {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

test('rollback-drift-check (real fs): a MODIFIED governed file → clean:false, modified change', () => {
  const { root, claudeDir, stateDir } = seed();
  try {
    // Edit one governed file AFTER the manifest was captured.
    const edited = join(claudeDir, 'settings.json');
    writeFileSync(edited, Buffer.from('{\n  "model": "opus"\n}\n', 'utf8'));

    const before = fingerprint(root);
    const res = checkRollbackDrift({ mgrStateDir: stateDir, snapshotId: VALID_ID });
    assert.equal(res.ok, true, JSON.stringify(res.diagnostics));
    assert.equal(res.clean, false);
    const hit = res.changes.find((c) => c.path === 'settings.json');
    assert.ok(hit, `expected a settings.json change, got ${JSON.stringify(res.changes)}`);
    assert.equal(hit.kind, 'modified');
    assert.equal(hit.actual, sha256File(edited));
    assert.ok(res.diagnostics.some((d) => d.code === 'rollback-drift-detected'));
    assert.deepEqual(fingerprint(root), before, 'drift check must not modify the tree');
  } finally {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

test('rollback-drift-check (real fs): a DELETED governed file → clean:false, deleted change', () => {
  const { root, claudeDir, stateDir } = seed();
  try {
    unlinkSync(join(claudeDir, 'agents', 'a.md'));

    const before = fingerprint(root);
    const res = checkRollbackDrift({ mgrStateDir: stateDir, snapshotId: VALID_ID });
    assert.equal(res.ok, true, JSON.stringify(res.diagnostics));
    assert.equal(res.clean, false);
    const hit = res.changes.find((c) => c.path === 'agents/a.md');
    assert.ok(hit, `expected an agents/a.md change, got ${JSON.stringify(res.changes)}`);
    assert.equal(hit.kind, 'deleted');
    assert.equal(hit.actual, null);
    assert.deepEqual(fingerprint(root), before, 'drift check must not modify the tree');
  } finally {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});
