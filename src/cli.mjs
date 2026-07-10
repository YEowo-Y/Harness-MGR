/**
 * CLI shell — argv → command → formatted output (P1.U15, sub-unit B).
 *
 * The PURE layers already exist and are reviewed: commands.mjs (the frozen
 * `COMMANDS` registry of never-throws `(ctx) => {result, diagnostics}` handlers),
 * resolve-config.mjs (which `~/.claude` is governed, M2-aware), and the json/table
 * output adapters. This shell wires argv parsing + output formatting around them.
 *
 * --- run() is PURE-ish and unit-testable ---
 * `run(argv)` returns `{code, stdout}` and NEVER calls process.exit / writes to
 * process.stdout — the executable entry guard at the BOTTOM of this file does that,
 * and only when cli.mjs is the process entry script (not under import). It also
 * NEVER throws: the whole
 * body is wrapped so an unexpected throw (the underlying modules are never-throws,
 * but the shell guards anyway) degrades to a JSON error envelope with code 2,
 * honouring the plan's "never a bare stack trace" rule.
 *
 * --- exit codes ---
 *   2  usage error (no/unknown subcommand, unknown long flag) OR an internal throw
 *   1  ran, but the merged diagnostics contain a severity:'error' entry
 *   0  ran cleanly (no error-severity diagnostics)
 *
 * Zero npm dependencies (project imports + node stdlib only). run() never throws.
 */

import { pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
import { COMMANDS } from './cli/commands.mjs';
import { resolveTargetAndConfig, isKnownTarget } from './cli/resolve-target.mjs';
import { TARGETS } from './targets/descriptor.mjs';
import { formatJson, formatNdjson } from './output/json.mjs';
import { renderTable, renderQuiet } from './cli/render.mjs';
import { VALUE_FLAGS, BOOLEAN_FLAGS } from './cli/flags.mjs';
import { parseArgs } from './cli/parse-args.mjs';
import { redactHomePaths } from './output/redact-paths.mjs';

/**
 * @typedef {import('./lib/diagnostic.mjs').Diagnostic} Diagnostic
 */

/**
 * @typedef {Object} RunResult
 * @property {number} code     process exit code (0 ok, 1 error-diagnostic, 2 usage/throw)
 * @property {string} stdout   the rendered output to print (no trailing write here)
 */

/** The output formats run() understands; anything else falls back to 'table'. */
const FORMATS = Object.freeze(['table', 'json', 'quiet', 'ndjson']);

/**
 * Parse argv, resolve the config dir, dispatch to the command, and render. Never
 * throws and never touches process — returns `{code, stdout}` for the caller.
 *
 * @param {string[]} argv        already sliced (no node/script path)
 * @param {Object}  [opts]
 * @param {()=>string} [opts.homeFn]  injectable seam for os.homedir() — tests
 *   override this to avoid depending on the real home directory.
 * @returns {Promise<RunResult>}
 */
export async function run(argv, { homeFn } = {}) {
  try {
    const { canonical, args, unknownFlag, missingValueFlag } = parseArgs(argv);

    // An unrecognized long flag is a hard usage error (exit 2) — mirror the
    // unknown-command path so a typo like `--configdir` can NEVER be silently
    // dropped (which would leave configDir undefined and misdirect a write to the
    // real ~/.claude once apply/rollback are CLI-wired).
    if (unknownFlag) return { code: 2, stdout: unknownFlagUsage(unknownFlag) };
    // A value flag left without a real value is a hard usage error too — a trailing,
    // flag-swallowing, or empty `--config-dir`/`--target` must NOT silently resolve to
    // the real ~/.claude (the write-misdirection the strict-flag policy guards against).
    if (missingValueFlag) return { code: 2, stdout: missingValueUsage(missingValueFlag) };
    if (!canonical) return { code: 2, stdout: usage() };
    if (!Object.prototype.hasOwnProperty.call(COMMANDS, canonical)) {
      return { code: 2, stdout: unknownCommand(canonical) };
    }

    // An explicit but unknown --target is a hard usage error (exit 2) — mirror the
    // unknown-flag/command path so a typo (`--target codexx`) can NEVER silently
    // mis-route to the default claude harness.
    if (args.target !== undefined && !isKnownTarget(args.target)) {
      return { code: 2, stdout: unknownTargetUsage(args.target) };
    }

    const cfg = await resolveTargetAndConfig({ target: args.target, configDir: args.configDir, homeFn });
    const out = await COMMANDS[canonical]({ configDir: cfg.configDir, mgrStateDir: cfg.mgrStateDir, descriptor: cfg.descriptor, args });
    let diagnostics = [...cfg.diagnostics, ...out.diagnostics, ...formatDiagnostics(args.format)];
    let result = out.result;

    // --redact-paths (opt-in privacy): replace every home-dir prefix in strings
    // with '~' so the OS username does not appear in the output. Applied AFTER
    // the handler returns and BEFORE serialisation so ALL formats are covered.
    // The exit code is not affected by redaction.
    if (args['redact-paths']) {
      const home = typeof homeFn === 'function' ? homeFn() : homedir();
      result = redactHomePaths(result, home);
      diagnostics = /** @type {typeof diagnostics} */ (redactHomePaths(diagnostics, home));
    }

    // Honor an explicit numeric code from the handler (e.g. release-gate uses 0/1/2);
    // backward-compatible: existing handlers don't set code, so we fall back to the
    // standard exit-code logic.
    const code = typeof out.code === 'number' ? out.code : exitCode(diagnostics);
    return { code, stdout: render(canonical, result, diagnostics, args.format) };
  } catch (err) {
    // The boundary guarantee: never a bare stack trace. Degrade to a JSON envelope.
    return { code: 2, stdout: formatJson({ error: 'internal', message: errMessage(err) }) };
  }
}

/**
 * One warn diagnostic when `--format` was given an unrecognized value. The render
 * still falls back to 'table' and the exit code is unchanged (a typo is advisory,
 * not fatal) — but the bad value is surfaced instead of silently ignored. A missing
 * or valid format yields no diagnostic.
 *
 * @param {unknown} format
 * @returns {Diagnostic[]}
 */
function formatDiagnostics(format) {
  if (format === undefined || FORMATS.includes(format)) return [];
  return [{
    severity: 'warn',
    code: 'unknown-format',
    message: `unknown --format ${String(format)}; falling back to table (valid: ${FORMATS.join(', ')})`,
  }];
}

/**
 * Render the chosen output format. `format` is the requested format if it is one
 * of FORMATS, else 'table' (an unrecognized --format falls back to table — see
 * formatDiagnostics() for the warn it raises). json is the versioned envelope;
 * quiet is a one-line summary; table is a human block plus a diagnostics footer.
 *
 * @param {string} canonical
 * @param {unknown} result
 * @param {Diagnostic[]} diagnostics
 * @param {unknown} format
 * @returns {string}
 */
function render(canonical, result, diagnostics, format) {
  const fmt = FORMATS.includes(format) ? format : 'table';
  if (fmt === 'json') return formatJson({ command: canonical, result, diagnostics });
  if (fmt === 'ndjson') return formatNdjson({ command: canonical, result, diagnostics });
  if (fmt === 'quiet') return renderQuiet(canonical, countSeverity(diagnostics, 'error'), countSeverity(diagnostics, 'warn'));
  return appendFooter(renderTable(canonical, result), diagnostics);
}

/**
 * Append the diagnostics footer to a table body — one line per diagnostic in the
 * form `severity code: message`. No diagnostics → the body is returned unchanged.
 *
 * @param {string} body
 * @param {Diagnostic[]} diagnostics
 * @returns {string}
 */
function appendFooter(body, diagnostics) {
  if (!diagnostics.length) return body;
  const lines = diagnostics.map((d) => `${d.severity} ${d.code}: ${d.message}`);
  return `${body}\n\n${lines.join('\n')}`;
}

/**
 * The exit code from the merged diagnostics: 1 if ANY is error-severity, else 0.
 * (Usage errors and internal throws set code 2 directly in run().)
 *
 * @param {Diagnostic[]} diagnostics
 * @returns {0|1}
 */
function exitCode(diagnostics) {
  return diagnostics.some((d) => d && d.severity === 'error') ? 1 : 0;
}

/**
 * Count diagnostics of one severity.
 * @param {Diagnostic[]} diagnostics
 * @param {string} severity
 * @returns {number}
 */
function countSeverity(diagnostics, severity) {
  let n = 0;
  for (const d of diagnostics) if (d && d.severity === severity) n += 1;
  return n;
}

/**
 * The usage text shown for no/empty subcommand. Lists the valid canonical
 * commands so a bare invocation is self-documenting.
 * @returns {string}
 */
function usage() {
  return `harness-mgr — read-mostly governance CLI\n\nusage: harness-mgr <command> [--config-dir <dir>] [--format ${FORMATS.join('|')}]\n\n  --target claude|codex   govern a Claude (default) or Codex (~/.codex) harness\n  --active-probes  (doctor) run active checks that spawn external tools and let\n                   the loader probe briefly create + self-remove a temporary file\n                   in the real agents/ directory (gated, always cleaned up)\n  --redact-paths   replace the home-directory prefix in output paths with '~'\n                   (opt-in privacy; without this flag output is unchanged)\n\nread commands:\n  config diff <a> <b> [--context N]      unified line-diff of two files\n  completion bash|powershell             emit a shell tab-completion script\n  health                                 severity-layered health report (loadability + advice + hooks)\n  compare [--detail]                     cross-target presence report (claude vs codex; by kind+name)\n\nwrite commands (DRY-RUN by default; pass --apply to execute. Set\nHARNESS_MGR_ENABLE_WRITES=0 to force-lock all writes):\n  rollback <id> [--force] [--apply]\n  recover <id> [--mark-failed|--resume|--rollback|--from-manifest] [--force] [--apply]\n  lock [--break-lock --apply]\n  remove <kind>:<name> [--cascade [--force]] [--reason <msg>] [--apply]\n  update <plugin> [--lock-version <ver>] [--reason <msg>] [--apply]\n  mcp remove <name> [--scope local|user|project] [--reason <msg>] [--apply]\n  skill propose <name> --from <file> [--reason <msg>] [--apply]\n  skill accept <name> [<proposalId>] [--force] [--apply]\n  skill visibility <name> on|name-only|user-invocable-only|off [--apply]  (Claude)\n\ncommands:\n${commandList()}`;
}

/**
 * The message for an unrecognized subcommand: name it and list the valid ones.
 * @param {string} canonical
 * @returns {string}
 */
function unknownCommand(canonical) {
  return `unknown command: ${canonical}\n\nvalid commands:\n${commandList()}`;
}

/**
 * The message for an unrecognized long flag: name the offending flag and list the
 * known flags so a typo (e.g. `--configdir`) is caught instead of silently dropped.
 * @param {string} flag
 * @returns {string}
 */
function unknownFlagUsage(flag) {
  return `unknown flag: ${flag}\n\nknown flags:\n${flagList()}`;
}

/**
 * The message for a value flag left without a real value (trailing, followed by
 * another flag, or empty). Naming it prevents the silent misdirection a bare
 * `--config-dir` would otherwise cause.
 * @param {string} flag
 * @returns {string}
 */
function missingValueUsage(flag) {
  return `flag requires a value: ${flag}\n\nknown flags:\n${flagList()}`;
}

/**
 * The message for an unrecognized --target value: name it and list the valid
 * target ids so a typo (e.g. `--target codexx`) is caught instead of silently
 * mis-routing to the default claude harness.
 * @param {string} target
 * @returns {string}
 */
function unknownTargetUsage(target) {
  return `unknown target: ${target}\n\nvalid targets:\n${targetList()}`;
}

/** The known flag names (value + boolean), one indented line each. @returns {string} */
function flagList() {
  return [...VALUE_FLAGS, ...BOOLEAN_FLAGS].map((f) => `  ${f}`).join('\n');
}

/** The valid target ids, one indented line each. @returns {string} */
function targetList() {
  return Object.keys(TARGETS).map((t) => `  ${t}`).join('\n');
}

/** The valid command names, one indented line each. @returns {string} */
function commandList() {
  return Object.keys(COMMANDS).map((c) => `  ${c}`).join('\n');
}

/** @param {unknown} err @returns {string} */
function errMessage(err) {
  return err instanceof Error ? err.message : String(err ?? '');
}

// ── executable entry (P1.U16) ────────────────────────────────────────────────────
//
// Fire ONLY when this module is the process entry script (e.g. `node src/cli.mjs …`
// or via the harness-mgr.ps1 wrapper), NEVER when imported by tests. run() stays
// pure; this guard is the one place that touches process — it prints stdout and
// sets the exit code from run()'s result.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(process.argv.slice(2)).then(({ code, stdout }) => {
    process.stdout.write(stdout + '\n');
    process.exit(code);
  });
}
