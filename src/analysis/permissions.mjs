/**
 * Permissions audit (P2.U8) — pure analysis over merged effective.permissions
 * {allow, ask, deny}. Surfaces the three categorized lists and flags OVERBROAD
 * (wildcard) entries in `allow`, which auto-grant more than likely intended.
 * Only `allow` is judged: a broad `deny` is safe and a broad `ask` only prompts.
 * This is the single source of the overbroad-allow rule, shared with doctor #23
 * (permissions-overbroad). Never throws. Node stdlib only; zero deps.
 */

/** @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic */

/** A permission rule is overbroad if it is a string containing a '*' wildcard. */
export function isOverbroadRule(rule) {
  return typeof rule === 'string' && rule.includes('*');
}

/**
 * The deduped, ascending-sorted overbroad (wildcard) entries of an allow list.
 * Defensive: a non-array or entries that are not strings are ignored.
 * @param {unknown} allow
 * @returns {string[]}
 */
export function findOverbroadAllow(allow) {
  const list = Array.isArray(allow) ? allow : [];
  const seen = new Set();
  /** @type {string[]} */
  const out = [];
  for (const entry of list) {
    if (!isOverbroadRule(entry) || seen.has(entry)) continue;
    seen.add(entry);
    out.push(entry);
  }
  out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return out;
}

/** Keep only string members of a maybe-array. @param {unknown} arr @returns {string[]} */
function stringList(arr) {
  return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : [];
}

/**
 * Audit merged permissions: return the categorized string lists plus the
 * overbroad allow entries and one warn Diagnostic per overbroad entry
 * (phase 'permissions'). Pure; never throws; tolerates junk input.
 * @param {unknown} permissions  expected { allow?, ask?, deny? }
 * @returns {{allow: string[], ask: string[], deny: string[], overbroad: string[], diagnostics: Diagnostic[]}}
 */
export function auditPermissions(permissions) {
  const p = permissions && typeof permissions === 'object' ? permissions : {};
  const allow = stringList(p.allow);
  const ask = stringList(p.ask);
  const deny = stringList(p.deny);
  const overbroad = findOverbroadAllow(allow);
  /** @type {Diagnostic[]} */
  const diagnostics = overbroad.map((entry) => ({
    severity: 'warn',
    code: 'permissions-overbroad',
    message: `permissions.allow contains a wildcard rule: "${entry}"`,
    phase: 'permissions',
    fix: `replace "${entry}" with specific rules, or move it to permissions.ask so it prompts instead of auto-allowing`,
  }));
  return { allow, ask, deny, overbroad, diagnostics };
}
