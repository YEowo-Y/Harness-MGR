/**
 * P4b.U10 — test/integration/post-apply-doctor-invariant.test.mjs
 *
 * Cross-phase INVARIANT #44 — "post-apply doctor exit <= 1".
 *
 * After ANY governed-config write/apply path runs, `doctor` must run to
 * completion and return exit <= 1 (0 = no error-severity diagnostics, 1 = at
 * least one error-severity diagnostic). It must NEVER crash to exit 2. This is a
 * REGRESSION GUARD: a write operation must not leave the config (or .mgr-state)
 * in a shape that makes doctor itself throw. doctor is already never-throws, so
 * this should pass today — its value is LOCKING the property in across all four
 * write paths so a future change to remove/cascade/update/mcp-write that left a
 * doctor-tripping artifact would go red here.
 *
 * Two harnesses, because the four write paths differ in how they reach an apply:
 *
 *   (A) remove + cascade — driven END-TO-END via run(argv) from src/cli.mjs with
 *       CLAUDE_CONFIG_DIR + HARNESS_MGR_ENABLE_WRITES + --config-dir all pointing at
 *       the temp tree. These ACTUALLY delete governed files (mirrors
 *       remove-cli-roundtrip.test.mjs / cascade-roundtrip.test.mjs).
 *
 *   (B) update + mcp-write — delegate the mutation to the EXTERNAL `claude` CLI
 *       via spawn, so they CANNOT be driven hermetically through run() (run() has
 *       no seam to inject a fake spawn). They are driven through the OPS layer
 *       directly (updatePlugin / mcpRemove) with a FAKE spawn + FAKE
 *       resolveClaude seam, exactly like update-roundtrip.test.mjs /
 *       mcp-remove-roundtrip.test.mjs. The fake spawn means the governed config is
 *       NOT mutated by the delegation itself, but the auto-snapshot DID run; the
 *       invariant we assert is that doctor over that post-apply config + .mgr-state
 *       is still <= 1 (guards a future regression where update/mcp begin touching
 *       governed config directly).
 *
 * Every apply path takes an auto-snapshot via the system `tar`, so each test
 * GRACEFUL-SKIPs when tar is unavailable. Each test uses a fresh temp dir and
 * saves + restores process.env.CLAUDE_CONFIG_DIR / HARNESS_MGR_ENABLE_WRITES in a
 * finally, then best-effort rmSync's the temp tree.
 *
 * NON-VACUOUS doctor assertion (assertDoctorHealthy): code <= 1 AND
 * result.checks is a non-empty array (doctor genuinely evaluated the post-apply
 * tree, not an early return) AND result.probeLevel === 'passive'. We assert
 * checks.length > 0 (NOT === 25) so this does not duplicate the doctor-fixture
 * golden's job or couple to the check count.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../../src/cli.mjs';
import { resolveTar } from '../../src/ops/snapshot-tar.mjs';
import { updatePlugin } from '../../src/ops/update.mjs';
import { mcpRemove } from '../../src/ops/mcp-write.mjs';
import { assertWritable } from '../../src/paths.mjs';

/** Write bytes at a POSIX-relative path under base, creating parent dirs. */
function put(base, rel, bytes) {
  const abs = join(base, ...rel.split('/'));
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, bytes);
}

/** A FAKE resolveClaudeExe seam: returns process.execPath (absolute + exists) as
 *  the spawnable exe, so even a real spawnability check would pass. */
function fakeResolveClaude() {
  return () => ({ exe: process.execPath, kind: 'native', diagnostics: [] });
}

/** A FAKE spawnFn that RECORDS the spec and resolves cleanly — real `claude` never runs. */
function makeFakeSpawn() {
  /** @type {{calls: any[]}} */
  const rec = { calls: [] };
  const spawnFn = async (spec) => { rec.calls.push(spec); return { stdout: '', stderr: '' }; };
  return { spawnFn, rec };
}

/**
 * The invariant assertion: run doctor over the post-apply temp tree and require
 * exit <= 1 (never the crash-to-2), with a NON-VACUOUS check that doctor actually
 * evaluated its checks passively over the tree.
 */
async function assertDoctorHealthy(tmp, label) {
  const { code, stdout } = await run(['doctor', '--format', 'json', '--config-dir', tmp]);
  assert.ok(code <= 1,
    `${label}: doctor must exit <=1 after apply, got ${code}; stdout head: ${stdout.slice(0, 300)}`);
  const j = JSON.parse(stdout);
  assert.ok(j.result && Array.isArray(j.result.checks) && j.result.checks.length > 0,
    `${label}: doctor must actually run its checks over the post-apply tree`);
  assert.equal(j.result.probeLevel, 'passive', `${label}: doctor ran passively`);
}

// ── Test 1 — remove path (real delete via run()) ──────────────────────────────
test('post-apply doctor invariant #44: remove path leaves doctor exit <=1', async (t) => {
  const { tarPath, diagnostics } = resolveTar();
  if (!tarPath) {
    t.skip(`system tar not found (${diagnostics.map((d) => d.code).join(',')}) — skipping remove invariant`);
    return;
  }

  const savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
  const savedEnableWrites = process.env.HARNESS_MGR_ENABLE_WRITES;
  const tmp = mkdtempSync(join(tmpdir(), 'cmgr-inv44-rm-'));

  try {
    put(tmp, 'agents/foo.md', Buffer.from('---\nname: foo\n---\n# agent foo\n', 'utf8'));
    put(tmp, 'commands/bar.md', Buffer.from('---\nname: bar\n---\n# command bar\n', 'utf8'));
    put(tmp, 'settings.json', Buffer.from('{}\n', 'utf8'));
    put(tmp, 'CLAUDE.md', Buffer.from('# project CLAUDE.md\n', 'utf8'));
    mkdirSync(join(tmp, '.mgr-state'), { recursive: true });

    process.env.CLAUDE_CONFIG_DIR = tmp;
    process.env.HARNESS_MGR_ENABLE_WRITES = '1';

    const r = await run(['remove', 'agent:foo', '--apply', '--config-dir', tmp]);
    assert.equal(r.code, 0,
      `remove --apply expected code 0, got ${r.code}; stdout: ${r.stdout.slice(0, 400)}`);
    // Sanity: the apply really happened.
    assert.ok(!existsSync(join(tmp, 'agents', 'foo.md')),
      'remove --apply must actually delete agents/foo.md');

    await assertDoctorHealthy(tmp, 'remove');
  } finally {
    if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
    if (savedEnableWrites === undefined) delete process.env.HARNESS_MGR_ENABLE_WRITES;
    else process.env.HARNESS_MGR_ENABLE_WRITES = savedEnableWrites;
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

// ── Test 2 — cascade path (real multi-delete via run()) ───────────────────────
test('post-apply doctor invariant #44: cascade path leaves doctor exit <=1', async (t) => {
  const { tarPath, diagnostics } = resolveTar();
  if (!tarPath) {
    t.skip(`system tar not found (${diagnostics.map((d) => d.code).join(',')}) — skipping cascade invariant`);
    return;
  }

  const savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
  const savedEnableWrites = process.env.HARNESS_MGR_ENABLE_WRITES;
  const tmp = mkdtempSync(join(tmpdir(), 'cmgr-inv44-cascade-'));

  try {
    // skills/trace/SKILL.md references agent:tracer via frontmatter `agent: tracer`,
    // so the cascade preview finds skill:trace as a dependent → --force is required.
    put(tmp, 'agents/tracer.md', Buffer.from('---\nname: tracer\n---\n# agent tracer\n', 'utf8'));
    put(tmp, 'skills/trace/SKILL.md', Buffer.from('---\nname: trace\nagent: tracer\n---\n# skill trace\n', 'utf8'));
    put(tmp, 'settings.json', Buffer.from('{}\n', 'utf8'));
    put(tmp, 'CLAUDE.md', Buffer.from('# project CLAUDE.md\n', 'utf8'));
    mkdirSync(join(tmp, '.mgr-state'), { recursive: true });

    process.env.CLAUDE_CONFIG_DIR = tmp;
    process.env.HARNESS_MGR_ENABLE_WRITES = '1';

    const r = await run(['remove', 'agent:tracer', '--cascade', '--force', '--apply', '--config-dir', tmp]);
    assert.equal(r.code, 0,
      `cascade --force --apply expected code 0, got ${r.code}; stdout: ${r.stdout.slice(0, 600)}`);
    // Sanity: BOTH the target and the dependent were deleted.
    assert.ok(!existsSync(join(tmp, 'agents', 'tracer.md')),
      'cascade must delete agents/tracer.md');
    assert.ok(!existsSync(join(tmp, 'skills', 'trace')),
      'cascade must delete skills/trace/');

    await assertDoctorHealthy(tmp, 'cascade');
  } finally {
    if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
    if (savedEnableWrites === undefined) delete process.env.HARNESS_MGR_ENABLE_WRITES;
    else process.env.HARNESS_MGR_ENABLE_WRITES = savedEnableWrites;
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

// ── Test 3 — update path (ops layer + fake spawn) ─────────────────────────────
test('post-apply doctor invariant #44: update path leaves doctor exit <=1', async (t) => {
  const { tarPath, diagnostics } = resolveTar();
  if (!tarPath) {
    t.skip(`system tar not found (${diagnostics.map((d) => d.code).join(',')}) — skipping update invariant`);
    return;
  }

  const saved = process.env.CLAUDE_CONFIG_DIR;
  const tmp = mkdtempSync(join(tmpdir(), 'cmgr-inv44-update-'));
  const stateDir = join(tmp, '.mgr-state');

  try {
    const installed = {
      version: 2,
      plugins: {
        'demo-plugin@demo-mkt': [
          { name: 'demo-plugin', marketplace: 'demo-mkt', version: '1.0.0', scope: 'user' },
        ],
      },
    };
    put(tmp, 'plugins/installed_plugins.json',
      Buffer.from(JSON.stringify(installed, null, 2) + '\n', 'utf8'));
    put(tmp, 'agents/keep.md', Buffer.from('---\nname: keep\n---\n# agent keep\n', 'utf8'));
    put(tmp, 'settings.json', Buffer.from('{}\n', 'utf8'));
    mkdirSync(stateDir, { recursive: true });

    // The REAL gate resolves the governed dir from CLAUDE_CONFIG_DIR (read at call time).
    process.env.CLAUDE_CONFIG_DIR = tmp;
    const { spawnFn, rec } = makeFakeSpawn();

    const r = await updatePlugin({
      spec: 'demo-plugin@demo-mkt', targetClaudeDir: tmp, mgrStateDir: stateDir,
      assertWritable, enableWrites: true,
      seams: { spawnFn, resolveClaudeFn: fakeResolveClaude() },
    });
    assert.equal(r.ok, true, `update --apply failed: ${JSON.stringify(r.diagnostics)}`);
    assert.equal(r.spawned, true, 'the apply path must have run the snapshot + (fake) delegation');
    assert.equal(rec.calls.length, 1, 'the (fake) delegation must have been invoked once');

    await assertDoctorHealthy(tmp, 'update');
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

// ── Test 4 — mcp-write path (ops layer + fake spawn) ──────────────────────────
test('post-apply doctor invariant #44: mcp-write path leaves doctor exit <=1', async (t) => {
  const { tarPath, diagnostics } = resolveTar();
  if (!tarPath) {
    t.skip(`system tar not found (${diagnostics.map((d) => d.code).join(',')}) — skipping mcp-write invariant`);
    return;
  }

  const saved = process.env.CLAUDE_CONFIG_DIR;
  const tmp = mkdtempSync(join(tmpdir(), 'cmgr-inv44-mcp-'));
  const stateDir = join(tmp, '.mgr-state');

  try {
    const mcp = { mcpServers: { foo: { command: 'node', args: ['x'] } } };
    put(tmp, '.mcp.json', Buffer.from(JSON.stringify(mcp, null, 2) + '\n', 'utf8'));
    put(tmp, 'agents/keep.md', Buffer.from('---\nname: keep\n---\n# agent keep\n', 'utf8'));
    put(tmp, 'settings.json', Buffer.from('{}\n', 'utf8'));
    mkdirSync(stateDir, { recursive: true });

    process.env.CLAUDE_CONFIG_DIR = tmp;
    const { spawnFn, rec } = makeFakeSpawn();

    const r = await mcpRemove({
      name: 'foo', scope: 'project', targetClaudeDir: tmp, mgrStateDir: stateDir,
      assertWritable, enableWrites: true,
      seams: { spawnFn, resolveClaudeFn: fakeResolveClaude() },
    });
    assert.equal(r.ok, true, `mcp remove --apply failed: ${JSON.stringify(r.diagnostics)}`);
    assert.equal(r.spawned, true, 'the apply path must have run the snapshot + (fake) delegation');
    assert.equal(rec.calls.length, 1, 'the (fake) delegation must have been invoked once');

    await assertDoctorHealthy(tmp, 'mcp-write');
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});
