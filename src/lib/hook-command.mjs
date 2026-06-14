/**
 * Pure parser/classifier for Claude Code hook command strings (P2.U5b-2).
 *
 * Claude Code hook commands are shell strings like:
 *   `node "$HOME/.claude/hooks/foo.mjs"`
 *   `any-buddy apply --silent`
 *
 * The doctor needs to know WHICH thing to verify for each command:
 *   - 'file'     → a script path that must exist on disk
 *   - 'external' → a bare executable name that must be on PATH
 *
 * This module handles the PURE parsing/classification only — string in,
 * classification out. No filesystem or PATH access; those are handled by
 * the discovery probe (src/discovery/probe-hooks.mjs). This separation keeps
 * the doctor analysis layer side-effect-free, deterministic, and time-injectable.
 *
 * Key design decisions:
 *   - tokenizeCommand: quote-aware split; no backslash-escape needed (hook
 *     commands in the wild use $VAR or "$VAR" but not \\-escapes).
 *   - expandVars: HOME fallback uses env.HOME ?? env.USERPROFILE so the module
 *     works on Windows where HOME is often absent but USERPROFILE is set.
 *   - classifyHookCommand: eval flags (-e, -m, etc.) make the arg non-checkable;
 *     return null rather than risk a false "file missing" diagnostic.
 *   - npx is deliberately NOT in INTERPRETERS — its first arg is a package name
 *     that should be treated as an external command, not a file.
 *
 * Zero npm dependencies; node:path (isAbsolute) only. Never throws.
 */

import { isAbsolute } from 'node:path';

// ── tokenizeCommand ──────────────────────────────────────────────────────────

/**
 * Decide whether character `ch` at position `i` in `str` is inside a quoted
 * region, and advance the quote state. Returns the updated quote character or ''.
 *
 * This helper is intentionally NOT exported — it is an internal state-machine
 * step used only by tokenizeCommand.
 *
 * @param {string} ch current character
 * @param {string} quote current active quote ('' | '"' | "'")
 * @returns {string} new quote state
 */
function nextQuote(ch, quote) {
  if (quote === '') {
    if (ch === '"' || ch === "'") return ch;
  } else if (ch === quote) {
    return '';
  }
  return quote;
}

/**
 * Quote-aware split of a shell-style command line into an array of tokens.
 *
 * Rules:
 *   - Unquoted whitespace separates tokens.
 *   - `"..."` and `'...'` keep their contents as one token (quotes stripped).
 *   - A quote may appear mid-token: `--opt="a b"` → `'--opt=a b'`.
 *   - No backslash-escape handling — Claude Code hook commands do not use them.
 *   - Non-string or empty input → `[]`.
 *
 * Examples:
 *   tokenizeCommand('node "$HOME/x.mjs"')       → ['node', '$HOME/x.mjs']
 *   tokenizeCommand('any-buddy apply --silent')  → ['any-buddy', 'apply', '--silent']
 *   tokenizeCommand("'a b' c")                  → ['a b', 'c']
 *
 * @param {string} str raw hook command line
 * @returns {string[]}
 */
export function tokenizeCommand(str) {
  if (typeof str !== 'string' || str.length === 0) return [];

  /** @type {string[]} */
  const tokens = [];
  let token = '';
  let quote = '';

  for (const ch of str) {
    const newQuote = nextQuote(ch, quote);
    if (newQuote !== quote) {
      // Quote boundary: opening or closing a quoted region — consume the quote
      // character itself (strip it) without adding it to the token.
      quote = newQuote;
      continue;
    }
    if (quote === '' && (ch === ' ' || ch === '\t')) {
      if (token.length > 0) { tokens.push(token); token = ''; }
      continue;
    }
    token += ch;
  }
  if (token.length > 0) tokens.push(token);
  return tokens;
}

// ── expandVars ───────────────────────────────────────────────────────────────

/**
 * Single combined matcher for `${VAR}`, `${VAR:-default}`, `${VAR-default}`,
 * `$VAR`, and `%VAR%`. Matching all forms in ONE pass means substituted text
 * is never re-scanned (an env value containing `$X` stays literal).
 *
 * Capture groups (1-indexed):
 *   1  braceName  — VAR name in the `${...}` brace form
 *   2  colonFlag  — ':' when operator is `:-`, '' when operator is `-`, undefined for plain `${VAR}`
 *   3  braceDefault — the default body (everything up to `}`) when an operator is present
 *   4  dollarName — VAR name in the bare `$VAR` form
 *   5  percentName — VAR name in the `%VAR%` Windows form
 *
 * Note: `[^}]*` for the default body stops at the FIRST `}`. A default body
 * that itself contains `}` is unsupported (not needed for real hook paths).
 * The default body IS expanded once recursively (so `${X:-$HOME/.claude}` works
 * when HOME is set). Env VALUES are never re-scanned (single-pass invariant
 * is preserved — only the config-author-written default literal is expanded).
 */
const VAR_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?)-([^}]*))?\}|\$([A-Za-z_][A-Za-z0-9_]*)|%([A-Za-z_][A-Za-z0-9_]*)%/g;

/**
 * Maximum string length allowed through the regex engine. Strings longer than
 * this cap are returned as-is with fullyExpanded:false. Mirrors the precedent in
 * probe-cli.mjs (4096 chars) but uses a wider 8192-char budget since hook command
 * strings are slightly longer. Real commands are <300 chars.
 * This also bounds the cost of the one-level recursive default expansion.
 */
const EXPAND_VARS_MAX_LEN = 8192;

/**
 * Resolve the home directory from an env object, applying the Windows fallback.
 * Returns the HOME value, or USERPROFILE if HOME is absent, or null if neither.
 *
 * @param {Record<string, string|undefined>} env
 * @returns {string|null}
 */
function homeDir(env) {
  if (typeof env.HOME === 'string') return env.HOME;
  if (typeof env.USERPROFILE === 'string') return env.USERPROFILE;
  return null;
}

/**
 * Look up a variable name in env, applying the HOME/USERPROFILE fallback when
 * the name is `HOME`. Returns the string value or null when unresolvable.
 *
 * @param {string} name variable name
 * @param {Record<string, string|undefined>} env
 * @returns {string|null}
 */
function resolveVar(name, env) {
  if (name === 'HOME') return homeDir(env);
  const v = env[name];
  return typeof v === 'string' ? v : null;
}

/**
 * Replace all recognised `$VAR`, `${VAR}`, and `%VAR%` occurrences in `str`
 * using values from `env`. A leading `~` (followed by `/`, `\`, or end-of-string)
 * is also expanded to the home directory.
 *
 * When a referenced variable has no string value in `env`, that occurrence is
 * LEFT UNTOUCHED and `fullyExpanded` is set to false. A `$` or `%` that is NOT
 * a valid variable reference is left as-is and does NOT affect `fullyExpanded`.
 *
 * @param {string} str input string (may contain variable references)
 * @param {Record<string, string|undefined>} [env] defaults to `process.env`
 * @returns {{ value: string, fullyExpanded: boolean }}
 */
export function expandVars(str, env) {
  if (typeof str !== 'string') return { value: '', fullyExpanded: false };
  // Length guard: prevent O(n²) ReDoS on pathologically long/malformed input.
  // Mirrors probe-cli.mjs:85-87. Real hook commands are <300 chars.
  if (str.length > EXPAND_VARS_MAX_LEN) return { value: str, fullyExpanded: false };

  const e = (env && typeof env === 'object') ? env : process.env;
  let fullyExpanded = true;
  let value = str;

  // 1. Leading `~` → home (only at index 0, before `/`, `\`, or end).
  if (value.length > 0 && value[0] === '~') {
    const next = value[1];
    if (next === '/' || next === '\\' || next === undefined) {
      const h = homeDir(e);
      if (h !== null) {
        value = h + value.slice(1);
      } else {
        fullyExpanded = false;
      }
    }
  }

  // 2. Single pass over ${VAR} / ${VAR:-default} / ${VAR-default} / $VAR / %VAR%
  //    — matching all forms at once means substituted text is never re-scanned
  //    (an env value containing "$X" stays literal rather than cascading).
  //
  //    Callback groups match VAR_RE group numbering (see const comment above):
  //      braceName    (g1) — VAR name inside ${...}
  //      colonFlag    (g2) — ':' for `:-`, '' for `-`, undefined for plain ${VAR}
  //      braceDefault (g3) — default body when an operator is present
  //      dollarName   (g4) — VAR name in bare $VAR form
  //      percentName  (g5) — VAR name in %VAR% form
  value = value.replace(VAR_RE, (m, braceName, colonFlag, braceDefault, dollarName, percentName) => {
    if (braceName !== undefined && braceDefault !== undefined) {
      // ${VAR:-default} or ${VAR-default}: operator form.
      const resolved = resolveVar(braceName, e);
      const useDefault = colonFlag === ':'
        ? (resolved === null || resolved === '') // `:-`: unset OR empty
        : resolved === null;                     // `-`:  unset only
      if (!useDefault) return resolved;
      // Default is selected: expand it once (so `${X:-$HOME/y}` resolves HOME).
      // This does NOT violate the "never re-scan env values" invariant — we are
      // expanding the config-author-written default literal, not an env value.
      // Nested `${...}` in a default body are unsupported ([^}]* stops at first }).
      const sub = expandVars(braceDefault, e);
      if (!sub.fullyExpanded) fullyExpanded = false;
      return sub.value;
    }
    // Plain ${VAR}, $VAR, or %VAR%: unresolved → leave literal + mark incomplete.
    const resolved = resolveVar(braceName ?? dollarName ?? percentName, e);
    if (resolved === null) { fullyExpanded = false; return m; }
    return resolved;
  });

  return { value, fullyExpanded };
}

// ── classifyHookCommand ──────────────────────────────────────────────────────

/**
 * The set of interpreter executable names (lowercased, .exe-stripped) that
 * take a SCRIPT FILE as their first non-flag argument. npx is intentionally
 * absent — its first arg is a package name, not a checkable file.
 */
const INTERPRETERS = new Set([
  'node', 'python', 'python3', 'py',
  'pwsh', 'powershell',
  'bash', 'sh',
  'deno', 'bun',
  'ruby', 'perl',
  'tsx', 'ts-node',
]);

/**
 * Flags that indicate the NEXT argument is inline code or a module name, NOT
 * a file path. When any of these appear, return null to avoid false diagnostics.
 */
const EVAL_FLAGS = new Set(['-e', '--eval', '-c', '--command', '-p', '--print', '-m', '--module']);

/**
 * Per-interpreter argument grammar (P6.U4). Only interpreters whose script
 * argument is NOT simply "the first non-flag token" need an entry; everything
 * else (node/python/bash/…) uses the generic rule and has no grammar.
 *
 * PowerShell is the case that matters for the Codex harness: its real hook
 * command is `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "<script>"`.
 * The generic rule would skip `-ExecutionPolicy` as a flag and then return its
 * VALUE `Bypass` as the script (a false "file missing"). PowerShell instead names
 * its script with `-File <path>` and takes several VALUE flags whose argument is
 * data, not a script. The three sets disambiguate it (all compared lowercased):
 *   scriptFlags : the NEXT token after this flag IS the script path.
 *   inlineFlags : inline code / no checkable script → classify as null (joins the
 *                 global EVAL_FLAGS; PowerShell uses single-dash `-Command` etc.).
 *   valueFlags  : this flag CONSUMES the next token as a value (skip the pair).
 * Known limitation: arbitrary PowerShell prefix abbreviations (e.g. `-exec` for
 * `-ExecutionPolicy`) are NOT modeled — only the documented forms + common short
 * aliases. The omx-generated Codex hooks use the full `-ExecutionPolicy -File`.
 */
const POWERSHELL_GRAMMAR = Object.freeze({
  scriptFlags: new Set(['-file']),
  inlineFlags: new Set(['-command', '-encodedcommand', '-ec']),
  valueFlags: new Set([
    '-executionpolicy', '-ep', '-windowstyle', '-version', '-configurationname',
    '-inputformat', '-outputformat', '-psconsolefile', '-settingsfile',
    '-workingdirectory', '-wd', '-custompipename',
  ]),
});

/**
 * Resolve the argument grammar for an interpreter name (interpreterName output),
 * or undefined when the interpreter uses the generic first-non-flag-token rule.
 * `pwsh` is an alias of `powershell`. Proto-safe (no inherited-key lookup).
 * @param {string} name canonical interpreter name (lowercased, .exe-stripped)
 * @returns {{scriptFlags: Set<string>, inlineFlags: Set<string>, valueFlags: Set<string>}|undefined}
 */
function grammarFor(name) {
  return (name === 'powershell' || name === 'pwsh') ? POWERSHELL_GRAMMAR : undefined;
}

/**
 * Decide whether an expanded executable token is "path-like": an absolute path,
 * or a relative/bare path containing a directory separator, or a `./` / `../`
 * relative reference (starts with `.`).
 *
 * @param {string} exe expanded executable string
 * @returns {boolean}
 */
function isPathLike(exe) {
  return isAbsolute(exe) || exe.includes('/') || exe.includes('\\') || exe.startsWith('.');
}

/**
 * Normalise an executable token to the canonical interpreter key used in
 * INTERPRETERS: lowercase the basename, strip a trailing `.exe` if present.
 *
 * @param {string} exe expanded executable token (bare name — no separators)
 * @returns {string}
 */
function interpreterName(exe) {
  let name = exe.toLowerCase();
  if (name.endsWith('.exe')) name = name.slice(0, -4);
  return name;
}

/**
 * Walk `args` to find the script-path token after the interpreter name. Returns
 * the raw token string, or null when none is found or an inline-code flag is hit.
 *
 * The generic rule (no grammar): an eval/inline flag → null; any other `-flag`
 * is skipped; the FIRST non-flag token is the script. An interpreter `grammar`
 * (PowerShell) refines this: a scriptFlag's NEXT token IS the script (`-File x`);
 * an inlineFlag → null; a valueFlag CONSUMES its next token (so `-ExecutionPolicy
 * Bypass` no longer leaks `Bypass` as the script — the P6.U4 Codex fix). When
 * `grammar` is undefined every grammar branch short-circuits, so behavior is
 * byte-identical to the pre-U4 generic rule for node/python/bash/etc.
 *
 * NOTE (residual limitation): a value-taking flag NOT in any grammar (e.g. node's
 * `--require esm`) is still skipped as a bare flag, so its value could be misread
 * as the script. Add it to the relevant interpreter grammar if it ever surfaces.
 *
 * @param {string[]} args remaining tokens after the interpreter (tokens[1..])
 * @param {{scriptFlags: Set<string>, inlineFlags: Set<string>, valueFlags: Set<string>}|undefined} [grammar]
 * @returns {string|null}
 */
function findScriptArg(args, grammar) {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const low = arg.toLowerCase();
    // Inline code / eval flag → the next token is code, not a checkable file.
    if (EVAL_FLAGS.has(low) || (grammar && grammar.inlineFlags.has(low))) return null;
    // Explicit script-path flag (e.g. PowerShell -File): the NEXT token is the script.
    if (grammar && grammar.scriptFlags.has(low)) {
      const next = args[i + 1];
      return typeof next === 'string' ? next : null; // a dangling -File → no false file
    }
    // Value-taking flag (e.g. -ExecutionPolicy Bypass): skip the flag AND its value
    // so the value is never mistaken for the script.
    if (grammar && grammar.valueFlags.has(low)) { i += 1; continue; }
    if (arg.startsWith('-')) continue;                  // other (boolean) flag
    return arg;                                          // first non-flag token
  }
  return null;
}

/**
 * Classify a single Claude Code hook command string.
 *
 * Algorithm:
 *   1. Tokenize the command line.
 *   2. Expand the first token (exe) with variable substitution.
 *   3. If exe is path-like → kind:'file' (direct script/executable).
 *   4. Else if exe is a known interpreter → find the script arg and expand it
 *      → kind:'file'. An eval flag or missing script arg → null.
 *   5. Otherwise → kind:'external' (bare command to find on PATH).
 *
 * Returns null for empty/non-string commands, or when classification is
 * impossible without risking a false "missing file" diagnostic.
 *
 * @param {string} command raw hook command string
 * @param {Record<string, string|undefined>} [env] defaults to `process.env`
 * @returns {{ kind: 'file'|'external', target: string, fullyExpanded: boolean }|null}
 */
export function classifyHookCommand(command, env) {
  const tokens = tokenizeCommand(command);
  if (tokens.length === 0) return null;

  const e = (env && typeof env === 'object') ? env : process.env;

  const { value: exe, fullyExpanded: exeExp } = expandVars(tokens[0], e);

  // Path-like exe: direct invocation of an absolute or relative script.
  if (isPathLike(exe)) {
    return { kind: 'file', target: exe, fullyExpanded: exeExp };
  }

  // Bare name: test against known interpreters.
  const name = interpreterName(exe);

  if (INTERPRETERS.has(name)) {
    const scriptToken = findScriptArg(tokens.slice(1), grammarFor(name));
    if (scriptToken === null) return null; // eval flag or no script arg
    const { value: scriptPath, fullyExpanded: scriptExp } = expandVars(scriptToken, e);
    return { kind: 'file', target: scriptPath, fullyExpanded: scriptExp };
  }

  // Not an interpreter → external command (e.g. npx, any-buddy).
  return { kind: 'external', target: exe, fullyExpanded: exeExp };
}
