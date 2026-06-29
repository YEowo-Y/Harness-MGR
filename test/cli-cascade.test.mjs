/**
 * test/cli-cascade.test.mjs
 *
 * Unit tests for the `remove <kind>:<name> --cascade` CLI handler
 * (src/cli/cascade-command.mjs). Drives cascadeCommand directly with an injected
 * deps seam ({loadPaths, cascadeFn, env}) — fully hermetic, no real fs / no real
 * paths.mjs / no real cascade engine.
 *
 * Coverage focus (the handler's branches): no-spec; the RELAXED write gate
 * (env='0' opt-out lock → refused; env unset / '1' + --apply → enabled); dry-run;
 * the M2 dynamic-paths load failure; an engine throw; the full exit-code map
 * (0/1/2/3/4/6); and the defensive summary.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { cascadeCommand } from '../src/cli/cascade-command.mjs';

/** A ctx with the given positionals + flag bag, plus an optional target descriptor. */
function makeCtx(positionals, flags = {}, descriptor) {
  return {
    configDir: '/fake/.claude',
    mgrStateDir: '/fake/.claude/.mgr-state',
    descriptor,
    args: { positionals, ...flags },
  };
}

/** Minimal codex descriptor stub — the guard only reads `.id`. */
const CODEX_DESCRIPTOR = { id: 'codex', label: 'OpenAI Codex' };
/** Minimal claude descriptor stub — proves the guard is codex-specific. */
const CLAUDE_DESCRIPTOR = { id: 'claude', label: 'Claude Code' };

/** A cascadeFn recorder that returns a crafted CascadeResult and records its opts. */
function recorder(result) {
  const calls = [];
  const fn = async (opts) => { calls.push(opts); return result; };
  return { fn, calls };
}

const fakeAssertWritable = () => {};
/** loadPaths seam returning a fake assertWritable; records whether it was called. */
function loadPathsRecorder() {
  const calls = [];
  const fn = async () => { calls.push(true); return { assertWritable: fakeAssertWritable }; };
  return { fn, calls };
}

// ── no-spec ─────────────────────────────────────────────────────────────────────

test('cascadeCommand: missing spec → code 3, cascade-no-spec, engine NOT called', async () => {
  const cas = recorder({ ok: true });
  const out = await cascadeCommand(makeCtx([], { apply: true }), { cascadeFn: cas.fn, env: {} });
  assert.equal(out.code, 3);
  assert.equal(out.result.status, 'no-spec');
  assert.equal(out.diagnostics[0].code, 'cascade-no-spec');
  assert.equal(cas.calls.length, 0, 'engine must not run without a spec');
});

// ── codex guard ─────────────────────────────────────────────────────────────────
// --cascade is a Claude-only feature (its edge model reads Claude skill frontmatter).
// A codex target must refuse cleanly BEFORE any discovery / write, never run the
// Claude cascade machinery against ~/.codex.

test('cascadeCommand: --target codex → refused cascade-unsupported-for-codex, code 3, engine NOT called', async () => {
  const cas = recorder({ ok: true });
  const lp = loadPathsRecorder();
  const out = await cascadeCommand(
    makeCtx(['skill:foo'], { apply: false }, CODEX_DESCRIPTOR),
    { cascadeFn: cas.fn, loadPaths: lp.fn, env: {} },
  );
  assert.equal(out.code, 3);
  assert.equal(out.result.status, 'unsupported-target');
  assert.equal(out.diagnostics[0].code, 'cascade-unsupported-for-codex');
  assert.match(out.diagnostics[0].message, /--prune-config/, 'must route the user to the codex paths that work');
  assert.equal(cas.calls.length, 0, 'codex must never reach the cascade engine');
  assert.equal(lp.calls.length, 0, 'codex must never load the write gate');
});

test('cascadeCommand: --target codex with NO spec → codex refusal wins over no-spec (checked first)', async () => {
  const cas = recorder({ ok: true });
  const out = await cascadeCommand(
    makeCtx([], {}, CODEX_DESCRIPTOR),
    { cascadeFn: cas.fn, env: {} },
  );
  assert.equal(out.code, 3);
  assert.equal(out.diagnostics[0].code, 'cascade-unsupported-for-codex',
    'the codex guard must precede the no-spec check (a spec would not help on codex)');
  assert.equal(cas.calls.length, 0);
});

test('cascadeCommand: --target codex with --apply --force → STILL refused before the write gate (no codex write)', async () => {
  const cas = recorder({ ok: true });
  const lp = loadPathsRecorder();
  const out = await cascadeCommand(
    makeCtx(['skill:foo'], { apply: true, force: true }, CODEX_DESCRIPTOR),
    { cascadeFn: cas.fn, loadPaths: lp.fn, env: {} },
  );
  assert.equal(out.code, 3);
  assert.equal(out.diagnostics[0].code, 'cascade-unsupported-for-codex');
  assert.equal(cas.calls.length, 0, 'the guard must fire before the engine even on the --apply path');
  assert.equal(lp.calls.length, 0, 'the guard must fire before paths.mjs loads — the dangerous codex write path is sealed');
});

test('cascadeCommand: claude descriptor (id "claude") → guard does NOT fire, engine runs (codex-specific guard)', async () => {
  const cas = recorder({ ok: true, dryRun: true, target: 'agent:foo', dependents: [] });
  const out = await cascadeCommand(
    makeCtx(['agent:foo'], {}, CLAUDE_DESCRIPTOR),
    { cascadeFn: cas.fn, env: {} },
  );
  assert.equal(out.code, 0);
  assert.equal(cas.calls.length, 1, 'a claude target must reach the engine — the guard is codex-only');
  assert.equal(out.result.status, 'dry-run');
});

test('cascadeCommand: undefined / null / {} / other-id / "CODEX" descriptors do NOT fire the guard (exact id==="codex" only)', async () => {
  // The guard fires ONLY on an own descriptor.id === 'codex' (case-sensitive). Every other
  // shape — absent, null, id-less, a different target id, or a different-cased 'CODEX' —
  // must fall through to the engine, never the codex refusal.
  for (const descriptor of [undefined, null, {}, { id: 'other-target' }, { id: 'CODEX' }]) {
    const cas = recorder({ ok: true, dryRun: true, target: 'agent:foo', dependents: [] });
    const out = await cascadeCommand(
      makeCtx(['agent:foo'], {}, descriptor),
      { cascadeFn: cas.fn, env: {} },
    );
    assert.equal(cas.calls.length, 1,
      `descriptor ${JSON.stringify(descriptor)} must reach the engine (guard fires only on id==='codex')`);
    assert.notEqual(out.result.status, 'unsupported-target',
      `descriptor ${JSON.stringify(descriptor)} must not produce the codex refusal`);
  }
});

// ── RELAXED write gate ────────────────────────────────────────────────────────────

test('cascadeCommand: env=0 (opt-out lock) + --apply → code 3 writes-disabled-env, engine + loadPaths NOT called', async () => {
  const cas = recorder({ ok: true });
  const lp = loadPathsRecorder();
  const out = await cascadeCommand(
    makeCtx(['agent:foo'], { apply: true, force: true }),
    { cascadeFn: cas.fn, loadPaths: lp.fn, env: { HARNESS_MGR_ENABLE_WRITES: '0' } },
  );
  assert.equal(out.code, 3);
  assert.equal(out.result.status, 'refused');
  assert.equal(out.diagnostics[0].code, 'writes-disabled-env');
  assert.equal(cas.calls.length, 0, 'engine must not run when the gate is locked out');
  assert.equal(lp.calls.length, 0, 'paths.mjs must not load when the gate is locked out');
});

test('cascadeCommand: env UNSET + --apply → ENABLED (relaxation: enableWrites:true reaches the engine)', async () => {
  const cas = recorder({ ok: true, dryRun: false, target: 'agent:foo', dependents: [] });
  const lp = loadPathsRecorder();
  const out = await cascadeCommand(
    makeCtx(['agent:foo'], { apply: true, force: true }),
    { cascadeFn: cas.fn, loadPaths: lp.fn, env: {} },
  );
  assert.equal(out.code, 0);
  assert.equal(cas.calls.length, 1);
  assert.equal(cas.calls[0].enableWrites, true, 'unset env + --apply must enable writes (the off-ramp relaxation)');
  assert.equal(cas.calls[0].assertWritable, fakeAssertWritable, 'the write gate must be threaded on --apply');
  assert.equal(cas.calls[0].force, true);
  assert.equal(lp.calls.length, 1, 'paths.mjs loads on the real --apply path');
});

test('cascadeCommand: env=1 + --apply → ENABLED (back-compat)', async () => {
  const cas = recorder({ ok: true, dryRun: false, target: 'agent:foo', dependents: [] });
  const lp = loadPathsRecorder();
  const out = await cascadeCommand(
    makeCtx(['agent:foo'], { apply: true, force: true }),
    { cascadeFn: cas.fn, loadPaths: lp.fn, env: { HARNESS_MGR_ENABLE_WRITES: '1' } },
  );
  assert.equal(out.code, 0);
  assert.equal(cas.calls[0].enableWrites, true);
});

test('cascadeCommand: dry-run (no --apply) → enableWrites:false, no paths load, code 0', async () => {
  const cas = recorder({ ok: true, dryRun: true, target: 'agent:foo', dependents: [{ id: 'skill:trace' }], preview: { wouldRemove: ['agent:foo', 'skill:trace'] } });
  const lp = loadPathsRecorder();
  const out = await cascadeCommand(
    makeCtx(['agent:foo'], { /* no apply */ }),
    { cascadeFn: cas.fn, loadPaths: lp.fn, env: {} },
  );
  assert.equal(out.code, 0);
  assert.equal(cas.calls[0].enableWrites, false, 'dry-run must not enable writes');
  assert.equal(cas.calls[0].assertWritable, undefined, 'dry-run must not resolve the write gate');
  assert.equal(lp.calls.length, 0, 'dry-run must never load paths.mjs (M2-safe)');
  assert.equal(out.result.status, 'dry-run');
  assert.deepEqual(out.result.wouldRemove, ['agent:foo', 'skill:trace']);
  assert.equal(out.result.dependentCount, 1);
  assert.equal(out.result.total, 2);
});

// ── M2 dynamic-paths load failure ────────────────────────────────────────────────

test('cascadeCommand: loadPaths throws on --apply → code 1, cascade-write-unavailable, engine NOT called', async () => {
  const cas = recorder({ ok: true });
  const badLoad = async () => { throw new Error('hooks/lib missing'); };
  const out = await cascadeCommand(
    makeCtx(['agent:foo'], { apply: true, force: true }),
    { cascadeFn: cas.fn, loadPaths: badLoad, env: {} },
  );
  assert.equal(out.code, 1);
  assert.equal(out.result.status, 'write-unavailable');
  assert.equal(out.diagnostics[0].code, 'cascade-write-unavailable');
  assert.equal(cas.calls.length, 0, 'engine must not run if the write gate cannot load');
});

// ── engine throw ─────────────────────────────────────────────────────────────────

test('cascadeCommand: cascadeFn throws → code 1, cascade-unexpected-error (never propagates)', async () => {
  const badFn = async () => { throw new Error('boom'); };
  const out = await cascadeCommand(
    makeCtx(['agent:foo'], { /* dry-run */ }),
    { cascadeFn: badFn, env: {} },
  );
  assert.equal(out.code, 1);
  assert.equal(out.result.status, 'error');
  assert.equal(out.diagnostics[0].code, 'cascade-unexpected-error');
});

// ── exit-code map ────────────────────────────────────────────────────────────────

test('cascadeCommand: refused with cascade-needs-force → code 3', async () => {
  const cas = recorder({ refused: true, diagnostics: [{ code: 'cascade-needs-force', severity: 'error' }] });
  const out = await cascadeCommand(makeCtx(['agent:foo'], {}), { cascadeFn: cas.fn, env: {} });
  assert.equal(out.code, 3);
  assert.equal(out.result.status, 'refused');
});

test('cascadeCommand: refused with a validation diag (not needs-force) → code 2', async () => {
  const cas = recorder({ refused: true, diagnostics: [{ code: 'cascade-target-not-found', severity: 'error' }] });
  const out = await cascadeCommand(makeCtx(['agent:foo'], {}), { cascadeFn: cas.fn, env: {} });
  assert.equal(out.code, 2);
});

test('cascadeCommand: apply lock not acquired → code 6', async () => {
  const cas = recorder({ ok: false, apply: { applied: false, lock: { acquired: false } }, diagnostics: [] });
  const out = await cascadeCommand(
    makeCtx(['agent:foo'], { apply: true, force: true }),
    { cascadeFn: cas.fn, loadPaths: loadPathsRecorder().fn, env: {} },
  );
  assert.equal(out.code, 6);
});

test('cascadeCommand: apply-snapshot-failed → code 4', async () => {
  const cas = recorder({ ok: false, apply: { applied: false, lock: { acquired: true }, diagnostics: [{ code: 'apply-snapshot-failed', severity: 'error' }] }, diagnostics: [] });
  const out = await cascadeCommand(
    makeCtx(['agent:foo'], { apply: true, force: true }),
    { cascadeFn: cas.fn, loadPaths: loadPathsRecorder().fn, env: {} },
  );
  assert.equal(out.code, 4);
});

test('cascadeCommand: a generic apply failure → code 1', async () => {
  const cas = recorder({ ok: false, apply: { applied: false, lock: { acquired: true }, diagnostics: [] }, diagnostics: [] });
  const out = await cascadeCommand(
    makeCtx(['agent:foo'], { apply: true, force: true }),
    { cascadeFn: cas.fn, loadPaths: loadPathsRecorder().fn, env: {} },
  );
  assert.equal(out.code, 1);
});

test('cascadeCommand: successful apply → code 0, status removed, snapshot + lock surfaced', async () => {
  const cas = recorder({
    ok: true, dryRun: false, target: 'agent:foo', dependents: [{ id: 'skill:trace' }],
    apply: { applied: true, snapshotId: '2026-06-09T10-00-00Z', lock: { acquired: true } },
  });
  const out = await cascadeCommand(
    makeCtx(['agent:foo'], { apply: true, force: true }),
    { cascadeFn: cas.fn, loadPaths: loadPathsRecorder().fn, env: {} },
  );
  assert.equal(out.code, 0);
  assert.equal(out.result.status, 'removed');
  assert.equal(out.result.applied, true);
  assert.equal(out.result.snapshotId, '2026-06-09T10-00-00Z');
  assert.equal(out.result.lockAcquired, true);
  assert.equal(out.result.total, 2);
});

// ── defensive summary ────────────────────────────────────────────────────────────

test('cascadeCommand: a non-object engine result is tolerated (defensive summary)', async () => {
  const badFn = async () => null;
  const out = await cascadeCommand(makeCtx(['agent:foo'], {}), { cascadeFn: badFn, env: {} });
  // null result → summarizeCascade defaults, exit code from cascadeExitCode(null-ish)
  assert.ok(out.result && typeof out.result === 'object');
  assert.equal(out.result.ok, false);
  assert.equal(out.diagnostics.length, 0, 'a null result yields no diagnostics array → []');
});
