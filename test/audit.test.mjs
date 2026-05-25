/**
 * Tests for src/ops/audit.mjs (P2.U10).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { parseSince, toEpochMs, readAuditLog } from '../src/ops/audit.mjs';

/** Fixture dir containing audit.log (7 lines: 5 timestamped, 1 malformed, 1 no-timestamp). */
const FIX = fileURLToPath(new URL('./fixtures/audit-log', import.meta.url));

/** Fixtures dir itself (no audit.log directly inside). */
const FIX_PARENT = fileURLToPath(new URL('./fixtures', import.meta.url));

/** Pinned clock: 2026-05-25T00:00:00.000Z */
const NOW = () => Date.parse('2026-05-25T00:00:00.000Z');

// ---------------------------------------------------------------------------
// parseSince
// ---------------------------------------------------------------------------
test('parseSince: valid durations', () => {
  assert.equal(parseSince('7d'), 604800000);
  assert.equal(parseSince('24h'), 86400000);
  assert.equal(parseSince('30m'), 1800000);
  assert.equal(parseSince('45s'), 45000);
  assert.equal(parseSince('2w'), 1209600000);
});

test('parseSince: trims whitespace', () => {
  assert.equal(parseSince(' 7d '), 604800000);
});

test('parseSince: invalid inputs return null', () => {
  assert.equal(parseSince('7x'), null);
  assert.equal(parseSince('abc'), null);
  assert.equal(parseSince(''), null);
  assert.equal(parseSince('7'), null);
  assert.equal(parseSince('-3d'), null);
  assert.equal(parseSince(null), null);
  assert.equal(parseSince(undefined), null);
  assert.equal(parseSince(42), null);
});

// ---------------------------------------------------------------------------
// toEpochMs
// ---------------------------------------------------------------------------
test('toEpochMs: ISO string -> epoch', () => {
  assert.equal(toEpochMs('2026-05-24T10:00:00.000Z'), Date.parse('2026-05-24T10:00:00.000Z'));
});

test('toEpochMs: finite number -> itself', () => {
  assert.equal(toEpochMs(1779408000000), 1779408000000);
});

test('toEpochMs: unparseable string -> null', () => {
  assert.equal(toEpochMs('not-a-date'), null);
});

test('toEpochMs: NaN -> null', () => {
  assert.equal(toEpochMs(NaN), null);
});

test('toEpochMs: Infinity -> null', () => {
  assert.equal(toEpochMs(Infinity), null);
});

test('toEpochMs: object -> null', () => {
  assert.equal(toEpochMs({}), null);
});

test('toEpochMs: null -> null', () => {
  assert.equal(toEpochMs(null), null);
});

// ---------------------------------------------------------------------------
// readAuditLog -- --since 7d filter
// ---------------------------------------------------------------------------
test('readAuditLog: --since 7d returns 3 entries newest-first', () => {
  const { entries, summary } = readAuditLog({ stateDir: FIX, since: '7d', now: NOW });
  // NOW = 2026-05-25; cutoff = 2026-05-18. Qualifying: 05-24, 05-22(epoch-ms), 05-20.
  assert.equal(entries.length, 3);
  assert.equal(entries[0].command, 'snapshot');   // 2026-05-24
  assert.equal(entries[1].command, 'gc');          // 2026-05-22 (epoch-ms)
  assert.equal(entries[2].command, 'rollback');    // 2026-05-20
  assert.equal(summary.skippedMalformed, 1);
  assert.equal(summary.total, 6);                  // 6 well-formed entries seen before the filter
  assert.equal(summary.returned, 3);               // 3 within the 7d window — "3 of 6"
});

test('readAuditLog: --since 7d excludes 05-10, 05-01, and no-timestamp entry', () => {
  const { entries } = readAuditLog({ stateDir: FIX, since: '7d', now: NOW });
  const commands = entries.map((e) => e.command);
  assert.ok(!commands.includes('no-timestamp-entry'));
  // 05-10 snapshot should not be present
  const old = entries.find((e) => e.snapshotId === '2026-05-10T12-00-00');
  assert.equal(old, undefined);
});

// ---------------------------------------------------------------------------
// readAuditLog -- no --since (all entries)
// ---------------------------------------------------------------------------
test('readAuditLog: no since returns 6 entries (5 timestamped + 1 no-timestamp)', () => {
  const { entries, summary } = readAuditLog({ stateDir: FIX, now: NOW });
  assert.equal(entries.length, 6);
  assert.equal(summary.skippedMalformed, 1);
});

test('readAuditLog: no since includes no-timestamp entry', () => {
  const { entries } = readAuditLog({ stateDir: FIX, now: NOW });
  const noTs = entries.find((e) => e.command === 'no-timestamp-entry');
  assert.ok(noTs, 'no-timestamp-entry should be present');
});

test('readAuditLog: no since newest-first order (null epoch sorts last)', () => {
  const { entries } = readAuditLog({ stateDir: FIX, now: NOW });
  // First entry should be the most recent timestamped (2026-05-24)
  assert.equal(entries[0].command, 'snapshot');
  assert.equal(entries[0].snapshotId, '2026-05-24T10-00-00');
  // Last entry should be no-timestamp-entry (null epoch sorts last)
  assert.equal(entries[entries.length - 1].command, 'no-timestamp-entry');
});

// ---------------------------------------------------------------------------
// readAuditLog -- invalid --since
// ---------------------------------------------------------------------------
test('readAuditLog: invalid --since emits warn and shows all entries', () => {
  const { entries, diagnostics } = readAuditLog({ stateDir: FIX, since: 'banana', now: NOW });
  const d = diagnostics.find((x) => x.code === 'audit-since-invalid');
  assert.ok(d, 'should have audit-since-invalid diagnostic');
  assert.equal(d.severity, 'warn');
  assert.equal(entries.length, 6);
});

// ---------------------------------------------------------------------------
// readAuditLog -- missing audit.log (ENOENT is benign)
// ---------------------------------------------------------------------------
test('readAuditLog: missing audit.log returns empty with no diagnostics', () => {
  const { entries, diagnostics } = readAuditLog({ stateDir: FIX_PARENT, now: NOW });
  assert.equal(entries.length, 0);
  assert.equal(diagnostics.length, 0);
});

// ---------------------------------------------------------------------------
// readAuditLog -- bad stateDir
// ---------------------------------------------------------------------------
test('readAuditLog: missing stateDir emits error diagnostic', () => {
  const { entries, diagnostics } = readAuditLog({});
  const d = diagnostics.find((x) => x.code === 'audit-bad-state-dir');
  assert.ok(d, 'should have audit-bad-state-dir');
  assert.equal(d.severity, 'error');
  assert.deepEqual(entries, []);
});

test('readAuditLog: numeric stateDir emits error diagnostic', () => {
  const { entries, diagnostics } = readAuditLog({ stateDir: 42 });
  const d = diagnostics.find((x) => x.code === 'audit-bad-state-dir');
  assert.ok(d);
  assert.deepEqual(entries, []);
});

// ---------------------------------------------------------------------------
// readAuditLog -- never throws
// ---------------------------------------------------------------------------
test('readAuditLog: does not throw with no args', () => {
  assert.doesNotThrow(() => readAuditLog());
});

test('readAuditLog: does not throw with null', () => {
  assert.doesNotThrow(() => readAuditLog(null));
});

// ---------------------------------------------------------------------------
// summary: oldest / newest
// ---------------------------------------------------------------------------
test('readAuditLog: summary newest and oldest from non-null epochs', () => {
  const { summary } = readAuditLog({ stateDir: FIX, now: NOW });
  // newest = 2026-05-24T10:00:00.000Z, oldest = 2026-05-01T09:00:00.000Z
  assert.equal(summary.newest, '2026-05-24T10:00:00.000Z');
  assert.equal(summary.oldest, '2026-05-01T09:00:00.000Z');
});

// ---------------------------------------------------------------------------
// readAuditLog -- BOM + CRLF tolerance (line-split contract)
// ---------------------------------------------------------------------------
test('readAuditLog: tolerates a leading BOM and CRLF line endings', () => {
  // U+FEFF is ECMAScript whitespace, so per-line .trim() strips a leading BOM;
  // .split(/\r?\n/) handles CRLF. readFn injection avoids a byte-fragile fixture.
  const text = '﻿{"timestamp":"2026-05-24T10:00:00.000Z","command":"a"}\r\n' +
    '{"timestamp":"2026-05-20T10:00:00.000Z","command":"b"}\r\n';
  const { entries, summary } = readAuditLog({ stateDir: '/x', now: NOW, readFn: () => text });
  assert.equal(entries.length, 2);
  assert.equal(summary.skippedMalformed, 0);
  assert.equal(entries[0].command, 'a'); // newest-first (05-24 before 05-20)
});
