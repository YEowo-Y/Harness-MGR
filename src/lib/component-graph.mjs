/**
 * ComponentGraph builder (P4b.U1) — node + edge-type vocabulary.
 *
 * Builds an in-memory directed graph over the discovered ComponentRecord set so
 * that the Phase-4b cascade operation can answer "what else must be touched when
 * I remove X?" without walking the filesystem a second time.
 *
 * --- Layering constraint ---
 * This module lives in src/lib/ BY DESIGN so that src/ops/cascade.mjs can import
 * it. The ops layer depends only on discovery + lib; it NEVER imports from
 * src/analysis/**. Therefore:
 *   - NO import of src/analysis/load-order.mjs (or any analysis module).
 *   - NO import of src/paths.mjs or src/lib/reexport.mjs (M2-safety).
 * Allowed runtime imports: src/lib/diagnostic.mjs + node stdlib if truly needed.
 * The ComponentRecord type is referenced only via a JSDoc @typedef comment
 * (runtime-erased), consistent with the rest of the lib layer.
 *
 * --- Node identity: `kind:name` ---
 * Each node's id is `${kind}:${name}`. For user-tier components this equals the
 * loader's resolution key (user-tier skills/agents/commands are flat — no plugin
 * namespace prefix). We do NOT import resolutionKey() from load-order.mjs; the
 * kind:name scheme is correct for the user tier and is all the cascade operation
 * needs. Plugin-tier components are not yet in scope for Phase 4b.
 *
 * --- Edges ---
 * Edges are DIRECTED: source REFERENCES / DEPENDS-ON target. An edge (A→B) means
 * "removing B may break A". Edges are EMPTY in U1 — the four extraction passes
 * (frontmatter-ref, settings-pointer, hook-command-path, manifest-include) land
 * in P4b.U2/U3. The addEdge primitive is provided now so U2 only fills edges.
 * Duplicate (source, target, kind) triples are silently deduped.
 *
 * --- Duplicate id behaviour ---
 * When two ComponentRecords share the same `kind:name` (a genuine conflict,
 * already detected by analyzeConflicts), the FIRST record wins and a
 * `component-graph-duplicate-id` warn diagnostic is emitted. We never throw.
 *
 * Pure, never-throws, zero npm deps. Node stdlib not needed — only
 * src/lib/diagnostic.mjs is imported at runtime.
 */

import { DiagnosticBag } from './diagnostic.mjs';

/**
 * @typedef {import('./diagnostic.mjs').Diagnostic} Diagnostic
 * @typedef {import('../discovery/components.mjs').ComponentRecord} ComponentRecord
 * @typedef {import('../discovery/components.mjs').ComponentKind} ComponentKind
 */

/**
 * The complete edge-type vocabulary. Each string names one kind of reference
 * edge that can exist between two components:
 *   frontmatter-ref      — a frontmatter field (e.g. `extends`) names another component
 *   settings-pointer     — settings.json references a component by name
 *   hook-command-path    — a hook's command string resolves to a component path
 *   manifest-include     — an explicit include/manifest list references a component
 *
 * @type {ReadonlyArray<'frontmatter-ref'|'settings-pointer'|'hook-command-path'|'manifest-include'>}
 */
export const EDGE_KINDS = Object.freeze([
  'frontmatter-ref',
  'settings-pointer',
  'hook-command-path',
  'manifest-include',
]);

/**
 * @typedef {'frontmatter-ref'|'settings-pointer'|'hook-command-path'|'manifest-include'} EdgeKind
 */

/**
 * A single node in the ComponentGraph.
 *
 * @typedef {Object} GraphNode
 * @property {string} id              `${kind}:${name}` — the loader identity for user-tier components
 * @property {ComponentKind} kind
 * @property {string} name
 * @property {string} path            absolute path to the component file (kept for display / uniqueness)
 * @property {Object} source          provenance (passed through from the ComponentRecord)
 * @property {Record<string,string>} frontmatter  raw parsed frontmatter fields
 *
 * NOTE: `source` and `frontmatter` are live aliases of the source ComponentRecord's fields,
 * not copies. Read-only access is safe; never mutate them (a write would modify the caller's record).
 */

/**
 * A directed edge between two nodes.
 *
 * @typedef {Object} GraphEdge
 * @property {string} source  id of the node that references/depends-on the target
 * @property {string} target  id of the referenced/depended-on node
 * @property {EdgeKind} kind  what type of reference this is
 */

/**
 * The ComponentGraph built by `buildComponentGraph`.
 *
 * @typedef {Object} ComponentGraph
 * @property {GraphNode[]} nodes        all nodes, sorted by id (deterministic)
 * @property {GraphEdge[]} edges        directed edges (empty until P4b.U2 fills them)
 * @property {Map<string, GraphNode>} byId    id → node (use for O(1) lookups)
 * @property {Map<string, GraphNode[]>} byName name → node[] (all nodes sharing a bare name across kinds)
 * @property {Diagnostic[]} diagnostics  duplicate-id warns + skipped-record warns
 */

const EDGE_KIND_SET = new Set(EDGE_KINDS);

/**
 * Build a ComponentGraph from a discovered component list.
 *
 * Never throws. A non-array `components` argument, or any record that is missing
 * a string `kind` or `name`, is skipped with a `component-graph-skipped-record`
 * warn diagnostic rather than throwing. Duplicate `kind:name` ids keep the first
 * record and emit a `component-graph-duplicate-id` warn.
 *
 * @param {ComponentRecord[]} components
 * @returns {ComponentGraph}
 */
export function buildComponentGraph(components) {
  const bag = new DiagnosticBag();

  /** @type {Map<string, GraphNode>} */
  const byId = new Map();
  /** @type {Map<string, GraphNode[]>} */
  const byName = new Map();

  const input = Array.isArray(components) ? components : [];

  for (const rec of input) {
    if (!rec || typeof rec !== 'object') {
      bag.add({ severity: 'warn', code: 'component-graph-skipped-record',
        message: 'skipped non-object component record', phase: 'component-graph' });
      continue;
    }
    if (typeof rec.kind !== 'string' || rec.kind.length === 0 ||
        typeof rec.name !== 'string' || rec.name.length === 0) {
      bag.add({ severity: 'warn', code: 'component-graph-skipped-record',
        message: `skipped record with missing/invalid kind or name (kind=${String(rec.kind)}, name=${String(rec.name)})`,
        phase: 'component-graph' });
      continue;
    }

    const id = `${rec.kind}:${rec.name}`;

    if (byId.has(id)) {
      bag.add({ severity: 'warn', code: 'component-graph-duplicate-id',
        message: `duplicate component id "${id}" — keeping first, ignoring subsequent`,
        path: typeof rec.path === 'string' ? rec.path : undefined,
        phase: 'component-graph' });
      continue;
    }

    /** @type {GraphNode} */
    const node = {
      id,
      kind: rec.kind,
      name: rec.name,
      path: typeof rec.path === 'string' ? rec.path : '',
      source: rec.source ?? {},
      frontmatter: rec.frontmatter && typeof rec.frontmatter === 'object' ? rec.frontmatter : {},
    };

    byId.set(id, node);

    const existing = byName.get(rec.name);
    if (existing) {
      existing.push(node);
    } else {
      byName.set(rec.name, [node]);
    }
  }

  // Nodes sorted by id for stable/deterministic output.
  const nodes = [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return {
    nodes,
    edges: [],
    byId,
    byName,
    diagnostics: bag.all(),
  };
}

/**
 * Add a directed edge to the graph. The edge is directed: `sourceId` REFERENCES /
 * DEPENDS-ON `targetId`. An edge (A→B) means "removing B may break A".
 *
 * Returns `true` when the edge was added, `false` when it was rejected (with the
 * reason being one of: unknown kind, unknown sourceId, unknown targetId, self-edge,
 * or duplicate triple). Never throws.
 *
 * @param {ComponentGraph} graph
 * @param {string} sourceId   id of the referencing node
 * @param {string} targetId   id of the referenced node
 * @param {EdgeKind} kind     must be a member of EDGE_KINDS
 * @returns {boolean}
 */
export function addEdge(graph, sourceId, targetId, kind) {
  try {
    if (!graph || typeof graph !== 'object') return false;
    if (!EDGE_KIND_SET.has(kind)) return false;
    if (typeof sourceId !== 'string' || typeof targetId !== 'string') return false;
    if (!graph.byId || !graph.byId.has(sourceId)) return false;
    if (!graph.byId.has(targetId)) return false;
    if (sourceId === targetId) return false;

    const edges = graph.edges;
    if (!Array.isArray(edges)) return false;

    // Dedup: reject if an identical (source, target, kind) triple already exists.
    for (const e of edges) {
      if (e.source === sourceId && e.target === targetId && e.kind === kind) return false;
    }

    edges.push({ source: sourceId, target: targetId, kind });
    return true;
  } catch {
    return false;
  }
}
