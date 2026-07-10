/**
 * Hand-rolled, zero-dep argv parser for the CLI shell (extracted from cli.mjs to
 * keep that module under the SLOC ceiling; parseArgs + its private helpers
 * canonicalize/flagKey are one coherent unit). Pure and never-throws.
 *
 * The first positional is the subcommand; two-word commands collapse to one
 * canonical key. Value flags consume the next token; boolean flags are
 * presence-only. STRICT policy: an unrecognized flag (`--typo` or a single-dash
 * `-f`) and a value flag left without a real value are NOT silently dropped — they
 * are captured and run() turns them into a hard exit-2 usage error, so a typo can
 * never leave configDir unset and misdirect a write to the real ~/.claude.
 *
 * Zero npm dependencies. Imports only the flag vocabulary (cli/flags.mjs).
 */

import { VALUE_FLAGS, BOOLEAN_FLAGS } from './flags.mjs';

/**
 * Parse argv into a canonical command + an `args` bag, surfacing the first
 * unrecognized flag and the first value-less flag for the caller to reject.
 *
 * @param {string[]} argv
 * @returns {{canonical: string|null, args: {format?:string, configDir?:string, name?:string, key?:string, type?:string, from?:string, explain?:boolean, detail?:boolean, positionals?:string[]}, unknownFlag: string|null, missingValueFlag: string|null}}
 */
export function parseArgs(argv) {
  const args = Object.create(null); // null-proto: a `--constructor`-style flag can never reach a prototype key
  /** @type {string[]} */
  const positionals = [];
  /** @type {string|null} the first unrecognized flag (drives the exit-2 usage error) */
  let unknownFlag = null;
  /** @type {string|null} the first value flag left without a real value (exit-2 in run()) */
  let missingValueFlag = null;

  for (let i = 0; i < (Array.isArray(argv) ? argv.length : 0); i += 1) {
    const tok = argv[i];
    if (typeof tok !== 'string') continue;
    if (VALUE_FLAGS.includes(tok)) {
      const val = argv[i + 1];
      // A value flag MUST be followed by a real value. A missing (end-of-argv),
      // flag-like ('--'-prefixed), or empty/whitespace token is NOT a value: flag it
      // as a usage error instead of silently assigning undefined/''. For --config-dir
      // that silent assignment misdirected a gated write to the real ~/.claude (the
      // exact hole the strict-flag policy exists to close). Do NOT consume the token,
      // so a following boolean flag (`--config-dir --apply`) is still parsed, not eaten.
      if (typeof val !== 'string' || val.startsWith('--') || val.trim() === '') {
        if (missingValueFlag === null) missingValueFlag = tok;
      } else {
        args[flagKey(tok)] = val;
        i += 1; // consume the value token
      }
    } else if (BOOLEAN_FLAGS.includes(tok)) {
      args[flagKey(tok)] = true;
    } else if (tok !== '-' && tok.startsWith('-')) {
      // Any other dash-led token is an unrecognized flag — a '--typo' OR a single-dash
      // token (`-f`); the vocabulary is '--'-only, so neither may be silently dropped
      // into positionals (which would discard the intended behavior with no diagnostic).
      // A lone '-' (stdin convention) stays a positional.
      if (unknownFlag === null) unknownFlag = tok; // strict: capture the first, error in run()
    } else {
      positionals.push(tok);
    }
  }

  // Resolve the canonical command AND how many positional tokens it consumed; the
  // REST become args.positionals so a handler can read its `<id>` (e.g. rollback <id>).
  const { canonical, consumed } = canonicalize(positionals);
  args.positionals = positionals.slice(consumed);
  return { canonical, args, unknownFlag, missingValueFlag };
}

/**
 * Resolve the canonical command name from the positionals AND how many positional
 * tokens that command consumed (so the caller can slice the REST into
 * `args.positionals` — e.g. the `<id>` in `rollback <id>`). No first positional →
 * `{ canonical: null, consumed: 0 }`. Two-word commands collapse to one canonical
 * key (TWO tokens consumed): `config show-effective`, `config diff`, `snapshot
 * list|gc|pin|unpin`, `mcp remove`, `skill propose|accept|visibility`. A bare
 * `snapshot` (no sub-verb) stays `snapshot` (the create command). Otherwise the
 * first positional is the canonical name verbatim (membership checked later).
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
  if (first === 'skill' && positionals[1] === 'propose') return { canonical: 'skill:propose', consumed: 2 };
  if (first === 'skill' && positionals[1] === 'accept') return { canonical: 'skill:accept', consumed: 2 };
  if (first === 'skill' && positionals[1] === 'visibility') return { canonical: 'skill:visibility', consumed: 2 };
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
