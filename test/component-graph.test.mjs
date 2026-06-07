/**
 * Unit oracle for the ComponentGraph builder (src/lib/component-graph.mjs).
 *
 * Pins:
 *  - buildComponentGraph: node ids, sort order, byId/byName lookups, duplicate-id
 *    warn, skipped-record warn, edges-empty invariant.
 *  - addEdge: valid add, dedup, unknown kind, self-edge, unknown id.
 *  - never-throws on junk input.
 *  - real-fixture smoke: discoverComponents over test/fixtures/minimal/ → nodes
 *    cover agents + commands.
 *
 * No filesystem writes; pure/synthetic ComponentRecord[] everywhere except the
 * optional real-fixture smoke at the end.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildComponentGraph, addEdge, EDGE_KINDS,
  REFERENCE_FIELDS, parseRefValue, extractEdges } from '../src/lib/component-graph.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── helpers ──────────────────────────────────────────────────────────────────

/** Build a minimal ComponentRecord for tests. */
const rec = (kind, name, path = `/fake/${kind}/${name}.md`) => ({
  kind,
  name,
  path,
  source: { tier: 'user' },
  frontmatter: { description: `${kind} ${name}` },
});

// ── EDGE_KINDS ────────────────────────────────────────────────────────────────

test('EDGE_KINDS is frozen and contains the four expected kinds', () => {
  assert.deepEqual([...EDGE_KINDS].sort(), [
    'frontmatter-ref',
    'hook-command-path',
    'manifest-include',
    'settings-pointer',
  ]);
  assert.throws(() => { EDGE_KINDS.push('extra'); }, TypeError, 'must be frozen');
});

// ── buildComponentGraph ───────────────────────────────────────────────────────

test('builds nodes for a mix of agent/command/skill records; ids are kind:name', () => {
  const components = [
    rec('agent', 'executor'),
    rec('command', 'commit'),
    rec('skill', 'python-testing'),
  ];
  const g = buildComponentGraph(components);
  assert.equal(g.nodes.length, 3);
  const ids = g.nodes.map((n) => n.id);
  assert.ok(ids.includes('agent:executor'));
  assert.ok(ids.includes('command:commit'));
  assert.ok(ids.includes('skill:python-testing'));
  assert.deepEqual(g.diagnostics, []);
});

test('nodes are sorted by id (deterministic output)', () => {
  const components = [
    rec('skill', 'zebra'),
    rec('agent', 'alpha'),
    rec('command', 'bravo'),
  ];
  const g = buildComponentGraph(components);
  const ids = g.nodes.map((n) => n.id);
  assert.deepEqual(ids, ['agent:alpha', 'command:bravo', 'skill:zebra']);
});

test('byId lookup returns the matching node', () => {
  const g = buildComponentGraph([rec('agent', 'helper'), rec('skill', 'research')]);
  assert.ok(g.byId.get('agent:helper'));
  assert.equal(g.byId.get('agent:helper').name, 'helper');
  assert.equal(g.byId.get('agent:helper').kind, 'agent');
  assert.equal(g.byId.get('agent:helper').path, '/fake/agent/helper.md');
  assert.ok(!g.byId.has('agent:nonexistent'));
});

test('byName lookup returns all nodes sharing a bare name across kinds', () => {
  const components = [
    rec('agent', 'deploy'),
    rec('command', 'deploy'),   // same bare name, different kind
    rec('skill', 'other'),
  ];
  const g = buildComponentGraph(components);
  const deployNodes = g.byName.get('deploy');
  assert.ok(Array.isArray(deployNodes));
  assert.equal(deployNodes.length, 2);
  const deployKinds = deployNodes.map((n) => n.kind).sort();
  assert.deepEqual(deployKinds, ['agent', 'command']);
  assert.ok(!g.byName.has('nonexistent'));
});

test('duplicate kind:name keeps first record and emits component-graph-duplicate-id warn', () => {
  const first = { ...rec('agent', 'foo'), path: '/first/foo.md' };
  const second = { ...rec('agent', 'foo'), path: '/second/foo.md' };
  const g = buildComponentGraph([first, second]);
  assert.equal(g.nodes.length, 1);
  assert.equal(g.byId.get('agent:foo').path, '/first/foo.md');
  const dup = g.diagnostics.filter((d) => d.code === 'component-graph-duplicate-id');
  assert.equal(dup.length, 1);
  assert.equal(dup[0].severity, 'warn');
  assert.match(dup[0].message, /"agent:foo"/);
});

test('edges is EMPTY after buildComponentGraph (extraction is U2)', () => {
  const g = buildComponentGraph([rec('agent', 'x'), rec('skill', 'y')]);
  assert.deepEqual(g.edges, []);
});

test('node carries source and frontmatter through from the record', () => {
  const src = { tier: 'user', marketplace: 'anthropic' };
  const fm = { description: 'does stuff', version: '2' };
  const r = { kind: 'skill', name: 'tester', path: '/p.md', source: src, frontmatter: fm };
  const g = buildComponentGraph([r]);
  const node = g.byId.get('skill:tester');
  assert.deepEqual(node.source, src);
  assert.deepEqual(node.frontmatter, fm);
});

// ── never-throws / skipped records ───────────────────────────────────────────

test('buildComponentGraph(undefined) returns empty graph with no throw', () => {
  const g = buildComponentGraph(undefined);
  assert.deepEqual(g.nodes, []);
  assert.deepEqual(g.edges, []);
  assert.ok(g.byId instanceof Map);
  assert.ok(g.byName instanceof Map);
  assert.deepEqual(g.diagnostics, []);
});

test('buildComponentGraph({}) treats non-array as empty, no throw', () => {
  const g = buildComponentGraph({});
  assert.deepEqual(g.nodes, []);
});

test('buildComponentGraph([null, 42, {kind:1}]) skips bad records with warn diagnostics', () => {
  const g = buildComponentGraph([null, 42, { kind: 1, name: 'x' }, { kind: 'agent', name: '' }]);
  assert.equal(g.nodes.length, 0);
  const skipped = g.diagnostics.filter((d) => d.code === 'component-graph-skipped-record');
  assert.ok(skipped.length >= 3, `expected ≥3 skipped warns, got ${skipped.length}`);
  for (const d of skipped) assert.equal(d.severity, 'warn');
});

test('a valid record among junk is still added', () => {
  const g = buildComponentGraph([null, rec('agent', 'valid'), 42]);
  assert.equal(g.nodes.length, 1);
  assert.ok(g.byId.has('agent:valid'));
});

test('proto-safe: record named __proto__ does not pollute Object.prototype', () => {
  const protoRec = { kind: 'skill', name: '__proto__', path: '/p.md', source: {}, frontmatter: {} };
  assert.doesNotThrow(() => buildComponentGraph([protoRec]));
  assert.equal({}.polluted, undefined);
  // The node IS added (it's a valid string name); byId/byName use Map, not plain objects.
  const g = buildComponentGraph([protoRec]);
  assert.ok(g.byId.has('skill:__proto__'));
  assert.equal({}.polluted, undefined, 'Object.prototype not polluted after byId lookup');
});

// ── addEdge ───────────────────────────────────────────────────────────────────

test('addEdge: a valid (source, target, frontmatter-ref) edge is added', () => {
  const g = buildComponentGraph([rec('skill', 'a'), rec('skill', 'b')]);
  const added = addEdge(g, 'skill:a', 'skill:b', 'frontmatter-ref');
  assert.equal(added, true);
  assert.equal(g.edges.length, 1);
  assert.deepEqual(g.edges[0], { source: 'skill:a', target: 'skill:b', kind: 'frontmatter-ref' });
});

test('addEdge: duplicate (source, target, kind) triple is deduped — edges length unchanged', () => {
  const g = buildComponentGraph([rec('skill', 'a'), rec('skill', 'b')]);
  addEdge(g, 'skill:a', 'skill:b', 'frontmatter-ref');
  const added2 = addEdge(g, 'skill:a', 'skill:b', 'frontmatter-ref');
  assert.equal(added2, false);
  assert.equal(g.edges.length, 1);
});

test('addEdge: different edge kinds between the same pair are NOT deduped', () => {
  const g = buildComponentGraph([rec('agent', 'x'), rec('agent', 'y')]);
  addEdge(g, 'agent:x', 'agent:y', 'frontmatter-ref');
  addEdge(g, 'agent:x', 'agent:y', 'settings-pointer');
  assert.equal(g.edges.length, 2);
});

test('addEdge: unknown kind returns false and does not add an edge', () => {
  const g = buildComponentGraph([rec('agent', 'x'), rec('agent', 'y')]);
  const added = addEdge(g, 'agent:x', 'agent:y', 'not-a-real-kind');
  assert.equal(added, false);
  assert.equal(g.edges.length, 0);
});

test('addEdge: self-edge returns false', () => {
  const g = buildComponentGraph([rec('agent', 'solo')]);
  const added = addEdge(g, 'agent:solo', 'agent:solo', 'frontmatter-ref');
  assert.equal(added, false);
  assert.equal(g.edges.length, 0);
});

test('addEdge: unknown sourceId returns false', () => {
  const g = buildComponentGraph([rec('skill', 'real')]);
  const added = addEdge(g, 'skill:ghost', 'skill:real', 'frontmatter-ref');
  assert.equal(added, false);
  assert.equal(g.edges.length, 0);
});

test('addEdge: unknown targetId returns false', () => {
  const g = buildComponentGraph([rec('skill', 'real')]);
  const added = addEdge(g, 'skill:real', 'skill:ghost', 'frontmatter-ref');
  assert.equal(added, false);
  assert.equal(g.edges.length, 0);
});

test('addEdge: all four EDGE_KINDS are accepted', () => {
  // Build enough nodes for 4 pairs
  const components = ['a', 'b', 'c', 'd', 'e'].map((n) => rec('command', n));
  const g = buildComponentGraph(components);
  let i = 0;
  for (const kind of EDGE_KINDS) {
    const src = `command:${['a', 'b', 'c', 'd'][i]}`;
    const tgt = `command:e`;
    const ok = addEdge(g, src, tgt, kind);
    assert.equal(ok, true, `EDGE_KINDS[${i}]=${kind} should be accepted`);
    i++;
  }
  assert.equal(g.edges.length, 4);
});

test('addEdge: never throws on junk graph argument', () => {
  assert.doesNotThrow(() => addEdge(null, 'a', 'b', 'frontmatter-ref'));
  assert.doesNotThrow(() => addEdge(undefined, 'a', 'b', 'frontmatter-ref'));
  assert.doesNotThrow(() => addEdge({}, 'a', 'b', 'frontmatter-ref'));
  assert.doesNotThrow(() => addEdge({ byId: null, edges: [] }, 'a', 'b', 'frontmatter-ref'));
});

// ── REFERENCE_FIELDS & parseRefValue ─────────────────────────────────────────

test('REFERENCE_FIELDS is frozen and contains exactly the three expected rows', () => {
  assert.ok(Object.isFrozen(REFERENCE_FIELDS));
  assert.equal(REFERENCE_FIELDS.length, 3);
  const keys = REFERENCE_FIELDS.map((r) => `${r.sourceKind}/${r.field}->${r.targetKind}`);
  assert.deepEqual(keys, [
    'skill/agent->agent',
    'skill/next-skill->skill',
    'skill/pipeline->skill',
  ]);
});

test('parseRefValue: plain string returns single-element array', () => {
  assert.deepEqual(parseRefValue('tracer'), ['tracer']);
  assert.deepEqual(parseRefValue('  tracer  '), ['tracer']);
});

test('parseRefValue: bracket-wrapped comma list is split correctly', () => {
  assert.deepEqual(parseRefValue('[deep-dive, plan, autopilot]'), ['deep-dive', 'plan', 'autopilot']);
  assert.deepEqual(parseRefValue('[a,b,c]'), ['a', 'b', 'c']);
});

test('parseRefValue: path-like tokens (containing / or \\) are dropped', () => {
  assert.deepEqual(parseRefValue('.omc/specs/x.md'), []);
  assert.deepEqual(parseRefValue('foo/bar'), []);
  assert.deepEqual(parseRefValue('foo\\bar'), []);
});

test('parseRefValue: tokens starting with "." are dropped', () => {
  assert.deepEqual(parseRefValue('.hidden'), []);
  assert.deepEqual(parseRefValue('[.hidden, good]'), ['good']);
});

test('parseRefValue: empty tokens are dropped', () => {
  assert.deepEqual(parseRefValue('[a,,b]'), ['a', 'b']);
  assert.deepEqual(parseRefValue(''), []);
  assert.deepEqual(parseRefValue('   '), []);
});

test('parseRefValue: non-string returns []', () => {
  assert.deepEqual(parseRefValue(42), []);
  assert.deepEqual(parseRefValue(null), []);
  assert.deepEqual(parseRefValue(undefined), []);
  assert.deepEqual(parseRefValue({}), []);
  assert.deepEqual(parseRefValue(['a', 'b']), []);
});

test('parseRefValue: bracket wrapping stripped only once (single outer pair)', () => {
  // "[plan]" -> "plan"; "[[plan]]" -> "[plan]" which has no separator, stays "[plan]"
  assert.deepEqual(parseRefValue('[plan]'), ['plan']);
  // The inner "[plan]" would be treated as a bare token (no comma, not path-like)
  // It does start with '[' but that's only stripped once, so the result is "[plan]"
  assert.deepEqual(parseRefValue('[[plan]]'), ['[plan]']);
});

// ── extractEdges ──────────────────────────────────────────────────────────────

/** Build a ComponentRecord with explicit frontmatter. */
const recFm = (kind, name, frontmatter = {}) => ({
  kind, name, path: `/fake/${kind}/${name}.md`,
  source: { tier: 'user' }, frontmatter,
});

test('extractEdges: skill.agent -> agent edge', () => {
  const components = [
    recFm('skill', 'tracer-skill', { agent: 'tracer' }),
    recFm('agent', 'tracer'),
  ];
  const g = extractEdges(buildComponentGraph(components));
  assert.equal(g.edges.length, 1);
  assert.deepEqual(g.edges[0], {
    source: 'skill:tracer-skill',
    target: 'agent:tracer',
    kind: 'frontmatter-ref',
  });
});

test('extractEdges: skill.next-skill -> skill edge', () => {
  const components = [
    recFm('skill', 'step-one', { 'next-skill': 'plan' }),
    recFm('skill', 'plan'),
  ];
  const g = extractEdges(buildComponentGraph(components));
  assert.equal(g.edges.length, 1);
  assert.deepEqual(g.edges[0], {
    source: 'skill:step-one',
    target: 'skill:plan',
    kind: 'frontmatter-ref',
  });
});

test('extractEdges: skill.pipeline -> multiple skill edges; self-edge silently rejected', () => {
  // pipeline includes 'p-skill' itself — that self-edge must be rejected
  const components = [
    recFm('skill', 'p-skill', { pipeline: '[a, p-skill, b, c]' }),
    recFm('skill', 'a'),
    recFm('skill', 'b'),
    recFm('skill', 'c'),
  ];
  const g = extractEdges(buildComponentGraph(components));
  // Expect edges to a, b, c — NOT to p-skill (self-edge rejected by addEdge)
  assert.equal(g.edges.length, 3);
  const targets = g.edges.map((e) => e.target).sort();
  assert.deepEqual(targets, ['skill:a', 'skill:b', 'skill:c']);
  assert.ok(g.edges.every((e) => e.source === 'skill:p-skill'));
  assert.ok(g.edges.every((e) => e.kind === 'frontmatter-ref'));
});

test('extractEdges: dangling ref (no matching node) produces NO edge', () => {
  const components = [
    recFm('skill', 'lonely', { agent: 'ghost' }),
    // no agent:ghost node
  ];
  const g = extractEdges(buildComponentGraph(components));
  assert.equal(g.edges.length, 0);
});

test('extractEdges: handoff and handoff-policy fields do NOT produce edges', () => {
  const components = [
    recFm('skill', 'x', {
      handoff: '.omc/specs/deep-dive-{slug}.md',
      'handoff-policy': 'approval-required',
    }),
    recFm('agent', 'tracer'), // present but should NOT be reached
  ];
  const g = extractEdges(buildComponentGraph(components));
  assert.equal(g.edges.length, 0, 'handoff/handoff-policy must not generate edges');
});

test('extractEdges: agents and commands with frontmatter produce NO edges (no REFERENCE_FIELDS rows)', () => {
  const components = [
    recFm('agent', 'my-agent', { agent: 'other', pipeline: '[a, b]' }),
    recFm('command', 'my-cmd', { 'next-skill': 'plan' }),
    recFm('agent', 'other'),
    recFm('skill', 'plan'),
    recFm('skill', 'a'),
    recFm('skill', 'b'),
  ];
  const g = extractEdges(buildComponentGraph(components));
  assert.equal(g.edges.length, 0, 'only skill nodes drive reference fields');
});

test('extractEdges: idempotent — calling twice does not duplicate edges', () => {
  const components = [
    recFm('skill', 'src', { agent: 'agt', 'next-skill': 'dst' }),
    recFm('agent', 'agt'),
    recFm('skill', 'dst'),
  ];
  const g = buildComponentGraph(components);
  extractEdges(g);
  const countAfterFirst = g.edges.length;
  extractEdges(g);
  assert.equal(g.edges.length, countAfterFirst, 'second extractEdges must not add duplicates');
});

test('extractEdges: deterministic edge order — iterates nodes (sorted by id) then fields in table order', () => {
  const components = [
    recFm('skill', 'z-skill', { agent: 'b-agent', 'next-skill': 'a-skill' }),
    recFm('skill', 'a-skill', { agent: 'a-agent' }),
    recFm('agent', 'a-agent'),
    recFm('agent', 'b-agent'),
  ];
  const g = extractEdges(buildComponentGraph(components));
  // Nodes sorted: skill:a-skill, skill:z-skill
  // skill:a-skill has agent:a-agent -> 1 edge
  // skill:z-skill has agent:b-agent + next-skill:a-skill -> 2 edges
  assert.equal(g.edges.length, 3);
  assert.equal(g.edges[0].source, 'skill:a-skill');
  assert.equal(g.edges[0].target, 'agent:a-agent');
  assert.equal(g.edges[1].source, 'skill:z-skill');
  assert.equal(g.edges[1].target, 'agent:b-agent');
  assert.equal(g.edges[2].source, 'skill:z-skill');
  assert.equal(g.edges[2].target, 'skill:a-skill');
});

test('extractEdges: never throws on undefined graph', () => {
  assert.doesNotThrow(() => extractEdges(undefined));
});

test('extractEdges: never throws on null graph', () => {
  assert.doesNotThrow(() => extractEdges(null));
});

test('extractEdges: never throws on graph with malformed nodes array', () => {
  const g = { nodes: [null, 42, undefined], edges: [], byId: new Map(), byName: new Map() };
  assert.doesNotThrow(() => extractEdges(g));
  assert.equal(g.edges.length, 0);
});

test('extractEdges: never throws on graph with node missing frontmatter', () => {
  const badNode = { id: 'skill:x', kind: 'skill', name: 'x', path: '/x.md', source: {} };
  // no frontmatter field
  const g = { nodes: [badNode], edges: [], byId: new Map([['skill:x', badNode]]), byName: new Map() };
  assert.doesNotThrow(() => extractEdges(g));
  assert.equal(g.edges.length, 0);
});

// ── real-harness smoke ────────────────────────────────────────────────────────

test('real-harness smoke: extractEdges over ~/.claude produces at least one frontmatter-ref edge', async () => {
  // This test uses the REAL harness. It skips gracefully if CLAUDE_CONFIG_DIR is not set
  // AND the default home dir has no components.
  const { discoverComponents } = await import('../src/discovery/components.mjs');
  const homeDir = process.env.CLAUDE_CONFIG_DIR ?? (
    process.platform === 'win32'
      ? `${process.env.USERPROFILE}\\.claude`
      : `${process.env.HOME}/.claude`
  );
  let components;
  try {
    ({ components } = discoverComponents(homeDir));
  } catch {
    // If discovery fails (e.g. no harness on CI), skip gracefully.
    return;
  }
  if (!components || components.length === 0) return; // nothing to test

  const g = extractEdges(buildComponentGraph(components));

  // There must be at least one frontmatter-ref edge on a real harness with skills.
  const hasSkills = components.some((c) => c.kind === 'skill');
  if (!hasSkills) return;

  assert.ok(g.edges.length > 0, 'expected at least one frontmatter-ref edge on the real harness');
  assert.ok(g.edges.every((e) => e.kind === 'frontmatter-ref'), 'all edges must be frontmatter-ref (only kind built in U2)');

  // NO edge should originate from a handoff path (a token containing '/' would
  // be the symptom of a false-positive path ref that parseRefValue should drop).
  for (const e of g.edges) {
    assert.ok(!e.target.includes('/'), `edge target "${e.target}" looks like a path — parseRefValue leak`);
  }
});

// ── real-fixture smoke ────────────────────────────────────────────────────────

test('real-fixture smoke: nodes cover agents + commands from test/fixtures/minimal/', async () => {
  const { discoverComponents } = await import('../src/discovery/components.mjs');
  const fixtureDir = join(__dirname, 'fixtures', 'minimal');
  const { components } = discoverComponents(fixtureDir);
  const g = buildComponentGraph(components);

  // minimal/ has agents/helper.md and commands/greet.md (at minimum)
  assert.ok(g.nodes.length >= 2, `expected ≥2 nodes, got ${g.nodes.length}`);
  assert.ok(g.byId.has('agent:helper'), 'agent:helper should exist');
  assert.ok(g.byId.has('command:greet'), 'command:greet should exist');

  // All nodes have valid ids of the form kind:name
  for (const node of g.nodes) {
    assert.match(node.id, /^(agent|command|skill):.+/, `invalid id "${node.id}"`);
    assert.equal(node.id, `${node.kind}:${node.name}`);
  }

  // edges is empty after build
  assert.deepEqual(g.edges, []);
  // diagnostics has no errors
  assert.ok(!g.diagnostics.some((d) => d.severity === 'error'));
});
