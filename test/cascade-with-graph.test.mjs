/**
 * Unit oracle for cascadeSet + cascadePreview (src/lib/component-graph-traverse.mjs).
 *
 * All graphs are synthetic (no filesystem reads).  Covers:
 *   - cascadeSet: chain traversal (dependents + dependencies)
 *   - cascadeSet: isolated target (no dependents)
 *   - cascadeSet: transitive multi-hop
 *   - cascadeSet: direction 'dependencies'
 *   - cascadeSet: cycle safety
 *   - cascadeSet: targetId not in graph -> { ids: [] }
 *   - cascadeSet: never-throws on junk input
 *   - cascadePreview: shape + sorted wouldRemove
 *   - cascadePreview: non-node target -> target:null
 *   - cascadePreview: never-throws
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildComponentGraph, addEdge } from '../src/lib/component-graph.mjs';
import { cascadeSet, cascadePreview } from '../src/lib/component-graph-traverse.mjs';

// ── helpers ───────────────────────────────────────────────────────────────────

/** Build a minimal ComponentRecord. */
const rec = (kind, name) => ({
  kind,
  name,
  path: `/fake/${kind}/${name}.md`,
  source: { tier: 'user' },
  frontmatter: {},
});

/**
 * Build a graph from a list of [kind,name] pairs and a list of
 * [sourceId, targetId] edge pairs (all 'frontmatter-ref').
 */
function makeGraph(nodes, edges = []) {
  const g = buildComponentGraph(nodes.map(([k, n]) => rec(k, n)));
  for (const [src, tgt] of edges) {
    addEdge(g, src, tgt, 'frontmatter-ref');
  }
  return g;
}

// ── cascadeSet: dependents direction (default) ────────────────────────────────

test('cascadeSet(dependents): chain C->B->A — removing A includes B and C', () => {
  // Edges: C depends on B (C->B), B depends on A (B->A)
  const g = makeGraph(
    [['skill', 'A'], ['skill', 'B'], ['skill', 'C']],
    [['skill:C', 'skill:B'], ['skill:B', 'skill:A']],
  );

  const result = cascadeSet(g, 'skill:A');
  assert.equal(result.target, 'skill:A');
  // BFS from A: incoming edges to A have source=skill:B → enqueue B
  //             incoming edges to B have source=skill:C → enqueue C
  assert.deepEqual(new Set(result.ids), new Set(['skill:B', 'skill:C']));
  assert.equal(result.ids.length, 2, 'no duplicates');
  // BFS order: B before C (B is found first from A's incoming edge)
  assert.equal(result.ids[0], 'skill:B');
  assert.equal(result.ids[1], 'skill:C');
  assert.deepEqual(result.order, result.ids, 'order is an alias of ids');
});

test('cascadeSet(dependents): targeting C — nothing depends on C, so ids=[]', () => {
  const g = makeGraph(
    [['skill', 'A'], ['skill', 'B'], ['skill', 'C']],
    [['skill:C', 'skill:B'], ['skill:B', 'skill:A']],
  );

  const result = cascadeSet(g, 'skill:C');
  assert.deepEqual(result.ids, [], 'C has no dependents');
  assert.deepEqual(result.edges, []);
});

test('cascadeSet(dependents): targeting B — only C depends on B', () => {
  const g = makeGraph(
    [['skill', 'A'], ['skill', 'B'], ['skill', 'C']],
    [['skill:C', 'skill:B'], ['skill:B', 'skill:A']],
  );

  const result = cascadeSet(g, 'skill:B');
  assert.deepEqual(result.ids, ['skill:C']);
});

test('cascadeSet(dependents): isolated node — no edges, ids=[]', () => {
  const g = makeGraph([['agent', 'solo']]);
  const result = cascadeSet(g, 'agent:solo');
  assert.deepEqual(result.ids, []);
  assert.deepEqual(result.edges, []);
});

test('cascadeSet(dependents): multiple dependents on one target', () => {
  // Both B and C depend directly on A
  const g = makeGraph(
    [['skill', 'A'], ['skill', 'B'], ['skill', 'C']],
    [['skill:B', 'skill:A'], ['skill:C', 'skill:A']],
  );
  const result = cascadeSet(g, 'skill:A');
  assert.deepEqual(new Set(result.ids), new Set(['skill:B', 'skill:C']));
  assert.equal(result.ids.length, 2);
});

// ── cascadeSet: direction 'dependencies' ──────────────────────────────────────

test('cascadeSet(dependencies): chain C->B->A — targeting C follows outgoing edges to B and A', () => {
  const g = makeGraph(
    [['skill', 'A'], ['skill', 'B'], ['skill', 'C']],
    [['skill:C', 'skill:B'], ['skill:B', 'skill:A']],
  );

  const result = cascadeSet(g, 'skill:C', { direction: 'dependencies' });
  assert.equal(result.target, 'skill:C');
  assert.deepEqual(new Set(result.ids), new Set(['skill:B', 'skill:A']));
  assert.equal(result.ids.length, 2);
  // BFS order: B before A
  assert.equal(result.ids[0], 'skill:B');
  assert.equal(result.ids[1], 'skill:A');
});

test('cascadeSet(dependencies): targeting A — no outgoing edges, ids=[]', () => {
  const g = makeGraph(
    [['skill', 'A'], ['skill', 'B'], ['skill', 'C']],
    [['skill:C', 'skill:B'], ['skill:B', 'skill:A']],
  );
  const result = cascadeSet(g, 'skill:A', { direction: 'dependencies' });
  assert.deepEqual(result.ids, []);
});

// ── cascadeSet: cycle safety ──────────────────────────────────────────────────

test('cascadeSet: cycle A->B and B->A — terminates and returns the other node', () => {
  const g = makeGraph(
    [['skill', 'A'], ['skill', 'B']],
    [['skill:A', 'skill:B'], ['skill:B', 'skill:A']],
  );

  // dependents of B: incoming edge to B has source A → include A; then incoming to A has source B → already visited
  const result = cascadeSet(g, 'skill:B');
  assert.deepEqual(result.ids, ['skill:A'], 'cycle terminates; B itself excluded');

  // dependencies of A: outgoing from A → B; outgoing from B → A (already visited)
  const depResult = cascadeSet(g, 'skill:A', { direction: 'dependencies' });
  assert.deepEqual(depResult.ids, ['skill:B']);
});

test('cascadeSet: longer cycle A->B->C->A — terminates with all nodes in cascade', () => {
  const g = makeGraph(
    [['skill', 'A'], ['skill', 'B'], ['skill', 'C']],
    [['skill:A', 'skill:B'], ['skill:B', 'skill:C'], ['skill:C', 'skill:A']],
  );

  // dependents of A: incoming edges to A have source C → include C;
  //                  incoming to C → include B; incoming to B → A (visited)
  const result = cascadeSet(g, 'skill:A');
  assert.deepEqual(new Set(result.ids), new Set(['skill:C', 'skill:B']));
  assert.equal(result.ids.length, 2, 'no infinite loop — 2 distinct other nodes');
});

// ── cascadeSet: unknown targetId ──────────────────────────────────────────────

test('cascadeSet: unknown targetId returns { ids: [] } without throwing', () => {
  const g = makeGraph([['skill', 'real']]);
  const result = cascadeSet(g, 'skill:ghost');
  assert.deepEqual(result.ids, []);
  assert.deepEqual(result.edges, []);
});

test('cascadeSet: empty string targetId returns { ids: [] }', () => {
  const g = makeGraph([['skill', 'real']]);
  const result = cascadeSet(g, '');
  assert.deepEqual(result.ids, []);
});

// ── cascadeSet: never-throws ──────────────────────────────────────────────────

test('cascadeSet: never throws on undefined graph', () => {
  assert.doesNotThrow(() => cascadeSet(undefined, 'skill:x'));
});

test('cascadeSet: never throws on null graph', () => {
  assert.doesNotThrow(() => cascadeSet(null, 'skill:x'));
});

test('cascadeSet: never throws on malformed graph (no byId)', () => {
  assert.doesNotThrow(() => cascadeSet({}, 'skill:x'));
  assert.doesNotThrow(() => cascadeSet({ byId: null, edges: [] }, 'skill:x'));
});

test('cascadeSet: never throws on non-string targetId', () => {
  const g = makeGraph([['skill', 'x']]);
  assert.doesNotThrow(() => cascadeSet(g, null));
  assert.doesNotThrow(() => cascadeSet(g, 42));
  assert.doesNotThrow(() => cascadeSet(g, undefined));
});

// ── cascadePreview shape ──────────────────────────────────────────────────────

test('cascadePreview: returns target summary + sorted wouldRemove + total', () => {
  // C->B->A: cascade of A includes B and C
  const g = makeGraph(
    [['skill', 'A'], ['skill', 'B'], ['skill', 'C']],
    [['skill:C', 'skill:B'], ['skill:B', 'skill:A']],
  );

  const preview = cascadePreview(g, 'skill:A');

  // target summary
  assert.ok(preview.target !== null, 'target is not null for a known node');
  assert.equal(preview.target.id, 'skill:A');
  assert.equal(preview.target.kind, 'skill');
  assert.equal(preview.target.name, 'A');
  assert.equal(preview.target.path, '/fake/skill/A.md');

  // wouldRemove is sorted by id
  assert.equal(preview.total, 2);
  const ids = preview.wouldRemove.map((s) => s.id);
  assert.deepEqual(ids, ['skill:B', 'skill:C'], 'sorted by id');

  // each summary has the four fields
  for (const s of preview.wouldRemove) {
    assert.ok(typeof s.id === 'string', 'id is string');
    assert.ok(typeof s.kind === 'string', 'kind is string');
    assert.ok(typeof s.name === 'string', 'name is string');
    assert.ok(typeof s.path === 'string', 'path is string');
  }

  // direction defaults to 'dependents'
  assert.equal(preview.direction, 'dependents');
});

test('cascadePreview: direction field reflects opts.direction', () => {
  const g = makeGraph([['skill', 'A']]);
  const p1 = cascadePreview(g, 'skill:A');
  assert.equal(p1.direction, 'dependents');

  const p2 = cascadePreview(g, 'skill:A', { direction: 'dependencies' });
  assert.equal(p2.direction, 'dependencies');
});

test('cascadePreview: non-node target returns target:null, wouldRemove:[], total:0', () => {
  const g = makeGraph([['skill', 'real']]);
  const preview = cascadePreview(g, 'skill:ghost');

  assert.equal(preview.target, null);
  assert.deepEqual(preview.wouldRemove, []);
  assert.equal(preview.total, 0);
});

test('cascadePreview: wouldRemove is sorted by id (deterministic output)', () => {
  // All of B, C, D depend on A — preview must return them sorted
  const g = makeGraph(
    [['skill', 'A'], ['skill', 'B'], ['skill', 'C'], ['skill', 'D']],
    [['skill:D', 'skill:A'], ['skill:B', 'skill:A'], ['skill:C', 'skill:A']],
  );
  const preview = cascadePreview(g, 'skill:A');
  assert.equal(preview.total, 3);
  const ids = preview.wouldRemove.map((s) => s.id);
  assert.deepEqual(ids, ['skill:B', 'skill:C', 'skill:D']);
});

test('cascadePreview: target with no cascade (isolated) has total:0', () => {
  const g = makeGraph([['agent', 'solo']]);
  const preview = cascadePreview(g, 'agent:solo');

  assert.ok(preview.target !== null);
  assert.equal(preview.target.id, 'agent:solo');
  assert.deepEqual(preview.wouldRemove, []);
  assert.equal(preview.total, 0);
});

// ── cascadePreview: never-throws ──────────────────────────────────────────────

test('cascadePreview: never throws on undefined graph', () => {
  assert.doesNotThrow(() => cascadePreview(undefined, 'skill:x'));
  const r = cascadePreview(undefined, 'skill:x');
  assert.equal(r.target, null);
  assert.deepEqual(r.wouldRemove, []);
});

test('cascadePreview: never throws on null graph', () => {
  assert.doesNotThrow(() => cascadePreview(null, 'skill:x'));
});

test('cascadePreview: never throws on malformed graph', () => {
  assert.doesNotThrow(() => cascadePreview({}, 'skill:x'));
});

test('cascadePreview: never throws on non-string targetId', () => {
  const g = makeGraph([['skill', 'x']]);
  assert.doesNotThrow(() => cascadePreview(g, null));
  assert.doesNotThrow(() => cascadePreview(g, undefined));
  const r = cascadePreview(g, null);
  assert.equal(r.target, null);
});

// ── traversed edges field ────────────────────────────────────────────────────

test('cascadeSet: edges field contains the traversed edges', () => {
  const g = makeGraph(
    [['skill', 'A'], ['skill', 'B']],
    [['skill:B', 'skill:A']],
  );
  const result = cascadeSet(g, 'skill:A');
  assert.equal(result.edges.length, 1);
  assert.equal(result.edges[0].source, 'skill:B');
  assert.equal(result.edges[0].target, 'skill:A');
});

test('cascadeSet: edges may include the same edge object in a cycle (visited guards ids, not edges)', () => {
  // In a cycle, the visited guard prevents re-queuing nodes, but the edge
  // pointing back to an already-visited node is still traversed once.
  const g = makeGraph(
    [['skill', 'A'], ['skill', 'B']],
    [['skill:A', 'skill:B'], ['skill:B', 'skill:A']],
  );
  // dependents of B: incoming edge B<-A (source=A) → include A; then incoming to A → edge A<-B (source=B, already visited)
  const result = cascadeSet(g, 'skill:B');
  assert.equal(result.ids.length, 1, 'B is visited; only A in cascade set');
  // edges contains at least the traversed edge
  assert.ok(result.edges.length >= 1);
});
