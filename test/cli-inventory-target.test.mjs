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

// ── multi-source: plugin-cache skills count + provenance (P6) ─────────────────

test('run: inventory --target codex counts plugin-cache skills + exposes provenance in --detail', async () => {
  await withTempDir(async (dir) => {
    buildCodexDir(dir); // 1 home skill (skills/foo)
    // a plugin-cache skill: plugins/cache/<mp>/<plugin>/<leaf>/skills/<name>/SKILL.md
    const cs = join(dir, 'plugins', 'cache', 'openai-curated', 'github', 'v1', 'skills', 'gh-fix-ci');
    mkdirSync(cs, { recursive: true });
    writeFileSync(join(cs, 'SKILL.md'), '---\n---\nbody\n');

    const out = await run(['inventory', '--target', 'codex', '--config-dir', dir, '--detail', '--format', 'json']);
    assert.equal(out.code, 0, out.stdout.slice(0, 300));
    const parsed = JSON.parse(out.stdout);
    // home skill + plugin-cache skill both counted.
    assert.equal(parsed.result.counts.skills, 2, `home + plugin skill; got ${JSON.stringify(parsed.result.counts)}`);
    // the plugin skill carries plugin/marketplace provenance.
    const plug = (parsed.result.components || []).find((c) => c.name === 'gh-fix-ci');
    assert.ok(plug, 'plugin-cache skill present in --detail');
    assert.equal(plug.source.tier, 'plugin');
    assert.equal(plug.source.plugin, 'github');
    assert.equal(plug.source.marketplace, 'openai-curated');
  });
});

test('run: inventory --target codex counts plugin-cache commands (flat-md) with provenance', async () => {
  await withTempDir(async (dir) => {
    buildCodexDir(dir); // 1 home command (prompts/greet.md)
    // a plugin-cache command: plugins/cache/<mp>/<plugin>/<leaf>/commands/<name>.md
    const cc = join(dir, 'plugins', 'cache', 'openai-curated', 'cloudflare', 'v1', 'commands');
    mkdirSync(cc, { recursive: true });
    writeFileSync(join(cc, 'build-agent.md'), '---\ndescription: Build an agent\n---\nbody\n');

    const out = await run(['inventory', '--target', 'codex', '--config-dir', dir, '--detail', '--format', 'json']);
    assert.equal(out.code, 0, out.stdout.slice(0, 300));
    const parsed = JSON.parse(out.stdout);
    // home command (greet) + plugin command (build-agent) both counted.
    assert.equal(parsed.result.counts.commands, 2, `home + plugin command; got ${JSON.stringify(parsed.result.counts)}`);
    const plug = (parsed.result.components || []).find((c) => c.name === 'build-agent');
    assert.ok(plug, 'plugin-cache command present in --detail');
    assert.equal(plug.kind, 'command');
    assert.equal(plug.source.tier, 'plugin');
    assert.equal(plug.source.plugin, 'cloudflare');
    assert.equal(plug.source.marketplace, 'openai-curated');
  });
});

test('run: inventory --target codex counts the sibling ~/.agents/skills (tier user)', async () => {
  // sibling resolves as dirname(configDir)/.agents → build <root>/.codex as the config dir.
  const root = mkdtempSync(join(tmpdir(), 'mgr-sib-cli-'));
  try {
    const cfg = join(root, '.codex');
    mkdirSync(cfg, { recursive: true }); // buildCodexDir writes config.toml into cfg, so cfg must exist
    buildCodexDir(cfg); // 1 home skill
    const ag = join(root, '.agents', 'skills', 'brandkit');
    mkdirSync(ag, { recursive: true });
    writeFileSync(join(ag, 'SKILL.md'), '---\n---\nbody\n');

    const out = await run(['inventory', '--target', 'codex', '--config-dir', cfg, '--detail', '--format', 'json']);
    assert.equal(out.code, 0, out.stdout.slice(0, 300));
    const parsed = JSON.parse(out.stdout);
    assert.equal(parsed.result.counts.skills, 2, `home + sibling skill; got ${JSON.stringify(parsed.result.counts)}`);
    const sib = (parsed.result.components || []).find((c) => c.name === 'brandkit');
    assert.ok(sib, 'sibling skill present in --detail');
    assert.equal(sib.source.tier, 'user');
    assert.ok(sib.path.includes('.agents'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('run: inventory --type marketplace --target codex unions the [marketplaces] table + plugins/cache', async () => {
  await withTempDir(async (dir) => {
    writeFileSync(join(dir, 'config.toml'),
      'model = "gpt-5.5"\n\n[marketplaces]\nmax_depth = 2\n\n[marketplaces.openai-bundled]\nsource = "/p/bundled"\n', 'utf8');
    mkdirSync(join(dir, 'plugins', 'cache', 'openai-bundled'), { recursive: true });
    mkdirSync(join(dir, 'plugins', 'cache', 'openai-curated'), { recursive: true }); // cached, undeclared

    const out = await run(['inventory', '--type', 'marketplace', '--target', 'codex', '--config-dir', dir, '--format', 'json']);
    assert.equal(out.code, 0, out.stdout.slice(0, 300));
    const items = JSON.parse(out.stdout).result.items || [];
    assert.deepEqual(items.map((m) => m.name), ['openai-bundled', 'openai-curated'], 'declared + cached, sorted, max_depth excluded');
    assert.equal(items.find((m) => m.name === 'openai-bundled').installLocation, '/p/bundled');
    assert.equal(items.every((m) => m.onDisk === true), true);
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
