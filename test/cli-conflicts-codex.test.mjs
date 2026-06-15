/**
 * cli-conflicts-codex.test.mjs (P6 conflicts unit) — `conflicts --target codex`
 * is target-correct + honest, end-to-end through run().
 *
 * Authority: docs/phase-6-codex-loadorder-design.md. Two things change for codex:
 *   1. Correctness — the scan now threads ctx.descriptor, so codex components
 *      (skills + prompts/ commands + agents/*.toml) are discovered with the CODEX
 *      layout, not the Claude one. (The CLAUDE path is byte-identical: no-descriptor
 *      === claudeDescriptor for component discovery, already drift-guarded.)
 *   2. Honesty — on a codex target the load-order diagnostic is the codex caveat
 *      `conflicts-unverified-for-codex` INSTEAD of the Claude-Code-version diagnostic
 *      `loader-rules-unverified-version` (whose "verified for 2.1.x" wording is
 *      meaningless on codex). THIS diagnostic swap is the headline falsifiable oracle.
 *
 * Codex conflicts are STRUCTURALLY 0 here: claude-mgr's codex scan walks only the
 * single home dir per kind and tiers all components `user`, and a codex home dir is
 * filesystem-unique per kind (no same-name dups). The cross-source dups that WOULD
 * collide live in plugins/cache/ + ~/.agents/skills, which the scan does not
 * traverse (deferred). So conflicts is an empty array by construction.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { run } from '../src/cli.mjs';

/** Find a diagnostic with the given code in a diagnostics array. */
const hasCode = (diags, code) => Array.isArray(diags) && diags.some((d) => d && d.code === code);

/**
 * A codex config dir: a config.toml (so auto-detect also recognises codex) plus a
 * skill, a prompts/ command, and an agents/*.toml — NO same-name collisions
 * (codex home dirs are filesystem-unique per kind).
 */
function makeCodexDir() {
  const dir = mkdtempSync(join(tmpdir(), 'mgr-conflicts-codex-'));
  writeFileSync(join(dir, 'config.toml'), 'model = "gpt-5.5"\n', 'utf8');
  // skill: skills/<name>/SKILL.md
  mkdirSync(join(dir, 'skills', 'alpha-skill'), { recursive: true });
  writeFileSync(join(dir, 'skills', 'alpha-skill', 'SKILL.md'), '---\nname: alpha-skill\ndescription: d\n---\nbody\n', 'utf8');
  // prompts/ command: prompts/<name>.md (a codex command; invisible under the Claude layout)
  mkdirSync(join(dir, 'prompts'), { recursive: true });
  writeFileSync(join(dir, 'prompts', 'beta-prompt.md'), '# beta prompt\n', 'utf8');
  // agents/<name>.toml (a codex agent; invisible under the Claude .md layout)
  mkdirSync(join(dir, 'agents'), { recursive: true });
  writeFileSync(join(dir, 'agents', 'gamma-agent.toml'), 'name = "gamma-agent"\n', 'utf8');
  return dir;
}

/** A Claude config dir: a settings.json + a skill, and NO config.toml (auto-detect stays claude). */
function makeClaudeDir() {
  const dir = mkdtempSync(join(tmpdir(), 'mgr-conflicts-claude-'));
  writeFileSync(join(dir, 'settings.json'), '{ "model": "sonnet" }\n', 'utf8');
  mkdirSync(join(dir, 'skills', 'alpha-skill'), { recursive: true });
  writeFileSync(join(dir, 'skills', 'alpha-skill', 'SKILL.md'), '---\nname: alpha-skill\ndescription: d\n---\nbody\n', 'utf8');
  return dir;
}

// ── (i) codex: honest caveat replaces the CC-version diagnostic ────────────────────

test('conflicts --target codex: empty conflicts + codex caveat replaces the CC-version diagnostic', async () => {
  const dir = makeCodexDir();
  try {
    const { code, stdout } = await run(['conflicts', '--target', 'codex', '--config-dir', dir, '--format', 'json']);
    assert.equal(code, 0, stdout);
    const env = JSON.parse(stdout);
    assert.equal(env.command, 'conflicts');

    // Codex conflicts are structurally moot (single home dir per kind, filesystem-unique).
    assert.ok(Array.isArray(env.result.conflicts), 'conflicts is an array');
    assert.equal(env.result.conflicts.length, 0, 'codex conflicts are structurally 0');
    assert.ok(Array.isArray(env.result.dispositions), 'dispositions is an array');
    assert.equal(env.result.dispositions.length, 0);

    // HEADLINE falsifiable oracle: the codex caveat is present and the CC-version one is gone.
    assert.ok(hasCode(env.diagnostics, 'conflicts-unverified-for-codex'), 'codex caveat present');
    assert.ok(!hasCode(env.diagnostics, 'loader-rules-unverified-version'), 'CC-version diagnostic absent on codex');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── (ii) claude: unchanged — still the CC-version diagnostic ───────────────────────

test('conflicts (claude default, no --target): CC-version diagnostic present, no codex caveat', async () => {
  const dir = makeClaudeDir();
  try {
    const { code, stdout } = await run(['conflicts', '--config-dir', dir, '--format', 'json']);
    assert.equal(code, 0, stdout);
    const env = JSON.parse(stdout);
    assert.equal(env.command, 'conflicts');
    // Pins the Claude path byte-identical: the version-guard info, not the codex caveat.
    assert.ok(hasCode(env.diagnostics, 'loader-rules-unverified-version'), 'CC-version diagnostic present on claude');
    assert.ok(!hasCode(env.diagnostics, 'conflicts-unverified-for-codex'), 'codex caveat absent on claude');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── (iii) explicit --target claude === the default claude leg ──────────────────────

test('conflicts --target claude: identical diagnostic codes to the no-target default', async () => {
  const dir = makeClaudeDir();
  try {
    const explicit = JSON.parse((await run(['conflicts', '--target', 'claude', '--config-dir', dir, '--format', 'json'])).stdout);
    const dflt = JSON.parse((await run(['conflicts', '--config-dir', dir, '--format', 'json'])).stdout);
    const codes = (env) => (env.diagnostics || []).map((d) => d.code).sort();
    assert.deepEqual(codes(explicit), codes(dflt), 'explicit claude === default claude diagnostics');
    assert.ok(hasCode(explicit.diagnostics, 'loader-rules-unverified-version'));
    assert.ok(!hasCode(explicit.diagnostics, 'conflicts-unverified-for-codex'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── (iv) codex multi-source: cross-source same-name → honest CO-EXISTENCE (no winner) ──

/** Plant a plugin-cache skill at plugins/cache/<mp>/<plugin>/<leaf>/skills/<name>/SKILL.md */
function mkPluginSkill(dir, mp, plugin, leaf, skill) {
  const p = join(dir, 'plugins', 'cache', mp, plugin, leaf, 'skills', skill);
  mkdirSync(p, { recursive: true });
  writeFileSync(join(p, 'SKILL.md'), '---\n---\nbody\n', 'utf8');
}

test('conflicts --target codex with plugin caches: conflicts stay [], cross-source dups become co-existence', async () => {
  const dir = makeCodexDir(); // already has a home skill alpha-skill + a config.toml
  try {
    // A home skill that ALSO ships from two plugin marketplaces (the real codex pattern).
    mkdirSync(join(dir, 'skills', 'gh-fix-ci'), { recursive: true });
    writeFileSync(join(dir, 'skills', 'gh-fix-ci', 'SKILL.md'), '---\n---\nbody\n', 'utf8');
    mkPluginSkill(dir, 'mkt-a', 'github', 'v1', 'gh-fix-ci');
    mkPluginSkill(dir, 'mkt-b', 'github', 'v1', 'gh-fix-ci');

    const { code, stdout } = await run(['conflicts', '--target', 'codex', '--config-dir', dir, '--format', 'json']);
    assert.equal(code, 0, stdout);
    const env = JSON.parse(stdout);

    // No Claude-style shadowing winner is ever asserted for codex.
    assert.deepEqual(env.result.conflicts, [], 'codex asserts no shadowing winner');
    assert.deepEqual(env.result.dispositions, [], 'no dispositions on codex');

    // The cross-source same-name dup surfaces as honest co-existence (no winner).
    const co = env.result.coexistence;
    assert.ok(Array.isArray(co), 'coexistence array present for codex');
    const cl = co.find((c) => c.name === 'gh-fix-ci');
    assert.ok(cl, 'gh-fix-ci co-existence cluster present');
    assert.equal(cl.kind, 'skill');
    assert.equal(cl.count, 3, 'home + 2 plugin marketplaces all load');
    assert.equal(cl.sources.filter((s) => s.tier === 'plugin').length, 2);
    assert.equal(cl.sources.filter((s) => s.tier === 'user').length, 1);

    // Honest caveat present; the meaningless CC-version diagnostic is gone.
    assert.ok(hasCode(env.diagnostics, 'conflicts-unverified-for-codex'), 'codex caveat present');
    assert.ok(!hasCode(env.diagnostics, 'loader-rules-unverified-version'), 'CC-version diagnostic absent');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('conflicts --target codex: claude shadowing is NOT asserted even when a plugin name ships twice', async () => {
  const dir = makeCodexDir();
  try {
    // Same plugin name from two marketplaces → under the Claude model this would be a
    // `github:gh-fix-ci` shadowing cluster claiming "first wins". For codex it must NOT.
    mkPluginSkill(dir, 'mkt-a', 'github', 'v1', 'yeet');
    mkPluginSkill(dir, 'mkt-b', 'github', 'v1', 'yeet');
    const env = JSON.parse((await run(['conflicts', '--target', 'codex', '--config-dir', dir, '--format', 'json'])).stdout);
    assert.deepEqual(env.result.conflicts, [], 'no plugin-vs-plugin shadowing winner for codex');
    assert.ok(env.result.coexistence.some((c) => c.name === 'yeet' && c.count === 2));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
