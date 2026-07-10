/**
 * The governed write-allowlist gate — the ONE place every governed-config write
 * is authorized. Extracted from paths.mjs (P6 write wave, unit 1) to keep both
 * modules under the SLOC ceiling AND to put the entire write-allowlist logic in
 * one focused, reviewable file (apply.mjs: "the gate is the single source of truth").
 *
 * SECURITY MODEL — one logic path, per-target data tables:
 *   The security LOGIC (canonical() symlink resolution, isUnder(), the forbidden-
 *   FIRST branch ordering, the least-authority per-context guards) is SHARED across
 *   every governed target and never duplicated — duplicating a security boundary is
 *   how the two copies drift. Only the DATA (a `WriteSurface`) varies per target:
 *   which dirs/files/leaf-shapes are writable in which context. `assertWritableCore`
 *   is the shared core; `makeAssertWritable` binds it to a target's dirs + surface.
 *   The Claude default (CLAUDE_WRITE_SURFACE) reproduces the historical hardcoded
 *   behavior exactly (pinned by test/paths.test.mjs + the boundary-cases matrix);
 *   Codex injects codexDescriptor.writeSurface (see docs/phase-6-codex-write-gate-design.md).
 *
 * This module is PURE (no top-level await) and NEVER imports paths.mjs — paths.mjs
 * imports + re-exports from here, and the per-target dirs are passed in. It performs
 * NO fs mutation (realpathSync is a read); it only validates a path against the
 * allowlist and returns its canonical form. Zero npm dependencies.
 */

import { basename, dirname, join, resolve, normalize, sep } from 'node:path';
import { realpathSync } from 'node:fs';
import { isLeftoverSidecar } from './lib/leftover-sidecars.mjs';

/** A loader-probe artifact filename: __mgr-probe-<uuid>.md. The ONLY name the
 *  'probe' write context permits in the surface's probeDir. */
const PROBE_NAME_RE = /^__mgr-probe-[0-9a-f-]+\.md$/i;

/** A removable skill DIRECTORY name: a plain dir name with no extension, no path
 *  separators, and no traversal. The ONLY basename shape the 'remove-skill' context
 *  permits directly in the surface's skillsDir. */
const SKILL_DIR_NAME_RE = /^[A-Za-z0-9._-]+$/;

/** A skill self-iteration proposal leaf: SKILL.proposed-<ts>.md where <ts> is the
 *  snapshot-id grammar (YYYY-MM-DDTHH-MM-SSZ). The ONLY name the 'propose' write
 *  context permits inside skills/<skill>/ (P5.U8). The /i flag is REQUIRED:
 *  canonical() lowercases the whole path on win32, so the leaf arrives as
 *  'skill.proposed-...z.md' — without /i this context would NEVER allow on Windows. */
const PROPOSAL_NAME_RE = /^SKILL\.proposed-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\.md$/i;

/** The original skill content leaf: SKILL.md. The 'accept' write context permits
 *  overwriting this (from a verified proposal). The /i flag is REQUIRED for the
 *  same load-bearing reason as PROPOSAL_NAME_RE: canonical() lowercases the whole
 *  path on win32, so the leaf arrives as 'skill.md' — without /i the 'accept'
 *  context would NEVER allow the overwrite on Windows. */
const SKILL_MD_RE = /^SKILL\.md$/i;

/** A removable single-file `.md` component leaf used by the Claude remove surface
 *  (agents/ + commands/). A probe artifact name is excluded by the gate separately. */
const REMOVABLE_MD_LEAF_RE = /^[A-Za-z0-9._-]+\.md$/i;

/**
 * The governed settings files writable in BOTH 'apply' and 'rollback' contexts,
 * each ONLY when placed DIRECTLY under the governed config dir (NOT nested).
 * Single source of truth — plan line 432 ("Forbidden vs Rollback-Writable",
 * the "Always writable (with --apply)" row). Matched by EXACT basename.
 * @type {ReadonlyArray<string>}
 */
export const APPLY_WRITABLE_FILES = Object.freeze(['settings.json', 'settings.local.json', '.mcp.json']);

/**
 * A per-target write-surface DATA table consumed by the gate core. The gate's
 * security LOGIC is shared and never duplicated; only this data varies per target.
 * Absent on a CLI call means "use the built-in Claude default" (CLAUDE_WRITE_SURFACE).
 *
 * @typedef {Object} WriteSurface
 * @property {ReadonlyArray<string>} forbiddenSubpaths  '/'-joined rel subpaths under the
 *   config dir that are ALWAYS forbidden (checked first → write-forbidden); defense-in-depth.
 * @property {ReadonlyArray<string>} applyWritableFiles  EXACT basenames directly under the
 *   config dir, writable in BOTH 'apply' and 'rollback' (Claude settings files; Codex = none).
 * @property {ReadonlyArray<string>} rollbackPaths  files/dirs writable ONLY in 'rollback'
 *   context (whole-file restore from a verified snapshot), matched by isUnder.
 * @property {ReadonlyArray<{dir:string, leafRe:RegExp}>} removeLeaves  'remove' context:
 *   a leaf matching leafRe placed DIRECTLY in <configDir>/<dir>.
 * @property {string} skillsDir  'remove-skill'/propose/accept context: the skills dir name.
 * @property {string} [probeDir]  'probe' context dir — read ONLY when features.probe is true.
 *   OMIT it when probe is disabled so enabling probe later fails loud (no dir) rather than
 *   silently defaulting to a dir that may be a real component dir (e.g. Codex agents/).
 * @property {ReadonlyArray<string>} configEditFiles  EXACT basenames directly under the config
 *   dir writable in the 'config-edit' context (in-place single-token splice). ALWAYS present;
 *   empty for Claude (config.toml is Codex-only). NOT the same as applyWritableFiles — a
 *   config-edit file is NEVER whole-file overwritable via 'apply'.
 * @property {{probe:boolean, propose:boolean, accept:boolean, configEdit:boolean}} features
 *   per-target feature contexts; a false flag makes that context fall through to a deny
 *   (Claude: configEdit false; Codex: probe/propose/accept false).
 */

/**
 * @typedef {'apply'|'rollback'|'probe'|'remove'|'remove-skill'|'propose'|'accept'|'config-edit'} WriteContext
 *   - 'apply'        — normal apply operation (default)
 *   - 'rollback'     — snapshot restore: may write to governed content surfaces
 *   - 'probe'        — transient loader-probe artifact: ONLY <probeDir>/__mgr-probe-<uuid>.md
 *   - 'remove'       — single-file component delete: ONLY a direct-child leaf in a removeLeaves dir
 *   - 'remove-skill' — single skill-DIRECTORY delete: ONLY a direct-child dir in skillsDir
 *   - 'propose'      — ONLY <skillsDir>/<skill>/SKILL.proposed-<ts>.md (skill self-iteration, P5.U8)
 *   - 'accept'       — ONLY <skillsDir>/<skill>/SKILL.md OR a SKILL.proposed-<ts>.md leaf (P5.U9)
 *   - 'config-edit'  — in-place config-file mutation: ONLY an EXACT configEditFiles basename
 *                      directly under the config dir (Codex config.toml; surgical single-token
 *                      splice via src/lib/toml-edit.mjs). Off for Claude (features.configEdit).
 */

/**
 * The built-in Claude write surface — the DEFAULT when no per-target surface is
 * injected. Its data equals the historical hardcoded literals (APPLY_WRITABLE_FILES
 * is reused by reference), so routing assertWritable through the surface-driven core
 * is behavior-preserving (pinned by the full test/paths.test.mjs + boundary-cases matrix).
 * @type {WriteSurface}
 */
export const CLAUDE_WRITE_SURFACE = Object.freeze({
  forbiddenSubpaths: Object.freeze(['plugins/marketplaces', 'projects']),
  applyWritableFiles: APPLY_WRITABLE_FILES,
  rollbackPaths: Object.freeze(['CLAUDE.md', 'agents', 'skills', 'commands', 'hooks']),
  removeLeaves: Object.freeze([
    Object.freeze({ dir: 'agents', leafRe: REMOVABLE_MD_LEAF_RE }),
    Object.freeze({ dir: 'commands', leafRe: REMOVABLE_MD_LEAF_RE }),
  ]),
  skillsDir: 'skills',
  probeDir: 'agents',
  // Claude has no in-place config-edit surface (settings.json is whole-file apply-writable);
  // present-but-empty + features.configEdit:false makes the 'config-edit' context structurally
  // unreachable for Claude (a false flag → fall-through to the historical deny).
  configEditFiles: Object.freeze([]),
  features: Object.freeze({ probe: true, propose: true, accept: true, configEdit: false }),
});

/**
 * Error thrown when a write target violates the allowlist.
 */
export class WriteForbiddenError extends Error {
  /** @param {string} message @param {string} code */
  constructor(message, code) {
    super(message);
    this.name = 'WriteForbiddenError';
    this.code = code;
  }
}

/**
 * Normalize a path for prefix comparison: resolve symlinks where possible
 * (security L1 — resolve via realpathSync BEFORE the allowlist check so a
 * symlink cannot escape the allowlist), then lowercase-normalize on a
 * case-INSENSITIVE filesystem (Windows NTFS and the macOS APFS/HFS+ default) so a
 * case-only variant of a governed path is not spuriously rejected. Linux stays
 * exact-case. Falls back to a plain resolve when the path does not yet exist (the
 * common case for to-be-created files).
 * @param {string} p
 * @returns {string}
 */
function canonical(p) {
  const abs = resolve(p);
  let real;
  try {
    real = realpathSync(abs);
  } catch (err) {
    // M1: branch on err.code. ONLY ENOENT means "not created yet" — anything
    // else (ELOOP cycle, EACCES, ENOTDIR) must FAIL CLOSED, never be treated
    // as a writable path.
    if (err && err.code === 'ENOENT') {
      // Resolve the DEEPEST existing ancestor so a symlinked/junctioned parent at
      // ANY depth still can't escape the allowlist. Walk UP one level at a time:
      // a single realpathSync(dirname) only catches a depth-1 escape — for a
      // >=2-deep to-be-created path (e.g. rollback of agents/sub/deep/file.md where
      // agents/sub is a junction and agents/sub/deep does not yet exist) the parent
      // ALSO ENOENTs, and stopping there would return the raw lexical path, letting
      // the junction escape. Rejoin the not-yet-existing suffix onto the resolved
      // real ancestor so isUnder() sees the true (escaped) path.
      real = resolveDeepestAncestor(abs);
    } else {
      throw new WriteForbiddenError(
        `cannot canonicalize path (${err && err.code}): ${abs}`,
        'write-canonicalize-failed',
      );
    }
  }
  const norm = normalize(real);
  // Case-fold on a case-INSENSITIVE filesystem (Windows NTFS + macOS APFS/HFS+
  // default) so a differently-cased spelling of a governed path canonicalizes to
  // the same allowlist key; Linux (case-sensitive) keeps the exact case.
  const plat = process.platform;
  return (plat === 'win32' || plat === 'darwin') ? norm.toLowerCase() : norm;
}

/**
 * Resolve the deepest existing ancestor of an as-yet-nonexistent `abs`, then rejoin
 * the not-yet-created suffix onto that REAL (symlink-resolved) ancestor. Walks up one
 * level at a time so a symlink/junction at ANY depth is resolved (a single
 * realpathSync(dirname) only catches a depth-1 escape). Each intermediate `ancestor`
 * is a lexical prefix of `abs` (produced by repeated dirname), so slicing the suffix
 * is safe. Fail-closed: any non-ENOENT realpath error throws WriteForbiddenError. If
 * even the filesystem root does not resolve, return the lexical path (nothing exists).
 * @param {string} abs an absolute, resolve()'d path
 * @returns {string}
 */
function resolveDeepestAncestor(abs) {
  let ancestor = dirname(abs);
  for (;;) {
    try {
      return join(realpathSync(ancestor), abs.slice(ancestor.length));
    } catch (err) {
      if (!err || err.code !== 'ENOENT') {
        throw new WriteForbiddenError(
          `cannot canonicalize path (${err && err.code}): ${abs}`,
          'write-canonicalize-failed',
        );
      }
      const parent = dirname(ancestor);
      if (parent === ancestor) return abs; // reached the root; nothing on the path exists yet
      ancestor = parent;
    }
  }
}

/**
 * True when `child` is at or under `parent` (after canonicalization).
 * @param {string} child
 * @param {string} parent
 * @returns {boolean}
 */
function isUnder(child, parent) {
  const c = canonical(child);
  const p = canonical(parent);
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}

/**
 * True when `canonicalTarget` is one of the surface's governed settings files
 * placed DIRECTLY under the config dir. Matches by EXACT basename + direct parent
 * (NOT isUnder / NOT a prefix), so `settings.jsonx`, a `settings.json/` directory
 * subtree, and a nested `sub/settings.json` are all rejected. With an EMPTY
 * applyWritableFiles (Codex) this is always false.
 * @param {string} canonicalTarget @param {string} configDir @param {WriteSurface} surface
 * @returns {boolean}
 */
function isApplyWritableFile(canonicalTarget, configDir, surface) {
  return dirname(canonicalTarget) === canonical(configDir)
    && surface.applyWritableFiles.includes(basename(canonicalTarget));
}

/**
 * Inner guard for the 'remove-skill' context: permit ONLY a single skill DIRECTORY
 * placed DIRECTLY in the surface's skillsDir (NOT nested, NOT a leftover sidecar,
 * NOT a probe artifact). canonical() defeats skills/../, NTFS ADS, 8.3 short-names,
 * trailing-dot, and a symlinked skills/ that escapes the config dir.
 * @param {string} target @param {string} configDir @param {WriteSurface} surface @returns {string}
 */
function assertRemoveSkillContext(target, configDir, surface) {
  const canonicalTarget = canonical(target);
  const parent = dirname(canonicalTarget);
  const leaf = basename(canonicalTarget);
  if (parent === canonical(join(configDir, surface.skillsDir))
    && SKILL_DIR_NAME_RE.test(leaf)
    && !isLeftoverSidecar(leaf)
    && !PROBE_NAME_RE.test(leaf)) {
    return canonicalTarget;
  }
  throw new WriteForbiddenError(
    `remove-skill context permits only a direct-child skill directory in ${surface.skillsDir}/: ${target}`,
    'write-remove-skill-only',
  );
}

/**
 * Shared "the target is a direct-child leaf inside <skillsDir>/<validSkillName>/"
 * check used by BOTH assertProposeContext and assertAcceptContext. canonical()
 * defeats skills/../, NTFS ADS, 8.3 short-names, trailing-dot, and a symlinked
 * skills/ that escapes the config dir. The skill dir must satisfy SKILL_DIR_NAME_RE,
 * not be a leftover sidecar, and not be a probe-named dir.
 * @param {string} target @param {string} configDir @param {WriteSurface} surface
 * @returns {{ok:boolean, leaf?:string, skillName?:string, canonicalTarget?:string}}
 */
function skillChildLeaf(target, configDir, surface) {
  const canonicalTarget = canonical(target);
  const parentDir = dirname(canonicalTarget);
  const leaf = basename(canonicalTarget);
  const skillName = basename(parentDir);
  const ok = dirname(parentDir) === canonical(join(configDir, surface.skillsDir))
    && SKILL_DIR_NAME_RE.test(skillName)
    && !isLeftoverSidecar(skillName)
    && !PROBE_NAME_RE.test(skillName);
  return { ok, leaf, skillName, canonicalTarget };
}

/**
 * Inner guard for the 'propose' context: permit ONLY a SKILL.proposed-<ts>.md leaf
 * placed DIRECTLY inside a skill dir (<skillsDir>/<skill>/ — NOT skills/ itself, NOT
 * nested deeper, NOT inside a sidecar/probe-named dir). PROPOSAL_NAME_RE can never
 * match 'SKILL.md', so overwriting the original skill through this context is
 * structurally impossible.
 * @param {string} target @param {string} configDir @param {WriteSurface} surface @returns {string}
 */
function assertProposeContext(target, configDir, surface) {
  const c = skillChildLeaf(target, configDir, surface);
  if (c.ok && PROPOSAL_NAME_RE.test(c.leaf)) {
    return c.canonicalTarget;
  }
  throw new WriteForbiddenError(
    `propose context permits only ${surface.skillsDir}/<skill>/SKILL.proposed-<ts>.md: ${target}`,
    'write-propose-only',
  );
}

/**
 * Inner guard for the 'accept' context (P5.U9): permit ONLY, DIRECTLY inside a skill
 * dir (<skillsDir>/<skill>/), either SKILL.md (overwrite the original from a verified
 * proposal) OR a SKILL.proposed-<ts>.md leaf (delete the accepted proposal). Anything
 * else — incl. any other leaf name, nested deeper, directly in skills/, a sidecar/
 * probe-named parent, or outside skills/ — is refused.
 * @param {string} target @param {string} configDir @param {WriteSurface} surface @returns {string}
 */
function assertAcceptContext(target, configDir, surface) {
  const c = skillChildLeaf(target, configDir, surface);
  if (c.ok && (SKILL_MD_RE.test(c.leaf) || PROPOSAL_NAME_RE.test(c.leaf))) {
    return c.canonicalTarget;
  }
  throw new WriteForbiddenError(
    `accept context permits only ${surface.skillsDir}/<skill>/SKILL.md or a SKILL.proposed-<ts>.md leaf: ${target}`,
    'write-accept-only',
  );
}

/**
 * Build a gate closure bound to a specific governed config dir + state dir +
 * write-surface. This is what a NON-default target (Codex) injects in place of the
 * bare `assertWritable` (the Claude default in paths.mjs). The surface defaults to
 * CLAUDE_WRITE_SURFACE so `makeAssertWritable({configDir, mgrStateDir})` is the
 * Claude gate bound to an explicit dir.
 *
 * Fail-closed: a non-string/empty configDir or mgrStateDir throws immediately (a
 * wiring bug must surface loudly, never silently widen the surface).
 *
 * @param {{configDir:string, mgrStateDir:string, surface?:WriteSurface}} opts
 * @returns {(target:string, context?:WriteContext)=>string}
 */
export function makeAssertWritable(opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const { configDir, mgrStateDir: stateDir } = o;
  const surface = o.surface ?? CLAUDE_WRITE_SURFACE;
  if (typeof configDir !== 'string' || configDir.length === 0
    || typeof stateDir !== 'string' || stateDir.length === 0) {
    throw new WriteForbiddenError(
      'makeAssertWritable requires non-empty configDir and mgrStateDir',
      'write-gate-misconfigured',
    );
  }
  return (target, context = 'apply') => assertWritableCore(target, context, configDir, stateDir, surface);
}

/**
 * The shared, surface-driven gate core. Pure over (target, context, configDir,
 * stateDir, surface). The security LOGIC (canonical() symlink resolution, isUnder(),
 * the forbidden-FIRST ordering, the least-authority per-context guards) is identical
 * for every target; only the DATA (surface) varies. The branch order is the historical
 * one, so "forbidden wins" and "a feature context never widens apply" hold for every
 * surface. A Claude-only feature context (probe/propose/accept) whose surface flag is
 * false falls through to a deny.
 *
 * Categories: stateDir/** always writable · outside config dir refused · forbidden
 * subpaths refused first · then the per-context least-authority guards · apply-writable
 * settings files · rollback-only paths · else conservative refuse.
 *
 * @param {string} target @param {WriteContext} context @param {string} configDir
 * @param {string} stateDir @param {WriteSurface} surface @returns {string}
 */
function assertWritableCore(target, context, configDir, stateDir, surface) {
  if (typeof target !== 'string' || target.length === 0) {
    throw new WriteForbiddenError('write target must be a non-empty string', 'write-target-invalid');
  }
  const ctx = (context === 'rollback' || context === 'probe' || context === 'remove' || context === 'remove-skill' || context === 'propose' || context === 'accept' || context === 'config-edit') ? context : 'apply';

  // mgr's own state dir is always writable (NOT part of the governed config
  // surface; excluded from snapshot scope).
  if (isUnder(target, stateDir)) {
    return canonical(target);
  }

  // Anything outside the governed config dir is out of scope for writes.
  if (!isUnder(target, configDir)) {
    throw new WriteForbiddenError(
      `refusing to write outside the governed config dir: ${target}`,
      'write-outside-target',
    );
  }

  // Always-forbidden subtrees within the config dir (defense in depth — these also
  // fall through to write-not-allowed, but write-forbidden is the louder, reviewed
  // denial that wins first regardless of any later surface widening).
  for (const sub of surface.forbiddenSubpaths) {
    if (isUnder(target, join(configDir, ...sub.split('/')))) {
      throw new WriteForbiddenError(`path is forbidden to write: ${target}`, 'write-forbidden');
    }
  }

  // 'probe' context (Claude-only feature): allow ONLY a transient loader-probe
  // artifact placed DIRECTLY in the surface's probeDir with a __mgr-probe-<uuid>.md
  // name. canonical() still denies a symlinked probeDir that escapes the config dir.
  // Skipped (falls through to a deny) when the surface disables the probe feature (Codex).
  if (ctx === 'probe' && surface.features.probe) {
    const canonicalTarget = canonical(target);
    const probeDir = canonical(join(configDir, surface.probeDir));
    if (dirname(canonicalTarget) === probeDir && PROBE_NAME_RE.test(basename(canonicalTarget))) {
      return canonicalTarget;
    }
    throw new WriteForbiddenError(
      `probe context permits only ${surface.probeDir}/__mgr-probe-*.md: ${target}`,
      'write-probe-only',
    );
  }

  // 'remove' context: permit ONLY a single-file component leaf matching the surface's
  // removeLeaves — a leaf with the per-dir extension placed DIRECTLY in one of the
  // listed dirs (Claude: .md in agents/ or commands/; Codex: .md in prompts/ or .toml
  // in agents/), NOT nested, NOT a probe artifact. Reached only AFTER the .mgr-state /
  // outside / forbidden / probe checks, so it can never touch a forbidden subtree or
  // escape via a symlinked dir (canonical() also defeats ../, NTFS ADS, short-names).
  if (ctx === 'remove') {
    const canonicalTarget = canonical(target);
    const parent = dirname(canonicalTarget);
    const leaf = basename(canonicalTarget);
    for (const { dir, leafRe } of surface.removeLeaves) {
      if (parent === canonical(join(configDir, dir)) && leafRe.test(leaf) && !PROBE_NAME_RE.test(leaf)) {
        return canonicalTarget;
      }
    }
    throw new WriteForbiddenError(
      `remove context permits only a single direct-child component leaf in the governed component dirs: ${target}`,
      'write-remove-only',
    );
  }

  // 'remove-skill' context: least-authority skill-DIRECTORY delete (P4b).
  if (ctx === 'remove-skill') return assertRemoveSkillContext(target, configDir, surface);

  // 'propose'/'accept' (Claude-only features): least-authority skill self-iteration
  // writes (P5.U8/U9). Reached only AFTER the forbidden denials, so those always win
  // and a normal apply STILL cannot touch skills/**. Skipped when the surface disables
  // the feature (Codex → falls through to a deny).
  if (ctx === 'propose' && surface.features.propose) return assertProposeContext(target, configDir, surface);
  if (ctx === 'accept' && surface.features.accept) return assertAcceptContext(target, configDir, surface);

  // 'config-edit' (per-target feature): permit ONLY an EXACT-basename match of the surface's
  // configEditFiles placed DIRECTLY under the config dir (Codex config.toml). This is the SOLE
  // write path to config.toml — config.toml is deliberately NOT in applyWritableFiles, so the
  // generic apply/overwrite path can never touch it and the surgical single-token splice
  // (src/lib/toml-edit.mjs) is the only producer of the bytes. Reached only AFTER the forbidden
  // denials (so a forbidden subpath always wins) and BEFORE the apply-writable check; skipped
  // (falls through to a deny) when the surface disables the feature (Claude → configEdit:false).
  if (ctx === 'config-edit' && surface.features.configEdit) {
    const ct = canonical(target);
    if (dirname(ct) === canonical(configDir) && surface.configEditFiles.includes(basename(ct))) return ct;
    throw new WriteForbiddenError(
      `config-edit context permits only ${surface.configEditFiles.join(', ') || '(none)'} directly under the config dir: ${target}`,
      'write-config-edit-only',
    );
  }

  // Always-writable governed settings files (Claude settings.json / settings.local.json
  // / .mcp.json, DIRECTLY under the config dir, in BOTH 'apply' and 'rollback'). Codex's
  // applyWritableFiles is empty → never matches (config.toml stays read-only this wave).
  const canonicalTarget = canonical(target);
  if ((ctx === 'apply' || ctx === 'rollback') && isApplyWritableFile(canonicalTarget, configDir, surface)) {
    return canonicalTarget;
  }

  // Rollback-only-writable surfaces: governed content that normal apply must never
  // touch directly, but rollback restores from a verified snapshot (Claude: CLAUDE.md +
  // agents/skills/commands/hooks; Codex: config.toml/AGENTS.md/hooks.json + skills/
  // prompts/agents). "Restorable", not "editable".
  for (const sub of surface.rollbackPaths) {
    if (isUnder(target, join(configDir, ...sub.split('/')))) {
      if (ctx === 'rollback') return canonical(target);
      throw new WriteForbiddenError(
        `path is rollback-only writable (not in 'apply' context): ${target}`,
        'write-rollback-only',
      );
    }
  }

  // Remaining paths under the config dir are not part of the writable surface;
  // reject conservatively rather than allowing unknown writes.
  throw new WriteForbiddenError(
    `path is not in the writable allowlist: ${target}`,
    'write-not-allowed',
  );
}
