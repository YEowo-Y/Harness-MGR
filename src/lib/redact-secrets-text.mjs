/**
 * Pure output redaction for secret-shaped string content and line-oriented diffs.
 *
 * Generic string/deep redaction stays high-confidence and bounded at 64 KiB. The
 * diff-specific line wrapper is stricter: an oversized physical line fails closed,
 * complete PEM blocks are masked line-for-line, and common JSON/YAML/TOML sensitive
 * keyed values are hidden. It preserves physical newline sequences and line count.
 */

import { PEM_RE, TOKEN_PATTERNS } from './secrets-content-sniff.mjs';
import { isSensitiveConfigKey } from './sensitive-name.mjs';

const MARKER = '<redacted>';
const INPUT_CAP = 64 * 1024;
const TOKEN_GLOBAL_RES = TOKEN_PATTERNS.map(({ re }) => new RegExp(re.source, 'g'));
const PEM_BLOCK_RE = /-----BEGIN [A-Z0-9 ]+-----[\s\S]*?-----END [A-Z0-9 ]+-----/g;
const PEM_HEADER_RE = new RegExp(PEM_RE.source, 'g');
const PEM_BEGIN_RE = /-----BEGIN ([A-Z0-9 ]+)-----/;
const URL_USERINFO_RE = /([a-z][a-z0-9+.-]{0,40}:\/\/)[^/\s]+@/gi;
const BEARER_RE = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/gi;
const NAME_VALUE_RE = /(?<![\w.-])(-{0,2}[A-Za-z0-9_.-]+)=("(?:\\.|[^"\\])*"[^\s&]*|'(?:\\.|[^'\\])*'[^\s&]*|[^\s&]+)/g;
const NAME_VALUE_START_RE = /(?<![\w.-])(-{0,2}[A-Za-z0-9_.-]+)=/g;
const ESCAPED_NAME_VALUE_RE = /(?<![\w.-])(-{0,2}[A-Za-z0-9_.-]+)=\\["']/g;
const JSON_VALUE_RE = /("((?:\\.|[^"\\])*)"\s*:\s*)("(?:\\.|[^"\\])*"|[^,}\]\r\n\[{]+)/g;
const ROOT_ASSIGNMENT_RE = /^(\s*(?:-\s+)?)(["']?)([A-Za-z0-9_.-]+)\2(\s*[:=]\s*)(.*)$/;
const ROOT_ASSIGNMENT_HINT_RE = /^\s*(?:-\s+)?["']?[A-Za-z0-9_.-]+["']?(?:\s*:|\s+=|=\s*["'])/;
const NEWLINE_RE = /(\r\n|\n|\r)/;

/** Redact a quoted value while keeping the quote pair, or replace a plain value. */
function redactedValue(value) {
  if (value.length >= 4 && value[0] === '\\'
    && (value[1] === '"' || value[1] === "'")
    && value[value.length - 2] === '\\' && value[value.length - 1] === value[1]) {
    return `${value.slice(0, 2)}${MARKER}${value.slice(-2)}`;
  }
  if (value.length >= 2) {
    const first = value[0];
    if ((first === '"' || first === "'") && value[value.length - 1] === first) {
      return `${first}${MARKER}${first}`;
    }
  }
  return MARKER;
}

/** A shell word with an uncertain same-line boundary must fail closed. */
function hasAmbiguousSensitiveAssignment(str) {
  NAME_VALUE_START_RE.lastIndex = 0;
  let match;
  while ((match = NAME_VALUE_START_RE.exec(str)) !== null) {
    if (!isSensitiveConfigKey(match[1])) continue;
    const valueStart = NAME_VALUE_START_RE.lastIndex;
    let quote = '';
    let quoteStart = -1;
    let escaped = false;
    let wordEnd = str.length;
    for (let i = valueStart; i < str.length; i += 1) {
      const char = str[i];
      if (escaped) {
        if (/\s/.test(char)) return true;
        escaped = false;
      } else if (char === '\\' && quote !== "'") escaped = true;
      else if (quote) {
        if (char === quote) quote = '';
        else if (/\s/.test(char) && quoteStart !== valueStart) return true;
      } else if (char === '"' || char === "'") {
        quote = char;
        quoteStart = i;
      } else if (char === '&' || /\s/.test(char)) {
        wordEnd = i;
        break;
      }
    }
    if (quote || escaped) return true;
    NAME_VALUE_START_RE.lastIndex = wordEnd;
  }
  return false;
}

function decodedJsonKey(key) {
  try { return JSON.parse(`"${key}"`); } catch { return key; }
}

/** Detect sensitive keys below a complete JSON document's root object. */
function hasNestedSensitiveJsonKey(line) {
  const first = line.trimStart()[0];
  if (first !== '{' && first !== '[') return false;
  try {
    const stack = [{ value: JSON.parse(line), depth: 0 }];
    while (stack.length > 0) {
      const { value, depth } = stack.pop();
      if (value === null || typeof value !== 'object') continue;
      if (Array.isArray(value)) {
        for (const item of value) stack.push({ value: item, depth: depth + 1 });
      } else {
        for (const key of Object.keys(value)) {
          if (depth > 0 && isSensitiveConfigKey(key)) return true;
          stack.push({ value: value[key], depth: depth + 1 });
        }
      }
    }
  } catch { return false; }
  return false;
}

/** Detect a sensitive JSON key whose value is a same-line object or array. */
function hasSensitiveJsonContainer(line) {
  let cursor = 0;
  while (cursor < line.length) {
    const start = line.indexOf('"', cursor);
    if (start < 0) return false;
    let end = start + 1;
    while (end < line.length && line[end] !== '"') {
      end += line[end] === '\\' ? 2 : 1;
    }
    if (end >= line.length) return false;
    let value = end + 1;
    while (value < line.length && /\s/.test(line[value])) value += 1;
    if (line[value] === ':') {
      value += 1;
      while (value < line.length && /\s/.test(line[value])) value += 1;
      if ((line[value] === '[' || line[value] === '{')
        && isSensitiveConfigKey(decodedJsonKey(line.slice(start + 1, end)))) return true;
    }
    cursor = end + 1;
  }
  return false;
}

/** Escaped quote nesting is parser-complex; sensitive assignments fail closed. */
function hasSensitiveEscapedAssignment(str) {
  ESCAPED_NAME_VALUE_RE.lastIndex = 0;
  let match;
  while ((match = ESCAPED_NAME_VALUE_RE.exec(str)) !== null) {
    if (isSensitiveConfigKey(match[1])) return true;
  }
  return false;
}

/** Add config-key structural signals that are specific to line-oriented text. */
function redactConfigLine(line) {
  let out = line;
  if (line.includes('"') && line.includes(':')) {
    if (hasNestedSensitiveJsonKey(line)) return MARKER;
    if ((line.includes('[') || line.includes('{')) && hasSensitiveJsonContainer(line)) {
      return MARKER;
    }
    out = line.replace(JSON_VALUE_RE, (match, prefix, key, value) => (
      isSensitiveConfigKey(decodedJsonKey(key)) ? `${prefix}${redactedValue(value)}` : match
    ));
  }
  // The generic name=value rule already covers the no-whitespace form. The root
  // parser is needed only for YAML ':' or TOML-style whitespace around '='.
  if (!ROOT_ASSIGNMENT_HINT_RE.test(out)) return out;
  const assignment = ROOT_ASSIGNMENT_RE.exec(out);
  if (assignment && isSensitiveConfigKey(assignment[3])) {
    out = `${assignment[1]}${assignment[2]}${assignment[3]}${assignment[2]}`
      + `${assignment[4]}${redactedValue(assignment[5])}`;
  }
  return out;
}

/**
 * Redact high-confidence secret substrings within one bounded string. Surrounding
 * text is preserved. Over-cap values retain the established O(1) pass-through
 * contract; diff callers must use redactSecretsLines for fail-closed behavior.
 * @param {unknown} str
 * @returns {unknown}
 */
export function redactSecretsInString(str) {
  if (typeof str !== 'string' || str.length === 0) return str;
  if (str.length > INPUT_CAP) return str;
  if (hasAmbiguousSensitiveAssignment(str)) return MARKER;
  if (str.indexOf('\\') !== -1 && hasSensitiveEscapedAssignment(str)) return MARKER;
  let out = str.replace(PEM_BLOCK_RE, MARKER).replace(PEM_HEADER_RE, MARKER);
  for (const re of TOKEN_GLOBAL_RES) out = out.replace(re, MARKER);
  out = out.replace(URL_USERINFO_RE, (_match, scheme) => `${scheme}${MARKER}@`);
  out = out.replace(BEARER_RE, (_match, scheme) => `${scheme} ${MARKER}`);
  return out.replace(NAME_VALUE_RE, (match, name, value) => (
    isSensitiveConfigKey(name) ? `${name}=${redactedValue(value)}` : match
  ));
}

/**
 * Redact a multi-line diff display without changing its physical line structure.
 * Oversized lines and every line from a PEM BEGIN through its matching END fail
 * closed to one marker. Unterminated PEM blocks remain redacted through EOF.
 * @param {unknown} text
 * @returns {unknown}
 */
export function redactSecretsLines(text) {
  if (typeof text !== 'string' || text.length === 0) return text;
  const hasCarriageReturn = text.includes('\r');
  const parts = hasCarriageReturn ? text.split(NEWLINE_RE) : text.split('\n');
  const step = hasCarriageReturn ? 2 : 1;
  let pemLabel = '';
  for (let i = 0; i < parts.length; i += step) {
    const line = parts[i];
    if (pemLabel) {
      parts[i] = MARKER;
      if (line.length <= INPUT_CAP && line.includes(`-----END ${pemLabel}-----`)) pemLabel = '';
      continue;
    }
    const begin = line.includes('-----BEGIN ') ? PEM_BEGIN_RE.exec(line) : null;
    if (begin) {
      parts[i] = MARKER;
      if (!line.includes(`-----END ${begin[1]}-----`)) pemLabel = begin[1];
      continue;
    }
    if (line.length > INPUT_CAP) {
      parts[i] = MARKER;
      continue;
    }
    parts[i] = redactConfigLine(/** @type {string} */ (redactSecretsInString(line)));
  }
  return hasCarriageReturn ? parts.join('') : parts.join('\n');
}

/** Recursively copy a value and redact every string leaf. Pure and proto-safe. */
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
