/**
 * Snapshot TAR argv chunker (P3.D1) — splits a snapshot's file list into chunks
 * that each fit the Windows command-line budget, so a large `~/.claude` (the real
 * dogfood: 664 files ≈ 28614 argv chars) can be archived by issuing one
 * `tar -c` for the first chunk and one `tar -r` (append) per subsequent chunk,
 * INSTEAD of overflowing a single spawn with the old `tar-too-many-files`.
 *
 * ── UNICODE SAFETY: the non-ASCII-first invariant (EVIDENCE-DRIVEN) ──
 * The P3.D1 integration round-trip EMPIRICALLY caught that the Windows-shipped
 * bsdtar's `-r` (append) mode CORRUPTS a member name containing non-ASCII bytes
 * (e.g. `café-señor-日本語.md` → `café-se_or-日本語.md`: the Latin-1 `ñ` is lost) —
 * `-r` reads the appended member's argv through the ANSI/OEM codepage, while `-c`
 * (create) marshals it as wide-chars correctly. Byte-identical round-trip INCLUDING
 * unicode names is the headline snapshot DoD, so this chunker GUARANTEES every
 * non-ASCII member rides the FIRST chunk (the `-c` create); only pure-ASCII members
 * are ever appended via `-r`. (Same class of Windows-bsdtar-unicode limitation that
 * made `-T` list-files unusable — see the snapshot-tar.mjs header.)
 *
 * WHY A SEPARATE FILE: snapshot-tar.mjs is near the 200-SLOC module ceiling. The
 * chunking is a self-contained pure function with no spawn/fs dependency, so it
 * lives here on a clean pure boundary — the sanctioned "extract, don't pragma" fix.
 * snapshot-tar.mjs imports `chunkByArgvBudget` and owns the actual spawns.
 *
 * Pure; never throws. Zero npm dependencies; no imports at all.
 */

/** True if `s` contains any non-ASCII (>0x7F) code unit — such a NAME must not be
 *  appended via `-r` (bsdtar Windows corrupts it); it rides the first `-c` chunk. */
export function hasNonAscii(s) {
  for (let i = 0; i < s.length; i += 1) {
    if (s.charCodeAt(i) > 0x7f) return true;
  }
  return false;
}

/** The argv COST of a member NAME in BYTES — `Buffer.byteLength(s,'utf8')`, the
 *  real command-line cost on the OS (a multi-byte UTF-8 name costs MORE than its
 *  UTF-16 `.length`). Budgeting in bytes (not code units) keeps each chunk safely
 *  under the OS argv cap even for unicode-heavy names (#11). Buffer is a Node
 *  global — this module still imports nothing. */
function memberBytes(s) {
  return Buffer.byteLength(s, 'utf8');
}

/**
 * Partition `files` into argv-budget-sized chunks for a `-c` create (chunk 0) +
 * `-r` append (chunks 1..n) sequence, with the UNICODE-SAFE invariant that EVERY
 * non-ASCII-named member is placed in chunk 0 (the only chunk written by the
 * wide-char-safe `-c` mode). Subsequent chunks are ASCII-only, safe to append.
 *
 * `fixedOverheadBytes` is the cost the caller pays on EVERY spawn regardless of the
 * member list (tarPath + the fixed flags + archivePath + '-C' + baseDir + their
 * per-token separators), computed by the caller the same way it budgets the whole
 * command line — in UTF-8 BYTES (the caller uses Buffer.byteLength to match
 * `memberBytes`). Each member contributes `memberBytes(member) + 1` (the +1
 * mirrors the caller's per-token join separator).
 *
 * FAILURE MODES (chunks:null + a reason, so the caller fails cleanly — never an
 * oversized OR a corrupting spawn):
 *   - `tooLong`: a SINGLE member cannot fit even an otherwise-empty chunk
 *     (`fixedOverheadBytes + memberBytes(member) + 1 > budget`).
 *   - `unicodeOverflow`: the non-ASCII members TOGETHER exceed one chunk's budget,
 *     so they cannot all ride chunk 0 — appending any of them via `-r` would corrupt
 *     it, so we refuse rather than corrupt. (Astronomically rare: hundreds of
 *     unicode-named files within ~32 KiB of argv.)
 *
 * An EMPTY `files` array yields `{ chunks: [] }` (zero chunks) — the caller decides
 * whether that means "one empty-archive create" or "skip tar entirely".
 *
 * @param {string[]} files               POSIX-relative member paths (already validated)
 * @param {number}   fixedOverheadBytes  per-spawn fixed argv cost (tarPath+flags+archive+-C+baseDir)
 * @param {number}   budget              max argv BYTES per spawn (UTF-8; #11)
 * @returns {{ chunks: string[][]|null, tooLong?: string, unicodeOverflow?: boolean }}
 */
export function chunkByArgvBudget(files, fixedOverheadBytes, budget) {
  /** @type {string[]} */
  const nonAscii = [];
  /** @type {string[]} */
  const ascii = [];
  for (const f of files) {
    // A member that cannot fit even a fresh (empty) chunk is unchunkable.
    if (fixedOverheadBytes + memberBytes(f) + 1 > budget) return { chunks: null, tooLong: f };
    (hasNonAscii(f) ? nonAscii : ascii).push(f);
  }

  // Chunk 0 starts with ALL non-ASCII members (so they ride the wide-char-safe -c
  // create). If they alone overflow one chunk we must refuse — we cannot append a
  // non-ASCII member via -r without corruption.
  let used = fixedOverheadBytes;
  for (const f of nonAscii) used += memberBytes(f) + 1;
  if (used > budget) return { chunks: null, unicodeOverflow: true };

  /** @type {string[][]} */
  const chunks = [];
  /** @type {string[]} */
  let current = [...nonAscii];

  // Greedily fill chunk 0 with as many ASCII members as fit, then spill the rest
  // into subsequent (ASCII-only) append chunks.
  for (const f of ascii) {
    const cost = memberBytes(f) + 1;
    if (current.length > 0 && used + cost > budget) {
      chunks.push(current);
      current = [];
      used = fixedOverheadBytes;
    }
    current.push(f);
    used += cost;
  }
  if (current.length > 0) chunks.push(current);
  // EMPTY input → no non-ASCII, no ascii, current stays [] → chunks stays [].
  return { chunks };
}
