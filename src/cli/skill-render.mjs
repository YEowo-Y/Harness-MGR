/**
 * skill propose table renderer (P5.U8 sub-unit C) — extracted from render.mjs to
 * keep that module under the 200-SLOC lint ceiling (the hooks-render.mjs /
 * snapshot-store-render.mjs precedent).
 *
 * Renders a flat summary block (status / name / proposal / changed / provenance)
 * followed by the RAW unified-diff text — mirroring how configDiffTable surfaces
 * the unified diff (render.mjs). The unified text is the diff between the current
 * SKILL.md and the proposed --from bytes (already redacted upstream in
 * skill-command.mjs, so this renderer just prints it).
 *
 * Defensive on malformed input (missing fields → empty/safe lines); pure; never
 * throws.
 */

/** True for a non-null, non-array object. @param {unknown} v */
function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

/**
 * skill:propose → a flat summary header then the raw unified diff block.
 * @param {unknown} r the skill propose command result (summarizeProposal shape)
 * @returns {string}
 */
export function skillProposeTable(r) {
  const o = isObj(r) ? r : {};
  const lines = [
    `status: ${scalar(o.status)}`,
    `name: ${scalar(o.name)}`,
    `proposal: ${scalar(o.proposalId)}`,
    `target: ${scalar(o.target)}`,
    `changed: ${scalar(o.changed)}`,
  ];
  // Provenance is only meaningful on the apply path; show it when present.
  if (o.provenanceWritten === true || o.provenanceWritten === false) {
    lines.push(`provenanceWritten: ${scalar(o.provenanceWritten)}`);
  }
  const unified = typeof o.unified === 'string' ? o.unified : '';
  if (unified.length > 0) {
    lines.push('', unified);
  }
  return lines.join('\n');
}

/**
 * skill:accept → a flat summary block (status / name / proposal / stale /
 * snapshotId / overwritten). No diff block — accept is an overwrite, not a preview
 * of two files. Defensive on malformed input (missing fields → empty lines); pure;
 * never throws.
 * @param {unknown} r the skill accept command result (summarizeAccept shape)
 * @returns {string}
 */
export function skillAcceptTable(r) {
  const o = isObj(r) ? r : {};
  return [
    `status: ${scalar(o.status)}`,
    `name: ${scalar(o.name)}`,
    `proposal: ${scalar(o.proposalId)}`,
    `skill: ${scalar(o.skillPath)}`,
    `stale: ${scalar(o.stale)}`,
    `snapshotId: ${scalar(o.snapshotId)}`,
    `overwritten: ${scalar(o.overwritten)}`,
  ].join('\n');
}

/**
 * skill:visibility → a flat summary block (status / name / state / target / alreadyInState /
 * snapshotId) plus the one-line before→after diff when present. Defensive on malformed input
 * (missing fields → empty lines); pure; never throws.
 * @param {unknown} r the skill visibility command result (summarize shape)
 * @returns {string}
 */
export function skillVisibilityTable(r) {
  const o = isObj(r) ? r : {};
  const lines = [
    `status: ${scalar(o.status)}`,
    `name: ${scalar(o.name)}`,
    `state: ${scalar(o.state)}`,
    `target: ${scalar(o.target)}`,
    `alreadyInState: ${scalar(o.alreadyInState)}`,
  ];
  if (o.snapshotId) lines.push(`snapshotId: ${scalar(o.snapshotId)}`);
  const diff = isObj(o.diff) ? o.diff : null;
  if (diff && (diff.before !== undefined || diff.after !== undefined)) {
    lines.push('', `- ${scalar(diff.before)}`, `+ ${scalar(diff.after)}`);
  }
  return lines.join('\n');
}

/** Coerce a value to a one-line, safe string for a summary line. @param {unknown} v */
function scalar(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') { try { return JSON.stringify(v); } catch { return String(v); } }
  return String(v);
}
