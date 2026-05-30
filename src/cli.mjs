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
 *   2  usage error (no/unknown subcommand) OR an internal throw
 *   1  ran, but the merged diagnostics contain a severity:'error' entry
 *   0  ran cleanly (no error-severity diagnostics)
 *
 * Zero npm dependencies (project imports + node stdlib only). run() never throws.
 */

import { pathToFileURL } from 'node:url';
import { COMMANDS } from './cli/commands.mjs';
import { resolveConfigDir } from './cli/resolve-config.mjs';
import { formatJson, formatNdjson } from './output/json.mjs';
import { renderTable, renderQuiet } from './cli/render.mjs';

/**
 * @typedef {import('./lib/diagnostic.mjs').Diagnostic} Diagnostic
 */

/**
 * @typedef {Object} RunResult
 * @property {number} code     process exit code (0 ok, 1 error-diagnostic, 2 usage/throw)
 * @property {string} stdout   the rendered output to print (no trailing write here)
 */

/** Value flags consume the NEXT token; boolean flags are presence-only. */
const VALUE_FLAGS = Object.freeze(['--format', '--config-dir', '--name', '--key', '--type', '--since', '--base', '--reason']);
const BOOLEAN_FLAGS = Object.freeze(['--explain', '--order', '--detail', '--lint', '--invariants', '--boundary', '--all', '--audit', '--active-probes', '--update', '--release-gate', '--log', '--schema-canary', '--update-baseline', '--apply', '--include-auth']);

/** The output formats run() understands; anything else falls back to 'table'. */
const FORMATS = Object.freeze(['table', 'json', 'quiet', 'ndjson']);

/**
 * Parse argv, resolve the config dir, dispatch to the command, and render. Never
 * throws and never touches process — returns `{code, stdout}` for the caller.
 *
 * @param {string[]} argv   already sliced (no node/script path)
 * @returns {Promise<RunResult>}
 */
export async function run(argv) {
  try {
    const { canonical, args } = parseArgs(Array.isArray(argv) ? argv : []);

    if (!canonical) return { code: 2, stdout: usage() };
    if (!Object.prototype.hasOwnProperty.call(COMMANDS, canonical)) {
      return { code: 2, stdout: unknownCommand(canonical) };
    }

    const cfg = await resolveConfigDir({ configDir: args.configDir });
    const out = await COMMANDS[canonical]({ configDir: cfg.configDir, mgrStateDir: cfg.mgrStateDir, args });
    const diagnostics = [...cfg.diagnostics, ...out.diagnostics];

    // Honor an explicit numeric code from the handler (e.g. release-gate uses 0/1/2);
    // backward-compatible: existing handlers don't set code, so we fall back to the
    // standard exit-code logic.
    const code = typeof out.code === 'number' ? out.code : exitCode(diagnostics);
    return { code, stdout: render(canonical, out.result, diagnostics, args.format) };
  } catch (err) {
    // The boundary guarantee: never a bare stack trace. Degrade to a JSON envelope.
    return { code: 2, stdout: formatJson({ error: 'internal', message: errMessage(err) }) };
  }
}

/**
 * Hand-rolled, zero-dep argv parse. The first positional is the subcommand —
 * with one SPECIAL CASE: `config show-effective` collapses to the canonical
 * `'config:show-effective'` (both tokens consumed). Value flags consume the next
 * token; boolean flags are presence-only; unknown `--flags` are ignored (lenient).
 *
 * @param {string[]} argv
 * @returns {{canonical: string|null, args: {format?:string, configDir?:string, name?:string, key?:string, type?:string, explain?:boolean, order?:boolean, detail?:boolean}}}
 */
function parseArgs(argv) {
  const args = Object.create(null); // null-proto: a `--constructor`-style flag can never reach a prototype key
  /** @type {string[]} */
  const positionals = [];

  for (let i = 0; i < argv.length; i += 1) {
    const tok = argv[i];
    if (typeof tok !== 'string') continue;
    if (VALUE_FLAGS.includes(tok)) {
      args[flagKey(tok)] = argv[i + 1]; // may be undefined at end of argv — tolerated
      i += 1; // consume the value token
    } else if (BOOLEAN_FLAGS.includes(tok)) {
      args[flagKey(tok)] = true;
    } else if (tok.startsWith('--')) {
      continue; // unknown long flag → ignore (lenient)
    } else {
      positionals.push(tok);
    }
  }

  return { canonical: canonicalize(positionals), args };
}

/**
 * Resolve the canonical command name from the positionals. No positional → null.
 * The two-word `config show-effective` collapses to one canonical key; otherwise
 * the first positional is the canonical name verbatim (membership checked later).
 *
 * @param {string[]} positionals
 * @returns {string|null}
 */
function canonicalize(positionals) {
  const first = positionals[0];
  if (typeof first !== 'string' || first.length === 0) return null;
  if (first === 'config' && positionals[1] === 'show-effective') return 'config:show-effective';
  return first;
}

/**
 * Map a flag token to its `args` key: strip the leading `--` and camel-case the
 * one hyphenated flag (`--config-dir` → `configDir`). Keeps the args object's
 * shape exactly what the handlers document.
 *
 * @param {string} flag
 * @returns {string}
 */
function flagKey(flag) {
  return flag === '--config-dir' ? 'configDir' : flag.slice(2);
}

/**
 * Render the chosen output format. `format` is the requested format if it is one
 * of FORMATS, else 'table' (an unrecognized --format silently defaults — never an
 * error). json is the versioned envelope; quiet is a one-line summary; table is a
 * human block plus a diagnostics footer.
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
  return `claude-mgr — read-mostly governance CLI\n\nusage: claude-mgr <command> [--config-dir <dir>] [--format table|json|quiet]\n\ncommands:\n${commandList()}`;
}

/**
 * The message for an unrecognized subcommand: name it and list the valid ones.
 * @param {string} canonical
 * @returns {string}
 */
function unknownCommand(canonical) {
  return `unknown command: ${canonical}\n\nvalid commands:\n${commandList()}`;
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
// or via the claude-mgr.ps1 wrapper), NEVER when imported by tests. run() stays
// pure; this guard is the one place that touches process — it prints stdout and
// sets the exit code from run()'s result.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(process.argv.slice(2)).then(({ code, stdout }) => {
    process.stdout.write(stdout + '\n');
    process.exit(code);
  });
}
