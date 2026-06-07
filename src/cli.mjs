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
import { COMMANDS } from './cli/commands.mjs';
import { resolveConfigDir } from './cli/resolve-config.mjs';
import { formatJson, formatNdjson } from './output/json.mjs';
import { renderTable, renderQuiet } from './cli/render.mjs';
import { VALUE_FLAGS, BOOLEAN_FLAGS } from './cli/flags.mjs';

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
 * @param {string[]} argv   already sliced (no node/script path)
 * @returns {Promise<RunResult>}
 */
export async function run(argv) {
  try {
    const { canonical, args, unknownFlag } = parseArgs(Array.isArray(argv) ? argv : []);

    // An unrecognized long flag is a hard usage error (exit 2) — mirror the
    // unknown-command path so a typo like `--configdir` can NEVER be silently
    // dropped (which would leave configDir undefined and misdirect a write to the
    // real ~/.claude once apply/rollback are CLI-wired).
    if (unknownFlag) return { code: 2, stdout: unknownFlagUsage(unknownFlag) };
    if (!canonical) return { code: 2, stdout: usage() };
    if (!Object.prototype.hasOwnProperty.call(COMMANDS, canonical)) {
      return { code: 2, stdout: unknownCommand(canonical) };
    }

    const cfg = await resolveConfigDir({ configDir: args.configDir });
    const out = await COMMANDS[canonical]({ configDir: cfg.configDir, mgrStateDir: cfg.mgrStateDir, args });
    const diagnostics = [...cfg.diagnostics, ...out.diagnostics, ...formatDiagnostics(args.format)];

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
 * token; boolean flags are presence-only.
 *
 * STRICT-FLAG POLICY (P2.1): an unrecognized long `--flag` is NOT silently dropped
 * — the FIRST one is captured as `unknownFlag` and run() turns it into a hard exit-2
 * usage error. This stops a typo (`--configdir` vs `--config-dir`) from being
 * discarded, leaving its key unset and its value token leaking into the positionals.
 *
 * @param {string[]} argv
 * @returns {{canonical: string|null, args: {format?:string, configDir?:string, name?:string, key?:string, type?:string, explain?:boolean, order?:boolean, detail?:boolean}, unknownFlag: string|null}}
 */
function parseArgs(argv) {
  const args = Object.create(null); // null-proto: a `--constructor`-style flag can never reach a prototype key
  /** @type {string[]} */
  const positionals = [];
  /** @type {string|null} the first unrecognized long flag (drives the exit-2 usage error) */
  let unknownFlag = null;

  for (let i = 0; i < argv.length; i += 1) {
    const tok = argv[i];
    if (typeof tok !== 'string') continue;
    if (VALUE_FLAGS.includes(tok)) {
      args[flagKey(tok)] = argv[i + 1]; // may be undefined at end of argv — tolerated
      i += 1; // consume the value token
    } else if (BOOLEAN_FLAGS.includes(tok)) {
      args[flagKey(tok)] = true;
    } else if (tok.startsWith('--')) {
      if (unknownFlag === null) unknownFlag = tok; // strict: capture the first, error in run()
    } else {
      positionals.push(tok);
    }
  }

  // Resolve the canonical command AND how many positional tokens it consumed; the
  // REST become args.positionals so a handler can read its `<id>` (e.g. rollback <id>).
  const { canonical, consumed } = canonicalize(positionals);
  args.positionals = positionals.slice(consumed);
  return { canonical, args, unknownFlag };
}

/**
 * Resolve the canonical command name from the positionals AND how many positional
 * tokens that command consumed (so the caller can slice the REST into
 * `args.positionals` — e.g. the `<id>` in `rollback <id>`). No first positional →
 * `{ canonical: null, consumed: 0 }`. Two-word commands collapse to one canonical
 * key (TWO tokens consumed):
 *   `config show-effective` → `config:show-effective` (consumed 2)
 *   `config diff`           → `config:diff`            (consumed 2)
 *   `snapshot list`         → `snapshot:list`          (consumed 2)
 *   `snapshot gc`           → `snapshot:gc`            (consumed 2)
 *   `snapshot pin`          → `snapshot:pin`           (consumed 2)
 *   `snapshot unpin`        → `snapshot:unpin`         (consumed 2)
 *   `mcp remove`            → `mcp:remove`             (consumed 2)
 * A bare `snapshot` (no sub-verb) stays `snapshot` (consumed 1, the create command).
 * Otherwise the first positional is the canonical name verbatim (consumed 1;
 * membership checked later).
 *
 * @param {string[]} positionals
 * @returns {{canonical: string|null, consumed: number}}
 */
function canonicalize(positionals) {
  const first = positionals[0];
  if (typeof first !== 'string' || first.length === 0) return { canonical: null, consumed: 0 };
  if (first === 'config' && positionals[1] === 'show-effective') return { canonical: 'config:show-effective', consumed: 2 };
  if (first === 'config' && positionals[1] === 'diff') return { canonical: 'config:diff', consumed: 2 };
  if (first === 'snapshot' && positionals[1] === 'list') return { canonical: 'snapshot:list', consumed: 2 };
  if (first === 'snapshot' && positionals[1] === 'gc') return { canonical: 'snapshot:gc', consumed: 2 };
  if (first === 'snapshot' && positionals[1] === 'pin') return { canonical: 'snapshot:pin', consumed: 2 };
  if (first === 'snapshot' && positionals[1] === 'unpin') return { canonical: 'snapshot:unpin', consumed: 2 };
  if (first === 'mcp' && positionals[1] === 'remove') return { canonical: 'mcp:remove', consumed: 2 };
  return { canonical: first, consumed: 1 };
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
  return `claude-mgr — read-mostly governance CLI\n\nusage: claude-mgr <command> [--config-dir <dir>] [--format table|json|quiet]\n\n  --active-probes  (doctor) run active checks that spawn external tools and let\n                   the loader probe briefly create + self-remove a temporary file\n                   in the real agents/ directory (gated, always cleaned up)\n\nread commands:\n  config diff <a> <b> [--context N]      unified line-diff of two files\n  completion bash|powershell             emit a shell tab-completion script\n\nwrite commands (DRY-RUN by default; require BOTH --apply AND the env var\nCLAUDE_MGR_ENABLE_WRITES=1 to touch governed config):\n  rollback <id> [--force] [--apply]\n  recover <id> [--mark-failed|--resume|--rollback|--from-manifest] [--force] [--apply]\n  lock [--break-lock --apply]\n  remove <kind>:<name> [--cascade [--force]] [--reason <msg>] [--apply]\n  update <plugin> [--lock-version <ver>] [--reason <msg>] [--apply]\n  mcp remove <name> [--scope local|user|project] [--reason <msg>] [--apply]\n\ncommands:\n${commandList()}`;
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

/** The known flag names (value + boolean), one indented line each. @returns {string} */
function flagList() {
  return [...VALUE_FLAGS, ...BOOLEAN_FLAGS].map((f) => `  ${f}`).join('\n');
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
