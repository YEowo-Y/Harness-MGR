/**
 * U4 oracle for setPluginEnabledClaude (src/ops/plugin-toggle.mjs).
 *
 * The engine is exercised with injected readFn + applyFn seams (no real fs/lock/snapshot):
 * dry-run previews (flip/insert/noop) write nothing and call NO applyFn; refusals
 * (no-map/unsupported-shape/bad-name/config-not-found) fail-closed; the cross-layer caveat
 * fires when settings.local.json overrides; apply builds the ONE json-edit op and hands it to
 * applyPlan; an already-in-state apply takes no snapshot.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { setPluginEnabledClaude } from '../src/ops/plugin-toggle.mjs';

const DIR = '/tmp/claude';
const STATE = '/tmp/claude/.mgr-state';
const SETTINGS = [
  '{',
  '  "model": "opus",',
  '  "enabledPlugins": {',
  '    "ecc@everything-claude-code": true,',
  '    "gsap@gsap-skills": false',
  '  },',
  '  "env": { "SECRET": "sk-keep" }',
  '}',
  '',
].join('\n');

/** A readFn that serves SETTINGS for settings.json and throws ENOENT for settings.local.json. */
function readOnlyMain(p) {
  if (p.endsWith('settings.json') && !p.endsWith('settings.local.json')) return SETTINGS;
  throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
}

/** A recording applyPlan seam returning a committed result. */
function recordApply(result = { ok: true, state: 'committed' }) {
  const calls = [];
  const fn = (opts) => { calls.push(opts); return Promise.resolve({ diagnostics: [], ...result }); };
  fn.calls = calls;
  return fn;
}

const base = { targetClaudeDir: DIR, mgrStateDir: STATE, readFn: readOnlyMain };

test('dry-run flip: previews the change, calls NO applyFn, writes nothing', async () => {
  const applyFn = recordApply();
  const r = await setPluginEnabledClaude({ ...base, key: 'ecc@everything-claude-code', desired: false, seams: { applyFn } });
  assert.equal(r.ok, true);
  assert.equal(r.dryRun, true);
  assert.equal(r.kind, 'plugin');
  assert.equal(r.name, 'ecc@everything-claude-code');
  assert.equal(r.desired, false);
  assert.ok(r.diff && r.diff.after.includes('false'));
  assert.equal(applyFn.calls.length, 0);
  assert.ok(r.diagnostics.some((d) => d.code === 'plugin-toggle-dry-run'));
});

test('dry-run insert: enabling an absent plugin previews an insertion', async () => {
  const r = await setPluginEnabledClaude({ ...base, key: 'fresh@mkt', desired: true });
  assert.equal(r.ok, true);
  assert.equal(r.dryRun, true);
  assert.ok(r.diff && r.diff.after.includes('"fresh@mkt": true'));
});

test('dry-run noop-already: enabling an already-enabled plugin is a safe no-op', async () => {
  const r = await setPluginEnabledClaude({ ...base, key: 'ecc@everything-claude-code', desired: true });
  assert.equal(r.ok, true);
  assert.equal(r.alreadyInState, true);
  assert.equal(r.diff, null);
});

test('dry-run noop-absent-disable: disabling an absent plugin is a safe no-op', async () => {
  const r = await setPluginEnabledClaude({ ...base, key: 'never-seen@mkt', desired: false });
  assert.equal(r.ok, true);
  assert.equal(r.alreadyInState, true);
});

test('refuse: no enabledPlugins map → plugin-toggle-no-map', async () => {
  const r = await setPluginEnabledClaude({ ...base, key: 'a@b', desired: true, readFn: () => '{"model":"opus"}' });
  assert.equal(r.refused, true);
  assert.ok(r.diagnostics.some((d) => d.code === 'plugin-toggle-no-map'));
});

test('refuse: a non-boolean value → plugin-toggle-unsupported-shape', async () => {
  const r = await setPluginEnabledClaude({ ...base, key: 'x@m', desired: false, readFn: () => '{"enabledPlugins":{"x@m":"true"}}' });
  assert.equal(r.refused, true);
  assert.ok(r.diagnostics.some((d) => d.code === 'plugin-toggle-unsupported-shape'));
});

test('refuse: an invalid plugin name → plugin-toggle-bad-name', async () => {
  const r = await setPluginEnabledClaude({ ...base, key: 'bad name!', desired: true });
  assert.equal(r.refused, true);
  assert.ok(r.diagnostics.some((d) => d.code === 'plugin-toggle-bad-name'));
});

test('refuse: settings.json unreadable → plugin-toggle-config-not-found', async () => {
  const r = await setPluginEnabledClaude({ ...base, key: 'a@b', desired: true, readFn: () => { throw new Error('nope'); } });
  assert.equal(r.refused, true);
  assert.ok(r.diagnostics.some((d) => d.code === 'plugin-toggle-config-not-found'));
});

test('cross-layer caveat: a settings.local.json override surfaces a WARN', async () => {
  const readFn = (p) => {
    if (p.endsWith('settings.local.json')) return '{"enabledPlugins":{"ecc@everything-claude-code":true}}';
    return SETTINGS;
  };
  const r = await setPluginEnabledClaude({ ...base, key: 'ecc@everything-claude-code', desired: false, readFn });
  assert.equal(r.ok, true);
  assert.ok(r.diagnostics.some((d) => d.code === 'plugin-toggle-overridden-by-local' && d.severity === 'warn'));
});

test('apply: builds ONE json-edit op and hands it to applyPlan', async () => {
  const applyFn = recordApply();
  const r = await setPluginEnabledClaude({ ...base, key: 'gsap@gsap-skills', desired: true, assertWritable: (p) => p, enableWrites: true, seams: { applyFn } });
  assert.equal(r.ok, true);
  assert.equal(applyFn.calls.length, 1);
  const op = applyFn.calls[0].plan.ops[0];
  assert.equal(op.kind, 'json-edit');
  assert.deepEqual(op.selector, { key: 'gsap@gsap-skills' });
  assert.equal(op.desired, true);
  assert.equal(applyFn.calls[0].enableWrites, true);
  assert.ok(r.diagnostics.some((d) => d.code === 'plugin-toggle-restart-needed'));
});

test('apply already-in-state: takes NO snapshot (no applyFn call)', async () => {
  const applyFn = recordApply();
  const r = await setPluginEnabledClaude({ ...base, key: 'ecc@everything-claude-code', desired: true, assertWritable: (p) => p, enableWrites: true, seams: { applyFn } });
  assert.equal(r.ok, true);
  assert.equal(r.alreadyInState, true);
  assert.equal(applyFn.calls.length, 0);
  assert.ok(r.diagnostics.some((d) => d.code === 'plugin-toggle-noop'));
});

test('apply without a gate → fail-closed bad-args (no applyFn call)', async () => {
  const applyFn = recordApply();
  const r = await setPluginEnabledClaude({ ...base, key: 'gsap@gsap-skills', desired: true, enableWrites: true, seams: { applyFn } });
  assert.equal(r.refused, true);
  assert.equal(applyFn.calls.length, 0);
  assert.ok(r.diagnostics.some((d) => d.code === 'plugin-toggle-bad-args'));
});

test('never throws on a garbage opts object', async () => {
  await assert.doesNotReject(() => setPluginEnabledClaude(null));
  await assert.doesNotReject(() => setPluginEnabledClaude({}));
});
