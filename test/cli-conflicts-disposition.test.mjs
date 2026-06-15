/**
 * CLI surface oracle for `conflicts` dispositions (P5.U10).
 *
 * Proves the ADDITIVE wiring: conflictsCommand now adds a `dispositions` array
 * to the result alongside the existing `conflicts` array (byte-compatible — the
 * `conflicts` shape is unchanged, derived clusters stay in sync with --name).
 * The disposition LOGIC itself is unit-tested in test/disposition.test.mjs.
 *
 * A real user-vs-* shadowing cluster cannot be staged in a temp scan tree
 * (Phase-1 scan discovers only user-tier components, and two user files can't
 * share a basename), so the CLI oracle asserts the CONTRACT (both keys present,
 * dispositions an array, conflicts unchanged) PLUS the falsifiable cross-check:
 * IF any cluster exists, its disposition's winner.path === the cluster's
 * likelyWinner.path — exercised against the real-snapshot fixture via run().
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { conflictsCommand } from '../src/cli/commands.mjs';
import { conflictsTable } from '../src/cli/conflicts-render.mjs';
import { run } from '../src/cli.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fix = (rel) => join(here, 'fixtures', rel);

/** Build a temp configDir with skills/<name>/SKILL.md for each name, run fn. */
function withSkills(names, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'mgr-disp-'));
  try {
    for (const name of names) {
      mkdirSync(join(dir, 'skills', name), { recursive: true });
      writeFileSync(join(dir, 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\nbody\n`, 'utf8');
    }
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('conflictsCommand adds a `dispositions` array; `conflicts` array stays present (additive contract)', () => {
  withSkills(['alpha', 'beta'], (dir) => {
    const { result } = conflictsCommand({ configDir: dir, args: {} });
    assert.ok(Array.isArray(result.conflicts), 'conflicts is an array');
    assert.ok(Array.isArray(result.dispositions), 'dispositions is an array');
    // No real cluster in a temp tree → both empty, but the KEYS are present.
    assert.equal(result.conflicts.length, 0);
    assert.equal(result.dispositions.length, 0);
  });
});

test('run(["conflicts","--format","json"]) envelope carries BOTH conflicts and dispositions', async () => {
  await withSkills(['x'], async (dir) => {
    const { code, stdout } = await run(['conflicts', '--format', 'json', '--config-dir', dir]);
    assert.equal(code, 0);
    const env = JSON.parse(stdout);
    assert.equal(env.command, 'conflicts');
    assert.ok('conflicts' in env.result, 'conflicts key present');
    assert.ok('dispositions' in env.result, 'dispositions key present');
    assert.ok(Array.isArray(env.result.dispositions), 'dispositions is an array');
  });
});

test('run() on the real-snapshot fixture: dispositions present + winner.path matches every cluster likelyWinner.path', async () => {
  const { code, stdout } = await run(['conflicts', '--format', 'json', '--config-dir', fix('real-snapshot')]);
  assert.equal(code, 0);
  const env = JSON.parse(stdout);
  const { conflicts, dispositions } = env.result;
  assert.ok(Array.isArray(conflicts), 'conflicts is an array');
  assert.ok(Array.isArray(dispositions), 'dispositions is an array');
  // Falsifiable cross-check: if any cluster exists, its disposition winner.path
  // must equal the cluster's likelyWinner.path (the dispositions derive from the
  // same clusters). A divergence (e.g. mis-wired filtering) goes RED here.
  for (const c of conflicts) {
    const d = dispositions.find((x) => x.kind === c.kind && x.key === c.key);
    assert.ok(d, `every cluster has a disposition: ${c.kind}:${c.key}`);
    assert.equal(d.winner.path, c.likelyWinner.path);
  }
  // one disposition per cluster (additive 1:1).
  assert.equal(dispositions.length, conflicts.length);
});

test('table format renders without throwing and includes the dispositions header only when clusters exist', async () => {
  await withSkills(['y'], async (dir) => {
    const { code, stdout } = await run(['conflicts', '--config-dir', dir]);
    assert.equal(code, 0);
    // no clusters → no dispositions section header (lines block is empty)
    assert.doesNotMatch(stdout, /dispositions:/);
  });
});

test('conflictsTable renders a disposition stanza: winner + remove command + plugin advisory + suggestion', () => {
  const out = conflictsTable({
    conflicts: [{ kind: 'agent', key: 'executor', likelyWinner: { path: '/cfg/agents/executor.md' } }],
    dispositions: [{
      kind: 'agent', key: 'executor',
      winner: { path: '/cfg/agents/executor.md' },
      shadowed: [
        { path: '/cfg/agents/dup.md', removable: true, removeCommand: 'remove agent:executor' },
        { path: '/cache/p/agents/executor.md', tier: 'plugin', plugin: 'p', removable: false, removeCommand: null },
      ],
      suggestion: 'The loader keeps /cfg/agents/executor.md; resolve it.',
    }],
  });
  assert.match(out, /dispositions:/);
  assert.match(out, /agent:executor keeps \/cfg\/agents\/executor\.md/);
  // removable loser shows the remove command…
  assert.match(out, /shadowed: \/cfg\/agents\/dup\.md -> remove agent:executor/);
  // …plugin loser shows the disable/uninstall advisory (NOT a remove command)
  assert.match(out, /shadowed: \/cache\/p\/agents\/executor\.md -> \(plugin p — disable\/uninstall\)/);
  assert.match(out, /The loader keeps \/cfg\/agents\/executor\.md; resolve it\./);
});

test('conflictsTable never throws on junk + omits the section when there are no dispositions', () => {
  assert.equal(typeof conflictsTable(null), 'string');
  assert.equal(typeof conflictsTable({ conflicts: [], dispositions: 'nope' }), 'string');
  assert.doesNotMatch(conflictsTable({ conflicts: [], dispositions: [] }), /dispositions:/);
});

// ── codex co-existence render (P6) ────────────────────────────────────────────

test('conflictsTable renders the codex co-existence block: plugin + user members, no winner', () => {
  const out = conflictsTable({
    conflicts: [],
    dispositions: [],
    coexistence: [{
      kind: 'skill', name: 'gh-fix-ci', count: 3,
      sources: [
        { tier: 'plugin', plugin: 'github', marketplace: 'openai-curated', path: '/c/oc/SKILL.md' },
        { tier: 'plugin', plugin: 'github', marketplace: 'openai-curated-remote', path: '/c/ocr/SKILL.md' },
        { tier: 'user', path: '/home/skills/gh-fix-ci/SKILL.md' },
      ],
    }],
  });
  assert.match(out, /co-existence \(codex/);
  assert.match(out, /skill:gh-fix-ci \(3 sources\)/);
  // plugin members show plugin@marketplace; the user (home) member shows its tier.
  assert.match(out, /plugin github@openai-curated: \/c\/oc\/SKILL\.md/);
  assert.match(out, /user: \/home\/skills\/gh-fix-ci\/SKILL\.md/);
});

test('conflictsTable co-existence: defensive on malformed members + absent provenance (never throws)', () => {
  const out = conflictsTable({ coexistence: [{ kind: 'skill', name: 'x', count: 2, sources: [{ tier: 'plugin' }, null] }] });
  assert.equal(typeof out, 'string');
  // a plugin member with absent plugin/marketplace falls back to '?'
  assert.match(out, /plugin \?@\?:/);
});

test('conflictsTable omits the co-existence block when there is none (claude path unchanged)', () => {
  assert.doesNotMatch(conflictsTable({ conflicts: [], dispositions: [] }), /co-existence/);
});
