/**
 * Static source-level invariant checker (P1.U16) — load-order single source of truth.
 *
 * Guards the cross-phase invariant that `conflicts.mjs` IMPORTS its precedence
 * model from `load-order.mjs` rather than defining its own, and that
 * `load-order.mjs` still owns the canonical KIND_RULES table. A static text
 * scan is used so the guard catches regressions at source level without
 * executing any module.
 *
 * Invariants enforced:
 *   1. conflicts.mjs IMPORTS resolutionKey, isLoadableComponent, AND rankComponents
 *      from './load-order.mjs'.
 *   2. conflicts.mjs does NOT define its own KIND_RULES (const/let/var KIND_RULES =, any binding).
 *   3. load-order.mjs DEFINES AND EXPORTS KIND_RULES (export const KIND_RULES =, must be exported).
 *
 * Exported API:
 *   checkLoadOrderSingleSource(conflictsSource, loadOrderSource) → Diagnostic[]
 *     Pure: given the two files' text, run all three invariant checks.
 *     Never throws. Inputs not mutated.
 *   checkInvariants(srcDir) → { diagnostics: Diagnostic[] }
 *     Thin fs wrapper: reads <srcDir>/analysis/conflicts.mjs and
 *     <srcDir>/analysis/load-order.mjs, then calls the pure check.
 *     Never throws.
 *
 * Zero npm dependencies. Node stdlib only.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic
 */

/** Names that conflicts.mjs must import from load-order.mjs. */
const REQUIRED_IMPORTS = Object.freeze(['resolutionKey', 'isLoadableComponent', 'rankComponents']);

/**
 * Strip single-line (`//`) and multi-line (`/* … *\/`) comments from JS/MJS source.
 * Strings are NOT parsed — this is a best-effort scan for assignment-form patterns
 * that should never appear in prose after comment stripping.
 *
 * @param {string} src
 * @returns {string}
 */
function stripComments(src) {
  // Remove block comments first (may span lines), then line comments.
  let out = src.replace(/\/\*[\s\S]*?\*\//g, '');
  out = out.replace(/\/\/[^\n]*/g, '');
  return out;
}

/**
 * Check that `conflicts.mjs` imports all three required names from load-order.mjs.
 *
 * Looks for an `import { … } from './load-order.mjs'` statement (arbitrary
 * whitespace/newlines inside the brace list) and verifies each of the three
 * identifiers appears in the brace list. Handles multiple import statements.
 *
 * @param {string} src — raw conflicts.mjs source text
 * @returns {string[]} list of missing identifier names (empty = all present)
 */
function missingImports(src) {
  const importRe = /import\s*\{([^}]*)\}\s*from\s*['"]\.\/load-order\.mjs['"]/g;
  let allImported = '';
  let m;
  while ((m = importRe.exec(src)) !== null) {
    allImported += ' ' + m[1];
  }
  return REQUIRED_IMPORTS.filter((name) => {
    const wordBound = new RegExp(`\\b${name}\\b`);
    return !wordBound.test(allImported);
  });
}

/**
 * Matches ANY binding-form KIND_RULES assignment (const/let/var, with or without
 * export). Used by Invariant 2 to catch regressions where the table is re-introduced
 * under any declaration keyword.
 */
const KIND_RULES_ANY_BINDING_RE = /\b(?:export\s+)?(?:const|let|var)\s+KIND_RULES\s*=/;

/**
 * Matches ONLY `export const KIND_RULES =`. Used by Invariant 3 to require that
 * load-order.mjs both defines AND exports the table (a private `const` is a
 * violation because callers cannot import it).
 */
const KIND_RULES_EXPORT_CONST_RE = /\bexport\s+const\s+KIND_RULES\s*=/;

/** @param {unknown} err @returns {string} */
function errMsg(err) {
  return err instanceof Error ? err.message : String(err ?? '');
}

/**
 * Build an error Diagnostic with phase:'invariants'. Omits path/fix when falsy.
 * @param {string} code @param {string} message @param {string} [path] @param {string} [fix]
 * @returns {Diagnostic}
 */
function vio(code, message, path, fix) {
  /** @type {Diagnostic} */
  const d = { severity: 'error', code, message, phase: 'invariants' };
  if (path) d.path = path;
  if (fix) d.fix = fix;
  return d;
}

/**
 * Invariant 1: conflicts.mjs must import all three required names from load-order.mjs.
 * @param {string} src raw conflicts.mjs source
 * @returns {Diagnostic|null}
 */
function checkImports(src) {
  const missing = missingImports(src);
  if (missing.length === 0) return null;
  return vio(
    'invariant-load-order-import-missing',
    `conflicts.mjs is missing import(s) from './load-order.mjs': ${missing.join(', ')}`,
    'src/analysis/conflicts.mjs',
    `Add the missing name(s) to the import: import { ${REQUIRED_IMPORTS.join(', ')}, … } from './load-order.mjs'`,
  );
}

/**
 * Invariant 2: conflicts.mjs must NOT define its own KIND_RULES (any binding form).
 * @param {string} src raw conflicts.mjs source
 * @returns {Diagnostic|null}
 */
function checkNoDuplicate(src) {
  if (!KIND_RULES_ANY_BINDING_RE.test(stripComments(src))) return null;
  return vio(
    'invariant-load-order-duplicate-rules',
    'conflicts.mjs defines its own KIND_RULES — violates single-source-of-truth invariant',
    'src/analysis/conflicts.mjs',
    'Delete the local KIND_RULES from conflicts.mjs and import from load-order.mjs instead',
  );
}

/**
 * Invariant 3: load-order.mjs must define AND export KIND_RULES.
 * @param {string} src raw load-order.mjs source
 * @returns {Diagnostic|null}
 */
function checkSourceExports(src) {
  if (KIND_RULES_EXPORT_CONST_RE.test(stripComments(src))) return null;
  return vio(
    'invariant-load-order-source-missing',
    'load-order.mjs does not define/export KIND_RULES — the single source of truth is gone',
    'src/analysis/load-order.mjs',
    'Restore `export const KIND_RULES = …` in load-order.mjs',
  );
}

/**
 * Pure invariant check: given the raw text of the two source files, return a
 * Diagnostic for every violation. Returns an empty array when all invariants hold.
 * Never throws; inputs are not mutated.
 *
 * @param {string} conflictsSource   raw text of src/analysis/conflicts.mjs
 * @param {string} loadOrderSource   raw text of src/analysis/load-order.mjs
 * @returns {Diagnostic[]}
 */
export function checkLoadOrderSingleSource(conflictsSource, loadOrderSource) {
  if (typeof conflictsSource !== 'string' || typeof loadOrderSource !== 'string') {
    return [vio('invariant-read-failed', 'checkLoadOrderSingleSource: both arguments must be strings')];
  }
  return [
    checkImports(conflictsSource),
    checkNoDuplicate(conflictsSource),
    checkSourceExports(loadOrderSource),
  ].filter(Boolean);
}

/**
 * Try to read `filePath`; on error push an invariant-read-failed Diagnostic to
 * `diags` and return undefined. Never throws.
 * @param {string} filePath @param {string} label @param {Diagnostic[]} diags
 * @returns {string|undefined}
 */
function readOrDiag(filePath, label, diags) {
  try {
    return readFileSync(filePath, 'utf-8');
  } catch (err) {
    diags.push(vio('invariant-read-failed', `could not read ${label}: ${errMsg(err)}`, filePath));
    return undefined;
  }
}

/**
 * Thin fs wrapper: read the two analysis source files and run the pure invariant
 * check. Returns `{ diagnostics }` on all paths — file-read failures are converted
 * to `invariant-read-failed` diagnostics. Never throws.
 *
 * @param {string} srcDir   absolute path to the `src/` directory
 * @returns {{ diagnostics: Diagnostic[] }}
 */
export function checkInvariants(srcDir) {
  /** @type {Diagnostic[]} */
  const diags = [];
  const conflictsSource = readOrDiag(join(srcDir, 'analysis', 'conflicts.mjs'), 'conflicts.mjs', diags);
  const loadOrderSource = readOrDiag(join(srcDir, 'analysis', 'load-order.mjs'), 'load-order.mjs', diags);
  if (diags.length > 0) return { diagnostics: diags };
  return { diagnostics: checkLoadOrderSingleSource(conflictsSource, loadOrderSource) };
}
