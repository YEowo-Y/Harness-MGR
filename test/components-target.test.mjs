/**
 * P6.U3 — components-target.test.mjs
 *
 * Verifies discoverComponents(rootDir, sourceInput, {descriptor}) drives the walk
 * from a TargetDescriptor's componentKinds:
 *   - BACK-COMPAT: the default path (no descriptor) is byte-identical to passing
 *     the claude descriptor (drift-guard — load-bearing).
 *   - CODEX: a temp tree mimicking ~/.codex discovers skills (skill-md, dir
 *     identity), commands (flat-md basename in prompts/), and agents (flat-toml
 *     filename identity, content NOT parsed).
 *
 * Temp trees are built via mkdtempSync(tmpdir()) and cleaned in finally.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverComponents } from '../src/discovery/components.mjs';
import { discoverComponentsForTarget } from '../src/discovery/components-target.mjs';
import { claudeDescriptor } from '../src/targets/claude.mjs';
import { codexDescriptor } from '../src/targets/codex.mjs';

/** Create a throwaway temp dir, run fn(dir), clean up. */
function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'mgr-u3-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const mkdir = (dir, name) => mkdirSync(join(dir, name), { recursive: true });
const mkfile = (dir, rel, body = '') => writeFileSync(join(dir, rel), body, 'utf-8');

// ── BACK-COMPAT DRIFT-GUARD (LOAD-BEARING) ────────────────────────────────────

test('back-compat: default path === claude-descriptor path (deepEqual)', () => {
  withTempDir((dir) => {
    // claude-shaped triple: a skill dir, an agent with a frontmatter name (so the
    // agent-name rule is exercised), and a command (basename identity).
    mkdir(dir, join('skills', 'hello'));
    mkfile(dir, join('skills', 'hello', 'SKILL.md'), '---\nmodel: haiku\n---\nbody\n');
    mkdir(dir, 'agents');
    mkfile(dir, join('agents', 'helper.md'), '---\nname: helper-display\n---\nbody\n');
    mkdir(dir, 'commands');
    mkfile(dir, join('commands', 'greet.md'), '---\n---\nbody\n');
    // a loose file in skills/ + a non-.md in agents/ (exercise the file gates).
    mkfile(dir, join('skills', 'loose.txt'), 'loose');
    mkfile(dir, join('agents', 'bad.json'), '{}');

    const dflt = discoverComponents(dir);
    const viaClaude = discoverComponents(dir, undefined, { descriptor: claudeDescriptor });
    assert.deepEqual(dflt, viaClaude);
    // sanity: the agent identity came from frontmatter.name, not the basename.
    assert.ok(dflt.components.some((c) => c.kind === 'agent' && c.name === 'helper-display'));
  });
});

// ── CODEX SHAPE GOLDEN ────────────────────────────────────────────────────────

test('codex descriptor: skills(skill-md) + commands(prompts/flat-md) + agents(flat-toml, content unparsed)', () => {
  withTempDir((dir) => {
    // skills/<name>/SKILL.md — identity is the DIR name, NOT the frontmatter name.
    mkdir(dir, join('skills', 'foo'));
    mkfile(dir, join('skills', 'foo', 'SKILL.md'), '---\nname: foo-display\n---\nbody\n');
    mkdir(dir, join('skills', 'bar'));
    mkfile(dir, join('skills', 'bar', 'SKILL.md'), '---\n---\nbody\n');

    // prompts/*.md → command kind, basename identity.
    mkdir(dir, 'prompts');
    mkfile(dir, join('prompts', 'greet.md'), '# greet\n');
    mkfile(dir, join('prompts', 'help.md'), '# help\n');

    // agents/*.toml → agent kind, filename identity, content NOT parsed. The TOML
    // body contains a multi-line string to PROVE the parser never touches it.
    mkdir(dir, 'agents');
    mkfile(dir, join('agents', 'architect.toml'), 'developer_instructions = """multi\nline"""\n');
    mkfile(dir, join('agents', 'coder.toml'), 'x = 1\n');
    // a non-.toml file in agents/ → IGNORED (flat-toml only matches .toml).
    mkfile(dir, join('agents', 'README-awesome.md'), '# readme\n');

    const { components, diagnostics } = discoverComponents(dir, undefined, { descriptor: codexDescriptor });

    // zero error diagnostics.
    assert.equal(diagnostics.filter((d) => d.severity === 'error').length, 0);

    // exactly 6 components.
    assert.equal(components.length, 6, `expected 6 components; got ${JSON.stringify(components.map((c) => `${c.kind}/${c.name}`))}`);

    const byKind = (kind) => components.filter((c) => c.kind === kind).map((c) => c.name).sort();
    // 2 skills, identity = DIR name (foo/bar), NOT the frontmatter display name.
    assert.deepEqual(byKind('skill'), ['bar', 'foo']);
    assert.equal(components.some((c) => c.name === 'foo-display'), false, 'skill identity must be the dir name, not frontmatter.name');
    // 2 commands from prompts/, basename identity.
    assert.deepEqual(byKind('command'), ['greet', 'help']);
    // 2 agents from .toml, basename identity (no .toml extension).
    assert.deepEqual(byKind('agent'), ['architect', 'coder']);

    // the README.md under agents/ is absent (flat-toml ignores non-.toml).
    assert.equal(components.some((c) => c.name.startsWith('README')), false, 'README-awesome.md must not be discovered');

    // agent frontmatter is EMPTY — content was not parsed.
    for (const agent of components.filter((c) => c.kind === 'agent')) {
      assert.equal(Object.keys(agent.frontmatter).length, 0, `agent ${agent.name} frontmatter must be empty (content unparsed)`);
    }

    // spot-checks: a skill's path ends with SKILL.md; a command's kind is 'command'.
    const foo = components.find((c) => c.kind === 'skill' && c.name === 'foo');
    assert.match(foo.path, /SKILL\.md$/);
    const greet = components.find((c) => c.name === 'greet');
    assert.equal(greet.kind, 'command');
  });
});

// ── MULTI-SOURCE (P6 codex plugin caches) ─────────────────────────────────────

/** Attempt a dir symlink; return false if the OS/env forbids it (skip the test then). */
function trySymlink(target, linkPath, type) {
  try { symlinkSync(target, linkPath, type); return true; }
  catch { return false; }
}

/** Plant a plugin-cache skill: plugins/cache/<mp>/<plugin>/<leaf>/skills/<name>/SKILL.md */
function mkPluginSkill(dir, mp, plugin, leaf, skill, body = '---\n---\nbody\n') {
  const rel = join('plugins', 'cache', mp, plugin, leaf, 'skills', skill);
  mkdir(dir, rel);
  mkfile(dir, join(rel, 'SKILL.md'), body);
}

test('discoverComponentsForTarget back-compat: claude === home-only discoverComponents (deepEqual)', () => {
  withTempDir((dir) => {
    mkdir(dir, join('skills', 'hello'));
    mkfile(dir, join('skills', 'hello', 'SKILL.md'), '---\nmodel: haiku\n---\nbody\n');
    mkdir(dir, 'agents');
    mkfile(dir, join('agents', 'helper.md'), '---\nname: helper-display\n---\nbody\n');
    mkdir(dir, 'commands');
    mkfile(dir, join('commands', 'greet.md'), '---\n---\nbody\n');
    // Claude declares NO componentSources, so the for-target wrapper is byte-identical
    // to the home-only walk (both the descriptor path and the no-descriptor default).
    const viaTarget = discoverComponentsForTarget({ rootDir: dir, descriptor: claudeDescriptor });
    assert.deepEqual(viaTarget, discoverComponents(dir, undefined, { descriptor: claudeDescriptor }));
    assert.deepEqual(viaTarget, discoverComponents(dir));
  });
});

test('discoverComponentsForTarget bad root → discover-bad-root, never throws', () => {
  const r = discoverComponentsForTarget({ rootDir: '' });
  assert.deepEqual(r.components, []);
  assert.equal(r.diagnostics.some((d) => d.code === 'discover-bad-root'), true);
});

test('codex multi-source: plugin-cache skills discovered with plugin provenance (home stays user)', () => {
  withTempDir((dir) => {
    mkdir(dir, join('skills', 'home-skill'));
    mkfile(dir, join('skills', 'home-skill', 'SKILL.md'), '---\n---\nbody\n');
    mkPluginSkill(dir, 'mkt', 'gh', 'v1', 'gh-fix-ci');

    const { components, diagnostics } = discoverComponentsForTarget({ rootDir: dir, descriptor: codexDescriptor });
    assert.equal(diagnostics.filter((d) => d.severity === 'error').length, 0);

    const home = components.find((c) => c.name === 'home-skill');
    assert.equal(home.source.tier, 'user');

    const plug = components.find((c) => c.name === 'gh-fix-ci');
    assert.ok(plug, 'plugin-cache skill discovered');
    assert.equal(plug.kind, 'skill');
    assert.equal(plug.source.tier, 'plugin');
    assert.equal(plug.source.plugin, 'gh');
    assert.equal(plug.source.marketplace, 'mkt');
    assert.match(plug.path, /SKILL\.md$/);
  });
});

test('codex multi-source: same skill name from two marketplaces yields two records (co-existence input)', () => {
  withTempDir((dir) => {
    mkPluginSkill(dir, 'mkt-a', 'gh', 'v1', 'gh-fix-ci');
    mkPluginSkill(dir, 'mkt-b', 'gh', 'v1', 'gh-fix-ci');
    const { components } = discoverComponentsForTarget({ rootDir: dir, descriptor: codexDescriptor });
    const recs = components.filter((c) => c.kind === 'skill' && c.name === 'gh-fix-ci');
    assert.equal(recs.length, 2, 'one record per marketplace');
    assert.deepEqual(recs.map((r) => r.source.marketplace).sort(), ['mkt-a', 'mkt-b']);
  });
});

test('claude descriptor ignores plugins/cache (no componentSources) — home-only', () => {
  withTempDir((dir) => {
    mkdir(dir, join('skills', 'home'));
    mkfile(dir, join('skills', 'home', 'SKILL.md'), '---\n---\nbody\n');
    mkPluginSkill(dir, 'mkt', 'gh', 'v1', 'should-not-appear');
    const { components } = discoverComponentsForTarget({ rootDir: dir, descriptor: claudeDescriptor });
    assert.equal(components.some((c) => c.name === 'should-not-appear'), false, 'claude must not walk plugins/cache');
    assert.equal(components.length, 1);
  });
});

test('codex multi-source: a symlinked leaf (latest) is NOT followed → skill counted once', (t) => {
  withTempDir((dir) => {
    // a real versioned leaf carrying skill 'dup'
    mkPluginSkill(dir, 'mkt', 'chrome', 'v1', 'dup');
    // a 'latest' symlink leaf pointing at the real versioned leaf (codex's actual layout)
    const realLeaf = join(dir, 'plugins', 'cache', 'mkt', 'chrome', 'v1');
    const made = trySymlink(realLeaf, join(dir, 'plugins', 'cache', 'mkt', 'chrome', 'latest'), 'dir');
    if (!made) { t.skip('dir symlinks not permitted in this environment'); return; }

    const { components } = discoverComponentsForTarget({ rootDir: dir, descriptor: codexDescriptor });
    const dups = components.filter((c) => c.name === 'dup');
    assert.equal(dups.length, 1, 'symlinked latest leaf must not double-count the skill (symlink-never-follow)');
  });
});
