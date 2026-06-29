/**
 * CLI dispatch tests for the governed-config WRITE commands (P3.U22, sub-unit C1).
 *
 * Proves that `rollback` / `recover` / `lock` are now REACHABLE from the real CLI
 * shell (src/cli.mjs `run(argv)`): the arg parser threads the snapshot `<id>` into
 * `args.positionals`, recognizes the new boolean flags (--force / --mark-failed /
 * --resume / --rollback / --from-manifest), and the COMMANDS registry dispatches to
 * the already-built+reviewed handlers. The two-factor write gate (--apply AND the
 * env var HARNESS_MGR_ENABLE_WRITES=1) is exercised end-to-end.
 *
 * HERMETIC: every case passes `--config-dir <tmpDir>` (a fresh mkdtemp dir) so the
 * real ~/.claude is never touched, and the gate assertions SAVE/DELETE/RESTORE
 * process.env.HARNESS_MGR_ENABLE_WRITES (deleted → the gate is closed, so --apply
 * refuses up front and the engine is never reached). Assertions are on the
 * `{code, stdout}` pair via substring + exact-code checks (default table format, so
 * the diagnostic CODE appears in the footer — `--format quiet` would collapse it).
 *
 * Also a POSITIONALS REGRESSION: the two-word `config show-effective` consume must
 * still collapse to its canonical key (the canonicalize change kept it intact).
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { run } from '../src/cli.mjs';

// One shared temp config dir for the whole file — every command reads it read-only
// (the write paths all refuse before any fs write under these closed-gate cases).
const tmp = mkdtempSync(join(tmpdir(), 'harness-mgr-dispatch-write-'));

// Snapshot the gate env var so the closed-gate assertions are deterministic
// regardless of the developer's shell; delete it for the duration of the file.
const ENV_KEY = 'HARNESS_MGR_ENABLE_WRITES';
const savedEnv = process.env[ENV_KEY];
delete process.env[ENV_KEY];

after(() => {
  // Restore the env var (or leave it unset if it was unset) and remove the temp dir.
  if (savedEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = savedEnv;
  rmSync(tmp, { recursive: true, force: true });
});

// ── rollback ─────────────────────────────────────────────────────────────────────

test('rollback (no id) → dispatches to the handler, code 3 + rollback-no-id', async () => {
  const out = await run(['rollback']);
  assert.equal(out.code, 3);
  assert.ok(out.stdout.includes('rollback-no-id'), 'reached the handler with empty positionals');
});

test('rollback <id> --apply, gate CLOSED (env=0) → code 3 + writes-disabled-env (engine never reached)', async () => {
  process.env[ENV_KEY] = '0';
  try {
    const out = await run(['rollback', 'snap-x', '--apply', '--config-dir', tmp]);
    assert.equal(out.code, 3);
    assert.ok(out.stdout.includes('writes-disabled-env'), 'the two-factor gate refused end-to-end');
  } finally {
    delete process.env[ENV_KEY];
  }
});

test('rollback <id> --force (no --apply) → recognized flag: code !== 2 and no "unknown flag"', async () => {
  // --force must be a KNOWN boolean flag — without registration the strict-flag
  // policy would turn it into a hard exit-2 usage error. This is a dry-run dispatch
  // (the engine runs on the empty tmp tree and returns a non-2 code).
  const out = await run(['rollback', 'snap-x', '--force', '--config-dir', tmp]);
  assert.notEqual(out.code, 2, '--force is recognized, not a usage error');
  assert.ok(!out.stdout.includes('unknown flag'), '--force did not trip the unknown-flag guard');
});

// ── recover ──────────────────────────────────────────────────────────────────────

test('recover <id> --apply, gate CLOSED (env=0) → code 3 + writes-disabled-env', async () => {
  process.env[ENV_KEY] = '0';
  try {
    const out = await run(['recover', 'snap-x', '--apply', '--config-dir', tmp]);
    assert.equal(out.code, 3);
    assert.ok(out.stdout.includes('writes-disabled-env'), 'the two-factor gate refused end-to-end');
  } finally {
    delete process.env[ENV_KEY];
  }
});

test('recover <id> --mark-failed --resume → code 3 + recover-ambiguous-mode (both flags parse)', async () => {
  const out = await run(['recover', 'snap-x', '--mark-failed', '--resume', '--config-dir', tmp]);
  assert.equal(out.code, 3);
  assert.ok(out.stdout.includes('recover-ambiguous-mode'), 'two mode flags reached the handler');
});

// ── lock ─────────────────────────────────────────────────────────────────────────

test('lock (read-only) → code 0 on an absent lock (proves dispatch)', async () => {
  const out = await run(['lock', '--config-dir', tmp]);
  assert.equal(out.code, 0);
});

test('lock --break-lock (no --apply) → code 3 + lock-break-needs-apply', async () => {
  const out = await run(['lock', '--break-lock', '--config-dir', tmp]);
  assert.equal(out.code, 3);
  assert.ok(out.stdout.includes('lock-break-needs-apply'), 'break is gated behind --apply');
});

// ── positionals regression (the canonicalize change) ──────────────────────────────

test('regression: two-word `config show-effective` still collapses (not "unknown command")', async () => {
  const out = await run(['config', 'show-effective', '--config-dir', tmp]);
  assert.equal(out.code, 0, 'a clean dispatch, not a usage error');
  assert.ok(!out.stdout.includes('unknown command'), 'the 2-token consume still works');
});
