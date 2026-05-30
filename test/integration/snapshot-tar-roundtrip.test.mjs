/**
 * P3.U7 — integration/snapshot-tar-roundtrip.test.mjs
 *
 * The HEADLINE DoD: a REAL system-tar create → extract round-trip that proves the
 * EXTRACTED files are byte-identical to the originals. This is what guarantees a
 * future rollback restores files uncorrupted.
 *
 * Uses the REAL safeSpawn path (no injected spawnFn) against the system tar
 * resolved by resolveTar(). GRACEFUL-SKIP when tar is unavailable, mirroring the
 * other test/integration/ probes.
 *
 * The source tree intentionally mixes content classes that a corrupting archiver
 * would mangle differently:
 *   - a plain UTF-8 text file (with CRLF + LF lines)
 *   - a binary file containing every byte 0x00..0xFF
 *   - a file inside a nested subdirectory
 *   - a file whose NAME is non-ASCII (unicode)
 *
 * A SECOND test (P3.D1) forces MULTI-CHUNK archiving by injecting a tiny
 * `argvBudget`, proving the `-c` first-chunk + `-r` append-chunk sequence produces
 * an archive whose extracted files are STILL byte-identical (incl. unicode + binary).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveTar, createSnapshotTar, extractSnapshotTar } from '../../src/ops/snapshot-tar.mjs';
import { chunkByArgvBudget } from '../../src/ops/snapshot-tar-chunk.mjs';

/**
 * The fixture file set. `rel` is the POSIX-relative path handed to the walker /
 * tar; `bytes` is the exact content written and later compared.
 */
function fixtureFiles() {
  const allBytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i)); // 0x00..0xFF
  return [
    { rel: 'settings.json', bytes: Buffer.from('{\r\n  "model": "opus",\n  "x": 1\n}\n', 'utf8') },
    { rel: 'binary.dat', bytes: allBytes },
    { rel: 'skills/nested/SKILL.md', bytes: Buffer.from('# nested skill\nline2\n', 'utf8') },
    { rel: 'commands/café-señor-日本語.md', bytes: Buffer.from('unicode filename payload', 'utf8') },
    // Follow-up #8(b): a real file literally named `@weird.md` INSIDE a walked
    // subdir. Its rel path `agents/@weird.md` has a NON-LEADING `@`, so it passes
    // createSnapshotTar's non-relative-member guard and must round-trip literally
    // (proving a non-leading @ member is archived as a file, never spliced as the
    // tar concatenate-archive sigil).
    { rel: 'agents/@weird.md', bytes: Buffer.from('at-prefixed filename in a subdir\n', 'utf8') },
  ];
}

test('roundtrip: real tar create→extract yields byte-identical files', async (t) => {
  const { tarPath, diagnostics } = resolveTar();
  if (!tarPath) {
    t.skip(`system tar not found (${diagnostics.map((d) => d.code).join(',')}) — skipping real round-trip`);
    return;
  }

  const srcDir = mkdtempSync(join(tmpdir(), 'mgr-tar-src-'));
  const destDir = mkdtempSync(join(tmpdir(), 'mgr-tar-dest-'));
  const archivePath = join(mkdtempSync(join(tmpdir(), 'mgr-tar-arc-')), 'snapshot.tar');
  try {
    const files = fixtureFiles();

    // Materialize the source tree.
    for (const f of files) {
      const abs = join(srcDir, ...f.rel.split('/'));
      mkdirSync(join(abs, '..'), { recursive: true });
      writeFileSync(abs, f.bytes);
    }

    // CREATE: archive the relative paths rooted at srcDir.
    const created = await createSnapshotTar({
      tarPath,
      archivePath,
      baseDir: srcDir,
      files: files.map((f) => f.rel),
    });
    assert.equal(created.ok, true, `create failed: ${JSON.stringify(created.diagnostics)}`);
    assert.equal(created.diagnostics.length, 0);

    // EXTRACT: into a clean destDir.
    const extracted = await extractSnapshotTar({ tarPath, archivePath, destDir });
    assert.equal(extracted.ok, true, `extract failed: ${JSON.stringify(extracted.diagnostics)}`);
    assert.equal(extracted.diagnostics.length, 0);

    // GOLDEN ORACLE: every extracted file is byte-identical to the original.
    for (const f of files) {
      const out = readFileSync(join(destDir, ...f.rel.split('/')));
      assert.ok(
        Buffer.compare(out, f.bytes) === 0,
        `byte mismatch for ${f.rel}: got ${out.length} bytes, expected ${f.bytes.length}`,
      );
    }
  } finally {
    for (const d of [srcDir, destDir]) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
    try { rmSync(join(archivePath, '..'), { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

test('roundtrip: MULTI-CHUNK (-c + -r append) archive is still byte-identical (P3.D1)', async (t) => {
  const { tarPath, diagnostics } = resolveTar();
  if (!tarPath) {
    t.skip(`system tar not found (${diagnostics.map((d) => d.code).join(',')}) — skipping multi-chunk round-trip`);
    return;
  }

  const srcDir = mkdtempSync(join(tmpdir(), 'mgr-tar-mc-src-'));
  const destDir = mkdtempSync(join(tmpdir(), 'mgr-tar-mc-dest-'));
  const archivePath = join(mkdtempSync(join(tmpdir(), 'mgr-tar-mc-arc-')), 'snapshot.tar');
  try {
    const files = fixtureFiles();
    for (const f of files) {
      const abs = join(srcDir, ...f.rel.split('/'));
      mkdirSync(join(abs, '..'), { recursive: true });
      writeFileSync(abs, f.bytes);
    }

    // Choose a budget that DEMONSTRABLY forces >=3 chunks for these 5 members,
    // computed against the SAME fixed overhead createSnapshotTar uses (so the real
    // run and this companion check agree). This proves the real `-c`+`-r` append
    // path runs across multiple spawns, not just the unit-level seam.
    const fixed = ['-c', '-f', archivePath, '-C', srcDir];
    // Byte-accurate (#11): mirror createSnapshotTar's Buffer.byteLength budgeting so
    // this companion check agrees with the real run for the unicode member (whose
    // UTF-8 byte cost exceeds its UTF-16 .length).
    const overhead = Buffer.byteLength(tarPath, 'utf8') + fixed.reduce((n, a) => n + Buffer.byteLength(a, 'utf8') + 1, 0);
    const rels = files.map((f) => f.rel);
    const longest = Math.max(...rels.map((r) => Buffer.byteLength(r, 'utf8'))) + 1;
    const argvBudget = overhead + longest + 1; // room for ~1 member per chunk → >=3 chunks
    const { chunks } = chunkByArgvBudget(rels, overhead, argvBudget);
    assert.ok(chunks && chunks.length >= 3, `companion check expected >=3 chunks, got ${chunks && chunks.length}`);

    // CREATE with the tiny budget → REAL multi-spawn -c + -r against the system tar.
    const created = await createSnapshotTar({ tarPath, archivePath, baseDir: srcDir, files: rels, argvBudget });
    assert.equal(created.ok, true, `multi-chunk create failed: ${JSON.stringify(created.diagnostics)}`);
    assert.equal(created.diagnostics.length, 0);

    const extracted = await extractSnapshotTar({ tarPath, archivePath, destDir });
    assert.equal(extracted.ok, true, `extract failed: ${JSON.stringify(extracted.diagnostics)}`);

    // GOLDEN ORACLE: every member (incl. unicode + the 0x00..0xFF binary) survives
    // the append sequence byte-identical.
    for (const f of files) {
      const out = readFileSync(join(destDir, ...f.rel.split('/')));
      assert.ok(
        Buffer.compare(out, f.bytes) === 0,
        `multi-chunk byte mismatch for ${f.rel}: got ${out.length} bytes, expected ${f.bytes.length}`,
      );
    }
  } finally {
    for (const d of [srcDir, destDir]) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
    try { rmSync(join(archivePath, '..'), { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});
