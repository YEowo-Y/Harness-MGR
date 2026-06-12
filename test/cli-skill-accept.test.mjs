/**
 * P5.U9 (sub-unit C) — test/cli-skill-accept.test.mjs
 *
 * Unit tests for the `skill accept` CLI handler (src/cli/skill-accept-command.mjs,
 * re-exported via src/cli/skill-command.mjs) + the COMMANDS registry wiring in
 * src/cli/commands.mjs and src/cli.mjs (run(argv)).
 *
 * All tests use injected `deps` seams so no real fs, gate, or engine is invoked.
 * Tests drive skillAcceptCommand() directly (the recorder pattern) or run(argv)
 * from cli.mjs. Falsifiable oracles: exact exit codes, NEVER-called recorders for
 * the M2 / gate-closed paths, captured engine opts, and a real token-shaped literal
 * proven ABSENT from the redacted output.
 *
 * Mirrors test/cli-skill-propose.test.mjs.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { skillAcceptCommand } from '../src/cli/skill-accept-command.mjs';
import { skillAcceptCommand as skillAcceptViaCommands } from '../src/cli/commands.mjs';
import { run } from '../src/cli.mjs';

// ── helpers ────────────────────────────────────────────────────────────────────

function makeCtx(positionals = [], extra = {}) {
  return {
    configDir: '/fake/claude',
    mgrStateDir: '/fake/claude/.mgr-state',
    args: Object.assign(Object.create(null), { positionals, ...extra }),
  };
}

/** A full-shape successful dry-run AcceptResult the recorder can return. */
function dryRunResult(over = {}) {
  return {
    ok: true, refused: false, dryRun: true,
    name: 'foo', skillPath: '/fake/claude/skills/foo/SKILL.md',
    proposalId: 'SKILL.proposed-2026-01-01T00-00-00Z.md',
    proposalPath: '/fake/claude/skills/foo/SKILL.proposed-2026-01-01T00-00-00Z.md',
    sourceSha256: 'aaa', proposedSha256: 'bbb',
    stale: false, provenanceFound: true, forced: false,
    snapshotId: null, manifestChecked: false, overwritten: false,
    proposalRemoved: false, provenanceRemoved: false, lock: null, diagnostics: [],
    ...over,
  };
}

/** A full-shape successful apply AcceptResult. */
function appliedResult(over = {}) {
  return {
    ok: true, refused: false, dryRun: false,
    name: 'foo', skillPath: '/fake/claude/skills/foo/SKILL.md',
    proposalId: 'SKILL.proposed-2026-01-01T00-00-00Z.md',
    proposalPath: '/fake/claude/skills/foo/SKILL.proposed-2026-01-01T00-00-00Z.md',
    sourceSha256: 'aaa', proposedSha256: 'bbb',
    stale: false, provenanceFound: true, forced: false,
    snapshotId: '2026-01-01T00-00-00Z', manifestChecked: true, overwritten: true,
    proposalRemoved: true, provenanceRemoved: true, lock: { acquired: true }, diagnostics: [],
    ...over,
  };
}

// ── 1. no name → code 3, skill-accept-no-name, acceptFn NEVER called ────────────

test('skillAcceptCommand: no name → code 3, skill-accept-no-name, acceptFn never called', async () => {
  let called = false;
  const deps = { acceptFn: () => { called = true; return {}; } };
  const out = await skillAcceptCommand(makeCtx([]), deps);
  assert.equal(out.code, 3);
  assert.ok(out.diagnostics.some((d) => d.code === 'skill-accept-no-name'), 'expected skill-accept-no-name');
  assert.equal(called, false, 'acceptFn must not be called when name is missing');
});

test('skillAcceptCommand: empty-string name → code 3', async () => {
  let called = false;
  const deps = { acceptFn: () => { called = true; return {}; } };
  const out = await skillAcceptCommand(makeCtx(['']), deps);
  assert.equal(out.code, 3);
  assert.equal(called, false);
});

// ── 2. gate-locked (--apply + env=0): code 3, loadPaths + acceptFn NEVER called ─

test('skillAcceptCommand: --apply + CLAUDE_MGR_ENABLE_WRITES=0 → code 3, writes-disabled-env, engine never', async () => {
  let acceptCalled = false;
  let loadPathsCalled = false;
  const deps = {
    acceptFn: () => { acceptCalled = true; return Promise.resolve({}); },
    loadPaths: () => { loadPathsCalled = true; return Promise.resolve({ assertWritable: (p) => p }); },
    env: { CLAUDE_MGR_ENABLE_WRITES: '0' },
  };
  const out = await skillAcceptCommand(makeCtx(['foo'], { apply: true }), deps);
  assert.equal(out.code, 3, `expected code 3, got ${out.code}`);
  assert.ok(out.diagnostics.some((d) => d.code === 'writes-disabled-env'), 'expected writes-disabled-env');
  assert.equal(acceptCalled, false, 'acceptFn must not be called when gate is closed');
  assert.equal(loadPathsCalled, false, 'loadPaths must not be called when gate is closed');
});

// ── 3. dry-run: loadPaths NEVER called, acceptFn gets enableWrites:false, code 0 ─

test('skillAcceptCommand: dry-run → code 0, loadPaths never called, acceptFn enableWrites:false', async () => {
  let loadPathsCalled = false;
  let captured;
  const deps = {
    loadPaths: () => { loadPathsCalled = true; return Promise.resolve({ assertWritable: (p) => p }); },
    acceptFn: (opts) => { captured = opts; return Promise.resolve(dryRunResult()); },
    env: {},
  };
  const out = await skillAcceptCommand(makeCtx(['foo']), deps);
  assert.equal(out.code, 0, `expected code 0, got ${out.code}; diags: ${JSON.stringify(out.diagnostics)}`);
  assert.equal(out.result.status, 'dry-run');
  assert.equal(out.result.stale, false);
  assert.equal(loadPathsCalled, false, 'loadPaths must NOT be called on dry-run (M2-safety)');
  assert.equal(captured.enableWrites, false, 'enableWrites must be false on dry-run');
  assert.equal(captured.assertWritable, undefined, 'assertWritable must be undefined on dry-run');
  assert.equal(captured.name, 'foo');
  assert.equal(captured.force, false);
});

// ── 4. engine refused → code 2 ───────────────────────────────────────────────────

test('skillAcceptCommand: engine refused (e.g. ambiguous) → code 2, status refused', async () => {
  const deps = {
    acceptFn: () => Promise.resolve(dryRunResult({
      ok: false, refused: true, dryRun: false,
      diagnostics: [{ severity: 'error', code: 'accept-ambiguous', phase: 'accept', message: 'two proposals' }],
    })),
    env: {},
  };
  const out = await skillAcceptCommand(makeCtx(['foo']), deps);
  assert.equal(out.code, 2, `expected code 2, got ${out.code}`);
  assert.equal(out.result.status, 'refused');
});

// ── 5. engine accept-stale → code 2 ──────────────────────────────────────────────

test('skillAcceptCommand: engine accept-stale → code 2', async () => {
  const deps = {
    loadPaths: () => Promise.resolve({ assertWritable: (p) => p }),
    acceptFn: () => Promise.resolve(dryRunResult({
      ok: false, refused: true, dryRun: false, stale: true,
      diagnostics: [{ severity: 'error', code: 'accept-stale', phase: 'accept', message: 'drifted' }],
    })),
    env: {},
  };
  const out = await skillAcceptCommand(makeCtx(['foo'], { apply: true }), deps);
  assert.equal(out.code, 2, `expected code 2 for accept-stale, got ${out.code}`);
  assert.equal(out.result.status, 'refused');
});

// ── 6. engine lock-failed → code 6 ──────────────────────────────────────────────

test('skillAcceptCommand: lock not acquired → code 6 (wins over refused)', async () => {
  const deps = {
    loadPaths: () => Promise.resolve({ assertWritable: (p) => p }),
    acceptFn: () => Promise.resolve(dryRunResult({
      ok: false, refused: true, dryRun: false,
      lock: { acquired: false, reason: 'held' },
      diagnostics: [{ severity: 'error', code: 'accept-lock-failed', phase: 'accept', message: 'lock held' }],
    })),
    env: {},
  };
  const out = await skillAcceptCommand(makeCtx(['foo'], { apply: true }), deps);
  assert.equal(out.code, 6, `expected code 6 (lock-failed wins over refused), got ${out.code}`);
});

// ── 7. engine snapshot-failed → code 4 ──────────────────────────────────────────

test('skillAcceptCommand: snapshot-failed → code 4', async () => {
  const deps = {
    loadPaths: () => Promise.resolve({ assertWritable: (p) => p }),
    acceptFn: () => Promise.resolve(dryRunResult({
      ok: false, refused: true, dryRun: false, lock: { acquired: true },
      diagnostics: [{ severity: 'error', code: 'accept-snapshot-failed', phase: 'accept', message: 'snap failed' }],
    })),
    env: {},
  };
  const out = await skillAcceptCommand(makeCtx(['foo'], { apply: true }), deps);
  assert.equal(out.code, 4, `expected code 4 for accept-snapshot-failed, got ${out.code}`);
});

test('skillAcceptCommand: target-not-snapshotted → code 4', async () => {
  const deps = {
    loadPaths: () => Promise.resolve({ assertWritable: (p) => p }),
    acceptFn: () => Promise.resolve(dryRunResult({
      ok: false, refused: true, dryRun: false, lock: { acquired: true },
      diagnostics: [{ severity: 'error', code: 'accept-target-not-snapshotted', phase: 'accept', message: 'not captured' }],
    })),
    env: {},
  };
  const out = await skillAcceptCommand(makeCtx(['foo'], { apply: true }), deps);
  assert.equal(out.code, 4, `expected code 4 for accept-target-not-snapshotted, got ${out.code}`);
});

// ── 8. engine ok apply → code 0, enableWrites:true, assertWritable injected ─────

test('skillAcceptCommand: --apply + env unset → code 0, loadPaths called, acceptFn enableWrites:true + assertWritable fn', async () => {
  let loadPathsCalled = false;
  let captured;
  const fakeGate = (p) => p;
  const deps = {
    loadPaths: () => { loadPathsCalled = true; return Promise.resolve({ assertWritable: fakeGate }); },
    acceptFn: (opts) => { captured = opts; return Promise.resolve(appliedResult()); },
    env: {}, // env unset → relaxed gate allows writes with --apply
  };
  const out = await skillAcceptCommand(makeCtx(['foo'], { apply: true }), deps);
  assert.equal(out.code, 0, `expected code 0, got ${out.code}; diags: ${JSON.stringify(out.diagnostics)}`);
  assert.equal(out.result.status, 'accepted');
  assert.equal(out.result.overwritten, true);
  assert.equal(out.result.proposalId, 'SKILL.proposed-2026-01-01T00-00-00Z.md');
  assert.equal(out.result.snapshotId, '2026-01-01T00-00-00Z');
  assert.equal(loadPathsCalled, true, 'loadPaths must be called when gate is open');
  assert.equal(captured.enableWrites, true, 'enableWrites must be true on --apply');
  assert.equal(captured.assertWritable, fakeGate, 'assertWritable must be the injected gate fn');
});

// ── 9. loadPaths throwing → code 1 with the degrade warn ────────────────────────

test('skillAcceptCommand: loadPaths throws on --apply → code 1, skill-accept-write-unavailable, acceptFn never called', async () => {
  let acceptCalled = false;
  const deps = {
    loadPaths: () => Promise.reject(new Error('hooks lib boom')),
    acceptFn: () => { acceptCalled = true; return Promise.resolve(appliedResult()); },
    env: {},
  };
  const out = await skillAcceptCommand(makeCtx(['foo'], { apply: true }), deps);
  assert.equal(out.code, 1, `expected code 1, got ${out.code}`);
  assert.equal(out.result.status, 'write-unavailable');
  assert.ok(out.diagnostics.some((d) => d.code === 'skill-accept-write-unavailable'), 'expected the degrade warn');
  assert.equal(acceptCalled, false, 'acceptFn must not be called when the gate import fails');
});

// ── 10. --force threads through to the engine ────────────────────────────────────

test('skillAcceptCommand: --force threads through (acceptFn called with force:true)', async () => {
  let captured;
  const deps = {
    loadPaths: () => Promise.resolve({ assertWritable: (p) => p }),
    acceptFn: (opts) => { captured = opts; return Promise.resolve(appliedResult({ forced: true })); },
    env: {},
  };
  const out = await skillAcceptCommand(makeCtx(['foo'], { apply: true, force: true }), deps);
  assert.equal(out.code, 0, `expected code 0, got ${out.code}`);
  assert.equal(captured.force, true, 'force must be threaded to the engine as true');
  assert.equal(out.result.forced, true);
});

test('skillAcceptCommand: proposalId positional threads through to the engine', async () => {
  let captured;
  const deps = {
    acceptFn: (opts) => { captured = opts; return Promise.resolve(dryRunResult()); },
    env: {},
  };
  // positionals[1] is the proposal id (full leaf form).
  await skillAcceptCommand(makeCtx(['foo', 'SKILL.proposed-2026-01-01T00-00-00Z.md']), deps);
  assert.equal(captured.proposalId, 'SKILL.proposed-2026-01-01T00-00-00Z.md', 'proposalId positional must thread through');
});

// ── 11. never-throws on a buggy injected engine seam ────────────────────────────

test('skillAcceptCommand: acceptFn that throws → code 1, clean error (never throws)', async () => {
  const deps = { acceptFn: () => { throw new Error('engine boom'); }, env: {} };
  const out = await skillAcceptCommand(makeCtx(['foo']), deps);
  assert.equal(out.code, 1);
  assert.equal(out.result.status, 'error');
  assert.ok(out.diagnostics.some((d) => d.code === 'skill-accept-unexpected-error'));
});

// ── 12. redaction: a token-shaped literal in a diagnostic is redacted ────────────

test('skillAcceptCommand: a ghp_ token in the result/diagnostics is redacted in the command output', async () => {
  const TOKEN = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
  const deps = {
    acceptFn: () => Promise.resolve(dryRunResult({
      diagnostics: [{ severity: 'info', code: 'accept-dry-run', phase: 'accept', message: `would overwrite with token ${TOKEN}` }],
    })),
    env: {},
  };
  const out = await skillAcceptCommand(makeCtx(['foo']), deps);
  assert.equal(out.code, 0);
  const blob = JSON.stringify(out);
  assert.ok(!blob.includes(TOKEN), `the raw token must be redacted from the output, but found it in: ${blob.slice(0, 400)}`);
});

// ── 13. registry: skill:accept is registered + re-exported + dispatched ──────────

test('commands.mjs: skillAcceptCommand is exported', () => {
  assert.equal(typeof skillAcceptViaCommands, 'function', 'skillAcceptCommand should be a function export');
});

test('run(argv): skill accept with no name → code 3', async () => {
  const r = await run(['skill', 'accept', '--config-dir', '/nonexistent-dir-cmgr-test']);
  assert.equal(r.code, 3, `expected code 3, got ${r.code}`);
  assert.ok(!r.stdout.includes('unknown command: skill'), `skill must be dispatched, not unknown: ${r.stdout.slice(0, 300)}`);
});

test('run(argv): usage text includes skill accept <name>', async () => {
  const r = await run([]);
  assert.ok(r.stdout.includes('skill accept'), `usage text should mention skill accept, got: ${r.stdout.slice(0, 700)}`);
});
