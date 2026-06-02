/**
 * P3.U20 — DoD test #36: the M3 SECURITY ORACLE.
 *
 * The audit log is metadata-ONLY (decided-item M3): it must NEVER contain file
 * contents, diffs, or before/after values, even when a careless caller stuffs
 * them into the raw entry object. The whitelist in audit-writer.mjs::normalizeEntry
 * (called at BOTH build and append time) is what enforces this.
 *
 * Falsifiable: if the writer ever spread the raw entry instead of re-whitelisting,
 * these assertions go red — the sentinels would land on disk.
 *
 * Covers BOTH paths: the inline (<=4 KiB) append AND the >4 KiB split, since the
 * re-whitelist must run before the large file is written too.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAuditEntry, appendAuditEntry, AUDIT_LOG_NAME, AUDIT_LARGE_DIRNAME } from '../src/ops/audit-writer.mjs';

const PASS = (p) => p;
const SENTINELS = ['TOPSECRET_DIFF', 'sk-ant-LEAKED-TOKEN', 'PLAINTEXT_FILE_BODY'];

function tmp() {
  return mkdtempSync(join(tmpdir(), 'cmgr-audit-m3-'));
}

/** Read every file under a dir (recursively), concatenated. '' if dir absent. */
function readAllBytes(dir) {
  if (!existsSync(dir)) return '';
  let out = '';
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    try { out += readFileSync(p, 'utf8'); } catch { /* dir entry, skip */ }
  }
  return out;
}

test('M3: secret-laden inline entries never persist file contents to audit.log', () => {
  const dir = tmp();
  try {
    // Several entries where a careless caller attached secrets/contents.
    for (let i = 0; i < 3; i++) {
      const entry = {
        timestamp: new Date(2026, 5, 1, 12, i, 0).toISOString(),
        command: 'apply', planVersion: 1, snapshotId: null, exitCode: 0, opCount: 1,
        diff: '<<TOPSECRET_DIFF>>',
        before: 'sk-ant-LEAKED-TOKEN',
        after: 'PLAINTEXT_FILE_BODY',
      };
      const r = appendAuditEntry({ stateDir: dir, entry, assertWritable: PASS });
      assert.equal(r.written, true);
      assert.equal(r.large, false);
    }

    const log = readFileSync(join(dir, AUDIT_LOG_NAME), 'utf8');
    for (const s of SENTINELS) {
      assert.ok(!log.includes(s), `audit.log must not contain sentinel ${s}`);
    }
    // The split dir should not even exist for inline entries.
    assert.equal(existsSync(join(dir, AUDIT_LARGE_DIRNAME)), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('M3: a secret-laden OVERSIZED entry leaks nothing to audit.log NOR audit-large/', () => {
  const dir = tmp();
  try {
    // A multi-KiB command forces the >4 KiB split, PLUS secret fields that must
    // be dropped before the large file is written.
    const entry = {
      timestamp: new Date(2026, 5, 1, 13, 0, 0).toISOString(),
      command: 'apply '.repeat(1000), // ~6000 bytes -> forces split
      planVersion: 1, snapshotId: '2026-06-01T13-00-00Z', exitCode: 0, opCount: 5,
      diff: '<<TOPSECRET_DIFF>>',
      before: 'sk-ant-LEAKED-TOKEN',
      after: 'PLAINTEXT_FILE_BODY',
    };
    const r = appendAuditEntry({ stateDir: dir, entry, assertWritable: PASS });
    assert.equal(r.written, true);
    assert.equal(r.large, true);
    assert.ok(existsSync(join(dir, AUDIT_LARGE_DIRNAME)));

    const log = readFileSync(join(dir, AUDIT_LOG_NAME), 'utf8');
    const largeBytes = readAllBytes(join(dir, AUDIT_LARGE_DIRNAME));
    for (const s of SENTINELS) {
      assert.ok(!log.includes(s), `audit.log must not contain sentinel ${s}`);
      assert.ok(!largeBytes.includes(s), `audit-large/* must not contain sentinel ${s}`);
    }
    // sanity: the large file DID get written with the (benign) big command
    assert.ok(largeBytes.includes('apply apply'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('M3: even an entry built via buildAuditEntry cannot carry contents', () => {
  const dir = tmp();
  try {
    // buildAuditEntry already drops extras, but prove the end-to-end persisted bytes.
    const entry = buildAuditEntry({ command: 'apply', diff: 'TOPSECRET_DIFF',
      fileBody: 'PLAINTEXT_FILE_BODY', now: () => new Date('2026-06-01T12:00:00.000Z') });
    appendAuditEntry({ stateDir: dir, entry, assertWritable: PASS });
    const log = readFileSync(join(dir, AUDIT_LOG_NAME), 'utf8');
    assert.ok(!log.includes('TOPSECRET_DIFF'));
    assert.ok(!log.includes('PLAINTEXT_FILE_BODY'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
