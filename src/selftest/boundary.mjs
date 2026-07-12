/**
 * Selftest boundary gate (P1.U16).
 *
 * Three check classes enforce the repository's trust boundaries:
 *
 *   1. STATIC - import-graph scan: reads src/**.mjs and asserts no import
 *      specifier starts with a forbidden prefix.  Phase 1 has no forbidden
 *      prefixes (FORBIDDEN_IMPORT_PREFIXES is empty) so this runs but always
 *      passes; adding an entry to the freeze list is sufficient to enforce it.
 *
 *   2. LAYERING - rejects any src/ops module that resolves an import into
 *      src/analysis, keeping the reusable operations layer below judgment code.
 *
 *   3. RUNTIME - write-allowlist probe: exercises assertWritable() against
 *      representative paths derived from roots and confirms each either
 *      allows or denies with the expected error code.
 *
 * Neither function throws; all failures surface as Diagnostics with
 * phase:'boundary'.
 *
 * Zero npm dependencies.  node:fs + node:path only.
 * paths.mjs is NOT statically imported -- assertWritable and roots are injected.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
export { buildAllowlistCases } from './boundary-cases.mjs';
export { snapshotDirHashes, checkSpawnWriteBoundary } from '../lib/spawn-write-boundary.mjs';
export { checkSpawnSpecGuardrail, MUTATION_FLAGS, LEGIT_POSIX_PATH } from './spawn-spec-guardrail.mjs';
export { checkSpawnSpecCompleteness } from './spawn-spec-completeness.mjs';
export { checkWriteGateCompleteness, MUTATION_SEAMS, EXEMPT_MODULES } from './write-gate-completeness.mjs';
export { checkZeroNetwork, NETWORK_IMPORT_PREFIXES } from './zero-network.mjs';
import { checkSpawnSpecGuardrail } from './spawn-spec-guardrail.mjs';
import { checkSpawnSpecCompleteness } from './spawn-spec-completeness.mjs';
import { checkWriteGateCompleteness } from './write-gate-completeness.mjs';
import { checkZeroNetwork } from './zero-network.mjs';
import { SPAWN_SPECS } from './spawn-spec-registry.mjs';
import { buildAllowlistCases } from './boundary-cases.mjs';

/** @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic */

/**
 * External prefixes that must never appear in the import graph.
 * Phase 1: empty.  Add strings here to enforce future constraints.
 * @type {ReadonlyArray<string>}
 */
export const FORBIDDEN_IMPORT_PREFIXES = Object.freeze([]);

// ── helpers ────────────────────────────────────────────────────────────────

/**
 * Walk a directory recursively, collecting absolute paths for .mjs files.
 * Returns an empty array on any read error.
 * @param {string} dir
 * @returns {string[]}
 */
function gatherMjs(dir) {
  const results = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const e of entries) {
    const abs = join(dir, e.name);
    try {
      if (e.isDirectory()) {
        const sub = gatherMjs(abs);
        for (const f of sub) results.push(f);
      } else if (e.isFile() && e.name.endsWith('.mjs')) {
        results.push(abs);
      }
    } catch {
      // Skip unreadable entries silently.
    }
  }
  return results;
}

/**
 * Extract all import specifiers from ESM source text: both static
 * (`import … from '…'` / `export … from '…'`) and dynamic (`import('…')`).
 *
 * NOTE: these regexes operate on the raw source, not a parsed AST, so they
 * may false-positive on specifier-like text inside string literals or comments.
 * That is the SAFE direction for a boundary guard — false positives are noise
 * we can suppress; false negatives would let a forbidden import through unseen.
 *
 * @param {string} src
 * @returns {string[]}
 */
function extractAllSpecifiers(src) {
  const staticRe = /\bfrom\s+['"]([^'"]+)['"]/g;
  const sideEffectRe = /\bimport\s*['"]([^'"]+)['"]/g;
  const dynamicRe = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  const found = [];
  let m;
  while ((m = staticRe.exec(src)) !== null) found.push(m[1]);
  while ((m = sideEffectRe.exec(src)) !== null) found.push(m[1]);
  while ((m = dynamicRe.exec(src)) !== null) found.push(m[1]);
  return found;
}

// ── exported API ───────────────────────────────────────────────────────────

/**
 * Check that no import specifier in the given files starts with a forbidden
 * prefix.  Pure; never throws.  Inputs are not mutated.
 *
 * @param {Array<{path: string, source: string}>} files
 * @param {ReadonlyArray<string>} [prefixes]
 * @returns {Diagnostic[]}
 */
export function checkStaticImports(files, prefixes = FORBIDDEN_IMPORT_PREFIXES) {
  if (!Array.isArray(files) || files.length === 0) return [];
  if (!Array.isArray(prefixes) || prefixes.length === 0) return [];
  /** @type {Diagnostic[]} */
  const diags = [];
  for (const file of files) {
    if (!file || typeof file.path !== 'string' || typeof file.source !== 'string') continue;
    const specifiers = extractAllSpecifiers(file.source);
    for (const spec of specifiers) {
      for (const prefix of prefixes) {
        if (typeof prefix === 'string' && spec.startsWith(prefix)) {
          diags.push({
            severity: 'error',
            code: 'boundary-forbidden-import',
            message: `forbidden import '${spec}' (matches prefix '${prefix}') in ${file.path}`,
            path: file.path,
            phase: 'boundary',
          });
        }
      }
    }
  }
  return diags;
}

/** Normalize a filesystem path for platform-independent layer classification. */
function slashPath(path) {
  return typeof path === 'string' ? path.replace(/\\/g, '/') : '';
}

/**
 * Reject imports from src/ops/** into src/analysis/**. Relative specifiers are
 * resolved against the importing file so static imports, re-exports, and dynamic
 * literal imports share one rule. Pure; never throws.
 * @param {Array<{path: string, source: string}>} files
 * @returns {Diagnostic[]}
 */
export function checkOpsAnalysisBoundary(files) {
  if (!Array.isArray(files)) return [];
  /** @type {Diagnostic[]} */
  const diags = [];
  for (const file of files) {
    if (!file || typeof file.path !== 'string' || typeof file.source !== 'string') continue;
    if (!/(?:^|\/)src\/ops\//.test(slashPath(file.path))) continue;
    for (const specifier of extractAllSpecifiers(file.source)) {
      if (!specifier.startsWith('.')) continue;
      const target = slashPath(resolve(dirname(file.path), specifier));
      if (!/(?:^|\/)src\/analysis(?:\/|$)/.test(target)) continue;
      diags.push({
        severity: 'error', code: 'boundary-layer-import', phase: 'boundary', path: file.path,
        message: `ops layer must not import analysis module '${specifier}'`,
      });
    }
  }
  return diags;
}

/**
 * Probe one allowlist case; return a Diagnostic on mismatch or null on pass.
 * @param {Function} assertWritable
 * @param {{label:string, target:string, context:string, expectAllow:boolean, expectedCode?:string}} c
 * @returns {Diagnostic|null}
 */
function probeCase(assertWritable, c) {
  try {
    const result = assertWritable(c.target, c.context);
    if (!c.expectAllow) {
      return { severity: 'error', code: 'boundary-write-allowed-unexpectedly',
        message: `[${c.label}] expected throw ${c.expectedCode ?? '(any)'} but returned ${String(result)}`,
        path: c.target, phase: 'boundary' };
    }
    return null; // expected allow, got allow -> pass
  } catch (err) {
    if (c.expectAllow) {
      const msg = err instanceof Error ? err.message : String(err ?? '');
      return { severity: 'error', code: 'boundary-write-denied-unexpectedly',
        message: `[${c.label}] expected allow but got throw: ${msg}`,
        path: c.target, phase: 'boundary' };
    }
    const actualCode = err && typeof err.code === 'string' ? err.code : '(no code)';
    if (c.expectedCode && actualCode !== c.expectedCode) {
      return { severity: 'error', code: 'boundary-write-wrong-code',
        message: `[${c.label}] wrong code: got '${actualCode}', expected '${c.expectedCode}'`,
        path: c.target, phase: 'boundary' };
    }
    return null; // expected throw + correct code -> pass
  }
}

/**
 * Exercise assertWritable against representative paths derived from roots and
 * confirm each allow/deny behaves as expected.  Never throws.
 *
 * @param {Function} assertWritable
 * @param {{ targetClaudeDir: string, mgrStateDir: string }} roots
 * @returns {Diagnostic[]}
 */
export function checkWriteAllowlist(assertWritable, roots) {
  if (typeof assertWritable !== 'function' || !roots || typeof roots !== 'object') {
    return [{ severity: 'error', code: 'boundary-runtime-bad-input',
      message: 'checkWriteAllowlist called with missing assertWritable or roots',
      phase: 'boundary' }];
  }
  const { targetClaudeDir, mgrStateDir } = roots;
  if (typeof targetClaudeDir !== 'string' || typeof mgrStateDir !== 'string') {
    return [{ severity: 'error', code: 'boundary-runtime-bad-input',
      message: 'roots.targetClaudeDir and roots.mgrStateDir must be strings',
      phase: 'boundary' }];
  }
  /** @type {Diagnostic[]} */
  const diags = [];
  for (const c of buildAllowlistCases(targetClaudeDir, mgrStateDir)) {
    const d = probeCase(assertWritable, c);
    if (d) diags.push(d);
  }
  return diags;
}

/**
 * Read src/*.mjs files under srcDir, push read-failure diagnostics into diags,
 * and return the successfully loaded file records.
 * @param {string} srcDir
 * @param {Diagnostic[]} diags
 * @returns {Array<{path: string, source: string}>}
 */
function loadSrcFiles(srcDir, diags) {
  /** @type {Array<{path: string, source: string}>} */
  const files = [];
  for (const p of gatherMjs(srcDir)) {
    try {
      files.push({ path: p, source: readFileSync(p, 'utf-8') });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err ?? '');
      diags.push({ severity: 'error', code: 'boundary-read-failed',
        message: `could not read ${p}: ${msg}`, path: p, phase: 'boundary' });
    }
  }
  return files;
}

/**
 * Thin orchestrator: static-import scan over src/**.mjs under srcDir, and
 * optionally the runtime allowlist check when assertWritable + roots are given.
 *
 * Never throws.  Inputs not mutated.
 *
 * @param {{ srcDir?: string, assertWritable?: Function, roots?: object }} [opts]
 * @returns {{ diagnostics: Diagnostic[] }}
 */
export function checkBoundary({ srcDir, assertWritable, roots } = {}) {
  /** @type {Diagnostic[]} */
  const diags = [];
  /** @type {Array<{path: string, source: string}>} */
  let srcFiles = [];
  if (typeof srcDir === 'string') {
    srcFiles = loadSrcFiles(srcDir, diags);
    for (const d of checkStaticImports(srcFiles)) diags.push(d);
    for (const d of checkOpsAnalysisBoundary(srcFiles)) diags.push(d);
  }
  if (typeof assertWritable === 'function' && roots != null) {
    for (const d of checkWriteAllowlist(assertWritable, roots)) diags.push(d);
  } else {
    diags.push({ severity: 'info', code: 'boundary-runtime-skipped',
      message: 'runtime write-allowlist check skipped (assertWritable/roots not provided)',
      phase: 'boundary' });
  }
  // Spawn-spec guardrail: runs unconditionally (pure, no assertWritable/roots needed).
  // Fails the gate if any allowSlashPositionals:true consumer has a permissive pattern.
  for (const d of checkSpawnSpecGuardrail(SPAWN_SPECS)) diags.push(d);
  // Spawn-spec completeness: static backstop — every src/ module that sets
  // allowSlashPositionals:true must be registered in SPAWN_SPECS.  Runs when
  // srcDir was provided (srcFiles already loaded above); skips silently otherwise.
  if (srcFiles.length > 0) {
    const registeredIds = new Set(
      SPAWN_SPECS.map((s) => (s && typeof s.id === 'string' ? s.id : '')),
    );
    for (const d of checkSpawnSpecCompleteness(srcFiles, registeredIds)) diags.push(d);
    // Write-gate completeness: static backstop — every src/ module that CALLS an
    // fs-mutation seam must reference assertWritable (gated) or be in EXEMPT_MODULES
    // (an audited non-governed writer). Runs when srcDir was provided.
    for (const d of checkWriteGateCompleteness(srcFiles)) diags.push(d);
    // Zero-network invariant (P5.U1): static backstop — no src/ module may import
    // a network builtin or call an ambient network API (fetch / WebSocket).
    for (const d of checkZeroNetwork(srcFiles)) diags.push(d);
  }
  return { diagnostics: diags };
}
