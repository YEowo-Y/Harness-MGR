/**
 * Tests for src/ops/stability-log.mjs (P3 gate infrastructure).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  parseStabilityLog,
  countGatePass,
  formatRow,
  appendStabilityRow,
  readStabilityLog,
} from '../src/ops/stability-log.mjs';

/** Path to the repo-root STABILITY-LOG.jsonl (read-only oracle). */
const REAL_LOG = fileURLToPath(new URL('../STABILITY-LOG.jsonl', import.meta.url));

// ---------------------------------------------------------------------------
// parseStabilityLog
// ---------------------------------------------------------------------------

test('parseStabilityLog: parses valid multi-row text', () => {
  const text = [
    '{"ts":"2026-05-24T00:00:00Z","cc_version":"2.1.146","gate_pass":true,"error_diag_count":0}',
    '{"ts":"2026-05-25T00:00:00Z","cc_version":"2.1.152","gate_pass":false,"error_diag_count":2,"note":"test"}',
  ].join('\n');

  const { rows, malformed } = parseStabilityLog(text);
  assert.equal(rows.length, 2);
  assert.equal(malformed, 0);
  assert.equal(rows[0].ts, '2026-05-24T00:00:00Z');
  assert.equal(rows[0].cc_version, '2.1.146');
  assert.equal(rows[0].gate_pass, true);
  assert.equal(rows[0].error_diag_count, 0);
  assert.equal(rows[1].note, 'test');
  assert.equal(rows[1].gate_pass, false);
});

test('parseStabilityLog: blank lines are skipped', () => {
  const text = '\n{"ts":"2026-05-24T00:00:00Z","cc_version":"x","gate_pass":true,"error_diag_count":0}\n\n';
  const { rows, malformed } = parseStabilityLog(text);
  assert.equal(rows.length, 1);
  assert.equal(malformed, 0);
});

test('parseStabilityLog: bad JSON line increments malformed and is skipped', () => {
  const text = [
    '{"ts":"2026-05-24T00:00:00Z","cc_version":"x","gate_pass":true,"error_diag_count":0}',
    'not valid json {{{',
  ].join('\n');
  const { rows, malformed } = parseStabilityLog(text);
  assert.equal(rows.length, 1);
  assert.equal(malformed, 1);
});

test('parseStabilityLog: JSON array line is malformed', () => {
  const text = '[{"gate_pass":true}]';
  const { rows, malformed } = parseStabilityLog(text);
  assert.equal(rows.length, 0);
  assert.equal(malformed, 1);
});

test('parseStabilityLog: JSON number line is malformed', () => {
  const text = '42';
  const { rows, malformed } = parseStabilityLog(text);
  assert.equal(rows.length, 0);
  assert.equal(malformed, 1);
});

test('parseStabilityLog: multiple malformed types all counted', () => {
  const text = [
    'bad json',
    '[1,2,3]',
    '99',
    '{"ts":"ok","cc_version":"x","gate_pass":true,"error_diag_count":0}',
  ].join('\n');
  const { rows, malformed } = parseStabilityLog(text);
  assert.equal(rows.length, 1);
  assert.equal(malformed, 3);
});

test('parseStabilityLog: non-string input returns empty result without throwing', () => {
  assert.doesNotThrow(() => {
    const { rows, malformed } = parseStabilityLog(null);
    assert.equal(rows.length, 0);
    assert.equal(malformed, 0);
  });
});

// ---------------------------------------------------------------------------
// Proto-poisoning safety
// ---------------------------------------------------------------------------

test('parseStabilityLog: proto-poisoning line does not pollute Object.prototype', () => {
  const text = '{"__proto__":{"x":1},"gate_pass":true,"ts":"t","cc_version":"v","error_diag_count":0}';
  const { rows } = parseStabilityLog(text);
  // Should not throw and Object.prototype must not be mutated
  assert.equal(/** @type {any} */ ({}).x, undefined, '__proto__ must not leak to Object.prototype');
  // The row itself should still exist (gate_pass field survives)
  assert.equal(rows.length, 1);
});

test('parseStabilityLog: proto-poisoning row still counts as gate_pass', () => {
  const text = '{"__proto__":{"x":1},"gate_pass":true,"ts":"t","cc_version":"v","error_diag_count":0}';
  const { rows } = parseStabilityLog(text);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].gate_pass, true);
  // __proto__ key must be stripped from the row
  assert.equal(Object.prototype.hasOwnProperty.call(rows[0], '__proto__'), false);
});

// ---------------------------------------------------------------------------
// countGatePass
// ---------------------------------------------------------------------------

test('countGatePass: counts strict boolean true only', () => {
  const text = [
    '{"ts":"a","cc_version":"x","gate_pass":true,"error_diag_count":0}',
    '{"ts":"b","cc_version":"x","gate_pass":true,"error_diag_count":0}',
    '{"ts":"c","cc_version":"x","gate_pass":false,"error_diag_count":1}',
  ].join('\n');
  assert.equal(countGatePass(text), 2);
});

test('countGatePass: string "true" does not count', () => {
  const text = '{"ts":"a","cc_version":"x","gate_pass":"true","error_diag_count":0}';
  assert.equal(countGatePass(text), 0);
});

test('countGatePass: number 1 does not count', () => {
  const text = '{"ts":"a","cc_version":"x","gate_pass":1,"error_diag_count":0}';
  assert.equal(countGatePass(text), 0);
});

test('countGatePass: absent gate_pass does not count', () => {
  const text = '{"ts":"a","cc_version":"x","error_diag_count":0}';
  assert.equal(countGatePass(text), 0);
});

test('countGatePass: false gate_pass does not count', () => {
  const text = '{"ts":"a","cc_version":"x","gate_pass":false,"error_diag_count":0}';
  assert.equal(countGatePass(text), 0);
});

test('countGatePass: accepts an already-parsed rows array', () => {
  const rows = [
    { ts: 'a', cc_version: 'x', gate_pass: true, error_diag_count: 0 },
    { ts: 'b', cc_version: 'x', gate_pass: false, error_diag_count: 0 },
    { ts: 'c', cc_version: 'x', gate_pass: true, error_diag_count: 0 },
  ];
  assert.equal(countGatePass(rows), 2);
});

test('countGatePass: empty text returns 0', () => {
  assert.equal(countGatePass(''), 0);
});

// ---------------------------------------------------------------------------
// formatRow
// ---------------------------------------------------------------------------

test('formatRow: stable key order ts/cc_version/gate_pass/error_diag_count', () => {
  const row = { ts: '2026-05-24T00:00:00Z', cc_version: '2.1.146', gate_pass: true, error_diag_count: 0 };
  const out = formatRow(row);
  const parsed = JSON.parse(out);
  const keys = Object.keys(parsed);
  assert.deepEqual(keys, ['ts', 'cc_version', 'gate_pass', 'error_diag_count']);
});

test('formatRow: note appears last when present', () => {
  const row = { ts: 't', cc_version: 'v', gate_pass: true, error_diag_count: 0, note: 'hello' };
  const out = formatRow(row);
  const parsed = JSON.parse(out);
  const keys = Object.keys(parsed);
  assert.deepEqual(keys, ['ts', 'cc_version', 'gate_pass', 'error_diag_count', 'note']);
  assert.equal(parsed.note, 'hello');
});

test('formatRow: note omitted when not present', () => {
  const row = { ts: 't', cc_version: 'v', gate_pass: true, error_diag_count: 0 };
  const out = formatRow(row);
  const parsed = JSON.parse(out);
  assert.equal(Object.prototype.hasOwnProperty.call(parsed, 'note'), false);
});

test('formatRow: round-trips through parseStabilityLog', () => {
  const row = { ts: '2026-05-24T00:00:00Z', cc_version: '2.1.152', gate_pass: true, error_diag_count: 3, note: 'test note' };
  const formatted = formatRow(row);
  const { rows } = parseStabilityLog(formatted);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ts, row.ts);
  assert.equal(rows[0].cc_version, row.cc_version);
  assert.equal(rows[0].gate_pass, row.gate_pass);
  assert.equal(rows[0].error_diag_count, row.error_diag_count);
  assert.equal(rows[0].note, row.note);
});

test('formatRow: never throws on a BigInt value', () => {
  assert.doesNotThrow(() => {
    const row = { ts: 'x', cc_version: 'v', gate_pass: false, error_diag_count: 0, note: /** @type {any} */ (BigInt(42)) };
    const out = formatRow(row);
    assert.ok(typeof out === 'string' && out.length > 0);
  });
});

test('formatRow: never throws on null input', () => {
  assert.doesNotThrow(() => {
    const out = formatRow(/** @type {any} */ (null));
    assert.ok(typeof out === 'string' && out.length > 0);
  });
});

test('formatRow: produces compact single-line JSON (no newlines)', () => {
  const row = { ts: 't', cc_version: 'v', gate_pass: true, error_diag_count: 0 };
  const out = formatRow(row);
  assert.ok(!out.includes('\n'));
});

// ---------------------------------------------------------------------------
// appendStabilityRow (uses TEMP file)
// ---------------------------------------------------------------------------

test('appendStabilityRow: creates file and appends a row', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stability-log-test-'));
  const logPath = join(dir, 'TEST-STABILITY.jsonl');
  try {
    const row = { ts: '2026-05-24T00:00:00Z', cc_version: '2.1.146', gate_pass: true, error_diag_count: 0 };
    const { ok, diagnostics } = appendStabilityRow({ logPath, row });
    assert.equal(ok, true);
    assert.equal(diagnostics.length, 0);

    const content = readFileSync(logPath, 'utf8');
    const lines = content.split('\n').filter(Boolean);
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.ts, row.ts);
    assert.equal(parsed.gate_pass, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('appendStabilityRow: appends multiple rows', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stability-log-test-'));
  const logPath = join(dir, 'TEST-STABILITY.jsonl');
  try {
    const rows = [
      { ts: '2026-05-24T00:00:00Z', cc_version: '2.1.146', gate_pass: true, error_diag_count: 0 },
      { ts: '2026-05-25T00:00:00Z', cc_version: '2.1.152', gate_pass: false, error_diag_count: 1 },
    ];
    for (const row of rows) {
      appendStabilityRow({ logPath, row });
    }
    const content = readFileSync(logPath, 'utf8');
    const lines = content.split('\n').filter(Boolean);
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).ts, rows[0].ts);
    assert.equal(JSON.parse(lines[1]).gate_pass, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('appendStabilityRow: returns ok:false with diagnostic on bad logPath', () => {
  const { ok, diagnostics } = appendStabilityRow({ logPath: '', row: { ts: 't', cc_version: 'v', gate_pass: true, error_diag_count: 0 } });
  assert.equal(ok, false);
  assert.ok(diagnostics.length > 0);
  assert.equal(diagnostics[0].phase, 'stability-log');
});

test('appendStabilityRow: never throws', () => {
  assert.doesNotThrow(() => appendStabilityRow(/** @type {any} */ ({})));
  assert.doesNotThrow(() => appendStabilityRow(/** @type {any} */ (null)));
});

// ---------------------------------------------------------------------------
// readStabilityLog
// ---------------------------------------------------------------------------

test('readStabilityLog: missing file returns missing:true and benign empty', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stability-log-test-'));
  const logPath = join(dir, 'NONEXISTENT.jsonl');
  try {
    const result = readStabilityLog({ logPath });
    assert.equal(result.missing, true);
    assert.deepEqual(result.rows, []);
    assert.equal(result.malformed, 0);
    assert.equal(result.gatePassCount, 0);
    assert.deepEqual(result.diagnostics, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readStabilityLog: reads rows and computes gatePassCount', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stability-log-test-'));
  const logPath = join(dir, 'TEST.jsonl');
  try {
    const text = [
      '{"ts":"a","cc_version":"x","gate_pass":true,"error_diag_count":0}',
      '{"ts":"b","cc_version":"x","gate_pass":false,"error_diag_count":1}',
      '{"ts":"c","cc_version":"x","gate_pass":true,"error_diag_count":0}',
    ].join('\n') + '\n';
    writeFileSync(logPath, text, 'utf8');

    const result = readStabilityLog({ logPath });
    assert.equal(result.missing, false);
    assert.equal(result.rows.length, 3);
    assert.equal(result.malformed, 0);
    assert.equal(result.gatePassCount, 2);
    assert.deepEqual(result.diagnostics, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readStabilityLog: malformed lines counted in result', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stability-log-test-'));
  const logPath = join(dir, 'TEST.jsonl');
  try {
    const text = [
      '{"ts":"a","cc_version":"x","gate_pass":true,"error_diag_count":0}',
      'not json',
    ].join('\n') + '\n';
    writeFileSync(logPath, text, 'utf8');

    const result = readStabilityLog({ logPath });
    assert.equal(result.rows.length, 1);
    assert.equal(result.malformed, 1);
    assert.equal(result.gatePassCount, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readStabilityLog: returns diagnostic on bad logPath', () => {
  const result = readStabilityLog({ logPath: '' });
  assert.ok(result.diagnostics.length > 0);
  assert.equal(result.diagnostics[0].phase, 'stability-log');
});

test('readStabilityLog: never throws with no args', () => {
  assert.doesNotThrow(() => readStabilityLog(/** @type {any} */ (undefined)));
});

// ---------------------------------------------------------------------------
// Real STABILITY-LOG.jsonl oracle.
// gate_pass rows are APPEND-ONLY (>=4 backfilled, then one per release-gate
// run toward the >=20 gate-exit floor), so this asserts a monotonic LOWER
// BOUND rather than an exact count — an exact `=== N` would break on every
// legitimate gate-pass append. malformed/diagnostics stay exact: the committed
// real log must always be well-formed.
// ---------------------------------------------------------------------------

test('readStabilityLog: real STABILITY-LOG.jsonl gatePassCount >= 4 (append-only)', () => {
  const result = readStabilityLog({ logPath: REAL_LOG });
  assert.equal(result.missing, false);
  assert.ok(result.gatePassCount >= 4, `expected >=4 gate_pass:true rows, got ${result.gatePassCount}`);
  assert.equal(result.malformed, 0, `expected 0 malformed lines, got ${result.malformed}`);
  assert.equal(result.diagnostics.length, 0);
});
