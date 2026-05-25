/**
 * P1.U11 — orphan-detector.test.mjs
 *
 * Golden + boundary tests for detectOrphans() against the orphan/ fixture and
 * throwaway temp directories.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectOrphans, KNOWN_TOP_FILES, KNOWN_TOP_FILE_PATTERNS, KNOWN_ECOSYSTEM_TOP_DIRS, DEFAULT_OWN_TOP_DIRS } from '../src/discovery/orphan-detector.mjs';
import { MGR_STATE_DIRNAME } from '../src/paths.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fix = (rel) => join(here, 'fixtures', rel);

const bySeverity = (diags, sev) => diags.filter((d) => d.severity === sev);

/** Create a throwaway temp dir, run fn(dir), clean up. */
function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'mgr-u11-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── EXPORTED CONTRACT ─────────────────────────────────────────────────────────

test('exports: KNOWN_TOP_FILES, KNOWN_TOP_FILE_PATTERNS, KNOWN_ECOSYSTEM_TOP_DIRS, DEFAULT_OWN_TOP_DIRS are frozen with expected entries', () => {
  assert.ok(Object.isFrozen(KNOWN_TOP_FILES), 'KNOWN_TOP_FILES must be frozen');
  assert.ok(Object.isFrozen(KNOWN_TOP_FILE_PATTERNS), 'KNOWN_TOP_FILE_PATTERNS must be frozen');
  assert.ok(Object.isFrozen(KNOWN_ECOSYSTEM_TOP_DIRS), 'KNOWN_ECOSYSTEM_TOP_DIRS must be frozen');
  assert.ok(Object.isFrozen(DEFAULT_OWN_TOP_DIRS), 'DEFAULT_OWN_TOP_DIRS must be frozen');
  // settings.json + CLAUDE.md are the load-bearing entries the top-level pass relies on.
  assert.ok(KNOWN_TOP_FILES.includes('settings.json'));
  assert.ok(KNOWN_TOP_FILES.includes('CLAUDE.md'));
  // New CC runtime files must be present.
  assert.ok(KNOWN_TOP_FILES.includes('history.jsonl'));
  assert.ok(KNOWN_TOP_FILES.includes('mcp-needs-auth-cache.json'));
  assert.ok(KNOWN_TOP_FILES.includes('.last-cleanup'));
  assert.ok(KNOWN_TOP_FILES.includes('bash-commands.log'));
  assert.ok(KNOWN_TOP_FILES.includes('cost-tracker.log'));
  // Pattern array must have at least the three expected patterns.
  assert.ok(Array.isArray(KNOWN_TOP_FILE_PATTERNS));
  assert.ok(KNOWN_TOP_FILE_PATTERNS.length >= 3);
  // OMC ecosystem dirs.
  assert.ok(KNOWN_ECOSYSTEM_TOP_DIRS.includes('homunculus'));
  assert.ok(KNOWN_ECOSYSTEM_TOP_DIRS.includes('metrics'));
  assert.ok(KNOWN_ECOSYSTEM_TOP_DIRS.includes('session-data'));
  assert.ok(KNOWN_ECOSYSTEM_TOP_DIRS.includes('teams'));
  // The tool's own dirs default to the state dir + the dogfood install dir.
  assert.deepEqual(DEFAULT_OWN_TOP_DIRS, ['.mgr-state', '.mgr']);
});

test('DEFAULT_OWN_TOP_DIRS[0] matches MGR_STATE_DIRNAME (drift guard)', () => {
  // The state dir literal must never drift from the single source of truth in
  // paths.mjs — the project has already hit a `.claude-mgr` vs `.mgr-state` drift
  // bug. The module stays pure/sync by NOT importing paths.mjs itself; this test
  // is where the two literals are reconciled.
  assert.equal(DEFAULT_OWN_TOP_DIRS[0], MGR_STATE_DIRNAME);
});

test('every KNOWN_TOP_FILES member at the root is excluded (hard:[])', () => {
  withTempDir((dir) => {
    for (const f of KNOWN_TOP_FILES) writeFileSync(join(dir, f), '{}', 'utf-8');
    const { hard, soft, diagnostics } = detectOrphans(dir);
    assert.equal(bySeverity(diagnostics, 'error').length, 0);
    assert.deepEqual(hard, []);
    assert.deepEqual(soft, []);
  });
});

// ── A. GOLDEN ─────────────────────────────────────────────────────────────────

test('orphan/golden: zero error-severity diagnostics', () => {
  const { diagnostics } = detectOrphans(fix('orphan'));
  assert.equal(bySeverity(diagnostics, 'error').length, 0);
});

test('orphan/golden: hard orphans match expected shape exactly', () => {
  const { hard } = detectOrphans(fix('orphan'));
  assert.deepEqual(
    hard.map((r) => ({ category: r.category, entryType: r.entryType, name: r.name })),
    [
      { category: 'hard', entryType: 'dir',  name: 'my-notes'   },
      { category: 'hard', entryType: 'file', name: 'scratch.txt' },
    ],
  );
});

test('orphan/golden: soft orphans match expected shape exactly', () => {
  const { soft } = detectOrphans(fix('orphan'));
  assert.deepEqual(
    soft.map((r) => ({ category: r.category, entryType: r.entryType, container: r.container, name: r.name })),
    [
      { category: 'soft', entryType: 'file', container: 'agents',   name: 'legacy.txt'      },
      { category: 'soft', entryType: 'file', container: 'commands', name: 'old-config.json'  },
      { category: 'soft', entryType: 'file', container: 'skills',   name: 'loose-note.md'   },
    ],
  );
});

test('orphan/golden: no record has a name that should be excluded', () => {
  const { hard, soft } = detectOrphans(fix('orphan'));
  const allNames = new Set([...hard, ...soft].map((r) => r.name));
  const mustNotAppear = [
    'real-skill', 'SKILL.md', 'reference.md',
    'real-agent.md', 'real-cmd.md',
    'settings.json', 'CLAUDE.md',
    'hooks', 'some-hook.sh',
    '.mgr', 'placeholder.txt',
  ];
  for (const name of mustNotAppear) {
    assert.equal(allNames.has(name), false, `"${name}" must not appear in any orphan record`);
  }
});

// ── B. ownTopDirs exclusion via TEMP DIR ──────────────────────────────────────

test('ownTopDirs default: .mgr-state and .mgr excluded; unknown entries flagged', () => {
  withTempDir((dir) => {
    // .mgr-state (gitignored in fixture — tested here via temp dir)
    mkdirSync(join(dir, '.mgr-state'));
    writeFileSync(join(dir, '.mgr-state', 'journal.json'), '{}', 'utf-8');
    // .mgr (default exclusion)
    mkdirSync(join(dir, '.mgr'));
    writeFileSync(join(dir, '.mgr', 'x.txt'), 'x', 'utf-8');
    // unknown top-level file
    writeFileSync(join(dir, 'scratch.txt'), 'orphan', 'utf-8');
    // unknown top-level dir
    mkdirSync(join(dir, 'weird'));
    writeFileSync(join(dir, 'weird', 'inside.txt'), 'orphan', 'utf-8');

    const { hard } = detectOrphans(dir);
    const names = hard.map((r) => r.name);
    // sorted: 'dir' < 'file', so 'weird' (dir) before 'scratch.txt' (file)
    assert.deepEqual(names, ['weird', 'scratch.txt']);
    // own dirs must NOT appear
    assert.equal(names.includes('.mgr-state'), false);
    assert.equal(names.includes('.mgr'), false);
  });
});

test('ownTopDirs override: custom list replaces defaults; omitted defaults now flagged', () => {
  withTempDir((dir) => {
    mkdirSync(join(dir, '.mgr-state'));
    writeFileSync(join(dir, '.mgr-state', 'journal.json'), '{}', 'utf-8');
    mkdirSync(join(dir, '.mgr'));
    writeFileSync(join(dir, '.mgr', 'x.txt'), 'x', 'utf-8');
    writeFileSync(join(dir, 'scratch.txt'), 'orphan', 'utf-8');
    mkdirSync(join(dir, 'weird'));
    writeFileSync(join(dir, 'weird', 'inside.txt'), 'orphan', 'utf-8');

    // Override: only exclude 'weird'; .mgr-state and .mgr are now unknown
    const { hard } = detectOrphans(dir, { ownTopDirs: ['weird'] });
    const names = hard.map((r) => r.name);

    // 'weird' is now excluded
    assert.equal(names.includes('weird'), false);
    // .mgr-state and .mgr are now flagged (defaults were overridden)
    assert.ok(names.includes('.mgr-state'), '.mgr-state should be flagged when not in ownTopDirs');
    assert.ok(names.includes('.mgr'), '.mgr should be flagged when not in ownTopDirs');
    // scratch.txt still flagged
    assert.ok(names.includes('scratch.txt'));
  });
});

// ── C. BOUNDARY ───────────────────────────────────────────────────────────────

test('boundary: null root → discover-bad-root error, never throws', () => {
  let result;
  assert.doesNotThrow(() => {
    result = detectOrphans(/** @type {any} */ (null));
  });
  assert.deepEqual(result.hard, []);
  assert.deepEqual(result.soft, []);
  assert.equal(result.diagnostics.find((d) => d.code === 'discover-bad-root')?.severity, 'error');
});

test('boundary: numeric root → discover-bad-root error, never throws', () => {
  let result;
  assert.doesNotThrow(() => {
    result = detectOrphans(/** @type {any} */ (42));
  });
  assert.deepEqual(result.hard, []);
  assert.deepEqual(result.soft, []);
  assert.equal(result.diagnostics[0].code, 'discover-bad-root');
});

test('boundary: non-existent path → empty result, zero error diagnostics', () => {
  let result;
  assert.doesNotThrow(() => {
    result = detectOrphans('/no/such/path/u11-nonexistent-abc123');
  });
  assert.deepEqual(result.hard, []);
  assert.deepEqual(result.soft, []);
  assert.equal(bySeverity(result.diagnostics, 'error').length, 0);
});

test('boundary: empty temp dir → hard:[], soft:[], no throw', () => {
  withTempDir((dir) => {
    let result;
    assert.doesNotThrow(() => { result = detectOrphans(dir); });
    assert.deepEqual(result.hard, []);
    assert.deepEqual(result.soft, []);
  });
});

test('boundary: temp dir with only skills/loose.md → soft has exactly that one entry', () => {
  withTempDir((dir) => {
    mkdirSync(join(dir, 'skills'));
    writeFileSync(join(dir, 'skills', 'loose.md'), 'a loose file', 'utf-8');

    let result;
    assert.doesNotThrow(() => { result = detectOrphans(dir); });
    assert.equal(bySeverity(result.diagnostics, 'error').length, 0);
    assert.equal(result.hard.length, 0);
    assert.equal(result.soft.length, 1);
    assert.equal(result.soft[0].name, 'loose.md');
    assert.equal(result.soft[0].container, 'skills');
  });
});

test('boundary: determinism — two calls produce identical results', () => {
  const r1 = detectOrphans(fix('orphan'));
  const r2 = detectOrphans(fix('orphan'));
  assert.deepEqual(r1, r2);
});

// ── D. WHITELIST EXPANSION — CC runtime + OMC ecosystem entries ───────────────

test('whitelist: CC runtime files and OMC ecosystem entries are NOT flagged as hard orphans', () => {
  withTempDir((dir) => {
    // CC runtime exact-name files
    for (const f of ['history.jsonl', '.last-cleanup', 'bash-commands.log',
      'cost-tracker.log', 'mcp-needs-auth-cache.json']) {
      writeFileSync(join(dir, f), '', 'utf-8');
    }
    // CC runtime pattern files (UUID-suffixed + timestamp-suffixed)
    writeFileSync(join(dir, 'security_warnings_state_a1b2c3d4-e5f6-7890-abcd-ef1234567890.json'), '{}', 'utf-8');
    writeFileSync(join(dir, 'CLAUDE.md.backup.1748736000000'), '# backup', 'utf-8');
    // OMC ecosystem file pattern
    writeFileSync(join(dir, '.omc-config.json'), '{}', 'utf-8');
    writeFileSync(join(dir, '.omc-version.json'), '{}', 'utf-8');
    // OMC ecosystem dirs
    for (const d of ['homunculus', 'metrics', 'session-data', 'teams']) {
      mkdirSync(join(dir, d));
    }

    const { hard, diagnostics } = detectOrphans(dir);
    assert.equal(hard.length, 0, `expected 0 hard orphans, got: ${hard.map((r) => r.name).join(', ')}`);
    assert.equal(diagnostics.filter((d) => d.severity === 'error').length, 0);
  });
});

test('whitelist: genuinely unknown entries are still flagged hard (no over-whitelisting)', () => {
  withTempDir((dir) => {
    // Known entries that must pass silently
    writeFileSync(join(dir, 'history.jsonl'), '', 'utf-8');
    writeFileSync(join(dir, '.omc-config.json'), '{}', 'utf-8');
    mkdirSync(join(dir, 'metrics'));
    // Unknown entries that MUST still be flagged
    writeFileSync(join(dir, 'random-junk.xyz'), 'orphan', 'utf-8');
    mkdirSync(join(dir, 'bogusdir'));

    const { hard } = detectOrphans(dir);
    const names = hard.map((r) => r.name);
    assert.ok(names.includes('random-junk.xyz'), 'random-junk.xyz must be a hard orphan');
    assert.ok(names.includes('bogusdir'), 'bogusdir must be a hard orphan');
    assert.equal(hard.length, 2, `expected exactly 2 hard orphans, got: ${names.join(', ')}`);
  });
});

test('whitelist: KNOWN_TOP_FILE_PATTERNS — security_warnings_state pattern matches correctly', () => {
  const pat = KNOWN_TOP_FILE_PATTERNS.find((r) => r.source.includes('security_warnings_state'));
  assert.ok(pat, 'security_warnings_state pattern must exist');
  assert.ok(pat.test('security_warnings_state_a1b2c3d4-e5f6-7890-abcd-ef1234567890.json'));
  assert.ok(!pat.test('security_warnings_state_.json'), 'empty UUID part must not match');
  assert.ok(!pat.test('xsecurity_warnings_state_abc.json'), 'leading char must not match');
});

test('whitelist: KNOWN_TOP_FILE_PATTERNS — CLAUDE.md.backup pattern matches correctly', () => {
  const pat = KNOWN_TOP_FILE_PATTERNS.find((r) => r.source.includes('backup'));
  assert.ok(pat, 'CLAUDE.md.backup pattern must exist');
  assert.ok(pat.test('CLAUDE.md.backup.1748736000000'));
  assert.ok(pat.test('CLAUDE.md.backup.anything'));
  assert.ok(!pat.test('CLAUDE.md.bak'), 'different suffix must not match');
  assert.ok(!pat.test('claude.md.backup.123'), 'lowercase must not match');
});

test('whitelist: KNOWN_TOP_FILE_PATTERNS — .omc-*.json pattern matches correctly', () => {
  const pat = KNOWN_TOP_FILE_PATTERNS.find((r) => r.source.includes('omc'));
  assert.ok(pat, '.omc-*.json pattern must exist');
  assert.ok(pat.test('.omc-config.json'));
  assert.ok(pat.test('.omc-version.json'));
  assert.ok(pat.test('.omc-my.state.json'));
  assert.ok(!pat.test('omc-config.json'), 'must start with dot');
  assert.ok(!pat.test('.omc-.json'), 'empty body after dash must not match');
});
