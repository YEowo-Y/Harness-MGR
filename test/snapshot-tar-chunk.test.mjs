/**
 * P3.D1 — snapshot-tar-chunk.mjs unit tests (the argv chunker).
 *
 * Pure function, no fs/spawn. Proves the greedy budget partition AND the
 * UNICODE-SAFE invariant: every non-ASCII-named member rides chunk 0 (the only
 * chunk written by the wide-char-safe `-c` create), only ASCII members spill into
 * later (`-r` append) chunks. Boundary cases, single-oversized-member (tooLong),
 * non-ASCII-overflow (unicodeOverflow), and empty list are all covered, plus the
 * no-loss/no-dup property.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { chunkByArgvBudget, hasNonAscii } from '../src/ops/snapshot-tar-chunk.mjs';

/** Cost the chunker assigns one member: UTF-8 byte length + 1 (the join separator) (#11). */
const cost = (s) => Buffer.byteLength(s, 'utf8') + 1;
/** Sum of a chunk's fixed-overhead + member costs (what the chunker bounds). */
function chunkArgv(overhead, members) {
  return overhead + members.reduce((n, m) => n + cost(m), 0);
}

// ── hasNonAscii ──────────────────────────────────────────────────────────────────

test('hasNonAscii: true only when a code unit exceeds 0x7F', () => {
  assert.equal(hasNonAscii('plain/ascii-name.md'), false);
  assert.equal(hasNonAscii('café.md'), true);   // é = U+00E9
  assert.equal(hasNonAscii('日本語.md'), true);  // CJK
  assert.equal(hasNonAscii('a@b.md'), false);   // @ is ASCII
  assert.equal(hasNonAscii(''), false);
});

// ── ASCII-only partition (unchanged greedy budget behavior) ───────────────────────

test('chunkByArgvBudget: a list that fits the budget is a single chunk', () => {
  const files = ['agents/a.md', 'agents/b.md', 'skills/s/SKILL.md'];
  const { chunks, tooLong, unicodeOverflow } = chunkByArgvBudget(files, 30, 1000);
  assert.equal(tooLong, undefined);
  assert.equal(unicodeOverflow, undefined);
  assert.equal(chunks.length, 1);
  assert.deepEqual(chunks[0], files);
});

test('chunkByArgvBudget: an over-budget ASCII list splits into multiple chunks', () => {
  const files = ['a'.repeat(20), 'b'.repeat(20), 'c'.repeat(20), 'd'.repeat(20)];
  const overhead = 10;
  const budget = 55; // overhead(10) + two members(21 each = 42) = 52 fits; a third (73) overflows
  const { chunks } = chunkByArgvBudget(files, overhead, budget);
  assert.ok(chunks.length > 1, `expected a split, got ${chunks.length}`);
  for (const c of chunks) assert.ok(chunkArgv(overhead, c) <= budget, `chunk over budget: ${chunkArgv(overhead, c)}`);
  assert.deepEqual(chunks.flat().slice().sort(), files.slice().sort());
});

test('chunkByArgvBudget: boundary — a chunk filled to exactly the budget does not overflow', () => {
  // overhead 10, each member 'xxxx' costs 5. budget 20 → 10 + 2*5 = 20 == budget
  // fits exactly; a 3rd member (25) would overflow → exactly 2 members per chunk.
  const files = ['xxxx', 'xxxx', 'xxxx', 'xxxx'];
  const { chunks } = chunkByArgvBudget(files, 10, 20);
  assert.deepEqual(chunks, [['xxxx', 'xxxx'], ['xxxx', 'xxxx']]);
});

test('chunkByArgvBudget: a member that fits an EMPTY chunk but not the current one starts a new chunk', () => {
  const files = ['aaaaaaaaaa', 'bbbbbbbbbb', 'cccccccccc']; // 10 chars, cost 11 each
  const { chunks, tooLong } = chunkByArgvBudget(files, 10, 22); // 10+11=21<=22; 10+22=32>22 → 1 per chunk
  assert.equal(tooLong, undefined);
  assert.deepEqual(chunks, [['aaaaaaaaaa'], ['bbbbbbbbbb'], ['cccccccccc']]);
});

test('chunkByArgvBudget: a member exactly at the boundary (overhead+cost == budget) fits', () => {
  const { chunks } = chunkByArgvBudget(['yyyyy'], 10, 16); // 10 + (5+1) = 16 == budget
  assert.deepEqual(chunks, [['yyyyy']]);
});

// ── single-oversized-member ───────────────────────────────────────────────────────

test('chunkByArgvBudget: a single member too long to fit any chunk → tooLong, chunks null', () => {
  const big = 'z'.repeat(100);
  const { chunks, tooLong } = chunkByArgvBudget(['ok.md', big], 10, 50);
  assert.equal(chunks, null);
  assert.equal(tooLong, big);
});

// ── empty list ────────────────────────────────────────────────────────────────────

test('chunkByArgvBudget: an empty files list yields zero chunks (no tooLong)', () => {
  const { chunks, tooLong } = chunkByArgvBudget([], 10, 100);
  assert.deepEqual(chunks, []);
  assert.equal(tooLong, undefined);
});

// ── UNICODE SAFETY: non-ASCII members ride chunk 0 (-c), ASCII spill to -r chunks ──

test('chunkByArgvBudget: every non-ASCII member is placed in chunk 0 (the -c create chunk)', () => {
  // A small budget forces multiple chunks; the unicode members must NOT scatter into
  // append chunks — they all belong to chunk 0 so only -c ever writes a unicode name.
  // Byte budgeting (#11): café-ñ.md=11 B (cost 12), 日本語.md=12 B (cost 13); the two
  // unicode members use 10+12+13=35, so budget 40 holds both in chunk 0 yet still
  // forces the ASCII members (cost 11 each) to spill into -r append chunks.
  const files = ['ascii-1.md', 'café-ñ.md', 'ascii-2.md', '日本語.md', 'ascii-3.md'];
  const { chunks } = chunkByArgvBudget(files, 10, 40);
  assert.ok(chunks.length > 1, `expected a split, got ${chunks.length}`);
  // chunk 0 contains BOTH unicode members.
  assert.ok(chunks[0].includes('café-ñ.md'), 'café-ñ.md must be in chunk 0');
  assert.ok(chunks[0].includes('日本語.md'), '日本語.md must be in chunk 0');
  // NO later chunk contains any non-ASCII member.
  for (let i = 1; i < chunks.length; i++) {
    for (const m of chunks[i]) assert.equal(hasNonAscii(m), false, `append chunk ${i} must be ASCII-only: ${m}`);
  }
  // No member lost or duplicated.
  assert.deepEqual(chunks.flat().slice().sort(), files.slice().sort());
});

test('chunkByArgvBudget: non-ASCII members that together overflow a chunk → unicodeOverflow', () => {
  // Two unicode names whose combined cost exceeds the budget cannot both ride chunk 0,
  // and neither may be appended via -r → refuse rather than corrupt.
  // Byte costs (#11): u1='café-'×4+'.md' = 27 B (cost 28), u2='日本語-'×4+'.md' = 43 B
  // (cost 44). Budget 60: each fits ALONE (10+28=38, 10+44=54 ≤ 60) so neither is
  // single-too-long, but together 10+28+44=82 > 60 → aggregate unicodeOverflow.
  const u1 = 'café-'.repeat(4) + '.md';
  const u2 = '日本語-'.repeat(4) + '.md';
  const { chunks, unicodeOverflow, tooLong } = chunkByArgvBudget([u1, u2], 10, 60);
  assert.equal(chunks, null);
  assert.equal(unicodeOverflow, true);
  assert.equal(tooLong, undefined);
});

test('chunkByArgvBudget: a single non-ASCII member too long for any chunk → tooLong (not unicodeOverflow)', () => {
  // The single-member-too-long check fires FIRST (before the unicode-aggregate check).
  const big = 'café'.repeat(40) + '.md';
  const { chunks, tooLong, unicodeOverflow } = chunkByArgvBudget([big], 10, 50);
  assert.equal(chunks, null);
  assert.equal(tooLong, big);
  assert.equal(unicodeOverflow, undefined);
});

// ── #11: budget is byte-accurate (UTF-8), not UTF-16 code units ────────────────────

test('chunkByArgvBudget: budgets UTF-8 BYTES — a member fitting under .length but over byte budget → tooLong (#11)', () => {
  // '日'×10 = 10 UTF-16 code units but 30 UTF-8 bytes. With overhead 0 + budget 20:
  //   OLD .length budgeting: 0 + 10 + 1 = 11 <= 20 → WOULD fit one chunk (the bug)
  //   byte budgeting:        0 + 30 + 1 = 31 >  20 → fits no chunk → tooLong
  // This assertion FAILS under the old `.length` accounting and PASSES with memberBytes.
  const wide = '日'.repeat(10);
  const { chunks, tooLong } = chunkByArgvBudget([wide], 0, 20);
  assert.equal(chunks, null, 'a 30-byte member cannot fit a 20-byte budget');
  assert.equal(tooLong, wide);
  // Sanity: the SAME member fits once the budget covers its 31-byte cost.
  const ok = chunkByArgvBudget([wide], 0, 40);
  assert.deepEqual(ok.chunks, [[wide]]);
  assert.equal(ok.tooLong, undefined);
});
