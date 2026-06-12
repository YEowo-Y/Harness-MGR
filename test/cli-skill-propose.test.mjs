/**
 * P5.U8 (sub-unit C) — test/cli-skill-propose.test.mjs
 *
 * Unit tests for src/cli/skill-command.mjs + the COMMANDS registry wiring in
 * src/cli/commands.mjs and src/cli.mjs (run(argv)).
 *
 * All tests use injected `deps` seams so no real fs, gate, or engine is invoked.
 * Tests drive skillProposeCommand() directly (the recorder pattern) or run(argv)
 * from cli.mjs. Falsifiable oracles: exact exit codes, NEVER-called recorders for
 * the M2 / gate-closed paths, captured engine opts, and a real token-shaped literal
 * proven ABSENT from the redacted output.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { skillProposeCommand } from '../src/cli/skill-command.mjs';
import { skillProposeCommand as skillProposeViaCommands } from '../src/cli/commands.mjs';
import { run } from '../src/cli.mjs';

// ── helpers ────────────────────────────────────────────────────────────────────

function makeCtx(positionals = [], extra = {}) {
  return {
    configDir: '/fake/claude',
    mgrStateDir: '/fake/claude/.mgr-state',
    args: Object.assign(Object.create(null), { positionals, ...extra }),
  };
}

/** A full-shape successful dry-run ProposeResult the recorder can return. */
function dryRunResult(over = {}) {
  return {
    ok: true, refused: false, dryRun: true,
    name: 'foo', skillPath: '/fake/claude/skills/foo/SKILL.md',
    target: '/fake/claude/skills/foo/SKILL.proposed-2026-01-01T00-00-00Z.md',
    proposalId: 'SKILL.proposed-2026-01-01T00-00-00Z.md',
    sourceSha256: 'aaa', proposedSha256: 'bbb', changed: true,
    stats: { added: 1, deleted: 1, unchanged: 5 }, unified: '--- a\n+++ b\n-x\n+y\n',
    provenancePath: null, provenanceWritten: false, lock: null, diagnostics: [],
    ...over,
  };
}

/** A full-shape successful apply ProposeResult. */
function appliedResult(over = {}) {
  return {
    ok: true, refused: false, dryRun: false,
    name: 'foo', skillPath: '/fake/claude/skills/foo/SKILL.md',
    target: '/fake/claude/skills/foo/SKILL.proposed-2026-01-01T00-00-00Z.md',
    proposalId: 'SKILL.proposed-2026-01-01T00-00-00Z.md',
    sourceSha256: 'aaa', proposedSha256: 'bbb', changed: true,
    stats: { added: 1, deleted: 1, unchanged: 5 }, unified: '--- a\n+++ b\n-x\n+y\n',
    provenancePath: '/fake/claude/.mgr-state/proposals/foo-2026-01-01T00-00-00Z.json',
    provenanceWritten: true, lock: { acquired: true }, diagnostics: [],
    ...over,
  };
}

// ── 1. no name → code 3, skill-propose-no-name, proposeFn NEVER called ──────────

test('skillProposeCommand: no name → code 3, skill-propose-no-name, proposeFn never called', async () => {
  let called = false;
  const deps = { proposeFn: () => { called = true; return {}; } };
  const out = await skillProposeCommand(makeCtx([], { from: '/tmp/x' }), deps);
  assert.equal(out.code, 3);
  assert.ok(out.diagnostics.some((d) => d.code === 'skill-propose-no-name'), 'expected skill-propose-no-name');
  assert.equal(called, false, 'proposeFn must not be called when name is missing');
});

test('skillProposeCommand: empty-string name → code 3', async () => {
  let called = false;
  const deps = { proposeFn: () => { called = true; return {}; } };
  const out = await skillProposeCommand(makeCtx([''], { from: '/tmp/x' }), deps);
  assert.equal(out.code, 3);
  assert.equal(called, false);
});

// ── 2. no --from → code 3, propose-no-source, proposeFn NEVER called ────────────

test('skillProposeCommand: no --from → code 3, propose-no-source, proposeFn never called', async () => {
  let called = false;
  const deps = { proposeFn: () => { called = true; return {}; } };
  const out = await skillProposeCommand(makeCtx(['foo']), deps);
  assert.equal(out.code, 3);
  assert.ok(out.diagnostics.some((d) => d.code === 'propose-no-source'), 'expected propose-no-source');
  assert.equal(called, false, 'proposeFn must not be called when --from is missing');
});

// ── 3. gate-locked (--apply + env=0): code 3, loadPaths + proposeFn NEVER called ─

test('skillProposeCommand: --apply + CLAUDE_MGR_ENABLE_WRITES=0 → code 3, writes-disabled-env, engine never', async () => {
  let proposeCalled = false;
  let loadPathsCalled = false;
  const deps = {
    proposeFn: () => { proposeCalled = true; return Promise.resolve({}); },
    loadPaths: () => { loadPathsCalled = true; return Promise.resolve({ assertWritable: (p) => p }); },
    env: { CLAUDE_MGR_ENABLE_WRITES: '0' },
  };
  const out = await skillProposeCommand(makeCtx(['foo'], { from: '/tmp/x', apply: true }), deps);
  assert.equal(out.code, 3, `expected code 3, got ${out.code}`);
  assert.ok(out.diagnostics.some((d) => d.code === 'writes-disabled-env'), 'expected writes-disabled-env');
  assert.equal(proposeCalled, false, 'proposeFn must not be called when gate is closed');
  assert.equal(loadPathsCalled, false, 'loadPaths must not be called when gate is closed');
});

// ── 4. dry-run: loadPaths NEVER called, proposeFn gets enableWrites:false, code 0 ─

test('skillProposeCommand: dry-run → code 0, loadPaths never called, proposeFn enableWrites:false', async () => {
  let loadPathsCalled = false;
  let captured;
  const deps = {
    loadPaths: () => { loadPathsCalled = true; return Promise.resolve({ assertWritable: (p) => p }); },
    proposeFn: (opts) => { captured = opts; return Promise.resolve(dryRunResult()); },
    env: {},
  };
  const out = await skillProposeCommand(makeCtx(['foo'], { from: '/tmp/x' }), deps);
  assert.equal(out.code, 0, `expected code 0, got ${out.code}; diags: ${JSON.stringify(out.diagnostics)}`);
  assert.equal(out.result.status, 'dry-run');
  assert.equal(loadPathsCalled, false, 'loadPaths must NOT be called on dry-run (M2-safety)');
  assert.equal(captured.enableWrites, false, 'enableWrites must be false on dry-run');
  assert.equal(captured.assertWritable, undefined, 'assertWritable must be undefined on dry-run');
  assert.equal(captured.name, 'foo');
  assert.equal(captured.fromPath, '/tmp/x');
});

// ── 5. engine refused → code 2 ───────────────────────────────────────────────────

test('skillProposeCommand: engine refused (e.g. name-invalid) → code 2, status refused', async () => {
  const deps = {
    proposeFn: () => Promise.resolve(dryRunResult({
      ok: false, refused: true, dryRun: false,
      diagnostics: [{ severity: 'error', code: 'propose-skill-not-found', phase: 'propose', message: 'no skill' }],
    })),
    env: {},
  };
  const out = await skillProposeCommand(makeCtx(['foo'], { from: '/tmp/x' }), deps);
  assert.equal(out.code, 2, `expected code 2, got ${out.code}`);
  assert.equal(out.result.status, 'refused');
});

// ── 6. engine lock-failed → code 6 ──────────────────────────────────────────────

test('skillProposeCommand: lock not acquired → code 6', async () => {
  const deps = {
    loadPaths: () => Promise.resolve({ assertWritable: (p) => p }),
    proposeFn: () => Promise.resolve(dryRunResult({
      ok: false, refused: true, dryRun: false,
      lock: { acquired: false, reason: 'held' },
      diagnostics: [{ severity: 'error', code: 'propose-lock-failed', phase: 'propose', message: 'lock held' }],
    })),
    env: {},
  };
  const out = await skillProposeCommand(makeCtx(['foo'], { from: '/tmp/x', apply: true }), deps);
  assert.equal(out.code, 6, `expected code 6 (lock-failed wins over refused), got ${out.code}`);
});

// ── 7. engine ok apply → code 0, enableWrites:true, assertWritable injected ─────

test('skillProposeCommand: --apply + env unset → code 0, loadPaths called, proposeFn enableWrites:true + assertWritable fn', async () => {
  let loadPathsCalled = false;
  let captured;
  const fakeGate = (p) => p;
  const deps = {
    loadPaths: () => { loadPathsCalled = true; return Promise.resolve({ assertWritable: fakeGate }); },
    proposeFn: (opts) => { captured = opts; return Promise.resolve(appliedResult()); },
    env: {}, // env unset → relaxed gate allows writes with --apply
  };
  const out = await skillProposeCommand(makeCtx(['foo'], { from: '/tmp/x', apply: true }), deps);
  assert.equal(out.code, 0, `expected code 0, got ${out.code}; diags: ${JSON.stringify(out.diagnostics)}`);
  assert.equal(out.result.status, 'proposed');
  assert.equal(out.result.provenanceWritten, true);
  assert.equal(out.result.proposalId, 'SKILL.proposed-2026-01-01T00-00-00Z.md');
  assert.equal(loadPathsCalled, true, 'loadPaths must be called when gate is open');
  assert.equal(captured.enableWrites, true, 'enableWrites must be true on --apply');
  assert.equal(captured.assertWritable, fakeGate, 'assertWritable must be the injected gate fn');
});

// ── 8. loadPaths throwing → code 1 with the degrade warn ────────────────────────

test('skillProposeCommand: loadPaths throws on --apply → code 1, skill-propose-write-unavailable, proposeFn never called', async () => {
  let proposeCalled = false;
  const deps = {
    loadPaths: () => Promise.reject(new Error('hooks lib boom')),
    proposeFn: () => { proposeCalled = true; return Promise.resolve(appliedResult()); },
    env: {},
  };
  const out = await skillProposeCommand(makeCtx(['foo'], { from: '/tmp/x', apply: true }), deps);
  assert.equal(out.code, 1, `expected code 1, got ${out.code}`);
  assert.equal(out.result.status, 'write-unavailable');
  assert.ok(out.diagnostics.some((d) => d.code === 'skill-propose-write-unavailable'), 'expected the degrade warn');
  assert.equal(proposeCalled, false, 'proposeFn must not be called when the gate import fails');
});

// ── 9. redaction: a token-shaped literal in the unified diff is redacted ─────────

test('skillProposeCommand: a ghp_ token in the unified diff is redacted in the command output', async () => {
  // A realistic GitHub PAT shape (ghp_ + 36 base62 chars) the secret-text redactor catches.
  const TOKEN = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
  const leakyUnified = `--- a\n+++ b\n-old line\n+new line with secret ${TOKEN} embedded\n`;
  const deps = {
    proposeFn: () => Promise.resolve(dryRunResult({ unified: leakyUnified })),
    env: {},
  };
  const out = await skillProposeCommand(makeCtx(['foo'], { from: '/tmp/x' }), deps);
  assert.equal(out.code, 0);
  // The whole command output must NOT contain the raw token anywhere.
  const blob = JSON.stringify(out);
  assert.ok(!blob.includes(TOKEN), `the raw token must be redacted from the output, but found it in: ${blob.slice(0, 400)}`);
  // And the result.unified is still a string (redaction replaced the token in-place).
  assert.equal(typeof out.result.unified, 'string');
  assert.ok(out.result.unified.includes('new line with'), 'the non-secret diff text survives redaction');
});

// ── 10. never-throws on a buggy injected engine seam ────────────────────────────

test('skillProposeCommand: proposeFn that throws → code 1, clean error (never throws)', async () => {
  const deps = { proposeFn: () => { throw new Error('engine boom'); }, env: {} };
  const out = await skillProposeCommand(makeCtx(['foo'], { from: '/tmp/x' }), deps);
  assert.equal(out.code, 1);
  assert.equal(out.result.status, 'error');
  assert.ok(out.diagnostics.some((d) => d.code === 'skill-propose-unexpected-error'));
});

// ── 11. registry: skill:propose is registered + re-exported ─────────────────────

test('commands.mjs: skillProposeCommand is exported', () => {
  assert.equal(typeof skillProposeViaCommands, 'function', 'skillProposeCommand should be a function export');
});

test('run(argv): skill propose with no name → code 3', async () => {
  const r = await run(['skill', 'propose', '--config-dir', '/nonexistent-dir-cmgr-test']);
  assert.equal(r.code, 3, `expected code 3, got ${r.code}`);
  assert.ok(!r.stdout.includes('unknown command: skill'), `skill must be dispatched, not unknown: ${r.stdout.slice(0, 300)}`);
});

test('run(argv): usage text includes skill propose <name> --from <file>', async () => {
  const r = await run([]);
  assert.ok(r.stdout.includes('skill propose'), `usage text should mention skill propose, got: ${r.stdout.slice(0, 600)}`);
});
