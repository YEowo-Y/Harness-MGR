/**
 * P6 prune-config wave · U3 — test/cli-prune-config.test.mjs
 *
 * Unit tests for the `remove skill:<name> --prune-config` CLI handler
 * (src/cli/prune-config-command.mjs) and its routing from remove-command.mjs. Driven
 * directly with an injected deps seam ({loadPaths, pruneFn, env}) — fully hermetic, no real
 * fs / paths.mjs / prune engine.
 *
 * Coverage: the target-support gate (Claude refused; Codex accepted); the --cascade conflict;
 * no-spec; the RELAXED write gate (env='0' lock; env unset + --apply enables); dry-run forwards
 * configFile/componentKinds/scope; the --apply path resolves the codex gate; an engine throw;
 * the exit-code map; and that remove-command routes --prune-config here.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { pruneConfigCommand } from '../src/cli/prune-config-command.mjs';
import { removeCommand } from '../src/cli/remove-command.mjs';
import { codexDescriptor } from '../src/targets/codex.mjs';
import { claudeDescriptor } from '../src/targets/claude.mjs';

/** A ctx with positionals + flags + a target descriptor (codex by default). */
function makeCtx(positionals, flags = {}, descriptor = codexDescriptor) {
  return {
    configDir: '/fake/.codex',
    mgrStateDir: '/fake/.codex/.mgr-state',
    descriptor,
    args: { positionals, ...flags },
  };
}

/** A pruneFn recorder returning a crafted result + recording its opts. */
function recorder(result) {
  const calls = [];
  const fn = async (opts) => { calls.push(opts); return result; };
  return { fn, calls };
}

const fakeAssertWritable = () => {};
function loadPathsRecorder() {
  const calls = [];
  const fn = async () => { calls.push(true); return { assertWritable: fakeAssertWritable, makeAssertWritable: () => fakeAssertWritable }; };
  return { fn, calls };
}

// ── target support ────────────────────────────────────────────────────────────────

test('Claude target (no config surface) → code 3 prune-config-unsupported-target, engine NOT called', async () => {
  const pr = recorder({ ok: true });
  const out = await pruneConfigCommand(makeCtx(['skill:x'], {}, claudeDescriptor), { pruneFn: pr.fn, env: {} });
  assert.equal(out.code, 3);
  assert.equal(out.diagnostics[0].code, 'prune-config-unsupported-target');
  assert.equal(pr.calls.length, 0);
});

test('--cascade + --prune-config → code 3 prune-config-cascade-conflict', async () => {
  const pr = recorder({ ok: true });
  const out = await pruneConfigCommand(makeCtx(['skill:x'], { cascade: true }), { pruneFn: pr.fn, env: {} });
  assert.equal(out.code, 3);
  assert.equal(out.diagnostics[0].code, 'prune-config-cascade-conflict');
  assert.equal(pr.calls.length, 0);
});

test('codex target, no spec → code 3 prune-config-no-spec', async () => {
  const pr = recorder({ ok: true });
  const out = await pruneConfigCommand(makeCtx([], {}), { pruneFn: pr.fn, env: {} });
  assert.equal(out.code, 3);
  assert.equal(out.diagnostics[0].code, 'prune-config-no-spec');
  assert.equal(pr.calls.length, 0);
});

// ── write gate ──────────────────────────────────────────────────────────────────────

test('env=0 (opt-out lock) + --apply → code 3 writes-disabled-env, engine + loadPaths NOT called', async () => {
  const pr = recorder({ ok: true });
  const lp = loadPathsRecorder();
  const out = await pruneConfigCommand(
    makeCtx(['skill:x'], { apply: true }),
    { pruneFn: pr.fn, loadPaths: lp.fn, env: { HARNESS_MGR_ENABLE_WRITES: '0' } });
  assert.equal(out.code, 3);
  assert.equal(out.diagnostics[0].code, 'writes-disabled-env');
  assert.equal(pr.calls.length, 0);
  assert.equal(lp.calls.length, 0);
});

test('dry-run (no --apply): engine called with enableWrites:false + configFile/componentKinds/scope forwarded', async () => {
  const pr = recorder({ ok: true, dryRun: true, kind: 'skill', name: 'x', target: '/fake/.codex/skills/x', pruned: [], prunedCount: 0 });
  const out = await pruneConfigCommand(makeCtx(['skill:x'], {}), { pruneFn: pr.fn, env: {} });
  assert.equal(out.code, 0);
  assert.equal(pr.calls.length, 1);
  const o = pr.calls[0];
  assert.equal(o.enableWrites, false);
  assert.equal(o.configFile, 'config.toml');
  assert.equal(o.componentKinds, codexDescriptor.componentKinds);
  assert.equal(o.scope, codexDescriptor.snapshotScope);
  assert.equal(o.assertWritable, undefined, 'no gate resolved on the dry-run path');
});

test('--apply (env unset): resolves the codex gate and forwards it to the engine', async () => {
  const pr = recorder({ ok: true, dryRun: false, apply: { applied: true, snapshotId: 's1' } });
  const lp = loadPathsRecorder();
  const out = await pruneConfigCommand(makeCtx(['skill:x'], { apply: true }), { pruneFn: pr.fn, loadPaths: lp.fn, env: {} });
  assert.equal(out.code, 0);
  assert.equal(lp.calls.length, 1, 'paths.mjs loaded once on the apply path');
  assert.equal(pr.calls.length, 1);
  assert.equal(typeof pr.calls[0].assertWritable, 'function', 'the codex gate reached the engine');
});

test('M2 dynamic-paths load failure on --apply → code 1 write-unavailable, engine NOT called', async () => {
  const pr = recorder({ ok: true });
  const out = await pruneConfigCommand(
    makeCtx(['skill:x'], { apply: true }),
    { pruneFn: pr.fn, loadPaths: async () => { throw new Error('boom'); }, env: {} });
  assert.equal(out.code, 1);
  assert.equal(out.diagnostics[0].code, 'prune-config-write-unavailable');
  assert.equal(pr.calls.length, 0);
});

// ── exit-code map + defensive summary ───────────────────────────────────────────────

test('engine throw → code 1 prune-config-unexpected-error', async () => {
  const out = await pruneConfigCommand(makeCtx(['skill:x'], {}), { pruneFn: async () => { throw new Error('kaboom'); }, env: {} });
  assert.equal(out.code, 1);
  assert.equal(out.diagnostics[0].code, 'prune-config-unexpected-error');
});

test('refused result → code 2; failed apply → code 1; lock-not-acquired → code 6', async () => {
  const refused = await pruneConfigCommand(makeCtx(['skill:x'], {}), { pruneFn: recorder({ refused: true }).fn, env: {} });
  assert.equal(refused.code, 2);
  const failed = await pruneConfigCommand(makeCtx(['skill:x'], {}), { pruneFn: recorder({ ok: false, apply: { diagnostics: [] } }).fn, env: {} });
  assert.equal(failed.code, 1);
  const locked = await pruneConfigCommand(makeCtx(['skill:x'], {}), { pruneFn: recorder({ ok: false, apply: { lock: { acquired: false }, diagnostics: [] } }).fn, env: {} });
  assert.equal(locked.code, 6);
});

test('a null / garbage engine result degrades cleanly (handler stays total)', async () => {
  for (const bad of [null, undefined, 42, 'nope']) {
    const out = await pruneConfigCommand(makeCtx(['skill:x'], {}), { pruneFn: async () => bad, env: {} });
    assert.equal(typeof out.code, 'number');
    assert.equal(typeof out.result, 'object');
    assert.ok(Array.isArray(out.diagnostics));
  }
});

// ── routing from remove-command ─────────────────────────────────────────────────────

test('remove-command routes --prune-config to the prune handler (passing deps through)', async () => {
  const pr = recorder({ ok: true, dryRun: true, kind: 'skill', name: 'x', target: '/t', pruned: [], prunedCount: 0 });
  const out = await removeCommand(makeCtx(['skill:x'], { 'prune-config': true }), { pruneFn: pr.fn, env: {} });
  assert.equal(out.code, 0);
  assert.equal(pr.calls.length, 1, 'remove-command delegated to pruneConfigCommand which called pruneFn');
});

test('remove-command WITHOUT --prune-config does not route to the prune handler', async () => {
  // A bare remove on a codex skill spec with no --prune-config must NOT call pruneFn.
  const pr = recorder({ ok: true });
  const out = await removeCommand(makeCtx(['skill:x'], {}), { pruneFn: pr.fn, env: {} });
  assert.equal(pr.calls.length, 0, 'the default remove path is untouched by the new flag');
  assert.equal(typeof out.code, 'number');
});
