/**
 * `config diff <a> <b> [relpath] [--context N]` — a READ-ONLY diff command.
 *
 * FILE MODE (default): reads two file paths and renders a git-style unified diff
 * via the pure Myers engine in ../output/diff.mjs.
 *
 * SNAPSHOT MODE: when a and b are both valid snapshot ids AND ctx.mgrStateDir is
 * set AND both snapshot dirs exist on disk, the handler delegates to
 * `diffSnapshots` (src/ops/snapshot-diff.mjs). A third positional (relpath) selects
 * content-diff mode; omitting it gives a manifest-level file-list diff.
 *
 * Detection is non-magic: a snapshot-id-shaped string that is NOT an actual snapshot
 * directory on disk falls through to file mode, so a real file named like a snapshot
 * id still diffs as a file.
 *
 * M2-SAFETY: snapshot-diff.mjs and snapshot-manifest.mjs are M2-safe (neither
 * imports paths.mjs), so adding them here keeps the CLI static graph paths.mjs-free.
 * The invariants gate confirms this.
 *
 * Exit codes (the handler returns an explicit `code` that run() honours):
 *   0  diff computed (file or snapshot mode).
 *   1  a file could not be read / snapshot diff failed / unexpected throw.
 *   2  the two required arguments were not supplied (config-diff-no-spec).
 *
 * Zero npm dependencies. Node stdlib only (plus src/ops/snapshot-diff imports stdlib).
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import { computeLineDiff, formatUnified, diffToJson } from '../output/diff.mjs';
import { diffSnapshots } from '../ops/snapshot-diff.mjs';
import { isValidSnapshotId, snapshotDir } from '../ops/snapshot-manifest.mjs';
import { redactSecretsLines } from '../analysis/redact-secrets-text.mjs';

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
 * True when both ids are valid snapshot ids AND mgrStateDir is set AND both snapshot
 * dirs exist on disk. Non-magic: a snapshot-id-shaped filename that is NOT a real
 * snapshot dir falls through to file mode.
 * @param {string} a @param {string} b @param {string|undefined} mgrStateDir
 * @param {(p:string)=>boolean} existsFn
 * @returns {boolean}
 */
function isSnapshotMode(a, b, mgrStateDir, existsFn) {
  if (!isValidSnapshotId(a) || !isValidSnapshotId(b)) return false;
  if (typeof mgrStateDir !== 'string' || mgrStateDir.length === 0) return false;
  return existsFn(snapshotDir(mgrStateDir, a)) && existsFn(snapshotDir(mgrStateDir, b));
}

/**
 * The `config:diff` handler. FILE MODE: reads two files and returns a unified
 * line-diff. SNAPSHOT MODE: delegates to diffSnapshots when both positionals are
 * valid snapshot ids that exist on disk.
 *
 * @param {{ configDir?: string, mgrStateDir?: string, args?: Object }} ctx
 *   `ctx.args.positionals[0]` = a, `[1]` = b, `[2]` = relpath (snapshot mode only);
 *   `ctx.args.context` = the optional `--context N` value flag (default 3).
 * @param {{ readFn?: Function, cwd?: string, existsFn?: Function, diffSnapshotsFn?: Function }} [deps]
 *   injectable seams.
 * @returns {Promise<{ result: Object, diagnostics: Diagnostic[], code: number }>}
 */
export async function configDiffCommand(ctx, deps = {}) {
  try {
    const args = (ctx && ctx.args) || {};
    const a = args.positionals && args.positionals[0];
    const b = args.positionals && args.positionals[1];

    if (typeof a !== 'string' || a.length === 0 || typeof b !== 'string' || b.length === 0) {
      return {
        result: { status: 'no-spec' },
        diagnostics: [{
          severity: 'error', code: 'config-diff-no-spec', phase: 'cli',
          message: 'config diff requires two arguments: config diff <a> <b> [relpath] [--context N]',
        }],
        code: 2,
      };
    }

    // Tolerate absent/garbage --context → 3. `+args.context` coerces a numeric
    // string ('5') or undefined (→ NaN, rejected); Number.isInteger filters NaN/floats;
    // `>= 0` rejects a negative (which the engine's normContext would floor anyway —
    // so the handler and the engine share one notion of a valid context).
    const context = Number.isInteger(+args.context) && +args.context >= 0 ? +args.context : 3;

    const existsFn = typeof deps.existsFn === 'function' ? deps.existsFn : existsSync;
    const mgrStateDir = ctx && ctx.mgrStateDir;

    // SNAPSHOT MODE: both args are valid snapshot ids AND their dirs exist on disk.
    if (isSnapshotMode(a, b, mgrStateDir, existsFn)) {
      const relpath = args.positionals && args.positionals[2];
      const diffSnapshotsFn = typeof deps.diffSnapshotsFn === 'function'
        ? deps.diffSnapshotsFn : diffSnapshots;
      const out = await diffSnapshotsFn({ mgrStateDir, idA: a, idB: b, relpath, context });
      return { result: out, diagnostics: out.diagnostics, code: out.ok ? 0 : 1 };
    }

    // FILE MODE (unchanged from P4b.U7b).
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

    // Redact secret VALUES (URL userinfo, Bearer, self-identifying tokens, PEM header,
    // sensitive name=value) BEFORE diffing, so no secret reaches the unified/hunks output.
    // Per-LINE redaction (redactSecretsLines) keeps the 64 KiB cost cap bounded to one line,
    // so a config larger than 64 KiB is still redacted (not returned verbatim). This makes
    // `config diff` honour the same no-secret-values contract as `config show-effective`
    // (threat-model §5.3); a secret changing between the two files diffs as <redacted>→<redacted>.
    const diff = computeLineDiff(redactSecretsLines(aRead.text), redactSecretsLines(bRead.text));
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
