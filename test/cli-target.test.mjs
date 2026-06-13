/**
 * P6.U2b — cli-target.test.mjs
 *
 * Drives run(argv) end-to-end to prove the --target plumbing:
 *   - an unknown --target is a hard usage error (exit 2).
 *   - --target codex classifies orphans via the codex descriptor (config.toml is
 *     NOT a hard orphan; a planted unknown dir IS).
 *   - WITHOUT --target, a codex-shaped dir (config.toml present) auto-detects codex.
 *   - WITHOUT --target, a non-codex dir (no config.toml) stays claude (config.toml
 *     would be a hard orphan there, but a claude tree has none).
 *
 * Real temp dirs are used (run() resolves the auto-detect probe via the real
 * statSync seam), cleaned in finally.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/cli.mjs';

/** Create a throwaway temp dir, await fn(dir), clean up (fn may be async). */
async function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'mgr-u2b-cli-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Build a codex-shaped config dir: config.toml (the signature) + a known dir
 * (skills/) + a planted UNKNOWN top dir + a non-codex top file. Returns the dir.
 */
function buildCodexDir(dir) {
  writeFileSync(join(dir, 'config.toml'), 'x = 1\n');
  mkdirSync(join(dir, 'skills'), { recursive: true });
  mkdirSync(join(dir, 'planted-unknown-dir'), { recursive: true }); // → hard orphan
  writeFileSync(join(dir, 'random-file.xyz'), 'orphan\n');          // → hard orphan (file)
  return dir;
}

/** Build a claude-shaped config dir: settings.json + skills/agents/commands, NO config.toml. */
function buildClaudeDir(dir) {
  writeFileSync(join(dir, 'settings.json'), '{}\n');
  mkdirSync(join(dir, 'skills'), { recursive: true });
  mkdirSync(join(dir, 'agents'), { recursive: true });
  mkdirSync(join(dir, 'commands'), { recursive: true });
  return dir;
}

// ── unknown --target → exit 2 ─────────────────────────────────────────────────

test('run: unknown --target → exit 2 usage error', async () => {
  const out = await run(['orphans', '--target', 'bogus']);
  assert.equal(out.code, 2, `expected exit 2 for unknown target; stdout: ${out.stdout.slice(0, 200)}`);
  assert.ok(/unknown target: bogus/.test(out.stdout), 'usage text should name the bad target');
  assert.ok(/codex/.test(out.stdout) && /claude/.test(out.stdout), 'usage should list valid targets');
});

// ── --target codex: codex classification ──────────────────────────────────────

test('run: --target codex classifies config.toml as known, planted dir as hard orphan', async () => {
  await withTempDir(async (dir) => {
    buildCodexDir(dir);
    const out = await run(['orphans', '--target', 'codex', '--config-dir', dir, '--format', 'json']);
    assert.equal(out.code, 0, `expected exit 0; stdout: ${out.stdout.slice(0, 300)}`);
    const parsed = JSON.parse(out.stdout);
    const orphans = parsed.result?.orphans ?? [];
    const names = orphans.map((o) => o.name);
    // config.toml is a KNOWN codex top file → NOT an orphan.
    assert.equal(names.includes('config.toml'), false, 'config.toml must not be a hard orphan under codex');
    // the planted unknown dir + file ARE hard orphans.
    assert.ok(names.includes('planted-unknown-dir'), `planted dir must be a hard orphan; got: ${JSON.stringify(names)}`);
    assert.ok(names.includes('random-file.xyz'), `random file must be a hard orphan; got: ${JSON.stringify(names)}`);
  });
});

// ── auto-detect codex (no --target) ───────────────────────────────────────────

test('run: no --target, codex-shaped dir → auto-detects codex (config.toml not orphaned)', async () => {
  await withTempDir(async (dir) => {
    buildCodexDir(dir);
    const out = await run(['orphans', '--config-dir', dir, '--format', 'json']);
    assert.equal(out.code, 0, `expected exit 0; stdout: ${out.stdout.slice(0, 300)}`);
    const parsed = JSON.parse(out.stdout);
    const names = (parsed.result?.orphans ?? []).map((o) => o.name);
    // If auto-detect picked codex, config.toml is known. (Under claude, config.toml
    // would be a hard orphan — so this assertion proves codex was auto-detected.)
    assert.equal(names.includes('config.toml'), false, 'auto-detected codex must treat config.toml as known');
    assert.ok(names.includes('planted-unknown-dir'), 'the planted unknown dir is still a hard orphan');
  });
});

// ── auto-detect claude (no --target, no config.toml) ──────────────────────────

test('run: no --target, non-codex dir (no config.toml) → stays claude', async () => {
  await withTempDir(async (dir) => {
    buildClaudeDir(dir);
    const out = await run(['orphans', '--config-dir', dir, '--format', 'json']);
    assert.equal(out.code, 0, `expected exit 0; stdout: ${out.stdout.slice(0, 300)}`);
    const parsed = JSON.parse(out.stdout);
    const names = (parsed.result?.orphans ?? []).map((o) => o.name);
    // A clean claude tree has no orphans; settings.json is a known claude top file.
    assert.equal(names.includes('settings.json'), false, 'settings.json must be a known claude top file');
    // Proof it used the CLAUDE tables: 'prompts' is a codex dir, not a claude one.
    // (We don't plant prompts/, but the absence of config.toml means claude tables.)
    assert.deepEqual(names, [], `a clean claude tree should have no orphans; got: ${JSON.stringify(names)}`);
  });
});
