/**
 * Loader-probe active probe gatherer (P2.U7c-2).
 *
 * Writes a transient `__mgr-probe-<uuid>.md` agent file into the REAL
 * <configDir>/agents/ via `assertWritable(target, 'probe')` (symlink-escape
 * protection), then confirms harness-mgr's own discoverComponents detects it
 * (end-to-end discovery self-check), and ALWAYS cleans up in a finally block.
 *
 * The `ccVersion` string is carried through unchanged for the downstream
 * analysis layer (#19 check in active-checks.mjs) to compute loader confidence
 * via loaderConfidence(). This module must NOT import from src/analysis/** —
 * the discovery layer cannot depend on analysis.
 *
 * Never throws. Returns { loader: LoaderProbeFact, diagnostics: Diagnostic[] }.
 * Zero npm dependencies. Node stdlib only.
 */

import { join } from 'node:path';
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { assertWritable } from '../paths.mjs';
import { discoverComponents } from './components.mjs';
import { DiagnosticBag } from '../lib/diagnostic.mjs';

/** @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic */

/**
 * @typedef {Object} LoaderProbeFact
 * @property {string} probeName    the __mgr-probe-<uuid> name used (or '' if none)
 * @property {boolean} wrote        a probe agent file was written
 * @property {boolean} observed     harness-mgr's own discovery detected the probe agent
 * @property {boolean} cleanedUp    the probe file was removed (true if never written)
 * @property {string|null} ccVersion  claude version passed in (for downstream confidence), or null
 */

/** Minimal valid agent markdown for the transient probe file. */
function probeAgentContent(probeName) {
  return `---\nname: ${probeName}\ndescription: harness-mgr loader probe (transient, safe to delete)\n---\nTransient loader probe written by \`harness-mgr doctor --active-probes\`. Auto-deleted.\n`;
}

// Default I/O implementations (overridable for tests).
const defaultWrite = (p, c) => writeFileSync(p, c, 'utf8');
const defaultRemove = (p) => unlinkSync(p);
const defaultExists = (p) => existsSync(p);

/**
 * Try to remove the probe file. Returns true when the file is confirmed gone,
 * false when removal fails or the file still exists afterwards.
 *
 * @param {string} validated    canonical probe file path
 * @param {function} removeFn  injectable remove function
 * @param {function} existsFn  injectable exists function
 * @returns {boolean}
 */
function cleanupProbe(validated, removeFn, existsFn) {
  try {
    removeFn(validated);
    return existsFn(validated) === false;
  } catch {
    return false;
  }
}

/**
 * Gather the loader-probe fact for the doctor active layer (#19).
 *
 * Writes a transient probe agent file, self-checks via discoverComponents,
 * and deletes the file in a finally block. Carries ccVersion for downstream
 * confidence computation (analysis must NOT be imported here).
 *
 * Never throws.
 *
 * @param {{ configDir?: string, ccVersion?: string,
 *           assertProbeWritable?: (p: string) => string,
 *           writeFn?: (p: string, c: string) => void,
 *           discoverFn?: (dir: string) => {components: object[], diagnostics: Diagnostic[]},
 *           removeFn?: (p: string) => void,
 *           existsFn?: (p: string) => boolean,
 *           uuid?: () => string }} [opts]
 * @returns {Promise<{ loader: LoaderProbeFact, diagnostics: Diagnostic[] }>}
 */
export async function gatherLoaderProbe(opts) {
  const bag = new DiagnosticBag();
  const {
    configDir,
    ccVersion,
    assertProbeWritable = (p) => assertWritable(p, 'probe'),
    writeFn = defaultWrite,
    discoverFn = discoverComponents,
    removeFn = defaultRemove,
    existsFn = defaultExists,
    uuid = randomUUID,
  } = opts ?? {};

  const ccv = typeof ccVersion === 'string' ? ccVersion : null;

  if (typeof configDir !== 'string' || configDir.length === 0) {
    bag.add({ severity: 'error', code: 'discover-bad-root', message: 'configDir must be a non-empty string', phase: 'loader-probe' });
    return { loader: { probeName: '', wrote: false, observed: false, cleanedUp: true, ccVersion: ccv }, diagnostics: bag.all() };
  }

  // Compute the probe name/path AND validate it through the write gate (symlink-
  // escape protection) inside one try, so that an injected uuid seam that throws
  // — or any setup failure — degrades to a fact rather than rejecting. If the gate
  // rejects, never write.
  let probeName = '';
  let validated;
  try {
    probeName = `__mgr-probe-${uuid()}`;
    const file = join(configDir, 'agents', `${probeName}.md`);
    validated = assertProbeWritable(file);
  } catch (err) {
    bag.add({ severity: 'warn', code: 'loader-probe-blocked', message: `probe write could not be validated: ${err && err.message ? err.message : String(err)}`, phase: 'loader-probe' });
    return { loader: { probeName, wrote: false, observed: false, cleanedUp: true, ccVersion: ccv }, diagnostics: bag.all() };
  }

  let wrote = false;
  let observed = false;
  let cleanedUp = true; // nothing written yet → nothing to clean

  try {
    try {
      writeFn(validated, probeAgentContent(probeName));
      wrote = true;
      cleanedUp = false; // we now own a file that MUST be removed
    } catch (err) {
      // e.g. ENOENT when agents/ does not exist → benign, cannot probe.
      bag.add({ severity: 'info', code: 'loader-probe-skipped', message: `could not write probe agent (${err && err.code ? err.code : 'error'}); loader probe skipped`, phase: 'loader-probe' });
      return { loader: { probeName, wrote: false, observed: false, cleanedUp: true, ccVersion: ccv }, diagnostics: bag.all() };
    }

    // Observe via harness-mgr's OWN discovery (end-to-end check against the live dir).
    try {
      const result = discoverFn(configDir);
      const components = result && Array.isArray(result.components) ? result.components : [];
      observed = components.some((c) => c && c.kind === 'agent' && c.name === probeName);
    } catch {
      observed = false; // discovery failure → not observed; cleanup STILL runs (finally)
    }
  } finally {
    if (wrote) {
      cleanedUp = cleanupProbe(validated, removeFn, existsFn);
    }
  }

  return { loader: { probeName, wrote, observed, cleanedUp, ccVersion: ccv }, diagnostics: bag.all() };
}
