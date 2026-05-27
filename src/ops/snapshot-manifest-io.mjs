/**
 * Snapshot manifest I/O (P3.U8) — the gated persistence half of the manifest
 * contract. Split from the pure model `snapshot-manifest.mjs` so each file stays
 * under the 200-SLOC ceiling and the pure-vs-I/O boundary is explicit.
 *
 * writeManifest writes ONLY into `<stateDir>/snapshots/<id>/manifest.json` — it
 * never touches the governed `~/.claude` config surface. assertWritable is
 * INJECTED + REQUIRED (fail-safe — refuses if absent, never silently bypasses
 * the gate), mirroring lock.mjs; the snapshot/apply path MUST inject
 * paths.mjs::assertWritable.
 *
 * Ops-layer constraint: imports only node:* stdlib and src/lib/** + the sibling
 * model. Never throws. Zero npm dependencies.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { DiagnosticBag } from '../lib/diagnostic.mjs';
import {
  isObject, errMsg, serialize, isValidSnapshotId, snapshotDir, manifestPath, SNAPSHOT_ID_RE,
} from './snapshot-manifest.mjs';

/** @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic */
/** @typedef {import('./snapshot-manifest.mjs').Manifest} Manifest */

/** Reject prototype-poisoning keys (JSON.parse can make `__proto__` an own key). */
function isSafeKey(key) {
  return key !== '__proto__' && key !== 'constructor' && key !== 'prototype';
}

/** Shallow-strip prototype-poisoning own keys from a parsed object. */
function stripProto(obj) {
  const out = {};
  for (const k of Object.keys(obj)) if (isSafeKey(k)) out[k] = obj[k];
  return out;
}

// ── writeManifest (gated I/O + verify-after-write) ────────────────────────────

/**
 * Serialize + write `manifest.json` into `<stateDir>/snapshots/<id>/`, then read
 * it back and byte-compare to prove the write landed intact (snapshot integrity
 * is exit-code-4 critical). Never throws.
 *
 * assertWritable is REQUIRED (fail-safe): a missing gate refuses the write rather
 * than bypassing it. The seams mkdir/write/read are injectable for tests.
 *
 * @param {object} opts
 * @param {string}  opts.stateDir
 * @param {string}  opts.snapshotId
 * @param {Manifest} opts.manifest
 * @param {(path:string, ctx:string)=>string} opts.assertWritable  governed-write gate
 * @param {object}  [opts.seams]   { mkdir, write, read } injectable fs seams
 * @returns {{ written: boolean, path: string|null, diagnostics: Diagnostic[] }}
 */
export function writeManifest(opts) {
  const { stateDir, snapshotId, manifest, assertWritable, seams = {} } = opts ?? {};
  const mkdir = seams.mkdir ?? ((p) => mkdirSync(p, { recursive: true }));
  const write = seams.write ?? ((p, data) => writeFileSync(p, data, 'utf8'));
  const read = seams.read ?? ((p) => readFileSync(p, 'utf8'));
  const bag = new DiagnosticBag();
  const fail = (code, message, path) => {
    bag.add({ severity: 'error', code, message, phase: 'snapshot', ...(path ? { path } : {}) });
    return { written: false, path: path ?? null, diagnostics: bag.all() };
  };

  if (typeof stateDir !== 'string' || stateDir.length === 0) {
    return fail('manifest-write-error', 'stateDir must be a non-empty string');
  }
  if (!isValidSnapshotId(snapshotId)) {
    return fail('manifest-snapshot-id-invalid', `snapshotId must match ${SNAPSHOT_ID_RE}`);
  }
  if (!isObject(manifest)) {
    return fail('manifest-write-error', 'manifest must be an object');
  }
  if (typeof assertWritable !== 'function') {
    return fail('manifest-write-error', 'assertWritable (the governed-write gate) must be injected');
  }

  const dir = snapshotDir(stateDir, snapshotId);
  const file = manifestPath(stateDir, snapshotId);

  try { assertWritable(file, 'apply'); }
  catch (e) { return fail('manifest-write-error', `write gate denied: ${errMsg(e)}`, file); }

  const data = serialize(manifest);
  try { mkdir(dir); write(file, data); }
  catch (e) { return fail('manifest-write-error', `could not write manifest: ${errMsg(e)}`, file); }

  // Verify-after-write: read back and byte-compare (integrity, not just I/O ok).
  let back;
  try { back = read(file); }
  catch (e) { return fail('manifest-write-verify-failed', `could not read back manifest: ${errMsg(e)}`, file); }
  if (back !== data) {
    return fail('manifest-write-verify-failed', 'manifest read-back does not match written bytes', file);
  }
  return { written: true, path: file, diagnostics: bag.all() };
}

// ── readManifest (I/O) ────────────────────────────────────────────────────────

/**
 * Read + parse a snapshot's `manifest.json`. Never throws. A missing manifest is
 * an error (the caller asked for a specific snapshot). TOP-LEVEL prototype keys in
 * the parsed JSON are stripped defensively (downstream verifyManifest validates
 * fields strictly, so a nested poison key cannot survive as a usable record).
 * Returns the manifest unvalidated — pass it to verifyManifest for checks.
 *
 * @param {object} opts
 * @param {string} opts.stateDir
 * @param {string} opts.snapshotId
 * @param {(path:string)=>string} [opts.readFn]  injectable reader
 * @returns {{ manifest: Manifest|null, diagnostics: Diagnostic[] }}
 */
export function readManifest(opts) {
  const { stateDir, snapshotId, readFn } = opts ?? {};
  const bag = new DiagnosticBag();
  const bail = (code, message, path) => {
    bag.add({ severity: 'error', code, message, phase: 'snapshot', ...(path ? { path } : {}) });
    return { manifest: null, diagnostics: bag.all() };
  };

  if (typeof stateDir !== 'string' || stateDir.length === 0) {
    return bail('manifest-read-error', 'stateDir must be a non-empty string');
  }
  if (!isValidSnapshotId(snapshotId)) {
    return bail('manifest-snapshot-id-invalid', `snapshotId must match ${SNAPSHOT_ID_RE}`);
  }

  const file = manifestPath(stateDir, snapshotId);
  let text;
  try { text = readFn ? readFn(file) : readFileSync(file, 'utf8'); }
  catch (e) {
    const code = e && e.code === 'ENOENT' ? 'manifest-not-found' : 'manifest-unreadable';
    return bail(code, `could not read manifest: ${errMsg(e)}`, file);
  }

  let parsed;
  try { parsed = JSON.parse(text); }
  catch (e) { return bail('manifest-unreadable', `invalid manifest JSON: ${errMsg(e)}`, file); }
  if (!isObject(parsed)) {
    return bail('manifest-unreadable', 'manifest is not a JSON object', file);
  }
  return { manifest: stripProto(parsed), diagnostics: bag.all() };
}
