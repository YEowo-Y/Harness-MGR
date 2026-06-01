/**
 * Heuristic redaction of secret VALUES embedded in MCP `args` (the deferred half
 * of the #2 mcp-leak hardening).
 *
 * The `inventory --type mcp` / `--detail` paths already DROP a server's top-level
 * `url` + `envKeys` (see trimMcpServer in cli/commands.mjs) but KEEP `command` and
 * `args` verbatim — most args are benign (npx package names, paths, ports). Some
 * configs, however, embed a credential directly in argv, e.g.
 *   ["--api-key", "sk-xxx"]   ["--token=ghp_xxx"]   ["TOKEN=ghp_xxx"]
 *   ["https://h/x?token=xxx&mode=fast"]
 * This module redacts those VALUES to the literal marker `<redacted>` at the
 * DISPLAY boundary only — mcp.mjs's raw record is never touched.
 *
 * This was DEFERRED because of FALSE-POSITIVE risk, so the policy is deliberately
 * CONSERVATIVE: redact ONLY when there is a STRUCTURAL signal (an inline `name=`,
 * a separate sensitive flag followed by a value, or a URL query param). A bare
 * value with no structural signal (package name, path, port) is NEVER redacted.
 * When in doubt, do NOT redact — a false-DROP of a structurally-signalled secret
 * is acceptable; a false-redact of a benign arg is not.
 *
 * Name-sensitivity here uses a PRECISE token/segment match (`isSensitiveArgName`),
 * NOT plan.mjs's bare-substring `isSensitivePointer`: a CLI argv token like
 * `--keychain`, `--keyboard`, `keymap=…`, `monkey=…`, `--public-key`, `--key-id`
 * merely CONTAINS a sensitive substring and would be wrongly destroyed by the
 * substring test, breaking this unit's "NEVER redact a benign arg" contract. The
 * raw word list (`SENSITIVE_KEY_PATTERNS`) is still imported from lib/plan.mjs as
 * the SINGLE SOURCE — this module defines NO second word list, only a stricter
 * MATCHER over those words.
 *
 * Zero npm dependencies. Node stdlib only (via lib/plan.mjs). Pure; never throws.
 */

import { SENSITIVE_KEY_PATTERNS } from '../lib/plan.mjs';

/**
 * Sensitive name patterns that are AMBIGUOUS as a standalone segment: `key` and
 * `auth` frequently appear in benign compound names (public-key, key-id, oauth's
 * own segment is excluded by exact-match, authenticate, etc.). For these, a
 * benign qualifier segment vetoes sensitivity. Non-ambiguous words
 * (token/secret/password/credential) are always sensitive when present.
 * @type {ReadonlySet<string>}
 */
const AMBIGUOUS_PATTERNS = new Set(['key', 'auth']);

/**
 * Benign qualifier segments that, when co-occurring with ONLY ambiguous sensitive
 * segments, mark the whole name as NOT a secret: `public-key`, `pub-key`, `key-id`
 * (and `_` variants). Spares public/private-key material identifiers from being
 * mistaken for the secret value itself.
 * @type {ReadonlySet<string>}
 */
const BENIGN_QUALIFIERS = new Set(['public', 'pub', 'id']);

/** Split a name into segments on `-`, `_`, and `.`. */
const SEGMENT_SEP_RE = /[-_.]/;

/**
 * Precise replacement for plan.mjs's bare-substring `isSensitivePointer`, scoped
 * to CLI argv NAMES. Strips leading dashes, lowercases, splits on `[-_.]`, and
 * matches segments EXACTLY against SENSITIVE_KEY_PATTERNS — so `keychain`,
 * `keyboard`, `keymap`, `monkey`, `keyword`, `donkey`, `turkey`, `author`,
 * `authenticate`, `oauth` are NOT sensitive (no segment equals a pattern), while
 * `api-key`, `access-token`, `client-secret`, `auth-token`, a bare `--key`/`--auth`
 * ARE. The ambiguous patterns `key`/`auth` are vetoed when the ONLY sensitive
 * segments are ambiguous AND a benign qualifier (public/pub/id) co-occurs, sparing
 * `public-key`, `pub-key`, `key-id`. A non-ambiguous sensitive segment
 * (token/secret/password/credential) keeps the name sensitive regardless. Pure;
 * never throws.
 * @param {string} name
 * @returns {boolean}
 */
function isSensitiveArgName(name) {
  if (typeof name !== 'string' || name.length === 0) return false;
  const n = stripLeadingDashes(name).toLowerCase();
  const segments = n.split(SEGMENT_SEP_RE);
  const sensitive = segments.filter((s) => SENSITIVE_KEY_PATTERNS.includes(s));
  if (sensitive.length === 0) return false;
  // A non-ambiguous sensitive segment (token/secret/password/credential) wins.
  if (sensitive.some((s) => !AMBIGUOUS_PATTERNS.has(s))) return true;
  // Only ambiguous (key/auth) segments remain: a benign qualifier vetoes them.
  return !segments.some((s) => BENIGN_QUALIFIERS.has(s));
}

/** The literal marker a redacted arg value is replaced with. */
const MARKER = '<redacted>';

/**
 * The shape of a flag / env-var NAME on the left of an inline `name=VALUE`: only
 * leading dashes then word-ish characters (letters, digits, `_`, `.`, `-`). This
 * keeps rule (a) to genuine assignments (`--token=…`, `TOKEN=…`) and refuses to
 * treat an arbitrary string that merely CONTAINS `=` (e.g. a `file:` URL with a
 * query, `a/b=c`) as an assignment — avoiding a false-positive redaction.
 */
const INLINE_NAME_RE = /^-*[A-Za-z0-9_.-]+$/;

/**
 * Return a NEW args array with secret VALUES replaced by `<redacted>`. The input
 * is never mutated. A non-array input is returned unchanged; a non-string element
 * passes through untouched (only strings can carry a structural signal). Pure;
 * never throws.
 *
 * Three structural-signal rules are applied per element:
 *   (a) inline `name=VALUE`     — `--token=ghp_xxx`, `TOKEN=xxx`
 *   (b) separate flag + value   — `["--api-key", "sk-xxx"]`
 *   (c) URL with a query string — `"https://h/x?token=xxx&mode=fast"`
 * A bare value with no signal is returned as-is.
 *
 * @param {unknown} args
 * @returns {unknown}
 */
export function redactMcpArgs(args) {
  if (!Array.isArray(args)) return args;
  /** @type {unknown[]} */
  const out = new Array(args.length);
  for (let i = 0; i < args.length; i += 1) {
    out[i] = args[i];
  }
  for (let i = 0; i < out.length; i += 1) {
    const arg = out[i];
    if (typeof arg !== 'string') continue;

    // (a) inline `name=VALUE` — redact the value when the name is sensitive.
    const inline = redactInline(arg);
    if (inline !== null) { out[i] = inline; continue; }

    // (c) URL with a query string — redact only sensitive query-param values.
    const url = redactUrlArg(arg);
    if (url !== null) { out[i] = url; continue; }

    // (b) separate sensitive flag followed by a value arg — redact the NEXT arg.
    if (isSensitiveFlag(arg) && isValueArg(out[i + 1])) {
      out[i + 1] = MARKER;
    }
  }
  return out;
}

/**
 * Rule (a): if `arg` is `name=VALUE` and `name` (with leading dashes stripped) is
 * sensitive, return `name=<redacted>` (everything after the FIRST `=` replaced).
 * A non-sensitive name (`--mode=fast`, `PORT=8080`) or an arg without `=` returns
 * null (no inline match — fall through to the other rules). Never throws.
 * @param {string} arg
 * @returns {string|null}
 */
function redactInline(arg) {
  const eq = arg.indexOf('=');
  if (eq <= 0) return null; // no `=`, or leading `=` (no name)
  const rawName = arg.slice(0, eq);
  if (!INLINE_NAME_RE.test(rawName)) return null; // not an assignment-shaped name
  if (!isSensitiveArgName(rawName)) return null;
  return `${rawName}=${MARKER}`;
}

/**
 * Rule (c): if `arg` parses as an http/https URL with a query string, return a
 * copy whose sensitive query-param VALUES are `<redacted>` (non-sensitive params
 * and the rest of the URL are preserved). Returns null when `arg` is not such a
 * URL or has no query (so the other rules / pass-through apply). Tolerant parse —
 * never throws.
 * @param {string} arg
 * @returns {string|null}
 */
function redactUrlArg(arg) {
  let url;
  try { url = new URL(arg); } catch { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.search === '') return null;
  let changed = false;
  for (const name of [...url.searchParams.keys()]) {
    if (isSensitiveArgName(name)) {
      url.searchParams.set(name, MARKER);
      changed = true;
    }
  }
  return changed ? url.toString() : null;
}

/**
 * True when `arg` is a flag (`-x`/`--x`) whose name (leading dashes stripped) is
 * sensitive — the rule (b) trigger for redacting the FOLLOWING value arg.
 * @param {string} arg
 * @returns {boolean}
 */
function isSensitiveFlag(arg) {
  if (arg.length === 0 || arg[0] !== '-') return false;
  return isSensitiveArgName(arg);
}

/**
 * True when `next` is a VALUE arg (a present string that does NOT start with `-`),
 * i.e. the value a sensitive flag consumes. A following flag (`-x`) or an absent
 * arg means the value is inline or missing → rule (b) redacts nothing.
 * @param {unknown} next
 * @returns {boolean}
 */
function isValueArg(next) {
  return typeof next === 'string' && next.length > 0 && next[0] !== '-';
}

/**
 * Strip leading `-` characters from a flag/name so `--api-key` and `api-key` both
 * test as the sensitive name `api-key`.
 * @param {string} s
 * @returns {string}
 */
function stripLeadingDashes(s) {
  let i = 0;
  while (i < s.length && s[i] === '-') i += 1;
  return s.slice(i);
}
