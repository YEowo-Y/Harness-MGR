/**
 * P3.U5 — snapshot-scope.test.mjs
 *
 * FALSIFIABLE golden-oracle coverage for walkSnapshotScope (src/ops/snapshot-walk.mjs):
 *   - builds a realistic temp ~/.claude tree (all allowlisted dirs + the 2 named
 *     plugins JSON + cache/marketplaces junk + 4 top files + ephemeral dirs), then
 *     asserts the returned `files` EXACTLY equals a hand-written sorted golden array
 *     (deepStrictEqual — not "non-empty"/"exit 0");
 *   - asserts plugins/cache/** and the ephemeral dirs are absent;
 *   - error paths (bad root), the named-file present-only branch, the depth guard,
 *     and prototype-poisoning names;
 *   - a COMPLETENESS drift-guard pinning all 19 KNOWN_TOP_DIRS to an explicit
 *     allowlist/plugins/exclusion decision, so a future new CC top dir forces a
 *     conscious snapshot-scope choice.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  walkSnapshotScope,
  WALK_DIRS,
  TOP_FILES,
  PLUGIN_FILES,
  EXCLUDE_TOP,
  EXCLUDE_PREFIXES,
} from '../src/ops/snapshot-walk.mjs';
// TEST files MAY import across layers — this is the discovery-side 19-dir oracle.
import { KNOWN_TOP_DIRS } from '../src/discovery/settings.mjs';

/** Create a fresh temp dir; returned cleanup fn removes it. */
function makeTmpDir() {
  const dir = mkdtempSync(join(tmpdir(), 'cmgr-snapscope-'));
  return { dir, cleanup() { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } } };
}

/** mkdir -p + write a file with junk content. */
function writeFileAt(root, rel, content = 'x') {
  const abs = join(root, ...rel.split('/'));
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content);
}

/**
 * Build a realistic ~/.claude tree. Returns the GOLDEN sorted list of POSIX-rel
 * paths the walker MUST capture (allowlisted dir files + 4 top files + 2 plugins
 * JSON), and the set of paths that MUST NOT appear.
 */
function buildRealisticTree(root) {
  // Allowlisted dirs (recursive) — include a nested subdir to prove recursion.
  writeFileAt(root, 'agents/reviewer.md');
  writeFileAt(root, 'skills/my-skill/SKILL.md');
  writeFileAt(root, 'skills/my-skill/helper/util.md'); // nested → recursion
  writeFileAt(root, 'commands/build.md');
  writeFileAt(root, 'hooks/pre-tool.mjs');
  writeFileAt(root, 'hud/omc-hud.mjs');
  // Top-level named files.
  for (const f of TOP_FILES) writeFileAt(root, f);
  // plugins: the 2 named JSON (captured) + cache/marketplaces junk (excluded).
  writeFileAt(root, 'plugins/installed_plugins.json');
  writeFileAt(root, 'plugins/known_marketplaces.json');
  writeFileAt(root, 'plugins/cache/some-plugin/index.js');
  writeFileAt(root, 'plugins/marketplaces/mp-clone/catalog.json');
  // Ephemeral / excluded top dirs (junk).
  for (const d of ['sessions', 'cache', 'projects', 'telemetry', 'backups', 'plans']) {
    writeFileAt(root, `${d}/junk.txt`);
  }

  const golden = [
    '.mcp.json',
    'CLAUDE.md',
    'agents/reviewer.md',
    'commands/build.md',
    'hooks/pre-tool.mjs',
    'hud/omc-hud.mjs',
    'plugins/installed_plugins.json',
    'plugins/known_marketplaces.json',
    'settings.json',
    'settings.local.json',
    'skills/my-skill/SKILL.md',
    'skills/my-skill/helper/util.md',
  ].sort();

  const mustNotAppear = [
    'plugins/cache/some-plugin/index.js',
    'plugins/marketplaces/mp-clone/catalog.json',
    'sessions/junk.txt', 'cache/junk.txt', 'projects/junk.txt',
    'telemetry/junk.txt', 'backups/junk.txt', 'plans/junk.txt',
  ];
  return { golden, mustNotAppear };
}

test('walkSnapshotScope returns EXACTLY the allowlisted file set (golden array)', () => {
  const { dir, cleanup } = makeTmpDir();
  try {
    const { golden } = buildRealisticTree(dir);
    const { files, diagnostics } = walkSnapshotScope({ targetClaudeDir: dir });
    assert.deepStrictEqual(files, golden);
    assert.deepStrictEqual(diagnostics, []); // clean tree → no diagnostics
  } finally {
    cleanup();
  }
});

test('plugins/cache/** and ephemeral dirs are NEVER captured', () => {
  const { dir, cleanup } = makeTmpDir();
  try {
    const { mustNotAppear } = buildRealisticTree(dir);
    const { files } = walkSnapshotScope({ targetClaudeDir: dir });
    const fileSet = new Set(files);
    for (const p of mustNotAppear) {
      assert.equal(fileSet.has(p), false, `${p} must be excluded`);
    }
    // Belt: no captured path starts with an excluded prefix.
    for (const p of files) {
      for (const prefix of EXCLUDE_PREFIXES) {
        assert.equal(p.startsWith(prefix), false, `${p} starts with excluded prefix ${prefix}`);
      }
    }
  } finally {
    cleanup();
  }
});

test('output is sorted ascending and de-duplicated', () => {
  const { dir, cleanup } = makeTmpDir();
  try {
    buildRealisticTree(dir);
    const { files } = walkSnapshotScope({ targetClaudeDir: dir });
    const sorted = [...files].sort();
    assert.deepStrictEqual(files, sorted, 'files must already be sorted');
    assert.equal(new Set(files).size, files.length, 'no duplicate paths');
  } finally {
    cleanup();
  }
});

test('top-level + plugins named files are present-only (absent files not emitted)', () => {
  const { dir, cleanup } = makeTmpDir();
  try {
    // Only create CLAUDE.md + installed_plugins.json; the other named files absent.
    writeFileAt(dir, 'CLAUDE.md');
    writeFileAt(dir, 'plugins/installed_plugins.json');
    const { files } = walkSnapshotScope({ targetClaudeDir: dir });
    assert.deepStrictEqual(files, ['CLAUDE.md', 'plugins/installed_plugins.json'].sort());
  } finally {
    cleanup();
  }
});

test('empty tree → empty file list, no diagnostics', () => {
  const { dir, cleanup } = makeTmpDir();
  try {
    const { files, diagnostics } = walkSnapshotScope({ targetClaudeDir: dir });
    assert.deepStrictEqual(files, []);
    assert.deepStrictEqual(diagnostics, []);
  } finally {
    cleanup();
  }
});

test('bad root → one discover-bad-root error + empty files; never throws', () => {
  for (const bad of [undefined, null, '', 123, {}, []]) {
    const { files, diagnostics } = walkSnapshotScope(
      bad === undefined ? undefined : { targetClaudeDir: bad },
    );
    assert.deepStrictEqual(files, []);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].code, 'discover-bad-root');
    assert.equal(diagnostics[0].severity, 'error');
  }
  // Calling with no args at all must also not throw.
  assert.doesNotThrow(() => walkSnapshotScope());
});

test('a file named __proto__ is captured verbatim, no prototype pollution', () => {
  const { dir, cleanup } = makeTmpDir();
  try {
    // A file literally named like a dangerous key, under an allowlisted dir. Since
    // `out` is an array (not a path-keyed object), it is captured as a plain element.
    writeFileAt(dir, 'agents/__proto__');
    writeFileAt(dir, 'agents/keep.md');
    const { files } = walkSnapshotScope({ targetClaudeDir: dir });
    assert.deepStrictEqual(files, ['agents/__proto__', 'agents/keep.md'].sort());
    // The output array's prototype is untouched (no pollution from the odd name).
    assert.equal(Object.getPrototypeOf(files), Array.prototype);
    assert.equal({}.polluted, undefined, 'Object.prototype not polluted');
  } finally {
    cleanup();
  }
});

test('depth guard: extremely deep nesting does not throw and is bounded', () => {
  const { dir, cleanup } = makeTmpDir();
  try {
    // Build a 70-deep chain under skills/ (beyond WALK_MAX_DEPTH=64).
    let rel = 'skills';
    for (let i = 0; i < 70; i++) rel += `/d${i}`;
    writeFileAt(dir, `${rel}/leaf.md`);
    // A shallow sibling that MUST be captured.
    writeFileAt(dir, 'skills/top.md');
    let result;
    assert.doesNotThrow(() => { result = walkSnapshotScope({ targetClaudeDir: dir }); });
    assert.ok(result.files.includes('skills/top.md'), 'shallow file captured');
    // The 70-deep leaf is beyond the depth guard → not captured.
    assert.equal(result.files.some((f) => f.endsWith('leaf.md')), false, 'deep leaf bounded out');
  } finally {
    cleanup();
  }
});

test('a stranded .mgr-new / .mgr-old sidecar is NEVER captured into a snapshot', () => {
  const { dir, cleanup } = makeTmpDir();
  try {
    // A real governed file alongside a stranded atomic-write recovery sidecar
    // (the catastrophic apply/rollback double-failure case).
    writeFileAt(dir, 'agents/real.md');
    writeFileAt(dir, 'agents/strand.md.mgr-old');
    // Also a nested .mgr-new deeper under skills/ to prove the recursive walk skips it.
    writeFileAt(dir, 'skills/my-skill/SKILL.md');
    writeFileAt(dir, 'skills/my-skill/SKILL.md.mgr-new');

    const { files } = walkSnapshotScope({ targetClaudeDir: dir });
    const fileSet = new Set(files);
    // The real files ARE captured (POSIX-relative).
    assert.equal(fileSet.has('agents/real.md'), true, 'real governed file must be captured');
    assert.equal(fileSet.has('skills/my-skill/SKILL.md'), true, 'real nested file must be captured');
    // The sidecars are NEVER captured. PRE-FIX both ARE captured (the walk has no
    // sidecar filter), so each of these assertions fails before the fix.
    assert.equal(fileSet.has('agents/strand.md.mgr-old'), false, '.mgr-old sidecar must be excluded');
    assert.equal(fileSet.has('skills/my-skill/SKILL.md.mgr-new'), false, '.mgr-new sidecar must be excluded');
    // Belt: no captured path ends with a recovery-sidecar suffix.
    for (const p of files) {
      assert.equal(p.endsWith('.mgr-new') || p.endsWith('.mgr-old'), false, `${p} is a recovery sidecar`);
    }
  } finally {
    cleanup();
  }
});

// ── COMPLETENESS drift-guard: all 19 KNOWN_TOP_DIRS explicitly accounted for ──

test('every KNOWN_TOP_DIR is explicitly decided (allowlist | plugins | exclusion)', () => {
  assert.equal(KNOWN_TOP_DIRS.length, 19, 'guard assumes the documented 19 top dirs');

  const walkSet = new Set(WALK_DIRS);
  const excludeSet = new Set(EXCLUDE_TOP);
  // `plugins` is intentionally NOT a top-segment exclusion (its 2 named JSON files
  // are captured); it is accounted for via PLUGIN_FILES living under it.
  const pluginsAccounted = PLUGIN_FILES.every((p) => p.startsWith('plugins/'));
  assert.ok(pluginsAccounted, 'PLUGIN_FILES live under plugins/');

  for (const dir of KNOWN_TOP_DIRS) {
    const decided = walkSet.has(dir) || excludeSet.has(dir) || (dir === 'plugins' && pluginsAccounted);
    assert.ok(
      decided,
      `KNOWN_TOP_DIR "${dir}" is UNDECIDED for snapshot scope — add it to WALK_DIRS, `
      + 'EXCLUDE_TOP, or (for plugins) PLUGIN_FILES',
    );
  }

  // And the inverse: every WALK_DIR / EXCLUDE_TOP entry that is a real top dir is a
  // known one (catch a typo'd allowlist entry). `.mgr` self-exclusion + the prefix
  // exclusions are NOT top dirs, so they're exempt.
  const knownSet = new Set(KNOWN_TOP_DIRS);
  for (const d of WALK_DIRS) assert.ok(knownSet.has(d), `WALK_DIRS entry "${d}" not a KNOWN_TOP_DIR`);
  for (const d of EXCLUDE_TOP) {
    if (d === '.mgr') continue; // self-exclusion sibling, not a CC top dir
    assert.ok(knownSet.has(d), `EXCLUDE_TOP entry "${d}" not a KNOWN_TOP_DIR`);
  }
});

test('allowlist / exclusion sets are disjoint (no dir both walked and excluded)', () => {
  const excludeSet = new Set(EXCLUDE_TOP);
  for (const d of WALK_DIRS) {
    assert.equal(excludeSet.has(d), false, `"${d}" is both walked and excluded`);
  }
});
