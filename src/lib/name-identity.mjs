/**
 * Canonical component-name IDENTITY for grouping, dedup, and comparison.
 *
 * A component's on-disk name (ComponentRecord.name / a directory entry) is kept
 * VERBATIM for I/O and display — it must stay byte-for-byte as it appears on disk
 * because it is also used to reconstruct filesystem paths (e.g. the cascade delete
 * target in src/ops/cascade.mjs joins targetClaudeDir + node.name). This module
 * produces a DERIVED identity used ONLY as a Map/Set key or for equality — it is
 * never written back onto a record and never used to build a path:
 *
 *   - Unicode NFC normalization (ALWAYS): macOS readdir returns names in NFD
 *     (decomposed: 'é' = 'e' + U+0301) while authored frontmatter/content is NFC.
 *     Without folding to a single form, the same logical name compares unequal
 *     across platforms (Linux/Windows NFC vs macOS NFD).
 *   - Case folding (ONLY on case-INSENSITIVE filesystems — Windows NTFS and the
 *     macOS APFS/HFS+ default): 'MySkill' and 'myskill' are the SAME identity on
 *     those volumes but DISTINCT on a case-sensitive Linux volume.
 *
 * Zero npm dependencies. Pure; never throws.
 */

/**
 * NFC-normalize a value. Non-strings and malformed strings pass through unchanged.
 * @param {unknown} name
 * @returns {unknown}
 */
export function toNfc(name) {
  if (typeof name !== 'string') return name;
  try {
    return name.normalize('NFC');
  } catch {
    return name; // never throw on a pathological string
  }
}

/**
 * Whether the given platform's default filesystem is case-INSENSITIVE. Windows
 * (NTFS) and macOS (APFS/HFS+ default) are; Linux (ext4/xfs) is not. This is a
 * platform DEFAULT — case-sensitivity is technically per-volume (a case-sensitive
 * APFS or a casefold ext4 exists) — and is deliberately injectable so a future
 * runtime volume probe can replace it without touching any caller.
 * @param {string} [platform] defaults to process.platform
 * @returns {boolean}
 */
export function isCaseInsensitiveFs(platform = process.platform) {
  return platform === 'win32' || platform === 'darwin';
}

/**
 * Derive the identity key for a component name: NFC always, plus case folding when
 * the target filesystem is case-insensitive. Returns '' for non-string input so it
 * is safe as a Map/Set key. Used ONLY as a grouping/comparison key — never stored,
 * never used to build a path.
 * @param {unknown} name
 * @param {boolean} caseInsensitive
 * @returns {string}
 */
export function identityKey(name, caseInsensitive) {
  const nfc = toNfc(name);
  const s = typeof nfc === 'string' ? nfc : '';
  return caseInsensitive ? s.toLowerCase() : s;
}
