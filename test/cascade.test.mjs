/**
 * test/cascade.test.mjs — hermetic unit tests for cascadeRemove (P4b.U4).
 *
 * Uses a synthetic discoverFn that returns a small graph:
 *   agent:tracer  (no dependencies)
 *   skill:trace   (frontmatter.agent = "tracer" → skill:trace DEPENDS ON agent:tracer)
 *
 * All graph wiring is synthetic — no real fs reads for discovery or lstat. The
 * lstatFn seam returns fake stat objects keyed by the synthetic component list.
 * The applyFn seam is a recording spy. Never touches the real ~/.claude.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { cascadeRemove, KIND_SPEC as CASCADE_KIND_SPEC } from '../src/ops/cascade.mjs';
import { KIND_SPEC as REMOVE_KIND_SPEC } from '../src/ops/remove.mjs';

// ── synthetic fixtures ─────────────────────────────────────────────────────────

const agentTracer = {
  kind: 'agent', name: 'tracer',
  path: '/fake/.claude/agents/tracer.md',
  source: { tier: 'user' },
  frontmatter: { name: 'tracer' },
};

/** skill:trace references agent:tracer via `agent: tracer` in frontmatter. */
const skillTrace = {
  kind: 'skill', name: 'trace',
  path: '/fake/.claude/skills/trace',
  source: { tier: 'user' },
  frontmatter: { agent: 'tracer' },
};

const agentSolo = {
  kind: 'agent', name: 'solo',
  path: '/fake/.claude/agents/solo.md',
  source: { tier: 'user' },
  frontmatter: { name: 'solo' },
};

// ── seam factories ─────────────────────────────────────────────────────────────

function makeDiscoverFn(components) {
  return () => ({ components, diagnostics: [] });
}

function makeApplySpy() {
  const calls = [];
  async function applyFn(opts) {
    calls.push(opts);
    return { ok: true, applied: true, snapshotId: 'fake-snapshot-id',
      lock: { acquired: true }, diagnostics: [] };
  }
  applyFn.calls = calls;
  return applyFn;
}

/**
 * lstatFn seam: returns a fake stat for every synthetic component path; throws
 * ENOENT for anything else.  Paths are constructed identically to resolveNodeTarget
 * inside cascade.mjs so that the seam matches without needing real files.
 */
function makeLstatFn(components) {
  const filePaths = new Set();
  const dirPaths  = new Set();
  const base = join('/fake', '.claude');
  for (const c of components) {
    if (c.kind === 'agent')   filePaths.add(join(base, 'agents',   c.name + '.md'));
    if (c.kind === 'command') filePaths.add(join(base, 'commands', c.name + '.md'));
    if (c.kind === 'skill')   dirPaths.add(join(base, 'skills',   c.name));
  }
  return (p) => {
    if (filePaths.has(p)) return { isFile: () => true,  isDirectory: () => false, isSymbolicLink: () => false };
    if (dirPaths.has(p))  return { isFile: () => false, isDirectory: () => true,  isSymbolicLink: () => false };
    const e = new Error(`ENOENT: '${p}'`); e.code = 'ENOENT'; throw e;
  };
}

const fakeAssertWritable = (p) => p;

const TRACER_COMPONENTS = [agentTracer, skillTrace];
const SOLO_COMPONENTS   = [agentSolo];

const FAKE_CLAUDE_DIR   = join('/fake', '.claude');
const FAKE_MGR_DIR      = join('/fake', '.mgr-state');

const BASE_OPTS = {
  targetClaudeDir: FAKE_CLAUDE_DIR,
  mgrStateDir: FAKE_MGR_DIR,
  assertWritable: fakeAssertWritable,
};

function codes(r) { return (r.diagnostics || []).map((d) => d.code); }

// ── tests ──────────────────────────────────────────────────────────────────────

test('dry-run: preview lists target + dependent; applyFn NOT called', async () => {
  const spy = makeApplySpy();
  const r = await cascadeRemove({
    ...BASE_OPTS,
    spec: 'agent:tracer',
    enableWrites: false,
    seams: {
      discoverFn: makeDiscoverFn(TRACER_COMPONENTS),
      applyFn: spy,
      lstatFn: makeLstatFn(TRACER_COMPONENTS),
    },
  });

  assert.equal(r.ok, true, 'dry-run should be ok');
  assert.equal(r.dryRun, true);
  assert.equal(r.refused, false);
  assert.equal(r.target, 'agent:tracer');
  assert.ok(r.dependents.includes('skill:trace'),
    `dependents should include skill:trace; got ${JSON.stringify(r.dependents)}`);
  assert.ok(r.preview !== null, 'preview must be non-null');
  assert.ok(r.preview.wouldRemove.some((n) => n.id === 'skill:trace'),
    'preview.wouldRemove should include skill:trace');
  assert.equal(spy.calls.length, 0, 'applyFn must not be called in dry-run');
  assert.ok(r.plan !== null);
  assert.equal(r.plan.ops.length, 2,
    `plan should have 2 ops (target + dependent); got ${r.plan.ops.length}`);
  assert.ok(codes(r).includes('cascade-dry-run'));
});

test('--apply with dependents + NO force: cascade-needs-force, applyFn NOT called', async () => {
  const spy = makeApplySpy();
  const r = await cascadeRemove({
    ...BASE_OPTS,
    spec: 'agent:tracer',
    enableWrites: true,
    force: false,
    seams: {
      discoverFn: makeDiscoverFn(TRACER_COMPONENTS),
      applyFn: spy,
      lstatFn: makeLstatFn(TRACER_COMPONENTS),
    },
  });

  assert.equal(r.refused, true, 'should be refused when force missing');
  assert.equal(r.ok, false);
  assert.equal(spy.calls.length, 0, 'applyFn must not be called');
  assert.ok(codes(r).includes('cascade-needs-force'),
    `expected cascade-needs-force in ${JSON.stringify(codes(r))}`);
  assert.ok(r.preview !== null, 'preview should be set even on refusal');
});

test('--apply --force with dependents: applyFn called ONCE with multi-op plan', async () => {
  const spy = makeApplySpy();
  const r = await cascadeRemove({
    ...BASE_OPTS,
    spec: 'agent:tracer',
    enableWrites: true,
    force: true,
    seams: {
      discoverFn: makeDiscoverFn(TRACER_COMPONENTS),
      applyFn: spy,
      lstatFn: makeLstatFn(TRACER_COMPONENTS),
    },
  });

  assert.equal(r.ok, true, `expected ok; diagnostics: ${JSON.stringify(r.diagnostics)}`);
  assert.equal(r.refused, false);
  assert.equal(r.dryRun, false);
  assert.equal(r.apply?.ok, true);
  assert.equal(spy.calls.length, 1, 'applyFn must be called exactly once');

  const call = spy.calls[0];
  assert.equal(call.plan.ops.length, 2,
    `plan should have 2 ops; got ${call.plan.ops.length}`);

  const agentOp = call.plan.ops.find((op) => op.kind === 'delete');
  assert.ok(agentOp, 'delete op for agent:tracer should exist');
  assert.ok(agentOp.target.endsWith('tracer.md'),
    `agent target should end with tracer.md; got ${agentOp.target}`);

  const skillOp = call.plan.ops.find((op) => op.kind === 'delete-dir');
  assert.ok(skillOp, 'delete-dir op for skill:trace should exist');
  assert.ok(skillOp.target.endsWith('trace'),
    `skill target should end with trace; got ${skillOp.target}`);

  assert.equal(call.enableWrites, true);
});

test('NO dependents + --apply (no force): applyFn called (plain remove semantics)', async () => {
  const spy = makeApplySpy();
  const r = await cascadeRemove({
    ...BASE_OPTS,
    spec: 'agent:solo',
    enableWrites: true,
    force: false,
    seams: {
      discoverFn: makeDiscoverFn(SOLO_COMPONENTS),
      applyFn: spy,
      lstatFn: makeLstatFn(SOLO_COMPONENTS),
    },
  });

  assert.equal(r.refused, false, 'no force needed when no dependents');
  assert.equal(r.ok, true);
  assert.equal(spy.calls.length, 1, 'applyFn must be called once');
  assert.equal(r.dependents.length, 0);
  assert.equal(spy.calls[0].plan.ops.length, 1, 'single-op plan for no-dependent case');
});

test('cascade-target-not-found for unknown component', async () => {
  const spy = makeApplySpy();
  const r = await cascadeRemove({
    ...BASE_OPTS,
    spec: 'agent:ghost',
    enableWrites: false,
    seams: {
      discoverFn: makeDiscoverFn([agentTracer]),
      applyFn: spy,
      lstatFn: makeLstatFn([agentTracer]),
    },
  });

  assert.equal(r.refused, true);
  assert.equal(r.ok, false);
  assert.ok(codes(r).includes('cascade-target-not-found'),
    `expected cascade-target-not-found; got ${JSON.stringify(codes(r))}`);
  assert.equal(spy.calls.length, 0);
});

test('bad spec (no colon): cascade-bad-spec', async () => {
  const r = await cascadeRemove({
    ...BASE_OPTS,
    spec: 'no-colon-here',
    seams: { discoverFn: makeDiscoverFn([]), applyFn: makeApplySpy(), lstatFn: makeLstatFn([]) },
  });
  assert.equal(r.refused, true);
  assert.ok(codes(r).includes('cascade-bad-spec'));
});

test('unsupported kind: cascade-kind-unsupported', async () => {
  const r = await cascadeRemove({
    ...BASE_OPTS,
    spec: 'plugin:foo',
    seams: { discoverFn: makeDiscoverFn([]), applyFn: makeApplySpy(), lstatFn: makeLstatFn([]) },
  });
  assert.equal(r.refused, true);
  assert.ok(codes(r).includes('cascade-kind-unsupported'));
});

test('never throws on garbage input', async () => {
  const r = await cascadeRemove(null);
  assert.equal(typeof r, 'object');
  assert.equal(r.ok, false);

  const r2 = await cascadeRemove({ spec: 42, targetClaudeDir: 123 });
  assert.equal(r2.ok, false);
});

test('preview and plan are populated even on cascade-needs-force refusal', async () => {
  const r = await cascadeRemove({
    ...BASE_OPTS,
    spec: 'agent:tracer',
    enableWrites: true,
    force: false,
    seams: {
      discoverFn: makeDiscoverFn(TRACER_COMPONENTS),
      applyFn: makeApplySpy(),
      lstatFn: makeLstatFn(TRACER_COMPONENTS),
    },
  });
  assert.ok(r.preview !== null, 'preview should be set even on cascade-needs-force');
  assert.ok(r.plan !== null, 'plan should be set even on cascade-needs-force');
});

// ── drift-guard ────────────────────────────────────────────────────────────────
//
// CASCADE_KIND_SPEC and REMOVE_KIND_SPEC are copy-duplicated across cascade.mjs
// and remove.mjs (ops-layer constraint: sibling modules share no mutable state).
// This test asserts they remain deepEqual so a future divergence fails the gate
// immediately rather than silently mis-gating a remove or cascade operation.

test('drift-guard: cascade.KIND_SPEC deepEquals remove.KIND_SPEC', () => {
  const cKinds = Object.keys(CASCADE_KIND_SPEC).sort();
  const rKinds = Object.keys(REMOVE_KIND_SPEC).sort();
  assert.deepEqual(cKinds, rKinds,
    `KIND_SPEC key sets differ — cascade has [${cKinds}], remove has [${rKinds}]`);
  for (const kind of cKinds) {
    assert.deepEqual(
      { ...CASCADE_KIND_SPEC[kind] },
      { ...REMOVE_KIND_SPEC[kind] },
      `KIND_SPEC["${kind}"] differs between cascade.mjs and remove.mjs`
    );
  }
});
