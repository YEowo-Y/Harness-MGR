/**
 * Single source for the `.mgr-new` / `.mgr-old` atomic-write recovery sidecar
 * basenames (left by atomic-write.mjs on a catastrophic double-failure). Pure,
 * never-throws, zero-dep — shared by probe-fs (doctor #21 detection), snapshot-walk
 * (exclude from archives), and probe-state (exclude from the drift fingerprint).
 */

/** Recovery-sidecar suffixes left by the atomic-write primitive (atomic-write.mjs). */
export const LEFTOVER_SUFFIXES = Object.freeze(['.mgr-new', '.mgr-old']);

/**
 * Is `name` a `.mgr-new` / `.mgr-old` atomic-write recovery sidecar basename?
 * Pure; never throws. Returns false for a non-string or empty input.
 * @param {string} name  a file basename (not a full path)
 * @returns {boolean}
 */
export function isLeftoverSidecar(name) {
  if (typeof name !== 'string' || name.length === 0) return false;
  return LEFTOVER_SUFFIXES.some((s) => name.endsWith(s));
}
