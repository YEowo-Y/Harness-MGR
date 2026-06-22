/**
 * Apply op-kind tables + per-op validation — EXTRACTED from apply.mjs (P6 config-edit
 * unit) to keep the orchestrator under the 200-SLOC ceiling (the apply-manifest-check.mjs
 * precedent). Pure; never throws. The dispatch loop in apply.mjs imports the kind tables,
 * and invalidOpReason is the single pre-write validity gate (ALL ops are validated BEFORE
 * any 'applying' transition or mutation). M2-safe (no imports at all).
 */

/** Op kinds this unit WRITES (they carry whole-file `content`). */
export const WRITABLE_KINDS = Object.freeze(['create', 'overwrite']);

/** Op kinds this unit DELETES (no `content`; the target file is removed). */
export const DELETABLE_KINDS = Object.freeze(['delete']);

/** Op kinds this unit DELETES as a DIRECTORY (the manifest captures its CONTENTS). */
export const DIR_DELETABLE_KINDS = Object.freeze(['delete-dir']);

/** Op kinds this unit edits IN PLACE via a single-token splice (gate context
 *  'config-edit'; carries {selector, desired}, never whole-file `content`). */
export const CONFIG_EDIT_KINDS = Object.freeze(['config-edit']);

/** Op kinds this unit DELETES a whole config BLOCK in place (the prune-config primitive:
 *  splices out one `[[skills.config]]` element). Routes through the SAME 'config-edit' gate
 *  context (it writes config.toml); carries {selector} only — never `content` or `desired`. */
export const CONFIG_BLOCK_DELETE_KINDS = Object.freeze(['config-block-delete']);

/** Op kinds this unit edits IN PLACE via a surgical JSON boolean flip/insert (the Claude
 *  plugin-toggle primitive: flips/inserts one `enabledPlugins[key]` boolean in settings.json).
 *  Routes through the 'apply' gate context (settings.json IS whole-file apply-writable — no new
 *  context); carries {selector:{key}, desired}, never whole-file `content`. */
export const JSON_EDIT_KINDS = Object.freeze(['json-edit']);

/** Op kinds this unit edits IN PLACE via a surgical JSON STRING flip/insert/create (the Claude
 *  skill-visibility primitive: flips/inserts one `skillOverrides[memberKey]` string in
 *  settings.json, CREATING the map when absent). Routes through the SAME 'apply' gate context
 *  (settings.json IS whole-file apply-writable — no new context); carries
 *  {selector:{mapKey,memberKey}, value:string}, never whole-file `content` or `desired`. */
export const JSON_MAP_SET_KINDS = Object.freeze(['json-map-set']);

/** True for a non-empty string. */
function isNonEmptyStr(v) { return typeof v === 'string' && v.length > 0; }

/**
 * Reason a single op is not a supported create/overwrite/delete/delete-dir/config-edit/
 * config-block-delete op, or null when it is valid. A create/overwrite needs a non-empty
 * `target` AND a string `content`; a delete/delete-dir needs a non-empty `target` and NO
 * content; a config-edit needs a non-empty `target`, a boolean `desired`, a `selector`
 * object, and NO `content` (it splices a single token); a config-block-delete needs a
 * non-empty `target` and a `selector` object, with NO `content` AND NO `desired` (it
 * removes a whole block, not a value). Kind errors and missing-field errors carry distinct
 * codes. Pure.
 * @param {unknown} op
 * @returns {{code:string, message:string}|null}
 */
export function invalidOpReason(op) {
  const obj = op && typeof op === 'object';
  const isWrite = obj && WRITABLE_KINDS.includes(op.kind);
  const isDelete = obj && DELETABLE_KINDS.includes(op.kind);
  const isDirDelete = obj && DIR_DELETABLE_KINDS.includes(op.kind);
  const isConfigEdit = obj && CONFIG_EDIT_KINDS.includes(op.kind);
  const isConfigBlockDelete = obj && CONFIG_BLOCK_DELETE_KINDS.includes(op.kind);
  const isJsonEdit = obj && JSON_EDIT_KINDS.includes(op.kind);
  const isJsonMapSet = obj && JSON_MAP_SET_KINDS.includes(op.kind);
  if (!isWrite && !isDelete && !isDirDelete && !isConfigEdit && !isConfigBlockDelete && !isJsonEdit && !isJsonMapSet) {
    return { code: 'apply-op-kind-unsupported',
      message: `apply supports only ${[...WRITABLE_KINDS, ...DELETABLE_KINDS, ...DIR_DELETABLE_KINDS, ...CONFIG_EDIT_KINDS, ...CONFIG_BLOCK_DELETE_KINDS, ...JSON_EDIT_KINDS, ...JSON_MAP_SET_KINDS].join('/')} ops` };
  }
  if (!isNonEmptyStr(op.target)) {
    return { code: 'apply-op-invalid', message: 'op must have a non-empty string target' };
  }
  if (isWrite && typeof op.content !== 'string') {
    return { code: 'apply-op-invalid', message: 'create/overwrite op must have a string content' };
  }
  if (isConfigEdit) {
    if (typeof op.desired !== 'boolean') return { code: 'apply-op-invalid', message: 'config-edit op must have a boolean desired' };
    if (!op.selector || typeof op.selector !== 'object') return { code: 'apply-op-invalid', message: 'config-edit op must have a selector object' };
    if (op.content !== undefined) return { code: 'apply-op-invalid', message: 'config-edit op must not carry content' };
  }
  if (isConfigBlockDelete) {
    if (!op.selector || typeof op.selector !== 'object') return { code: 'apply-op-invalid', message: 'config-block-delete op must have a selector object' };
    if (op.content !== undefined) return { code: 'apply-op-invalid', message: 'config-block-delete op must not carry content' };
    if (op.desired !== undefined) return { code: 'apply-op-invalid', message: 'config-block-delete op must not carry desired' };
  }
  if (isJsonEdit) {
    if (typeof op.desired !== 'boolean') return { code: 'apply-op-invalid', message: 'json-edit op must have a boolean desired' };
    if (!op.selector || typeof op.selector !== 'object') return { code: 'apply-op-invalid', message: 'json-edit op must have a selector object' };
    if (op.content !== undefined) return { code: 'apply-op-invalid', message: 'json-edit op must not carry content' };
  }
  if (isJsonMapSet) {
    if (!op.selector || typeof op.selector !== 'object') return { code: 'apply-op-invalid', message: 'json-map-set op must have a selector object' };
    if (!isNonEmptyStr(op.selector.mapKey) || !isNonEmptyStr(op.selector.memberKey)) return { code: 'apply-op-invalid', message: 'json-map-set selector must have non-empty mapKey and memberKey' };
    if (typeof op.value !== 'string') return { code: 'apply-op-invalid', message: 'json-map-set op must have a string value' };
    if (op.content !== undefined) return { code: 'apply-op-invalid', message: 'json-map-set op must not carry content' };
    if (op.desired !== undefined) return { code: 'apply-op-invalid', message: 'json-map-set op must not carry desired' };
  }
  return null;
}
