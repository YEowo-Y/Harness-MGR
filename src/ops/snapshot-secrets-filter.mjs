/**
 * Snapshot secrets filter (P3.U6) — the LAST line that stops a credential or key
 * from being written into a snapshot archive. A SECURITY-BOUNDARY module: it
 * consumes the U5 walker's raw file list and partitions it into `kept` (captured)
 * vs `dropped` (excluded), emitting one INFO Diagnostic per drop.
 *
 * --- The drop rule is the UNION of name AND content (recall > precision) ---
 * A file is dropped iff EITHER its BASENAME matches the secrets allowlist
 * (`matchesSecret`, the NAME matcher) OR its bytes match the content sniffer
 * (`sniffSecretContent`, the PEM/token/entropy detector). The corpus proves both
 * legs are load-bearing and DISJOINT in practice:
 *   - `github-token.json` has a glob-NAME match but BENIGN content
 *     ("synthetic-not-a-secret") — caught ONLY by the name matcher.
 *   - `disguised/config.json` has a BENIGN name but contains a real-shaped PEM +
 *     `ghp_` token + `AKIA` key — caught ONLY by content-sniff.
 * Neither leg alone excludes both; the union does.
 *
 * --- AMENDMENT to decided-item plan L22 (with rationale + residual risk) ---
 * L22 reads "content-sniff + extension (NOT name patterns)". This unit takes the
 * documented amendment path that item offers. RATIONALE: for a SNAPSHOT the cost
 * asymmetry mandates recall over precision — a false-KEEP archives a real secret
 * (HIGH harm, the exact failure this module exists to prevent), whereas a
 * false-DROP merely omits one file from a backup (LOW harm, AND it is made
 * visible by a per-drop INFO Diagnostic so the user can rename or future-opt-in).
 * Content-sniff is GENUINELY added here (not name-only) — `disguised/config.json`
 * is excluded purely by its content, satisfying L22's substantive intent. The
 * name matcher is additionally retained as a cheap, content-independent belt
 * (a benign-content `*token.json` file is still a likely credential drop site).
 * RESIDUAL PRECISION RISK: a legitimately-named file whose BASENAME matches a
 * secret glob (e.g. `refresh-token.md`) is dropped even if its content is benign.
 * This is mitigated by (a) BASENAME-scoping — a `*token*` ANCESTOR dir never
 * drops a clean nested file (`legit-skill/api-tokens/SKILL.md` is KEPT, its
 * basename is `SKILL.md`), and (b) the per-drop INFO Diagnostic giving the user
 * the visibility to rename the file or rely on a future `--include` escape.
 *
 * --- Lockfile guard ---
 * package-lock.json / yarn.lock / pnpm-lock.yaml / npm-shrinkwrap.json carry
 * integrity hashes (sha512-<base64>) that the entropy heuristic WOULD flag (the
 * sniffer documents this expected over-flag). They are exempted from the CONTENT
 * step only — they remain subject to the name matcher (which never matches them),
 * so a lockfile is kept rather than false-dropped.
 *
 * --- Auth gate ---
 * `mcp-needs-auth-cache.json` is NOT emitted by the U5 walker (it is not in the
 * snapshot allowlist scope). It is added to `kept` ONLY when `includeAuth===true`
 * and it exists on disk — an explicit user opt-in that BYPASSES the secret filter.
 * Default (`includeAuth===false`) leaves it excluded. It is never content-sniffed
 * and never appears in `dropped`. The bypass is constrained to a single
 * in-directory path segment: a separator or `..`-traversal `authFileName` is
 * rejected, so the opt-in can never pull an arbitrary nested/host file into the
 * snapshot (the CLI plumbs only a boolean; the filename seam stays test-only).
 *
 * Ops-layer constraint: imports only node:* stdlib and src/lib/**. Never throws —
 * a bad/missing `files` input yields an empty result; a per-file read error
 * degrades silently to NO content (the name matcher still applies). Injectable
 * readFileFn / existsFn / allowlist seams for testability. Zero npm dependencies.
 *
 * Spec: plan "Snapshot Scope (v4 hardened)" + secrets allowlist/auth gate
 * (claude-mgr-v5.md L22, L404-420).
 */

import { join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { DiagnosticBag } from '../lib/diagnostic.mjs';
import { matchesSecret } from '../lib/secrets-allowlist.mjs';
import { sniffSecretContent } from '../lib/secrets-content-sniff.mjs';

/** @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic */

/**
 * @typedef {Object} DropRecord
 * @property {string} path     POSIX-relative path that was excluded
 * @property {'name'|'content'} by  which detector triggered the drop
 * @property {string} kind     extension|exact|glob (name) | pem|token|entropy (content)
 * @property {string} pattern  the specific matching pattern
 */

/**
 * @typedef {Object} FilterResult
 * @property {string[]} kept           sorted POSIX-relative paths to capture
 * @property {DropRecord[]} dropped    sorted (by path) excluded files with reasons
 * @property {Diagnostic[]} diagnostics one INFO per drop + the auth-include notice
 */

/** Default auth-cache filename, default-excluded unless `--include-auth`. */
const DEFAULT_AUTH_FILE = 'mcp-needs-auth-cache.json';

/** Stable diagnostic phase tag for this module. */
const PHASE = 'snapshot-secrets';

/**
 * Lockfiles exempted from the CONTENT sniff only (their integrity hashes flag as
 * entropy). Matched on BASENAME, case-insensitively. Still subject to the name
 * matcher (which never matches these), so they are kept rather than false-dropped.
 * @type {Set<string>}
 */
const LOCKFILE_BASENAMES = new Set([
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'npm-shrinkwrap.json',
]);

/** Last POSIX path segment, lowercased. Pure; never throws. */
function basenameLower(rel) {
  const i = rel.lastIndexOf('/');
  return (i >= 0 ? rel.slice(i + 1) : rel).toLowerCase();
}

/**
 * Is `name` a single, in-directory path segment safe to resolve directly under
 * `baseDir`? Rejects any separator (`/` or `\`), any `..` traversal component,
 * and the bare `.`/`..` specials — so the auth gate can NEVER resolve outside
 * baseDir nor capture a nested/host file (defence-in-depth: `--include-auth`
 * plumbs only a boolean, but a future mis-wiring of a path into `authFileName`
 * must not silently exfiltrate an arbitrary secret). Pure; never throws.
 * @param {string} name
 * @returns {boolean}
 */
function isSinglePathSegment(name) {
  if (typeof name !== 'string' || name.length === 0) return false;
  if (name.includes('/') || name.includes('\\')) return false;
  if (name === '.' || name === '..') return false;
  return true;
}

/**
 * Classify a single file: is it a secret, and if so why? Returns a DropRecord
 * (without `path`) when the file must be dropped, else null (keep). The name
 * matcher runs first (cheap, no I/O); content-sniff is the fallback and is
 * skipped for lockfiles. A read error degrades silently to NO content.
 *
 * @param {string} rel        POSIX-relative path (the key into `files`)
 * @param {string} baseDir    absolute root to resolve `rel` against
 * @param {(p:string)=>(Buffer|string)} readFileFn
 * @param {object|undefined} allowlist  injectable secrets allowlist
 * @returns {{by:'name'|'content', kind:string, pattern:string}|null}
 */
function classify(rel, baseDir, readFileFn, allowlist) {
  // 1. Name matcher (basename-scoped, case-insensitive).
  const nameHit = matchesSecret(rel, allowlist);
  if (nameHit.match) {
    return { by: 'name', kind: nameHit.kind ?? 'unknown', pattern: nameHit.pattern ?? '' };
  }
  // 2. Lockfile guard — skip the content sniff (integrity-hash entropy would
  //    false-drop). Already passed the name matcher, so KEEP.
  if (LOCKFILE_BASENAMES.has(basenameLower(rel))) return null;
  // 3. Content sniff — read bytes, degrade silently to no-content on any error.
  let bytes;
  try {
    bytes = readFileFn(join(baseDir, ...rel.split('/')));
  } catch {
    bytes = null; // unreadable → no content → name matcher already said keep
  }
  if (bytes != null) {
    const contentHit = sniffSecretContent(bytes);
    if (contentHit.match) {
      return { by: 'content', kind: contentHit.kind ?? 'unknown', pattern: contentHit.pattern ?? '' };
    }
  }
  return null;
}

/**
 * Build the per-drop INFO Diagnostic. Message names the detector + pattern so the
 * user understands WHY a file was excluded (and can rename / future-opt-in).
 * @param {DropRecord} d
 * @returns {Diagnostic}
 */
function dropDiagnostic(d) {
  return {
    severity: 'info',
    code: 'snapshot-secret-excluded',
    message: `excluded ${d.path} from snapshot (${d.by} match: ${d.kind}/${d.pattern})`,
    path: d.path,
    phase: PHASE,
  };
}

/**
 * Apply the `--include-auth` gate. When opted in AND the auth file exists on disk,
 * add it to `kept` (bypassing the secret filter) + emit an INFO notice. Otherwise
 * a no-op (the file is default-excluded). Mutates `kept` in place.
 *
 * The gate is constrained to a single in-directory path segment: a non-segment
 * `authFileName` (separator or `..` traversal) is rejected up front so the
 * secret-filter bypass can target ONLY a file directly under baseDir, never an
 * arbitrary nested/host file.
 * @param {string[]} kept
 * @param {DiagnosticBag} bag
 * @param {{includeAuth:boolean, baseDir:string, authFileName:string, existsFn:(p:string)=>boolean}} ctx
 */
function applyAuthGate(kept, bag, ctx) {
  const { includeAuth, baseDir, authFileName, existsFn } = ctx;
  if (!includeAuth) return;
  // Defence-in-depth: only a single in-directory segment may bypass the filter.
  if (!isSinglePathSegment(authFileName)) return;
  let present = false;
  try {
    present = existsFn(join(baseDir, authFileName)) === true;
  } catch {
    present = false; // never throw on a hostile existsFn
  }
  if (!present) return;
  if (!kept.includes(authFileName)) kept.push(authFileName);
  bag.add({
    severity: 'info',
    code: 'snapshot-auth-included',
    message: `included ${authFileName} via --include-auth (bypasses secret filter)`,
    path: authFileName,
    phase: PHASE,
  });
}

/**
 * Partition a snapshot file list into kept vs dropped, dropping any file whose
 * NAME or CONTENT identifies it as a secret (the union rule). Pure orchestration
 * over injectable seams; never throws.
 *
 * @param {object} opts
 * @param {string} opts.baseDir                    absolute root the rel-paths resolve against
 * @param {string[]} opts.files                    POSIX-relative file list (from the U5 walker)
 * @param {boolean} [opts.includeAuth=false]       opt in to capturing the auth-cache file
 * @param {string} [opts.authFileName='mcp-needs-auth-cache.json'] must be a single
 *   in-directory path segment (no separator / `..`); a non-segment value is
 *   rejected so the bypass can never reach outside baseDir
 * @param {(p:string)=>(Buffer|string)} [opts.readFileFn] default: fs.readFileSync (Buffer)
 * @param {(p:string)=>boolean} [opts.existsFn]    default: fs.existsSync
 * @param {object} [opts.allowlist]                injectable secrets allowlist
 * @returns {FilterResult}
 */
export function filterSnapshotSecrets(opts) {
  const bag = new DiagnosticBag();
  const o = opts && typeof opts === 'object' ? opts : {};
  const baseDir = typeof o.baseDir === 'string' ? o.baseDir : '';
  const includeAuth = o.includeAuth === true;
  const authFileName = typeof o.authFileName === 'string' && o.authFileName.length > 0
    ? o.authFileName : DEFAULT_AUTH_FILE;
  const readFileFn = typeof o.readFileFn === 'function' ? o.readFileFn : readFileSync;
  const existsFn = typeof o.existsFn === 'function' ? o.existsFn : existsSync;
  const allowlist = o.allowlist; // undefined → matchesSecret uses its default

  const files = Array.isArray(o.files) ? o.files : [];

  /** @type {string[]} */
  const kept = [];
  /** @type {DropRecord[]} */
  const dropped = [];

  for (const rel of files) {
    if (typeof rel !== 'string' || rel.length === 0) continue; // skip junk entries
    const verdict = classify(rel, baseDir, readFileFn, allowlist);
    if (verdict === null) {
      kept.push(rel);
    } else {
      dropped.push({ path: rel, by: verdict.by, kind: verdict.kind, pattern: verdict.pattern });
    }
  }

  // Auth gate runs AFTER partitioning (the auth file is not in `files`).
  applyAuthGate(kept, bag, { includeAuth, baseDir, authFileName, existsFn });

  // Deterministic golden output: sort both arrays by path.
  kept.sort();
  dropped.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  // One INFO per drop, appended AFTER any auth notice (order is not asserted but
  // kept stable: drops are emitted in sorted-path order).
  for (const d of dropped) bag.add(dropDiagnostic(d));

  return { kept, dropped, diagnostics: bag.all() };
}
