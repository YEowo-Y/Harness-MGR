/**
 * health table renderer (P5.U5) — the SEVERITY-LAYERED human view (the owner's
 * "报警" ask), extracted from render.mjs like hooks-render.mjs to keep that
 * module under the 200-SLOC lint ceiling.
 *
 * FIXED tier order (golden-pinned by test/cli-health.test.mjs):
 *   1. summary headline  — total / loadable / degraded / not-loaded counts
 *   2. [!!] not-loaded   — one row per component: kind name — worst reason
 *   3. [! ] degraded     — same row shape
 *   4. advice            — records grouped error → warn → info, each
 *                          `[marker] title — first affectedPath` + `fix:` line
 *   5. hooks             — PROBLEM lines only (missing → [!!], then
 *                          indeterminate → [! ]); a fully-resolved set renders
 *                          one OK summary line; no entries → 'none configured'
 *
 * Empty component/advice tiers render a single '  none' line (pinned choice —
 * a visible empty tier beats a silently missing section). Markers are TEXTUAL
 * ([!!] / [! ] / [i ]) — plain-by-default, no color codes (table.mjs
 * convention); blocks are separated by one blank line.
 *
 * Defensive on malformed input (non-object records skipped, missing fields →
 * empty strings); pure; never throws.
 */

/** Severity → textual marker (error/warn/info). */
const MARKERS = Object.freeze({ error: '[!!]', warn: '[! ]', info: '[i ]' });

/** Advice tiers in render order (worst first). */
const ADVICE_TIERS = Object.freeze(['error', 'warn', 'info']);

/** True for a non-null, non-array object. @param {unknown} v */
function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

/** String when string, else ''. @param {unknown} v @returns {string} */
function str(v) { return typeof v === 'string' ? v : ''; }

/** Finite number when number, else 0. @param {unknown} v @returns {number} */
function num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : 0; }

/**
 * The full severity-layered body for the `health` result. Never throws.
 * @param {unknown} r  the health command result ({health, advice, hooks})
 * @returns {string}
 */
export function healthTable(r) {
  try {
    const root = isObj(r) ? r : {};
    const health = isObj(root.health) ? root.health : {};
    const components = Array.isArray(health.components) ? health.components : [];
    /** @type {string[]} */
    const lines = [summaryLine(isObj(health.summary) ? health.summary : {}), ''];
    pushComponentTier(lines, components, 'not-loaded', MARKERS.error);
    lines.push('');
    pushComponentTier(lines, components, 'degraded', MARKERS.warn);
    lines.push('');
    pushAdviceTier(lines, isObj(root.advice) ? root.advice : {});
    lines.push('');
    pushHooksTier(lines, isObj(root.hooks) ? root.hooks : {});
    return lines.join('\n');
  } catch {
    return ''; // never-throws backstop — a hostile result renders as empty, not a crash
  }
}

/**
 * The headline counts line.
 * @param {Record<string, unknown>} s @returns {string}
 */
function summaryLine(s) {
  return `summary: total ${num(s.total)} — loadable ${num(s.loadable)}, degraded ${num(s.degraded)}, not-loaded ${num(s.notLoaded)}`;
}

/**
 * One component tier ([!!] not-loaded / [! ] degraded): header with count, then
 * `  kind name — worst reason message` rows (reasons are already sorted
 * worst-first by analyzeHealth, so reasons[0] is the worst), or '  none'.
 * @param {string[]} lines @param {unknown[]} components
 * @param {string} status @param {string} marker
 */
function pushComponentTier(lines, components, status, marker) {
  const rows = components.filter((c) => isObj(c) && c.status === status);
  lines.push(`${marker} ${status} (${rows.length})`);
  if (rows.length === 0) {
    lines.push('  none');
    return;
  }
  for (const c of rows) {
    const reasons = Array.isArray(c.reasons) ? c.reasons : [];
    const worst = isObj(reasons[0]) ? str(reasons[0].message) : '';
    const label = `${str(c.kind)} ${str(c.name)}`.trim();
    lines.push(worst ? `  ${label} — ${worst}` : `  ${label}`);
  }
}

/**
 * The advice tier: records grouped error → warn → info (a record with an
 * unknown severity is dropped — it has no tier), each as a `[marker] title`
 * line (plus ` — <first affectedPath>` when present) and an indented `fix:`.
 * @param {string[]} lines @param {Record<string, unknown>} advice
 */
function pushAdviceTier(lines, advice) {
  const all = Array.isArray(advice.advice) ? advice.advice : [];
  const usable = all.filter((a) => isObj(a) && ADVICE_TIERS.includes(/** @type {any} */ (a).severity));
  lines.push(`advice (${usable.length})`);
  if (usable.length === 0) {
    lines.push('  none');
    return;
  }
  for (const sev of ADVICE_TIERS) {
    for (const a of usable) {
      if (a.severity !== sev) continue;
      const paths = Array.isArray(a.affectedPaths) ? a.affectedPaths : [];
      const first = typeof paths[0] === 'string' ? paths[0] : '';
      lines.push(first ? `  ${MARKERS[sev]} ${str(a.title)} — ${first}` : `  ${MARKERS[sev]} ${str(a.title)}`);
      if (str(a.fix)) lines.push(`       fix: ${str(a.fix)}`);
    }
  }
}

/**
 * The hooks tier: PROBLEM lines only — missing entries first ([!!]), then
 * indeterminate ([! ]). A non-empty fully-resolved set renders ONE ok line;
 * an empty set renders 'none configured'.
 * @param {string[]} lines @param {Record<string, unknown>} hooks
 */
function pushHooksTier(lines, hooks) {
  const entries = (Array.isArray(hooks.explanations) ? hooks.explanations : []).filter(isObj);
  const missing = entries.filter((e) => e.status === 'missing');
  const indeterminate = entries.filter((e) => e.status === 'indeterminate');
  if (entries.length === 0) {
    lines.push('hooks: none configured');
    return;
  }
  const problems = missing.length + indeterminate.length;
  if (problems === 0) {
    lines.push(`hooks: ok — ${entries.length} entries, all resolved`);
    return;
  }
  lines.push(`hooks: ${problems} problem(s) of ${entries.length}`);
  for (const e of missing) lines.push(`  ${MARKERS.error} ${str(e.event)}: ${str(e.command)} — missing`);
  for (const e of indeterminate) lines.push(`  ${MARKERS.warn} ${str(e.event)}: ${str(e.command)} — indeterminate`);
}
