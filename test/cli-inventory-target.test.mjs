/**
 * P6.U3 — cli-inventory-target.test.mjs
 *
 * Drives run(argv) end-to-end to prove `inventory` reports codex components:
 *   - --target codex against a codex-shaped dir → counts.skills/commands/agents
 *     each reflect the codex layouts (skills/skill-md, prompts/flat-md,
 *     agents/flat-toml).
 *   - WITHOUT --target on the same dir (config.toml present) auto-detects codex and
 *     yields the same counts.
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
  const dir = mkdtempSync(join(tmpdir(), 'mgr-u3-cli-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Build a codex-shaped config dir: config.toml (the signature) + one skill
 * (skills/foo/SKILL.md), one command (prompts/greet.md), one agent
 * (agents/architect.toml). Returns the dir.
 */
function buildCodexDir(dir) {
  writeFileSync(join(dir, 'config.toml'), 'x = 1\n');
  mkdirSync(join(dir, 'skills', 'foo'), { recursive: true });
  writeFileSync(join(dir, 'skills', 'foo', 'SKILL.md'), '---\n---\nbody\n');
  mkdirSync(join(dir, 'prompts'), { recursive: true });
  writeFileSync(join(dir, 'prompts', 'greet.md'), '# greet\n');
  mkdirSync(join(dir, 'agents'), { recursive: true });
  writeFileSync(join(dir, 'agents', 'architect.toml'), 'x = 1\n');
  return dir;
}

// ── --target codex: counts reflect codex layouts ──────────────────────────────

test('run: inventory --target codex counts skills/commands/agents', async () => {
  await withTempDir(async (dir) => {
    buildCodexDir(dir);
    const out = await run(['inventory', '--target', 'codex', '--config-dir', dir, '--format', 'json']);
    assert.equal(out.code, 0, `expected exit 0; stdout: ${out.stdout.slice(0, 300)}`);
    const parsed = JSON.parse(out.stdout);
    const counts = parsed.result?.counts ?? {};
    assert.equal(counts.skills, 1, `expected 1 skill; got ${JSON.stringify(counts)}`);
    assert.equal(counts.commands, 1, `expected 1 command; got ${JSON.stringify(counts)}`);
    assert.equal(counts.agents, 1, `expected 1 agent; got ${JSON.stringify(counts)}`);
  });
});

// ── auto-detect codex (no --target) → same counts ─────────────────────────────

test('run: inventory without --target auto-detects codex (same counts)', async () => {
  await withTempDir(async (dir) => {
    buildCodexDir(dir);
    const out = await run(['inventory', '--config-dir', dir, '--format', 'json']);
    assert.equal(out.code, 0, `expected exit 0; stdout: ${out.stdout.slice(0, 300)}`);
    const parsed = JSON.parse(out.stdout);
    const counts = parsed.result?.counts ?? {};
    // If auto-detect picked codex, prompts/ counts as a command and agents/*.toml
    // as an agent. (Under claude, prompts/ is unknown and *.toml would not count.)
    assert.equal(counts.skills, 1, `expected 1 skill; got ${JSON.stringify(counts)}`);
    assert.equal(counts.commands, 1, `auto-detected codex must count prompts/ as a command; got ${JSON.stringify(counts)}`);
    assert.equal(counts.agents, 1, `auto-detected codex must count agents/*.toml as an agent; got ${JSON.stringify(counts)}`);
  });
});
