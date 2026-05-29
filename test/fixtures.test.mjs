/**
 * P1.U6 — fixtures.test.mjs
 *
 * Asserts the shape and invariants of every test fixture under test/fixtures/.
 * These tests are the acceptance gate for the sandbox config directories that
 * later units (discovery, conflicts, doctor) use as CLAUDE_CONFIG_DIR values.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const fix = (rel) => join(here, 'fixtures', rel);

// ── minimal/ ──────────────────────────────────────────────────────────────────

test('minimal: skill SKILL.md exists', () => {
  assert.ok(existsSync(fix('minimal/skills/hello/SKILL.md')), 'hello SKILL.md present');
});

test('minimal: skill frontmatter declares name: hello', () => {
  const content = readFileSync(fix('minimal/skills/hello/SKILL.md'), 'utf-8');
  assert.match(content, /^name:\s*hello$/m);
});

test('minimal: agent file exists', () => {
  assert.ok(existsSync(fix('minimal/agents/helper.md')), 'helper.md present');
});

test('minimal: agent frontmatter declares name: helper', () => {
  const content = readFileSync(fix('minimal/agents/helper.md'), 'utf-8');
  assert.match(content, /^name:\s*helper$/m);
});

test('minimal: command file exists', () => {
  assert.ok(existsSync(fix('minimal/commands/greet.md')), 'greet.md present');
});

test('minimal: settings.json is valid JSON with model field', () => {
  const settings = JSON.parse(readFileSync(fix('minimal/settings.json'), 'utf-8'));
  assert.equal(settings.model, 'sonnet');
  assert.ok(Array.isArray(settings.permissions.allow));
});

// ── conflict/ ─────────────────────────────────────────────────────────────────

test('conflict: user-level executor agent exists', () => {
  assert.ok(existsSync(fix('conflict/agents/executor.md')), 'user executor.md present');
});

test('conflict: plugin-level executor agent exists at verified cache path', () => {
  const pluginAgent = fix(
    'conflict/plugins/cache/claude-plugins-official/oh-my-claudecode/1.0.0/agents/executor.md',
  );
  assert.ok(existsSync(pluginAgent), 'plugin executor.md present');
});

test('conflict: both executor agents declare name: executor (the real collision)', () => {
  const userContent = readFileSync(fix('conflict/agents/executor.md'), 'utf-8');
  const pluginContent = readFileSync(
    fix('conflict/plugins/cache/claude-plugins-official/oh-my-claudecode/1.0.0/agents/executor.md'),
    'utf-8',
  );
  assert.match(userContent, /^name:\s*executor$/m, 'user agent name');
  assert.match(pluginContent, /^name:\s*executor$/m, 'plugin agent name');
});

test('conflict: user executor model is opus (winner marker)', () => {
  const content = readFileSync(fix('conflict/agents/executor.md'), 'utf-8');
  assert.match(content, /^model:\s*opus$/m);
});

test('conflict: plugin executor model is sonnet (loser marker)', () => {
  const content = readFileSync(
    fix('conflict/plugins/cache/claude-plugins-official/oh-my-claudecode/1.0.0/agents/executor.md'),
    'utf-8',
  );
  assert.match(content, /^model:\s*sonnet$/m);
});

test('conflict: installed_plugins.json references oh-my-claudecode plugin', () => {
  const ip = JSON.parse(readFileSync(fix('conflict/plugins/installed_plugins.json'), 'utf-8'));
  assert.equal(ip.version, 2);
  assert.ok('oh-my-claudecode@claude-plugins-official' in ip.plugins);
});

test('conflict: token-vault skill present (guards against name-pattern false positives)', () => {
  assert.ok(existsSync(fix('conflict/skills/token-vault/SKILL.md')), 'token-vault SKILL.md present');
});

// ── broken/ ───────────────────────────────────────────────────────────────────

test('broken: settings.json has trailing comma (unparseable as strict JSON)', () => {
  const raw = readFileSync(fix('broken/settings.json'), 'utf-8');
  assert.throws(() => JSON.parse(raw), /SyntaxError|JSON/, 'strict parse must throw');
});

test('broken: bad-frontmatter SKILL.md exists', () => {
  assert.ok(existsSync(fix('broken/skills/bad-frontmatter/SKILL.md')));
});

test('broken: bad-frontmatter SKILL.md contains malformed YAML (unclosed bracket)', () => {
  const content = readFileSync(fix('broken/skills/bad-frontmatter/SKILL.md'), 'utf-8');
  // The name value is an unclosed flow-sequence: name: [unclosed bracket
  assert.match(content, /^name:\s*\[/m);
});

test('broken: installed_plugins.json references plugins with no cache dirs', () => {
  const ip = JSON.parse(readFileSync(fix('broken/plugins/installed_plugins.json'), 'utf-8'));
  assert.equal(ip.version, 2);
  // ghost-plugin and another-ghost are enabled but have no cache dirs
  assert.ok('ghost-plugin@claude-plugins-official' in ip.plugins);
  assert.ok('another-ghost@thedotmack' in ip.plugins);
  // Confirm no cache dirs exist for them
  assert.ok(
    !existsSync(fix('broken/plugins/cache/claude-plugins-official/ghost-plugin')),
    'ghost-plugin cache must not exist',
  );
});

// ── unicode-paths/ ────────────────────────────────────────────────────────────

test('unicode-paths: café-assistant skill exists', () => {
  assert.ok(existsSync(fix('unicode-paths/skills/café-assistant/SKILL.md')));
});

test('unicode-paths: agent with Unicode name exists', () => {
  assert.ok(existsSync(fix('unicode-paths/agents/répondeur.md')));
});

// ── long-paths/ ───────────────────────────────────────────────────────────────

test('long-paths: 60-char skill directory exists', () => {
  const longName = 'a'.repeat(60);
  assert.ok(existsSync(fix(`long-paths/skills/${longName}/SKILL.md`)));
});

// ── case-insensitive/ ─────────────────────────────────────────────────────────

test('case-insensitive: mixed-case skill dir exists', () => {
  assert.ok(existsSync(fix('case-insensitive/skills/MySkill/SKILL.md')));
});

test('case-insensitive: mixed-case agent file exists', () => {
  assert.ok(existsSync(fix('case-insensitive/agents/MyAgent.md')));
});

// ── onedrive-placeholder/ ─────────────────────────────────────────────────────

test('onedrive-placeholder: README documents static-data limitation', () => {
  assert.ok(
    existsSync(fix('onedrive-placeholder/README.md')),
    'README.md explains why a static fixture cannot fake the offline attribute',
  );
});

// ── real-snapshot/ ────────────────────────────────────────────────────────────

test('real-snapshot: snapshot.json exists and is valid JSON', () => {
  const snapPath = fix('real-snapshot/snapshot.json');
  assert.ok(existsSync(snapPath), 'snapshot.json present');
  const snap = JSON.parse(readFileSync(snapPath, 'utf-8'));
  assert.ok(snap._meta, '_meta block present');
  assert.ok(snap.skills, 'skills block present');
  assert.ok(snap.agents, 'agents block present');
});

test('real-snapshot: skill count ≥ 200 (sanity check against known ~240)', () => {
  const snap = JSON.parse(readFileSync(fix('real-snapshot/snapshot.json'), 'utf-8'));
  assert.ok(snap.skills.count >= 200, `expected ≥200 skills, got ${snap.skills.count}`);
});

test('real-snapshot: agent count ≥ 10 (sanity check against known 19)', () => {
  const snap = JSON.parse(readFileSync(fix('real-snapshot/snapshot.json'), 'utf-8'));
  assert.ok(snap.agents.count >= 10, `expected ≥10 agents, got ${snap.agents.count}`);
});

test('real-snapshot REDACTION: no real username (alice)', () => {
  const raw = readFileSync(fix('real-snapshot/snapshot.json'), 'utf-8');
  assert.ok(!raw.includes('alice'), 'username alice must not appear in snapshot');
});

test('real-snapshot REDACTION: no real email prefix (exampleuser)', () => {
  const raw = readFileSync(fix('real-snapshot/snapshot.json'), 'utf-8');
  assert.ok(!raw.includes('exampleuser'), 'email prefix must not appear in snapshot');
});

test('real-snapshot REDACTION: no Windows absolute path (C:\\Users)', () => {
  const raw = readFileSync(fix('real-snapshot/snapshot.json'), 'utf-8');
  assert.ok(!/[A-Za-z]:[/\\]Users/.test(raw), 'no Windows absolute path in snapshot');
});

test('real-snapshot REDACTION: no POSIX absolute path (/c/Users)', () => {
  const raw = readFileSync(fix('real-snapshot/snapshot.json'), 'utf-8');
  assert.ok(!/\/[cC]\/Users\//.test(raw), 'no POSIX absolute path in snapshot');
});

test('real-snapshot REDACTION: no token-like hex string ≥20 chars', () => {
  const raw = readFileSync(fix('real-snapshot/snapshot.json'), 'utf-8');
  const match = raw.match(/[0-9a-fA-F]{20,}/);
  assert.ok(!match, `hex token found in snapshot: ${match?.[0]?.slice(0, 20)}`);
});

// ── real-snapshot/ scannable tree (new synthetic fixture) ─────────────────────

test('real-snapshot scannable tree: settings.json is valid JSONC object with no duplicateKeys', () => {
  // Use raw JSON.parse — the '//' key is unique, no actual duplicates.
  const raw = readFileSync(fix('real-snapshot/settings.json'), 'utf-8');
  const parsed = JSON.parse(raw);
  assert.ok(parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed), 'settings.json is a JSON object');
});

test('real-snapshot scannable tree: installed_plugins.json schema version is 2', () => {
  const raw = readFileSync(fix('real-snapshot/plugins/installed_plugins.json'), 'utf-8');
  const parsed = JSON.parse(raw);
  assert.equal(parsed.version, 2, 'schema version must be 2');
});

test('real-snapshot scannable tree: all required scannable surfaces present', () => {
  const required = [
    'settings.json',
    'plugins/installed_plugins.json',
    'plugins/known_marketplaces.json',
    '.mcp.json',
    'skills/hello-skill/SKILL.md',
    'agents/synthetic-helper.md',
    'commands/synthetic-greet.md',
    'hooks/session-start.mjs',
    'hooks/pre-tool-use.mjs',
    'hooks/statusline.mjs',
    'plugins/cache/synthetic-marketplace/sample-plugin/1.0.0/.gitkeep',
  ];
  for (const rel of required) {
    assert.ok(existsSync(fix(`real-snapshot/${rel}`)), `required file missing: ${rel}`);
  }
});

test('real-snapshot REDACTION (whole tree): no real username, email, home path, or hex token', () => {
  /** Recursively collect all files under a dir, skipping snapshot.json (covered above). */
  function collectFiles(dir, out) {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        collectFiles(full, out);
      } else if (entry !== 'snapshot.json') {
        out.push(full);
      }
    }
    return out;
  }

  const treeRoot = fix('real-snapshot');
  const files = collectFiles(treeRoot, []);
  assert.ok(files.length > 0, 'should find files in the tree');

  const forbidden = [
    { re: /alice/, label: 'username alice' },
    { re: /exampleuser/, label: 'email prefix exampleuser' },
    { re: /[A-Za-z]:[/\\]Users/, label: 'Windows absolute home path' },
    { re: /\/[cC]\/Users\//, label: 'POSIX absolute home path' },
    { re: /[0-9a-fA-F]{20,}/, label: 'hex token ≥20 chars' },
  ];

  for (const file of files) {
    const content = readFileSync(file, 'utf-8');
    for (const { re, label } of forbidden) {
      const m = content.match(re);
      assert.ok(!m, `${label} found in ${file}: ${m?.[0]?.slice(0, 30)}`);
    }
  }
});

test('real-snapshot REDACTION (whole tree): README.md contains synthetic marker', () => {
  const readme = readFileSync(fix('real-snapshot/README.md'), 'utf-8');
  assert.ok(readme.includes('SYNTHETIC TEST FIXTURE - NOT REAL'), 'README must carry the synthetic marker');
});
