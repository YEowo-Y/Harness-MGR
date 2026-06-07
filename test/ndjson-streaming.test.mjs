/**
 * NDJSON streaming polish (P4b.U8).
 *
 * Proves the `--format ndjson` contract is FIRST-CLASS and correct:
 *   (a) the `ndjsonLines` generator seam — line shape, order, the
 *       formatNdjson === join(ndjsonLines) refactor invariant, never-throws;
 *   (b) CROSS-PHASE correctness via real run(): every PHYSICAL line of stdout is
 *       independently JSON.parse-able (THE ndjson invariant — one record per line,
 *       no embedded raw newline) for a representative command set, including the
 *       critical config:diff embedded-newline case;
 *   (c) MULTI-MB SCALE — a >1 MB in-memory payload streams as 1+N parseable lines,
 *       deterministically, without blowup, and can be consumed line-at-a-time;
 *   (d) never-throws — an unserializable result degrades to the error envelope.
 *
 * The ndjson invariant under test: splitting stdout on '\n' yields exactly the
 * records, because each record is compact (indent:0) so a newline-bearing field
 * (e.g. a multi-line unified diff) is JSON-escaped to `\n` INSIDE its single line,
 * never split across physical lines.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { run } from '../src/cli.mjs';
import { formatNdjson, ndjsonLines } from '../src/output/json.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fix = (rel) => join(here, 'fixtures', rel);
const MIN = fix('minimal');

// ── (a) ndjsonLines unit ─────────────────────────────────────────────────────────

test('(a) ndjsonLines yields exactly 1 + diagnostics.length lines, in order', () => {
  const diagnostics = [
    { severity: 'warn', code: 'd1', message: 'first', phase: 'cli' },
    { severity: 'error', code: 'd2', message: 'second', phase: 'scan' },
    { severity: 'info', code: 'd3', message: 'third' },
  ];
  const payload = { command: 'demo', result: { counts: { skills: 7 } }, diagnostics };
  const lines = [...ndjsonLines(payload)];

  assert.equal(lines.length, 1 + diagnostics.length, 'line count is 1 + N');

  // line 0 = the result record, with the command result nested under `result`.
  const head = JSON.parse(lines[0]);
  assert.equal(head.type, 'result');
  assert.equal(head.command, 'demo');
  assert.equal(head.version, 1);
  assert.deepEqual(head.result, { counts: { skills: 7 } }, 'result is nested under `result`');

  // each later line = a diagnostic record preserving the input fields + order.
  for (let i = 0; i < diagnostics.length; i += 1) {
    const rec = JSON.parse(lines[i + 1]);
    assert.equal(rec.type, 'diagnostic');
    assert.equal(rec.code, diagnostics[i].code, `diagnostic ${i} code preserved + ordered`);
    assert.equal(rec.severity, diagnostics[i].severity);
    assert.equal(rec.message, diagnostics[i].message);
  }
});

test('(a) formatNdjson(payload) === [...ndjsonLines(payload)].join("\\n") — refactor invariant', () => {
  for (const payload of [
    { command: 'a', result: { x: 1, nested: { y: [3, 2, 1] } }, diagnostics: [{ severity: 'warn', code: 'c', message: 'm' }] },
    { command: 'b', result: { type: 'collide', command: 'collide', version: 99 }, diagnostics: [] },
    { command: 'c', result: null, diagnostics: [{ severity: 'info', code: 'i', message: 'note' }, { severity: 'error', code: 'e', message: 'bad' }] },
  ]) {
    assert.equal(formatNdjson(payload), [...ndjsonLines(payload)].join('\n'), `byte-identical for command ${payload.command}`);
  }
});

test('(a) a result carrying type/command/version cannot clobber the envelope fields', () => {
  const [head] = [...ndjsonLines({ command: 'real', result: { type: 'evil', command: 'evil', version: 999 }, diagnostics: [] })];
  const rec = JSON.parse(head);
  assert.equal(rec.type, 'result', 'envelope type wins');
  assert.equal(rec.command, 'real', 'envelope command wins');
  assert.equal(rec.version, 1, 'envelope version wins');
  assert.deepEqual(rec.result, { type: 'evil', command: 'evil', version: 999 }, 'payload preserved under `result`');
});

test('(a) non-array diagnostics → just the result line; null/weird payload never throws', () => {
  // non-array diagnostics coerced to [].
  assert.equal([...ndjsonLines({ command: 'x', result: {}, diagnostics: 'nope' })].length, 1);
  assert.equal([...ndjsonLines({ command: 'x', result: {}, diagnostics: undefined })].length, 1);
  assert.equal([...ndjsonLines({ command: 'x', result: {}, diagnostics: 42 })].length, 1);

  // weird / absent payloads must not throw — the generator is total.
  assert.doesNotThrow(() => [...ndjsonLines()], 'no-arg call');
  assert.doesNotThrow(() => [...ndjsonLines({})], 'empty object');
  assert.doesNotThrow(() => [...ndjsonLines({ command: null, result: undefined, diagnostics: null })], 'all nullish');
  assert.doesNotThrow(() => formatNdjson({ command: 'x', result: {}, diagnostics: null }), 'formatNdjson null diags');
});

// ── (b) CROSS-PHASE correctness via real run() ────────────────────────────────────

/**
 * Run a command with --format ndjson and assert THE ndjson invariant: every
 * physical line independently parses, line 0 is the result with the expected
 * canonical command, and every later line is a diagnostic.
 *
 * @param {string[]} argv          the command argv (WITHOUT --format ndjson)
 * @param {string} expectCommand   the canonical command name expected on line 0
 */
async function assertNdjsonShape(argv, expectCommand) {
  const { stdout } = await run([...argv, '--format', 'ndjson']);
  const physicalLines = stdout.split('\n');
  assert.ok(physicalLines.length >= 1, `${expectCommand}: at least one physical line`);

  // THE invariant: one record per physical line, no embedded raw newline.
  for (const line of physicalLines) {
    let parsed;
    assert.doesNotThrow(() => { parsed = JSON.parse(line); }, `${expectCommand}: every physical line must be valid JSON: ${line.slice(0, 120)}`);
    void parsed;
  }

  const head = JSON.parse(physicalLines[0]);
  assert.equal(head.type, 'result', `${expectCommand}: line 0 is type:result`);
  assert.equal(head.command, expectCommand, `${expectCommand}: line 0 command matches canonical`);

  for (let i = 1; i < physicalLines.length; i += 1) {
    assert.equal(JSON.parse(physicalLines[i]).type, 'diagnostic', `${expectCommand}: line ${i} is type:diagnostic`);
  }
}

test('(b) inventory ndjson — every physical line parses, line 0 = result', async () => {
  await assertNdjsonShape(['inventory', '--config-dir', MIN], 'inventory');
});

test('(b) conflicts ndjson — every physical line parses, line 0 = result', async () => {
  await assertNdjsonShape(['conflicts', '--config-dir', MIN], 'conflicts');
});

test('(b) doctor (passive) ndjson — every physical line parses, line 0 = result', async () => {
  await assertNdjsonShape(['doctor', '--config-dir', MIN], 'doctor');
});

test('(b) drift ndjson — every physical line parses, line 0 = result', async () => {
  await assertNdjsonShape(['drift', '--config-dir', MIN], 'drift');
});

test('(b) audit ndjson — every physical line parses, line 0 = result', async () => {
  await assertNdjsonShape(['audit', '--config-dir', MIN], 'audit');
});

test('(b) update <plugin> dry-run ndjson — every physical line parses, line 0 = result', async () => {
  // Read-only dry-run (no --apply): the engine refuses/previews, writes nothing.
  await assertNdjsonShape(['update', 'some-plugin', '--config-dir', MIN], 'update');
});

test('(b) mcp remove <name> dry-run ndjson — every physical line parses, line 0 = result', async () => {
  // Read-only dry-run (no --apply): canonical command is the two-word `mcp:remove`.
  await assertNdjsonShape(['mcp', 'remove', 'some-server', '--config-dir', MIN], 'mcp:remove');
});

test('(b) config diff ndjson — every physical line parses, line 0 = config:diff', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ndjson-diff-shape-'));
  try {
    const a = join(dir, 'a.txt');
    const b = join(dir, 'b.txt');
    await writeFile(a, 'one\ntwo\nthree\n');
    await writeFile(b, 'one\nTWO\nthree\n');
    await assertNdjsonShape(['config', 'diff', a, b], 'config:diff');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('(b) THE embedded-newline case: config diff multi-line unified is ONE physical line', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ndjson-diff-newline-'));
  try {
    // Two files differing over several lines → a MULTI-LINE unified diff string.
    const a = join(dir, 'a.txt');
    const b = join(dir, 'b.txt');
    const aText = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'].join('\n') + '\n';
    const bText = ['alpha', 'BRAVO', 'charlie', 'DELTA', 'echo', 'FOXTROT'].join('\n') + '\n';
    await writeFile(a, aText);
    await writeFile(b, bText);

    const { stdout } = await run(['config', 'diff', a, b, '--format', 'ndjson']);
    const physicalLines = stdout.split('\n');

    // The result line must be EXACTLY ONE physical line even though result.unified
    // is multi-line: the newlines are JSON-escaped to `\n` inside the single record.
    const head = JSON.parse(physicalLines[0]);
    assert.equal(head.type, 'result');
    assert.equal(head.command, 'config:diff');
    assert.equal(typeof head.result.unified, 'string', 'result.unified is a string');
    assert.ok(head.result.unified.includes('\n'), 'the unified string is genuinely multi-line');
    assert.ok(head.result.changed === true, 'the files genuinely differ');

    // Round-trip proof: the escaped single line decodes back to the multi-line string,
    // so no information was lost and no line was split across physical lines.
    const roundTrip = JSON.parse(physicalLines[0]).result.unified;
    assert.equal(roundTrip, head.result.unified, 'unified round-trips through ndjson');
    assert.ok(roundTrip.split('\n').length >= 4, 'unified spans several logical lines but one physical line');

    // And — the whole point — every physical line still parses independently.
    for (const line of physicalLines) {
      assert.doesNotThrow(() => JSON.parse(line), `physical line must parse: ${line.slice(0, 120)}`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── (c) MULTI-MB SCALE (the DoD) ───────────────────────────────────────────────────

/**
 * Build a >1 MB in-memory ndjson payload: N sizable diagnostics plus a large
 * nested result array.
 *
 * @param {number} n   diagnostic count
 * @returns {{ command: string, result: unknown, diagnostics: unknown[] }}
 */
function makeLargePayload(n) {
  const filler = 'x'.repeat(200); // sizable per-message body
  const diagnostics = [];
  for (let i = 0; i < n; i += 1) {
    diagnostics.push({ severity: i % 3 === 0 ? 'error' : 'warn', code: `bulk-${i}`, phase: 'scale', message: `diagnostic #${i}: ${filler}` });
  }
  const items = [];
  for (let i = 0; i < 2000; i += 1) items.push({ id: i, label: `item-${i}-${'y'.repeat(40)}` });
  return { command: 'scale', result: { items, total: items.length }, diagnostics };
}

test('(c) multi-MB: 1+N parseable lines, >1 MB serialized, deterministic, no blowup', () => {
  const N = 5000;
  const payload = makeLargePayload(N);

  // formatNdjson over the large payload — must complete + not throw.
  let out;
  assert.doesNotThrow(() => { out = formatNdjson(payload); }, 'formatNdjson must not throw at scale');

  // Genuinely multi-MB.
  const bytes = Buffer.byteLength(out, 'utf8');
  assert.ok(bytes > 1_000_000, `serialized output must exceed 1 MB, got ${bytes} bytes`);

  // 1 + N lines, every line independently parseable.
  const lines = out.split('\n');
  assert.equal(lines.length, 1 + N, `line count is 1 + ${N}`);
  for (let i = 0; i < lines.length; i += 1) {
    const rec = JSON.parse(lines[i]);
    assert.equal(rec.type, i === 0 ? 'result' : 'diagnostic', `line ${i} has the right type`);
  }

  // Determinism: two independent serializations are identical.
  const out2 = formatNdjson(makeLargePayload(N));
  assert.equal(out, out2, 'two runs produce identical output (deterministic)');
});

test('(c) streaming seam: consume lines one at a time without materializing the join', () => {
  const N = 5000;
  const payload = makeLargePayload(N);

  // Pull lines from the generator one at a time — never build the joined string.
  let count = 0;
  let sawResult = false;
  let sawDiagnostic = false;
  let maxLineBytes = 0;
  for (const line of ndjsonLines(payload)) {
    const rec = JSON.parse(line); // each pulled line is independently valid
    if (count === 0) { assert.equal(rec.type, 'result'); sawResult = true; }
    else { assert.equal(rec.type, 'diagnostic'); sawDiagnostic = true; }
    maxLineBytes = Math.max(maxLineBytes, Buffer.byteLength(line, 'utf8'));
    count += 1;
  }
  assert.equal(count, 1 + N, 'iterated exactly 1 + N lines');
  assert.ok(sawResult && sawDiagnostic, 'saw both record kinds');
  assert.ok(maxLineBytes > 0, 'each line was non-empty');
});

// ── (d) never-throws on unserializable result ─────────────────────────────────────

test('(d) unserializable result (BigInt) → error-envelope string, no throw', () => {
  const payload = { command: 'bad', result: { n: 10n }, diagnostics: [] };
  let lines;
  assert.doesNotThrow(() => { lines = [...ndjsonLines(payload)]; }, 'BigInt result must not throw');
  // The result line degraded to the error envelope per stableStringify's contract.
  const head = JSON.parse(lines[0]);
  assert.equal(head.error, 'unserializable', 'degraded to the error envelope');
  // formatNdjson mirrors the generator — same degradation, no throw.
  let out;
  assert.doesNotThrow(() => { out = formatNdjson(payload); });
  assert.equal(JSON.parse(out.split('\n')[0]).error, 'unserializable');
});

test('(d) circular result → error-envelope string, no throw', () => {
  const circular = { a: 1 };
  circular.self = circular; // cycle
  const payload = { command: 'bad', result: circular, diagnostics: [{ severity: 'warn', code: 'ok', message: 'still emitted' }] };
  let lines;
  assert.doesNotThrow(() => { lines = [...ndjsonLines(payload)]; }, 'circular result must not throw');
  assert.equal(JSON.parse(lines[0]).error, 'unserializable', 'result line degraded');
  // A bad result must not poison the (serializable) diagnostic lines.
  assert.equal(lines.length, 2, 'diagnostic line still emitted');
  assert.equal(JSON.parse(lines[1]).type, 'diagnostic');
  assert.equal(JSON.parse(lines[1]).code, 'ok');
});

test('(d) unserializable diagnostic → that line degrades, others unaffected, no throw', () => {
  const payload = {
    command: 'mixed',
    result: { ok: true },
    diagnostics: [
      { severity: 'warn', code: 'fine', message: 'first' },
      { severity: 'error', code: 'bad', message: 'has bigint', n: 7n },
      { severity: 'info', code: 'also-fine', message: 'third' },
    ],
  };
  let lines;
  assert.doesNotThrow(() => { lines = [...ndjsonLines(payload)]; });
  assert.equal(lines.length, 4, 'result + 3 diagnostics');
  assert.equal(JSON.parse(lines[0]).result.ok, true, 'result intact');
  assert.equal(JSON.parse(lines[1]).code, 'fine');
  assert.equal(JSON.parse(lines[2]).error, 'unserializable', 'the BigInt diagnostic degraded');
  assert.equal(JSON.parse(lines[3]).code, 'also-fine', 'the trailing diagnostic still emitted');
});
