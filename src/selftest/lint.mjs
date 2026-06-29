/**
 * Source-size linter (P1.U16) — the `selftest --lint` gate's enforcement core.
 *
 * Enforces three size limits on harness-mgr's OWN source so the read-CLI stays
 * small and reviewable: a module is <= 200 SLOC, every function is <= 80 SLOC, and
 * no function takes more than 5 parameters. The point of SLOC ("source lines of
 * code") rather than physical lines is that this codebase's modules run 200-300
 * PHYSICAL lines but are mostly JSDoc — counting comments would flag clean files.
 *
 * --- What SLOC means here ---
 * A physical line counts iff, AFTER removing comments and the CONTENTS of string,
 * template, and regex literals, what remains (trimmed) is non-empty. So a blank
 * line, a pure line-comment or block-comment line, and a line that is only a
 * string of text do not count; a line with code plus a trailing note still counts.
 * That comment/literal stripping — and its documented template/regex limitations —
 * lives in ./projection.mjs (projectLines); this module only counts and matches
 * over the projection it returns, where braces inside strings/comments are blanked
 * but structural delimiters outside literals are preserved.
 *
 * --- Pragma escape: mgr-lint-ignore: <reason> ---
 * Directly above a function (no blank line between) it exempts THAT function from
 * the function-SLOC and parameter checks; anywhere else (e.g. the file header) it
 * exempts the MODULE-SLOC check for the file. The <reason> is REQUIRED — an
 * empty/whitespace reason grants NO exemption and emits lint-pragma-empty-reason.
 *
 * --- Pure / never-throws, by design ---
 * lintSource reads no filesystem and never throws: a non-string source coerces to
 * '' and any anomaly degrades to a diagnostic or a safe skip; inputs are never
 * mutated. lintTree is the thin fs wrapper (node:fs + node:path only) and also
 * never throws — an unreadable dir/file becomes a lint-read-failed diagnostic.
 *
 * Zero npm dependencies. Node stdlib only.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { projectLines } from './projection.mjs';

/**
 * @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic
 */

/** Module-SLOC ceiling (inclusive max). */
export const MAX_MODULE_SLOC = 200;
/** Function-SLOC ceiling (inclusive max), counting the signature line. */
export const MAX_FUNCTION_SLOC = 80;
/** Parameter-count ceiling (inclusive max) per function. */
export const MAX_PARAMS = 5;

const PRAGMA_RE = /\/\/\s*mgr-lint-ignore:(.*)$/;

/**
 * Lint ONE file's TEXT against the three size limits. Pure: never reads the
 * filesystem, never throws, never mutates input. `filePath` is used only to label
 * `diagnostic.path`. A non-string `source` is treated as empty (zero diagnostics).
 *
 * @param {string} filePath path reported on each diagnostic (not read)
 * @param {string} source the file's full text
 * @returns {Diagnostic[]}
 */
export function lintSource(filePath, source) {
  if (typeof source !== 'string' || source.length === 0) return [];
  const path = typeof filePath === 'string' ? filePath : undefined;
  const lines = source.split('\n');
  const code = projectLines(lines);
  /** @type {Diagnostic[]} */
  const out = [];
  const pragmas = collectPragmas(lines, out, path);
  checkModule(code, pragmas, out, path);
  checkFunctions(code, pragmas, out, path);
  return out;
}

/**
 * Recursively read every `*.mjs` under `rootDir` and lint each. Thin fs wrapper;
 * never throws — an unreadable directory or file yields a `lint-read-failed`
 * diagnostic and the walk continues. `scanned` lists the files actually linted.
 *
 * @param {string} rootDir directory to walk
 * @returns {{ diagnostics: Diagnostic[], scanned: string[] }}
 */
export function lintTree(rootDir) {
  /** @type {Diagnostic[]} */
  const diagnostics = [];
  /** @type {string[]} */
  const scanned = [];
  if (typeof rootDir !== 'string' || rootDir.length === 0) return { diagnostics, scanned };
  for (const file of walkMjs(rootDir, diagnostics)) {
    let text;
    try {
      text = readFileSync(file, 'utf-8');
    } catch (err) {
      diagnostics.push(readFailed(file, err));
      continue;
    }
    scanned.push(file);
    for (const d of lintSource(file, text)) diagnostics.push(d);
  }
  scanned.sort();
  return { diagnostics, scanned };
}

// ── pragmas ──────────────────────────────────────────────────────────────────────

/**
 * Scan raw lines for the `mgr-lint-ignore: <reason>` pragma. A non-empty reason
 * records the pragma's line index (for adjacency tests); an empty/whitespace reason
 * grants NO exemption and pushes a `lint-pragma-empty-reason` warn. Returns the set
 * of line indices that carry a VALID pragma.
 * @param {string[]} lines @param {Diagnostic[]} out @param {string|undefined} path
 * @returns {Set<number>}
 */
function collectPragmas(lines, out, path) {
  /** @type {Set<number>} */
  const valid = new Set();
  lines.forEach((line, idx) => {
    const m = PRAGMA_RE.exec(line);
    if (!m) return;
    if (m[1].trim().length === 0) {
      out.push(diag('warn', 'lint-pragma-empty-reason', 'mgr-lint-ignore pragma has an empty reason; exemption NOT granted', path,
        'add a reason after the colon'));
      return;
    }
    valid.add(idx);
  });
  return valid;
}

// ── checks ─────────────────────────────────────────────────────────────────────

/**
 * Module-SLOC check. A VALID pragma that is NOT directly above a function (i.e. a
 * header/standalone pragma) exempts the whole file. Never throws.
 * @param {string[]} code @param {Set<number>} pragmas @param {Diagnostic[]} out @param {string|undefined} path
 */
function checkModule(code, pragmas, out, path) {
  const sloc = countSloc(code, 0, code.length - 1);
  if (sloc <= MAX_MODULE_SLOC) return;
  const moduleExempt = [...pragmas].some((idx) => !startsFunction(code[idx + 1] ?? ''));
  if (moduleExempt) return;
  out.push(diag('error', 'lint-module-too-large', `module is ${sloc} SLOC (max ${MAX_MODULE_SLOC})`, path,
    'split this module into smaller files'));
}

/**
 * Function-SLOC + parameter checks. Detects each function head on the projection,
 * spans its body by brace depth, and reports oversize/over-param unless the line
 * directly above carries a valid pragma. Never throws.
 * @param {string[]} code @param {Set<number>} pragmas @param {Diagnostic[]} out @param {string|undefined} path
 */
function checkFunctions(code, pragmas, out, path) {
  for (let i = 0; i < code.length; i += 1) {
    const head = detectFunction(code, i);
    if (!head) continue;
    if (pragmas.has(i - 1)) { i = head.endLine; continue; }
    const sloc = countSloc(code, i, head.endLine);
    if (sloc > MAX_FUNCTION_SLOC) {
      out.push(diag('error', 'lint-function-too-large', `function ${head.name} is ${sloc} SLOC (max ${MAX_FUNCTION_SLOC})`, path,
        'extract a helper to keep the function small'));
    }
    if (head.params > MAX_PARAMS) {
      out.push(diag('error', 'lint-too-many-params', `function ${head.name} takes ${head.params} params (max ${MAX_PARAMS})`, path,
        'group related parameters into an options object'));
    }
    i = head.endLine;
  }
}

// ── function detection ───────────────────────────────────────────────────────────

const FN_HEADS = [
  /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/,
  /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?\(/,
  /^\s*([A-Za-z_$][\w$]*)\s*\(/,
];

/**
 * If a function head BEGINS at projected line `i`, return its name, top-level
 * parameter count, and the line index of its body's closing brace. Otherwise null.
 * The signature may span lines; params and body are matched on the projection so
 * commas/braces inside literals or comments cannot mislead. Never throws.
 * @param {string[]} code @param {number} i @returns {{name: string, params: number, endLine: number}|null}
 */
function detectFunction(code, i) {
  const name = matchHeadName(code[i]);
  if (name === null) return null;
  const openCol = code[i].indexOf('(');
  if (openCol === -1) return null;
  const sig = sliceSpan(code, i, openCol, ')');
  if (!sig) return null;
  const body = findBodyOpen(code, sig.endLine, sig.endCol + 1);
  if (body === null) return null;
  const close = sliceSpan(code, body.line, body.col, '}');
  if (!close) return null;
  return { name, params: countParams(sig.text), endLine: close.endLine };
}

/**
 * Return the function name if `line` begins a supported function head, else null.
 * The bare-identifier form (method/arrow) is rejected when the name is a control
 * keyword (if/for/while/switch/catch/return/...), which look like call heads.
 * @param {string} line @returns {string|null}
 */
function matchHeadName(line) {
  if (typeof line !== 'string') return null;
  for (const re of FN_HEADS) {
    const m = re.exec(line);
    if (!m) continue;
    if (re === FN_HEADS[2] && KEYWORDS.has(m[1])) return null;
    return m[1];
  }
  return null;
}

const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'await', 'typeof', 'do', 'else']);

/**
 * From the char AFTER a signature's closing paren, find the body's opening brace.
 * Only `=>`, whitespace, or `:` return-type-ish chars may sit between; anything
 * else means this was not a function definition (e.g. a bare call) → null.
 * @param {string[]} code @param {number} line @param {number} col
 * @returns {{line: number, col: number}|null}
 */
function findBodyOpen(code, line, col) {
  for (let r = line; r < code.length; r += 1) {
    const text = code[r];
    for (let c = r === line ? col : 0; c < text.length; c += 1) {
      const ch = text[c];
      if (ch === '{') return { line: r, col: c };
      if (ch === ' ' || ch === '\t' || ch === '=' || ch === '>' || ch === ':') continue;
      return null;
    }
  }
  return null;
}

/**
 * Walk the projection from (startLine, openCol) — the index of an opener — to its
 * matching `close`, returning the concatenated INNER text plus the end position.
 * Never throws; an unmatched opener returns null.
 * @param {string[]} code @param {number} startLine @param {number} openCol @param {string} close
 * @returns {{text: string, endLine: number, endCol: number}|null}
 */
function sliceSpan(code, startLine, openCol, close) {
  const open = close === ')' ? '(' : '{';
  let depth = 0;
  let text = '';
  for (let r = startLine; r < code.length; r += 1) {
    const lineText = code[r];
    for (let c = r === startLine ? openCol : 0; c < lineText.length; c += 1) {
      const ch = lineText[c];
      if (ch === open) { depth += 1; if (depth === 1) continue; }
      else if (ch === close) { depth -= 1; if (depth === 0) return { text, endLine: r, endCol: c }; }
      if (depth >= 1) text += ch;
    }
    if (depth >= 1) text += '\n';
  }
  return null;
}

/**
 * Count top-level parameters in a signature's inner text. Splits on depth-0 commas
 * (ignoring commas nested in brackets/braces/parens), counting non-empty segments —
 * so an empty list is 0 and a destructured `{a, b}` param counts as ONE.
 * @param {string} inner the text BETWEEN the signature parens
 * @returns {number}
 */
function countParams(inner) {
  let depth = 0;
  let count = 0;
  let seen = false;
  for (const ch of inner) {
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    else if (ch === ',' && depth === 0) { if (seen) count += 1; seen = false; continue; }
    if (!/\s/.test(ch)) seen = true;
  }
  return seen ? count + 1 : count;
}

// ── small shared helpers ─────────────────────────────────────────────────────────

/**
 * Count SLOC lines in `code` over the inclusive index range [from, to]: a line
 * whose projection trims to non-empty. Bounds are clamped; never throws.
 * @param {string[]} code @param {number} from @param {number} to @returns {number}
 */
function countSloc(code, from, to) {
  const lo = Math.max(0, from);
  const hi = Math.min(code.length - 1, to);
  let n = 0;
  for (let i = lo; i <= hi; i += 1) {
    if (code[i] && code[i].trim().length > 0) n += 1;
  }
  return n;
}

/**
 * Does projected `line` begin a function head? Used to classify a pragma as
 * function-adjacent (vs module-level). Conservatively also matches bare calls
 * (e.g. `foo(`), which can only DENY a module-level pragma exemption — the safe
 * direction — never grant a false one. Never throws.
 * @param {string} line @returns {boolean}
 */
function startsFunction(line) {
  return matchHeadName(line) !== null;
}

/**
 * Build a Diagnostic with the lint phase, omitting an absent path.
 * @param {'info'|'warn'|'error'} severity @param {string} code @param {string} message
 * @param {string|undefined} path @param {string} [fix] @returns {Diagnostic}
 */
function diag(severity, code, message, path, fix) {
  /** @type {Diagnostic} */
  const d = { severity, code, message, phase: 'lint' };
  if (typeof path === 'string') d.path = path;
  if (typeof fix === 'string') d.fix = fix;
  return d;
}

/** @param {string} file @param {unknown} err @returns {Diagnostic} */
function readFailed(file, err) {
  const message = err instanceof Error ? err.message : String(err ?? '');
  return diag('error', 'lint-read-failed', `read failed: ${message}`, file);
}

/**
 * Recursively collect `*.mjs` paths under `dir`, never throwing — an unreadable
 * directory yields a `lint-read-failed` diagnostic and is skipped. Order is
 * filesystem-defined; lintTree sorts `scanned` for determinism.
 * @param {string} dir @param {Diagnostic[]} diagnostics @returns {string[]}
 */
function walkMjs(dir, diagnostics) {
  /** @type {string[]} */
  const found = [];
  let ents;
  try {
    ents = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    diagnostics.push(readFailed(dir, err));
    return found;
  }
  for (const ent of ents) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) for (const f of walkMjs(full, diagnostics)) found.push(f);
    else if (ent.isFile() && /\.mjs$/i.test(ent.name)) found.push(full);
  }
  return found;
}
