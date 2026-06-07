/**
 * P4a.U1d — remove.test.mjs (removeComponent unit tests, hermetic).
 *
 * Drives removeComponent with an INJECTED seams.applyFn recorder so the apply
 * lifecycle is never really run, and uses real mkdtemp temp trees only for the
 * on-disk existence / symlink / file refusal checks (validateSpec's read-only
 * lstat probe). The assertions prove:
 *   - the §1 refusal matrix: each bad spec/target refuses with the EXACT code AND
 *     applyFn is NEVER called (no lock, no snapshot, no write);
 *   - dry-run (default) builds a one-op delete plan, previews it, calls applyFn
 *     NEVER, emits a remove-dry-run info, and leaves the file on disk;
 *   - name normalization: `agent:foo.md` → base foo (no double .md); command kind
 *     → commands/<name>.md;
 *   - --apply calls applyFn ONCE with the delete plan, enableWrites:true, and the
 *     injected assertWritable; missing gate on --apply refuses (no applyFn);
 *   - never-throws on garbage input.
 *
 * The real-fs end-to-end oracle (real gate + real tar + rollback reversibility)
 * lives in test/integration/remove-roundtrip.test.mjs.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeComponent } from '../src/ops/remove.mjs';

const PASS = (p) => p; // passthrough write gate

/** A recording applyFn seam (async). Records every call; returns a committed result. */
function makeApply(result = {}) {
  const calls = [];
  const fn = (opts) => {
    calls.push(opts);
    return Promise.resolve({
      ok: true, state: 'committed', applied: true, opsWritten: 1,
      snapshotId: '2026-06-06T00-00-00Z', diagnostics: [], ...result,
    });
  };
  fn.calls = calls;
  return fn;
}

/** Make a fresh temp ~/.claude-like tree with agents/ + commands/ + skills/ dirs. */
function makeTree() {
  const tmp = mkdtempSync(join(tmpdir(), 'cmgr-remove-unit-'));
  mkdirSync(join(tmp, 'agents'), { recursive: true });
  mkdirSync(join(tmp, 'commands'), { recursive: true });
  mkdirSync(join(tmp, 'skills'), { recursive: true });
  return tmp;
}

function codes(res) {
  return res.diagnostics.map((d) => d.code);
}

// ── refusal matrix — each refuses with the exact code, applyFn NEVER called ──

// skill is now SUPPORTED — plugin/marketplace remain unsupported
test('refuse plugin:foo and weird:foo → remove-kind-unsupported', async () => {
  const tmp = makeTree();
  const applyFn = makeApply();
  try {
    for (const spec of ['plugin:foo', 'weird:foo', 'marketplace:foo']) {
      const res = await removeComponent({ spec, targetClaudeDir: tmp, mgrStateDir: join(tmp, '.mgr-state'), seams: { applyFn } });
      assert.equal(res.ok, false, spec);
      assert.ok(codes(res).includes('remove-kind-unsupported'), `${spec}: ${codes(res)}`);
    }
    assert.equal(applyFn.calls.length, 0);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('refuse "noColonHere" → remove-bad-spec', async () => {
  const tmp = makeTree();
  const applyFn = makeApply();
  try {
    const res = await removeComponent({ spec: 'noColonHere', targetClaudeDir: tmp, mgrStateDir: join(tmp, '.mgr-state'), seams: { applyFn } });
    assert.equal(res.ok, false);
    assert.ok(codes(res).includes('remove-bad-spec'), `codes: ${codes(res)}`);
    assert.equal(applyFn.calls.length, 0);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('refuse "agent:" (empty name) → remove-name-invalid', async () => {
  const tmp = makeTree();
  const applyFn = makeApply();
  try {
    const res = await removeComponent({ spec: 'agent:', targetClaudeDir: tmp, mgrStateDir: join(tmp, '.mgr-state'), seams: { applyFn } });
    assert.equal(res.ok, false);
    assert.ok(codes(res).includes('remove-name-invalid'), `codes: ${codes(res)}`);
    assert.equal(applyFn.calls.length, 0);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('refuse agent:foo/bar (namespaced) → remove-name-invalid', async () => {
  const tmp = makeTree();
  const applyFn = makeApply();
  try {
    const res = await removeComponent({ spec: 'agent:foo/bar', targetClaudeDir: tmp, mgrStateDir: join(tmp, '.mgr-state'), seams: { applyFn } });
    assert.equal(res.ok, false);
    assert.ok(codes(res).includes('remove-name-invalid'), `codes: ${codes(res)}`);
    assert.equal(applyFn.calls.length, 0);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('refuse agent:../secrets (traversal) → remove-name-invalid', async () => {
  const tmp = makeTree();
  const applyFn = makeApply();
  try {
    const res = await removeComponent({ spec: 'agent:../secrets', targetClaudeDir: tmp, mgrStateDir: join(tmp, '.mgr-state'), seams: { applyFn } });
    assert.equal(res.ok, false);
    assert.ok(codes(res).includes('remove-name-invalid'), `codes: ${codes(res)}`);
    assert.equal(applyFn.calls.length, 0);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('refuse agent:foo:bar (ADS / extra colon segment) → remove-name-invalid', async () => {
  const tmp = makeTree();
  const applyFn = makeApply();
  try {
    // split on FIRST colon → name is "foo:bar", which fails NAME_RE.
    const res = await removeComponent({ spec: 'agent:foo:bar', targetClaudeDir: tmp, mgrStateDir: join(tmp, '.mgr-state'), seams: { applyFn } });
    assert.equal(res.ok, false);
    assert.ok(codes(res).includes('remove-name-invalid'), `codes: ${codes(res)}`);
    assert.equal(applyFn.calls.length, 0);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('refuse agent:foo when agents/foo.md does not exist → remove-target-not-found', async () => {
  const tmp = makeTree();
  const applyFn = makeApply();
  try {
    const res = await removeComponent({ spec: 'agent:foo', targetClaudeDir: tmp, mgrStateDir: join(tmp, '.mgr-state'), seams: { applyFn } });
    assert.equal(res.ok, false);
    assert.ok(codes(res).includes('remove-target-not-found'), `codes: ${codes(res)}`);
    assert.equal(applyFn.calls.length, 0);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('refuse agent:foo when agents/foo.md is a DIRECTORY → remove-target-not-a-file', async () => {
  const tmp = makeTree();
  const applyFn = makeApply();
  try {
    mkdirSync(join(tmp, 'agents', 'foo.md'), { recursive: true });
    const res = await removeComponent({ spec: 'agent:foo', targetClaudeDir: tmp, mgrStateDir: join(tmp, '.mgr-state'), seams: { applyFn } });
    assert.equal(res.ok, false);
    assert.ok(codes(res).includes('remove-target-not-a-file'), `codes: ${codes(res)}`);
    assert.equal(applyFn.calls.length, 0);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('refuse agent:foo when agents/foo.md is a SYMLINK → remove-target-is-symlink', async (t) => {
  const tmp = makeTree();
  const applyFn = makeApply();
  try {
    writeFileSync(join(tmp, 'real-target.md'), 'x');
    try {
      symlinkSync(join(tmp, 'real-target.md'), join(tmp, 'agents', 'foo.md'));
    } catch (e) {
      t.skip(`symlink creation failed (${e.code ?? e.message}) — skipping symlink refusal assertion`);
      return;
    }
    const res = await removeComponent({ spec: 'agent:foo', targetClaudeDir: tmp, mgrStateDir: join(tmp, '.mgr-state'), seams: { applyFn } });
    assert.equal(res.ok, false);
    assert.ok(codes(res).includes('remove-target-is-symlink'), `codes: ${codes(res)}`);
    assert.equal(applyFn.calls.length, 0);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

// ── success paths ──

test('dry-run: agent:foo (present) previews, builds a one-op delete plan, never calls applyFn, leaves file', async () => {
  const tmp = makeTree();
  const applyFn = makeApply();
  try {
    const fooPath = join(tmp, 'agents', 'foo.md');
    writeFileSync(fooPath, '---\nname: foo\n---\nbody\n');
    const res = await removeComponent({ spec: 'agent:foo', targetClaudeDir: tmp, mgrStateDir: join(tmp, '.mgr-state'), seams: { applyFn } });
    assert.equal(res.ok, true);
    assert.equal(res.dryRun, true);
    assert.equal(res.refused, false);
    assert.equal(res.kind, 'agent');
    assert.equal(res.name, 'foo');
    assert.ok(res.target.endsWith(join('agents', 'foo.md')), `target: ${res.target}`);
    // one delete op with the target.
    assert.equal(res.plan.ops.length, 1);
    assert.equal(res.plan.ops[0].kind, 'delete');
    assert.equal(res.plan.ops[0].target, res.target);
    assert.equal(res.plan.apply, false); // dry-run plan
    // applyFn NEVER called, the dry-run info present, the file still on disk.
    assert.equal(applyFn.calls.length, 0);
    assert.ok(codes(res).includes('remove-dry-run'), `codes: ${codes(res)}`);
    assert.ok(existsSync(fooPath), 'agents/foo.md must still exist after a dry-run');
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('name normalization: agent:foo.md → base foo, target agents/foo.md (no double .md)', async () => {
  const tmp = makeTree();
  const applyFn = makeApply();
  try {
    const fooPath = join(tmp, 'agents', 'foo.md');
    writeFileSync(fooPath, 'x');
    const res = await removeComponent({ spec: 'agent:foo.md', targetClaudeDir: tmp, mgrStateDir: join(tmp, '.mgr-state'), seams: { applyFn } });
    assert.equal(res.ok, true);
    assert.equal(res.name, 'foo');
    assert.equal(res.target, fooPath);
    assert.ok(!res.target.endsWith('foo.md.md'), 'must not double the .md extension');
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('command:greet → target commands/greet.md', async () => {
  const tmp = makeTree();
  const applyFn = makeApply();
  try {
    const greetPath = join(tmp, 'commands', 'greet.md');
    writeFileSync(greetPath, 'x');
    const res = await removeComponent({ spec: 'command:greet', targetClaudeDir: tmp, mgrStateDir: join(tmp, '.mgr-state'), seams: { applyFn } });
    assert.equal(res.ok, true);
    assert.equal(res.kind, 'command');
    assert.equal(res.target, greetPath);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

// ── skill (DIR) kind tests ──

test('skill:foo dry-run: builds delete-dir plan, no .md extension, never calls applyFn', async () => {
  const tmp = makeTree();
  const applyFn = makeApply();
  try {
    mkdirSync(join(tmp, 'skills', 'foo'), { recursive: true });
    writeFileSync(join(tmp, 'skills', 'foo', 'SKILL.md'), '---\nname: foo\n---\nbody\n');
    const res = await removeComponent({ spec: 'skill:foo', targetClaudeDir: tmp, mgrStateDir: join(tmp, '.mgr-state'), seams: { applyFn } });
    assert.equal(res.ok, true);
    assert.equal(res.dryRun, true);
    assert.equal(res.kind, 'skill');
    assert.equal(res.name, 'foo');
    // target ends in skills/foo — NO .md extension
    assert.ok(res.target.endsWith(join('skills', 'foo')), `target: ${res.target}`);
    assert.ok(!res.target.endsWith('.md'), 'DIR target must not have .md extension');
    // plan op kind is delete-dir
    assert.equal(res.plan.ops.length, 1);
    assert.equal(res.plan.ops[0].kind, 'delete-dir');
    assert.equal(res.plan.ops[0].target, res.target);
    assert.equal(applyFn.calls.length, 0);
    assert.ok(codes(res).includes('remove-dry-run'), `codes: ${codes(res)}`);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('skill:foo missing → remove-target-not-found, applyFn never called', async () => {
  const tmp = makeTree();
  const applyFn = makeApply();
  try {
    const res = await removeComponent({ spec: 'skill:foo', targetClaudeDir: tmp, mgrStateDir: join(tmp, '.mgr-state'), seams: { applyFn } });
    assert.equal(res.ok, false);
    assert.equal(res.refused, true);
    assert.ok(codes(res).includes('remove-target-not-found'), `codes: ${codes(res)}`);
    assert.equal(applyFn.calls.length, 0);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('skill:foo when skills/foo is a FILE → remove-target-not-a-dir, applyFn never called', async () => {
  const tmp = makeTree();
  const applyFn = makeApply();
  try {
    writeFileSync(join(tmp, 'skills', 'foo'), 'not a dir');
    const res = await removeComponent({ spec: 'skill:foo', targetClaudeDir: tmp, mgrStateDir: join(tmp, '.mgr-state'), seams: { applyFn } });
    assert.equal(res.ok, false);
    assert.equal(res.refused, true);
    assert.ok(codes(res).includes('remove-target-not-a-dir'), `codes: ${codes(res)}`);
    assert.equal(applyFn.calls.length, 0);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('skill:foo when skills/foo is a SYMLINK → remove-target-is-symlink, applyFn never called', async (t) => {
  const tmp = makeTree();
  const applyFn = makeApply();
  try {
    mkdirSync(join(tmp, 'skills', 'real-foo'), { recursive: true });
    try {
      symlinkSync(join(tmp, 'skills', 'real-foo'), join(tmp, 'skills', 'foo'));
    } catch (e) {
      t.skip(`symlink creation failed (${e.code ?? e.message}) — skipping`);
      return;
    }
    const res = await removeComponent({ spec: 'skill:foo', targetClaudeDir: tmp, mgrStateDir: join(tmp, '.mgr-state'), seams: { applyFn } });
    assert.equal(res.ok, false);
    assert.ok(codes(res).includes('remove-target-is-symlink'), `codes: ${codes(res)}`);
    assert.equal(applyFn.calls.length, 0);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('--apply skill:foo calls applyFn with delete-dir op, enableWrites:true', async () => {
  const tmp = makeTree();
  const applyFn = makeApply();
  try {
    mkdirSync(join(tmp, 'skills', 'foo'), { recursive: true });
    writeFileSync(join(tmp, 'skills', 'foo', 'SKILL.md'), 'x');
    const fooDir = join(tmp, 'skills', 'foo');
    const res = await removeComponent({
      spec: 'skill:foo', targetClaudeDir: tmp, mgrStateDir: join(tmp, '.mgr-state'),
      assertWritable: PASS, enableWrites: true, pid: 4242, seams: { applyFn },
    });
    assert.equal(applyFn.calls.length, 1, 'applyFn must be called exactly once');
    const call = applyFn.calls[0];
    assert.equal(call.enableWrites, true);
    assert.equal(call.assertWritable, PASS);
    assert.equal(call.plan.ops.length, 1);
    assert.equal(call.plan.ops[0].kind, 'delete-dir');
    assert.equal(call.plan.ops[0].target, fooDir);
    assert.equal(res.ok, true);
    assert.equal(res.dryRun, false);
    assert.equal(res.kind, 'skill');
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('--apply: agent:foo calls applyFn ONCE with the delete plan, enableWrites:true, the injected gate', async () => {
  const tmp = makeTree();
  const applyFn = makeApply();
  try {
    const fooPath = join(tmp, 'agents', 'foo.md');
    writeFileSync(fooPath, 'x');
    const res = await removeComponent({
      spec: 'agent:foo', targetClaudeDir: tmp, mgrStateDir: join(tmp, '.mgr-state'),
      assertWritable: PASS, enableWrites: true, pid: 4242, seams: { applyFn },
    });
    assert.equal(applyFn.calls.length, 1, 'applyFn must be called exactly once');
    const call = applyFn.calls[0];
    assert.equal(call.enableWrites, true);
    assert.equal(call.assertWritable, PASS, 'the injected gate must be forwarded');
    assert.equal(call.targetClaudeDir, tmp);
    assert.equal(call.pid, 4242);
    // the plan handed to applyFn has the single delete op targeting agents/foo.md.
    assert.equal(call.plan.ops.length, 1);
    assert.equal(call.plan.ops[0].kind, 'delete');
    assert.equal(call.plan.ops[0].target, fooPath);
    // the result reflects the apply outcome.
    assert.equal(res.ok, true);
    assert.equal(res.dryRun, false);
    assert.ok(res.apply, 'apply result must be present');
    assert.equal(res.apply.state, 'committed');
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('--apply with missing assertWritable → refused remove-bad-args, applyFn never called', async () => {
  const tmp = makeTree();
  const applyFn = makeApply();
  try {
    writeFileSync(join(tmp, 'agents', 'foo.md'), 'x');
    const res = await removeComponent({
      spec: 'agent:foo', targetClaudeDir: tmp, mgrStateDir: join(tmp, '.mgr-state'),
      enableWrites: true, seams: { applyFn }, // no assertWritable
    });
    assert.equal(res.ok, false);
    assert.equal(res.refused, true);
    assert.ok(codes(res).includes('remove-bad-args'), `codes: ${codes(res)}`);
    assert.equal(applyFn.calls.length, 0);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

// ── never-throws ──

test('never-throws: removeComponent(undefined) returns a full-shape ok:false result', async () => {
  const res = await removeComponent(undefined);
  assert.equal(typeof res, 'object');
  assert.equal(res.ok, false);
  assert.ok(Array.isArray(res.diagnostics));
  // full shape, no undefined.
  assert.equal(res.target, null);
  assert.equal(res.plan, null);
  assert.equal(res.apply, null);
});

test('never-throws: removeComponent({}) returns a full-shape ok:false result', async () => {
  const res = await removeComponent({});
  assert.equal(res.ok, false);
  assert.ok(Array.isArray(res.diagnostics));
  assert.ok(res.diagnostics.length > 0, 'a missing targetClaudeDir must produce a diagnostic');
});
