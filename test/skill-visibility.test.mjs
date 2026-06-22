/**
 * U3 oracle for setSkillVisibility (src/ops/skill-visibility.mjs).
 *
 * The engine is exercised with injected readFn + skillExistsFn + applyFn seams (no real
 * fs/lock/snapshot): dry-run previews (flip/insert/CREATE/noop) write nothing and call NO
 * applyFn; refusals (bad-name/bad-state/unsupported-shape/config-not-found) fail-closed; the
 * plugin-skill advisory WARN fires when the skill dir is absent; apply builds the ONE
 * json-map-set op and hands it to applyPlan; an already-in-state apply takes no snapshot.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { setSkillVisibility, VISIBILITY_STATES } from '../src/ops/skill-visibility.mjs';

const DIR = '/tmp/claude';
const STATE = '/tmp/claude/.mgr-state';

const WITH_MAP = [
  '{',
  '  "model": "opus",',
  '  "skillOverrides": {',
  '    "deep-research": "off",',
  '    "tdd": "name-only"',
  '  },',
  '  "env": { "SECRET": "sk-keep" }',
  '}',
  '',
].join('\n');

const NO_MAP = '{\n  "model": "opus"\n}\n';

/** A readFn that serves the given settings text for settings.json. */
function reader(textForSettings) {
  return (p) => {
    if (p.endsWith('settings.json')) return textForSettings;
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  };
}

/** A statFn that reports the given skill dirs as existing directories. */
function statForDirs(...names) {
  const set = new Set(names);
  return (p) => {
    for (const n of set) if (p.replace(/\\/g, '/').endsWith(`/skills/${n}`)) return { isDirectory: () => true };
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  };
}

/** A recording applyPlan seam returning a committed result. */
function recordApply(result = { ok: true, state: 'committed' }) {
  const calls = [];
  const fn = (opts) => { calls.push(opts); return Promise.resolve({ diagnostics: [], ...result }); };
  fn.calls = calls;
  return fn;
}

// existing skill dirs so the advisory WARN does NOT fire unless a test wants it
const base = { targetClaudeDir: DIR, mgrStateDir: STATE, readFn: reader(WITH_MAP), skillExistsFn: statForDirs('deep-research', 'tdd') };

test('the four states are the documented enum', () => {
  assert.deepEqual([...VISIBILITY_STATES], ['on', 'name-only', 'user-invocable-only', 'off']);
});

test('dry-run flip: previews the change, calls NO applyFn, writes nothing', async () => {
  const applyFn = recordApply();
  const r = await setSkillVisibility({ ...base, name: 'deep-research', state: 'on', seams: { applyFn } });
  assert.equal(r.ok, true);
  assert.equal(r.dryRun, true);
  assert.equal(r.kind, 'skill');
  assert.equal(r.field, 'visibility');
  assert.equal(r.name, 'deep-research');
  assert.equal(r.state, 'on');
  assert.ok(r.diff && r.diff.after.includes('on'));
  assert.equal(applyFn.calls.length, 0);
  assert.ok(r.diagnostics.some((d) => d.code === 'skill-visibility-dry-run'));
});

test('dry-run insert: setting a member absent from the map previews an insertion', async () => {
  const r = await setSkillVisibility({ ...base, name: 'tdd', state: 'off', skillExistsFn: statForDirs('tdd'), readFn: reader(WITH_MAP) });
  // tdd exists in WITH_MAP already → this is a flip; use a genuinely-absent name for insert:
  const ins = await setSkillVisibility({ ...base, name: 'avoid-ai-writing', state: 'off', skillExistsFn: statForDirs('avoid-ai-writing') });
  assert.equal(ins.ok, true);
  assert.equal(ins.dryRun, true);
  assert.ok(ins.diff && ins.diff.after.includes('"avoid-ai-writing": "off"'));
  assert.equal(r.ok, true);
});

test('dry-run CREATE: an absent skillOverrides map previews a map creation', async () => {
  const r = await setSkillVisibility({ ...base, name: 'deep-research', state: 'off', readFn: reader(NO_MAP) });
  assert.equal(r.ok, true);
  assert.equal(r.dryRun, true);
  assert.ok(r.diff && r.diff.after.includes('skillOverrides'));
});

test('dry-run noop-already: setting a member to its current value is a safe no-op', async () => {
  const r = await setSkillVisibility({ ...base, name: 'tdd', state: 'name-only' });
  assert.equal(r.ok, true);
  assert.equal(r.alreadyInState, true);
  assert.equal(r.diff, null);
});

test('refuse: an invalid skill name fails closed', async () => {
  const r = await setSkillVisibility({ ...base, name: 'has spaces', state: 'off' });
  assert.equal(r.refused, true);
  assert.ok(r.diagnostics.some((d) => d.code === 'skill-visibility-bad-name'));
});

test('refuse: an invalid state fails closed', async () => {
  const r = await setSkillVisibility({ ...base, name: 'deep-research', state: 'hidden' });
  assert.equal(r.refused, true);
  assert.ok(r.diagnostics.some((d) => d.code === 'skill-visibility-bad-state'));
});

test('refuse: a missing settings.json fails closed', async () => {
  const r = await setSkillVisibility({ ...base, name: 'deep-research', state: 'off', readFn: () => { throw new Error('ENOENT'); } });
  assert.equal(r.refused, true);
  assert.ok(r.diagnostics.some((d) => d.code === 'skill-visibility-config-not-found'));
});

test('refuse: a non-object skillOverrides is an unsupported shape', async () => {
  const r = await setSkillVisibility({ ...base, name: 'x', state: 'off', readFn: reader('{"skillOverrides":"nope"}'), skillExistsFn: statForDirs('x') });
  assert.equal(r.refused, true);
  assert.ok(r.diagnostics.some((d) => d.code === 'skill-visibility-unsupported-shape'));
});

test('advisory WARN: a non-directory-backed skill name warns but still previews the write', async () => {
  const r = await setSkillVisibility({ ...base, name: 'some-plugin-skill', state: 'off', skillExistsFn: () => { throw new Error('ENOENT'); } });
  assert.equal(r.ok, true);
  assert.equal(r.dryRun, true);
  assert.ok(r.diagnostics.some((d) => d.code === 'skill-visibility-not-directory-backed'));
});

test('no advisory WARN when the skill dir exists', async () => {
  const r = await setSkillVisibility({ ...base, name: 'deep-research', state: 'on' });
  assert.ok(!r.diagnostics.some((d) => d.code === 'skill-visibility-not-directory-backed'));
});

test('apply: builds the ONE json-map-set op and hands it to applyPlan', async () => {
  const applyFn = recordApply();
  const r = await setSkillVisibility({ ...base, name: 'deep-research', state: 'on', enableWrites: true, assertWritable: (p) => p, seams: { applyFn } });
  assert.equal(r.ok, true);
  assert.equal(r.dryRun, false);
  assert.equal(applyFn.calls.length, 1);
  const plan = applyFn.calls[0].plan;
  assert.equal(plan.ops.length, 1);
  assert.equal(plan.ops[0].kind, 'json-map-set');
  assert.deepEqual(plan.ops[0].selector, { mapKey: 'skillOverrides', memberKey: 'deep-research' });
  assert.equal(plan.ops[0].value, 'on');
  assert.ok(r.diagnostics.some((d) => d.code === 'skill-visibility-restart-needed'));
});

test('apply already-in-state: takes NO snapshot (applyFn never called)', async () => {
  const applyFn = recordApply();
  const r = await setSkillVisibility({ ...base, name: 'tdd', state: 'name-only', enableWrites: true, assertWritable: (p) => p, seams: { applyFn } });
  assert.equal(r.ok, true);
  assert.equal(r.alreadyInState, true);
  assert.equal(applyFn.calls.length, 0);
  assert.ok(r.diagnostics.some((d) => d.code === 'skill-visibility-noop'));
});

test('apply without an injected gate fails closed', async () => {
  const r = await setSkillVisibility({ ...base, name: 'deep-research', state: 'on', enableWrites: true });
  assert.equal(r.refused, true);
  assert.ok(r.diagnostics.some((d) => d.code === 'skill-visibility-bad-args'));
});

test('never throws on garbage opts', async () => {
  for (const g of [undefined, null, 42, {}, { name: 5 }]) {
    await assert.doesNotReject(() => setSkillVisibility(g));
  }
});
