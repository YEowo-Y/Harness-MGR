/**
 * Tests for src/ops/update.mjs (P4b.U5) — the `update <plugin>` delegator.
 *
 * Falsifiable oracles (assert EXACT values + call ORDER via spies, never just
 * truthy): the §3 refusal matrix; dry-run writes nothing + emits the §6 caveats;
 * the --apply happy path takes the snapshot BEFORE the spawn with the EXACT argv;
 * --apply gate/exe/snapshot/spawn failure modes; an injection defense-in-depth
 * check against the REAL safeSpawn validator; never-throws on hostile input.
 *
 * Spec: docs/phase-4b-update-design.md §9.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { updatePlugin, CLAUDE_PLUGIN_UPDATE_SCHEMA } from '../src/ops/update.mjs';
import { validateSpawnSpec } from '../src/lib/safe-spawn.mjs';

// ── helpers ───────────────────────────────────────────────────────────────────

const TARGET = '/abs/.claude';
const STATE = '/abs/.mgr-state';

/** A PluginRecord factory. */
function rec(over = {}) {
  return {
    key: 'foo@market', name: 'foo', marketplace: 'market',
    version: '1.0.0', enabled: true, cachePresent: true, ...over,
  };
}

/** A discoverPlugins seam returning the given records. */
function fakeDiscover(plugins) {
  return () => ({ plugins, diagnostics: [] });
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

// ── refusal: bad spec ───────────────────────────────────────────────────────────

test('refuses empty / null / number spec → update-bad-spec, spawn NEVER called', async () => {
  for (const spec of ['', null, undefined, 42]) {
    const spawnSpy = () => { throw new Error('spawn must not be called'); };
    const r = await updatePlugin({ spec, targetClaudeDir: TARGET, mgrStateDir: STATE,
      seams: { spawnFn: spawnSpy } });
    assert.equal(r.ok, false, `spec=${String(spec)}`);
    assert.equal(r.refused, true);
    assert.ok(diag(r, 'update-bad-spec'), `spec=${String(spec)} expected update-bad-spec`);
    assert.equal(r.spawned, false);
  }
});

test('refuses spec with shell/path metacharacters → update-bad-spec', async () => {
  for (const spec of ['foo;rm', 'a/b', '../x', 'a b', 'foo|bar', 'a$(b)', 'a\\b', 'foo:bar']) {
    let spawnCalled = false;
    const r = await updatePlugin({ spec, targetClaudeDir: TARGET, mgrStateDir: STATE,
      seams: { discoverPluginsFn: fakeDiscover([rec()]), spawnFn: () => { spawnCalled = true; } } });
    assert.equal(r.refused, true, `spec=${spec}`);
    assert.ok(diag(r, 'update-bad-spec'), `spec=${spec} expected update-bad-spec`);
    assert.equal(spawnCalled, false, `spec=${spec} must not spawn`);
  }
});

test('refuses missing targetClaudeDir → update-bad-args', async () => {
  const r = await updatePlugin({ spec: 'foo', targetClaudeDir: '', mgrStateDir: STATE });
  assert.equal(r.refused, true);
  assert.ok(diag(r, 'update-bad-args'));
});

// ── defense-in-depth: re-validate the RESOLVED key, not just the raw spec ─────────

test('--apply with a poisoned record.key refuses BEFORE snapshot/spawn → update-bad-spec', async () => {
  // The spec is a SAFE bare name, but the DISCOVERED record carries a
  // metacharacter-laden key (a corrupt/poisoned installed_plugins.json). record.key
  // — not the raw spec — is what reaches argv, so it must be re-validated and refused
  // before ANY snapshot/spawn side effect. (Pins the security-review Medium fix;
  // RED pre-fix, where the key flowed to the spawn after a wasted snapshot.)
  const seq = makeSeq();
  const poisoned = rec({ name: 'foo', key: 'foo@m; rm -rf ~' });
  const r = await updatePlugin({
    spec: 'foo', targetClaudeDir: TARGET, mgrStateDir: STATE, assertWritable: gate,
    enableWrites: true,
    seams: { discoverPluginsFn: fakeDiscover([poisoned]), resolveClaudeFn: nativeClaude(),
      createSnapshotFn: seq.snapshot(), spawnFn: seq.spawn() },
  });
  assert.equal(r.refused, true);
  assert.ok(diag(r, 'update-bad-spec'), 'expected update-bad-spec for the poisoned key');
  assert.deepEqual(seq.seq, [], 'no snapshot and no spawn — refused before any side effect');
});

// ── refusal: not found / ambiguous ───────────────────────────────────────────────

test('refuses a spec not present in the plugin list → update-plugin-not-found', async () => {
  const r = await updatePlugin({ spec: 'absent', targetClaudeDir: TARGET, mgrStateDir: STATE,
    seams: { discoverPluginsFn: fakeDiscover([rec({ name: 'foo', key: 'foo@market' })]) } });
  assert.equal(r.refused, true);
  assert.ok(diag(r, 'update-plugin-not-found'));
});

test('refuses a bare name installed from TWO marketplaces → update-plugin-ambiguous naming both keys', async () => {
  const plugins = [
    rec({ name: 'dup', marketplace: 'mkt-a', key: 'dup@mkt-a' }),
    rec({ name: 'dup', marketplace: 'mkt-b', key: 'dup@mkt-b' }),
  ];
  const r = await updatePlugin({ spec: 'dup', targetClaudeDir: TARGET, mgrStateDir: STATE,
    seams: { discoverPluginsFn: fakeDiscover(plugins) } });
  assert.equal(r.refused, true);
  const d = diag(r, 'update-plugin-ambiguous');
  assert.ok(d, 'expected update-plugin-ambiguous');
  assert.match(d.message, /dup@mkt-a/);
  assert.match(d.message, /dup@mkt-b/);
});

test('an @-qualified spec disambiguates among same-name records (resolves by key)', async () => {
  const plugins = [
    rec({ name: 'dup', marketplace: 'mkt-a', key: 'dup@mkt-a' }),
    rec({ name: 'dup', marketplace: 'mkt-b', key: 'dup@mkt-b' }),
  ];
  const r = await updatePlugin({ spec: 'dup@mkt-b', targetClaudeDir: TARGET, mgrStateDir: STATE,
    seams: { discoverPluginsFn: fakeDiscover(plugins) } });
  assert.equal(r.refused, false);
  assert.equal(r.ok, true);
  assert.equal(r.dryRun, true);
  assert.deepEqual(r.command, ['plugin', 'update', 'dup@mkt-b']);
});

// ── dry-run (default) ────────────────────────────────────────────────────────────

test('dry-run (default) writes NOTHING: neither createSnapshot nor spawn is called', async () => {
  let snapCalled = false;
  let spawnCalled = false;
  const r = await updatePlugin({ spec: 'foo', targetClaudeDir: TARGET, mgrStateDir: STATE,
    seams: {
      discoverPluginsFn: fakeDiscover([rec()]),
      createSnapshotFn: async () => { snapCalled = true; return { ok: true, diagnostics: [] }; },
      spawnFn: async () => { spawnCalled = true; return { stdout: '', stderr: '' }; },
    } });
  assert.equal(snapCalled, false, 'createSnapshot must NOT be called in dry-run');
  assert.equal(spawnCalled, false, 'spawn must NOT be called in dry-run');
  assert.equal(r.ok, true);
  assert.equal(r.dryRun, true);
  assert.deepEqual(r.command, ['plugin', 'update', 'foo@market']);
  assert.ok(diag(r, 'update-cache-not-snapshotted'), 'expected the §6 cache caveat');
  assert.ok(diag(r, 'update-dry-run'));
  assert.ok(diag(r, 'update-restart-required'));
});

test('--lock-version reports an unsupported info', async () => {
  const r = await updatePlugin({ spec: 'foo', targetClaudeDir: TARGET, mgrStateDir: STATE,
    lockVersion: '1.2.3', seams: { discoverPluginsFn: fakeDiscover([rec()]) } });
  assert.ok(diag(r, 'update-lock-version-unsupported'));
});

// ── --apply happy path ───────────────────────────────────────────────────────────

test('--apply happy: snapshot is taken BEFORE spawn, with the EXACT argv; audit recorded', async () => {
  const s = makeSeq();
  const snapFn = s.snapshot();
  const spawnFn = s.spawn();
  const auditFn = s.audit();
  const r = await updatePlugin({
    spec: 'foo', targetClaudeDir: TARGET, mgrStateDir: STATE,
    assertWritable: gate, enableWrites: true,
    seams: {
      discoverPluginsFn: fakeDiscover([rec()]),
      resolveClaudeFn: nativeClaude(),
      createSnapshotFn: snapFn, spawnFn, auditFn,
    },
  });
  // ORDER: snapshot BEFORE spawn.
  assert.deepEqual(s.seq, ['snapshot', 'spawn', 'audit']);
  // The spawn spec carries the resolved exe + the exact argv.
  assert.equal(s._lastSpec.exe, '/abs/claude');
  assert.deepEqual(s._lastSpec.args, ['plugin', 'update', 'foo@market']);
  assert.equal(s._lastSpec.schema, CLAUDE_PLUGIN_UPDATE_SCHEMA);
  // Result shape.
  assert.equal(r.ok, true);
  assert.equal(r.refused, false);
  assert.equal(r.dryRun, false);
  assert.equal(r.spawned, true);
  assert.equal(r.claudeExe, '/abs/claude');
  assert.equal(r.snapshotId, '2026-06-07T00-00-00Z');
  // Audit recorded exactly once with command 'update'.
  assert.equal(s._lastAudit.entry.command, 'update');
});

// ── --apply refusals / failures ──────────────────────────────────────────────────

test('--apply with no assertWritable gate → update-bad-args, no snapshot/spawn', async () => {
  let snapCalled = false;
  let spawnCalled = false;
  const r = await updatePlugin({
    spec: 'foo', targetClaudeDir: TARGET, mgrStateDir: STATE, enableWrites: true,
    seams: {
      discoverPluginsFn: fakeDiscover([rec()]),
      resolveClaudeFn: nativeClaude(),
      createSnapshotFn: async () => { snapCalled = true; return { ok: true, diagnostics: [] }; },
      spawnFn: async () => { spawnCalled = true; },
    },
  });
  assert.equal(r.refused, true);
  assert.ok(diag(r, 'update-bad-args'));
  assert.equal(snapCalled, false);
  assert.equal(spawnCalled, false);
});

test('--apply not-spawnable → update-claude-not-spawnable; snapshot+spawn NEVER called; message has the command', async () => {
  let snapCalled = false;
  let spawnCalled = false;
  const r = await updatePlugin({
    spec: 'foo', targetClaudeDir: TARGET, mgrStateDir: STATE,
    assertWritable: gate, enableWrites: true,
    seams: {
      discoverPluginsFn: fakeDiscover([rec()]),
      resolveClaudeFn: () => ({ exe: null, kind: null, diagnostics: [] }),
      createSnapshotFn: async () => { snapCalled = true; return { ok: true, diagnostics: [] }; },
      spawnFn: async () => { spawnCalled = true; },
    },
  });
  assert.equal(r.refused, true);
  const d = diag(r, 'update-claude-not-spawnable');
  assert.ok(d, 'expected update-claude-not-spawnable');
  assert.match(d.message, /claude plugin update/);
  assert.equal(snapCalled, false, 'must NOT snapshot when no exe');
  assert.equal(spawnCalled, false, 'must NOT spawn when no exe');
});

test('--apply snapshot-fail → ok:false, update-snapshot-failed, spawn NEVER called', async () => {
  let spawnCalled = false;
  const r = await updatePlugin({
    spec: 'foo', targetClaudeDir: TARGET, mgrStateDir: STATE,
    assertWritable: gate, enableWrites: true,
    seams: {
      discoverPluginsFn: fakeDiscover([rec()]),
      resolveClaudeFn: nativeClaude(),
      createSnapshotFn: async () => ({ ok: false, diagnostics: [{ severity: 'error', code: 'snapshot-x', message: 'x' }] }),
      spawnFn: async () => { spawnCalled = true; },
    },
  });
  assert.equal(r.ok, false);
  assert.ok(diag(r, 'update-snapshot-failed'));
  assert.ok(diag(r, 'snapshot-x'), 'snapshot diagnostics are aggregated');
  assert.equal(spawnCalled, false, 'must NOT spawn after a failed snapshot');
});

test('--apply spawn-fail → ok:false, update-spawn-failed, BUT createSnapshot WAS called (kept as undo)', async () => {
  let snapCalled = false;
  const r = await updatePlugin({
    spec: 'foo', targetClaudeDir: TARGET, mgrStateDir: STATE,
    assertWritable: gate, enableWrites: true,
    seams: {
      discoverPluginsFn: fakeDiscover([rec()]),
      resolveClaudeFn: nativeClaude(),
      createSnapshotFn: async () => { snapCalled = true; return { ok: true, snapshotId: 'snap-1', diagnostics: [] }; },
      spawnFn: async () => { throw new Error('boom'); },
      auditFn: () => ({ written: true }),
    },
  });
  assert.equal(snapCalled, true, 'snapshot WAS taken (it stays as the undo point)');
  assert.equal(r.ok, false);
  assert.equal(r.spawned, true);
  const d = diag(r, 'update-spawn-failed');
  assert.ok(d, 'expected update-spawn-failed');
  assert.match(d.message, /boom/);
  assert.equal(r.snapshotId, 'snap-1');
});

// ── injection defense-in-depth (the REAL safeSpawn validator) ─────────────────────

test('CLAUDE_PLUGIN_UPDATE_SCHEMA rejects an injection token at the safeSpawn gate, accepts a valid key', () => {
  // A malicious positional with `;` is rejected by the positionalPattern.
  assert.throws(() => validateSpawnSpec({
    exe: '/abs/claude', args: ['plugin', 'update', 'foo;bar'],
    cwd: '/tmp', allowedCwds: ['/tmp'], schema: CLAUDE_PLUGIN_UPDATE_SCHEMA,
  }), /positional rejected by pattern/, 'foo;bar must be rejected');
  // A valid name@marketplace key passes the gate.
  assert.doesNotThrow(() => validateSpawnSpec({
    exe: '/abs/claude', args: ['plugin', 'update', 'ok-name@mkt'],
    cwd: '/tmp', allowedCwds: ['/tmp'], schema: CLAUDE_PLUGIN_UPDATE_SCHEMA,
  }), 'ok-name@mkt must be accepted');
  // The schema accepts NO flags (so --lock-version can never reach the CLI).
  assert.throws(() => validateSpawnSpec({
    exe: '/abs/claude', args: ['plugin', 'update', '--lock-version'],
    cwd: '/tmp', allowedCwds: ['/tmp'], schema: CLAUDE_PLUGIN_UPDATE_SCHEMA,
  }), /flag not allowed/, 'a flag must be rejected');
  // Frozen schema invariant.
  assert.equal(Object.isFrozen(CLAUDE_PLUGIN_UPDATE_SCHEMA), true);
  assert.deepEqual(CLAUDE_PLUGIN_UPDATE_SCHEMA.allowedFlags, []);
  assert.equal(CLAUDE_PLUGIN_UPDATE_SCHEMA.maxArgs, 3);
});

// ── never-throws ─────────────────────────────────────────────────────────────────

test('never throws: updatePlugin(null) → full-shape {ok:false}', async () => {
  const r = await updatePlugin(null);
  assert.equal(r.ok, false);
  assert.equal(r.refused, true);
  assert.equal(r.spawned, false);
  assert.ok(Array.isArray(r.diagnostics));
  // Full default shape present.
  for (const k of ['ok', 'refused', 'dryRun', 'plugin', 'claudeExe', 'command', 'snapshotId', 'spawned', 'apply', 'diagnostics']) {
    assert.ok(k in r, `result missing key ${k}`);
  }
});

test('never throws: updatePlugin({spec:42}) → bad-spec refusal, no throw', async () => {
  const r = await updatePlugin({ spec: 42, targetClaudeDir: TARGET, mgrStateDir: STATE });
  assert.equal(r.ok, false);
  assert.ok(diag(r, 'update-bad-spec'));
});

test('never throws: a seam that throws degrades to update-unexpected-error', async () => {
  const r = await updatePlugin({
    spec: 'foo', targetClaudeDir: TARGET, mgrStateDir: STATE,
    seams: { discoverPluginsFn: () => { throw new Error('discover blew up'); } },
  });
  assert.equal(r.ok, false);
  const d = diag(r, 'update-unexpected-error');
  assert.ok(d, 'expected update-unexpected-error');
  assert.match(d.message, /discover blew up/);
});

// ── manifest cross-check tests ────────────────────────────────────────────────

/**
 * Build a fake manifest JSON string whose files[] contains or omits the given
 * relative path.
 */
function fakeManifest(paths) {
  return JSON.stringify({ files: paths.map((p) => ({ path: p, preSha256: 'aaa', currentSha256: 'aaa' })) });
}

test('manifest cross-check: target absent from manifest → update-target-not-snapshotted, spawn NEVER called', async () => {
  const spawnCalls = [];
  const snapId = '2026-06-07T00-00-00Z';
  const manifestPath = '/fake/snapshots/' + snapId + '/manifest.json';

  const r = await updatePlugin({
    spec: 'foo@market', targetClaudeDir: TARGET, mgrStateDir: STATE,
    assertWritable: gate, enableWrites: true,
    seams: {
      discoverPluginsFn: fakeDiscover([rec()]),
      resolveClaudeFn: nativeClaude(),
      // Fake snapshot returns ok:true with a manifestPath
      createSnapshotFn: async () => ({
        ok: true, snapshotId: snapId, manifestPath, diagnostics: [],
      }),
      // Manifest does NOT contain plugins/installed_plugins.json
      manifestReadFileFn: () => fakeManifest(['CLAUDE.md', 'settings.json']),
      // The target DOES exist on disk (so the check is not skipped)
      existsFn: () => true,
      spawnFn: async (spec) => { spawnCalls.push(spec); return { stdout: '', stderr: '' }; },
      auditFn: () => ({ written: true, diagnostics: [] }),
    },
  });

  assert.equal(r.ok, false, 'should be refused');
  assert.equal(r.spawned, false, 'spawn must NOT have been called');
  assert.equal(spawnCalls.length, 0, 'spawnFn must not be called');
  const d = diag(r, 'update-target-not-snapshotted');
  assert.ok(d, 'update-target-not-snapshotted diagnostic must be present');
  assert.equal(d.severity, 'error');
});

test('manifest cross-check: target present in manifest → spawn proceeds normally', async () => {
  const spawnCalls = [];
  const snapId = '2026-06-07T00-00-00Z';
  const manifestPath = '/fake/snapshots/' + snapId + '/manifest.json';

  const r = await updatePlugin({
    spec: 'foo@market', targetClaudeDir: TARGET, mgrStateDir: STATE,
    assertWritable: gate, enableWrites: true,
    seams: {
      discoverPluginsFn: fakeDiscover([rec()]),
      resolveClaudeFn: nativeClaude(),
      createSnapshotFn: async () => ({
        ok: true, snapshotId: snapId, manifestPath, diagnostics: [],
      }),
      // Manifest CONTAINS plugins/installed_plugins.json
      manifestReadFileFn: () => fakeManifest(['plugins/installed_plugins.json', 'CLAUDE.md']),
      existsFn: () => true,
      spawnFn: async (spec) => { spawnCalls.push(spec); return { stdout: '', stderr: '' }; },
      auditFn: () => ({ written: true, diagnostics: [] }),
    },
  });

  assert.equal(r.ok, true);
  assert.equal(r.spawned, true, 'spawn must have been called');
  assert.equal(spawnCalls.length, 1);
  assert.ok(!diag(r, 'update-target-not-snapshotted'), 'no cross-check error expected');
});

test('manifest cross-check: target does not exist on disk → no refusal (existsFn false)', async () => {
  const spawnCalls = [];
  const snapId = '2026-06-07T00-00-00Z';
  const manifestPath = '/fake/snapshots/' + snapId + '/manifest.json';

  const r = await updatePlugin({
    spec: 'foo@market', targetClaudeDir: TARGET, mgrStateDir: STATE,
    assertWritable: gate, enableWrites: true,
    seams: {
      discoverPluginsFn: fakeDiscover([rec()]),
      resolveClaudeFn: nativeClaude(),
      createSnapshotFn: async () => ({
        ok: true, snapshotId: snapId, manifestPath, diagnostics: [],
      }),
      // Manifest is empty — but existsFn returns false so check is skipped
      manifestReadFileFn: () => fakeManifest([]),
      existsFn: () => false,
      spawnFn: async (spec) => { spawnCalls.push(spec); return { stdout: '', stderr: '' }; },
      auditFn: () => ({ written: true, diagnostics: [] }),
    },
  });

  assert.equal(r.ok, true, 'non-existent target must not cause a refusal');
  assert.equal(r.spawned, true);
  assert.ok(!diag(r, 'update-target-not-snapshotted'));
});
