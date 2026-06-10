/**
 * Zero-network machine-verified invariant (P5.U1).
 *
 * The machine-verified form of docs/threat-model.md's "zero network I/O"
 * property: a static scan over the src/ module graph that forbids
 *
 *   (a) IMPORTS of network-capable modules — any static or dynamic import
 *       specifier starting with an entry in NETWORK_IMPORT_PREFIXES, and
 *   (b) CALLS to ambient network APIs — bare/global fetch and WebSocket
 *       construction.
 *
 * --- Raw vs projected scanning (deliberate asymmetry) ---
 * Imports are scanned on RAW source, mirroring boundary.mjs checkStaticImports'
 * documented stance: comment/string over-match is the SAFE direction for a
 * boundary guard (a false positive is suppressible noise; a false negative is
 * an unseen hole). Calls are scanned on the PROJECTED source (projection.mjs:
 * comments stripped, string/template/regex contents blanked) because "fetch" is
 * a common English word in comments and docstrings — a raw scan would drown
 * the gate in noise without adding safety.
 *
 * --- Local regex mirror (deliberate duplication) ---
 * The first two specifier-extraction regexes MIRROR boundary.mjs's private
 * extractAllSpecifiers. They are duplicated locally because boundary.mjs
 * imports THIS module; importing the helper back from boundary.mjs would
 * create an import cycle (and exporting it would widen boundary's surface).
 * The third regex is a deliberate LOCAL EXTENSION beyond that mirrored pair:
 * it catches the side-effect form (`import 'spec';`, no `from` clause), which
 * yields no usable binding (a weak vector) but still executes the module —
 * boundary.mjs's FORBIDDEN_IMPORT_PREFIXES guard does not scan that form.
 *
 * --- Documented residuals (known, accepted false negatives) ---
 * A literal-string static scan inherently cannot see: (1) computed or
 * concatenated dynamic specifiers, e.g. import('a' + 'b'); (2) CommonJS
 * require() obtained via node:module createRequire (exotic in this ESM
 * zero-dependency repo); (3) aliased call forms (const f = fetch; f(u)) and
 * other network globals such as XMLHttpRequest — the call leg's scope is
 * deliberately the literal CALL_FORMS below. These are accepted residuals
 * (mirroring projection.mjs's documented-limitations stance); the backstop
 * is the threat-model's human no-network review gate.
 *
 * Pure / never-throws on junk input. Imports ONLY ./projection.mjs.
 * Zero npm dependencies. paths.mjs is never imported (M2-safe).
 */

import { projectLines } from './projection.mjs';

/** @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic */

/**
 * Import-specifier prefixes that mark a network-capable module. Prefix
 * matching deliberately OVER-matches ('node:http' also covers node:https and
 * node:http2; bare 'http' covers https/http2): in a zero-dependency repo every
 * legitimate specifier is either relative (starts with '.') or a node: builtin,
 * so a bare-prefix collision with an npm package name cannot occur legitimately.
 * @type {ReadonlyArray<string>}
 */
export const NETWORK_IMPORT_PREFIXES = Object.freeze([
  // node: builtin forms ('node:http' prefix also covers node:https/node:http2).
  'node:http',
  'node:net',
  'node:tls',
  'node:dgram',
  'node:dns',
  // bare un-prefixed builtin forms ('http' also covers https/http2).
  'http',
  'https',
  'net',
  'tls',
  'dgram',
  'dns',
  'http2',
  // common userland network clients — can never legitimately appear here.
  'undici',
  'ws',
]);

// The first two regexes MIRROR boundary.mjs extractAllSpecifiers (raw-source
// scan; see module header for why they are duplicated rather than shared).
// The third is a LOCAL EXTENSION: the side-effect form (`import 'spec';`,
// no `from` clause), which the mirrored pair cannot see. The lookbehind
// excludes member access; `import(` (dynamic form) cannot match because the
// mandatory whitespace must be followed directly by a quote.
const STATIC_IMPORT_RE = /\bfrom\s+['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const SIDE_EFFECT_IMPORT_RE = /(?<!\.)\bimport\s+['"]([^'"]+)['"]/g;

/**
 * Ambient network-API call forms, matched per PROJECTED line. The bare-fetch
 * lookbehind excludes member access (`cache.fetch(`) and longer identifiers
 * (`prefetch(`); the explicit globalThis form catches the qualified call the
 * lookbehind deliberately skips.
 */
const CALL_FORMS = Object.freeze([
  { label: 'fetch(...)', re: /(?<![.\w$])fetch\s*\(/ },
  { label: 'globalThis.fetch(...)', re: /\bglobalThis\s*\.\s*fetch\s*\(/ },
  { label: 'new WebSocket(...)', re: /\bnew\s+WebSocket\s*\(/ },
]);

/**
 * Extract every static, dynamic, and side-effect import specifier from raw
 * ESM source text.
 * @param {string} src
 * @returns {string[]}
 */
function extractSpecifiers(src) {
  const found = [];
  let m;
  STATIC_IMPORT_RE.lastIndex = 0;
  while ((m = STATIC_IMPORT_RE.exec(src)) !== null) found.push(m[1]);
  DYNAMIC_IMPORT_RE.lastIndex = 0;
  while ((m = DYNAMIC_IMPORT_RE.exec(src)) !== null) found.push(m[1]);
  SIDE_EFFECT_IMPORT_RE.lastIndex = 0;
  while ((m = SIDE_EFFECT_IMPORT_RE.exec(src)) !== null) found.push(m[1]);
  return found;
}

/**
 * Scan RAW source of each file for import specifiers starting with a forbidden
 * network prefix. One diagnostic per offending specifier (first matching
 * prefix wins). Never throws; junk input tolerated.
 *
 * @param {Array<{path: string, source: string}>} files
 * @returns {Diagnostic[]}
 */
export function checkZeroNetworkImports(files) {
  if (!Array.isArray(files)) return [];
  /** @type {Diagnostic[]} */
  const diags = [];
  for (const file of files) {
    if (!file || typeof file.path !== 'string' || typeof file.source !== 'string') continue;
    for (const spec of extractSpecifiers(file.source)) {
      for (const prefix of NETWORK_IMPORT_PREFIXES) {
        if (spec.startsWith(prefix)) {
          diags.push({
            severity: 'error',
            code: 'zero-network-import',
            message:
              `network import '${spec}' (matches forbidden prefix '${prefix}') in ` +
              `${file.path} — src/ must stay zero-network (threat-model)`,
            path: file.path,
            phase: 'boundary',
          });
          break; // one diagnostic per specifier
        }
      }
    }
  }
  return diags;
}

/**
 * Scan PROJECTED source (comments stripped, literal contents blanked) of each
 * file for ambient network-API call forms. One diagnostic per (line, form)
 * hit, with a 1-based line number in the message. Never throws.
 *
 * @param {Array<{path: string, source: string}>} files
 * @returns {Diagnostic[]}
 */
export function checkZeroNetworkCalls(files) {
  if (!Array.isArray(files)) return [];
  /** @type {Diagnostic[]} */
  const diags = [];
  for (const file of files) {
    if (!file || typeof file.path !== 'string' || typeof file.source !== 'string') continue;
    const projected = projectLines(file.source.split('\n'));
    for (let i = 0; i < projected.length; i += 1) {
      for (const form of CALL_FORMS) {
        if (form.re.test(projected[i])) {
          diags.push({
            severity: 'error',
            code: 'zero-network-call',
            message:
              `network call ${form.label} in ${file.path} line ${i + 1} — ` +
              `src/ must stay zero-network (threat-model)`,
            path: file.path,
            phase: 'boundary',
          });
        }
      }
    }
  }
  return diags;
}

/**
 * Run both zero-network checks and concatenate their diagnostics.
 * Never throws; junk input tolerated.
 *
 * @param {Array<{path: string, source: string}>} files
 * @returns {Diagnostic[]}
 */
export function checkZeroNetwork(files) {
  return [...checkZeroNetworkImports(files), ...checkZeroNetworkCalls(files)];
}
