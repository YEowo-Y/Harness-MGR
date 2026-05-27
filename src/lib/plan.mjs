/**
 * Plan typedefs for claude-mgr.
 *
 * The CLI is dry-run-by-default: mutating commands produce a Plan (a versioned
 * list of proposed PlanOps) rather than performing writes. Stage A is read-only,
 * so a Plan here is mostly a stable vocabulary that later phases (snapshot/
 * rollback/remove, P3.U10+) will populate and execute. Defining the versioned
 * shape now keeps the type surface stable so downstream units don't reshape it.
 *
 * Shape per plan (lines 473-479):
 *   Plan = { planVersion: 1, command, ops: PlanOp[], wouldSnapshot?, apply }
 *
 * Also exports the sensitive-key redaction helper (P3.U10): a patch op whose
 * JSON pointer targets a sensitive key has its before/after values replaced with
 * {redacted:true, sha256} BEFORE being persisted to apply-journal.json, so the
 * journal never stores a secret. Terminal dry-run output shows raw values (the
 * user asked for it) — redaction is a persistence-time concern only.
 *
 * Zero npm dependencies (node:crypto stdlib for the redaction hash). Pure; never
 * throws.
 */

import { createHash } from 'node:crypto';

/**
 * @typedef {'create'|'overwrite'|'delete'|'rename'|'symlink'|'patch'|'spawn'} OpKind
 */

/**
 * A single proposed mutation. `target` is the absolute path affected; variant
 * fields carry kind-specific context:
 *   - create/overwrite: `content`
 *   - rename/symlink:   `to`
 *   - patch:            `pointer` (JSON pointer), `before`, `after`
 *   - spawn:            `exe`, `args`
 *
 * @typedef {Object} PlanOp
 * @property {OpKind} kind
 * @property {string} target           absolute path the op concerns
 * @property {string} summary          one-line human description
 * @property {string} [content]        for create/overwrite
 * @property {string} [to]             destination for rename/symlink
 * @property {string} [pointer]        JSON pointer for patch ops
 * @property {unknown} [before]        prior value for patch ops (→ RedactedValue once persisted under a sensitive pointer; see redactPatchOp)
 * @property {unknown} [after]         new value for patch ops (→ RedactedValue once persisted under a sensitive pointer)
 * @property {string} [exe]            absolute exe for spawn ops
 * @property {string[]} [args]         argv for spawn ops
 */

/**
 * A versioned, executable plan. `apply` records intent (false = dry-run);
 * `wouldSnapshot` names the snapshot id that an --apply run would capture first.
 *
 * @typedef {Object} Plan
 * @property {1} planVersion
 * @property {string} command          the CLI command that produced the plan
 * @property {PlanOp[]} ops
 * @property {string} [wouldSnapshot]  snapshot id to be captured before applying
 * @property {boolean} apply           true only when writes were explicitly enabled
 */

/** Current Plan schema version. */
export const PLAN_VERSION = 1;

/**
 * Build an empty plan for a command. Defaults to dry-run (`apply: false`).
 * Pure; never throws.
 * @param {string} command
 * @param {{apply?: boolean, wouldSnapshot?: string}} [options]
 * @returns {Plan}
 */
export function emptyPlan(command, options = {}) {
  /** @type {Plan} */
  const plan = {
    planVersion: PLAN_VERSION,
    command: typeof command === 'string' ? command : '',
    ops: [],
    apply: options.apply === true,
  };
  if (typeof options.wouldSnapshot === 'string') plan.wouldSnapshot = options.wouldSnapshot;
  return plan;
}

/**
 * Append a PlanOp to a plan, returning the same plan (chainable). Ignores
 * malformed input rather than throwing, consistent with the never-throw policy.
 * @param {Plan} plan
 * @param {PlanOp} op
 * @returns {Plan}
 */
export function addOp(plan, op) {
  if (plan && Array.isArray(plan.ops) && op && typeof op === 'object') {
    plan.ops.push(op);
  }
  return plan;
}

// ── sensitive-key redaction (P3.U10) ──────────────────────────────────────────

/**
 * Case-insensitive substrings that mark a JSON pointer / key as sensitive. The
 * plan's glob form `*secret*` etc. is a plain "contains" test. Over-redaction is
 * the SAFE direction — a false positive merely hashes a non-secret. (Plan L491.)
 * @type {ReadonlyArray<string>}
 */
export const SENSITIVE_KEY_PATTERNS = Object.freeze([
  'secret', 'token', 'key', 'password', 'credential', 'auth',
]);

/**
 * @typedef {Object} RedactedValue
 * @property {true} redacted
 * @property {string} sha256   hex sha256 of the original value's serialization
 */

/**
 * True when a JSON pointer (or plain key name) targets a sensitive key — i.e.
 * its lowercased text contains any SENSITIVE_KEY_PATTERNS substring. A non-string
 * pointer is not sensitive. Never throws.
 * @param {unknown} pointer
 * @returns {boolean}
 */
export function isSensitivePointer(pointer) {
  if (typeof pointer !== 'string' || pointer.length === 0) return false;
  const lower = pointer.toLowerCase();
  return SENSITIVE_KEY_PATTERNS.some((p) => lower.includes(p));
}

/**
 * Return a journal-safe copy of a patch op: when its `pointer` targets a
 * sensitive key, `before`/`after` (only those present) are replaced with
 * {redacted:true, sha256} so apply-journal.json records that the field changed
 * WITHOUT persisting the secret. A non-sensitive (or malformed) op is returned
 * unchanged — same reference, so dry-run callers still see raw values. The hash
 * is over the value's serialization (the string itself for strings, else
 * JSON.stringify); redacted values are normally scalars, so object-key-order is
 * a non-issue in practice. Never throws.
 * @param {PlanOp} op
 * @returns {PlanOp}
 */
export function redactPatchOp(op) {
  if (!op || typeof op !== 'object' || !isSensitivePointer(op.pointer)) return op;
  const copy = { ...op };
  if ('before' in op) copy.before = { redacted: true, sha256: sha256OfValue(op.before) };
  if ('after' in op) copy.after = { redacted: true, sha256: sha256OfValue(op.after) };
  return copy;
}

/**
 * Deterministic sha256 hex of a value (stable for a GIVEN value); never throws.
 * Strings hash their own bytes; serializable non-strings hash their JSON form
 * (so logically-equal objects with different key insertion order would differ —
 * acceptable because redacted secret values are scalars per plan L491);
 * unserializable inputs (undefined, function, symbol, cyclic) use a
 * sentinel-tagged fallback so e.g. the value `undefined` cannot hash-collide
 * with the string "undefined".
 * @param {unknown} value
 * @returns {string}
 */
function sha256OfValue(value) {
  let serialized;
  if (typeof value === 'string') {
    serialized = value;
  } else {
    try { serialized = JSON.stringify(value); } catch { serialized = undefined; }
    if (typeof serialized !== 'string') serialized = `[mgr:unserializable]${String(value)}`;
  }
  return createHash('sha256').update(serialized, 'utf8').digest('hex');
}
