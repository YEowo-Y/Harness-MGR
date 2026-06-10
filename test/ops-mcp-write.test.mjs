/**
 * Tests for src/ops/mcp-write.mjs (P4b.U6) — the `mcp remove <name>` delegator.
 *
 * Falsifiable oracles (assert EXACT values + call ORDER via spies, never just
 * truthy): the §2 refusal matrix; the advisory not-found info; dry-run writes
 * nothing + emits the §5 caveats (scope-dependent); the --apply happy path takes
 * the snapshot BEFORE the spawn with the EXACT argv; --apply gate/exe/snapshot/
 * spawn failure modes; never-throws on hostile input.
 *
 * Spec: docs/phase-4b-mcp-design.md §6.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mcpRemove, MCP_REMOVE_SCHEMA, VALID_SCOPES } from '../src/ops/mcp-write.mjs';

// ── helpers ───────────────────────────────────────────────────────────────────

const TARGET = '/abs/.claude';
const STATE = '/abs/.mgr-state';

/** An McpServerRecord factory. */
function rec(over = {}) {
  return { name: 'foo', scope: 'project', transport: 'stdio', command: 'node', args: ['x'], ...over };
}

/** A discoverMcp seam returning the given records. */
function fakeDiscover(servers) {
  return () => ({ mcpServers: servers, diagnostics: [] });
}

/** Find a diagnostic by code. */
function diag(result, code) {
  return result.diagnostics.find((d) => d.code === code) || null;
}

/** A native-exe resolveClaudeExe seam. */
function nativeClaude() {
  return () => ({ exe: '/abs/claude', kind: 'native', diagnostics: [] });
}

/** A no-op assertWritable gate (returns the path). */
function gate(p) { return p; }

/** A sequence recorder shared by spies to assert call ORDER. */
function makeSeq() {
  const seq = [];
  return {
    seq,
    snapshot(over = {}) {
      return async () => { seq.push('snapshot'); return { ok: true, snapshotId: '2026-06-07T00-00-00Z', diagnostics: [], ...over }; };
    },
    spawn(impl) {
      return async (spec) => { seq.push('spawn'); this._lastSpec = spec; if (impl) return impl(spec); return { stdout: '', stderr: '' }; };
    },
    audit() {
      return (args) => { seq.push('audit'); this._lastAudit = args; return { written: true, diagnostics: [] }; };
    },
  };
}

// ── refusal: bad name ─────────────────────────────────────────────────────────

test('refuses empty / null / number / metachar name → mcp-bad-spec, spawn NEVER called', async () => {
  for (const name of ['', null, undefined, 42, 'foo;rm', 'a/b', '../x', 'a b', '-rf', 'foo|x', 'foo$(id)', 'a\\b']) {
    const spawnSpy = () => { throw new Error('spawn must not be called'); };
    const r = await mcpRemove({ name, targetClaudeDir: TARGET, mgrStateDir: STATE,
      seams: { discoverMcpFn: fakeDiscover([rec()]), spawnFn: spawnSpy } });
    assert.equal(r.ok, false, `name=${String(name)}`);
    assert.equal(r.refused, true, `name=${String(name)}`);
    assert.ok(diag(r, 'mcp-bad-spec'), `name=${String(name)} expected mcp-bad-spec`);
    assert.equal(r.spawned, false);
  }
});

// ── refusal: bad scope ────────────────────────────────────────────────────────

test('refuses an invalid --scope → mcp-bad-scope, refused', async () => {
  for (const scope of ['global', 'x', 'Project', 'system']) {
    const r = await mcpRemove({ name: 'foo', scope, targetClaudeDir: TARGET, mgrStateDir: STATE,
      seams: { discoverMcpFn: fakeDiscover([rec()]) } });
    assert.equal(r.refused, true, `scope=${scope}`);
    assert.ok(diag(r, 'mcp-bad-scope'), `scope=${scope} expected mcp-bad-scope`);
  }
});

test('accepts every valid scope enum value', async () => {
  for (const scope of VALID_SCOPES) {
    const r = await mcpRemove({ name: 'foo', scope, targetClaudeDir: TARGET, mgrStateDir: STATE,
      seams: { discoverMcpFn: fakeDiscover([rec({ scope })]) } });
    assert.equal(r.refused, false, `scope=${scope}`);
    assert.equal(r.ok, true);
    assert.equal(r.dryRun, true);
  }
});

// ── refusal: bad args ─────────────────────────────────────────────────────────

test('refuses missing targetClaudeDir → mcp-bad-args', async () => {
  const r = await mcpRemove({ name: 'foo', targetClaudeDir: '', mgrStateDir: STATE });
  assert.equal(r.refused, true);
  assert.ok(diag(r, 'mcp-bad-args'));
});

// ── advisory: server not visible (NOT a refusal) ──────────────────────────────

test('not-found is ADVISORY: a valid name absent from discovery → info mcp-server-not-visible, still ok dry-run', async () => {
  const r = await mcpRemove({ name: 'ghost', targetClaudeDir: TARGET, mgrStateDir: STATE,
    seams: { discoverMcpFn: fakeDiscover([]) } });
  assert.equal(r.refused, false, 'not-found must NOT refuse');
  assert.equal(r.ok, true);
  assert.equal(r.dryRun, true);
  assert.equal(r.server, null);
  assert.ok(diag(r, 'mcp-server-not-visible'), 'expected the advisory info');
});

// ── dry-run (default) ─────────────────────────────────────────────────────────

test('dry-run (default) writes NOTHING: neither createSnapshot nor spawn is called; exact command (scoped)', async () => {
  let snapCalled = false;
  let spawnCalled = false;
  const r = await mcpRemove({ name: 'foo', scope: 'project', targetClaudeDir: TARGET, mgrStateDir: STATE,
    seams: {
      discoverMcpFn: fakeDiscover([rec()]),
      createSnapshotFn: async () => { snapCalled = true; return { ok: true, diagnostics: [] }; },
      spawnFn: async () => { spawnCalled = true; return { stdout: '', stderr: '' }; },
    } });
  assert.equal(snapCalled, false, 'createSnapshot must NOT be called in dry-run');
  assert.equal(spawnCalled, false, 'spawn must NOT be called in dry-run');
  assert.equal(r.ok, true);
  assert.equal(r.dryRun, true);
  assert.deepEqual(r.command, ['mcp', 'remove', 'foo', '--scope', 'project']);
  assert.ok(diag(r, 'mcp-dry-run'));
  assert.ok(diag(r, 'mcp-restart-required'));
});

test('dry-run with NO scope: command omits --scope', async () => {
  const r = await mcpRemove({ name: 'foo', targetClaudeDir: TARGET, mgrStateDir: STATE,
    seams: { discoverMcpFn: fakeDiscover([rec()]) } });
  assert.equal(r.ok, true);
  assert.equal(r.dryRun, true);
  assert.deepEqual(r.command, ['mcp', 'remove', 'foo']);
  assert.equal(r.scope, null);
});

test('mcp-user-scope-not-snapshotted caveat: present for user AND for no-scope, ABSENT for project', async () => {
  // scope:user → present
  const ru = await mcpRemove({ name: 'foo', scope: 'user', targetClaudeDir: TARGET, mgrStateDir: STATE,
    seams: { discoverMcpFn: fakeDiscover([rec({ scope: 'user' })]) } });
  assert.ok(diag(ru, 'mcp-user-scope-not-snapshotted'), 'scope:user must warn');
  // scope undefined → present
  const rn = await mcpRemove({ name: 'foo', targetClaudeDir: TARGET, mgrStateDir: STATE,
    seams: { discoverMcpFn: fakeDiscover([rec()]) } });
  assert.ok(diag(rn, 'mcp-user-scope-not-snapshotted'), 'no scope must warn');
  // scope:project → ABSENT (reversible)
  const rp = await mcpRemove({ name: 'foo', scope: 'project', targetClaudeDir: TARGET, mgrStateDir: STATE,
    seams: { discoverMcpFn: fakeDiscover([rec()]) } });
  assert.equal(diag(rp, 'mcp-user-scope-not-snapshotted'), null, 'scope:project must NOT warn');
});

// ── --apply happy path ────────────────────────────────────────────────────────

test('--apply happy (scope:project): snapshot BEFORE spawn, with the EXACT argv + exe; audit recorded', async () => {
  const s = makeSeq();
  const r = await mcpRemove({
    name: 'foo', scope: 'project', targetClaudeDir: TARGET, mgrStateDir: STATE,
    assertWritable: gate, enableWrites: true,
    seams: {
      discoverMcpFn: fakeDiscover([rec()]),
      resolveClaudeFn: nativeClaude(),
      createSnapshotFn: s.snapshot(), spawnFn: s.spawn(), auditFn: s.audit(),
    },
  });
  // ORDER: snapshot BEFORE spawn BEFORE audit.
  assert.deepEqual(s.seq, ['snapshot', 'spawn', 'audit']);
  // The spawn spec carries the resolved exe + the exact argv + the schema.
  assert.equal(s._lastSpec.exe, '/abs/claude');
  assert.deepEqual(s._lastSpec.args, ['mcp', 'remove', 'foo', '--scope', 'project']);
  assert.equal(s._lastSpec.schema, MCP_REMOVE_SCHEMA);
  // Result shape.
  assert.equal(r.ok, true);
  assert.equal(r.refused, false);
  assert.equal(r.dryRun, false);
  assert.equal(r.spawned, true);
  assert.equal(r.claudeExe, '/abs/claude');
  assert.equal(r.scope, 'project');
  assert.equal(r.snapshotId, '2026-06-07T00-00-00Z');
  // Audit recorded exactly once with command 'mcp-remove'.
  assert.equal(s._lastAudit.entry.command, 'mcp-remove');
});

// ── --apply refusals / failures ───────────────────────────────────────────────

test('--apply with no assertWritable gate → mcp-bad-args, no snapshot/spawn', async () => {
  let snapCalled = false;
  let spawnCalled = false;
  const r = await mcpRemove({
    name: 'foo', scope: 'project', targetClaudeDir: TARGET, mgrStateDir: STATE, enableWrites: true,
    seams: {
      discoverMcpFn: fakeDiscover([rec()]),
      resolveClaudeFn: nativeClaude(),
      createSnapshotFn: async () => { snapCalled = true; return { ok: true, diagnostics: [] }; },
      spawnFn: async () => { spawnCalled = true; },
    },
  });
  assert.equal(r.refused, true);
  assert.ok(diag(r, 'mcp-bad-args'));
  assert.equal(snapCalled, false);
  assert.equal(spawnCalled, false);
});

test('--apply not-spawnable → mcp-claude-not-spawnable; snapshot+spawn NEVER called; message has the command', async () => {
  let snapCalled = false;
  let spawnCalled = false;
  const r = await mcpRemove({
    name: 'foo', scope: 'project', targetClaudeDir: TARGET, mgrStateDir: STATE,
    assertWritable: gate, enableWrites: true,
    seams: {
      discoverMcpFn: fakeDiscover([rec()]),
      resolveClaudeFn: () => ({ exe: null, kind: null, diagnostics: [] }),
      createSnapshotFn: async () => { snapCalled = true; return { ok: true, diagnostics: [] }; },
      spawnFn: async () => { spawnCalled = true; },
    },
  });
  assert.equal(r.refused, true);
  const d = diag(r, 'mcp-claude-not-spawnable');
  assert.ok(d, 'expected mcp-claude-not-spawnable');
  assert.match(d.message, /claude mcp remove/);
  assert.equal(snapCalled, false, 'must NOT snapshot when no exe');
  assert.equal(spawnCalled, false, 'must NOT spawn when no exe');
});

test('--apply snapshot-fail → ok:false, mcp-snapshot-failed, spawn NEVER called', async () => {
  let spawnCalled = false;
  const r = await mcpRemove({
    name: 'foo', scope: 'project', targetClaudeDir: TARGET, mgrStateDir: STATE,
    assertWritable: gate, enableWrites: true,
    seams: {
      discoverMcpFn: fakeDiscover([rec()]),
      resolveClaudeFn: nativeClaude(),
      createSnapshotFn: async () => ({ ok: false, diagnostics: [{ severity: 'error', code: 'snapshot-x', message: 'x' }] }),
      spawnFn: async () => { spawnCalled = true; },
    },
  });
  assert.equal(r.ok, false);
  assert.ok(diag(r, 'mcp-snapshot-failed'));
  assert.ok(diag(r, 'snapshot-x'), 'snapshot diagnostics are aggregated');
  assert.equal(spawnCalled, false, 'must NOT spawn after a failed snapshot');
});

test('--apply spawn-fail → ok:false, mcp-spawn-failed, BUT createSnapshot WAS called (kept as undo)', async () => {
  let snapCalled = false;
  const r = await mcpRemove({
    name: 'foo', scope: 'project', targetClaudeDir: TARGET, mgrStateDir: STATE,
    assertWritable: gate, enableWrites: true,
    seams: {
      discoverMcpFn: fakeDiscover([rec()]),
      resolveClaudeFn: nativeClaude(),
      createSnapshotFn: async () => { snapCalled = true; return { ok: true, snapshotId: 'snap-1', diagnostics: [] }; },
      spawnFn: async () => { throw new Error('boom'); },
      auditFn: () => ({ written: true }),
    },
  });
  assert.equal(snapCalled, true, 'snapshot WAS taken (it stays as the undo point)');
  assert.equal(r.ok, false);
  assert.equal(r.spawned, true);
  const d = diag(r, 'mcp-spawn-failed');
  assert.ok(d, 'expected mcp-spawn-failed');
  assert.match(d.message, /boom/);
  assert.equal(r.snapshotId, 'snap-1');
});

test('--apply audit failure degrades to a warn, never flips ok', async () => {
  const r = await mcpRemove({
    name: 'foo', scope: 'project', targetClaudeDir: TARGET, mgrStateDir: STATE,
    assertWritable: gate, enableWrites: true,
    seams: {
      discoverMcpFn: fakeDiscover([rec()]),
      resolveClaudeFn: nativeClaude(),
      createSnapshotFn: async () => ({ ok: true, snapshotId: 's', diagnostics: [] }),
      spawnFn: async () => ({ stdout: '', stderr: '' }),
      auditFn: () => { throw new Error('audit down'); },
    },
  });
  assert.equal(r.ok, true, 'audit failure must not flip ok');
  assert.ok(diag(r, 'mcp-audit-unavailable'));
});

// ── never-throws ──────────────────────────────────────────────────────────────

test('never throws: mcpRemove(null) → full-shape {ok:false}', async () => {
  const r = await mcpRemove(null);
  assert.equal(r.ok, false);
  assert.equal(r.refused, true);
  assert.equal(r.spawned, false);
  assert.ok(Array.isArray(r.diagnostics));
  for (const k of ['ok', 'refused', 'dryRun', 'name', 'scope', 'server', 'claudeExe', 'command', 'snapshotId', 'spawned', 'apply', 'diagnostics']) {
    assert.ok(k in r, `result missing key ${k}`);
  }
});

test('never throws: mcpRemove({name:42}) → bad-spec refusal, no throw', async () => {
  const r = await mcpRemove({ name: 42, targetClaudeDir: TARGET, mgrStateDir: STATE });
  assert.equal(r.ok, false);
  assert.ok(diag(r, 'mcp-bad-spec'));
});

test('never throws: a throwing seam degrades to mcp-unexpected-error', async () => {
  const r = await mcpRemove({
    name: 'foo', targetClaudeDir: TARGET, mgrStateDir: STATE,
    seams: { discoverMcpFn: () => { throw new Error('discover blew up'); } },
  });
  assert.equal(r.ok, false);
  const d = diag(r, 'mcp-unexpected-error');
  assert.ok(d, 'expected mcp-unexpected-error');
  assert.match(d.message, /discover blew up/);
});

// ── manifest cross-check tests ────────────────────────────────────────────────

function fakeManifest(paths) {
  return JSON.stringify({ files: paths.map((p) => ({ path: p, preSha256: 'aaa', currentSha256: 'aaa' })) });
}

test('manifest cross-check (project scope): .mcp.json absent from manifest → mcp-target-not-snapshotted, spawn NEVER called', async () => {
  const spawnCalls = [];
  const snapId = '2026-06-07T00-00-00Z';
  const manifestPath = '/fake/snapshots/' + snapId + '/manifest.json';

  const r = await mcpRemove({
    name: 'foo', scope: 'project', targetClaudeDir: TARGET, mgrStateDir: STATE,
    assertWritable: gate, enableWrites: true,
    seams: {
      discoverMcpFn: fakeDiscover([rec()]),
      resolveClaudeFn: nativeClaude(),
      createSnapshotFn: async () => ({
        ok: true, snapshotId: snapId, manifestPath, diagnostics: [],
      }),
      // Manifest does NOT contain .mcp.json
      manifestReadFileFn: () => fakeManifest(['CLAUDE.md', 'settings.json']),
      // The target DOES exist on disk
      existsFn: () => true,
      spawnFn: async (spec) => { spawnCalls.push(spec); return { stdout: '', stderr: '' }; },
      auditFn: () => ({ written: true, diagnostics: [] }),
    },
  });

  assert.equal(r.ok, false, 'should be refused');
  assert.equal(r.spawned, false, 'spawn must NOT be called');
  assert.equal(spawnCalls.length, 0, 'spawnFn must not be called');
  const d = diag(r, 'mcp-target-not-snapshotted');
  assert.ok(d, 'mcp-target-not-snapshotted diagnostic must be present');
  assert.equal(d.severity, 'error');
});

test('manifest cross-check (project scope): .mcp.json present in manifest → spawn proceeds', async () => {
  const spawnCalls = [];
  const snapId = '2026-06-07T00-00-00Z';
  const manifestPath = '/fake/snapshots/' + snapId + '/manifest.json';

  const r = await mcpRemove({
    name: 'foo', scope: 'project', targetClaudeDir: TARGET, mgrStateDir: STATE,
    assertWritable: gate, enableWrites: true,
    seams: {
      discoverMcpFn: fakeDiscover([rec()]),
      resolveClaudeFn: nativeClaude(),
      createSnapshotFn: async () => ({
        ok: true, snapshotId: snapId, manifestPath, diagnostics: [],
      }),
      manifestReadFileFn: () => fakeManifest(['.mcp.json', 'CLAUDE.md']),
      existsFn: () => true,
      spawnFn: async (spec) => { spawnCalls.push(spec); return { stdout: '', stderr: '' }; },
      auditFn: () => ({ written: true, diagnostics: [] }),
    },
  });

  assert.equal(r.ok, true);
  assert.equal(r.spawned, true);
  assert.equal(spawnCalls.length, 1);
  assert.ok(!diag(r, 'mcp-target-not-snapshotted'));
});

test('manifest cross-check: user scope → NO refusal even when .mcp.json missing from manifest', async () => {
  const spawnCalls = [];
  const snapId = '2026-06-07T00-00-00Z';
  const manifestPath = '/fake/snapshots/' + snapId + '/manifest.json';

  const r = await mcpRemove({
    name: 'foo', scope: 'user', targetClaudeDir: TARGET, mgrStateDir: STATE,
    assertWritable: gate, enableWrites: true,
    seams: {
      discoverMcpFn: fakeDiscover([rec()]),
      resolveClaudeFn: nativeClaude(),
      createSnapshotFn: async () => ({
        ok: true, snapshotId: snapId, manifestPath, diagnostics: [],
      }),
      // Manifest is empty — but scope=user so check is skipped
      manifestReadFileFn: () => fakeManifest([]),
      existsFn: () => true,
      spawnFn: async (spec) => { spawnCalls.push(spec); return { stdout: '', stderr: '' }; },
      auditFn: () => ({ written: true, diagnostics: [] }),
    },
  });

  assert.equal(r.ok, true, 'user scope: no cross-check refusal expected');
  assert.equal(r.spawned, true);
  assert.ok(!diag(r, 'mcp-target-not-snapshotted'));
});

test('manifest cross-check: scope OMITTED (undefined) → check skipped, NO refusal even when manifest is empty', async () => {
  // An unscoped removal sends ['mcp','remove',name] with no --scope; only
  // scope:'project' is documented reversible, so the cross-check must not fire here
  // (the snapshot is still keepAll-complete — the skip only means we don't REFUSE).
  const spawnCalls = [];
  const snapId = '2026-06-07T00-00-00Z';
  const manifestPath = '/fake/snapshots/' + snapId + '/manifest.json';

  const r = await mcpRemove({
    name: 'foo', targetClaudeDir: TARGET, mgrStateDir: STATE,
    assertWritable: gate, enableWrites: true,
    seams: {
      discoverMcpFn: fakeDiscover([rec()]),
      resolveClaudeFn: nativeClaude(),
      createSnapshotFn: async () => ({
        ok: true, snapshotId: snapId, manifestPath, diagnostics: [],
      }),
      // Manifest is empty — but scope is omitted so the check is skipped
      manifestReadFileFn: () => fakeManifest([]),
      existsFn: () => true,
      spawnFn: async (spec) => { spawnCalls.push(spec); return { stdout: '', stderr: '' }; },
      auditFn: () => ({ written: true, diagnostics: [] }),
    },
  });

  assert.equal(r.ok, true, 'omitted scope: no cross-check refusal expected');
  assert.equal(r.spawned, true);
  assert.deepEqual(r.command, ['mcp', 'remove', 'foo'], 'unscoped argv carries no --scope');
  assert.ok(!diag(r, 'mcp-target-not-snapshotted'));
});

test('manifest cross-check (project scope): target does not exist on disk → no refusal', async () => {
  const spawnCalls = [];
  const snapId = '2026-06-07T00-00-00Z';
  const manifestPath = '/fake/snapshots/' + snapId + '/manifest.json';

  const r = await mcpRemove({
    name: 'foo', scope: 'project', targetClaudeDir: TARGET, mgrStateDir: STATE,
    assertWritable: gate, enableWrites: true,
    seams: {
      discoverMcpFn: fakeDiscover([rec()]),
      resolveClaudeFn: nativeClaude(),
      createSnapshotFn: async () => ({
        ok: true, snapshotId: snapId, manifestPath, diagnostics: [],
      }),
      // Manifest empty, but existsFn returns false → check is skipped
      manifestReadFileFn: () => fakeManifest([]),
      existsFn: () => false,
      spawnFn: async (spec) => { spawnCalls.push(spec); return { stdout: '', stderr: '' }; },
      auditFn: () => ({ written: true, diagnostics: [] }),
    },
  });

  assert.equal(r.ok, true, 'non-existent .mcp.json must not cause a refusal');
  assert.equal(r.spawned, true);
  assert.ok(!diag(r, 'mcp-target-not-snapshotted'));
});
