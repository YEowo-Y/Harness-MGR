/**
 * Write-gate registry-completeness backstop (P4a.U4, cross-phase invariant).
 *
 * The companion to spawn-spec-completeness.mjs, for the OTHER governed surface:
 * every module that mutates the filesystem must route that mutation through the
 * `assertWritable` gate (paths.mjs) — OR be on a curated `EXEMPT_MODULES`
 * allowlist of audited NON-governed writers. Without this static guard a FUTURE
 * ungated governed-write (e.g. a second atomic-delete-style primitive added
 * without injecting the gate) could slip in unnoticed. This check closes that
 * gap with a completeness invariant: scan src/ source text for any CODE line
 * (not JSDoc/comment) that CALLS an fs-mutation seam, and require that module to
 * either reference `assertWritable` on a code line or appear in EXEMPT_MODULES.
 *
 * DETECTION TOKEN (governed fs-mutation):
 *   A code line "performs an fs-mutation" iff, after trimming, it is NOT a
 *   JSDoc/block-comment line (starts with `*`) and NOT a line comment (starts
 *   with `//`), and it contains a CALL to one of the MUTATION_SEAMS — the seam
 *   name on a word boundary immediately followed by optional spaces + `(`. The
 *   `\b…\s*\(` shape means a bare import (`unlinkSync, statSync`), a seam-variable
 *   reference (`?? unlinkSync`), or a longer identifier (`myWriteFileSync(`) does
 *   NOT trigger — only a direct invocation does. This is the SAME conservative
 *   direction as spawn-spec-completeness / checkStaticImports: false positives
 *   (a mutation seam called in a non-governed context — handled via EXEMPT) are
 *   noise we tolerate; false negatives (a real ungated governed write we miss)
 *   would leave the gap open, so we err toward flagging.
 *
 * CONVENTION (load-bearing for this guard): a module performing a GOVERNED-config
 *   fs-mutation MUST invoke its fs seam in CALL-FORM (`writeFileSync(p,c)` or
 *   `(p,c)=>writeFileSync(p,c)`) so this code-line check detects it. A
 *   BARE-referenced default seam (`?? writeFileSync` / `seamFn: writeFileSync`) is
 *   reserved for NON-governed `.mgr-state`/temp writers (e.g. the bounded-delete gc
 *   modules). A governed writer that violates this convention would silently evade
 *   the guard — do not write governed config via a bare-ref seam without referencing
 *   assertWritable.
 *
 * GATED RULE (MODULE-SCOPED):
 *   A flagged module is "gated" iff any CODE line references the identifier
 *   `assertWritable` (word-boundary match). Every module that performs an
 *   fs-mutation MUST be gated OR be in EXEMPT_MODULES; otherwise one
 *   `write-gate-unguarded` error is emitted for that module. Note: this predicate
 *   is module-scoped — it clears a module if ANY code line references assertWritable,
 *   not per-write. The authoritative per-write enforcement is the runtime
 *   `assertWritable` gate + the `buildAllowlistCases`/boundary-cases probe.
 *
 * EXEMPT_MODULES — a curated allowlist of NON-governed writers:
 *   Each entry is a module-id (basename sans .mjs) whose fs-mutation provably
 *   never touches the governed `~/.claude` config surface (verified by reading
 *   the module). Each carries an inline comment stating WHAT it writes + WHERE.
 *   This list is the security-relevant surface a reviewer audits: a module
 *   belongs here ONLY if its writes are confined to a throwaway temp dir, the
 *   repo tree, or another non-governed location.
 *
 * SCOPE:
 *   Only src/ files are scanned (caller passes the already-loaded srcFiles).
 *   src/selftest/ files are the guardrail infrastructure itself — they mention
 *   the seam names and `assertWritable` as string constants / error-message text,
 *   not as real governed writes. These are excluded by the file-path filter
 *   inside checkWriteGateCompleteness (same exclusion as spawn-spec-completeness).
 *
 * Pure / never-throws. Zero npm dependencies.
 */

import { basename, sep } from 'node:path';

/** @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic */

/**
 * The fs-mutation seams whose CALL on a code line marks a module as a writer.
 * Mirrors the node:fs sync mutation surface this codebase uses (and a few it
 * does not, for forward coverage). A module calling any of these must be gated
 * or exempt.
 * @type {ReadonlyArray<string>}
 */
export const MUTATION_SEAMS = Object.freeze([
  'renameSync',
  'writeFileSync',
  'appendFileSync',
  'unlinkSync',
  'rmSync',
  'rmdirSync',
  'mkdirSync',
  'writeSync',
  'copyFileSync',
  'cpSync',
  'truncateSync',
  'symlinkSync',
  'chmodSync',
  'openSync',
]);

/**
 * Curated allowlist of modules that mutate the filesystem but NEVER the governed
 * config surface — so they legitimately do NOT route through assertWritable.
 * Keyed by module-id (basename sans .mjs). VERIFIED by reading each module.
 *
 * Only modules my code-line detection actually FLAGS need an entry. Several
 * bounded-delete modules (snapshot-gc, gc-extras, snapshot-store) delete via
 * INJECTED seam functions (`unlinkFn(...)` / `rmFn(...)`), not direct
 * `unlinkSync(`/`rmSync(` calls, so they are not detected as code-mutators and
 * deliberately have NO entry here.
 * @type {ReadonlySet<string>}
 */
export const EXEMPT_MODULES = Object.freeze(
  new Set([
    // rollback-decompress-verify: writes ONLY into a FRESH os.tmpdir() mkdtemp
    // dir (mkdtempSync + rmSync of that exact dir) to extract+hash an archive for
    // verification; removed in a finally. Never the governed config — no gate needed.
    'rollback-decompress-verify',
    // snapshot-diff: the read-only snapshot↔snapshot diff engine. In CONTENT mode it
    // writes ONLY into FRESH os.tmpdir() mkdtemp dir(s) (mkdtempSync + rmSync of those
    // exact dirs) to extract the one member it diffs; each is removed in a finally.
    // Never the governed config / .mgr-state — same non-governed temp-writer class as
    // rollback-decompress-verify, so no assertWritable gate is needed.
    'snapshot-diff',
    // stability-log: appendFileSync to STABILITY-LOG.jsonl in the repo root — a
    // plain repo soak-log file, NOT a governed-config write.
    'stability-log',
    // probe-access: openSync(p, 'r') — a READ-ONLY shared open of settings.json to
    // probe its lock status, immediately closed. Not a write at all (read-only mode).
    'probe-access',
    // selftest-command: writeFileSync(baselinePath, ...) writes
    // src/selftest/schema-baseline.json (a source-tree baseline updated via
    // --update-baseline), NOT governed ~/.claude config. The assertWritable
    // references in this module are for passing the gate INTO checkBoundary, not for
    // gating this source-tree write.
    'selftest-command',
  ]),
);

/**
 * Return true iff the trimmed line is a code line (not a comment/JSDoc line).
 * A "comment line" means the trimmed content starts with `*` (JSDoc / block
 * comment continuation) or `//` (line comment). Inline trailing comments on code
 * lines are NOT stripped — the conservative direction for detection. Identical to
 * spawn-spec-completeness's helper.
 *
 * @param {string} trimmed   already-trimmed line
 * @returns {boolean}
 */
function isCodeLine(trimmed) {
  return trimmed.length > 0 && !trimmed.startsWith('*') && !trimmed.startsWith('//');
}

/**
 * Derive the module id from an absolute file path: basename without .mjs.
 * A file named `atomic-delete.mjs` → id `'atomic-delete'`. Same convention as
 * spawn-spec-completeness.
 *
 * @param {string} filePath   absolute path to the .mjs file
 * @returns {string}
 */
function moduleId(filePath) {
  const base = basename(filePath);
  return base.endsWith('.mjs') ? base.slice(0, -4) : base;
}

/** Matches a CALL to any mutation seam: seam name on a word boundary + `(`. */
const MUTATION_CALL_RE = new RegExp(`\\b(?:${MUTATION_SEAMS.join('|')})\\s*\\(`);

/** Matches a reference to the `assertWritable` identifier on a word boundary. */
const ASSERT_WRITABLE_RE = /\bassertWritable\b/;

/**
 * Return true iff any CODE line in `source` matches `re`. Comment/JSDoc lines
 * are skipped so a prose mention of a seam name (or of assertWritable) does not
 * count.
 *
 * @param {string} source
 * @param {RegExp} re
 * @returns {boolean}
 */
function hasCodeLineMatch(source, re) {
  for (const raw of source.split('\n')) {
    const trimmed = raw.trim();
    if (isCodeLine(trimmed) && re.test(trimmed)) return true;
  }
  return false;
}

/**
 * Scan loaded source files for ungated fs-mutations.
 *
 * For each non-selftest file that CALLS an fs-mutation seam on a CODE line, the
 * file's module-id (basename sans .mjs) must either reference `assertWritable` on
 * a code line (gated) OR be present in EXEMPT_MODULES. If neither holds, one
 * `write-gate-unguarded` error is emitted for that file.
 *
 * Non-array `files` or garbage file entries are tolerated silently. Never throws.
 *
 * @param {Array<{path: string, source: string}>} files
 * @returns {Diagnostic[]}
 */
export function checkWriteGateCompleteness(files) {
  if (!Array.isArray(files)) return [];

  /** @type {Diagnostic[]} */
  const diags = [];

  for (const file of files) {
    if (!file || typeof file.path !== 'string' || typeof file.source !== 'string') continue;

    // Skip selftest/ infrastructure — those files mention the seam names and
    // assertWritable as string constants / error messages, not as governed writes.
    if (file.path.includes(`${sep}selftest${sep}`) || file.path.includes('/selftest/')) continue;

    // Does this module CALL an fs-mutation seam on a code line?
    if (!hasCodeLineMatch(file.source, MUTATION_CALL_RE)) continue;

    // It mutates — it must be gated (references assertWritable) or exempt.
    const id = moduleId(file.path);
    if (EXEMPT_MODULES.has(id)) continue;
    if (hasCodeLineMatch(file.source, ASSERT_WRITABLE_RE)) continue;

    diags.push({
      severity: 'error',
      code: 'write-gate-unguarded',
      message:
        `module '${id}' performs an fs-mutation but does not reference assertWritable and is ` +
        `not in EXEMPT_MODULES — gate the write via an injected assertWritable (paths.mjs), or, ` +
        `if it is a NON-governed write (temp dir / repo tree), add '${id}' to EXEMPT_MODULES in ` +
        `src/selftest/write-gate-completeness.mjs with a justification of WHAT it writes + WHERE`,
      path: file.path,
      phase: 'boundary',
    });
  }

  return diags;
}
