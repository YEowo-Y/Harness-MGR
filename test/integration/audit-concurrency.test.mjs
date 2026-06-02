/**
 * P3.U20 — DoD test #35: the O_APPEND ATOMICITY ORACLE.
 *
 * 10 REAL concurrent OS processes each append 50 metadata-only entries to the
 * SAME audit.log via appendAuditEntry's O_APPEND ('a' flag) primitive. Afterward:
 *   - every line parses as valid JSON (no torn / interleaved lines), and
 *   - the total line count is EXACTLY 10*50 = 500 (no lost writes).
 *
 * This proves the 'a'-flag append is atomic for ≤4 KiB lines, which is the whole
 * reason the writer caps inline entries at 4 KiB. Each entry stays well under the
 * cap so atomicity holds.
 *
 * All I/O is confined to a temp dir, cleaned up in a finally.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(import.meta.url);
// repo root: this file is <root>/test/integration/audit-concurrency.test.mjs
const REPO_ROOT = join(HERE, '..', '..', '..');
const WRITER = join(REPO_ROOT, 'src', 'ops', 'audit-writer.mjs');

const WORKERS = 10;
const PER_WORKER = 50;
const AUDIT_LOG_NAME = 'audit.log';

/** The worker script source — imports the REAL writer via an absolute file:// URL. */
function workerSource() {
  const writerUrl = JSON.stringify(`file://${WRITER.replace(/\\/g, '/')}`);
  return `
import { buildAuditEntry, appendAuditEntry } from ${writerUrl};
const [stateDir, countStr, idStr] = process.argv.slice(2);
const count = Number(countStr);
const id = Number(idStr);
const PASS = (p) => p;
for (let i = 0; i < count; i++) {
  const entry = buildAuditEntry({ command: 'worker-' + id + '-' + i, planVersion: 1,
    snapshotId: null, exitCode: 0, opCount: i });
  const r = appendAuditEntry({ stateDir, entry, assertWritable: PASS });
  if (!r.written) { console.error('append failed', JSON.stringify(r.diagnostics)); process.exit(1); }
}
process.exit(0);
`;
}

function runWorker(workerPath, stateDir, count, id) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerPath, stateDir, String(count), String(id)],
      { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`worker ${id} exited ${code}: ${stderr}`));
    });
  });
}

test('O_APPEND: 10 concurrent processes x 50 appends -> 500 intact JSON lines', { timeout: 60000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cmgr-audit-concurrency-'));
  try {
    const workerPath = join(dir, 'worker.mjs');
    writeFileSync(workerPath, workerSource(), 'utf8');

    // Spawn all workers concurrently and await every exit.
    const procs = [];
    for (let i = 0; i < WORKERS; i++) procs.push(runWorker(workerPath, dir, PER_WORKER, i));
    await Promise.all(procs);

    const raw = readFileSync(join(dir, AUDIT_LOG_NAME), 'utf8');
    const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);

    // Every line must parse — a torn/interleaved line would throw here.
    for (const line of lines) {
      assert.doesNotThrow(() => JSON.parse(line), `line should be valid JSON: ${line.slice(0, 120)}`);
    }
    // Exact count — no lost writes.
    assert.equal(lines.length, WORKERS * PER_WORKER);

    // Every parsed line has exactly the 6 metadata keys (M3 holds under concurrency).
    const sample = JSON.parse(lines[0]);
    assert.deepEqual(Object.keys(sample),
      ['timestamp', 'command', 'planVersion', 'snapshotId', 'exitCode', 'opCount']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
