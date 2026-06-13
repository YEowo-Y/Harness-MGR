/**
 * Target descriptor registry + resolver (P6.U1).
 *
 * claude-mgr's target-specific knowledge already lives in frozen DATA tables, not
 * logic (KIND_RULES, KNOWN_TOP_DIRS/FILES, WALK_DIRS, APPLY_WRITABLE_FILES). This
 * module packages each target's read-only tables into one descriptor and resolves
 * the requested one.
 *
 * PURE / never-throws / proto-safe / frozen / zero npm deps. Imports only the two
 * sibling descriptor modules (themselves frozen pure data). NEVER imports
 * paths.mjs (async, top-level-await) — fs auto-detect of a configDir lands in U2.
 */

import { claudeDescriptor } from './claude.mjs';
import { codexDescriptor } from './codex.mjs';

/**
 * @typedef {Object} ComponentKindSpec
 * @property {'skill'|'agent'|'command'} kind
 * @property {string} dir                          sub-directory under the config root
 * @property {'skill-md'|'flat-md'|'flat-toml'} layout   on-disk shape of each component
 */

/**
 * @typedef {Object} TargetDescriptor
 * @property {'claude'|'codex'} id
 * @property {string} label
 * @property {string} defaultHomeSubdir            e.g. '.claude' / '.codex'
 * @property {string} signatureFile                the file whose presence identifies this target (auto-detect, U2)
 * @property {ComponentKindSpec[]} componentKinds
 * @property {string[]} governedConfigFiles
 * @property {string[]} knownTopDirs
 * @property {string[]} knownTopFiles
 * @property {RegExp[]} knownTopFilePatterns
 */

/** The frozen registry of known targets, keyed by descriptor id. */
export const TARGETS = Object.freeze({
  claude: claudeDescriptor,
  codex: codexDescriptor,
});

/**
 * Resolve the requested target descriptor.
 *
 * Semantics (pure, never-throws, proto-safe):
 *   - opts null/undefined/non-object        → the DEFAULT (claudeDescriptor).
 *   - opts.target a known id 'claude'|'codex' → that descriptor.
 *   - opts.target an UNKNOWN non-empty string → undefined (the U2 CLI maps this to
 *                                               a usage error; we do NOT silently
 *                                               default an invalid target to claude).
 *   - opts.target absent/empty/non-string    → the DEFAULT (claudeDescriptor).
 *
 * `opts.configDir` is accepted in the signature but UNUSED in U1 — fs auto-detect
 * (signatureFile probing) lands in U2.
 *
 * @param {{target?: string, configDir?: string}|null} [opts]
 * @returns {TargetDescriptor|undefined}
 */
export function resolveTarget(opts) {
  if (opts === null || typeof opts !== 'object') return claudeDescriptor;

  const target = opts.target;
  if (typeof target !== 'string' || target.length === 0) return claudeDescriptor;

  // Own-property lookup ONLY: 'constructor'/'__proto__'/'prototype' resolve to
  // undefined (NOT inherited functions), so an unknown/hostile target is rejected.
  if (Object.prototype.hasOwnProperty.call(TARGETS, target)) return TARGETS[target];

  return undefined;
}
