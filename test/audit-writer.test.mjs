/**
 * P3.U20 — unit tests for the audit-log WRITE side (src/ops/audit-writer.mjs).
 *
 * Round-trips through the REAL reader (src/ops/audit.mjs::readAuditLog) so the
 * written format is proven parseable by its consumer. Uses a real temp dir and a
 * passthrough gate (the real assertWritable is exercised by selftest --boundary).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { buildAuditEntry, appendAuditEntry, AUDIT_LOG_NAME } from '../src/ops/audit-writer.mjs';
import { readAuditLog } from '../src/ops/audit.mjs';

const PASS = (p) => p; // passthrough write gate
const ISO = '2026-06-01T12:00:00.000Z';

function tmp() {
  return mkdtempSync(join(tmpdir(), 'cmgr-audit-writer-'));
}
function sha256Hex(s) {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}
function rawLines(dir) {
  return readFileSync(join(dir, AUDIT_LOG_NAME), 'utf8').split('\n');
}

// ── buildAuditEntry (pure) ──────────────────────────────────────────────────────

test('buildAuditEntry: returns exactly the 6 keys in fixed order', () => {
  const e = buildAuditEntry({ command: 'apply', planVersion: 2, snapshotId: '2026-06-01T12-00-00Z',
    exitCode: 0, opCount: 3, now: () => new Date(ISO) });
  assert.deepEqual(Object.keys(e),
    ['timestamp', 'command', 'planVersion', 'snapshotId', 'exitCode', 'opCount']);
  assert.equal(e.timestamp, ISO);
  assert.equal(e.command, 'apply');
  assert.equal(e.planVersion, 2);
  assert.equal(e.snapshotId, '2026-06-01T12-00-00Z');
  assert.equal(e.exitCode, 0);
  assert.equal(e.opCount, 3);
});

test('buildAuditEntry: coerces bad types to defaults', () => {
  const e = buildAuditEntry({ command: 123, planVersion: 0, snapshotId: 42,
    exitCode: 'x', opCount: -5, now: () => new Date(ISO) });
  assert.equal(e.command, '');         // non-string -> ''
  assert.equal(e.planVersion, 1);      // 0 (<1) -> 1
  assert.equal(e.snapshotId, null);    // non-string -> null
  assert.equal(e.exitCode, null);      // non-integer -> null
  assert.equal(e.opCount, 0);          // negative -> 0
});

test('buildAuditEntry: planVersion non-integer -> 1, opCount float -> 0, exitCode float -> null', () => {
  const e = buildAuditEntry({ planVersion: 2.5, opCount: 1.5, exitCode: 0.5, now: () => new Date(ISO) });
  assert.equal(e.planVersion, 1);
  assert.equal(e.opCount, 0);
  assert.equal(e.exitCode, null);   // a non-integer exit code is intentionally nulled
});

test('buildAuditEntry: exitCode negative integer is kept (real exit codes can be nonzero)', () => {
  const e = buildAuditEntry({ exitCode: 2, now: () => new Date(ISO) });
  assert.equal(e.exitCode, 2);
});

test('buildAuditEntry: never throws on {} / junk / no args', () => {
  assert.doesNotThrow(() => buildAuditEntry({}));
  assert.doesNotThrow(() => buildAuditEntry());
  assert.doesNotThrow(() => buildAuditEntry(null));
  assert.doesNotThrow(() => buildAuditEntry(42));
  const e = buildAuditEntry({});
  assert.equal(e.command, '');
  assert.equal(e.planVersion, 1);
  assert.equal(e.snapshotId, null);
  assert.equal(e.exitCode, null);
  assert.equal(e.opCount, 0);
  assert.equal(typeof e.timestamp, 'string');
});

test('buildAuditEntry: a throwing clock falls back to a valid ISO string', () => {
  const e = buildAuditEntry({ now: () => { throw new Error('bad clock'); } });
  assert.equal(typeof e.timestamp, 'string');
  assert.ok(e.timestamp.length > 0);
});

test('buildAuditEntry: DROPS extra fields (M3 whitelist)', () => {
  const e = buildAuditEntry({ command: 'apply', diff: 'X', before: 'Y', after: 'Z',
    fileContents: 'LEAK', now: () => new Date(ISO) });
  const keys = Object.keys(e);
  assert.ok(!keys.includes('diff'));
  assert.ok(!keys.includes('before'));
  assert.ok(!keys.includes('after'));
  assert.ok(!keys.includes('fileContents'));
  assert.equal(keys.length, 6);
});

// ── appendAuditEntry — gate fail-safe ───────────────────────────────────────────

test('appendAuditEntry: missing assertWritable -> written:false + diagnostic (fail-safe)', () => {
  const dir = tmp();
  try {
    const entry = buildAuditEntry({ command: 'apply', now: () => new Date(ISO) });
    const r = appendAuditEntry({ stateDir: dir, entry });
    assert.equal(r.written, false);
    assert.ok(r.diagnostics.some((d) => d.severity === 'error' && d.code === 'audit-write-error'));
    assert.equal(existsSync(join(dir, AUDIT_LOG_NAME)), false); // nothing written
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('appendAuditEntry: gate that throws -> written:false, nothing written', () => {
  const dir = tmp();
  try {
    const entry = buildAuditEntry({ command: 'apply', now: () => new Date(ISO) });
    const gate = () => { throw new Error('write gate denied'); };
    const r = appendAuditEntry({ stateDir: dir, entry, assertWritable: gate });
    assert.equal(r.written, false);
    assert.ok(r.diagnostics.some((d) => d.code === 'audit-write-error'));
    assert.equal(existsSync(join(dir, AUDIT_LOG_NAME)), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('appendAuditEntry: bad stateDir / non-object entry -> written:false', () => {
  const r1 = appendAuditEntry({ stateDir: '', entry: {}, assertWritable: PASS });
  assert.equal(r1.written, false);
  assert.ok(r1.diagnostics.some((d) => d.code === 'audit-write-error'));
  const dir = tmp();
  try {
    const r2 = appendAuditEntry({ stateDir: dir, entry: 'not-an-object', assertWritable: PASS });
    assert.equal(r2.written, false);
    assert.ok(r2.diagnostics.some((d) => d.code === 'audit-write-error'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── appendAuditEntry — happy path + reader round-trip ────────────────────────────

test('appendAuditEntry: writes one single-line JSON entry ending in \\n, reader parses it', () => {
  const dir = tmp();
  try {
    const entry = buildAuditEntry({ command: 'apply', planVersion: 1, snapshotId: '2026-06-01T12-00-00Z',
      exitCode: 0, opCount: 2, now: () => new Date(ISO) });
    const r = appendAuditEntry({ stateDir: dir, entry, assertWritable: PASS });
    assert.equal(r.written, true);
    assert.equal(r.large, false);
    assert.equal(r.ref, null);

    const raw = readFileSync(join(dir, AUDIT_LOG_NAME), 'utf8');
    // exactly one newline (one line + trailing \n)
    assert.equal((raw.match(/\n/g) || []).length, 1);
    assert.ok(raw.endsWith('\n'));
    // the line itself has no interior newline
    assert.equal(raw.trim().includes('\n'), false);

    const { entries } = readAuditLog({ stateDir: dir });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].command, 'apply');
    assert.equal(entries[0].snapshotId, '2026-06-01T12-00-00Z');
    assert.equal(entries[0].opCount, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('appendAuditEntry: re-whitelists at the I/O boundary (raw entry not from builder)', () => {
  const dir = tmp();
  try {
    // A careless caller stuffs file contents into a raw entry object.
    const raw = { timestamp: ISO, command: 'apply', fileContents: 'LEAK', diff: 'SECRET' };
    const r = appendAuditEntry({ stateDir: dir, entry: raw, assertWritable: PASS });
    assert.equal(r.written, true);
    const text = readFileSync(join(dir, AUDIT_LOG_NAME), 'utf8');
    assert.ok(!text.includes('fileContents'));
    assert.ok(!text.includes('LEAK'));
    assert.ok(!text.includes('SECRET'));
    // and the persisted entry has exactly the 6 metadata keys
    const parsed = JSON.parse(text.trim());
    assert.deepEqual(Object.keys(parsed),
      ['timestamp', 'command', 'planVersion', 'snapshotId', 'exitCode', 'opCount']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('appendAuditEntry: missing/empty timestamp -> audit-entry-invalid, nothing written', () => {
  const dir = tmp();
  try {
    const r1 = appendAuditEntry({ stateDir: dir, entry: { command: 'apply' }, assertWritable: PASS });
    assert.equal(r1.written, false);
    assert.ok(r1.diagnostics.some((d) => d.code === 'audit-entry-invalid'));
    const r2 = appendAuditEntry({ stateDir: dir, entry: { timestamp: '', command: 'apply' }, assertWritable: PASS });
    assert.equal(r2.written, false);
    assert.ok(r2.diagnostics.some((d) => d.code === 'audit-entry-invalid'));
    assert.equal(existsSync(join(dir, AUDIT_LOG_NAME)), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── chain mode ──────────────────────────────────────────────────────────────────

test('chain mode: first prevHash is null; second prevHash == sha256 of first written line', () => {
  const dir = tmp();
  try {
    const e1 = buildAuditEntry({ command: 'first', now: () => new Date('2026-06-01T12:00:00.000Z') });
    const e2 = buildAuditEntry({ command: 'second', now: () => new Date('2026-06-01T12:00:01.000Z') });
    const r1 = appendAuditEntry({ stateDir: dir, entry: e1, assertWritable: PASS, chain: true });
    const r2 = appendAuditEntry({ stateDir: dir, entry: e2, assertWritable: PASS, chain: true });
    assert.equal(r1.written, true);
    assert.equal(r2.written, true);

    const lines = rawLines(dir).filter((l) => l.trim());
    assert.equal(lines.length, 2);
    const first = JSON.parse(lines[0]);
    const second = JSON.parse(lines[1]);
    assert.equal(first.prevHash, null);                 // genesis
    assert.equal(second.prevHash, sha256Hex(lines[0])); // chained to the raw first line
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('chain mode off: no prevHash key in the line', () => {
  const dir = tmp();
  try {
    const e = buildAuditEntry({ command: 'apply', now: () => new Date(ISO) });
    appendAuditEntry({ stateDir: dir, entry: e, assertWritable: PASS });
    const parsed = JSON.parse(readFileSync(join(dir, AUDIT_LOG_NAME), 'utf8').trim());
    assert.ok(!('prevHash' in parsed));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── sequential appends + reader ordering ────────────────────────────────────────

test('3 sequential appends -> reader returns 3, newest-first', () => {
  const dir = tmp();
  try {
    appendAuditEntry({ stateDir: dir, assertWritable: PASS,
      entry: buildAuditEntry({ command: 'one', now: () => new Date('2026-06-01T12:00:00.000Z') }) });
    appendAuditEntry({ stateDir: dir, assertWritable: PASS,
      entry: buildAuditEntry({ command: 'two', now: () => new Date('2026-06-01T12:00:01.000Z') }) });
    appendAuditEntry({ stateDir: dir, assertWritable: PASS,
      entry: buildAuditEntry({ command: 'three', now: () => new Date('2026-06-01T12:00:02.000Z') }) });

    const { entries, summary } = readAuditLog({ stateDir: dir });
    assert.equal(entries.length, 3);
    assert.equal(summary.total, 3);
    // newest-first
    assert.equal(entries[0].command, 'three');
    assert.equal(entries[1].command, 'two');
    assert.equal(entries[2].command, 'one');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── large-entry split ───────────────────────────────────────────────────────────

test('appendAuditEntry: >4 KiB entry splits to audit-large/<uuid>.json + tiny pointer line', () => {
  const dir = tmp();
  try {
    const big = 'A'.repeat(5000); // > 4096 bytes once serialized
    const entry = buildAuditEntry({ command: big, snapshotId: '2026-06-01T12-00-00Z',
      now: () => new Date(ISO) });
    const r = appendAuditEntry({ stateDir: dir, entry, assertWritable: PASS });
    assert.equal(r.written, true);
    assert.equal(r.large, true);
    assert.ok(typeof r.ref === 'string' && r.ref.endsWith('.json'));
    assert.ok(r.diagnostics.some((d) => d.code === 'audit-entry-split' && d.severity === 'info'));

    // pointer line is small and parseable, and OMITS command (kept tiny)
    const ptr = JSON.parse(readFileSync(join(dir, AUDIT_LOG_NAME), 'utf8').trim());
    assert.equal(ptr.large, true);
    assert.equal(ptr.ref, r.ref);
    assert.equal(typeof ptr.sha256, 'string');
    assert.ok(!('command' in ptr));
    assert.ok(Buffer.byteLength(JSON.stringify(ptr), 'utf8') < 4096);

    // the full entry lives in audit-large/ and carries the big command
    const full = JSON.parse(readFileSync(join(dir, 'audit-large', r.ref), 'utf8'));
    assert.equal(full.command, big);
    // pointer.sha256 matches the full file content (with its 2-space-indent + \n)
    const fullContent = readFileSync(join(dir, 'audit-large', r.ref), 'utf8');
    assert.equal(ptr.sha256, sha256Hex(fullContent));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('appendAuditEntry: large split honors the gate on the large file too', () => {
  const dir = tmp();
  try {
    const big = 'B'.repeat(5000);
    const entry = buildAuditEntry({ command: big, now: () => new Date(ISO) });
    // gate denies ONLY the large file (path under audit-large)
    const gate = (p) => { if (String(p).includes('audit-large')) throw new Error('nope'); return p; };
    const r = appendAuditEntry({ stateDir: dir, entry, assertWritable: gate });
    assert.equal(r.written, false);
    assert.ok(r.diagnostics.some((d) => d.code === 'audit-write-error'));
    assert.equal(existsSync(join(dir, 'audit-large')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── never-throws ────────────────────────────────────────────────────────────────

test('appendAuditEntry: a throwing append seam -> written:false + diagnostic, no exception escapes', () => {
  const dir = tmp();
  try {
    const entry = buildAuditEntry({ command: 'apply', now: () => new Date(ISO) });
    const boom = () => { throw new Error('disk full'); };
    let r;
    assert.doesNotThrow(() => {
      r = appendAuditEntry({ stateDir: dir, entry, assertWritable: PASS, seams: { append: boom } });
    });
    assert.equal(r.written, false);
    assert.ok(r.diagnostics.some((d) => d.code === 'audit-write-error'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('appendAuditEntry: a throwing mkdir seam -> written:false, never throws', () => {
  const dir = tmp();
  try {
    const entry = buildAuditEntry({ command: 'apply', now: () => new Date(ISO) });
    const boom = () => { throw new Error('mkdir failed'); };
    let r;
    assert.doesNotThrow(() => {
      r = appendAuditEntry({ stateDir: dir, entry, assertWritable: PASS, seams: { mkdir: boom } });
    });
    assert.equal(r.written, false);
    assert.ok(r.diagnostics.some((d) => d.code === 'audit-write-error'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('appendAuditEntry: never throws with no args', () => {
  let r;
  assert.doesNotThrow(() => { r = appendAuditEntry(); });
  assert.equal(r.written, false);
  assert.ok(r.diagnostics.length > 0);
});

test('appendAuditEntry: a throwing accessor getter on the raw entry -> clean refuse, never throws', () => {
  const dir = tmp();
  try {
    // A pathological entry whose `command` getter throws must not abort an
    // in-flight apply — the I/O boundary refuses cleanly instead (LOW-1).
    const evil = { timestamp: ISO };
    Object.defineProperty(evil, 'command', { enumerable: true, get() { throw new Error('boom'); } });
    let r;
    assert.doesNotThrow(() => {
      r = appendAuditEntry({ stateDir: dir, entry: evil, assertWritable: PASS });
    });
    assert.equal(r.written, false);
    assert.ok(r.diagnostics.some((d) => d.code === 'audit-entry-invalid'));
    assert.equal(existsSync(join(dir, AUDIT_LOG_NAME)), false); // nothing written
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
