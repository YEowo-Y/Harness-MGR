/**
 * JSON output adapter (P1.U14 sub-unit B).
 *
 * The CLI's `--format json` contract (per plan) is "ONE JSON envelope ... never
 * a bare stack": every machine-readable response is a versioned envelope and the
 * serialization is DETERMINISTIC so snapshots/diffs are stable across runs and
 * machines. This module owns that shape — a `version: 1` envelope plus a
 * stable-stringifier whose object-key order does not depend on insertion order.
 *
 * Why stable-stringify (not plain JSON.stringify): `JSON.stringify` preserves
 * insertion order, so two equal objects built in different orders would diff.
 * We rebuild plain objects with lexicographically-sorted keys before stringify;
 * arrays are left in their original order (their order is data, not incidental).
 *
 * Never throws — the boundary guarantee. An unserializable value (cycle, BigInt,
 * …) degrades to a minimal error envelope string rather than propagating.
 *
 * Zero npm dependencies. Node stdlib only. Pure.
 */

/** Envelope schema version. Bumped only on a breaking output-shape change. */
export const JSON_ENVELOPE_VERSION = 1;

/** Frozen fallback returned (stringified) when a payload cannot be serialized. */
const ERROR_ENVELOPE = Object.freeze({ version: JSON_ENVELOPE_VERSION, error: 'unserializable' });

/**
 * @typedef {Object} StringifyOpts
 * @property {number} [indent]   spaces per level; 0 → compact. Default 2.
 */

/**
 * Wrap a payload in the versioned envelope. A plain object is spread so its keys
 * sit at the top level alongside `version`; anything else (array, primitive,
 * null) is nested under `data` so the envelope is always a well-formed object.
 * The envelope `version` is written LAST, so a payload that itself carries a
 * `version` key cannot clobber the envelope's schema version.
 *
 * @param {unknown} payload
 * @returns {Record<string, unknown>}
 */
export function toEnvelope(payload) {
  if (isPlainObject(payload)) return { ...payload, version: JSON_ENVELOPE_VERSION };
  return { version: JSON_ENVELOPE_VERSION, data: payload };
}

/**
 * Deterministically stringify a value: plain-object keys sorted lexicographically
 * (recursively), arrays preserved in order, primitives as JSON. Never throws — on
 * any serialization failure (cycle, BigInt, …) returns the error-envelope string.
 *
 * @param {unknown} value
 * @param {StringifyOpts} [opts]
 * @returns {string}
 */
export function stableStringify(value, opts) {
  const indent = normalizeIndent(opts);
  try {
    const sorted = sortValue(value, new WeakSet());
    return JSON.stringify(sorted, null, indent);
  } catch {
    // Belt-and-suspenders: covers BigInt and any other JSON.stringify throw that
    // the cycle guard does not pre-empt. Degrade, never propagate.
    return JSON.stringify(ERROR_ENVELOPE);
  }
}

/**
 * Convenience: envelope + stable-stringify in one call. Never throws.
 *
 * @param {unknown} payload
 * @param {StringifyOpts} [opts]
 * @returns {string}
 */
export function formatJson(payload, opts) {
  return stableStringify(toEnvelope(payload), opts);
}

/**
 * Recursively rebuild a value so plain objects have lexicographically-sorted
 * keys; arrays keep their order (only their elements are recursed). A repeated
 * object reference on the current path is a cycle — throw so the caller's
 * try/catch degrades to the error envelope. Prototype-poisoning keys are dropped
 * (JSON.parse can make `__proto__` an own key) so they never reach output.
 *
 * @param {unknown} value
 * @param {WeakSet<object>} seen   ancestors on the current path (cycle detection)
 * @returns {unknown}
 */
function sortValue(value, seen) {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) throw new Error('circular');
  seen.add(value);
  let out;
  if (Array.isArray(value)) {
    out = value.map((item) => sortValue(item, seen));
  } else {
    out = {};
    for (const key of Object.keys(value).sort()) {
      if (isSafeKey(key)) out[key] = sortValue(value[key], seen);
    }
  }
  seen.delete(value); // sibling reuse is fine; only an ancestor cycle is an error
  return out;
}

/**
 * Coerce `opts.indent` to a non-negative integer; default 2. A non-finite or
 * negative value falls back to 2 so a bad option can never throw or emit garbage.
 *
 * @param {StringifyOpts} [opts]
 * @returns {number}
 */
function normalizeIndent(opts) {
  const raw = opts && typeof opts === 'object' ? opts.indent : undefined;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return 2;
  return Math.floor(raw);
}

/**
 * True for a non-null, non-array PLAIN object — the only shape spread at the
 * envelope top level. A null-proto or Object.prototype object qualifies; class
 * instances and exotics (Date, Map, Set, RegExp) do NOT — spreading those would
 * silently drop their data, so they are nested under `data` instead.
 *
 * @param {unknown} v
 * @returns {v is Record<string, unknown>}
 */
function isPlainObject(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === null || proto === Object.prototype;
}

/**
 * The streaming seam: lazily YIELD each NDJSON line of a command response, in
 * order. FIRST the `type:'result'` line, THEN one `type:'diagnostic'` line per
 * diagnostic. Each line is compact (indent:0), key-stable (stableStringify), and
 * never-throws (stableStringify degrades a bad value to the error envelope string).
 *
 * A consumer (a future TUI, a server, a `for ... of` loop) can iterate the lines
 * one at a time WITHOUT re-buffering the whole joined output — the generator does
 * not materialize a joined string. Diagnostics are emitted in DISCOVERY ORDER
 * (the DiagnosticBag insertion order), so the line stream mirrors the order facts
 * were gathered.
 *
 * Honest architecture note: the pure-handler design COLLECTS every diagnostic
 * first, then this generator emits them as a line-delimited, discovery-ordered
 * stream. It is NOT real-time per-gatherer emission — surfacing each diagnostic
 * the instant a gatherer produces it would require threading emit-callbacks
 * through every pure gatherer, which is out of scope (and would break the
 * never-throws/pure-handler boundary). "Streaming" here means a first-class line
 * generator a consumer can pull lazily, not live event emission.
 *
 * The result is nested under a `result` key (not spread) so a result payload
 * that itself carries a `type` or `command` key cannot collide with the
 * envelope fields. A non-array `diagnostics` is coerced to `[]`.
 *
 * @param {{ command: string, result: unknown, diagnostics: unknown[] }} opts
 * @yields {string} one NDJSON line (no trailing newline)
 */
export function* ndjsonLines({ command, result, diagnostics } = {}) {
  yield stableStringify({ type: 'result', command, result, version: JSON_ENVELOPE_VERSION }, { indent: 0 });
  const diags = Array.isArray(diagnostics) ? diagnostics : [];
  for (const d of diags) {
    yield stableStringify({ ...d, type: 'diagnostic' }, { indent: 0 });
  }
}

/**
 * Render a command response as NDJSON: a `type:'result'` line followed by one
 * `type:'diagnostic'` line per diagnostic. A thin buffering wrapper over the
 * first-class `ndjsonLines` generator — its output is byte-identical to joining
 * that stream with '\n' (NO trailing newline; the executable entry guard adds
 * the final one). Never throws.
 *
 * @param {{ command: string, result: unknown, diagnostics: unknown[] }} opts
 * @returns {string}
 */
export function formatNdjson({ command, result, diagnostics } = {}) {
  return [...ndjsonLines({ command, result, diagnostics })].join('\n');
}

/**
 * Reject keys that could poison a result object's prototype when assigned via
 * bracket notation. Mirrors the hardening in settings-merge.mjs / frontmatter.mjs:
 * user-controlled JSON can carry an own `__proto__` key, which must never reach
 * an output object.
 *
 * @param {string} key
 * @returns {boolean}
 */
function isSafeKey(key) {
  return key !== '__proto__' && key !== 'constructor' && key !== 'prototype';
}
