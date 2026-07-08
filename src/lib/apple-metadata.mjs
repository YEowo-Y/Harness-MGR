/**
 * Single source for macOS Finder / AppleDouble metadata basenames that are NOT
 * governed config and must be filtered CONSISTENTLY at every walk choke point:
 *   - snapshot-walk  — never archive them into a snapshot;
 *   - probe-state    — never hash them into the drift fingerprint (else a .DS_Store
 *                      that appears/changes reads as spurious config drift);
 *   - orphan-detector — never flag them as hard/soft orphans (else a mac-touched
 *                      harness drowns in orphan noise).
 *
 * These are created whenever macOS Finder (or a mac visiting a shared/network
 * volume) touches a directory. Pure, never-throws, zero-dep — the exact same
 * "one predicate shared by three walkers" shape as leftover-sidecars.mjs.
 *
 * SCOPE (deliberately conservative — the ~/.claude config surface, not a volume root):
 *   - .DS_Store        Finder folder metadata (exact basename, a file)
 *   - .AppleDouble     AppleDouble resource-fork DIRECTORY (exact basename)
 *   - ._<anything>     AppleDouble resource-fork sidecar for <anything> (prefix)
 * Volume-root-only artifacts (.Spotlight-V100, .Trashes, .fseventsd, .TemporaryItems)
 * are intentionally EXCLUDED: they never occur inside a config dir, so filtering them
 * would be dead code.
 */

/** Exact Apple-metadata basenames (each may be a file OR a dir). */
export const APPLE_METADATA_NAMES = Object.freeze(['.DS_Store', '.AppleDouble']);

/** AppleDouble resource-fork sidecar prefix (e.g. `._SKILL.md` shadows `SKILL.md`). */
export const APPLE_DOUBLE_PREFIX = '._';

/**
 * Is `name` a macOS Apple-metadata basename — `.DS_Store`, `.AppleDouble`, or a
 * `._*` AppleDouble sidecar? Pure; never throws. False for a non-string / empty
 * input. Case-SENSITIVE by design: macOS writes these names in exactly this form,
 * so a differently-cased `.ds_store` is a user file, not Apple metadata.
 * @param {string} name  a file/dir basename (NOT a full path)
 * @returns {boolean}
 */
export function isAppleMetadata(name) {
  if (typeof name !== 'string' || name.length === 0) return false;
  if (name.startsWith(APPLE_DOUBLE_PREFIX)) return true; // ._* AppleDouble sidecar
  return APPLE_METADATA_NAMES.includes(name);
}
