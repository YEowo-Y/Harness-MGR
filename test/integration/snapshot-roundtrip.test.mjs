/**
 * P3.U8 — integration/snapshot-roundtrip.test.mjs
 *
 * The HEADLINE DoD for the snapshot orchestrator: a FULL end-to-end run of
 * createSnapshot against a REAL temp `~/.claude`-like tree, using the REAL
 * system tar (no injected spawnFn), proving the assembled snapshot is correct
 * AND secret-free.
 *
 * Golden oracle (all must hold):
 *   (a) the snapshot dir holds both files.tar and manifest.json;
 *   (b) extracting files.tar yields every KEPT file byte-identical to source;
 *   (c) a planted .pem AND a token-bearing config.json are in `dropped`, ABSENT
 *       from the extracted tree, AND ABSENT from the manifest files[];
 *   (d) a fake PRIOR snapshot under .mgr-state/ is NOT captured (self-exclusion —
 *       the recursion-bloat the walker exists to prevent);
 *   (e) manifest.json is valid: parses, snapshotId matches the result, and every
 *       files[] sha256 matches the re-hashed source bytes.
 *
 * GRACEFUL-SKIP when the system tar is unavailable (mirrors the other
 * test/integration/ probes). assertWritable is injected as a passthrough so the
 * test does not depend on the real ~/.claude path resolution (the real gate is
 * exercised by selftest --boundary).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { createSnapshot } from '../../src/ops/snapshot.mjs';
import { resolveTar, extractSnapshotTar } from '../../src/ops/snapshot-tar.mjs';

const PASS_GATE = (p) => p; // passthrough write gate (the real gate is in selftest --boundary)

function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/** Write a file at a POSIX-relative path under base, creating parent dirs. */
function put(base, rel, bytes) {
  const abs = join(base, ...rel.split('/'));
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, bytes);
}

/** Recursively list POSIX-relative file paths under dir. */
function listFiles(dir) {
  /** @type {string[]} */
  const out = [];
  const walk = (d) => {
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      const abs = join(d, ent.name);
      if (ent.isDirectory()) walk(abs);
      else if (ent.isFile()) out.push(relative(dir, abs).split(sep).join('/'));
    }
  };
  walk(dir);
  return out.sort();
}

/**
 * The KEPT (non-secret) source files — these must round-trip byte-identical.
 * Mixed content classes a corrupting archiver would mangle differently.
 */
function keptFixtures() {
  return [
    { rel: 'agents/a.md', bytes: Buffer.from('# agent a\nline2\n', 'utf8') },
    { rel: 'skills/s/SKILL.md', bytes: Buffer.from('# 技能 — unicode body café\nx\n', 'utf8') },
    { rel: 'settings.json', bytes: Buffer.from('{\r\n  "model": "opus"\n}\n', 'utf8') },
  ];
}

test('roundtrip: createSnapshot archives kept files byte-identical and excludes secrets', async (t) => {
  const { tarPath, diagnostics } = resolveTar();
  if (!tarPath) {
    t.skip(`system tar not found (${diagnostics.map((d) => d.code).join(',')}) — skipping snapshot round-trip`);
    return;
  }

  const root = mkdtempSync(join(tmpdir(), 'cmgr-snap-rt-'));
  const claudeDir = join(root, '.claude');
  const stateDir = join(claudeDir, '.mgr-state');
  const destDir = mkdtempSync(join(tmpdir(), 'cmgr-snap-rt-dest-'));
  mkdirSync(claudeDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });

  // PLANTED SECRETS (must be dropped + never archived):
  //  - hooks/leaked.pem: caught by the NAME matcher (.pem extension).
  //  - commands/config.json: BENIGN name, but a ghp_ GitHub token in its CONTENT
  //    → caught ONLY by content-sniff (proves the content leg is live).
  const pemBytes = Buffer.from('-----BEGIN OPENSSH PRIVATE KEY-----\nQUJD\n-----END OPENSSH PRIVATE KEY-----\n', 'utf8');
  const tokenBytes = Buffer.from('{"github":"ghp_abcdefghijklmnopqrstuvwxyz0123456789"}\n', 'utf8');

  try {
    const kept = keptFixtures();
    for (const f of kept) put(claudeDir, f.rel, f.bytes);
    put(claudeDir, 'hooks/leaked.pem', pemBytes);
    put(claudeDir, 'commands/config.json', tokenBytes);
    // A fake PRIOR snapshot inside .mgr-state — must NOT be re-captured.
    put(stateDir, 'snapshots/old/files.tar', Buffer.from('OLD SNAPSHOT TAR BYTES', 'utf8'));

    // RUN the orchestrator with the REAL tar (no injected spawnFn).
    const res = await createSnapshot({
      targetClaudeDir: claudeDir, mgrStateDir: stateDir, reason: 'integration', assertWritable: PASS_GATE,
    });
    assert.equal(res.ok, true, `snapshot failed: ${JSON.stringify(res.diagnostics)}`);

    // (a) the snapshot dir holds both artifacts.
    assert.ok(existsSync(res.archivePath), 'files.tar must exist');
    assert.ok(existsSync(res.manifestPath), 'manifest.json must exist');
    assert.equal(res.snapshotDir, join(stateDir, 'snapshots', res.snapshotId));

    // (c-partial) both secrets are in `dropped`; the config.json drop is BY CONTENT.
    assert.ok(res.dropped.some((d) => d.path === 'hooks/leaked.pem'), 'leaked.pem must be dropped');
    const cfgDrop = res.dropped.find((d) => d.path === 'commands/config.json');
    assert.ok(cfgDrop, 'config.json must be dropped');
    assert.equal(cfgDrop.by, 'content', 'config.json is dropped by content-sniff (benign name)');
    // neither secret is kept.
    assert.ok(!res.kept.includes('hooks/leaked.pem'));
    assert.ok(!res.kept.includes('commands/config.json'));

    // (d) the prior .mgr-state snapshot was NOT captured (self-exclusion).
    assert.ok(!res.kept.some((p) => p.startsWith('.mgr-state/')), 'no .mgr-state file may be captured');

    // (b) EXTRACT and byte-compare every kept file.
    const ex = await extractSnapshotTar({ tarPath, archivePath: res.archivePath, destDir });
    assert.equal(ex.ok, true, `extract failed: ${JSON.stringify(ex.diagnostics)}`);
    for (const f of kept) {
      const out = readFileSync(join(destDir, ...f.rel.split('/')));
      assert.ok(Buffer.compare(out, f.bytes) === 0, `byte mismatch for ${f.rel}`);
    }

    // (c) the secrets are ABSENT from the extracted tree.
    const extracted = listFiles(destDir);
    assert.ok(!extracted.includes('hooks/leaked.pem'), 'leaked.pem must not be in the archive');
    assert.ok(!extracted.includes('commands/config.json'), 'token config.json must not be in the archive');
    // the extracted set is exactly the kept set.
    assert.deepEqual(extracted, kept.map((f) => f.rel).sort());

    // (e) the manifest is valid: parses, snapshotId matches, hashes match source.
    const manifest = JSON.parse(readFileSync(res.manifestPath, 'utf8'));
    assert.equal(manifest.snapshotId, res.snapshotId);
    assert.equal(manifest.targetClaudeDir, claudeDir);
    assert.equal(manifest.reason, 'integration');
    assert.ok(!manifest.files.some((f) => f.path === 'hooks/leaked.pem'), 'secret absent from manifest');
    assert.ok(!manifest.files.some((f) => f.path === 'commands/config.json'), 'token file absent from manifest');
    const byPath = Object.fromEntries(manifest.files.map((f) => [f.path, f]));
    for (const f of kept) {
      const rec = byPath[f.rel];
      assert.ok(rec, `manifest must record ${f.rel}`);
      assert.equal(rec.preSha256, sha256Hex(f.bytes), `manifest preSha256 mismatch for ${f.rel}`);
      assert.equal(rec.currentSha256, sha256Hex(f.bytes), `manifest currentSha256 mismatch for ${f.rel}`);
    }
    assert.equal(res.fileCount, kept.length);
  } finally {
    for (const d of [root, destDir]) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }
});
