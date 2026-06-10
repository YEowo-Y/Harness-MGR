/**
 * Reversibility fix integration tests — test/integration/reversibility-secret-name-fix.test.mjs
 *
 * Reproduces and verifies the fix for the SECURITY BUG where a governed component
 * whose basename matches a secret name-glob (e.g. `*-secret*`, `*-token*`) OR whose
 * content triggers the content-sniff (e.g. contains a `ghp_` token) would be DROPPED
 * by the pre-apply snapshot's secrets filter, making `remove --apply` silently
 * irreversible (the deleted file absent from the manifest, rollback unable to restore).
 *
 * THE FIX:
 *   Part 1 — applyPlan passes `skipSecretFilter:true` to createSnapshot, which passes
 *             `keepAll:true` to filterSnapshotSecrets, bypassing name-glob + content-sniff
 *             for reversibility snapshots. The walker is allowlist-driven and only returns
 *             governed surface files, so no stray id_rsa/.env/etc. is walked.
 *   Part 2 — After the snapshot, applyPlan cross-checks that every op target appears in
 *             the snapshot manifest. If ANY is absent the whole apply is REFUSED (exit
 *             code apply-target-not-snapshotted) before a single mutation. Belt-and-
 *             suspenders: catches any future secret-filter gap at apply time.
 *
 * TEST SUITE:
 *   1. HEADLINE — `remove command:rotate-secret --apply` with a PEM-named component:
 *      the component's `rotate-secret.md` name would previously be dropped by the
 *      `*-secret*` glob; with the fix it is CAPTURED in the manifest AND rollback
 *      restores it byte-identical.
 *   2. Content-sniff case — a command `.md` whose body contains a `ghp_`-shaped token
 *      would previously be dropped by the content sniffer; with the fix it is KEPT +
 *      restorable.
 *   3. Part 2 backstop — inject a `createSnapshotFn` that returns a manifest omitting
 *      the op target; `applyPlan` must return `ok:false` with code
 *      `apply-target-not-snapshotted` and perform NO mutations.
 *
 * All real-fs tests use a TEMP dir + the REAL write gate (via CLAUDE_CONFIG_DIR env) and
 * the REAL system tar. GRACEFUL-SKIP when tar is unavailable.
 *
 * CRITICAL security constraint: this test covers ONLY the local snapshot archive
 * (reversibility). It does NOT modify, weaken, or test the OUTPUT/sharing redaction
 * surfaces (redact-effective / redact-secrets-text / redact-mcp-args / redact-paths /
 * inventory / config diff). Those remain a SEPARATE, correct surface.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { resolveTar } from '../../src/ops/snapshot-tar.mjs';
import { run } from '../../src/cli.mjs';
import { applyPlan } from '../../src/ops/apply.mjs';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/** Write a file at a POSIX-relative path under base, creating parent dirs. */
function put(base, rel, bytes) {
  const abs = join(base, ...rel.split('/'));
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, bytes);
}

/**
 * Find the newest snapshot id directory under mgrStateDir/snapshots. Returns null
 * when none exist. Newest = last lexicographically (ids are ISO timestamps).
 */
function newestSnapshotId(mgrStateDir) {
  const snapshotsDir = join(mgrStateDir, 'snapshots');
  if (!existsSync(snapshotsDir)) return null;
  const ids = readdirSync(snapshotsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  return ids.length > 0 ? ids[ids.length - 1] : null;
}

const PASS_GATE = (p) => p; // passthrough write gate for ops-layer unit tests

// ---------------------------------------------------------------------------
// Test 1 — HEADLINE: secret-named component is captured + rollback restores it
// ---------------------------------------------------------------------------

test('reversibility fix: secret-named command component (rotate-secret.md) is captured in the pre-apply snapshot and rollback restores it byte-identical', async (t) => {
  const { tarPath, diagnostics } = resolveTar();
  if (!tarPath) {
    t.skip(`system tar not found (${diagnostics.map((d) => d.code).join(',')}) — skipping reversibility headline test`);
    return;
  }

  const savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
  const savedEnableWrites = process.env.CLAUDE_MGR_ENABLE_WRITES;
  const tmp = mkdtempSync(join(tmpdir(), 'cmgr-rev-fix-'));
  const stateDir = join(tmp, '.mgr-state');

  try {
    // ── BUILD the live tree ───────────────────────────────────────────────────
    // rotate-secret.md — a COMMAND whose basename matches `*-secret*` name glob.
    // Previously this would be DROPPED by filterSnapshotSecrets, making remove silently irreversible.
    const secretComponentBytes = Buffer.from('---\nname: rotate-secret\n---\n# rotate-secret command\nThis governs a rotation workflow.\n', 'utf8');
    // normal.md — an unrelated command that must be byte-identical after everything.
    const normalBytes = Buffer.from('---\nname: normal\n---\n# normal command\nNothing special here.\n', 'utf8');
    const claudeBytes = Buffer.from('# project CLAUDE.md\noriginal content\n', 'utf8');

    put(tmp, 'commands/rotate-secret.md', secretComponentBytes);
    put(tmp, 'commands/normal.md', normalBytes);
    put(tmp, 'CLAUDE.md', claudeBytes);
    mkdirSync(stateDir, { recursive: true });

    const normalShaOrig = sha256Hex(readFileSync(join(tmp, 'commands', 'normal.md')));
    const claudeShaOrig = sha256Hex(readFileSync(join(tmp, 'CLAUDE.md')));

    process.env.CLAUDE_CONFIG_DIR = tmp;
    delete process.env.CLAUDE_MGR_ENABLE_WRITES;

    // ── LEG 1: DRY-RUN — confirms no write ────────────────────────────────────
    const dryResult = await run(['remove', 'command:rotate-secret', '--config-dir', tmp]);
    assert.equal(dryResult.code, 0,
      `dry-run expected code 0, got ${dryResult.code}; stdout: ${dryResult.stdout.slice(0, 400)}`);
    assert.ok(existsSync(join(tmp, 'commands', 'rotate-secret.md')),
      'dry-run must NOT delete rotate-secret.md');
    assert.ok(!existsSync(join(stateDir, 'snapshots')),
      'dry-run must NOT create any snapshot');

    // ── LEG 2: APPLY — deletes the component ──────────────────────────────────
    process.env.CLAUDE_MGR_ENABLE_WRITES = '1';
    const applyResult = await run(['remove', 'command:rotate-secret', '--apply', '--config-dir', tmp]);
    assert.equal(applyResult.code, 0,
      `apply expected code 0, got ${applyResult.code}; stdout: ${applyResult.stdout.slice(0, 400)}`);
    assert.ok(!existsSync(join(tmp, 'commands', 'rotate-secret.md')),
      'rotate-secret.md must be deleted after --apply');

    // Unrelated governed files must be byte-identical.
    assert.equal(sha256Hex(readFileSync(join(tmp, 'commands', 'normal.md'))), normalShaOrig,
      'commands/normal.md must be unchanged after remove');
    assert.equal(sha256Hex(readFileSync(join(tmp, 'CLAUDE.md'))), claudeShaOrig,
      'CLAUDE.md must be unchanged after remove');

    // ── HEADLINE SECURITY CHECK: rotate-secret.md IS captured in the manifest ─
    const snapId = newestSnapshotId(stateDir);
    assert.ok(snapId, 'a snapshot must have been created by the apply leg');
    const manifestPath = join(stateDir, 'snapshots', snapId, 'manifest.json');
    assert.ok(existsSync(manifestPath), 'manifest.json must exist in the snapshot dir');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    assert.ok(
      manifest.files.some((f) => f.path === 'commands/rotate-secret.md'),
      'HEADLINE: commands/rotate-secret.md MUST be captured in the pre-apply snapshot manifest ' +
      '(the reversibility fix ensures secret-named governed files are kept in the undo-point)',
    );

    // ── LEG 3: ROLLBACK — restores rotate-secret.md byte-identical ────────────
    const rollbackResult = await run(['rollback', snapId, '--apply', '--force', '--config-dir', tmp]);
    assert.equal(rollbackResult.code, 0,
      `rollback expected code 0, got ${rollbackResult.code}; stdout: ${rollbackResult.stdout.slice(0, 400)}`);
    assert.ok(existsSync(join(tmp, 'commands', 'rotate-secret.md')),
      'rotate-secret.md must be restored by rollback');
    assert.ok(
      Buffer.compare(readFileSync(join(tmp, 'commands', 'rotate-secret.md')), secretComponentBytes) === 0,
      'rollback must restore rotate-secret.md byte-identical to the original',
    );

    // No sidecar residue after rollback.
    const allFiles = (dir) => {
      const out = [];
      const walk = (d) => {
        for (const ent of readdirSync(d, { withFileTypes: true })) {
          const abs = join(d, ent.name);
          if (ent.isDirectory()) walk(abs);
          else out.push(abs);
        }
      };
      walk(dir);
      return out;
    };
    const residue = allFiles(tmp).filter((p) => /\.mgr-(new|old)$/.test(p));
    assert.deepEqual(residue, [], `no .mgr-new/.mgr-old residue expected, found: ${residue.join(', ')}`);

  } finally {
    if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
    if (savedEnableWrites === undefined) delete process.env.CLAUDE_MGR_ENABLE_WRITES;
    else process.env.CLAUDE_MGR_ENABLE_WRITES = savedEnableWrites;
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

// ---------------------------------------------------------------------------
// Test 2 — Content-sniff case: component whose .md body contains a ghp_ token
// ---------------------------------------------------------------------------

test('reversibility fix: command whose .md content contains a ghp_ token is captured in the snapshot and restorable', async (t) => {
  const { tarPath, diagnostics } = resolveTar();
  if (!tarPath) {
    t.skip(`system tar not found (${diagnostics.map((d) => d.code).join(',')}) — skipping content-sniff reversibility test`);
    return;
  }

  const savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
  const savedEnableWrites = process.env.CLAUDE_MGR_ENABLE_WRITES;
  const tmp = mkdtempSync(join(tmpdir(), 'cmgr-rev-sniff-'));
  const stateDir = join(tmp, '.mgr-state');

  try {
    // A command whose CONTENT triggers the content sniffer (ghp_-shaped token in .md body).
    // Previously the content-sniff leg would DROP this from the snapshot, making remove
    // irreversible. With skipSecretFilter:true the file is always kept.
    const tokenInBodyBytes = Buffer.from(
      '---\nname: deploy-helper\n---\n# deploy-helper\n' +
      'Uses token ghp_ABCDEFabcdef1234567890abcdef123456 to push releases.\n',
      'utf8',
    );
    const normalBytes = Buffer.from('---\nname: other\n---\n# other\ncontent\n', 'utf8');

    put(tmp, 'commands/deploy-helper.md', tokenInBodyBytes);
    put(tmp, 'commands/other.md', normalBytes);
    put(tmp, 'CLAUDE.md', Buffer.from('# test\n', 'utf8'));
    mkdirSync(stateDir, { recursive: true });

    process.env.CLAUDE_CONFIG_DIR = tmp;
    process.env.CLAUDE_MGR_ENABLE_WRITES = '1';

    const applyResult = await run(['remove', 'command:deploy-helper', '--apply', '--config-dir', tmp]);
    assert.equal(applyResult.code, 0,
      `apply expected code 0, got ${applyResult.code}; stdout: ${applyResult.stdout.slice(0, 400)}`);
    assert.ok(!existsSync(join(tmp, 'commands', 'deploy-helper.md')),
      'deploy-helper.md must be deleted after --apply');

    // The component MUST be in the manifest.
    const snapId = newestSnapshotId(stateDir);
    assert.ok(snapId, 'a snapshot must have been created');
    const manifestPath = join(stateDir, 'snapshots', snapId, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    assert.ok(
      manifest.files.some((f) => f.path === 'commands/deploy-helper.md'),
      'commands/deploy-helper.md (content-sniff match) MUST be in the manifest (reversibility fix)',
    );

    // Rollback restores it byte-identical.
    const rollbackResult = await run(['rollback', snapId, '--apply', '--force', '--config-dir', tmp]);
    assert.equal(rollbackResult.code, 0,
      `rollback expected code 0, got ${rollbackResult.code}; stdout: ${rollbackResult.stdout.slice(0, 400)}`);
    assert.ok(existsSync(join(tmp, 'commands', 'deploy-helper.md')),
      'deploy-helper.md must be restored by rollback');
    assert.ok(
      Buffer.compare(readFileSync(join(tmp, 'commands', 'deploy-helper.md')), tokenInBodyBytes) === 0,
      'rollback must restore deploy-helper.md byte-identical',
    );

  } finally {
    if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
    if (savedEnableWrites === undefined) delete process.env.CLAUDE_MGR_ENABLE_WRITES;
    else process.env.CLAUDE_MGR_ENABLE_WRITES = savedEnableWrites;
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

// ---------------------------------------------------------------------------
// Test 3 — Part 2 backstop: injected snapshot that omits op target → apply refused
// ---------------------------------------------------------------------------

test('Part 2 backstop: applyPlan refuses with apply-target-not-snapshotted when the snapshot manifest omits an op target', async (t) => {
  // This test is hermetic (no real tar / no real CLI run). It uses the ops-layer
  // applyPlan directly with injected seams so it can control the snapshot result.

  const root = mkdtempSync(join(tmpdir(), 'cmgr-backstop-'));
  const claudeDir = join(root, '.claude');
  const stateDir = join(claudeDir, '.mgr-state');
  mkdirSync(claudeDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });

  try {
    // Lay down a file that the plan will try to delete.
    const targetBytes = Buffer.from('# my-component\ncontent\n', 'utf8');
    put(claudeDir, 'agents/my-component.md', targetBytes);

    const targetPath = join(claudeDir, 'agents', 'my-component.md');

    // A plan with a 'delete' op targeting agents/my-component.md.
    const plan = {
      planVersion: 1,
      command: 'remove agent:my-component',
      ops: [{ kind: 'delete', target: targetPath }],
      apply: true,
    };

    // Spy to detect if atomicDeleteFn was ever called (it must NOT be).
    let deleteCallCount = 0;

    // Inject a createSnapshotFn that returns a manifest that OMITS the op target.
    // This simulates a future secret-filter gap (or any other gap in coverage).
    const fakeSnapId = '2026-01-01T00-00-00Z';
    const fakeManifestPath = join(stateDir, 'snapshots', fakeSnapId, 'manifest.json');
    mkdirSync(join(stateDir, 'snapshots', fakeSnapId), { recursive: true });
    // Write a manifest that captures CLAUDE.md but NOT agents/my-component.md.
    const fakeManifest = {
      manifestVersion: 1, planVersion: 1, snapshotId: fakeSnapId,
      targetClaudeDir: claudeDir, createdAt: new Date().toISOString(), reason: 'test',
      files: [{ path: 'CLAUDE.md', preSha256: 'abc123', currentSha256: 'abc123' }],
    };
    writeFileSync(fakeManifestPath, JSON.stringify(fakeManifest, null, 2));

    const fakeCreateSnapshot = async () => ({
      ok: true,
      snapshotId: fakeSnapId,
      manifestPath: fakeManifestPath,
      archivePath: join(stateDir, 'snapshots', fakeSnapId, 'files.tar'),
      kept: ['CLAUDE.md'],
      dropped: [],
      fileCount: 1,
      diagnostics: [],
    });

    const res = await applyPlan({
      plan,
      targetClaudeDir: claudeDir,
      mgrStateDir: stateDir,
      assertWritable: PASS_GATE,
      enableWrites: true,
      reason: 'backstop-test',
      pid: process.pid,
      seams: {
        createSnapshotFn: fakeCreateSnapshot,
        atomicDeleteFn: async () => {
          deleteCallCount += 1;
          return { ok: true, diagnostics: [] };
        },
      },
    });

    // The apply must be REFUSED with apply-target-not-snapshotted.
    assert.equal(res.ok, false,
      `apply must be refused when op target is missing from the manifest; got ok:${res.ok}`);
    assert.ok(
      res.diagnostics.some((d) => d.code === 'apply-target-not-snapshotted'),
      `expected diagnostic code 'apply-target-not-snapshotted', got: ${res.diagnostics.map((d) => d.code).join(', ')}`,
    );

    // NO mutations: the target file must still exist.
    assert.ok(existsSync(targetPath),
      'agents/my-component.md must NOT be deleted when apply is refused by the backstop');
    assert.equal(deleteCallCount, 0,
      'atomicDeleteFn must never be called when the backstop refuses the apply');
    assert.equal(res.applied, false,
      'applied must be false when the backstop refuses before any mutation');

  } finally {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});
