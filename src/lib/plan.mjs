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
 * Zero dependencies. Pure; never throws.
 */

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
 * @property {unknown} [before]        prior value for patch ops
 * @property {unknown} [after]         new value for patch ops
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
