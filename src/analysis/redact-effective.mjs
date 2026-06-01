/**
 * Effective-config value redaction for `config show-effective`.
 *
 * The merged effective settings object can carry secret VALUES — notably every
 * value under the top-level `env` map (e.g. ANTHROPIC_API_KEY) and any value
 * whose KEY matches a sensitive pattern (token/secret/key/password/credential/
 * auth). The CLI serializes the whole result for `--format json|ndjson` and dumps
 * it for the table/quiet paths, so without redaction those secrets print in
 * plaintext — contradicting the threat model's "names-only" guarantee.
 *
 * This module returns a FRESH redacted copy (the input is never mutated, so the
 * caller's `m.effective` stays byte-identical) in which each sensitive value is
 * replaced with the SAME shape the rest of the tool uses for secrets — a
 * `{redacted:true, sha256}` object (key NAMES stay visible for governance; the
 * stable hash allows config-diffing without revealing the secret). The sensitive-
 * key machinery (`isSensitivePointer`) and the hash (`sha256OfValue`) are reused
 * from lib/plan.mjs as the SINGLE SOURCE — this module adds NO second pattern list.
 *
 * Two surfaces carry values and BOTH are covered:
 *   - the merged `effective` object (redactEffective);
 *   - the per-key `keys` map, whose KeyMerge entries carry the raw `value` for
 *     KNOWN keys and raw `perLayer[].value` for UNKNOWN keys (redactKeysMap) — an
 *     unknown sensitive key like `apiKeyHelper` lives ONLY here, not in effective.
 *
 * Redaction is applied in the command handler BEFORE the result is returned, so
 * EVERY output format (json, ndjson, table, quiet) is uniformly safe; the
 * formatter (stableStringify) stays generic and command-agnostic.
 *
 * Zero npm dependencies. Node stdlib only (via lib/plan.mjs). Pure; never throws.
 */

import { isSensitivePointer, sha256OfValue } from '../lib/plan.mjs';

/**
 * @typedef {import('../lib/plan.mjs').RedactedValue} RedactedValue
 */

/** The top-level key whose every child value is a secret regardless of its name. */
const ENV_KEY = 'env';

/**
 * Replace a value with the project's standard redaction sentinel: a stable
 * `{redacted:true, sha256}` so the value is provably gone yet diffable. Never throws.
 * @param {unknown} value
 * @returns {RedactedValue}
 */
function redactValue(value) {
  return { redacted: true, sha256: sha256OfValue(value) };
}

/**
 * Return a deep-redacted copy of an effective-settings object. EVERY value under
 * the top-level `env` map is redacted (env is the documented secret home and the
 * specific var that is a secret cannot be known); additionally, any value at ANY
 * depth whose own KEY is sensitive (per isSensitivePointer) is redacted. Plain
 * objects are rebuilt with proto-poisoning keys skipped; arrays are mapped;
 * primitives are returned as-is. The input is NOT mutated. Never throws.
 *
 * @param {unknown} effective   the merged effective settings (Record or anything)
 * @returns {unknown}           a fresh redacted copy
 */
export function redactEffective(effective) {
  if (!isPlainObject(effective)) return effective;
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const key of Object.keys(effective)) {
    if (!isSafeKey(key)) continue;
    const val = effective[key];
    if (key === ENV_KEY) out[key] = redactEnv(val);
    else if (isSensitivePointer(key)) out[key] = redactValue(val);
    else out[key] = redactDeep(val);
  }
  return out;
}

/**
 * Return a deep-redacted copy of the per-key `keys` map (Record<topKey, KeyMerge>).
 * Each KeyMerge keeps its `key`/`strategy`/`mergeConfidence` metadata but its raw
 * `value` (KNOWN keys) and `perLayer[].value` (UNKNOWN keys) are redacted whenever
 * the TOP-LEVEL key is `env` or sensitive-named; for any other top-level key the
 * value/perLayer are still deep-redacted so a nested sensitive sub-key is covered.
 * The input is NOT mutated. Never throws.
 *
 * @param {unknown} keys   the MergeResult.keys map
 * @returns {unknown}      a fresh redacted copy
 */
export function redactKeysMap(keys) {
  if (!isPlainObject(keys)) return keys;
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const topKey of Object.keys(keys)) {
    if (!isSafeKey(topKey)) continue;
    out[topKey] = redactMergeEntry(topKey, keys[topKey]);
  }
  return out;
}

/**
 * Redact ONE KeyMerge entry selected by its top-level key — for the `--key`
 * path's `merge` field, which is the same KeyMerge shape that carries a raw
 * `value`/`perLayer[].value`. Decides sensitivity from `topKey` (env or
 * sensitive-named) then reuses the entry redactor. A non-object passes through.
 * The input is NOT mutated. Never throws.
 * @param {unknown} topKey   the top-level key the entry describes
 * @param {unknown} km       the KeyMerge entry (or null)
 * @returns {unknown}        a fresh redacted copy
 */
export function redactMergeEntry(topKey, km) {
  if (!isPlainObject(km)) return km;
  const k = typeof topKey === 'string' ? topKey : '';
  const sensitive = k === ENV_KEY || isSensitivePointer(k);
  return redactKeyMergeEntry(k, km, sensitive);
}

/**
 * Redact a single KeyMerge entry. Copies the metadata fields, then redacts the
 * `value` and each `perLayer[].value` — a sentinel for a sensitive top-level key
 * (env redacts its leaves), else a deep-redact to catch nested sensitive sub-keys.
 * Never throws.
 * @param {string} topKey
 * @param {Record<string, unknown>} km
 * @param {boolean} sensitive
 * @returns {Record<string, unknown>}
 */
function redactKeyMergeEntry(topKey, km, sensitive) {
  /** @type {Record<string, unknown>} */
  const copy = {};
  for (const f of Object.keys(km)) {
    if (!isSafeKey(f)) continue;
    if (f === 'value') copy[f] = redactMergeValue(topKey, km[f], sensitive);
    else if (f === 'perLayer') copy[f] = redactPerLayer(topKey, km[f], sensitive);
    else copy[f] = km[f];
  }
  return copy;
}

/**
 * Redact a KeyMerge `value`: env redacts every leaf, a sensitive-named key becomes
 * a single sentinel, otherwise deep-redact for nested sensitive sub-keys.
 * @param {string} topKey
 * @param {unknown} value
 * @param {boolean} sensitive
 * @returns {unknown}
 */
function redactMergeValue(topKey, value, sensitive) {
  if (topKey === ENV_KEY) return redactEnv(value);
  return sensitive ? redactValue(value) : redactDeep(value);
}

/**
 * Redact a KeyMerge `perLayer` array: map each `{name, value}` to a copy whose
 * `value` is redacted by the same rule as the merged value. A non-array passes
 * through; a non-object entry is kept as-is. Never throws.
 * @param {string} topKey
 * @param {unknown} perLayer
 * @param {boolean} sensitive
 * @returns {unknown}
 */
function redactPerLayer(topKey, perLayer, sensitive) {
  if (!Array.isArray(perLayer)) return perLayer;
  return perLayer.map((entry) => {
    if (!isPlainObject(entry)) return entry;
    /** @type {Record<string, unknown>} */
    const e = {};
    for (const f of Object.keys(entry)) {
      if (!isSafeKey(f)) continue;
      e[f] = f === 'value' ? redactMergeValue(topKey, entry[f], sensitive) : entry[f];
    }
    return e;
  });
}

/**
 * Redact the top-level `env` map: every child value becomes a redaction sentinel
 * regardless of the child key (one cannot know which env var is the secret), while
 * the key NAMES stay visible. A non-object env (malformed) is recursed defensively.
 * @param {unknown} env
 * @returns {unknown}
 */
function redactEnv(env) {
  if (!isPlainObject(env)) return redactDeep(env);
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const key of Object.keys(env)) {
    if (!isSafeKey(key)) continue;
    out[key] = redactValue(env[key]);
  }
  return out;
}

/**
 * Recursively copy a value, redacting any nested value whose KEY is sensitive.
 * Plain objects are rebuilt (proto-keys skipped); arrays are element-mapped (array
 * indices are never sensitive keys); primitives pass through. Never throws.
 * @param {unknown} value
 * @returns {unknown}
 */
function redactDeep(value) {
  if (Array.isArray(value)) return value.map((item) => redactDeep(item));
  if (!isPlainObject(value)) return value;
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const key of Object.keys(value)) {
    if (!isSafeKey(key)) continue;
    out[key] = isSensitivePointer(key) ? redactValue(value[key]) : redactDeep(value[key]);
  }
  return out;
}

/**
 * Redact a single value selected by a key path (the `--key a.b.c` value): redact
 * when the LAST path segment is sensitive OR the path's first segment is `env`
 * (any env leaf is a secret); otherwise deep-redact so nested sensitive keys in a
 * sub-object value are still covered. Never throws.
 * @param {string[]} segments   the dotted key path, already split
 * @param {unknown} value       the value navigated to at that path
 * @returns {unknown}
 */
export function redactKeyedValue(segments, value) {
  const segs = Array.isArray(segments) ? segments : [];
  const last = segs.length > 0 ? segs[segs.length - 1] : undefined;
  if (segs[0] === ENV_KEY || (typeof last === 'string' && isSensitivePointer(last))) {
    return redactValue(value);
  }
  return redactDeep(value);
}

/**
 * True for a non-null, non-array plain object — the shape redaction descends into.
 * @param {unknown} v
 * @returns {v is Record<string, unknown>}
 */
function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Reject prototype-poisoning keys (`__proto__`/`constructor`/`prototype`) so a
 * hostile settings key (JSON.parse can make `__proto__` an own key) never reaches
 * the redacted output object. Mirrors the project isSafeKey idiom.
 * @param {string} key
 * @returns {boolean}
 */
function isSafeKey(key) {
  return key !== '__proto__' && key !== 'constructor' && key !== 'prototype';
}
