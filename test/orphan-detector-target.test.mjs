/**
 * P6.U2a — orphan-detector-target.test.mjs
 *
 * Verifies detectOrphans(rootDir, {descriptor}) drives classification from a
 * TargetDescriptor:
 *   - BACK-COMPAT: the default path (no descriptor) is byte-identical to passing
 *     the claude descriptor (drift-guard — load-bearing).
 *   - CODEX: a temp tree mimicking ~/.codex classifies via the codex descriptor's
 *     known dirs/files/patterns + componentKinds (skill-md / flat-md / flat-toml).
 *
 * Temp trees are built via mkdtempSync(tmpdir()) and cleaned in finally.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectOrphans } from '../src/discovery/orphan-detector.mjs';
import { claudeDescriptor } from '../src/targets/claude.mjs';
import { codexDescriptor } from '../src/targets/codex.mjs';

/** Create a throwaway temp dir, run fn(dir), clean up. */
function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'mgr-u2a-'));
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
    // a couple known dirs
    mkdir(dir, 'skills');
    mkdir(dir, 'agents');
    mkdir(dir, 'commands');
    // an unknown top-level dir
    mkdir(dir, 'bogus-dir');
    // a known top-level file + an unknown one
    mkfile(dir, 'settings.json', '{}');
    mkfile(dir, 'weird.xyz', 'orphan');
    // a loose file in skills/ (soft, skill-md)
    mkfile(dir, join('skills', 'loose.txt'), 'loose');
    // a non-.md in agents/ (soft, flat-md)
    mkfile(dir, join('agents', 'bad.json'), '{}');

    const dflt = detectOrphans(dir);
    const viaClaude = detectOrphans(dir, { descriptor: claudeDescriptor });
    assert.deepEqual(dflt, viaClaude);
  });
});

// ── CODEX SHAPE GOLDEN ────────────────────────────────────────────────────────

test('codex descriptor: hard + soft orphans match sorted name goldens', () => {
  withTempDir((dir) => {
    // ── known component + ecosystem dirs ──
    for (const d of ['skills', 'prompts', 'agents', 'hooks', 'cache', '.omx']) {
      mkdir(dir, d);
    }
    // ── known top files ──
    for (const f of ['config.toml', 'AGENTS.md', 'hooks.json', 'auth.json', 'version.json']) {
      mkfile(dir, f, 'x');
    }
    // leftover-bloat (pattern) + sqlite (pattern) → KNOWN, not hard
    mkfile(dir, '..codex-global-state.json.tmp-123', '{}');
    mkfile(dir, 'goals_1.sqlite', '');
    // ── unknown top dir + file → HARD ──
    mkdir(dir, 'bogus-dir');
    mkfile(dir, 'weird.xyz', 'orphan');

    // ── soft cases ──
    mkfile(dir, join('skills', 'loose.txt'), 'loose');        // skill-md: loose → soft
    mkfile(dir, join('prompts', 'notes.txt'), 'n');           // flat-md: non-.md → soft
    mkfile(dir, join('agents', 'bad.json'), '{}');            // flat-toml: non-.toml → soft
    mkfile(dir, join('agents', 'architect.toml'), 'x');       // flat-toml: .toml → LEGIT
    mkfile(dir, join('agents', 'README.md'), '# r');          // flat-toml: non-.toml → soft

    const { hard, soft, diagnostics } = detectOrphans(dir, { descriptor: codexDescriptor });

    assert.equal(diagnostics.filter((d) => d.severity === 'error').length, 0);

    // HARD: only the genuinely-unknown dir + file.
    const hardNames = hard.map((r) => r.name).sort();
    assert.deepEqual(hardNames, ['bogus-dir', 'weird.xyz']);
    // and the known entries are EXCLUDED from hard.
    for (const excluded of [
      'config.toml', 'AGENTS.md', 'hooks.json', 'auth.json', 'version.json',
      '..codex-global-state.json.tmp-123', 'goals_1.sqlite',
      'skills', 'prompts', 'agents', 'hooks', 'cache', '.omx',
    ]) {
      assert.equal(hardNames.includes(excluded), false, `"${excluded}" must not be a hard orphan`);
    }

    // SOFT: README.md & bad.json under agents (flat-toml non-.toml), notes.txt under
    // prompts (flat-md non-.md), loose.txt under skills (skill-md loose). Sorted by
    // the soft comparator (container, name): agents < prompts < skills.
    assert.deepEqual(soft.map((r) => r.name), ['README.md', 'bad.json', 'notes.txt', 'loose.txt']);
    // architect.toml is NOT flagged.
    assert.equal(soft.some((r) => r.name === 'architect.toml'), false, 'architect.toml must be legit, not soft');

    // spot-check container + reason wiring on the flat-toml path.
    const readme = soft.find((r) => r.name === 'README.md');
    assert.equal(readme.container, 'agents');
    assert.equal(readme.reason, 'non-.toml file in agents/');
    const loose = soft.find((r) => r.name === 'loose.txt');
    assert.equal(loose.container, 'skills');
    assert.equal(loose.reason, 'loose file in skills/ (skills must be <name>/SKILL.md)');
  });
});
