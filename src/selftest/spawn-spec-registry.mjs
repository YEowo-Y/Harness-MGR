/**
 * Central registry of safe-spawn descriptors that opt into allowSlashPositionals.
 *
 * PURPOSE:
 *   The spawn-spec guardrail (spawn-spec-guardrail.mjs) sweeps every descriptor
 *   in this list and asserts that its positionalPattern rejects all known Windows
 *   mutation flags.  A new consumer that sets allowSlashPositionals:true MUST
 *   export a descriptor and register it here — otherwise it is invisible to the
 *   guardrail and the release gate.
 *
 * STATIC BACKSTOP (registry-completeness):
 *   checkSpawnSpecGuardrail only tests descriptors listed here.  To close the
 *   "forgot to register" gap, checkSpawnSpecCompleteness (boundary.mjs) does a
 *   lightweight static scan over src/**.mjs: any CODE line (not JSDoc/comment)
 *   containing `allowSlashPositionals:` causes the file's basename-stem to be
 *   checked against the ids in this registry.  A missing id → a
 *   `spawn-spec-unregistered` error that fails `selftest --boundary` and the
 *   release gate.  This is IMPLEMENTED in src/selftest/spawn-spec-completeness.mjs.
 *
 * M2-SAFETY:
 *   Descriptors are pure data (RegExp + booleans) — no paths.mjs reach.
 *   Importing this file does not pull the discovery-layer I/O graph; it only
 *   evaluates the top-level of probe-hook-syntax.mjs (which imports safe-spawn.mjs
 *   → node:child_process only).
 *
 * ADDING A NEW CONSUMER:
 *   1. In the consuming module, define and export a frozen descriptor:
 *        export const MY_SPAWN_SPEC = Object.freeze({
 *          id: 'probe-my-thing',
 *          allowSlashPositionals: true,
 *          positionalPattern: MY_PATH_RE,
 *        });
 *      Then spread descriptor.positionalPattern + descriptor.allowSlashPositionals
 *      INTO the safeSpawn schema call (single source of truth; no drift).
 *   2. Import the descriptor here and add it to SPAWN_SPECS.
 *
 * Zero npm dependencies.
 */

import { HOOK_SYNTAX_SPAWN_SPEC } from '../discovery/probe-hook-syntax.mjs';

/**
 * Every registered allowSlashPositionals:true spawn-spec descriptor.
 * The guardrail iterates this array; the release gate fails on any violation.
 *
 * @type {ReadonlyArray<import('./spawn-spec-guardrail.mjs').SpawnSpecDescriptor>}
 */
export const SPAWN_SPECS = Object.freeze([
  HOOK_SYNTAX_SPAWN_SPEC,
]);
