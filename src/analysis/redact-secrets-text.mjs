/**
 * Output secret-shape redaction for command strings and config VALUES (audit 2026-06-02, P1).
 *
 * The read commands surface raw STRINGS a settings author may have stuffed a
 * credential into: a hook `command` ("curl -H 'Authorization: Bearer <tok>'"), the
 * statusLine `command` ("statusline.mjs --token=<tok>"), or a value under a benign
 * key name ("myDatabaseUrl": "postgres://user:pass@host"). These flow verbatim to
 * `inventory` / `hooks` / `config show-effective` json+ndjson — i.e. straight onto
 * the TUI/Web UI display surface. The existing redact-effective.mjs only redacts by
 * KEY NAME, so a secret inside a command string or under a non-sensitive key escaped.
 *
 * This module redacts secret SUBSTRINGS *within* a string (it does NOT replace the
 * whole value), so the command/URL stays readable while the secret is gone —
 * mirroring redact-mcp-args.mjs's "surgical, never destroy a benign arg" policy.
 *
 * DELIBERATELY HIGH-CONFIDENCE ONLY (low false-positive): self-identifying token
 * shapes (single-sourced from secrets-content-sniff.mjs), PEM blocks, URL userinfo,
 * the Bearer/Basic auth scheme, and an inline sensitive `name=VALUE` (sensitivity via
 * redact-mcp-args.mjs's isSensitiveArgName, which vetoes ambiguous public-key/key-id).
 * The high-ENTROPY heuristic is INTENTIONALLY NOT used here — it false-positives on
 * arbitrary command lines / paths / base64 args; a bare no-prefix secret is the
 * accepted residual (the same documented gap as secrets-content-sniff). A lone PEM
 * BEGIN header with no END leaves its body unredacted (an accepted edge residual).
 * A bare `key=`/`auth=` in a command string IS redacted by design (consistent with
 * redact-mcp-args' isSensitiveArgName) — a display-only over-redaction accepted under
 * the recall>precision policy. Scanning is capped at INPUT_CAP bytes; a larger string
 * is returned unchanged to bound cost (the same >64 KiB residual as secrets-content-sniff).
 *
 * Zero npm dependencies. Node stdlib only (via plan.mjs / secrets-content-sniff /
 * redact-mcp-args). Pure; never throws; never mutates its input.
 */

import { PEM_RE, TOKEN_PATTERNS } from '../lib/secrets-content-sniff.mjs';
import { isSensitiveArgName } from './redact-mcp-args.mjs';

/** The literal marker a redacted secret substring is replaced with (matches redact-mcp-args). */
const MARKER = '<redacted>';

/** Cap scanning to the first 64 KiB; a larger string is returned unchanged (bounded cost on untrusted input). */
const INPUT_CAP = 64 * 1024;

/** Self-identifying token shapes, single-sourced from the sniffer, as GLOBAL regexes for replace(). */
const TOKEN_GLOBAL_RES = TOKEN_PATTERNS.map(({ re }) => new RegExp(re.source, 'g'));

/** A full PEM block (BEGIN…END), single- or multi-line. */
const PEM_BLOCK_RE = /-----BEGIN [A-Z0-9 ]+-----[\s\S]*?-----END [A-Z0-9 ]+-----/g;

/** A lone PEM BEGIN header — single-sources the shape from the sniffer's PEM_RE. */
const PEM_HEADER_RE = new RegExp(PEM_RE.source, 'g');

/**
 * scheme://USERINFO@ — credentials in a URL authority. `[^/\s]+` stays within the
 * authority (cannot cross the first `/`) and is greedy to the LAST `@`, so a raw `@`
 * in a password (user:p@ss@host) still redacts to scheme://<redacted>@host. A URL
 * with no userinfo (no `@` in the authority) does not match. The scheme run is
 * length-BOUNDED ({0,40} — real schemes are short) so each start-offset retry is
 * O(40) not O(n), keeping the scan linear on long input (no O(n^2) backtracking).
 */
const URL_USERINFO_RE = /([a-z][a-z0-9+.-]{0,40}:\/\/)[^/\s]+@/gi;

/** Bearer/Basic Authorization scheme + a token (≥16 token chars so prose words don't match); case-insensitive, original scheme casing preserved. */
const BEARER_RE = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/gi;

/** Inline `name=VALUE`; the value stops at whitespace / quote / `&` (a URL-query sibling). */
const NAME_VALUE_RE = /(?<![\w.-])(-{0,2}[A-Za-z0-9_.-]+)=([^\s'"&]+)/g;

/**
 * Redact high-confidence secret SUBSTRINGS within a single string, leaving the
 * surrounding text intact. Returns the input unchanged when it is not a non-empty
 * string, exceeds INPUT_CAP (bounded cost), or contains no recognised secret shape.
 * The URL scheme run is length-bounded so matching stays linear. Pure; never throws.
 * @param {unknown} str
 * @returns {unknown}   the redacted string, or the input unchanged
 */
export function redactSecretsInString(str) {
  if (typeof str !== 'string' || str.length === 0) return str;
  if (str.length > INPUT_CAP) return str; // bound cost on a pathological value; realistic secrets are << 64 KiB
  let s = str;
  s = s.replace(PEM_BLOCK_RE, MARKER);
  s = s.replace(PEM_HEADER_RE, MARKER);
  for (const re of TOKEN_GLOBAL_RES) s = s.replace(re, MARKER);
  s = s.replace(URL_USERINFO_RE, (_m, scheme) => `${scheme}${MARKER}@`);
  s = s.replace(BEARER_RE, (_m, scheme) => `${scheme} ${MARKER}`);
  s = s.replace(NAME_VALUE_RE, (m, name) => (isSensitiveArgName(name) ? `${name}=${MARKER}` : m));
  return s;
}

/**
 * Recursively copy a value, applying redactSecretsInString to every STRING leaf so
 * a nested command/value is redacted regardless of its key name. Arrays are mapped;
 * plain objects are rebuilt with proto-poisoning keys skipped; non-string primitives
 * (incl. null) pass through. The input is NOT mutated. Pure; never throws.
 * @param {unknown} value
 * @returns {unknown}   a fresh redacted copy
 */
export function redactSecretsDeep(value) {
  if (typeof value === 'string') return redactSecretsInString(value);
  if (Array.isArray(value)) return value.map((item) => redactSecretsDeep(item));
  if (value === null || typeof value !== 'object') return value;
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const key of Object.keys(value)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    out[key] = redactSecretsDeep(/** @type {Record<string, unknown>} */ (value)[key]);
  }
  return out;
}
