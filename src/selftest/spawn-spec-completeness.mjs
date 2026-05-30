/**
 * Spawn-spec registry-completeness backstop (P3 gate-infra, High fix).
 *
 * Implements the static scan promised by spawn-spec-registry.mjs lines 11-17:
 * scans src/**.mjs source text for any CODE line (not JSDoc/comment) that
 * contains the literal `allowSlashPositionals:` and emits a
 * `spawn-spec-unregistered` error for every such module whose basename (without
 * .mjs) is NOT present as an `id` in the registered SPAWN_SPECS array.
 *
 * WHY BASENAME-BASED MATCHING:
 *   The registry ids follow the convention `'probe-hook-syntax'` = the module's
 *   filename without `.mjs`.  This is cheap, sound, and matches the existing
 *   HOOK_SYNTAX_SPAWN_SPEC.id value.  A future consumer MUST follow the same
 *   convention (or register under its actual filename-stem — it will be obvious
 *   from the error message which id is expected).
 *
 * DETECTION TOKEN:
 *   A code line "contains `allowSlashPositionals:`" iff, after trimming, it is
 *   NOT a JSDoc/block-comment line (starts with `*`) and NOT a line comment
 *   (starts with `//`), and it contains the substring `allowSlashPositionals:`.
 *   This is the same conservative direction as checkStaticImports: false
 *   positives (a string literal containing the token) are noise we can tolerate;
 *   false negatives (a real opt-in we miss) would leave the gap open.
 *
 * SCOPE:
 *   Only src/ files are scanned (caller passes the already-loaded srcFiles).
 *   test/ files legitimately use the literal as fixtures — excluded by design.
 *   src/selftest/ files are the guardrail infrastructure itself — they mention
 *   the token as a string constant / error-message text, not as an opt-in.
 *   These are excluded by the caller (checkBoundary) passing only non-selftest
 *   files, or by the file-path filter inside checkSpawnSpecCompleteness.
 *
 * Pure / never-throws.  Zero npm dependencies.
 */

import { basename, sep } from 'node:path';

/** @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic */

/** The detection token: a code line containing this substring is an opt-in. */
const OPT_IN_TOKEN = 'allowSlashPositionals:';

/**
 * Return true iff the trimmed line is a code line (not a comment/JSDoc line).
 * A "comment line" here means the trimmed content starts with `*` (JSDoc / block
 * comment continuation) or `//` (line comment).  Inline trailing comments on
 * code lines are NOT stripped — the conservative direction for detection.
 *
 * @param {string} trimmed   already-trimmed line
 * @returns {boolean}
 */
function isCodeLine(trimmed) {
  return trimmed.length > 0 && !trimmed.startsWith('*') && !trimmed.startsWith('//');
}

/**
 * Derive the module id from an absolute file path: basename without .mjs.
 * Matches the naming convention used by HOOK_SYNTAX_SPAWN_SPEC and the registry
 * doc.  A file named `probe-hook-syntax.mjs` → id `'probe-hook-syntax'`.
 *
 * @param {string} filePath   absolute path to the .mjs file
 * @returns {string}
 */
function moduleId(filePath) {
  const base = basename(filePath);
  return base.endsWith('.mjs') ? base.slice(0, -4) : base;
}

/**
 * Scan loaded source files for unregistered `allowSlashPositionals:` opt-ins.
 *
 * For each file that contains the opt-in token on at least one CODE line, the
 * file's module-id (basename sans .mjs) must appear in `registeredIds`.  If it
 * does not, one `spawn-spec-unregistered` error is emitted for that file.
 *
 * Non-array `files`, non-Set `registeredIds`, or garbage file entries are
 * tolerated silently.  Never throws.
 *
 * @param {Array<{path: string, source: string}>} files
 * @param {Set<string>} registeredIds   ids present in SPAWN_SPECS
 * @returns {Diagnostic[]}
 */
export function checkSpawnSpecCompleteness(files, registeredIds) {
  if (!Array.isArray(files)) return [];
  if (!(registeredIds instanceof Set)) return [];

  /** @type {Diagnostic[]} */
  const diags = [];

  for (const file of files) {
    if (!file || typeof file.path !== 'string' || typeof file.source !== 'string') continue;

    // Skip selftest/ infrastructure — those files mention the token as string
    // constants or error messages, not as real opt-ins.
    if (file.path.includes(`${sep}selftest${sep}`) || file.path.includes('/selftest/')) continue;

    // Check whether any CODE line in this file contains the opt-in token.
    let hasOptIn = false;
    for (const raw of file.source.split('\n')) {
      const trimmed = raw.trim();
      if (isCodeLine(trimmed) && trimmed.includes(OPT_IN_TOKEN)) {
        hasOptIn = true;
        break;
      }
    }
    if (!hasOptIn) continue;

    // This file opts in — its module id must be registered.
    const id = moduleId(file.path);
    if (!registeredIds.has(id)) {
      diags.push({
        severity: 'error',
        code: 'spawn-spec-unregistered',
        message:
          `module '${id}' sets allowSlashPositionals in code but is not registered in SPAWN_SPECS ` +
          `— add a descriptor with id:'${id}' to src/selftest/spawn-spec-registry.mjs`,
        path: file.path,
        phase: 'boundary',
      });
    }
  }

  return diags;
}
