/**
 * Myers line-diff engine (P4b.U7a).
 *
 * The pure algorithm that `config diff <a> <b>` (P4b.U7b, a separate unit) will
 * consume to compare two text blobs (e.g. two settings.json layers, two CLAUDE.md
 * versions) line by line. This module owns the core diff math; the CLI layer owns
 * I/O and rendering choices.
 *
 * What it does:
 *  - `computeLineDiff(aText, bText)` runs the **Myers O(ND) shortest-edit-script**
 *    algorithm (the greedy edit-graph / LCS approach) over the two files' LINES,
 *    producing the MINIMAL sequence of equal/delete/insert ops with 1-based line
 *    numbers. "Minimal" matters: a naive diff that deletes-all-then-inserts-all is
 *    correct-but-useless; Myers finds the genuine longest common subsequence so a
 *    one-line edit shows as one delete + one insert, not a wholesale rewrite.
 *  - `formatUnified(diff, opts)` renders a git-style unified-diff STRING (header +
 *    `@@` hunks with surrounding context), and `diffToJson(diff, opts)` renders the
 *    same hunking as a JSON-serializable object. Both reuse ONE `buildHunks` helper
 *    so the text and JSON forms can never drift in their hunk boundaries/counts.
 *
 * Conventions (match src/output/json.mjs & table.mjs):
 *  - PURE: no I/O, no spawning, no fs, no env reads. Deterministic.
 *  - NEVER throws — the boundary guarantee. Non-string input is coerced to '' and a
 *    malformed `diff` object degrades to an empty result, never a propagated stack.
 *  - Zero npm dependencies. Node stdlib only.
 *
 * CRLF normalization: both inputs have `\r\n` (and lone `\r`) collapsed to `\n`
 * BEFORE splitting, so an otherwise-identical CRLF file and LF file diff as equal
 * instead of every line changing. Line splitting is `text.split('\n')`: a trailing
 * newline therefore yields a final empty-string line (e.g. "a\n" → ['a','']),
 * which is preserved as a real line so a "no trailing newline" vs "trailing
 * newline" difference is itself diffable. The empty string '' splits to [''] (one
 * empty line), NOT [] — consistent with split semantics and documented here.
 *
 * Known cost: ~150 LOC, the explicit budget from the plan for this unit.
 */

/**
 * @typedef {Object} DiffOp
 * @property {'equal'|'delete'|'insert'} type
 * @property {string} text                 the line's text (no trailing newline)
 * @property {number|null} aLine           1-based line in A, or null if absent in A
 * @property {number|null} bLine           1-based line in B, or null if absent in B
 */

/**
 * @typedef {Object} DiffStats
 * @property {number} added      count of 'insert' ops
 * @property {number} deleted    count of 'delete' ops
 * @property {number} unchanged  count of 'equal' ops
 */

/**
 * @typedef {Object} LineDiff
 * @property {DiffOp[]} ops
 * @property {DiffStats} stats
 */

/**
 * Compute the minimal line diff of two texts via Myers' shortest edit script.
 * Inputs are CRLF-normalized then split on '\n'. Non-string input → ''. Identical
 * inputs → all 'equal', stats added/deleted 0. Never throws.
 *
 * @param {string} aText
 * @param {string} bText
 * @returns {LineDiff}
 */
export function computeLineDiff(aText, bText) {
  const aLines = splitLines(aText);
  const bLines = splitLines(bText);
  const script = myersEditScript(aLines, bLines);
  return numberAndCount(script, aLines, bLines);
}

/**
 * Coerce to string, normalize CRLF (and lone CR) → LF, split into lines. A
 * non-string is treated as the empty string. The empty string splits to [''].
 *
 * @param {unknown} text
 * @returns {string[]}
 */
function splitLines(text) {
  const s = typeof text === 'string' ? text : '';
  return s.replace(/\r\n?/g, '\n').split('\n');
}

/**
 * Myers O(ND) greedy shortest-edit-script: walk the edit graph by increasing edit
 * distance D, tracking the furthest-reaching x on each diagonal k in `v`, snapshot
 * each round into `trace`, then backtrack to recover the op sequence. Returns raw
 * ops `{type, ai, bi}` where ai/bi are 0-based source indices (or -1 when absent).
 *
 * @param {string[]} a
 * @param {string[]} b
 * @returns {Array<{type:'equal'|'delete'|'insert', ai:number, bi:number}>}
 */
function myersEditScript(a, b) {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const offset = max;
  const v = new Array(2 * max + 1).fill(0);
  const trace = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = chooseX(v, k, d, offset);
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[k + offset] = x;
      if (x >= n && y >= m) return backtrack(trace, a, b, offset);
    }
  }
  return []; // unreachable for finite inputs; never-throws fallback
}

/**
 * Pick the furthest-reaching predecessor x for diagonal k at depth d: move down
 * (insert, from k+1) when k===-d or, except at k===d, the down path reached further
 * than the right path (delete, from k-1).
 *
 * @param {number[]} v
 * @param {number} k
 * @param {number} d
 * @param {number} offset
 * @returns {number}
 */
function chooseX(v, k, d, offset) {
  if (k === -d || (k !== d && v[k - 1 + offset] < v[k + 1 + offset])) {
    return v[k + 1 + offset]; // down → insertion
  }
  return v[k - 1 + offset] + 1; // right → deletion
}

/**
 * Walk the saved traces backward from (n,m) to (0,0), emitting equal/delete/insert
 * ops; reverse to forward order. `ai`/`bi` are 0-based indices into a/b.
 *
 * @param {number[][]} trace
 * @param {string[]} a
 * @param {string[]} b
 * @param {number} offset
 * @returns {Array<{type:'equal'|'delete'|'insert', ai:number, bi:number}>}
 */
function backtrack(trace, a, b, offset) {
  const ops = [];
  let x = a.length;
  let y = b.length;
  for (let d = trace.length - 1; d > 0; d--) {
    const v = trace[d];
    const k = x - y;
    const down = k === -d || (k !== d && v[k - 1 + offset] < v[k + 1 + offset]);
    const prevK = down ? k + 1 : k - 1;
    const prevX = v[prevK + offset];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { ops.push({ type: 'equal', ai: --x, bi: --y }); }
    if (down) ops.push({ type: 'insert', ai: -1, bi: --y });
    else ops.push({ type: 'delete', ai: --x, bi: -1 });
  }
  while (x > 0 && y > 0) { ops.push({ type: 'equal', ai: --x, bi: --y }); }
  return ops.reverse();
}

/**
 * Attach 1-based line numbers (null on the absent side) and tally stats over the
 * raw script.
 *
 * @param {Array<{type:'equal'|'delete'|'insert', ai:number, bi:number}>} script
 * @param {string[]} a
 * @param {string[]} b
 * @returns {LineDiff}
 */
function numberAndCount(script, a, b) {
  const ops = [];
  const stats = { added: 0, deleted: 0, unchanged: 0 };
  for (const raw of script) {
    if (raw.type === 'insert') {
      ops.push({ type: 'insert', text: b[raw.bi], aLine: null, bLine: raw.bi + 1 });
      stats.added++;
    } else if (raw.type === 'delete') {
      ops.push({ type: 'delete', text: a[raw.ai], aLine: raw.ai + 1, bLine: null });
      stats.deleted++;
    } else {
      ops.push({ type: 'equal', text: a[raw.ai], aLine: raw.ai + 1, bLine: raw.bi + 1 });
      stats.unchanged++;
    }
  }
  return { ops, stats };
}

/**
 * @typedef {Object} Hunk
 * @property {number} aStart   1-based start line in A (1 even for a pure-insert)
 * @property {number} aCount   # of context+delete lines
 * @property {number} bStart   1-based start line in B
 * @property {number} bCount   # of context+insert lines
 * @property {DiffOp[]} ops    the ops belonging to this hunk, in order
 */

/**
 * Group a diff's ops into unified-diff hunks: each run of changes plus up to
 * `context` equal lines on each side, with adjacent change-runs whose context
 * windows touch/overlap (gap of equal lines <= 2*context) merged into one hunk.
 * Shared by `formatUnified` and `diffToJson` so text and JSON never drift.
 *
 * @param {LineDiff} diff
 * @param {number} context
 * @returns {Hunk[]}
 */
function buildHunks(diff, context) {
  // Filter at the boundary: the public API documents never-throws on a malformed
  // diff, and an `ops` ARRAY containing a null/non-object element would otherwise
  // be dereferenced unguarded in changeRanges/makeHunk. The live consumer never
  // emits these, but the contract is stated for exactly this class.
  const ops = diff && Array.isArray(diff.ops)
    ? diff.ops.filter((o) => o && typeof o === 'object')
    : [];
  const ranges = changeRanges(ops, context);
  return ranges.map((r) => makeHunk(ops.slice(r.start, r.end), ops, r.start));
}

/**
 * Find the [start,end) op-index ranges that each become one hunk: expand every
 * change run by `context` on both ends (clamped to bounds), then merge overlapping
 * or touching ranges.
 *
 * @param {DiffOp[]} ops
 * @param {number} context
 * @returns {Array<{start:number, end:number}>}
 */
function changeRanges(ops, context) {
  const ranges = [];
  for (let i = 0; i < ops.length; i++) {
    if (ops[i].type === 'equal') continue;
    const start = Math.max(0, i - context);
    let j = i;
    while (j < ops.length && ops[j].type !== 'equal') j++;
    const end = Math.min(ops.length, j + context);
    const last = ranges[ranges.length - 1];
    if (last && start <= last.end) last.end = Math.max(last.end, end);
    else ranges.push({ start, end });
    i = j;
  }
  return ranges;
}

/**
 * Build one hunk from a slice of ops: derive @@ start lines from the first op's
 * line numbers (falling back to the surrounding context) and count a/b lines.
 *
 * @param {DiffOp[]} slice
 * @param {DiffOp[]} all
 * @param {number} startIdx   index of slice[0] within `all`
 * @returns {Hunk}
 */
function makeHunk(slice, all, startIdx) {
  let aCount = 0;
  let bCount = 0;
  for (const op of slice) {
    if (op.type !== 'insert') aCount++;
    if (op.type !== 'delete') bCount++;
  }
  const aStart = hunkStart(slice, all, startIdx, 'aLine', aCount);
  const bStart = hunkStart(slice, all, startIdx, 'bLine', bCount);
  return { aStart, aCount, bStart, bCount, ops: slice };
}

/**
 * Resolve a hunk's 1-based start line for one side. Prefer the first op in the
 * slice that has a line number on that side; if none (a pure insert hunk has no
 * aLine, a pure delete has no bLine), use the previous op's number + 1, else fall
 * back to 1. A zero-line hunk (count 0) conventionally starts at the line BEFORE
 * the change, i.e. start-1, which equals using the predecessor directly.
 *
 * @param {DiffOp[]} slice
 * @param {DiffOp[]} all
 * @param {number} startIdx
 * @param {'aLine'|'bLine'} field
 * @param {number} count
 * @returns {number}
 */
function hunkStart(slice, all, startIdx, field, count) {
  // `typeof === 'number'` (not `!== null`) so a field-incomplete junk op whose
  // line field is `undefined` can never put `undefined` into a `@@` header. For a
  // valid op (line is a number or null) this is identical to the old `!== null`.
  for (const op of slice) {
    if (typeof op[field] === 'number') return op[field];
  }
  // No line on this side anywhere in the hunk (e.g. pure insert → no aLine).
  for (let i = startIdx - 1; i >= 0; i--) {
    if (typeof all[i][field] === 'number') return all[i][field] + (count === 0 ? 0 : 1);
  }
  return count === 0 ? 0 : 1;
}

/**
 * @typedef {Object} UnifiedOpts
 * @property {string} [aLabel]   left file label (default 'a')
 * @property {string} [bLabel]   right file label (default 'b')
 * @property {number} [context]  lines of equal context per hunk (default 3)
 */

/**
 * Render a diff as a git-style unified-diff string: a `--- aLabel` / `+++ bLabel`
 * header, then one `@@ -aStart,aCount +bStart,bCount @@` block per hunk with ' '
 * (context), '-' (delete), '+' (insert) line prefixes. Identical files (no change
 * ops) → ONLY the header, with NO hunk body (documented choice). A malformed diff
 * coerces to no hunks → header only. Never throws.
 *
 * @param {LineDiff} diff
 * @param {UnifiedOpts} [opts]
 * @returns {string}
 */
export function formatUnified(diff, opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const aLabel = typeof o.aLabel === 'string' ? o.aLabel : 'a';
  const bLabel = typeof o.bLabel === 'string' ? o.bLabel : 'b';
  const context = normContext(o.context);
  const hunks = buildHunks(diff, context);
  const lines = [`--- ${aLabel}`, `+++ ${bLabel}`];
  for (const h of hunks) {
    lines.push(`@@ -${h.aStart},${h.aCount} +${h.bStart},${h.bCount} @@`);
    for (const op of h.ops) lines.push(unifiedLine(op));
  }
  return lines.join('\n');
}

/**
 * One unified-diff body line: ' ' context, '-' delete, '+' insert + the text.
 *
 * @param {DiffOp} op
 * @returns {string}
 */
function unifiedLine(op) {
  const prefix = op.type === 'delete' ? '-' : op.type === 'insert' ? '+' : ' ';
  return prefix + String(op.text ?? '');
}

/**
 * Render a diff as a JSON-serializable object mirroring the unified hunking, for
 * `config diff --format json`. Reuses `buildHunks` so its hunk boundaries/counts
 * match `formatUnified` exactly. Never throws.
 *
 * @param {LineDiff} diff
 * @param {UnifiedOpts} [opts]
 * @returns {{aLabel:string, bLabel:string, stats:DiffStats, hunks:Array<{aStart:number,aCount:number,bStart:number,bCount:number,lines:Array<{type:string,text:string}>}>}}
 */
export function diffToJson(diff, opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const aLabel = typeof o.aLabel === 'string' ? o.aLabel : 'a';
  const bLabel = typeof o.bLabel === 'string' ? o.bLabel : 'b';
  const context = normContext(o.context);
  const stats = diff && diff.stats && typeof diff.stats === 'object'
    ? { added: diff.stats.added | 0, deleted: diff.stats.deleted | 0, unchanged: diff.stats.unchanged | 0 }
    : { added: 0, deleted: 0, unchanged: 0 };
  const hunks = buildHunks(diff, context).map((h) => ({
    aStart: h.aStart,
    aCount: h.aCount,
    bStart: h.bStart,
    bCount: h.bCount,
    lines: h.ops.map((op) => ({ type: op.type, text: op.text })),
  }));
  return { aLabel, bLabel, stats, hunks };
}

/**
 * Coerce `context` to a non-negative integer; default 3. A non-finite or negative
 * value falls back to 3 so a bad option can never throw (mirrors json.mjs's
 * normalizeIndent).
 *
 * @param {unknown} raw
 * @returns {number}
 */
function normContext(raw) {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return 3;
  return Math.floor(raw);
}
