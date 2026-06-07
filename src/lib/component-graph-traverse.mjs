/**
 * ComponentGraph traversal (P4b.U3) — BFS cascade traversal + preview builder.
 *
 * Provides the pure CASCADE logic for Phase-4b's `--cascade` operation: given a
 * target component, answer "what else would need to be removed?" by walking the
 * directed dependency graph. The result is preview DATA only — no deletes, no I/O,
 * no paths.mjs import.
 *
 * --- Traversal direction (opts.direction) ---
 * 'dependents' (DEFAULT):
 *   For each visited node V, follow edges whose TARGET is V (incoming edges),
 *   collecting the SOURCE node of each such edge. These are components that depend
 *   on V — "removing V may break them", so they are included in the cascade set.
 *   This is the plan's default cascade semantics: "remove target + everything
 *   that references it transitively."
 *
 * 'dependencies':
 *   For each visited node V, follow edges whose SOURCE is V (outgoing edges),
 *   collecting the TARGET node. These are components V depends on.
 *   Useful for "what would I lose if I remove this whole sub-tree".
 *
 * --- Cycle safety ---
 * A visited Set guards every BFS expansion. A cycle in the graph (A->B and B->A)
 * terminates: both nodes are visited once, then no new nodes are enqueued.
 *
 * --- Layering constraint ---
 * src/lib/ layer — imports ONLY sibling lib modules + node stdlib if needed.
 * NO analysis/**, NO paths.mjs, NO reexport.mjs. M2-safe.
 *
 * Pure, never-throws, deterministic (stable BFS; cascadePreview sorts by id).
 * Zero npm deps.
 *
 * @module component-graph-traverse
 */

/**
 * @typedef {import('./component-graph.mjs').ComponentGraph} ComponentGraph
 * @typedef {import('./component-graph.mjs').GraphNode} GraphNode
 * @typedef {import('./component-graph.mjs').GraphEdge} GraphEdge
 */

/**
 * Options for cascadeSet and cascadePreview.
 *
 * @typedef {Object} CascadeOpts
 * @property {'dependents'|'dependencies'} [direction='dependents']
 *   'dependents': follow incoming edges (find everything that depends on the target).
 *   'dependencies': follow outgoing edges (find everything the target depends on).
 */

/**
 * Result of cascadeSet.
 *
 * @typedef {Object} CascadeSetResult
 * @property {string} target      the targetId as given
 * @property {string[]} ids       ids of the cascade set EXCLUDING the target, in BFS discovery order
 * @property {string[]} order     same as ids (BFS layers; alias for caller clarity)
 * @property {GraphEdge[]} edges  every edge inspected during BFS, including edges that lead back to
 *   already-visited nodes (e.g. the second edge in a cycle A→B, B→A). NOT deduped and NOT in
 *   1-to-1 correspondence with wouldRemove nodes. To derive the removal set, use ids/wouldRemove —
 *   do NOT count or deduplicate edges.
 */

/**
 * A compact node summary for preview display.
 *
 * @typedef {Object} NodeSummary
 * @property {string} id
 * @property {string} kind
 * @property {string} name
 * @property {string} path
 */

/**
 * Result of cascadePreview.
 *
 * @typedef {Object} CascadePreviewResult
 * @property {NodeSummary|null} target        summary of the target node, or null if not in graph
 * @property {'dependents'|'dependencies'} direction  the traversal direction used
 * @property {NodeSummary[]} wouldRemove      cascade set summaries, sorted by id
 * @property {number} total                  wouldRemove.length
 */

// ─── internal helpers ─────────────────────────────────────────────────────────

/**
 * Build adjacency indices (incoming and outgoing) from the graph's edge list.
 * Returns {incoming: Map<targetId, GraphEdge[]>, outgoing: Map<sourceId, GraphEdge[]>}.
 * Pure, never-throws.
 *
 * @param {ComponentGraph} graph
 * @returns {{ incoming: Map<string, GraphEdge[]>, outgoing: Map<string, GraphEdge[]> }}
 */
function buildAdjacency(graph) {
  /** @type {Map<string, GraphEdge[]>} */
  const incoming = new Map();
  /** @type {Map<string, GraphEdge[]>} */
  const outgoing = new Map();

  const edges = Array.isArray(graph.edges) ? graph.edges : [];
  for (const edge of edges) {
    if (!edge || typeof edge !== 'object') continue;
    if (typeof edge.source !== 'string' || typeof edge.target !== 'string') continue;

    const inc = incoming.get(edge.target);
    if (inc) inc.push(edge); else incoming.set(edge.target, [edge]);

    const out = outgoing.get(edge.source);
    if (out) out.push(edge); else outgoing.set(edge.source, [edge]);
  }

  return { incoming, outgoing };
}

/**
 * Extract a compact NodeSummary from a GraphNode.
 *
 * @param {GraphNode} node
 * @returns {NodeSummary}
 */
function toSummary(node) {
  return {
    id: node.id,
    kind: node.kind,
    name: node.name,
    path: node.path,
  };
}

// ─── exported API ─────────────────────────────────────────────────────────────

/**
 * Compute the transitive cascade set for a target node using BFS.
 *
 * Returns the set of node ids that would need to be considered for removal
 * alongside the target. The target itself is EXCLUDED from the returned ids.
 *
 * If targetId is not present in graph.byId, returns an empty set ({ ids: [] })
 * without throwing. Any malformed input is handled gracefully.
 *
 * @param {ComponentGraph} graph
 * @param {string} targetId
 * @param {CascadeOpts} [opts]
 * @returns {CascadeSetResult}
 */
export function cascadeSet(graph, targetId, opts) {
  const EMPTY = { target: String(targetId ?? ''), ids: [], order: [], edges: [] };

  try {
    if (!graph || typeof graph !== 'object') return EMPTY;
    if (!graph.byId || !(graph.byId instanceof Map)) return EMPTY;
    if (typeof targetId !== 'string' || !graph.byId.has(targetId)) return EMPTY;

    const direction = (opts && opts.direction === 'dependencies') ? 'dependencies' : 'dependents';
    const { incoming, outgoing } = buildAdjacency(graph);

    /** @type {string[]} ids in BFS discovery order */
    const ids = [];
    /** @type {GraphEdge[]} traversed edges */
    const traversedEdges = [];
    /** @type {Set<string>} visited guard (includes the target itself) */
    const visited = new Set([targetId]);

    /** @type {string[]} BFS queue */
    const queue = [targetId];

    while (queue.length > 0) {
      const current = queue.shift();

      // Pick the right adjacency map based on direction.
      const neighbors = direction === 'dependents'
        ? (incoming.get(current) ?? [])   // incoming: A->current means A depends on current
        : (outgoing.get(current) ?? []);  // outgoing: current->B means current depends on B

      for (const edge of neighbors) {
        const neighborId = direction === 'dependents' ? edge.source : edge.target;
        traversedEdges.push(edge);
        if (!visited.has(neighborId)) {
          visited.add(neighborId);
          ids.push(neighborId);
          queue.push(neighborId);
        }
      }
    }

    return { target: targetId, ids, order: ids, edges: traversedEdges };
  } catch {
    return EMPTY;
  }
}

/**
 * Build a pure preview payload describing what a cascade removal would affect.
 *
 * Returns a structured object that the CLI renderer can display to the user
 * BEFORE any delete takes place. Performs NO I/O and NO deletion.
 *
 * If targetId is not present in the graph, target is null and wouldRemove is [].
 *
 * @param {ComponentGraph} graph
 * @param {string} targetId
 * @param {CascadeOpts} [opts]
 * @returns {CascadePreviewResult}
 */
export function cascadePreview(graph, targetId, opts) {
  const direction = (opts && opts.direction === 'dependencies') ? 'dependencies' : 'dependents';
  const EMPTY = { target: null, direction, wouldRemove: [], total: 0 };

  try {
    if (!graph || typeof graph !== 'object') return EMPTY;
    if (!graph.byId || !(graph.byId instanceof Map)) return EMPTY;
    if (typeof targetId !== 'string') return EMPTY;

    const targetNode = graph.byId.get(targetId);
    if (!targetNode) return EMPTY;

    const { ids } = cascadeSet(graph, targetId, opts);

    /** @type {NodeSummary[]} */
    const wouldRemove = ids
      .map((id) => {
        const node = graph.byId.get(id);
        return node ? toSummary(node) : null;
      })
      .filter(Boolean)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    return {
      target: toSummary(targetNode),
      direction,
      wouldRemove,
      total: wouldRemove.length,
    };
  } catch {
    return EMPTY;
  }
}
