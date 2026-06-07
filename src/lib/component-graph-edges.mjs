/**
 * ComponentGraph edge extraction (P4b.U2) — frontmatter-ref pass.
 *
 * Fills the `edges` array of a ComponentGraph (built by buildComponentGraph in
 * component-graph.mjs) by reading well-known structured reference fields from
 * each node's frontmatter.  The result is a directed graph where an edge A→B
 * means "A references B; removing B may break A".
 *
 * --- What is implemented (frontmatter-ref) ---
 * Three skill frontmatter fields carry component references on the real harness:
 *   skill.agent      — a single agent name (string), e.g. "tracer"
 *   skill.next-skill — a single skill name (string), e.g. "plan"
 *   skill.pipeline   — a bracket-wrapped comma list, e.g. "[deep-dive, plan]"
 * Each resolves to one or more `frontmatter-ref` edges: skill→agent or skill→skill.
 *
 * --- What is EXCLUDED / DEFERRED ---
 * skill.handoff (a PATH/glob like ".omc/specs/x.md") and skill.handoff-policy
 * (an enum like "approval-required") are NOT component references — including them
 * would produce false-positive edges.  They are explicitly excluded here.
 *
 * The remaining three EDGE_KINDS are deferred:
 *   settings-pointer   — needs parsed settings layers not present in ComponentRecord[]
 *   hook-command-path  — needs resolved hook facts; weak component-targeting signal
 *   manifest-include   — no manifest-file convention found on the real harness in U2 scout
 * Document them here so a future U3 knows exactly where to add them.
 *
 * --- Layering constraint ---
 * Same as component-graph.mjs: imports ONLY src/lib/diagnostic.mjs at runtime.
 * NO analysis/**, NO paths.mjs, NO reexport.mjs (M2-safe).
 *
 * Pure, never-throws, deterministic (iterates nodes in graph.nodes order; fields
 * in REFERENCE_FIELDS table order; pipeline tokens in list order).
 */

import { addEdge } from './component-graph.mjs';

/**
 * @typedef {import('./component-graph.mjs').ComponentGraph} ComponentGraph
 */

/**
 * Describes one structured reference field in a component's frontmatter.
 *
 * @typedef {Object} ReferenceField
 * @property {string} sourceKind  kind of the node that carries this field
 * @property {string} field       frontmatter key
 * @property {string} targetKind  kind of the referenced node
 */

/**
 * The complete table of structured frontmatter reference fields for the user-tier
 * component set.  Grounded in a scout of the real harness (2026-06-07).
 *
 * @type {ReadonlyArray<ReferenceField>}
 */
export const REFERENCE_FIELDS = Object.freeze([
  { sourceKind: 'skill', field: 'agent',      targetKind: 'agent' },
  { sourceKind: 'skill', field: 'next-skill', targetKind: 'skill' },
  { sourceKind: 'skill', field: 'pipeline',   targetKind: 'skill' },
]);

/**
 * Parse a raw frontmatter value into a list of bare component names.
 *
 * Accepts:
 *   - a plain string:           "tracer"          -> ["tracer"]
 *   - a bracket-wrapped list:   "[a, b, c]"       -> ["a","b","c"]
 *
 * Rejects (returns []) for any value that is not a string.
 * Per-token filtering: drops empty tokens, and any token that contains a path
 * separator (/ or \) or starts with "." so that stray path values (e.g. a
 * skill.handoff glob that somehow slips through) never become component names.
 *
 * @param {unknown} raw
 * @returns {string[]}
 */
export function parseRefValue(raw) {
  if (typeof raw !== 'string') return [];

  let s = raw.trim();
  // Strip a single surrounding [ ... ] pair if present.
  if (s.startsWith('[') && s.endsWith(']')) {
    s = s.slice(1, -1);
  }

  return s
    .split(',')
    .map((tok) => tok.trim())
    .filter((tok) => {
      if (tok.length === 0) return false;
      if (tok.startsWith('.')) return false;
      if (tok.includes('/') || tok.includes('\\')) return false;
      return true;
    });
}

/**
 * Extract frontmatter-ref edges from every node in the graph and add them via
 * `addEdge`.  The graph is mutated in place (edges[] is filled).  The same graph
 * is returned so callers can chain: `const g = extractEdges(buildComponentGraph(…))`.
 *
 * `addEdge` already silently rejects:
 *   - self-edges  (a pipeline that lists its own skill)
 *   - dangling refs (target not in byId — normal for plugin/builtin components)
 *   - duplicate (source, target, kind) triples
 *
 * So `extractEdges` is naturally conservative: it never throws and never produces
 * spurious edges even when called twice (idempotent, because addEdge deduplicates).
 *
 * Iteration order is deterministic: graph.nodes (sorted by id in buildComponentGraph)
 * → REFERENCE_FIELDS table order → pipeline tokens in list order.
 *
 * @param {ComponentGraph} graph
 * @returns {ComponentGraph}
 */
export function extractEdges(graph) {
  try {
    if (!graph || typeof graph !== 'object') return graph;
    if (!Array.isArray(graph.nodes)) return graph;

    for (const node of graph.nodes) {
      if (!node || typeof node !== 'object') continue;
      const { id: sourceId, kind, frontmatter } = node;
      if (typeof sourceId !== 'string' || typeof kind !== 'string') continue;
      if (!frontmatter || typeof frontmatter !== 'object') continue;

      for (const row of REFERENCE_FIELDS) {
        if (row.sourceKind !== kind) continue;

        const raw = frontmatter[row.field];
        const names = parseRefValue(raw);

        for (const name of names) {
          const targetId = `${row.targetKind}:${name}`;
          // addEdge handles all rejection silently (dangling, self, dedup).
          addEdge(graph, sourceId, targetId, 'frontmatter-ref');
        }
      }
    }
  } catch {
    // never-throws: any unexpected error is silently swallowed.
  }

  return graph;
}
