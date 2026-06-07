/**
 * `config diff <a> <b> [--context N]` — a READ-ONLY unified line-diff of two files
 * (P4b.U7b).
 *
 * This handler reads two file paths and renders a git-style unified diff using the
 * pure Myers engine in ../output/diff.mjs. It is a PURE READ command:
 *   - NO write gate, NO paths.mjs, NO snapshot, NO lock — it only reads two files.
 *   - M2-safe: imports ONLY node:fs (readFileSync), node:path (resolve/isAbsolute),
 *     and ../output/diff.mjs. There is no static or dynamic paths.mjs import.
 *   - Never throws: the whole body is wrapped so any unexpected throw degrades to a
 *     `config-diff-error` diagnostic + code 1, honouring the CLI's never-bare-stack rule.
 *
 * Exit codes (the handler returns an explicit `code` that run() honours):
 *   0  the diff was computed (EVEN IF the files differ — like `git diff` WITHOUT
 *      --exit-code: a difference is data, not a failure; computing it succeeded).
 *   1  a file could not be read (config-diff-unreadable) OR an unexpected throw
 *      (config-diff-error).
 *   2  the two required path arguments were not supplied (config-diff-no-spec).
 *
 * The result carries the structured `diffToJson` fields (aLabel/bLabel/stats/hunks)
 * for `--format json`, a `unified` STRING for the table renderer, and a `changed`
 * boolean. Both file labels are the ORIGINAL (pre-resolve) argument strings so the
 * diff header reads exactly what the user typed.
 *
 * Zero npm dependencies. Node stdlib only.
 */

import { readFileSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import { computeLineDiff, formatUnified, diffToJson } from '../output/diff.mjs';

/**
 * @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic
 */

/**
 * Default file reader: read a path as UTF-8, never throwing. Returns the text on
 * success or an `{error}` describing the failure (ENOENT, EISDIR, EACCES, …).
 *
 * @param {string} path
 * @returns {{text: string, error?: undefined} | {text?: undefined, error: string}}
 */
function defaultRead(path) {
  try {
    return { text: readFileSync(path, 'utf8') };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Resolve a path against `cwd` when it is not already absolute. Total — a non-string
 * is returned as-is so the read step surfaces the failure as `config-diff-unreadable`
 * rather than throwing here.
 *
 * @param {string} p
 * @param {string} cwd
 * @returns {string}
 */
function resolvePath(p, cwd) {
  if (typeof p !== 'string') return p;
  return isAbsolute(p) ? p : resolve(cwd, p);
}

/**
 * The `config:diff` handler. Reads two files and returns a unified line-diff.
 *
 * @param {{ configDir?: string, mgrStateDir?: string, args?: Object }} ctx
 *   `ctx.args.positionals[0]` = path A, `[1]` = path B; `ctx.args.context` = the
 *   optional `--context N` value flag (default 3).
 * @param {{ readFn?: (path: string) => {text?: string, error?: string}, cwd?: string }} [deps]
 *   injectable seams — `readFn` defaults to a never-throws UTF-8 reader; `cwd`
 *   defaults to `process.cwd()`.
 * @returns {{ result: Object, diagnostics: Diagnostic[], code: number }}
 */
export function configDiffCommand(ctx, deps = {}) {
  try {
    const args = (ctx && ctx.args) || {};
    const a = args.positionals && args.positionals[0];
    const b = args.positionals && args.positionals[1];

    if (typeof a !== 'string' || a.length === 0 || typeof b !== 'string' || b.length === 0) {
      return {
        result: { status: 'no-spec' },
        diagnostics: [{
          severity: 'error', code: 'config-diff-no-spec', phase: 'cli',
          message: 'config diff requires two file paths: config diff <a> <b> [--context N]',
        }],
        code: 2,
      };
    }

    // Tolerate absent/garbage --context → 3. `+args.context` coerces a numeric
    // string ('5') or undefined (→ NaN, rejected); Number.isInteger filters NaN/floats;
    // `>= 0` rejects a negative (which the engine's normContext would floor anyway —
    // so the handler and the engine share one notion of a valid context).
    const context = Number.isInteger(+args.context) && +args.context >= 0 ? +args.context : 3;

    const readFn = typeof deps.readFn === 'function' ? deps.readFn : defaultRead;
    const cwd = typeof deps.cwd === 'string' ? deps.cwd : process.cwd();

    const aRead = readFn(resolvePath(a, cwd));
    const bRead = readFn(resolvePath(b, cwd));

    /** @type {Diagnostic[]} */
    const readDiags = [];
    if (!aRead || typeof aRead.text !== 'string') {
      readDiags.push({
        severity: 'error', code: 'config-diff-unreadable', phase: 'cli',
        message: `cannot read ${a}: ${(aRead && aRead.error) || 'unreadable'}`,
      });
    }
    if (!bRead || typeof bRead.text !== 'string') {
      readDiags.push({
        severity: 'error', code: 'config-diff-unreadable', phase: 'cli',
        message: `cannot read ${b}: ${(bRead && bRead.error) || 'unreadable'}`,
      });
    }
    if (readDiags.length > 0) {
      return { result: { status: 'unreadable', a, b }, diagnostics: readDiags, code: 1 };
    }

    const diff = computeLineDiff(aRead.text, bRead.text);
    const labels = { aLabel: a, bLabel: b, context };
    const result = {
      ...diffToJson(diff, labels),
      unified: formatUnified(diff, labels),
      changed: diff.stats.added > 0 || diff.stats.deleted > 0,
    };
    // Exit 0 even when the files differ — computing the diff succeeded (git-diff
    // semantics without --exit-code).
    return { result, diagnostics: [], code: 0 };
  } catch (err) {
    return {
      result: { status: 'error' },
      diagnostics: [{
        severity: 'error', code: 'config-diff-error', phase: 'cli',
        message: err instanceof Error ? err.message : String(err),
      }],
      code: 1,
    };
  }
}
