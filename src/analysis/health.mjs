/**
 * Health aggregation (P5.U2) — the per-component LOADABILITY view.
 *
 * Pure judgment over already-gathered facts: discovered ComponentRecords
 * (scan()), ConflictClusters (analyzeConflicts), and the flat path-bearing
 * Diagnostic[] channels from scan and doctor. Emits one HealthRecord per valid
 * component — loadable / degraded / not-loaded — plus a summary and a
 * scope×kind×status grouping. Feeds the P5.U5 `health` CLI command and the
 * TUI/MCP front-ends (module + tests only here, no CLI wiring — mirroring how
 * P2.U4 built the doctor scaffold before its CLI command).
 *
 * --- Purity (the drift.mjs precedent) ---
 * PURE: ZERO runtime imports (no fs/crypto/paths/DiagnosticBag). Reasons and
 * results are plain objects built inline; all I/O lives in discovery and the
 * caller hands every fact in. Never throws — junk input (non-array channels,
 * malformed records/clusters/diagnostics) degrades to silent skips.
 *
 * --- Association contract: EXACT path equality ---
 * A diagnostic (from either the scan or the doctor channel) attaches to a
 * component iff `diagnostic.path === component.path` — plain string equality,
 * NO normalization. Both sides come from the same scan of the same tree, so
 * the paths are byte-identical by construction; a path-less or foreign-path
 * diagnostic simply never attaches. Conflict-cluster membership is likewise
 * matched by exact `possibleWinners[i].path` / `likelyWinner.path` equality
 * within the SAME kind.
 *
 * --- Status semantics (severity-driven, deterministic) ---
 *   not-loaded ← SHADOWED LOSER: the component sits in a same-kind cluster's
 *                possibleWinners with path !== likelyWinner.path. NOTE the
 *                asymmetry: the attached reason keeps the cluster's own 'warn'
 *                severity, but the STATUS is 'not-loaded' because the verified
 *                loader rules say a shadowed copy does not load.
 *              ← ATTACHED ERROR: any error-severity diagnostic at the path.
 *   degraded   ← (when not already not-loaded) ATTACHED WARN at the path, OR
 *                being a cluster's likelyWinner — it loads but shadows others
 *                (reason code `${kind}-shadowing-winner`).
 *   loadable   ← otherwise. info-severity reasons are RECORDED in `reasons`
 *                but never change status.
 *
 * --- Grouping = the spec's "按 scope×kind×severity 分组" ---
 * `groups` aggregates scope×kind×STATUS: status IS the health severity axis of
 * this view; the per-record `worstSeverity` (error>warn>info) carries the
 * finer diagnostic tier for U5's alarm rendering.
 *
 * --- scope/tier mirror note ---
 * scope = component.source.tier when it is one of the four valid SourceTier
 * strings, else 'user' (the makeSource default). The 4-string list is
 * DUPLICATED locally from src/lib/source.mjs SOURCE_TIERS rather than imported
 * to honor the zero-runtime-imports purity stance — keep in sync if a tier is
 * ever added.
 *
 * @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic
 * @typedef {import('../discovery/components.mjs').ComponentRecord} ComponentRecord
 * @typedef {import('./conflicts.mjs').ConflictCluster} ConflictCluster
 */

/**
 * @typedef {Object} HealthReason
 * @property {string} code
 * @property {'error'|'warn'|'info'} severity
 * @property {string} message
 */

/**
 * @typedef {Object} HealthRecord
 * @property {string} kind
 * @property {string} name
 * @property {string} path
 * @property {string} scope                          source tier ('user' fallback)
 * @property {'loadable'|'degraded'|'not-loaded'} status
 * @property {'error'|'warn'|'info'|null} worstSeverity
 * @property {HealthReason[]} reasons                deduped, severity-rank/code/message sorted
 */

/**
 * @typedef {Object} HealthGroup
 * @property {string} scope
 * @property {string} kind
 * @property {'loadable'|'degraded'|'not-loaded'} status
 * @property {number} count
 * @property {string[]} names  sorted component names in the group
 */

/**
 * @typedef {Object} HealthResult
 * @property {HealthRecord[]} components  sorted by (kind, name, path)
 * @property {{ total: number, loadable: number, degraded: number, notLoaded: number }} summary
 * @property {HealthGroup[]} groups       non-empty only, sorted (scope, kind, status order)
 * @property {Diagnostic[]} diagnostics   always [] (pure judgment emits no own diagnostics)
 */

/** Health statuses in severity order (best → worst); also the group sort order. */
export const HEALTH_STATUSES = Object.freeze(['loadable', 'degraded', 'not-loaded']);

// Local mirror of src/lib/source.mjs SOURCE_TIERS (deliberately NOT imported — purity; header).
const VALID_TIERS = Object.freeze(['user', 'plugin', 'catalog', 'marketplace-copy']);

/** Diagnostic severities, worst first (index = rank used for sorting/worstSeverity). */
const SEVERITIES = Object.freeze(['error', 'warn', 'info']);

/**
 * Code-unit string compare (locale-independent, mirrors conflicts.mjs cmp).
 * @param {string} a @param {string} b @returns {number}
 */
function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * @param {unknown} v @returns {unknown[]} v when it is an array, else []
 */
function arr(v) {
  return Array.isArray(v) ? v : [];
}

/**
 * A valid component carries non-empty string kind/name/path (mirrors the
 * conflicts.mjs/load-order.mjs eligibility stance: skip, never throw).
 * @param {unknown} rec @returns {boolean}
 */
function isValidComponent(rec) {
  return !!rec && typeof rec === 'object'
    && typeof (/** @type {any} */ (rec).kind) === 'string' && (/** @type {any} */ (rec).kind).length > 0
    && typeof (/** @type {any} */ (rec).name) === 'string' && (/** @type {any} */ (rec).name).length > 0
    && typeof (/** @type {any} */ (rec).path) === 'string' && (/** @type {any} */ (rec).path).length > 0;
}

/**
 * scope = source.tier when valid, else 'user' (the makeSource default — header note).
 * @param {any} rec @returns {string}
 */
function scopeOf(rec) {
  const t = rec.source && typeof rec.source === 'object' ? rec.source.tier : undefined;
  return typeof t === 'string' && VALID_TIERS.includes(t) ? t : 'user';
}

/**
 * Append a reason to a Map<string, HealthReason[]> bucket.
 * @param {Map<string, HealthReason[]>} map @param {string} key @param {HealthReason} reason
 */
function push(map, key, reason) {
  const list = map.get(key);
  if (list) list.push(reason);
  else map.set(key, [reason]);
}

/**
 * Index path-bearing diagnostics from both channels by exact path. Entries
 * without a string path or with an unknown severity are skipped (junk
 * tolerance). Map keys are untrusted strings — Map is proto-poisoning safe.
 * @param {unknown[]} channels
 * @returns {Map<string, HealthReason[]>}
 */
function indexDiagnostics(channels) {
  /** @type {Map<string, HealthReason[]>} */
  const byPath = new Map();
  for (const channel of channels) {
    for (const d of arr(channel)) {
      if (!d || typeof d !== 'object') continue;
      const { path, severity, code, message } = /** @type {any} */ (d);
      if (typeof path !== 'string' || path.length === 0) continue;
      if (!SEVERITIES.includes(severity)) continue;
      push(byPath, path, {
        code: typeof code === 'string' ? code : '',
        severity,
        message: typeof message === 'string' ? message : '',
      });
    }
  }
  return byPath;
}

/**
 * Index conflict clusters into loser/winner reason maps keyed `${kind}\n${path}`
 * (\n cannot appear in a kind or a real path — same trick as conflicts.mjs).
 * Malformed clusters (no string kind, no usable members, no likelyWinner.path)
 * and degenerate single-member clusters (mirrors doctor #11's guard) are skipped.
 * @param {unknown} conflicts
 * @returns {{ losers: Map<string, HealthReason[]>, winners: Map<string, HealthReason[]> }}
 */
function indexClusters(conflicts) {
  /** @type {Map<string, HealthReason[]>} */
  const losers = new Map();
  /** @type {Map<string, HealthReason[]>} */
  const winners = new Map();
  for (const c of arr(conflicts)) {
    if (!c || typeof c !== 'object' || typeof (/** @type {any} */ (c).kind) !== 'string') continue;
    const { kind, likelyWinner, possibleWinners, confidence } = /** @type {any} */ (c);
    const members = arr(possibleWinners)
      .filter((m) => !!m && typeof m === 'object' && typeof (/** @type {any} */ (m).path) === 'string');
    if (members.length < 2) continue; // a single member is not a conflict (doctor #11 guard)
    const winnerPath = likelyWinner && typeof likelyWinner === 'object' && typeof likelyWinner.path === 'string'
      ? likelyWinner.path : null;
    if (winnerPath === null) continue; // cannot tell winner from loser
    const conf = typeof confidence === 'string' ? confidence : 'likely';
    const winnerName = typeof likelyWinner.name === 'string' ? likelyWinner.name : '(unknown)';
    for (const m of /** @type {any[]} */ (members)) {
      if (m.path === winnerPath) {
        push(winners, `${kind}\n${m.path}`, {
          code: `${kind}-shadowing-winner`,
          severity: 'warn',
          message: `loads but shadows ${members.length - 1} other(s); confidence ${conf}`,
        });
      } else {
        push(losers, `${kind}\n${m.path}`, {
          code: `${kind}-shadowing`,
          severity: 'warn',
          message: `shadowed by '${winnerName}' (${winnerPath}); confidence ${conf}`,
        });
      }
    }
  }
  return { losers, winners };
}

/**
 * Dedupe identical {severity,code,message} triples, then sort by severity rank
 * (error > warn > info), code, message. Returns a NEW array.
 * @param {HealthReason[]} reasons @returns {HealthReason[]}
 */
function dedupeSortReasons(reasons) {
  const seen = new Set();
  /** @type {HealthReason[]} */
  const out = [];
  for (const r of reasons) {
    const k = `${r.severity}\n${r.code}\n${r.message}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  out.sort((a, b) => (SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity))
    || cmp(a.code, b.code) || cmp(a.message, b.message));
  return out;
}

/**
 * Highest severity among reasons (error > warn > info), null when empty.
 * @param {HealthReason[]} reasons @returns {'error'|'warn'|'info'|null}
 */
function worstOf(reasons) {
  let idx = Infinity;
  for (const r of reasons) {
    const i = SEVERITIES.indexOf(r.severity);
    if (i !== -1 && i < idx) idx = i;
  }
  return idx === Infinity ? null : /** @type {any} */ (SEVERITIES[idx]);
}

/**
 * Build one HealthRecord per the status semantics table (module header).
 * @param {any} rec
 * @param {Map<string, HealthReason[]>} diagIndex
 * @param {Map<string, HealthReason[]>} losers
 * @param {Map<string, HealthReason[]>} winners
 * @returns {HealthRecord}
 */
function buildRecord(rec, diagIndex, losers, winners) {
  const key = `${rec.kind}\n${rec.path}`;
  const loserReasons = losers.get(key) ?? [];
  const winnerReasons = winners.get(key) ?? [];
  const attached = diagIndex.get(rec.path) ?? [];

  const hasError = attached.some((r) => r.severity === 'error');
  const hasWarn = attached.some((r) => r.severity === 'warn');
  let status = 'loadable';
  if (loserReasons.length > 0 || hasError) status = 'not-loaded';
  else if (hasWarn || winnerReasons.length > 0) status = 'degraded';

  const reasons = dedupeSortReasons([...loserReasons, ...attached, ...winnerReasons]);
  return {
    kind: rec.kind,
    name: rec.name,
    path: rec.path,
    scope: scopeOf(rec),
    status: /** @type {any} */ (status),
    worstSeverity: worstOf(reasons),
    reasons,
  };
}

/**
 * Aggregate records into non-empty scope×kind×status groups, names sorted,
 * groups sorted by (scope, kind, status in HEALTH_STATUSES order).
 * @param {HealthRecord[]} records @returns {HealthGroup[]}
 */
function buildGroups(records) {
  /** @type {Map<string, HealthGroup>} */
  const map = new Map();
  for (const r of records) {
    const key = `${r.scope}\n${r.kind}\n${r.status}`;
    const g = map.get(key);
    if (g) {
      g.count += 1;
      g.names.push(r.name);
    } else {
      map.set(key, { scope: r.scope, kind: r.kind, status: r.status, count: 1, names: [r.name] });
    }
  }
  const groups = [...map.values()];
  for (const g of groups) g.names.sort(cmp);
  groups.sort((a, b) => cmp(a.scope, b.scope) || cmp(a.kind, b.kind)
    || (HEALTH_STATUSES.indexOf(a.status) - HEALTH_STATUSES.indexOf(b.status)));
  return groups;
}

/**
 * Analyze per-component loadability health. Pure; never throws; inputs are
 * never mutated. See the module header for the status semantics.
 *
 * @param {{ components?: ComponentRecord[], conflicts?: ConflictCluster[],
 *           diagnostics?: Diagnostic[], doctorDiagnostics?: Diagnostic[] }} [input]
 * @returns {HealthResult}
 */
export function analyzeHealth(input = {}) {
  const { components, conflicts, diagnostics, doctorDiagnostics } = input ?? {};
  const diagIndex = indexDiagnostics([diagnostics, doctorDiagnostics]);
  const { losers, winners } = indexClusters(conflicts);

  /** @type {HealthRecord[]} */
  const records = [];
  for (const rec of arr(components)) {
    if (!isValidComponent(rec)) continue;
    records.push(buildRecord(rec, diagIndex, losers, winners));
  }
  records.sort((a, b) => cmp(a.kind, b.kind) || cmp(a.name, b.name) || cmp(a.path, b.path));

  const summary = { total: records.length, loadable: 0, degraded: 0, notLoaded: 0 };
  for (const r of records) {
    if (r.status === 'loadable') summary.loadable += 1;
    else if (r.status === 'degraded') summary.degraded += 1;
    else summary.notLoaded += 1;
  }

  return { components: records, summary, groups: buildGroups(records), diagnostics: [] };
}
