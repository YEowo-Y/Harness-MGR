/**
 * Minimal YAML-frontmatter parser (P1.U7, split out of components.mjs).
 *
 * --- Why hand-rolled ---
 * The project constitution is ZERO runtime dependencies, so we cannot pull in
 * js-yaml. Claude Code frontmatter is a tiny subset of YAML — `key: scalar`
 * pairs plus folded multi-line scalars — so a small parser covers every real
 * case while keeping the attack/maintenance surface near zero. Values are
 * opaque strings; we intentionally do NOT support nested mappings, anchors, or
 * typed flow collections.
 *
 * --- The one structural check ---
 * A value that OPENS a flow collection (`[` or `{`) must close it. That is the
 * single malformation we detect (it is exactly what the broken/ fixture
 * exercises: `name: [unclosed bracket`). Quoted values are exempt: in YAML a
 * quoted scalar is a literal string, so `name: "[literal]"` is the string
 * `[literal]`, NOT a flow sequence — we therefore check quotes BEFORE flow.
 *
 * --- Prototype-safety ---
 * Parsed maps use `Object.create(null)`. Frontmatter keys come from a file, so
 * a literal key like `toString` would otherwise shadow an inherited method and
 * surprise downstream consumers (JSON output, conflict maps). A null-prototype
 * map turns every key into ordinary data with no inherited behavior.
 *
 * Pure; never throws. Zero npm dependencies.
 */

/** Matches a `key:` or `key: value` line (hyphens allowed, e.g. allowed-tools). */
const KEY_RE = /^([A-Za-z0-9_][A-Za-z0-9_.-]*):(?:[ \t]+(.*))?$/;

/** A fresh null-prototype string map. */
function emptyData() {
  return /** @type {Record<string,string>} */ (Object.create(null));
}

/**
 * Parse a YAML-frontmatter block out of file text. Pure; never throws.
 *
 * Returns `hasFrontmatter:false` when the text does not open with a `---` line
 * (a frontmatter-less file is normal, not an error). `error` is a human string
 * when the block is structurally malformed (opened-but-unclosed, or a value
 * with an unbalanced flow collection); the offending key is dropped from `data`
 * while every other key is still returned.
 *
 * @param {string} text
 * @returns {{data: Record<string,string>, hasFrontmatter: boolean, error: string|null}}
 */
export function parseFrontmatter(text) {
  if (typeof text !== 'string') return { data: emptyData(), hasFrontmatter: false, error: null };

  // Strip a leading UTF-8 BOM, then split on either line ending (Windows CRLF).
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = s.split(/\r?\n/);

  if (lines.length === 0 || lines[0].trim() !== '---') {
    return { data: emptyData(), hasFrontmatter: false, error: null };
  }

  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      end = i;
      break;
    }
  }
  if (end === -1) {
    return { data: emptyData(), hasFrontmatter: true, error: 'frontmatter block opened with --- but was never closed' };
  }

  return parseBlock(lines.slice(1, end));
}

/**
 * Parse the inner lines of a frontmatter block into a scalar map. A line at the
 * base indent matching `key:` starts a new key; YAML requires folded
 * continuations to be MORE indented, so any deeper-indented (or non-matching)
 * line folds into the current value, joined with a single space.
 *
 * @param {string[]} bodyLines
 * @returns {{data: Record<string,string>, hasFrontmatter: boolean, error: string|null}}
 */
function parseBlock(bodyLines) {
  const data = emptyData();
  let curKey = null;
  let baseIndent = null;

  for (const raw of bodyLines) {
    if (raw.trim() === '') continue;
    const indent = raw.length - raw.trimStart().length;
    const trimmed = raw.trim();
    const m = trimmed.match(KEY_RE);
    const isKey = m && (baseIndent === null || indent <= baseIndent);

    if (isKey) {
      if (baseIndent === null) baseIndent = indent;
      curKey = m[1];
      data[curKey] = m[2] !== undefined ? m[2] : '';
    } else if (curKey !== null) {
      data[curKey] += (data[curKey].length ? ' ' : '') + trimmed;
    }
    // A non-key line before any key is ignored (no scalar to fold into).
  }

  const error = normalizeValues(data);
  return { data, hasFrontmatter: true, error };
}

/**
 * In-place value cleanup. Quotes are checked FIRST: a quoted scalar is a literal
 * string in YAML, so quoting deliberately disables the flow-collection check
 * (`name: "[x"` is the literal `[x`, not a malformed sequence). Unquoted values
 * that open a flow collection must be balanced. Returns the first error, or null.
 *
 * @param {Record<string,string>} data
 * @returns {string|null}
 */
function normalizeValues(data) {
  let error = null;
  for (const k of Object.keys(data)) {
    const v = data[k];
    const unquoted = stripQuotes(v);
    if (unquoted !== null) {
      data[k] = unquoted;
      continue;
    }
    if ((v[0] === '[' || v[0] === '{') && !isBalancedFlow(v)) {
      if (!error) error = `frontmatter key '${k}' has a malformed flow value: ${truncate(v)}`;
      delete data[k];
    }
  }
  return error;
}

/**
 * If `v` is wrapped in matching single or double quotes, return the inner text;
 * otherwise null. No escape processing (minimal — fixtures are unquoted).
 * @param {string} v
 * @returns {string|null}
 */
function stripQuotes(v) {
  if (v.length >= 2) {
    const a = v[0];
    const b = v[v.length - 1];
    if ((a === '"' && b === '"') || (a === "'" && b === "'")) return v.slice(1, -1);
  }
  return null;
}

/**
 * True when every `[`/`{` is matched by a later `]`/`}` and none closes before
 * it opens. This counts brackets only; it does NOT validate cross-type nesting
 * order (`[{]}` counts as balanced), which is an accepted trade-off for the
 * minimal "is this flow value obviously truncated?" check.
 * @param {string} v
 * @returns {boolean}
 */
function isBalancedFlow(v) {
  let square = 0;
  let curly = 0;
  for (const ch of v) {
    if (ch === '[') square++;
    else if (ch === ']') square--;
    else if (ch === '{') curly++;
    else if (ch === '}') curly--;
    if (square < 0 || curly < 0) return false;
  }
  return square === 0 && curly === 0;
}

/** @param {string} s @param {number} [n] */
function truncate(s, n = 60) {
  return s.length > n ? s.slice(0, n) + '…' : s;
}
